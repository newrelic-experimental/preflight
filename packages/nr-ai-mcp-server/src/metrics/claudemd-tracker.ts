/**
 * CLAUDE.md Change Impact Tracking — detects modifications to CLAUDE.md
 * and `.claude/` configuration files, computes before/after metric deltas
 * from stored sessions, estimates token context costs, and emits NR metrics.
 *
 * Change detection:
 *   - Within a session: Write/Edit tool calls targeting CLAUDE.md or .claude/
 *   - Between sessions: SHA-256 hash comparison of CLAUDE.md content
 *
 * Impact analysis:
 *   - Partitions sessions into before/after windows around a change timestamp
 *   - Compares efficiency, cost, correction rate, tool calls per task, and
 *     task success rate across the two windows
 *   - Generates a verdict string: "Positive impact", "Negative impact", or
 *     "Mixed impact" with the top changed metrics
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { MetricAggregator } from '@nr-ai-observatory/shared';
import { createLogger } from '@nr-ai-observatory/shared';
import type { SessionStore } from '../storage/session-store.js';
import type { FullSessionSummary } from '../storage/session-store.js';
import type { ToolCallRecord } from '../storage/types.js';
import { percentChange } from './trend-analyzer.js';

const logger = createLogger('claudemd-tracker');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClaudeMdChange {
  readonly timestamp: number;
  readonly sessionId: string;
  readonly filePath: string;
  readonly changeType: 'created' | 'modified' | 'deleted';
  readonly diffSummary: string;
  readonly linesAdded: number;
  readonly linesRemoved: number;
}

export interface AggregateMetrics {
  readonly avgEfficiencyScore: number | null;
  readonly avgCostUsd: number;
  readonly avgCorrectionRate: number;
  readonly avgToolCallsPerTask: number;
  readonly avgTaskSuccessRate: number | null;
  readonly sessionCount: number;
}

export interface MetricDelta {
  readonly value: number;
  readonly percentChange: number | null;
  readonly improved: boolean;
}

export interface ClaudeMdImpactReport {
  readonly changeDescription: string;
  readonly beforeMetrics: AggregateMetrics;
  readonly afterMetrics: AggregateMetrics;
  readonly deltas: {
    readonly efficiencyScore: MetricDelta;
    readonly cost: MetricDelta;
    readonly correctionRate: MetricDelta;
    readonly toolCallsPerTask: MetricDelta;
    readonly taskSuccessRate: MetricDelta;
  };
  readonly contextTokensForClaudeMd: number;
  readonly verdict: string;
}

export interface ContextCostEstimate {
  readonly filePath: string;
  readonly charCount: number;
  readonly estimatedTokens: number;
  readonly perSessionCostUsd: number;
  readonly perTurnCostUsd: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Rough heuristic: 1 char ≈ 0.25 tokens for English text. */
const TOKENS_PER_CHAR = 0.25;

/** Baseline input cost: Sonnet 4's $3 per million input tokens. */
const DEFAULT_INPUT_COST_PER_MTOK = 3;

/** Average turns per session — used for per-session cost estimation. */
const AVG_TURNS_PER_SESSION = 10;

/** Regex matching CLAUDE.md files and .claude/ directory contents. */
const CLAUDEMD_PATTERN = /(?:^|\/)CLAUDE\.md$|(?:^|\/)\.claude\//;

const MAX_CHANGES = 1_000;

// ---------------------------------------------------------------------------
// ClaudeMdTracker
// ---------------------------------------------------------------------------

export class ClaudeMdTracker {
  private readonly sessionStore: SessionStore;
  private readonly changes: ClaudeMdChange[] = [];
  private lastEmittedIndex = 0;
  private cachedImpact: { timestamp: number; report: ClaudeMdImpactReport } | null = null;

  constructor(options: { sessionStore: SessionStore }) {
    this.sessionStore = options.sessionStore;
  }

  /**
   * Examine a tool call record and detect if it modifies a CLAUDE.md or
   * `.claude/` file. Returns the change event if detected, null otherwise.
   */
  detectChange(toolCall: ToolCallRecord): ClaudeMdChange | null {
    if (toolCall.toolName !== 'Write' && toolCall.toolName !== 'Edit') {
      return null;
    }

    const rec = toolCall as Record<string, unknown>;
    const filePath = typeof rec.filePath === 'string' ? rec.filePath : null;
    if (!filePath || !CLAUDEMD_PATTERN.test(filePath)) {
      return null;
    }

    let changeType: ClaudeMdChange['changeType'];
    let linesAdded = 0;
    let linesRemoved = 0;

    if (toolCall.toolName === 'Write') {
      changeType = 'created';
      linesAdded = typeof rec.lineCount === 'number' ? rec.lineCount : 0;
    } else {
      // Edit tool
      if (rec.isDelete === true) {
        changeType = 'deleted';
      } else {
        changeType = 'modified';
      }
      linesAdded = typeof rec.newLineCount === 'number' ? rec.newLineCount : 0;
      linesRemoved = typeof rec.oldLineCount === 'number' ? rec.oldLineCount : 0;
    }

    const diffSummary = `${changeType} ${filePath}: +${linesAdded}/-${linesRemoved} lines`;

    const change: ClaudeMdChange = {
      timestamp: toolCall.timestamp,
      sessionId: toolCall.sessionId ?? 'unknown',
      filePath,
      changeType,
      diffSummary,
      linesAdded,
      linesRemoved,
    };

    this.appendChange(change);
    this.cachedImpact = null;
    logger.debug('CLAUDE.md change detected', { filePath, changeType });

    return change;
  }

  /** Returns all detected changes in this tracker's lifetime. */
  getChanges(): readonly ClaudeMdChange[] {
    return [...this.changes];
  }

  /**
   * Compute SHA-256 hash of a file's content.
   * Throws if the file does not exist.
   */
  static computeFileHash(filePath: string): string {
    const content = readFileSync(filePath, 'utf-8');
    return createHash('sha256').update(content).digest('hex');
  }

  /**
   * Detect whether CLAUDE.md changed between sessions by comparing hashes.
   * Returns true if previousHash is null (first session) or hashes differ.
   */
  static detectBetweenSessionChange(
    previousHash: string | null,
    currentHash: string,
  ): boolean {
    if (previousHash === null) return true;
    return previousHash !== currentHash;
  }

  /**
   * Compare metrics in the N days before vs N days after a change timestamp.
   * Returns a full impact report with deltas, context cost estimate, and verdict.
   */
  computeImpact(changeTimestamp: number, windowDays: number = 7): ClaudeMdImpactReport {
    const windowMs = windowDays * 86_400_000;
    const allSessions = this.sessionStore.loadAllSessions();

    const beforeSessions = allSessions.filter(
      (s) => s.startTime >= changeTimestamp - windowMs && s.startTime < changeTimestamp,
    );
    const afterSessions = allSessions.filter(
      (s) => s.startTime >= changeTimestamp && s.startTime <= changeTimestamp + windowMs,
    );

    const beforeMetrics = aggregateSessions(beforeSessions);
    const afterMetrics = aggregateSessions(afterSessions);

    const deltas = {
      efficiencyScore: computeDelta(
        beforeMetrics.avgEfficiencyScore ?? 0,
        afterMetrics.avgEfficiencyScore ?? 0,
        true, // higher is better
      ),
      cost: computeDelta(
        beforeMetrics.avgCostUsd,
        afterMetrics.avgCostUsd,
        false, // lower is better
      ),
      correctionRate: computeDelta(
        beforeMetrics.avgCorrectionRate,
        afterMetrics.avgCorrectionRate,
        false, // lower is better
      ),
      toolCallsPerTask: computeDelta(
        beforeMetrics.avgToolCallsPerTask,
        afterMetrics.avgToolCallsPerTask,
        false, // lower is better
      ),
      taskSuccessRate: computeDelta(
        beforeMetrics.avgTaskSuccessRate ?? 0,
        afterMetrics.avgTaskSuccessRate ?? 0,
        true, // higher is better
      ),
    };

    // Estimate context tokens from the actual file size
    let contextTokensForClaudeMd = 0;
    const latestChange = [...this.changes]
      .reverse()
      .find((c) => c.changeType !== 'deleted');
    if (latestChange) {
      try {
        const cost = ClaudeMdTracker.estimateContextCost(latestChange.filePath);
        contextTokensForClaudeMd = cost.estimatedTokens;
      } catch {
        contextTokensForClaudeMd = 0;
      }
    }

    // Generate verdict
    const verdict = generateVerdict(deltas);

    // Build change description
    const lastChange = this.changes[this.changes.length - 1];
    const changeDescription = lastChange?.diffSummary ?? 'Unknown change';

    return {
      changeDescription,
      beforeMetrics,
      afterMetrics,
      deltas,
      contextTokensForClaudeMd,
      verdict,
    };
  }

  private appendChange(change: ClaudeMdChange): void {
    this.changes.push(change);
    if (this.changes.length > MAX_CHANGES) {
      const dropped = this.changes.length - MAX_CHANGES;
      this.changes.splice(0, dropped);
      this.lastEmittedIndex = Math.max(0, this.lastEmittedIndex - dropped);
    }
  }

  private getCachedImpact(timestamp: number): ClaudeMdImpactReport {
    if (!this.cachedImpact || this.cachedImpact.timestamp !== timestamp) {
      this.cachedImpact = { timestamp, report: this.computeImpact(timestamp) };
    }
    return this.cachedImpact.report;
  }

  /**
   * Estimate the per-session and per-turn cost of loading a CLAUDE.md file
   * into context. Reads the file and computes token estimate.
   */
  static estimateContextCost(claudeMdPath: string): ContextCostEstimate {
    const content = readFileSync(claudeMdPath, 'utf-8');
    const charCount = content.length;
    const estimatedTokens = Math.round(charCount * TOKENS_PER_CHAR);
    const perTurnCostUsd = round((estimatedTokens / 1_000_000) * DEFAULT_INPUT_COST_PER_MTOK, 6);
    const perSessionCostUsd = round(perTurnCostUsd * AVG_TURNS_PER_SESSION, 6);

    return {
      filePath: claudeMdPath,
      charCount,
      estimatedTokens,
      perSessionCostUsd,
      perTurnCostUsd,
    };
  }

  /**
   * Emit custom events and delta metrics for newly detected changes only.
   * Impact report is cached and only recomputed when a new change arrives.
   */
  emitMetrics(aggregator: MetricAggregator): void {
    for (let i = this.lastEmittedIndex; i < this.changes.length; i++) {
      const change = this.changes[i]!;
      aggregator.record('ai.claudemd.change', 1, {
        filePath: change.filePath,
        changeType: change.changeType,
        linesAdded: change.linesAdded,
        linesRemoved: change.linesRemoved,
      });
    }
    this.lastEmittedIndex = this.changes.length;

    // Emit impact deltas for the latest change if we have one
    if (this.changes.length > 0) {
      const latest = this.changes[this.changes.length - 1]!;
      const report = this.getCachedImpact(latest.timestamp);

      aggregator.record(
        'ai.claudemd.post_change_efficiency_delta',
        report.deltas.efficiencyScore.value,
        { filePath: latest.filePath, changeType: latest.changeType },
      );
      aggregator.record(
        'ai.claudemd.post_change_cost_delta',
        report.deltas.cost.value,
        { filePath: latest.filePath, changeType: latest.changeType },
      );
    }

    logger.debug('CLAUDE.md change metrics emitted', { changeCount: this.changes.length });
  }

  reset(): void {
    this.changes.length = 0;
    this.lastEmittedIndex = 0;
    this.cachedImpact = null;
  }
}

// ---------------------------------------------------------------------------
// Session aggregation
// ---------------------------------------------------------------------------

function aggregateSessions(sessions: FullSessionSummary[]): AggregateMetrics {
  if (sessions.length === 0) {
    return {
      avgEfficiencyScore: null,
      avgCostUsd: 0,
      avgCorrectionRate: 0,
      avgToolCallsPerTask: 0,
      avgTaskSuccessRate: null,
      sessionCount: 0,
    };
  }

  let efficiencySum = 0;
  let efficiencyCount = 0;
  let totalCost = 0;
  let totalCorrections = 0;
  let totalUserMessages = 0;
  let totalToolCalls = 0;
  let totalTasks = 0;
  let taskSuccessSum = 0;

  for (const s of sessions) {
    if (s.efficiencyScore !== null) {
      efficiencySum += s.efficiencyScore;
      efficiencyCount++;
    }
    totalCost += s.estimatedCostUsd ?? 0;
    totalCorrections += s.userCorrections;
    totalUserMessages += s.userMessages;
    totalToolCalls += s.toolCallCount;
    totalTasks += s.taskCount;
    if (s.taskSuccessRate !== null) {
      taskSuccessSum += s.taskSuccessRate * s.taskCount;
    }
  }

  return {
    avgEfficiencyScore: efficiencyCount > 0
      ? round(efficiencySum / efficiencyCount, 3)
      : null,
    avgCostUsd: round(totalCost / sessions.length, 4),
    avgCorrectionRate: totalUserMessages > 0
      ? round(totalCorrections / totalUserMessages, 3)
      : 0,
    avgToolCallsPerTask: totalTasks > 0
      ? round(totalToolCalls / totalTasks, 1)
      : 0,
    avgTaskSuccessRate: totalTasks > 0
      ? round(taskSuccessSum / totalTasks, 3)
      : null,
    sessionCount: sessions.length,
  };
}

// ---------------------------------------------------------------------------
// Delta computation
// ---------------------------------------------------------------------------

function computeDelta(
  beforeValue: number,
  afterValue: number,
  higherIsBetter: boolean,
): MetricDelta {
  const value = round(afterValue - beforeValue, 4);
  const pct = percentChange(beforeValue, afterValue);
  const improved = higherIsBetter ? value > 0 : value < 0;

  return { value, percentChange: pct, improved };
}

// ---------------------------------------------------------------------------
// Verdict generation
// ---------------------------------------------------------------------------

function generateVerdict(deltas: ClaudeMdImpactReport['deltas']): string {
  const entries: Array<{ name: string; delta: MetricDelta }> = [
    { name: 'efficiency', delta: deltas.efficiencyScore },
    { name: 'cost', delta: deltas.cost },
    { name: 'corrections', delta: deltas.correctionRate },
    { name: 'tool calls/task', delta: deltas.toolCallsPerTask },
    { name: 'task success', delta: deltas.taskSuccessRate },
  ];

  const improved = entries.filter((e) => e.delta.improved);
  const degraded = entries.filter((e) => !e.delta.improved && e.delta.value !== 0);

  const formatMetric = (e: { name: string; delta: MetricDelta }) => {
    if (e.delta.percentChange === null) return `${e.name} ${e.delta.value > 0 ? '+' : ''}${e.delta.value}`;
    const sign = e.delta.percentChange >= 0 ? '+' : '';
    return `${e.name} ${sign}${e.delta.percentChange}%`;
  };

  // Sort by absolute percent change for most significant first (null treated as 0)
  const sortByImpact = (a: { delta: MetricDelta }, b: { delta: MetricDelta }) =>
    Math.abs(b.delta.percentChange ?? 0) - Math.abs(a.delta.percentChange ?? 0);

  if (improved.length >= 3) {
    const top = improved.sort(sortByImpact).slice(0, 2).map(formatMetric);
    return `Positive impact: ${top.join(', ')}`;
  }

  if (degraded.length >= 3) {
    const top = degraded.sort(sortByImpact).slice(0, 2).map(formatMetric);
    return `Negative impact: ${top.join(', ')}`;
  }

  const parts: string[] = [];
  if (improved.length > 0) {
    parts.push(improved.sort(sortByImpact).slice(0, 1).map(formatMetric).join(''));
  }
  if (degraded.length > 0) {
    parts.push(degraded.sort(sortByImpact).slice(0, 1).map(formatMetric).join(''));
  }

  return parts.length > 0 ? `Mixed impact: ${parts.join(', ')}` : 'No significant change';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function round(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}
