/**
 * Instruction Drift Tracking — correlates changes to the active instruction
 * prompt (CLAUDE.md / system prompt, identified by content hash) with the
 * outcomes of sessions run under each version, to flag whether a prompt
 * change measurably helped or hurt. Distinct from ClaudeMdTracker's
 * before/after window comparison: this tracks per-session outcomes tagged
 * by exact prompt hash, so it can compare across many prompt variants, not
 * just the single most recent change.
 */

import { createHash } from 'node:crypto';
import { createLogger } from '../shared/index.js';
import { ClaudeMdTracker, matchesInstructionFile } from './claudemd-tracker.js';
import type { ToolCallRecord } from '../storage/types.js';

const logger = createLogger('instruction-drift');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionOutcomeRecord {
  readonly sessionId: string;
  readonly promptHash: string;
  readonly timestamp: number;
  readonly successRate: number | null;
  readonly totalTokens: number;
  readonly thrashingIncidents: number;
  readonly taskCount: number;
  readonly avgEfficiency: number | null;
}

export interface PromptVariantStats {
  readonly promptHash: string;
  readonly sessionCount: number;
  readonly avgSuccessRate: number | null;
  readonly avgTokensPerSession: number;
  readonly avgThrashingIncidents: number;
  readonly avgEfficiency: number | null;
  readonly firstSeen: number;
  readonly lastSeen: number;
}

export interface DriftCorrelation {
  readonly fromHash: string;
  readonly toHash: string;
  readonly successRateDelta: number | null;
  readonly tokensDelta: number;
  readonly thrashingDelta: number;
  readonly efficiencyDelta: number | null;
  readonly verdict: 'improved' | 'degraded' | 'neutral' | 'insufficient_data';
}

export interface InstructionDriftMetrics {
  readonly currentPromptHash: string | null;
  readonly uniquePromptVariants: number;
  readonly variantStats: readonly PromptVariantStats[];
  readonly recentCorrelations: readonly DriftCorrelation[];
  readonly currentVariantSessionCount: number;
}

export interface InstructionDriftOptions {
  readonly maxRecords?: number;
  readonly minSessionsForComparison?: number;
  readonly instructionFilePaths?: readonly string[];
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_RECORDS = 200;
const DEFAULT_MIN_SESSIONS = 3;

// ---------------------------------------------------------------------------
// InstructionDriftTracker
// ---------------------------------------------------------------------------

export class InstructionDriftTracker {
  private readonly maxRecords: number;
  private readonly minSessionsForComparison: number;
  private readonly instructionFilePaths: readonly string[];

  private currentPromptHash: string | null = null;
  private readonly records: SessionOutcomeRecord[] = [];
  private readonly correlations: DriftCorrelation[] = [];

  constructor(options?: InstructionDriftOptions) {
    this.maxRecords = options?.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.minSessionsForComparison = options?.minSessionsForComparison ?? DEFAULT_MIN_SESSIONS;
    this.instructionFilePaths = [
      ...new Set(['CLAUDE.md', '.claude/', ...(options?.instructionFilePaths ?? [])]),
    ];
  }

  get promptHash(): string | null {
    return this.currentPromptHash;
  }

  recordToolCall(record: ToolCallRecord): void {
    if (record.toolName !== 'Read') return;

    const filePath = record.filePath as string | undefined;
    if (!filePath) return;

    // Only track reads of instruction files
    if (!matchesInstructionFile(filePath, this.instructionFilePaths)) return;

    let hash: string;
    try {
      hash = ClaudeMdTracker.computeFileHash(filePath);
    } catch (err) {
      // File gone/unreadable by the time we process this event — no signal,
      // but log at debug level since this can also mean permission-denied
      // or an EISDIR (unlike the pre-fix code, which never touched the
      // filesystem here at all).
      logger.debug('Could not hash instruction file', { filePath, error: String(err) });
      return;
    }

    this.setPromptHash(hash);
  }

  setPrompt(promptText: string): string {
    const hash = hashPrompt(promptText);
    if (this.currentPromptHash !== null && this.currentPromptHash !== hash) {
      this.computeCorrelation(this.currentPromptHash, hash);
    }
    this.currentPromptHash = hash;
    return hash;
  }

  setPromptHash(hash: string): void {
    if (this.currentPromptHash !== null && this.currentPromptHash !== hash) {
      this.computeCorrelation(this.currentPromptHash, hash);
    }
    this.currentPromptHash = hash;
  }

  recordSessionOutcome(outcome: {
    sessionId: string;
    successRate: number | null;
    totalTokens: number;
    thrashingIncidents: number;
    taskCount: number;
    avgEfficiency: number | null;
  }): void {
    if (this.currentPromptHash === null) return;

    const record: SessionOutcomeRecord = {
      sessionId: outcome.sessionId,
      promptHash: this.currentPromptHash,
      timestamp: Date.now(),
      successRate: outcome.successRate,
      totalTokens: outcome.totalTokens,
      thrashingIncidents: outcome.thrashingIncidents,
      taskCount: outcome.taskCount,
      avgEfficiency: outcome.avgEfficiency,
    };

    this.records.push(record);
    if (this.records.length > this.maxRecords) {
      this.records.shift();
    }
  }

  getMetrics(): InstructionDriftMetrics {
    const variantStats = this.computeVariantStats();
    const currentCount = this.currentPromptHash
      ? this.records.filter((r) => r.promptHash === this.currentPromptHash).length
      : 0;

    return {
      currentPromptHash: this.currentPromptHash,
      uniquePromptVariants: variantStats.length,
      variantStats,
      recentCorrelations: this.correlations.slice(-10),
      currentVariantSessionCount: currentCount,
    };
  }

  loadRecords(records: readonly SessionOutcomeRecord[]): void {
    // Prepend external records (historical, older) before in-memory records so
    // that trimming from the front evicts the oldest entries first (FIFO).
    this.records.unshift(...records);
    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords);
    }
  }

  getRecords(): readonly SessionOutcomeRecord[] {
    return this.records;
  }

  reset(_sessionId: string): void {
    this.currentPromptHash = null;
    this.records.length = 0;
    this.correlations.length = 0;
  }

  private computeVariantStats(): PromptVariantStats[] {
    const byHash = new Map<string, SessionOutcomeRecord[]>();
    for (const record of this.records) {
      const arr = byHash.get(record.promptHash) ?? [];
      arr.push(record);
      byHash.set(record.promptHash, arr);
    }

    const stats: PromptVariantStats[] = [];
    for (const [hash, sessions] of byHash) {
      const successRates = sessions
        .map((s) => s.successRate)
        .filter((r): r is number => r !== null);
      const efficiencies = sessions
        .map((s) => s.avgEfficiency)
        .filter((e): e is number => e !== null);

      stats.push({
        promptHash: hash,
        sessionCount: sessions.length,
        avgSuccessRate:
          successRates.length > 0
            ? Math.round((successRates.reduce((a, b) => a + b, 0) / successRates.length) * 1000) /
              1000
            : null,
        avgTokensPerSession: Math.round(
          sessions.reduce((s, r) => s + r.totalTokens, 0) / sessions.length,
        ),
        avgThrashingIncidents:
          Math.round(
            (sessions.reduce((s, r) => s + r.thrashingIncidents, 0) / sessions.length) * 100,
          ) / 100,
        avgEfficiency:
          efficiencies.length > 0
            ? Math.round((efficiencies.reduce((a, b) => a + b, 0) / efficiencies.length) * 1000) /
              1000
            : null,
        firstSeen: Math.min(...sessions.map((s) => s.timestamp)),
        lastSeen: Math.max(...sessions.map((s) => s.timestamp)),
      });
    }

    return stats.sort((a, b) => b.lastSeen - a.lastSeen);
  }

  private computeCorrelation(fromHash: string, toHash: string): void {
    const fromSessions = this.records.filter((r) => r.promptHash === fromHash);
    const toSessions = this.records.filter((r) => r.promptHash === toHash);

    if (fromSessions.length < this.minSessionsForComparison) {
      this.correlations.push({
        fromHash,
        toHash,
        successRateDelta: null,
        tokensDelta: 0,
        thrashingDelta: 0,
        efficiencyDelta: null,
        verdict: 'insufficient_data',
      });
      return;
    }

    const fromAvg = this.averageMetrics(fromSessions);
    const toAvg = toSessions.length > 0 ? this.averageMetrics(toSessions) : null;

    if (!toAvg) {
      this.correlations.push({
        fromHash,
        toHash,
        successRateDelta: null,
        tokensDelta: 0,
        thrashingDelta: 0,
        efficiencyDelta: null,
        verdict: 'insufficient_data',
      });
      return;
    }

    const successDelta =
      fromAvg.successRate !== null && toAvg.successRate !== null
        ? toAvg.successRate - fromAvg.successRate
        : null;
    const tokensDelta = toAvg.tokens - fromAvg.tokens;
    const thrashingDelta = toAvg.thrashing - fromAvg.thrashing;
    const efficiencyDelta =
      fromAvg.efficiency !== null && toAvg.efficiency !== null
        ? toAvg.efficiency - fromAvg.efficiency
        : null;

    // Thresholds below are hand-picked "big enough to matter" cutoffs, not
    // derived from data — any one signal crossing its threshold is enough to
    // call the change degraded/improved.
    let verdict: DriftCorrelation['verdict'] = 'neutral';
    if (successDelta !== null) {
      if (successDelta < -0.1 || thrashingDelta > 0.5 || tokensDelta > 5000) {
        verdict = 'degraded';
      } else if (successDelta > 0.1 || thrashingDelta < -0.5 || tokensDelta < -5000) {
        verdict = 'improved';
      }
    }

    const correlation: DriftCorrelation = {
      fromHash,
      toHash,
      successRateDelta: successDelta !== null ? Math.round(successDelta * 1000) / 1000 : null,
      tokensDelta: Math.round(tokensDelta),
      thrashingDelta: Math.round(thrashingDelta * 100) / 100,
      efficiencyDelta: efficiencyDelta !== null ? Math.round(efficiencyDelta * 1000) / 1000 : null,
      verdict,
    };

    this.correlations.push(correlation);

    if (verdict === 'degraded') {
      logger.warn('Prompt change correlated with degradation', {
        fromHash: fromHash.slice(0, 8),
        toHash: toHash.slice(0, 8),
        successDelta: correlation.successRateDelta,
        tokensDelta: correlation.tokensDelta,
      });
    }
  }

  private averageMetrics(sessions: SessionOutcomeRecord[]): {
    successRate: number | null;
    tokens: number;
    thrashing: number;
    efficiency: number | null;
  } {
    const rates = sessions.map((s) => s.successRate).filter((r): r is number => r !== null);
    const effs = sessions.map((s) => s.avgEfficiency).filter((e): e is number => e !== null);

    return {
      successRate: rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : null,
      tokens: sessions.reduce((s, r) => s + r.totalTokens, 0) / sessions.length,
      thrashing: sessions.reduce((s, r) => s + r.thrashingIncidents, 0) / sessions.length,
      efficiency: effs.length > 0 ? effs.reduce((a, b) => a + b, 0) / effs.length : null,
    };
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

export function hashPrompt(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}
