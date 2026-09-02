/**
 * Session Persistence — enriched session summaries with data from all trackers.
 *
 * `FullSessionSummary` extends the minimal `SessionSummary` type with fields
 * aggregated from SessionTracker, CostTracker, TaskDetector, AntiPatternDetector,
 * and EfficiencyScorer.
 *
 * `SessionStore` wraps filesystem operations for saving and loading session files
 * with a `YYYY-MM-DD_sessionId.json` naming convention.
 *
 * `buildSessionSummary()` pulls getMetrics() from each tracker and aggregates
 * task-level data into a single FullSessionSummary.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { createLogger } from '../shared/index.js';
import { redactSensitive } from '../config.js';
import { isSyntheticSessionId, type SessionNameSource } from '../hooks/session-resolver.js';
import type { SessionSummary, ReplayTimelineEntry } from './types.js';
import type { SessionTracker } from '../metrics/session-tracker.js';
import type { CostTracker } from '../metrics/cost-tracker.js';
import type { TaskDetector } from '../metrics/task-detector.js';
import type { AntiPatternDetector } from '../metrics/anti-patterns.js';
import type { EfficiencyScorer, EfficiencyScoreComponents } from '../metrics/efficiency-score.js';
import type { TranscriptMessageTracker } from '../metrics/transcript-message-tracker.js';
import type { SessionOutcomeRecord } from '../metrics/instruction-drift-tracker.js';
import type { AntiPattern } from '../metrics/anti-patterns.js';
import {
  ToolSelectionScorer,
  toToolSelectionSummary,
  type ToolSelectionSummary,
} from '../metrics/tool-selection-scorer.js';
import type { ModelUsageTracker, ModelBreakdownEntry } from '../metrics/model-usage-tracker.js';
import type { QualityProxyTracker } from '../metrics/quality-proxy-tracker.js';
import {
  type QualityProxyRawCounts,
  ZERO_QUALITY_PROXY_COUNTS,
} from '../metrics/quality-proxy-tracker.js';

const logger = createLogger('session-store');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One detected anti-pattern occurrence, persisted per incident rather than
 * grouped by type — the target (`file`/`command`) and the detector's own
 * per-incident occurrence count (`iterations`/`readCount`/etc., matching
 * `AntiPattern`) both survive the round-trip to disk.
 */
export interface PersistedAntiPattern {
  readonly type: string;
  readonly file?: string;
  readonly command?: string;
  readonly iterations?: number;
  readonly readCount?: number;
  readonly repeatCount?: number;
  readonly editCount?: number;
  readonly agentCount?: number;
}

/**
 * Maps detector-reported anti-pattern incidents into the persisted/API shape,
 * redacting `file`/`command` targets the same way other persisted fields are.
 */
export function toPersistedAntiPatterns(patterns: readonly AntiPattern[]): PersistedAntiPattern[] {
  return patterns.map((p) => ({
    type: p.type,
    file: p.file !== undefined ? redactSensitive(p.file) : undefined,
    command: p.command !== undefined ? redactSensitive(p.command) : undefined,
    iterations: p.iterations,
    readCount: p.readCount,
    repeatCount: p.repeatCount,
    editCount: p.editCount,
    agentCount: p.agentCount,
  }));
}

export interface FullSessionSummary extends SessionSummary {
  readonly sessionName: string | null;
  /** Which source produced `sessionName` (see SessionNameSource), or null. */
  readonly sessionNameSource: SessionNameSource | null;
  /**
   * The session's originating intent (first user prompt), redacted, or null.
   * SENSITIVE content: only ever non-null when recordContent was enabled at
   * capture time (force-disabled under highSecurity). See SessionMetrics.
   */
  readonly sessionIntent: string | null;
  readonly repoName: string | null;
  readonly model: string | null;
  readonly toolBreakdown: Record<string, number>;
  readonly filesRead: string[];
  readonly filesModified: string[];
  readonly linesAdded: number;
  readonly linesRemoved: number;
  readonly bashCommandCount: number;
  readonly testRunCount: number;
  readonly testPassCount: number;
  readonly buildRunCount: number;
  readonly buildPassCount: number;
  readonly estimatedCostUsd: number | null;
  /**
   * Portion of estimatedCostUsd attributed to subagent (ctx.agentId) calls —
   * see CostMetrics.subagentCostUsd. 0 for an older session summary written
   * before subagent cost was tracked, and for sessions with no subagent
   * activity.
   */
  readonly subagentCostUsd: number;
  /**
   * Total cost bucketed by local-day key (`YYYY-MM-DD`), mirrored from
   * `CostMetrics.costByDayUsd`. The dashboard's "Spend Today" aggregate sums
   * `costByDayUsd[todayKey]` across sessions — the authoritative today-figure —
   * instead of pro-rating `estimatedCostUsd` (a lifetime cumulative total) by a
   * tool-call timeline, which over-attributes a resumed multi-day session's
   * whole cost to one day. Optional: absent on a session summary written
   * before this field existed, which falls back to the timeline pro-rate
   * path in the aggregate route.
   */
  readonly costByDayUsd?: Record<string, number>;
  /** Subagent-attributed cost by local-day key; today-scoped counterpart to
   * `subagentCostUsd`. Optional for the same backward-compat reason as
   * `costByDayUsd`. */
  readonly subagentCostByDayUsd?: Record<string, number>;
  readonly tokensInput: number;
  readonly tokensOutput: number;
  readonly tokensThinking: number;
  readonly tokensCacheRead: number;
  readonly tokensCacheCreation: number;
  readonly cacheSavingsUsd: number;
  readonly efficiencyScore: number | null;
  /**
   * Number of individual task scores that fed `efficiencyScore` at save
   * time — captured from `EfficiencyScorer.getSessionSampleCount()`, which
   * includes any weight seeded from an earlier restart's checkpoint (not
   * just fresh-this-process scores). Lets a resumed session re-seed a
   * weighted average via `EfficiencyScorer.seedFromPersisted()` instead of
   * losing every pre-restart task's contribution to it. Optional (unlike
   * most fields on this interface) so the many existing test factories
   * building `FullSessionSummary` literals don't all need updating for an
   * additive field — read with `?? 0` at the point of use. 0/absent for an
   * older session summary written before this field existed, and for
   * sessions with no scored tasks.
   */
  readonly efficiencyScoreSampleCount?: number;
  /**
   * Component breakdown backing `efficiencyScore` at save time, captured
   * from `EfficiencyScorer.getSessionAverage()?.components`. Persisted
   * alongside `efficiencyScoreSampleCount` so a re-seeded average's
   * component breakdown is exact, not just its top-level score. Optional
   * for the same reason as `efficiencyScoreSampleCount` above. null/absent
   * for an older session summary written before this field existed, and
   * for sessions with no scored tasks.
   */
  readonly efficiencyScoreComponents?: EfficiencyScoreComponents | null;
  readonly antiPatterns: PersistedAntiPattern[];
  readonly taskCount: number;
  readonly taskSuccessRate: number | null;
  readonly toolSuccessRate: number | null;
  readonly contextCompressions: number;
  readonly agentSpawns: number;
  readonly userMessages: number;
  readonly assistantMessages: number;
  readonly userCorrections: number;
  readonly outcome: string;
  readonly platform?: string;
  readonly instructionPromptHash?: string | null;
  readonly timeline?: ReplayTimelineEntry[];
  /**
   * Tool-selection quality summary for this session, computed once at save
   * time from the full in-memory ToolCallRecord[] — the only point where
   * outputSizeBytes (needed for unused-output detection) is still available;
   * it is never persisted anywhere else, including `timeline` above. null
   * for an older session summary written before this field existed, and
   * for sessions with no tool calls.
   */
  readonly toolSelectionMetrics: ToolSelectionSummary | null;
  /**
   * Raw per-model token/cost counters for this session, keyed by model name.
   * Captured once at save time from ModelUsageTracker.getRawBreakdown(). Raw
   * counters only, no derived ratios — see ModelUsageTracker.combineBreakdowns
   * for why ratios are always recomputed at read time instead of persisted.
   * `{}` for an older session summary written before this field existed,
   * and for sessions with no token events.
   */
  readonly modelBreakdown: Readonly<Record<string, ModelBreakdownEntry>>;
  /**
   * Per-workflow-run cost, split by local-day, keyed by workflow_run_id then
   * day key — the exact shape `CostMetrics.costByWorkflowRunId` already
   * produces. Captured once at save time so a resumed session's per-run
   * spend survives a process restart (see CostTracker.seedFromPersisted()).
   * `{}` for an older session summary written before this field existed,
   * and for sessions with no workflow runs.
   */
  readonly costByWorkflowRunId: Record<string, Record<string, number>>;
  /**
   * Raw quality-proxy signal counts for this session, captured once at save
   * time from QualityProxyTracker.getRawCounts(). Raw counts only, no derived
   * rates — see combineQualityProxyRawCounts for why rates are always
   * recomputed at read time instead of persisted. All-zero
   * (ZERO_QUALITY_PROXY_COUNTS) for an older session summary written before
   * this field existed, and for sessions with no quality signals. Nested
   * (not top-level) specifically to avoid
   * colliding with the unrelated top-level testPassCount/testRunCount fields
   * above (total task test runs, not quality-proxy test signals).
   */
  readonly qualityProxy: QualityProxyRawCounts;
}

export interface SessionFileInfo {
  readonly filename: string;
  readonly sessionId: string;
  readonly date: string;
}

export interface ListSessionsOptions {
  since?: Date;
  developer?: string;
}

// ---------------------------------------------------------------------------
// SessionStore
// ---------------------------------------------------------------------------

/**
 * Combine two views of the same session so neither writer can lose the other's
 * data. Counters take the max rather than the sum: the two processes observe
 * overlapping (not disjoint) slices of one session, so summing would inflate
 * and taking the incoming value alone would regress.
 */
export function mergeSummaries(
  existing: FullSessionSummary,
  incoming: FullSessionSummary,
): FullSessionSummary {
  const maxNum = (a: unknown, b: unknown): number =>
    Math.max(typeof a === 'number' ? a : 0, typeof b === 'number' ? b : 0);
  const maxNullable = (a: number | null, b: number | null): number | null =>
    a === null && b === null ? null : Math.max(a ?? 0, b ?? 0);
  const mergeCounts = (
    a: Record<string, number> = {},
    b: Record<string, number> = {},
  ): Record<string, number> => {
    const out: Record<string, number> = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = Math.max(out[k] ?? 0, v);
    return out;
  };
  const union = (a: string[] = [], b: string[] = []): string[] => [...new Set([...a, ...b])];
  // efficiencyScore/efficiencyScoreSampleCount/efficiencyScoreComponents must
  // always come from the SAME side, atomically — EfficiencyScorer.
  // seedFromPersisted() treats sampleCount as a weight multiplier
  // (score * sampleCount), not just a display field, so merging the three
  // independently (e.g. taking the newer score but the max sampleCount) can
  // attach a thin/unrelated sample count to a completely different score,
  // radically over- or under-weighting it on the next re-seed. When only one
  // side has a real score, that side wins outright (this is what makes an
  // unseeded write never erase a real prior score). When both do, the side
  // with the larger sampleCount wins — the more statistically meaningful one.
  const mergeEfficiencyScoreTriple = (
    existing: FullSessionSummary,
    incoming: FullSessionSummary,
  ): Pick<
    FullSessionSummary,
    'efficiencyScore' | 'efficiencyScoreSampleCount' | 'efficiencyScoreComponents'
  > => {
    const existingHasScore = existing.efficiencyScore !== null;
    const incomingHasScore = incoming.efficiencyScore !== null;
    const winner =
      existingHasScore && incomingHasScore
        ? (incoming.efficiencyScoreSampleCount ?? 0) >= (existing.efficiencyScoreSampleCount ?? 0)
          ? incoming
          : existing
        : incomingHasScore
          ? incoming
          : existing;
    return {
      efficiencyScore: winner.efficiencyScore,
      efficiencyScoreSampleCount: winner.efficiencyScoreSampleCount ?? 0,
      efficiencyScoreComponents: winner.efficiencyScoreComponents ?? null,
    };
  };
  const mergeCostByWorkflowRunId = (
    a: Record<string, Record<string, number>> = {},
    b: Record<string, Record<string, number>> = {},
  ): Record<string, Record<string, number>> => {
    const out: Record<string, Record<string, number>> = { ...a };
    for (const [runId, dayCosts] of Object.entries(b)) {
      out[runId] = mergeCounts(out[runId], dayCosts);
    }
    return out;
  };

  const modelBreakdown: Record<string, ModelBreakdownEntry> = { ...existing.modelBreakdown };
  for (const [model, entry] of Object.entries(incoming.modelBreakdown ?? {})) {
    const prev = modelBreakdown[model];
    modelBreakdown[model] = prev
      ? {
          requestCount: Math.max(prev.requestCount, entry.requestCount),
          totalInputTokens: Math.max(prev.totalInputTokens, entry.totalInputTokens),
          totalOutputTokens: Math.max(prev.totalOutputTokens, entry.totalOutputTokens),
          totalCostUsd: Math.max(prev.totalCostUsd, entry.totalCostUsd),
        }
      : entry;
  }

  const qa = existing.qualityProxy ?? ZERO_QUALITY_PROXY_COUNTS;
  const qb = incoming.qualityProxy ?? ZERO_QUALITY_PROXY_COUNTS;
  const qualityProxy: QualityProxyRawCounts = {
    totalSignals: maxNum(qa.totalSignals, qb.totalSignals),
    diffApplyCleanCount: maxNum(qa.diffApplyCleanCount, qb.diffApplyCleanCount),
    diffFailCount: maxNum(qa.diffFailCount, qb.diffFailCount),
    testPassCount: maxNum(qa.testPassCount, qb.testPassCount),
    testFailCount: maxNum(qa.testFailCount, qb.testFailCount),
    backtrackCount: maxNum(qa.backtrackCount, qb.backtrackCount),
    selfCorrectionCount: maxNum(qa.selfCorrectionCount, qb.selfCorrectionCount),
  };

  // Keep whichever tool-selection score saw more of the session; it is scored
  // from an ordered record list that cannot be meaningfully merged field-wise.
  const toolSelectionMetrics =
    (incoming.toolSelectionMetrics?.totalCalls ?? 0) >=
    (existing.toolSelectionMetrics?.totalCalls ?? 0)
      ? (incoming.toolSelectionMetrics ?? existing.toolSelectionMetrics)
      : existing.toolSelectionMetrics;

  const timeline =
    (incoming.timeline?.length ?? 0) >= (existing.timeline?.length ?? 0)
      ? incoming.timeline
      : existing.timeline;

  const startTime = Math.min(
    existing.startTime || incoming.startTime,
    incoming.startTime || existing.startTime,
  );
  const endTime = maxNum(existing.endTime, incoming.endTime);

  return {
    ...existing,
    ...incoming,
    startTime,
    endTime,
    durationMs: Math.max(0, endTime - startTime),
    toolCallCount: maxNum(existing.toolCallCount, incoming.toolCallCount),
    sessionName: incoming.sessionName ?? existing.sessionName,
    // Tie the source to whichever name won above so a name/source desync can't
    // arise (incoming spreads a null source alongside a null name). The
    // in-process tracker already enforces the no-downgrade invariant on
    // `incoming`, so taking incoming's name+source when present is safe.
    sessionNameSource: incoming.sessionName
      ? incoming.sessionNameSource
      : existing.sessionNameSource,
    // Never clobber a previously-captured intent with a later intent-less write
    // (e.g. a checkpoint saved before the name/intent was resolved, or a run
    // with recordContent off).
    sessionIntent: incoming.sessionIntent ?? existing.sessionIntent,
    repoName: incoming.repoName ?? existing.repoName,
    model: incoming.model ?? existing.model,
    platform: incoming.platform ?? existing.platform,
    instructionPromptHash: incoming.instructionPromptHash ?? existing.instructionPromptHash,
    toolBreakdown: mergeCounts(existing.toolBreakdown, incoming.toolBreakdown),
    filesRead: union(existing.filesRead, incoming.filesRead),
    filesModified: union(existing.filesModified, incoming.filesModified),
    linesAdded: maxNum(existing.linesAdded, incoming.linesAdded),
    linesRemoved: maxNum(existing.linesRemoved, incoming.linesRemoved),
    bashCommandCount: maxNum(existing.bashCommandCount, incoming.bashCommandCount),
    testRunCount: maxNum(existing.testRunCount, incoming.testRunCount),
    testPassCount: maxNum(existing.testPassCount, incoming.testPassCount),
    buildRunCount: maxNum(existing.buildRunCount, incoming.buildRunCount),
    buildPassCount: maxNum(existing.buildPassCount, incoming.buildPassCount),
    estimatedCostUsd: maxNullable(existing.estimatedCostUsd, incoming.estimatedCostUsd),
    subagentCostUsd: maxNum(existing.subagentCostUsd, incoming.subagentCostUsd),
    tokensInput: maxNum(existing.tokensInput, incoming.tokensInput),
    tokensOutput: maxNum(existing.tokensOutput, incoming.tokensOutput),
    tokensThinking: maxNum(existing.tokensThinking, incoming.tokensThinking),
    tokensCacheRead: maxNum(existing.tokensCacheRead, incoming.tokensCacheRead),
    tokensCacheCreation: maxNum(existing.tokensCacheCreation, incoming.tokensCacheCreation),
    cacheSavingsUsd: maxNum(existing.cacheSavingsUsd, incoming.cacheSavingsUsd),
    ...mergeEfficiencyScoreTriple(existing, incoming),
    costByWorkflowRunId: mergeCostByWorkflowRunId(
      existing.costByWorkflowRunId,
      incoming.costByWorkflowRunId,
    ),
    taskCount: maxNum(existing.taskCount, incoming.taskCount),
    taskSuccessRate: incoming.taskSuccessRate ?? existing.taskSuccessRate,
    toolSuccessRate: incoming.toolSuccessRate ?? existing.toolSuccessRate,
    contextCompressions: maxNum(existing.contextCompressions, incoming.contextCompressions),
    agentSpawns: maxNum(existing.agentSpawns, incoming.agentSpawns),
    userMessages: maxNum(existing.userMessages, incoming.userMessages),
    assistantMessages: maxNum(existing.assistantMessages, incoming.assistantMessages),
    userCorrections: maxNum(existing.userCorrections, incoming.userCorrections),
    antiPatterns:
      (incoming.antiPatterns?.length ?? 0) >= (existing.antiPatterns?.length ?? 0)
        ? incoming.antiPatterns
        : existing.antiPatterns,
    outcome:
      incoming.outcome === 'completed' || existing.outcome !== 'completed'
        ? incoming.outcome
        : existing.outcome,
    ...(timeline ? { timeline } : {}),
    toolSelectionMetrics,
    modelBreakdown,
    qualityProxy,
  };
}

export class SessionStore {
  private readonly sessionsDir: string;

  constructor(options: { storagePath: string }) {
    this.sessionsDir = join(options.storagePath, 'sessions');
  }

  getSessionsDir(): string {
    return this.sessionsDir;
  }

  saveSession(summary: FullSessionSummary): void {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(summary.sessionId) || summary.sessionId === 'unknown') {
      logger.warn('Rejecting invalid sessionId for file path', { sessionId: summary.sessionId });
      return;
    }

    if (!existsSync(this.sessionsDir)) {
      mkdirSync(this.sessionsDir, { recursive: true, mode: 0o700 });
    }

    // Look up any existing file for this sessionId BEFORE deciding the
    // filename — by sessionId alone, not by today's date-prefixed path. A
    // session can already have a file under an EARLIER date than this
    // write's own startTime computes (e.g. a `--local`/synthetic-owner
    // process rolling up a session it only started observing after a date
    // boundary — see LocalSessionAggregator). Deciding the filename from
    // `summary.startTime` alone before merging, then merging in whatever
    // file happens to share the sessionId regardless of date, wrote the
    // merged (inflated, since counters take the max) result to a NEW file
    // while leaving the OLD file on disk untouched — the session then
    // appeared twice in history with overlapping, double-counted totals.
    const existingWithPath = this.loadSessionWithPath(summary.sessionId);

    // A second process saving under the same sessionId (e.g. two MCP
    // servers both resumed/forked against one real session ID) would
    // otherwise silently overwrite the first save with no error.
    //
    // Guard the destructive case: a short-lived process that adopts an
    // existing session ID (resolved from the session-by-cwd breadcrumb) but
    // never observed any hook activity would replace a fully recorded session
    // with an all-zero summary, erasing tool calls, tokens and cost from the
    // dashboard on the next refresh. Never let an empty summary clobber a
    // non-empty one; other collisions keep the previous last-write-wins
    // behaviour with a warning.
    let toWrite: FullSessionSummary = summary;
    if (existingWithPath) {
      const { summary: existing } = existingWithPath;
      const existingCalls = existing.toolCallCount ?? 0;
      if (existingCalls > 0 && (summary.toolCallCount ?? 0) === 0) {
        logger.warn('Refusing to overwrite recorded session with an empty summary', {
          sessionId: summary.sessionId,
        });
        return;
      }
      // Two processes legitimately share one session id: the CLI/editor
      // spawns an MCP engine that owns the session natively, while a
      // `--local` dashboard adopts the same id from the session-by-cwd
      // breadcrumb. Each sees only part of the picture — the engine has the
      // token/model events, the dashboard has the aggregated hook activity —
      // so plain last-write-wins let whichever wrote last erase the other's
      // data, which is how a fully recorded session could come back with
      // modelBreakdown {} and a lower toolCallCount. Merge non-destructively
      // instead: counters take the max (they only ever grow, so max never
      // regresses and never double-counts overlapping views).
      toWrite = mergeSummaries(existing, summary);
    }

    // The filename is derived from the merged (earliest) startTime, not the
    // incoming write's own — mergeSummaries() takes Math.min() of the two,
    // so this is normally the existing file's own date; recomputing here
    // keeps the filename consistent with what's actually written.
    const startDate = new Date(toWrite.startTime);
    if (!isFinite(startDate.getTime())) {
      throw new Error(`Invalid startTime for session ${toWrite.sessionId}: ${toWrite.startTime}`);
    }
    const date = startDate.toISOString().slice(0, 10);
    const filename = `${date}_${toWrite.sessionId}.json`;
    const filepath = resolve(this.sessionsDir, filename);
    if (!filepath.startsWith(this.sessionsDir + sep)) {
      throw new Error(`Session path escaped storage directory: ${filepath}`);
    }

    try {
      writeFileSync(filepath, JSON.stringify(toWrite, null, 2) + '\n', { mode: 0o600 });
      // The merge landed on a different filename than where the existing
      // record lived (a date-rollover case) — remove the now-superseded
      // file so the session isn't left duplicated across two files.
      if (existingWithPath && existingWithPath.filepath !== filepath) {
        try {
          unlinkSync(existingWithPath.filepath);
        } catch (err) {
          logger.warn('Failed to remove superseded session file after merge', {
            sessionId: toWrite.sessionId,
            stalePath: existingWithPath.filepath,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      logger.debug('Session saved', { sessionId: toWrite.sessionId, filename });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('Failed to save session file', {
        sessionId: toWrite.sessionId,
        filename,
        error: message,
      });
    }
  }

  loadSession(sessionId: string): FullSessionSummary | null {
    return this.loadSessionWithPath(sessionId)?.summary ?? null;
  }

  /** Like loadSession(), but also returns the file path it was loaded from — used by saveSession() to detect and clean up a stale file after a merge relocates a session to a different filename. */
  private loadSessionWithPath(
    sessionId: string,
  ): { summary: FullSessionSummary; filepath: string } | null {
    if (!existsSync(this.sessionsDir)) return null;

    for (const file of readdirSync(this.sessionsDir)) {
      if (!file.endsWith('.json')) continue;
      if (parseSessionFilename(file)?.sessionId !== sessionId) continue;

      const filepath = join(this.sessionsDir, file);
      try {
        const raw = readFileSync(filepath, 'utf-8');
        const session = deserializeSession(raw);
        if (session === null) {
          logger.warn('Failed to deserialize session file', { file });
          return null;
        }
        return { summary: session, filepath };
      } catch {
        logger.warn('Failed to read session file', { file });
      }
    }

    return null;
  }

  listSessions(options?: ListSessionsOptions): SessionFileInfo[] {
    if (!existsSync(this.sessionsDir)) return [];

    const sinceDate = options?.since ? formatDate(options.since) : null;
    const results: SessionFileInfo[] = [];

    for (const file of readdirSync(this.sessionsDir)) {
      if (!file.endsWith('.json')) continue;

      const parsed = parseSessionFilename(file);
      if (!parsed) continue;

      if (sinceDate && parsed.date < sinceDate) continue;

      if (options?.developer) {
        try {
          const raw = readFileSync(join(this.sessionsDir, file), 'utf-8');
          const session = deserializeSession(raw);
          if (session?.developer !== options.developer) continue;
        } catch {
          continue;
        }
      }

      results.push(parsed);
    }

    return results.sort(
      (a, b) => a.date.localeCompare(b.date) || a.sessionId.localeCompare(b.sessionId),
    );
  }

  loadAllSessions(options?: ListSessionsOptions): FullSessionSummary[] {
    if (!existsSync(this.sessionsDir)) return [];

    const sinceDate = options?.since ? formatDate(options.since) : null;
    const results: FullSessionSummary[] = [];

    for (const file of readdirSync(this.sessionsDir)) {
      if (!file.endsWith('.json')) continue;

      const parsed = parseSessionFilename(file);
      if (!parsed) continue;

      if (sinceDate && parsed.date < sinceDate) continue;

      try {
        const raw = readFileSync(join(this.sessionsDir, file), 'utf-8');
        const session = deserializeSession(raw);
        if (!session) continue;

        // Synthetic session IDs (`local-*`, `proxy-*`, `pending-*`) are
        // MCP-internal bookkeeping from --local / proxy modes, never a real
        // Claude Code session. persistSession() in src/index.ts already
        // refuses to write new ones; any that still exist on disk are stale
        // artifacts from before that guard shipped. Filtering them here
        // means every consumer of this loader (and of loadTodaySessions() /
        // loadSessionsOverlappingToday(), which both delegate to it) gets
        // clean data without re-implementing the same check.
        if (isSyntheticSessionId(session.sessionId)) continue;

        if (options?.developer && session.developer !== options.developer) continue;

        results.push(session);
      } catch {
        logger.warn('Failed to read session file', { file });
      }
    }

    return results.sort((a, b) => a.startTime - b.startTime);
  }

  loadTodaySessions(): FullSessionSummary[] {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return this.loadAllSessions({ since: today });
  }

  /**
   * Sessions whose wall-clock spans today's local day at all — i.e. include
   * a session that started yesterday and ended this morning. The "today
   * spend" calculation needs these to attribute the today-portion of any
   * cross-midnight session, since `loadTodaySessions()` filters by file-name
   * date (= start date) and would silently drop them.
   *
   * Loads a 2-day window (yesterday + today's date prefixes) and filters by
   * endTime overlap with [startOfToday, now].
   */
  loadSessionsOverlappingToday(): FullSessionSummary[] {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today.getTime() - 86_400_000);
    const startOfToday = today.getTime();
    const all = this.loadAllSessions({ since: yesterday });
    // endTime=0 is the deserialisation default for sessions that crashed or
    // were written by an older build without the endTime field. Treat those as
    // "unknown end" and include them — they are already bounded to the 2-day
    // window by loadAllSessions({ since: yesterday }).
    return all.filter((s) => s.endTime === 0 || s.endTime >= startOfToday);
  }
}

// ---------------------------------------------------------------------------
// buildSessionSummary
// ---------------------------------------------------------------------------

export interface BuildSessionSummarySources {
  sessionTracker: SessionTracker;
  costTracker?: CostTracker;
  taskDetector?: TaskDetector;
  antiPatternDetector?: AntiPatternDetector;
  efficiencyScorer?: EfficiencyScorer;
  transcriptMessageTracker?: TranscriptMessageTracker;
  toolSelectionScorer?: ToolSelectionScorer;
  modelUsageTracker?: ModelUsageTracker;
  qualityProxyTracker?: QualityProxyTracker;
  developer: string;
  repoName?: string | null;
  /**
   * Session outcome to persist. Defaults to `'completed'`. Periodic mid-session
   * checkpoints MUST pass `'in progress'` so a live session is never persisted
   * (and then rendered) as completed — the dashboard detail route reads this
   * snapshot's outcome verbatim. Only the terminal (shutdown) save should write
   * `'completed'`.
   */
  outcome?: string;
  platform?: string;
  instructionPromptHash?: string | null;
}

export function buildSessionSummary(sources: BuildSessionSummarySources): FullSessionSummary {
  const {
    sessionTracker,
    costTracker,
    taskDetector,
    antiPatternDetector,
    efficiencyScorer,
    developer,
  } = sources;

  const sessionMetrics = sessionTracker.getMetrics();
  const costMetrics = costTracker?.getMetrics() ?? null;
  const taskMetrics = taskDetector?.getMetrics() ?? null;
  const transcriptMessageMetrics = sources.transcriptMessageTracker?.getMetrics();

  // Aggregate task-level data
  const allFilesRead = new Set<string>();
  const allFilesModified = new Set<string>();
  let totalLinesAdded = 0;
  let totalLinesRemoved = 0;
  let totalTestsRun = 0;
  let totalTestsPassed = 0;
  let totalBuildsRun = 0;
  let totalBuildsPassed = 0;
  let totalAgentSpawns = 0;
  const allToolCalls: import('../storage/types.js').ToolCallRecord[] = [];

  if (taskMetrics) {
    const allTasks = [...taskMetrics.completedTasks];
    const activeTask = taskDetector?.getCurrentTask();
    if (activeTask) allTasks.push(activeTask);

    for (const task of allTasks) {
      for (const f of task.filesRead) allFilesRead.add(f);
      for (const f of task.filesModified) allFilesModified.add(f);
      totalLinesAdded += task.linesAdded;
      totalLinesRemoved += task.linesRemoved;
      totalTestsRun += task.testsRun;
      totalTestsPassed += task.testsPassed;
      totalBuildsRun += task.buildRun;
      totalBuildsPassed += task.buildPassed;
      totalAgentSpawns += task.subAgentsSpawned;
      allToolCalls.push(...task.toolCalls);
    }

    // Fold in pre-restart totals recovered by TaskDetector.seedFromPersisted()
    // — see TaskMetrics.seededAggregate's doc comment for why these can't be
    // represented as a synthetic entry in completedTasks above.
    if (taskMetrics.seededAggregate) {
      for (const f of taskMetrics.seededAggregate.filesRead) allFilesRead.add(f);
      for (const f of taskMetrics.seededAggregate.filesModified) allFilesModified.add(f);
      totalLinesAdded += taskMetrics.seededAggregate.linesAdded;
      totalLinesRemoved += taskMetrics.seededAggregate.linesRemoved;
      totalTestsRun += taskMetrics.seededAggregate.testsRun;
      totalTestsPassed += taskMetrics.seededAggregate.testsPassed;
      totalBuildsRun += taskMetrics.seededAggregate.buildRun;
      totalBuildsPassed += taskMetrics.seededAggregate.buildPassed;
      totalAgentSpawns += taskMetrics.seededAggregate.agentSpawns;
    }
  }

  // Anti-pattern analysis
  const antiPatternResults =
    antiPatternDetector && allToolCalls.length > 0
      ? antiPatternDetector.analyze(allToolCalls)
      : null;

  const antiPatterns: PersistedAntiPattern[] = antiPatternResults
    ? toPersistedAntiPatterns(antiPatternResults.patterns)
    : [];

  // Tool-selection quality: same allToolCalls used for anti-pattern analysis
  // above, still holding real outputSizeBytes at this point — see the
  // ToolSelectionSummary doc comment on FullSessionSummary for why this is
  // the only place that's true.
  const toolSelectionResult =
    sources.toolSelectionScorer && allToolCalls.length > 0
      ? toToolSelectionSummary(sources.toolSelectionScorer.scoreSession(allToolCalls))
      : null;

  // Efficiency score
  const efficiencyAvg = efficiencyScorer?.getSessionAverage() ?? null;

  // Task success rate: ratio of test passes to test runs across all tasks
  const taskSuccessRate =
    totalTestsRun > 0 ? Math.round((totalTestsPassed / totalTestsRun) * 1000) / 1000 : null;

  // Enriched timeline for session replay
  const timeline: ReplayTimelineEntry[] = allToolCalls.map((tc) => ({
    timestamp: tc.timestamp,
    toolName: tc.toolName,
    durationMs: tc.durationMs,
    success: tc.success,
    filePath: tc.filePath ? redactSensitive(String(tc.filePath)) : undefined,
    command: tc.command ? redactSensitive(String(tc.command)) : undefined,
    isTestCommand: (tc.isTestCommand as boolean | undefined) || undefined,
    isBuildCommand: (tc.isBuildCommand as boolean | undefined) || undefined,
    isLintCommand: (tc.isLintCommand as boolean | undefined) || undefined,
    errorType: tc.errorType || undefined,
  }));

  const now = Date.now();

  return {
    sessionId: sessionMetrics.sessionId,
    sessionName: sessionMetrics.sessionName ? redactSensitive(sessionMetrics.sessionName) : null,
    // Source is an enum label (not user content) — persisted unredacted.
    sessionNameSource: sessionMetrics.sessionNameSource ?? null,
    // Intent is SENSITIVE content; the tracker only holds a value when
    // recordContent was on, and it is already redacted there. Redact again
    // (idempotent) so persistence is safe regardless of caller.
    sessionIntent: sessionMetrics.sessionIntent
      ? redactSensitive(sessionMetrics.sessionIntent)
      : null,
    repoName: sources.repoName ? redactSensitive(sources.repoName) : null,
    startTime: sessionMetrics.sessionStartTime,
    endTime: now,
    // Recalculate durationMs from wall-clock times rather than trusting the
    // tracker's accumulated value, which can lag if polling is infrequent.
    durationMs: now - sessionMetrics.sessionStartTime,
    toolCallCount: sessionMetrics.toolCallCount,
    developer,
    model: costMetrics?.model ?? null,
    toolBreakdown: { ...sessionMetrics.toolCallCountByTool },
    filesRead: [...allFilesRead].sort().map((f) => redactSensitive(f)),
    filesModified: [...allFilesModified].sort().map((f) => redactSensitive(f)),
    linesAdded: totalLinesAdded,
    linesRemoved: totalLinesRemoved,
    bashCommandCount: sessionMetrics.bashCommandsRun,
    testRunCount: totalTestsRun,
    testPassCount: totalTestsPassed,
    buildRunCount: totalBuildsRun,
    buildPassCount: totalBuildsPassed,
    estimatedCostUsd: costMetrics?.sessionTotalCostUsd ?? null,
    subagentCostUsd: costMetrics?.subagentCostUsd ?? 0,
    costByDayUsd: costMetrics?.costByDayUsd ?? {},
    subagentCostByDayUsd: costMetrics?.subagentCostByDayUsd ?? {},
    tokensInput: costMetrics?.totalInputTokens ?? 0,
    tokensOutput: costMetrics?.totalOutputTokens ?? 0,
    tokensThinking: costMetrics?.totalThinkingTokens ?? 0,
    tokensCacheRead: costMetrics?.totalCacheReadTokens ?? 0,
    tokensCacheCreation: costMetrics?.totalCacheCreationTokens ?? 0,
    cacheSavingsUsd: costMetrics?.totalCacheSavingsUsd ?? 0,
    efficiencyScore: efficiencyAvg?.score ?? null,
    efficiencyScoreSampleCount: efficiencyScorer?.getSessionSampleCount() ?? 0,
    efficiencyScoreComponents: efficiencyAvg?.components ?? null,
    antiPatterns,
    taskCount: (taskMetrics?.totalTasksCompleted ?? 0) + (taskMetrics?.currentTaskActive ? 1 : 0),
    taskSuccessRate,
    toolSuccessRate: sessionMetrics.toolSuccessRate,
    contextCompressions: 0,
    agentSpawns: totalAgentSpawns,
    userMessages: transcriptMessageMetrics?.userMessages ?? 0,
    assistantMessages: transcriptMessageMetrics?.assistantMessages ?? 0,
    userCorrections: transcriptMessageMetrics?.userCorrections ?? 0,
    outcome: sources.outcome ?? 'completed',
    platform: sources.platform,
    instructionPromptHash: sources.instructionPromptHash ?? null,
    timeline: timeline.length > 0 ? timeline : undefined,
    toolSelectionMetrics: toolSelectionResult,
    modelBreakdown: sources.modelUsageTracker?.getRawBreakdown() ?? {},
    costByWorkflowRunId: costMetrics?.costByWorkflowRunId ?? {},
    qualityProxy: sources.qualityProxyTracker?.getRawCounts() ?? ZERO_QUALITY_PROXY_COUNTS,
  };
}

/**
 * Maps a persisted session summary into the shape InstructionDriftTracker
 * consumes, for both startup hydration (loadRecords) and shutdown recording
 * (recordSessionOutcome, which only uses the outcome fields and ignores
 * promptHash/timestamp). Returns null when the session never had a prompt
 * hash captured (no CLAUDE.md read that session, or the session predates
 * this field's introduction).
 */
export function sessionSummaryToDriftRecord(
  summary: FullSessionSummary,
): SessionOutcomeRecord | null {
  if (summary.instructionPromptHash === null || summary.instructionPromptHash === undefined) {
    return null;
  }

  return {
    sessionId: summary.sessionId,
    promptHash: summary.instructionPromptHash,
    timestamp: summary.endTime,
    successRate: summary.taskSuccessRate,
    totalTokens: summary.tokensInput + summary.tokensOutput,
    thrashingIncidents: summary.antiPatterns.filter((p) => p.type === 'thrashing').length,
    taskCount: summary.taskCount,
    avgEfficiency: summary.efficiencyScore,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The on-disk shape `deserializeFullSessionSummary` reads. Every field stays
 * `unknown` except the five that get `Array.isArray`/`typeof === 'object'`
 * checked before further processing below — those get just enough shape to
 * remove the inner cast that check's body previously needed, while every
 * runtime guard stays exactly as defensive as before (a legacy on-disk file
 * from an older build may not match this shape).
 */
interface SerializedFullSessionSummary {
  readonly sessionId?: unknown;
  readonly sessionName?: unknown;
  readonly sessionNameSource?: unknown;
  readonly sessionIntent?: unknown;
  readonly repoName?: unknown;
  readonly startTime?: unknown;
  readonly endTime?: unknown;
  readonly durationMs?: unknown;
  readonly toolCallCount?: unknown;
  readonly developer?: unknown;
  readonly model?: unknown;
  readonly toolBreakdown?: Record<string, unknown>;
  readonly filesRead?: unknown[];
  readonly filesModified?: unknown[];
  readonly linesAdded?: unknown;
  readonly linesRemoved?: unknown;
  readonly bashCommandCount?: unknown;
  readonly testRunCount?: unknown;
  readonly testPassCount?: unknown;
  readonly buildRunCount?: unknown;
  readonly buildPassCount?: unknown;
  readonly estimatedCostUsd?: unknown;
  readonly subagentCostUsd?: unknown;
  readonly costByDayUsd?: unknown;
  readonly subagentCostByDayUsd?: unknown;
  readonly tokensInput?: unknown;
  readonly tokensOutput?: unknown;
  readonly tokensThinking?: unknown;
  readonly tokensCacheRead?: unknown;
  readonly tokensCacheCreation?: unknown;
  readonly cacheSavingsUsd?: unknown;
  readonly efficiencyScore?: unknown;
  readonly efficiencyScoreSampleCount?: unknown;
  readonly efficiencyScoreComponents?: Record<string, unknown>;
  readonly antiPatterns?: Array<Record<string, unknown>>;
  readonly taskCount?: unknown;
  readonly taskSuccessRate?: unknown;
  readonly toolSuccessRate?: unknown;
  readonly contextCompressions?: unknown;
  readonly agentSpawns?: unknown;
  readonly userMessages?: unknown;
  readonly assistantMessages?: unknown;
  readonly userCorrections?: unknown;
  readonly outcome?: unknown;
  readonly platform?: unknown;
  readonly instructionPromptHash?: unknown;
  readonly timeline?: Array<Record<string, unknown>>;
  readonly toolSelectionMetrics?: unknown;
  readonly modelBreakdown?: Record<string, unknown>;
  readonly costByWorkflowRunId?: Record<string, unknown>;
  readonly qualityProxy?: Record<string, unknown>;
}

/**
 * Parse an untrusted value into a `Record<string, number>`, dropping any
 * non-finite or non-numeric entries. Used to hydrate the per-day cost maps
 * (`costByDayUsd` / `subagentCostByDayUsd`) from disk. Returns undefined when
 * the value is absent or not an object, so a session summary that predates
 * these keys leaves the field undefined and falls through to the aggregate
 * route's timeline pro-rate fallback.
 */
function parseNumberRecord(value: unknown): Record<string, number> | undefined {
  // Reject arrays too (typeof [] === 'object'): a corrupt `costByDayUsd: [5]`
  // must yield undefined so the aggregate route falls through to the timeline
  // pro-rate path, not a bogus `{ '0': 5 }` map that silently reads as $0 today.
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/**
 * Explicitly extract known fields from a raw session object (already parsed
 * from JSON) rather than blindly casting. Prevents untrusted keys from disk
 * being misinterpreted as typed properties. Exported for testing.
 */
export function deserializeFullSessionSummary(
  obj: SerializedFullSessionSummary,
): FullSessionSummary {
  const toolBreakdown = Object.create(null) as Record<string, number>;
  if (typeof obj.toolBreakdown === 'object' && obj.toolBreakdown !== null) {
    for (const [k, v] of Object.entries(obj.toolBreakdown)) {
      if (typeof v === 'number') toolBreakdown[k] = v;
    }
  }

  // Legacy on-disk files only ever have the old `{type, count}` shape —
  // `count` meant "distinct entries of this type" and carried no target
  // info. Every downstream consumer (trend analysis, weekly summaries,
  // thrashing-incident counts) counts array entries rather than reading a
  // magnitude field, so a legacy entry is expanded back into `count`
  // separate rows of that type here, leaving `file`/`command`/etc.
  // undefined for those older records — that keeps "one array entry = one
  // incident" true for both legacy and current on-disk shapes.
  const antiPatterns: PersistedAntiPattern[] = [];
  if (Array.isArray(obj.antiPatterns)) {
    for (const ap of obj.antiPatterns) {
      if (typeof ap === 'object' && ap !== null) {
        const a = ap;
        if (typeof a.type !== 'string') continue;
        const hasMagnitudeField =
          typeof a.iterations === 'number' ||
          typeof a.readCount === 'number' ||
          typeof a.repeatCount === 'number' ||
          typeof a.editCount === 'number' ||
          typeof a.agentCount === 'number';
        if (!hasMagnitudeField && typeof a.count === 'number') {
          const legacyCount = Math.max(0, Math.trunc(a.count));
          for (let i = 0; i < legacyCount; i++) {
            antiPatterns.push({ type: a.type });
          }
          continue;
        }
        antiPatterns.push({
          type: a.type,
          file: typeof a.file === 'string' ? a.file : undefined,
          command: typeof a.command === 'string' ? a.command : undefined,
          iterations: typeof a.iterations === 'number' ? a.iterations : undefined,
          readCount: typeof a.readCount === 'number' ? a.readCount : undefined,
          repeatCount: typeof a.repeatCount === 'number' ? a.repeatCount : undefined,
          editCount: typeof a.editCount === 'number' ? a.editCount : undefined,
          agentCount: typeof a.agentCount === 'number' ? a.agentCount : undefined,
        });
      }
    }
  }

  const toolSelectionMetrics: ToolSelectionSummary | null = (() => {
    const t = obj.toolSelectionMetrics;
    if (typeof t !== 'object' || t === null) return null;
    const r = t as Record<string, unknown>;
    if (
      typeof r.score !== 'number' ||
      typeof r.totalCalls !== 'number' ||
      typeof r.penalizedCalls !== 'number' ||
      typeof r.redundantReadCount !== 'number' ||
      typeof r.repeatedFailureCount !== 'number' ||
      typeof r.unusedOutputCount !== 'number'
    ) {
      return null;
    }
    return {
      score: r.score,
      totalCalls: r.totalCalls,
      penalizedCalls: r.penalizedCalls,
      redundantReadCount: r.redundantReadCount,
      repeatedFailureCount: r.repeatedFailureCount,
      unusedOutputCount: r.unusedOutputCount,
    };
  })();

  const modelBreakdown: Record<string, ModelBreakdownEntry> = {};
  if (typeof obj.modelBreakdown === 'object' && obj.modelBreakdown !== null) {
    for (const [model, entry] of Object.entries(obj.modelBreakdown)) {
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as Record<string, unknown>;
      if (
        typeof e.requestCount === 'number' &&
        typeof e.totalInputTokens === 'number' &&
        typeof e.totalOutputTokens === 'number' &&
        typeof e.totalCostUsd === 'number'
      ) {
        modelBreakdown[model] = {
          requestCount: e.requestCount,
          totalInputTokens: e.totalInputTokens,
          totalOutputTokens: e.totalOutputTokens,
          totalCostUsd: e.totalCostUsd,
        };
      }
    }
  }

  const costByWorkflowRunId: Record<string, Record<string, number>> = {};
  if (typeof obj.costByWorkflowRunId === 'object' && obj.costByWorkflowRunId !== null) {
    for (const [runId, dayMap] of Object.entries(obj.costByWorkflowRunId)) {
      if (typeof dayMap !== 'object' || dayMap === null) continue;
      const days: Record<string, number> = {};
      for (const [dayKey, usd] of Object.entries(dayMap)) {
        if (typeof usd === 'number') days[dayKey] = usd;
      }
      costByWorkflowRunId[runId] = days;
    }
  }

  const qualityProxy: QualityProxyRawCounts = (() => {
    const q = obj.qualityProxy;
    if (typeof q !== 'object' || q === null) return ZERO_QUALITY_PROXY_COUNTS;
    const r = q as Record<string, unknown>;
    if (
      typeof r.totalSignals !== 'number' ||
      typeof r.diffApplyCleanCount !== 'number' ||
      typeof r.diffFailCount !== 'number' ||
      typeof r.testPassCount !== 'number' ||
      typeof r.testFailCount !== 'number' ||
      typeof r.backtrackCount !== 'number' ||
      typeof r.selfCorrectionCount !== 'number'
    ) {
      return ZERO_QUALITY_PROXY_COUNTS;
    }
    return {
      totalSignals: r.totalSignals,
      diffApplyCleanCount: r.diffApplyCleanCount,
      diffFailCount: r.diffFailCount,
      testPassCount: r.testPassCount,
      testFailCount: r.testFailCount,
      backtrackCount: r.backtrackCount,
      selfCorrectionCount: r.selfCorrectionCount,
    };
  })();

  const efficiencyScoreComponents: EfficiencyScoreComponents | null = (() => {
    const c = obj.efficiencyScoreComponents;
    if (typeof c !== 'object' || c === null) return null;
    const r = c as Record<string, unknown>;
    if (
      typeof r.speed !== 'number' ||
      typeof r.correctness !== 'number' ||
      typeof r.autonomy !== 'number' ||
      typeof r.firstAttemptQuality !== 'number'
    ) {
      return null;
    }
    return {
      speed: r.speed,
      correctness: r.correctness,
      autonomy: r.autonomy,
      firstAttemptQuality: r.firstAttemptQuality,
    };
  })();

  return {
    sessionId:
      typeof obj.sessionId === 'string' && obj.sessionId.length > 0 ? obj.sessionId : 'unknown',
    sessionName: typeof obj.sessionName === 'string' ? obj.sessionName : null,
    sessionNameSource:
      obj.sessionNameSource === 'user' ||
      obj.sessionNameSource === 'ai-title' ||
      obj.sessionNameSource === 'auto' ||
      obj.sessionNameSource === 'cwd'
        ? obj.sessionNameSource
        : null,
    sessionIntent: typeof obj.sessionIntent === 'string' ? obj.sessionIntent : null,
    repoName: typeof obj.repoName === 'string' ? obj.repoName : null,
    startTime: typeof obj.startTime === 'number' ? obj.startTime : 0,
    endTime: typeof obj.endTime === 'number' ? obj.endTime : 0,
    durationMs: typeof obj.durationMs === 'number' ? obj.durationMs : 0,
    toolCallCount: typeof obj.toolCallCount === 'number' ? obj.toolCallCount : 0,
    developer: typeof obj.developer === 'string' ? obj.developer : 'unknown',
    model: typeof obj.model === 'string' ? obj.model : null,
    toolBreakdown,
    filesRead: Array.isArray(obj.filesRead)
      ? obj.filesRead.filter((f): f is string => typeof f === 'string')
      : [],
    filesModified: Array.isArray(obj.filesModified)
      ? obj.filesModified.filter((f): f is string => typeof f === 'string')
      : [],
    linesAdded: typeof obj.linesAdded === 'number' ? obj.linesAdded : 0,
    linesRemoved: typeof obj.linesRemoved === 'number' ? obj.linesRemoved : 0,
    bashCommandCount: typeof obj.bashCommandCount === 'number' ? obj.bashCommandCount : 0,
    testRunCount: typeof obj.testRunCount === 'number' ? obj.testRunCount : 0,
    testPassCount: typeof obj.testPassCount === 'number' ? obj.testPassCount : 0,
    buildRunCount: typeof obj.buildRunCount === 'number' ? obj.buildRunCount : 0,
    buildPassCount: typeof obj.buildPassCount === 'number' ? obj.buildPassCount : 0,
    estimatedCostUsd: typeof obj.estimatedCostUsd === 'number' ? obj.estimatedCostUsd : null,
    subagentCostUsd: typeof obj.subagentCostUsd === 'number' ? obj.subagentCostUsd : 0,
    costByDayUsd: parseNumberRecord(obj.costByDayUsd),
    subagentCostByDayUsd: parseNumberRecord(obj.subagentCostByDayUsd),
    tokensInput: typeof obj.tokensInput === 'number' ? obj.tokensInput : 0,
    tokensOutput: typeof obj.tokensOutput === 'number' ? obj.tokensOutput : 0,
    tokensThinking: typeof obj.tokensThinking === 'number' ? obj.tokensThinking : 0,
    tokensCacheRead: typeof obj.tokensCacheRead === 'number' ? obj.tokensCacheRead : 0,
    tokensCacheCreation: typeof obj.tokensCacheCreation === 'number' ? obj.tokensCacheCreation : 0,
    cacheSavingsUsd: typeof obj.cacheSavingsUsd === 'number' ? obj.cacheSavingsUsd : 0,
    efficiencyScore: typeof obj.efficiencyScore === 'number' ? obj.efficiencyScore : null,
    efficiencyScoreSampleCount:
      typeof obj.efficiencyScoreSampleCount === 'number' ? obj.efficiencyScoreSampleCount : 0,
    efficiencyScoreComponents,
    antiPatterns,
    taskCount: typeof obj.taskCount === 'number' ? obj.taskCount : 0,
    taskSuccessRate: typeof obj.taskSuccessRate === 'number' ? obj.taskSuccessRate : null,
    toolSuccessRate: typeof obj.toolSuccessRate === 'number' ? obj.toolSuccessRate : null,
    contextCompressions: typeof obj.contextCompressions === 'number' ? obj.contextCompressions : 0,
    agentSpawns: typeof obj.agentSpawns === 'number' ? obj.agentSpawns : 0,
    userMessages: typeof obj.userMessages === 'number' ? obj.userMessages : 0,
    assistantMessages: typeof obj.assistantMessages === 'number' ? obj.assistantMessages : 0,
    userCorrections: typeof obj.userCorrections === 'number' ? obj.userCorrections : 0,
    outcome: typeof obj.outcome === 'string' ? obj.outcome : 'unknown',
    platform: typeof obj.platform === 'string' ? obj.platform : undefined,
    instructionPromptHash:
      typeof obj.instructionPromptHash === 'string' ? obj.instructionPromptHash : null,
    timeline: Array.isArray(obj.timeline)
      ? obj.timeline
          .filter(
            (e): e is Record<string, unknown> =>
              typeof e === 'object' &&
              e !== null &&
              typeof e.timestamp === 'number' &&
              typeof e.toolName === 'string',
          )
          .map((e) => ({
            timestamp: e.timestamp as number,
            toolName: e.toolName as string,
            durationMs: typeof e.durationMs === 'number' ? e.durationMs : null,
            success: typeof e.success === 'boolean' ? e.success : true,
            filePath: typeof e.filePath === 'string' ? e.filePath : undefined,
            command: typeof e.command === 'string' ? e.command : undefined,
            isTestCommand: typeof e.isTestCommand === 'boolean' ? e.isTestCommand : undefined,
            isBuildCommand: typeof e.isBuildCommand === 'boolean' ? e.isBuildCommand : undefined,
            isLintCommand: typeof e.isLintCommand === 'boolean' ? e.isLintCommand : undefined,
            errorType: typeof e.errorType === 'string' ? e.errorType : undefined,
          }))
      : undefined,
    toolSelectionMetrics,
    modelBreakdown,
    costByWorkflowRunId,
    qualityProxy,
  };
}

/**
 * Parse a raw session JSON string and extract known fields. Delegates field
 * extraction to `deserializeFullSessionSummary` to avoid duplication.
 */
function deserializeSession(raw: string): FullSessionSummary | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  return deserializeFullSessionSummary(parsed as SerializedFullSessionSummary);
}

function parseSessionFilename(filename: string): SessionFileInfo | null {
  // Expected format: YYYY-MM-DD_sessionId.json
  const match = filename.match(/^(\d{4}-\d{2}-\d{2})_(.+)\.json$/);
  if (!match) return null;
  return {
    filename,
    date: match[1],
    sessionId: match[2],
  };
}
