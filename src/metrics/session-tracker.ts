/**
 * Session Metrics Aggregation — maintains running aggregates for a coding session.
 *
 * Tracks tool call counts, durations, success rates, file access patterns,
 * and provides both a plain snapshot (for MCP tool responses) and metric
 * emission (for NR ingestion via MetricAggregator).
 */

import { basename } from 'node:path';
import type { MetricAggregator } from '../core/index.js';
import type { ToolCallRecord } from '../storage/types.js';
import {
  DEGENERATE_NAMES,
  shouldReplaceSessionName,
  type SessionNameSource,
} from '../hooks/session-resolver.js';
import { computePercentile } from './percentile.js';
import type { Resettable } from './tracker-contracts.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DurationStats {
  count: number;
  sum: number;
  min: number;
  max: number;
  p95: number;
}

export interface TimelineEntry {
  timestamp: number;
  toolName: string;
  durationMs: number | null;
  success: boolean;
}

export interface SessionMetrics {
  sessionId: string;
  sessionName: string | null;
  /** Which source produced `sessionName` (see SessionNameSource), or null when unnamed. */
  sessionNameSource: SessionNameSource | null;
  /**
   * The session's originating intent (the first user prompt), or null. This is
   * SENSITIVE content: it is populated ONLY when `recordContent` is enabled
   * (force-disabled under highSecurity upstream) and is always redacted before
   * being stored. Null whenever content recording is off. See
   * `setSessionIntent`.
   */
  sessionIntent: string | null;
  sessionStartTime: number;
  sessionDurationMs: number;
  toolCallCount: number;
  toolCallCountByTool: Record<string, number>;
  toolDurationMsByTool: Record<string, DurationStats>;
  toolSuccessRate: number | null;
  toolSuccessRateByTool: Record<string, number>;
  toolErrorCount: number;
  toolErrorsByType: Record<string, number>;
  uniqueFilesRead: number;
  uniqueFilesWritten: number;
  bashCommandsRun: number;
  bashExitCodes: Record<string, number>;
  /** Per-bash-category call counts (e.g. git, test-runner, build). Only populated for Bash tool calls. */
  bashCallsByCategory: Record<string, number>;
  searchQueries: number;
  toolCallTimeline: TimelineEntry[];
  /** True when the oldest entries were dropped to stay within MAX_TIMELINE_ENTRIES; callers should not assume they have the full history. */
  timelineTruncated: boolean;
  /** Lifetime total of timeline entries, including those dropped by the cap. */
  timelineEntryCount: number;
}

/** What a session summary takes from a tracker's calls. */
export type CallCounts = Pick<
  SessionMetrics,
  'toolCallCount' | 'toolCallCountByTool' | 'bashCommandsRun' | 'toolSuccessRate'
>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_TIMELINE_ENTRIES = 10_000;

/** A call's key among the counted ones. A tool use id is only promised unique within its session. */
function countedKey(sessionId: string, toolUseId: string): string {
  return `${sessionId}\u0000${toolUseId}`;
}

const AMENDABLE_ERROR_TYPES = new Set(['timeout', 'rejected']);

/** A record for a pre that has seen no post yet, which a late post could still amend or count. */
export function isAwaitingLatePost(record: Pick<ToolCallRecord, 'errorType'>): boolean {
  return record.errorType !== undefined && AMENDABLE_ERROR_TYPES.has(record.errorType);
}

function addCount<K>(counts: Map<K, number>, key: K, delta: number): void {
  const next = (counts.get(key) ?? 0) + delta;
  if (next > 0) counts.set(key, next);
  else counts.delete(key);
}

// Bounds memory on sessions that touch an unusually large number of distinct
// files (e.g. a repo-wide codemod or search) — head-drop the oldest-added
// file once the cap is hit, matching EventBuffer's eviction policy.
const MAX_UNIQUE_FILES = 10_000;

/** Add to a bounded Set, evicting the oldest entry (insertion order) once `MAX_UNIQUE_FILES` is hit. */
function addBoundedFile(set: Set<string>, filePath: string): void {
  if (!set.has(filePath) && set.size >= MAX_UNIQUE_FILES) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
  set.add(filePath);
}

export function computeP95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return computePercentile(sorted, 0.95) ?? 0;
}

export function computeDurationStats(durations: number[]): DurationStats {
  if (durations.length === 0) {
    return { count: 0, sum: 0, min: 0, max: 0, p95: 0 };
  }
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const d of durations) {
    sum += d;
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return {
    count: durations.length,
    sum,
    min,
    max,
    p95: computeP95(durations),
  };
}

/**
 * Pre-restart totals to fold into a freshly-started process's SessionTracker
 * for a resumed session — mirrors CostTracker.seedFromPersisted()'s pattern
 * (see that file's doc comment for why this exists: SessionStore.mergeSummaries()
 * merges scalar counters via Math.max(), which under-reports when pre- and
 * post-restart activity are disjoint rather than overlapping).
 *
 * Only toolCallCount and bashCommandCount are seeded here, less the saved calls
 * (by toolUseId) the tracker already counted. SessionTracker's
 * other counters that end up on FullSessionSummary (linesAdded, linesRemoved,
 * testRunCount/testPassCount, buildRunCount/buildPassCount) are sourced from
 * TaskDetector's seededAggregate instead (see buildSessionSummary() in
 * session-store.ts) and are already seeded there.
 */
export interface SessionTrackerSeed {
  /** The session the saved file belongs to. */
  readonly sessionId: string;
  readonly toolCallCount: number;
  readonly bashCommandCount: number;
  /** The tool name of each saved call that has a toolUseId, keyed by that id. */
  readonly toolNameByUseId: ReadonlyMap<string, string>;
}

/**
 * Calls this tracker drained whose toolUseId a seed already counted. Its
 * metrics leave them out. Its own share counts them, because they are in its
 * timeline and the fold takes each call two writers hold out once.
 */
class SeededRepeats {
  count = 0;
  bashCount = 0;
  successCount = 0;
  readonly byTool = new Map<string, number>();

  add(record: ToolCallRecord, delta: 1 | -1): void {
    this.count += delta;
    if (record.toolName === 'Bash') this.bashCount += delta;
    addCount(this.byTool, record.toolName, delta);
    if (record.success) this.successCount += delta;
  }
}

// ---------------------------------------------------------------------------
// SessionTracker
// ---------------------------------------------------------------------------

export class SessionTracker implements Resettable {
  private sessionId: string;
  private sessionName: string | null = null;
  private sessionNameSource: SessionNameSource | null = null;
  private sessionIntent: string | null = null;
  /**
   * True once an authoritative name (resolved at startup from the job state
   * file or transcript title) has been set via `setAuthoritativeName`. While
   * true, the streaming cwd-basename derivation in `recordToolCall` is
   * suppressed — the authoritative name always wins.
   */
  private authoritativeName = false;
  private sessionStartTime: number;

  private toolCallCount = 0;
  private toolErrorCount = 0;
  private successCount = 0;
  private bashCommandsRun = 0;
  private searchQueries = 0;

  private readonly toolCallCountByTool = new Map<string, number>();
  private readonly toolDurationsByTool = new Map<string, number[]>();
  private readonly toolSuccessByTool = new Map<string, { success: number; total: number }>();
  private readonly toolErrorsByType = new Map<string, number>();
  private readonly filesRead = new Set<string>();
  private readonly filesWritten = new Set<string>();
  private readonly bashExitCodes = new Map<number, number>();
  private readonly bashCallsByCategory = new Map<string, number>();
  private timeline: TimelineEntry[] = [];
  private timelineEntryCount = 0;
  private readonly amendable = new Map<
    string,
    { record: ToolCallRecord; timelineSequence: number }
  >();
  private readonly maxAmendable: number;
  /** The most recent calls counted, seeded ones included, so a call another process also drained counts once. */
  private readonly toolNameByCountedKey = new Map<string, string>();
  /** Keys a seed added to the counted ones that this tracker has not drained. */
  private readonly seededKeys = new Set<string>();
  private seededToolCallCount = 0;
  private seededBashCommandCount = 0;
  private seededRepeats = new SeededRepeats();
  private readonly amendableRepeats = new Map<string, ToolCallRecord>();
  /** What getMetrics() shows until this engine adopts a session, which some engines never do. */
  private drainedWhilePending: SessionTracker | null;
  /** Set by a pending or adopted id, whose engine also drains other sessions' calls. */
  private countsOnlyOwnSession: boolean;

  constructor(sessionId: string, maxAmendable = 0) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      // The MCP no longer fabricates session_ids. Callers must pass the
      // resolved Claude Code session_id (or a real UUID for tests).
      throw new Error('SessionTracker requires a non-empty sessionId');
    }
    this.sessionId = sessionId;
    this.sessionStartTime = Date.now();
    this.maxAmendable = maxAmendable;
    this.countsOnlyOwnSession = sessionId.startsWith('pending-');
    this.drainedWhilePending = this.countsOnlyOwnSession
      ? new SessionTracker('drained-while-pending', maxAmendable)
      : null;
  }

  recordToolCall(record: ToolCallRecord): void {
    this.drainedWhilePending?.recordToolCall(record);
    // A pending engine drains every session, and after adoption its scoped store still
    // takes its own claims of other buffers; adoptSessionId() replays its own records.
    if (record.sessionId && this.countsOnlyOwnSession && record.sessionId !== this.sessionId) {
      return;
    }
    if (record.toolUseId) {
      const key = countedKey(record.sessionId ?? this.sessionId, record.toolUseId);
      if (this.seededKeys.delete(key)) {
        this.seededRepeats.add(record, 1);
        if (isAwaitingLatePost(record))
          this.keepAmendable(this.amendableRepeats, record.id, record);
        return;
      }
      if (this.toolNameByCountedKey.has(key)) return;
      this.rememberCounted(key, record.toolName);
    }
    this.toolCallCount++;

    // FALLBACK naming only: an authoritative name (job-state title or
    // transcript ai-title, resolved once at startup) always wins, so skip the
    // cwd derivation entirely once one is set. Otherwise derive from cwd,
    // preferring a later, more meaningful name if the current one is a
    // degenerate system directory (tmp, var, usr, etc.).
    if (!this.authoritativeName && typeof record.cwd === 'string' && record.cwd.length > 0) {
      const name = basename(record.cwd);
      if (name.length > 0 && name !== '.' && name !== '..') {
        if (this.sessionName === null || DEGENERATE_NAMES.has(this.sessionName.toLowerCase())) {
          this.sessionName = name;
          this.sessionNameSource = 'cwd';
        }
      }
    }

    // Per-tool count
    const tool = record.toolName;
    this.toolCallCountByTool.set(tool, (this.toolCallCountByTool.get(tool) ?? 0) + 1);

    // Duration tracking
    if (record.durationMs !== null && record.durationMs !== undefined) {
      const durations = this.toolDurationsByTool.get(tool);
      if (durations) {
        // Bounds memory per tool — 500 samples is already far more than
        // needed for a stable p95 within one session.
        if (durations.length < 500) durations.push(record.durationMs);
      } else {
        this.toolDurationsByTool.set(tool, [record.durationMs]);
      }
    }

    const successEntry = this.toolSuccessByTool.get(tool) ?? { success: 0, total: 0 };
    successEntry.total++;
    this.toolSuccessByTool.set(tool, successEntry);
    this.applyOutcome(record, 1);

    // File tracking (uses tool-specific fields from parsers)
    const filePath = record.filePath as string | undefined;
    if (filePath) {
      if (tool === 'Read') {
        addBoundedFile(this.filesRead, filePath);
      } else if (tool === 'Write' || tool === 'Edit') {
        addBoundedFile(this.filesWritten, filePath);
      }
    }

    // Bash tracking
    if (tool === 'Bash') {
      this.bashCommandsRun++;
      const category = record.bashCategory as string | undefined;
      if (typeof category === 'string' && category.length > 0) {
        this.bashCallsByCategory.set(category, (this.bashCallsByCategory.get(category) ?? 0) + 1);
      }
    }

    // Search tracking
    if (tool === 'Grep' || tool === 'Glob') {
      this.searchQueries++;
    }

    // Timeline (capped, keeps the most recent entries); always increment the lifetime counter.
    this.timelineEntryCount++;
    const timelineSequence = this.timelineEntryCount - 1;
    if (this.timeline.length >= MAX_TIMELINE_ENTRIES) this.timeline.shift();
    this.timeline.push({
      timestamp: record.timestamp,
      toolName: tool,
      durationMs: record.durationMs,
      success: record.success,
    });
    if (isAwaitingLatePost(record)) {
      this.keepAmendable(this.amendable, record.id, { record, timelineSequence });
    }
  }

  private keepAmendable<T>(records: Map<string, T>, id: string, value: T): void {
    records.set(id, value);
    if (records.size > this.maxAmendable) records.delete(records.keys().next().value!);
  }

  private applyOutcome(record: ToolCallRecord, delta: 1 | -1): void {
    const successEntry = this.toolSuccessByTool.get(record.toolName)!;
    if (record.success) {
      successEntry.success += delta;
      this.successCount += delta;
    } else {
      this.toolErrorCount += delta;
      if (record.errorType) addCount(this.toolErrorsByType, record.errorType, delta);
    }
    const exitCode = record.exitCode as number | undefined;
    if (record.toolName === 'Bash' && exitCode != null)
      addCount(this.bashExitCodes, exitCode, delta);
  }

  amendToolCall(record: ToolCallRecord): void {
    this.drainedWhilePending?.amendToolCall(record);
    const repeat = this.amendableRepeats.get(record.id);
    if (repeat) {
      this.amendableRepeats.delete(record.id);
      this.seededRepeats.add(repeat, -1);
      this.seededRepeats.add(record, 1);
      return;
    }
    const amended = this.amendable.get(record.id);
    if (!amended) return;
    this.amendable.delete(record.id);
    this.applyOutcome(amended.record, -1);
    this.applyOutcome(record, 1);
    if (record.durationMs !== null) {
      const durations = this.toolDurationsByTool.get(record.toolName) ?? [];
      if (durations.length < 500) durations.push(record.durationMs);
      this.toolDurationsByTool.set(record.toolName, durations);
    }
    const timelineIndex =
      amended.timelineSequence - (this.timelineEntryCount - this.timeline.length);
    const entry = this.timeline[timelineIndex];
    if (entry) {
      this.timeline[timelineIndex] = {
        ...entry,
        durationMs: record.durationMs,
        success: record.success,
      };
    }
  }

  getMetrics(): SessionMetrics {
    if (this.drainedWhilePending) {
      return { ...this.drainedWhilePending.getMetrics(), sessionId: this.sessionId };
    }
    // Convert Maps to plain objects
    const toolCallCountByTool: Record<string, number> = {};
    for (const [tool, count] of this.toolCallCountByTool) {
      toolCallCountByTool[tool] = count;
    }

    const toolDurationMsByTool: Record<string, DurationStats> = {};
    for (const [tool, durations] of this.toolDurationsByTool) {
      toolDurationMsByTool[tool] = computeDurationStats(durations);
    }

    const toolSuccessRateByTool: Record<string, number> = {};
    for (const [tool, entry] of this.toolSuccessByTool) {
      toolSuccessRateByTool[tool] = entry.total > 0 ? entry.success / entry.total : 1;
    }

    const toolErrorsByType: Record<string, number> = {};
    for (const [type, count] of this.toolErrorsByType) {
      toolErrorsByType[type] = count;
    }

    const bashExitCodes: Record<string, number> = {};
    for (const [code, count] of this.bashExitCodes) {
      bashExitCodes[String(code)] = count;
    }

    const bashCallsByCategory: Record<string, number> = {};
    for (const [category, count] of this.bashCallsByCategory) {
      bashCallsByCategory[category] = count;
    }

    const toolCallCount = this.toolCallCount + this.seededToolCallCount;
    const overallSuccessRate = toolCallCount > 0 ? this.successCount / toolCallCount : null;

    return {
      sessionId: this.sessionId,
      sessionName: this.sessionName,
      sessionNameSource: this.sessionNameSource,
      sessionIntent: this.sessionIntent,
      sessionStartTime: this.sessionStartTime,
      sessionDurationMs: Date.now() - this.sessionStartTime,
      toolCallCount,
      toolCallCountByTool,
      toolDurationMsByTool,
      toolSuccessRate: overallSuccessRate,
      toolSuccessRateByTool,
      toolErrorCount: this.toolErrorCount,
      toolErrorsByType,
      uniqueFilesRead: this.filesRead.size,
      uniqueFilesWritten: this.filesWritten.size,
      bashCommandsRun: this.bashCommandsRun + this.seededBashCommandCount,
      bashExitCodes,
      bashCallsByCategory,
      searchQueries: this.searchQueries,
      toolCallTimeline: [...this.timeline],
      timelineTruncated: this.timelineEntryCount > this.timeline.length,
      timelineEntryCount: this.timelineEntryCount,
    };
  }

  /** Every call this tracker drained itself, once each, including ones a seed also counted. */
  getOwnCallCounts(): CallCounts {
    const repeats = this.seededRepeats;
    const toolCallCountByTool = Object.fromEntries(this.toolCallCountByTool);
    for (const [tool, n] of repeats.byTool) {
      toolCallCountByTool[tool] = (toolCallCountByTool[tool] ?? 0) + n;
    }
    const toolCallCount = this.toolCallCount + repeats.count;
    return {
      toolCallCount,
      toolCallCountByTool,
      bashCommandsRun: this.bashCommandsRun + repeats.bashCount,
      toolSuccessRate:
        toolCallCount > 0 ? (this.successCount + repeats.successCount) / toolCallCount : null,
    };
  }

  emitMetrics(aggregator: MetricAggregator): void {
    // Per-tool metrics
    for (const [tool, count] of this.toolCallCountByTool) {
      aggregator.record('ai.tool.call_count', count, { tool });
    }

    for (const [tool, durations] of this.toolDurationsByTool) {
      for (const d of durations) {
        aggregator.record('ai.tool.duration_ms', d, { tool });
      }
    }

    for (const [tool, entry] of this.toolSuccessByTool) {
      const rate = entry.total > 0 ? entry.success / entry.total : 1;
      aggregator.record('ai.tool.success_rate', rate, { tool });
    }

    // Per-bash-category breakdown — emitted separately from generic tool
    // counts so dashboards can split git vs test-runner vs build vs ...
    for (const [category, count] of this.bashCallsByCategory) {
      aggregator.record('ai.bash.call_count', count, { category });
    }

    // Session-level metrics
    aggregator.record('ai.session.duration_ms', Date.now() - this.sessionStartTime);
    aggregator.record('ai.session.unique_files_read', this.filesRead.size);
    aggregator.record('ai.session.unique_files_written', this.filesWritten.size);
  }

  /**
   * Set the authoritative session name (from the job-state title or the
   * transcript ai-title, per `resolveSessionName`'s precedence). Overrides any
   * name the streaming cwd fallback may have set, and suppresses that fallback
   * for the rest of the session. Ignores empty names. The name is a display
   * LABEL; callers redact it at each sink.
   *
   * Called both once at startup AND repeatedly on the persist/shutdown path
   * (Phase 2 freshness), so a refined `ai-title` — or a name a human later
   * assigns — replaces the first-prompt guess. `shouldReplaceSessionName`
   * enforces the no-downgrade invariant: a strictly-less-trusted source (e.g.
   * a `cwd` re-resolve arriving after a `user` name was set) is refused rather
   * than allowed to demote the better name.
   *
   * Returns true only when the stored name or source actually changed, so the
   * caller can log a genuine (re)naming without spamming on every no-op
   * re-resolve.
   */
  setAuthoritativeName(name: string, source: SessionNameSource): boolean {
    if (typeof name !== 'string' || name.length === 0) return false;
    if (!shouldReplaceSessionName(this.sessionNameSource, source)) return false;
    const changed = this.sessionName !== name || this.sessionNameSource !== source;
    this.sessionName = name;
    this.sessionNameSource = source;
    this.authoritativeName = true;
    return changed;
  }

  /**
   * Set the session's originating intent (the first user prompt).
   *
   * The caller owns the content gate and redaction: this must only be called
   * with an already-redacted string, and only when `recordContent` is enabled
   * (force-disabled under highSecurity upstream — never bypass). A null/empty
   * value clears it. Because the intent is stable across a session (it is the
   * first prompt), re-calling on the persist/shutdown path is idempotent.
   */
  setSessionIntent(intent: string | null): void {
    this.sessionIntent = intent && intent.length > 0 ? intent : null;
  }

  /**
   * Adopts the real session id and counts `records`, the calls of that session
   * drained before this tracker knew its id. Replacing a wrong guess first drops
   * every count of the guessed session.
   */
  adoptSessionId(
    sessionId: string,
    records: readonly ToolCallRecord[] = [],
    replacingGuess = false,
  ): void {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('SessionTracker.adoptSessionId() requires a non-empty sessionId');
    }
    if (replacingGuess) this.clearCounts();
    this.drainedWhilePending = null;
    this.countsOnlyOwnSession = true;
    this.sessionId = sessionId;
    for (const record of records) this.recordToolCall(record);
  }

  /**
   * Fold a resumed session's saved toolCallCount/bashCommandCount into this
   * process's live counters, leaving out saved calls it already counted, such
   * as ones adoptSessionId() replayed. See SessionTrackerSeed's doc comment for
   * why this exists.
   */
  seedFromPersisted(seed: SessionTrackerSeed): void {
    let calls = seed.toolCallCount;
    let bashCalls = seed.bashCommandCount;
    const unseen: [string, string][] = [];
    for (const [toolUseId, toolName] of seed.toolNameByUseId) {
      const key = countedKey(seed.sessionId, toolUseId);
      if (!this.toolNameByCountedKey.has(key)) {
        unseen.push([key, toolName]);
        continue;
      }
      calls--;
      if (toolName === 'Bash') bashCalls--;
    }
    // Remembering them only now keeps a full map from evicting the live ids the loop has yet to reach.
    for (const [key, toolName] of unseen) {
      this.rememberCounted(key, toolName);
      this.seededKeys.add(key);
    }
    // A max-merged file can hold more ids than its count, so the overlap can exceed it.
    this.seededToolCallCount += Math.max(0, calls);
    this.seededBashCommandCount += Math.max(0, bashCalls);
  }

  private rememberCounted(key: string, toolName: string): void {
    if (this.toolNameByCountedKey.size >= MAX_TIMELINE_ENTRIES) {
      const oldest = this.toolNameByCountedKey.keys().next().value!;
      this.toolNameByCountedKey.delete(oldest);
      this.seededKeys.delete(oldest);
    }
    this.toolNameByCountedKey.set(key, toolName);
  }

  reset(sessionId: string): void {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('SessionTracker.reset() requires a non-empty sessionId');
    }
    this.drainedWhilePending = null;
    this.countsOnlyOwnSession = sessionId.startsWith('pending-');
    this.sessionId = sessionId;
    this.sessionName = null;
    this.sessionNameSource = null;
    this.sessionIntent = null;
    this.authoritativeName = false;
    this.sessionStartTime = Date.now();
    this.clearCounts();
  }

  private clearCounts(): void {
    this.toolCallCount = 0;
    this.toolErrorCount = 0;
    this.successCount = 0;
    this.bashCommandsRun = 0;
    this.searchQueries = 0;
    this.toolCallCountByTool.clear();
    this.toolDurationsByTool.clear();
    this.toolSuccessByTool.clear();
    this.toolErrorsByType.clear();
    this.filesRead.clear();
    this.filesWritten.clear();
    this.bashExitCodes.clear();
    this.bashCallsByCategory.clear();
    this.timeline = [];
    this.timelineEntryCount = 0;
    this.amendable.clear();
    this.toolNameByCountedKey.clear();
    this.seededKeys.clear();
    this.seededToolCallCount = 0;
    this.seededBashCommandCount = 0;
    this.seededRepeats = new SeededRepeats();
    this.amendableRepeats.clear();
  }
}
