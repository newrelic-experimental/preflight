import { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { localDateKey, localStartOfDay, todayPortionOfSessionCost } from '../../lib/date.js';
import { redactSensitive, normalizeDeveloperName } from '../../config.js';
import { handleSendDigest } from '../../tools/cross-session-tools.js';
import type { WeeklySummaryGenerator } from '../../storage/weekly-summary.js';
import type { McpServerConfig } from '../../config.js';
import {
  attributeSessionCosts,
  type SessionLikeForCostOutcome,
} from '../../metrics/cost-per-outcome.js';
import { getIsoWeekId } from '../../storage/weekly-summary.js';
import { analyzeReplayTimeline } from './replay-analyzer.js';
import type { ReplayTimelineEntry, ToolCallRecord } from '../../storage/types.js';
import { isSyntheticSessionId } from '../../hooks/session-resolver.js';

// ---------------------------------------------------------------------------
// Aggregate quality-proxy metrics from today's persisted sessions so the
// panel isn't empty on page refresh (when the live tracker has no signals).
// ---------------------------------------------------------------------------

interface HistoricalSession {
  readonly testRunCount?: number;
  readonly testPassCount?: number;
  readonly timeline?: readonly ReplayTimelineEntry[];
}

function aggregateQualityFromHistory(sessions: unknown[]): {
  totalSignals: number;
  diffApplyRate: number | null;
  testPassRate: number | null;
  backtrackCount: number;
  selfCorrectionCount: number;
  qualityByTurnBucket: never[];
  degradationDetected: boolean;
  events: never[];
} {
  let diffApplied = 0;
  let diffFailed = 0;
  let testPass = 0;
  let testFail = 0;
  let backtrackCount = 0;
  let selfCorrectionCount = 0;

  for (const raw of sessions) {
    const session = raw as HistoricalSession;
    const testRuns = session.testRunCount ?? 0;
    const testPasses = session.testPassCount ?? 0;

    // Derive diff success/failure from timeline when available
    if (session.timeline && session.timeline.length > 0) {
      let lastEditFile: string | null = null;
      let lastEditIdx = -1;
      for (let i = 0; i < session.timeline.length; i++) {
        const entry = session.timeline[i]!;
        if (entry.toolName === 'Edit' || entry.toolName === 'Write') {
          if (entry.success) diffApplied++;
          else diffFailed++;

          // Detect self-correction: re-edit same file within 3 turns after a test failure
          if (lastEditFile && entry.filePath === lastEditFile && i - lastEditIdx <= 3) {
            const recentFail = session.timeline
              .slice(lastEditIdx + 1, i)
              .some((e) => e.isTestCommand && !e.success);
            if (recentFail) selfCorrectionCount++;
          }

          lastEditFile = entry.filePath ?? null;
          lastEditIdx = i;
        }
        // Detect backtrack: Read of a recently edited file
        if (
          entry.toolName === 'Read' &&
          lastEditFile &&
          entry.filePath === lastEditFile &&
          i - lastEditIdx <= 2
        ) {
          backtrackCount++;
        }
        if (entry.isTestCommand) {
          if (entry.success) testPass++;
          else testFail++;
        }
      }
    } else {
      // No timeline — use summary counts for test pass/fail only.
      // Edit/Write counts from toolBreakdown have no success/failure split,
      // so including them would always produce 100% diffApplyRate; skip them.
      testPass += testPasses;
      testFail += Math.max(0, testRuns - testPasses);
    }
  }

  const totalDiffs = diffApplied + diffFailed;
  const totalTests = testPass + testFail;
  const totalSignals = totalDiffs + totalTests + backtrackCount + selfCorrectionCount;

  return {
    totalSignals,
    diffApplyRate: totalDiffs > 0 ? Math.round((diffApplied / totalDiffs) * 1000) / 1000 : null,
    testPassRate: totalTests > 0 ? Math.round((testPass / totalTests) * 1000) / 1000 : null,
    backtrackCount,
    selfCorrectionCount,
    qualityByTurnBucket: [],
    degradationDetected: false,
    events: [],
  };
}

interface RawAuditRecord {
  readonly timestamp: number;
  readonly sessionId: string | null;
  readonly action: string;
  readonly tool: string;
  readonly detail: string;
  readonly developer: string;
  readonly filePath?: string;
  readonly command?: string;
  readonly securityAlert?: { readonly severity: string; readonly alertType: string } | undefined;
}

// Shape consumed by the SPA Audit view. Distinct from RawAuditRecord so that
// (1) field names match the React component (ts/target/classification, not
// timestamp/detail/action), (2) we don't leak filePath/command/developer to
// the browser by accident, and (3) classification surfaces the security
// alertType chip (sensitive_file/destructive_command/external_network)
// directly so the SPA's filter chips work without a second mapping.
interface AuditEntryDto {
  readonly ts: number;
  readonly sessionId: string | null;
  readonly tool: string;
  readonly target: string;
  readonly classification: string;
}

function toAuditEntry(entry: unknown): AuditEntryDto {
  const r = (entry ?? {}) as RawAuditRecord;
  const target = typeof r.detail === 'string' ? redactSensitive(r.detail) : '';
  // Prefer the explicit security classification when present; fall back to
  // 'other' for routine tool calls so the "All" filter still shows them
  // while specific filters (sensitive_file/destructive_command/external_network)
  // surface only flagged entries.
  const classification = r.securityAlert?.alertType ?? 'other';
  return {
    ts: r.timestamp,
    sessionId: r.sessionId ?? null,
    tool: r.tool,
    target,
    classification,
  };
}

interface LiveSessionMetrics {
  readonly sessionId: string;
  readonly sessionName: string | null;
  readonly sessionStartTime: number;
  readonly sessionDurationMs: number;
  readonly toolCallCount: number;
  readonly toolCallCountByTool: Record<string, number>;
  readonly uniqueFilesRead: number;
  readonly uniqueFilesWritten: number;
  readonly toolCallTimeline: ReadonlyArray<{
    readonly timestamp: number;
    readonly toolName: string;
    readonly durationMs: number | null;
    readonly success: boolean;
  }>;
}

export interface ApiHandlerDeps {
  readonly sessionTracker?: { getMetrics: () => LiveSessionMetrics };
  readonly sessionStore?: {
    loadTodaySessions: () => unknown[];
    // Optional: introduced for the cross-midnight cost fix (sessions that
    // started yesterday and ended today need their today-portion summed).
    // Older fakes/mocks that don't implement it fall through to the legacy
    // path which sees only same-day-started sessions.
    loadSessionsOverlappingToday?: () => unknown[];
    listSessions: (opts?: { since?: Date; developer?: string }) => unknown[];
    loadSession: (id: string) => unknown | null;
    loadAllSessions?: (opts?: {
      since?: Date;
      developer?: string;
    }) => readonly SessionLikeForCostOutcome[];
  };
  readonly costTracker?: {
    getMetrics: () => { sessionTotalCostUsd?: number | null; model?: string | null };
    // Optional: per-day cost attribution. Fixes the cross-midnight bug where
    // a session that started yesterday counted its full cost as today's. When
    // present, the aggregate route uses it instead of session-total.
    getCostForDay?: (dayKey: string) => number;
  };
  readonly costForecast?: () => unknown;
  readonly antiPatternDetector?: { getCurrentPatterns: () => unknown };
  readonly auditTrailManager?: { getAuditLog: () => readonly unknown[] };
  readonly weeklySummaryGenerator?: {
    loadRecentWeeks: (count: number) => unknown[];
    generate: (weekId: string) => unknown;
  };
  readonly budgetTracker?: { getStatus: () => unknown };
  readonly latencyTracker?: { getMetrics: () => unknown };
  readonly personalCoach?: { generate: () => unknown };
  readonly alertLog?: { readRecent: (limit: number) => Promise<readonly unknown[]> };
  readonly taskDetector?: {
    getCompletedTasks: () => readonly { toolCalls: readonly ToolCallRecord[] }[];
    getCurrentTask: () => { toolCalls: readonly ToolCallRecord[] } | null;
  };
  // Minimal interface — we only need the rolling session-average score for the
  // Today KPI; richer per-task breakdowns ship via the existing MCP tool path.
  readonly efficiencyScorer?: { getSessionAverage: () => { score: number } | null };
  readonly gitEfficiencyTracker?: { getMetrics: () => unknown };
  readonly qualityProxyTracker?: { getMetrics: () => unknown };
  readonly toolSelectionScorer?: { scoreSession: (calls: readonly ToolCallRecord[]) => unknown };
  readonly modelUsageTracker?: { getMetrics: () => unknown };
  readonly toolCallBuffer?: { getRecords: () => readonly ToolCallRecord[] };
  readonly liveSessionRegistry?: {
    getLiveSessions: () => string[];
    getSessionName: (sessionId: string) => string | null;
    // Optional: introduced for /api/sessions/live so the Today selector can
    // default to the most-recently-active session. Older fakes / mocks that
    // don't implement it still work — `?.` falls back to undefined.
    getLastActivity?: (sessionId: string) => number | null;
  };
  readonly concurrencyTracker?: {
    getConcurrentCount: () => number;
    getPeakConcurrent: () => number;
    getConcurrencyTimeSeries: () => readonly { timestamp: number; count: number }[];
  };
  readonly contextTracker?: { getMetrics: (sessionId?: string) => unknown };
  readonly config?: McpServerConfig;
  readonly configFilePath?: string;
  // The dashboard owner reads every per-session buffer file in read-only
  // mode for the cross-session aggregate endpoint.
  // `peekAllBuffers()` does NOT drain — only the owning MCP's own
  // `drainBuffer()` consumes events for ingestion.
  readonly localStore?: { peekAllBuffers: () => readonly { readonly [key: string]: unknown }[] };
}

type RouteFn = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

function jsonOk(res: ServerResponse, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
  });
  res.end(payload);
}

function unavailable(res: ServerResponse, what: string): void {
  const payload = JSON.stringify({ error: 'unavailable', what });
  res.writeHead(503, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
  });
  res.end(payload);
}

const MAX_BODY_BYTES = 64 * 1024; // 64 KB — generous for any settings payload

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.byteLength;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

const ACTIVITY_WINDOW_MS = 180_000; // 3 minutes — matches LiveSessionRegistry staleness

function mergeActivityWindows(
  timeline: readonly { timestamp: number }[],
): Array<{ start: number; end: number }> {
  const sorted = [...timeline].sort((a, b) => a.timestamp - b.timestamp);
  const windows: Array<{ start: number; end: number }> = [];
  for (const entry of sorted) {
    const start = entry.timestamp;
    const end = start + ACTIVITY_WINDOW_MS;
    if (windows.length > 0 && start <= windows[windows.length - 1]!.end) {
      windows[windows.length - 1]!.end = Math.max(windows[windows.length - 1]!.end, end);
    } else {
      windows.push({ start, end });
    }
  }
  return windows;
}

// 96 × 15-minute buckets covering today (00:00 → 24:00 local). Each bucket
// holds the peak concurrent session count observed within its window — see
// computeTodayConcurrencyBuckets() below.
const CONCURRENCY_BUCKET_SIZE_MS = 15 * 60 * 1000;
const CONCURRENCY_BUCKET_COUNT = 96;

interface ConcurrencyBucket {
  readonly timestamp: number;
  readonly count: number;
}

interface SessionInterval {
  readonly startTime: number;
  readonly endTime: number;
}

// Build [startTime, endTime] intervals for every session that has any activity
// today. Persisted sessions contribute their stored startTime/endTime.
// Currently-live sessions (in the registry but not yet persisted) derive
// startTime from the in-memory tool-call buffer (oldest observed timestamp)
// and use `now` as endTime — matching the convention used by /api/sessions/live.
// Sessions that appear in both the persisted store and the live registry are
// deduped by sessionId; the live (extended-to-now) interval wins.
function collectTodaySessionIntervals(
  todaySessions: readonly unknown[],
  liveSessionIds: readonly string[],
  bufferRecords: readonly ToolCallRecord[],
  now: number,
): SessionInterval[] {
  const byId = new Map<string, SessionInterval>();

  for (const raw of todaySessions) {
    const s = raw as { sessionId?: string; startTime?: number; endTime?: number | null };
    if (typeof s.startTime !== 'number') continue;
    const end = typeof s.endTime === 'number' ? s.endTime : now;
    if (end <= s.startTime) continue;
    if (typeof s.sessionId === 'string' && s.sessionId.length > 0) {
      byId.set(s.sessionId, { startTime: s.startTime, endTime: end });
    } else {
      // No id — use a synthetic key so it still contributes.
      byId.set(`__anon_${byId.size}`, { startTime: s.startTime, endTime: end });
    }
  }

  if (liveSessionIds.length > 0) {
    const firstTsBySession = new Map<string, number>();
    for (const r of bufferRecords) {
      const sid = (r as { sessionId?: string | null }).sessionId;
      if (!sid) continue;
      const ts = (r as { timestamp?: number }).timestamp ?? 0;
      if (!ts) continue;
      const prev = firstTsBySession.get(sid);
      if (prev === undefined || ts < prev) firstTsBySession.set(sid, ts);
    }
    for (const sid of liveSessionIds) {
      const existing = byId.get(sid);
      const bufferStart = firstTsBySession.get(sid);
      // Prefer the EARLIER startTime: a persisted entry's startTime is
      // authoritative (e.g. 09:00) and would be clobbered if we keyed solely
      // off the buffer's earliest record (which may be much later if the
      // buffer was drained between flushes). Extend endTime to `now` —
      // that's the original intent of this loop (a live session is, by
      // definition, ongoing).
      const candidates: number[] = [];
      if (existing !== undefined) candidates.push(existing.startTime);
      if (bufferStart !== undefined) candidates.push(bufferStart);
      if (candidates.length === 0) continue;
      const startTime = Math.min(...candidates);
      if (now <= startTime) continue;
      byId.set(sid, { startTime, endTime: now });
    }
  }

  return Array.from(byId.values());
}

function computeTodayConcurrencyBuckets(
  intervals: readonly SessionInterval[],
  startTimestamp: number,
): ConcurrencyBucket[] {
  // Single pass O(N log N) — build delta events from every interval,
  // clamped to today's window, then sort once and sweep across the 96
  // buckets in lockstep with the event cursor. Buckets containing no
  // events still need a count: the value carried over from the previous
  // bucket's tail (a session that spans many buckets without a delta in
  // between must propagate as count=1+ in those buckets).
  const dayEnd = startTimestamp + CONCURRENCY_BUCKET_COUNT * CONCURRENCY_BUCKET_SIZE_MS;
  const events: Array<{ ts: number; delta: number }> = [];
  for (const interval of intervals) {
    const start = Math.max(interval.startTime, startTimestamp);
    const end = Math.min(interval.endTime, dayEnd);
    if (start < end) {
      events.push({ ts: start, delta: 1 }, { ts: end, delta: -1 });
    }
  }
  // Sort by ts ascending; at ties, +1 deltas precede -1 (open-before-close)
  // so that exact-touch session boundaries (one ends as another starts)
  // count as overlap for one instant. Matches computeTodayPeakConcurrency's
  // sort and the headline `peak` semantics — without this, a bucket peak
  // can fall 1 below the day peak at boundary conditions.
  events.sort((a, b) => a.ts - b.ts || b.delta - a.delta);

  const buckets: ConcurrencyBucket[] = new Array(CONCURRENCY_BUCKET_COUNT);
  let current = 0;
  let cursor = 0;
  for (let b = 0; b < CONCURRENCY_BUCKET_COUNT; b++) {
    const bucketStart = startTimestamp + b * CONCURRENCY_BUCKET_SIZE_MS;
    const bucketEnd = bucketStart + CONCURRENCY_BUCKET_SIZE_MS;
    // Flush any boundary events whose ts falls AT OR BEFORE bucketStart.
    // Without this, a session ending at exactly t=bucketStart (e.g. a
    // 15-min-aligned endTime) would still be carried as current=1 into
    // this bucket before the -1 fires, inflating the bucket's initial peak
    // by 1. Flushing first means peak is initialised from the correct
    // post-close concurrency level.
    while (cursor < events.length && events[cursor]!.ts <= bucketStart) {
      current += events[cursor]!.delta;
      cursor++;
    }
    // Peak starts at the carried-over (post-flush) level. Sessions spanning
    // many buckets with no mid-bucket events propagate as count=N+ here.
    let peak = current;
    while (cursor < events.length && events[cursor]!.ts < bucketEnd) {
      current += events[cursor]!.delta;
      if (current > peak) peak = current;
      cursor++;
    }
    buckets[b] = { timestamp: bucketStart, count: peak };
  }
  return buckets;
}

function computeTodayPeakConcurrency(sessions: readonly unknown[]): number {
  const events: Array<{ ts: number; delta: number }> = [];
  for (const s of sessions) {
    const session = s as { timeline?: readonly { timestamp: number }[] };
    if (!session.timeline || session.timeline.length === 0) continue;

    const windows = mergeActivityWindows(session.timeline);

    for (const w of windows) {
      events.push({ ts: w.start, delta: 1 }, { ts: w.end, delta: -1 });
    }
  }
  if (events.length === 0) return 0;
  events.sort((a, b) => a.ts - b.ts || b.delta - a.delta);
  let current = 0;
  let peak = 0;
  for (const e of events) {
    current += e.delta;
    if (current > peak) peak = current;
  }
  return peak;
}

function computeDailyPeakConcurrency(
  sessions: readonly unknown[],
  days: number,
): Array<{ date: string; peak: number }> {
  const now = new Date();
  const result: Array<{ date: string; peak: number }> = [];

  for (let d = days - 1; d >= 0; d--) {
    const dayStart = new Date(now);
    dayStart.setUTCDate(dayStart.getUTCDate() - d);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

    const dayStartMs = dayStart.getTime();
    const dayEndMs = dayEnd.getTime();
    const dateKey = dayStart.toISOString().slice(0, 10);

    // Find sessions that overlap with this day and have timeline data
    const events: Array<{ ts: number; delta: number }> = [];
    for (const s of sessions) {
      const session = s as { timeline?: readonly { timestamp: number }[] };
      if (!session.timeline || session.timeline.length === 0) continue;

      // Only include tool calls within this day
      const dayEntries = session.timeline.filter(
        (e) => e.timestamp >= dayStartMs && e.timestamp < dayEndMs,
      );
      if (dayEntries.length === 0) continue;

      const windows = mergeActivityWindows(dayEntries);

      for (const w of windows) {
        events.push({ ts: w.start, delta: 1 }, { ts: w.end, delta: -1 });
      }
    }

    if (events.length === 0) {
      result.push({ date: dateKey, peak: 0 });
      continue;
    }

    events.sort((a, b) => a.ts - b.ts || b.delta - a.delta);
    let concurrent = 0;
    let peak = 0;
    for (const e of events) {
      concurrent += e.delta;
      if (concurrent > peak) peak = concurrent;
    }
    result.push({ date: dateKey, peak });
  }

  return result;
}

function toolCallToTimelineEntry(tc: ToolCallRecord): ReplayTimelineEntry {
  return {
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
  };
}

function buildReplayResponse(sessionId: string, deps: ApiHandlerDeps): unknown | null {
  // Try persisted session first
  if (deps.sessionStore) {
    const session = deps.sessionStore.loadSession(sessionId) as Record<string, unknown> | null;
    if (session && Array.isArray(session['timeline'])) {
      const rawTimeline = session['timeline'] as ReplayTimelineEntry[];
      // Redact sensitive fields before sending to the browser
      const timeline = rawTimeline.map((e) => ({
        ...e,
        filePath: e.filePath ? redactSensitive(String(e.filePath)) : undefined,
        command: e.command ? redactSensitive(String(e.command)) : undefined,
      }));
      const analysis = analyzeReplayTimeline(timeline);
      return {
        sessionId,
        timeline,
        segments: analysis.segments,
        worstSegment: analysis.worstSegment,
      };
    }
  }

  // Try live session from TaskDetector — filter to the requested sessionId
  if (deps.taskDetector) {
    const completed = deps.taskDetector.getCompletedTasks();
    const current = deps.taskDetector.getCurrentTask();
    const allCalls: ToolCallRecord[] = [];
    for (const task of completed) {
      allCalls.push(...(task.toolCalls as ToolCallRecord[]));
    }
    if (current) {
      allCalls.push(...(current.toolCalls as ToolCallRecord[]));
    }
    const sessionCalls = allCalls.filter((c) => c.sessionId === sessionId);
    if (sessionCalls.length > 0) {
      sessionCalls.sort((a, b) => a.timestamp - b.timestamp);
      const timeline = sessionCalls.map(toolCallToTimelineEntry);
      const analysis = analyzeReplayTimeline(timeline);
      return {
        sessionId,
        timeline,
        segments: analysis.segments,
        worstSegment: analysis.worstSegment,
      };
    }
  }

  // Final fallback: scan the in-memory tool call buffer for events matching
  // sessionId. TaskDetector only emits records once they're attributed to a
  // task; tool calls that fire before a task starts (or for sessions other
  // than the dashboard owner's) live in the buffer but not in TaskDetector.
  // Today's live tail reads via SSE so it sees these immediately; without
  // this fallback the Sessions detail view shows "No tool calls" for a
  // newly-live session that hasn't yet completed a task.
  if (deps.toolCallBuffer) {
    const records = deps.toolCallBuffer.getRecords();
    const sessionCalls = records.filter(
      (c) => (c as { sessionId?: string | null }).sessionId === sessionId,
    ) as ToolCallRecord[];
    if (sessionCalls.length > 0) {
      sessionCalls.sort((a, b) => a.timestamp - b.timestamp);
      const timeline = sessionCalls.map(toolCallToTimelineEntry);
      const analysis = analyzeReplayTimeline(timeline);
      return {
        sessionId,
        timeline,
        segments: analysis.segments,
        worstSegment: analysis.worstSegment,
      };
    }
  }

  return null;
}

export function createApiHandler(
  deps: ApiHandlerDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const routes = new Map<string, RouteFn>();

  routes.set('GET /api/session/current', (_req, res) => {
    if (!deps.sessionTracker) return unavailable(res, 'sessionTracker');
    // surface the rolling efficiency score as a sibling field so the
    // SPA Today KPI can render it without a second round-trip. `null` when
    // no tasks have been scored yet (or when the scorer wasn't wired in).
    const efficiencyScore = deps.efficiencyScorer?.getSessionAverage()?.score ?? null;
    const liveSessions = deps.liveSessionRegistry?.getLiveSessions() ?? [];
    jsonOk(res, { ...deps.sessionTracker.getMetrics(), efficiencyScore, liveSessions });
  });

  routes.set('GET /api/session/today', (_req, res) => {
    if (!deps.sessionStore) return unavailable(res, 'sessionStore');
    jsonOk(res, deps.sessionStore.loadTodaySessions());
  });

  routes.set('GET /api/sessions', (req, res) => {
    if (!deps.sessionStore) return unavailable(res, 'sessionStore');
    const url = new URL(req.url ?? '/', 'http://localhost');
    const limitStr = url.searchParams.get('limit') ?? '';
    let limit = 50;
    const parsed = parseInt(limitStr, 10);
    if (!Number.isNaN(parsed)) {
      limit = Math.min(Math.max(parsed, 1), 500);
    }
    const allSessions = deps.sessionStore.loadAllSessions
      ? deps.sessionStore.loadAllSessions()
      : deps.sessionStore.listSessions();
    // Filter synthetic IDs (`local-<ts>`, `proxy-<ts>`) from the historical
    // list. They're MCP-internal bookkeeping IDs persisted incidentally by
    // older builds; they appear as confusing "duplicate" rows next to real
    // Claude Code sessions. The synthetic-shutdown filter in src/index.ts
    // prevents new ones from being persisted, but stale ones from before
    // that filter shipped need to be hidden at read time.
    const withActivity = (allSessions as unknown[]).filter((s) => {
      const sid = (s as { sessionId?: string }).sessionId;
      const calls = (s as { toolCallCount?: number }).toolCallCount ?? 0;
      return calls > 0 && (!sid || !isSyntheticSessionId(sid));
    });
    const sliced = withActivity.slice(-limit);

    // Append the current live session so it appears in the list before
    // shutdown — but skip synthetic sessionTraceIds from --local / proxy
    // modes (the same filter as for persisted entries above).
    if (deps.sessionTracker) {
      const live = deps.sessionTracker.getMetrics();
      const alreadyPersisted = sliced.some(
        (s) => (s as { sessionId?: string }).sessionId === live.sessionId,
      );
      if (!alreadyPersisted && live.toolCallCount > 0 && !isSyntheticSessionId(live.sessionId)) {
        sliced.push({
          sessionId: live.sessionId,
          sessionName: live.sessionName ?? null,
          startTime: live.sessionStartTime,
          durationMs: live.sessionDurationMs,
          toolCallCount: live.toolCallCount,
          estimatedCostUsd: deps.costTracker?.getMetrics().sessionTotalCostUsd ?? null,
        });
      }
    }

    // Inject stub entries for live sessions not yet persisted to disk.
    // Derive toolCallCount and startTime from the in-memory tool call buffer
    // so concurrent sessions show real activity counts on the badges.
    if (deps.liveSessionRegistry) {
      const knownIds = new Set(sliced.map((s) => (s as { sessionId?: string }).sessionId));
      const records = deps.toolCallBuffer?.getRecords() ?? [];
      const perSession = new Map<string, { count: number; firstTs: number; lastTs: number }>();
      for (const r of records) {
        const sid = (r as { sessionId?: string | null }).sessionId;
        if (!sid) continue;
        const ts = (r as { timestamp?: number }).timestamp ?? 0;
        const entry = perSession.get(sid);
        if (entry) {
          entry.count++;
          if (ts && ts < entry.firstTs) entry.firstTs = ts;
          if (ts && ts > entry.lastTs) entry.lastTs = ts;
        } else {
          perSession.set(sid, { count: 1, firstTs: ts || Date.now(), lastTs: ts || Date.now() });
        }
      }
      for (const id of deps.liveSessionRegistry.getLiveSessions()) {
        if (!knownIds.has(id)) {
          const stats = perSession.get(id);
          // getLastActivity is registry-maintained and survives buffer drains,
          // so use it as the stable upper bound for durationMs. Without this,
          // durationMs collapses to 0 every 5s when the harvest scheduler drains
          // the buffer and perSession rebuilds from an empty set of records.
          const lastActivityTs = deps.liveSessionRegistry.getLastActivity?.(id) ?? stats?.lastTs;
          const sessionStart = stats?.firstTs ?? lastActivityTs ?? Date.now();
          sliced.push({
            sessionId: id,
            sessionName: deps.liveSessionRegistry.getSessionName(id),
            startTime: sessionStart,
            durationMs: lastActivityTs != null ? Math.max(0, lastActivityTs - sessionStart) : 0,
            toolCallCount: stats?.count ?? 0,
            estimatedCostUsd: null,
          });
        }
      }
    }

    // Strip heavy per-session fields the list view doesn't render. Without
    // this, /api/sessions returns ~90KB per session × N sessions; first
    // paint blocks on parsing 200KB+ of JSON the list never reads.
    // The detail endpoint /api/sessions/:id returns the full session.
    const HEAVY_FIELDS = new Set(['timeline', 'filesRead', 'filesModified']);
    const slimmed = sliced.map((s) => {
      const o = s as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(o)) {
        if (!HEAVY_FIELDS.has(k)) out[k] = o[k];
      }
      return out;
    });
    jsonOk(res, slimmed.length > limit ? slimmed.slice(-limit) : slimmed);
  });

  // Currently-live session list with metadata. Sourced from LiveSessionRegistry
  // (touch-based liveness within a 3-minute window) so the Today selector can
  // default to the most-recently-active session even when nothing has been
  // persisted to disk yet. The dashboard owner sees every live session — the
  // registry is in-memory and shared via this MCP, so the data is one
  // authoritative read.
  //
  // Falls back to the in-memory tool call buffer for `startTime` (oldest
  // observed timestamp for that session) since the registry only tracks
  // last-activity. When a session's first event hasn't reached the buffer
  // yet, startTime defaults to lastActivity (or now() if both are missing).
  routes.set('GET /api/sessions/live', (_req, res) => {
    if (!deps.liveSessionRegistry) return unavailable(res, 'liveSessionRegistry');
    // Filter out synthetic session identities used by --local / proxy modes
    // (`local-<ts>`, `proxy-<ts>`). They're MCP-internal bookkeeping IDs,
    // not real Claude Code sessions, so they shouldn't appear as clickable
    // rows in the dashboard's live-sessions selector. The real user sessions
    // (with proper session_ids resolved via the breadcrumb / CLAUDE_JOB_DIR
    // path) are what users want to see and click.
    const ids = deps.liveSessionRegistry
      .getLiveSessions()
      .filter((id) => !isSyntheticSessionId(id));
    const records = deps.toolCallBuffer?.getRecords() ?? [];
    const perSession = new Map<string, { firstTs: number; lastTs: number }>();
    for (const r of records) {
      const sid = (r as { sessionId?: string | null }).sessionId;
      if (!sid) continue;
      const ts = (r as { timestamp?: number }).timestamp ?? 0;
      if (!ts) continue;
      const entry = perSession.get(sid);
      if (entry) {
        if (ts < entry.firstTs) entry.firstTs = ts;
        if (ts > entry.lastTs) entry.lastTs = ts;
      } else {
        perSession.set(sid, { firstTs: ts, lastTs: ts });
      }
    }
    const sessions = ids.map((id) => {
      const stats = perSession.get(id);
      const lastActivity =
        deps.liveSessionRegistry?.getLastActivity?.(id) ?? stats?.lastTs ?? Date.now();
      return {
        sessionId: id,
        sessionName: deps.liveSessionRegistry?.getSessionName(id) ?? null,
        startTime: stats?.firstTs ?? lastActivity,
        lastActivity,
      };
    });
    // Most-recently-active first so the Today selector can default to
    // sessions[0] without re-sorting on the client.
    sessions.sort((a, b) => b.lastActivity - a.lastActivity);
    jsonOk(res, sessions);
  });

  // Cross-session aggregate KPIs for the Today view. Reads:
  //   1. every per-session buffer-*.jsonl in read-only mode (each MCP only
  //      drains its own; the dashboard owner needs the union)
  //   2. completed session JSONs at ~/.newrelic-preflight/sessions/ (loaded via
  //      sessionStore.loadTodaySessions())
  //   3. the in-memory tool call buffer (events from this MCP that have
  //      already been processed but not yet persisted)
  //
  // The minute-bucketed sparkline starts at 00:00 local and runs through
  // the current minute. Aggregate `avgDurationMs` is the simple mean over
  // every observed durationMs across all three sources.
  //
  // Caching: dashboards poll this endpoint every 5–10s; both reads (peek
  // every buffer-*.jsonl + load every today-session JSON) hit disk and
  // walk the full result. Cache the response in a 5-second bucket so a
  // single tab burst plus a couple of mirror tabs collapses to one
  // computation per bucket. TTL is short enough that the live-feel KPI
  // (sparkline tail, tool-call count) lags by at most ~5s.
  const AGGREGATE_TTL_MS = 5_000;
  let aggregateCache: { bucket: number; payload: unknown } | null = null;

  routes.set('GET /api/sessions/today/aggregate', (_req, res) => {
    const now = Date.now();
    const currentBucket = Math.floor(now / AGGREGATE_TTL_MS);
    if (aggregateCache && aggregateCache.bucket === currentBucket) {
      jsonOk(res, aggregateCache.payload);
      return;
    }

    const startMs = localStartOfDay(now);
    const minuteBuckets = Math.max(1, Math.ceil((now - startMs) / 60_000));
    const sparkline = new Array<number>(minuteBuckets).fill(0);

    let toolCallCount = 0;
    let totalDurationMs = 0;
    let durationSamples = 0;
    let totalCostUsd = 0;
    let antiPatternCount = 0;
    const sessionsSeen = new Set<string>();

    // (1) live, undrained per-session buffer events
    const peeked = deps.localStore?.peekAllBuffers() ?? [];
    // Per-live-session earliest buffer timestamp (today only). Used as a
    // cutoff against the persisted timeline below: persisted timeline
    // entries strictly OLDER than the buffer's earliest event for the same
    // sessionId are pre-resume (drained before persistence and replayed via
    // saved JSON); entries at-or-after that cutoff are live buffer events
    // we already counted in step (1) and must not double-count.
    //
    // In practice the resume-after-shutdown flow doesn't keep the buffer
    // alive across restarts (each MCP starts fresh), so this dedup is a
    // belt-and-suspenders safety net rather than a load-bearing invariant.
    const bufferStartBySession = new Map<string, number>();
    for (const ev of peeked) {
      const ts = typeof ev.timestamp === 'number' ? ev.timestamp : 0;
      if (ts < startMs) continue;
      const sid = ev.sessionId;
      if (typeof sid === 'string' && sid.length > 0) {
        sessionsSeen.add(sid);
        const prev = bufferStartBySession.get(sid);
        if (prev === undefined || ts < prev) bufferStartBySession.set(sid, ts);
      }
      // Hook events come through as either `pre`/`post`/`token`. We only
      // count `post` events as completed tool calls — `pre` is the start
      // marker and `token` is a cost event with no tool-call semantics.
      if (ev.mode === 'post') {
        toolCallCount++;
        const idx = Math.floor((ts - startMs) / 60_000);
        if (idx >= 0 && idx < sparkline.length) sparkline[idx]++;
        const dur = typeof ev.durationMs === 'number' ? ev.durationMs : null;
        if (dur !== null) {
          totalDurationMs += dur;
          durationSamples++;
        }
      }
    }

    // Hoist the live-session set out of the inner loop so we don't pay
    // O(timeline × liveSessions) lookups per aggregate request.
    const liveSet = new Set<string>(deps.liveSessionRegistry?.getLiveSessions() ?? []);

    // (2) completed sessions persisted today
    const todaySessions = deps.sessionStore?.loadTodaySessions() ?? [];
    for (const raw of todaySessions) {
      const session = raw as {
        sessionId?: string;
        toolCallCount?: number;
        estimatedCostUsd?: number | null;
        antiPatterns?: ReadonlyArray<unknown>;
        timeline?: ReadonlyArray<{ timestamp: number; durationMs: number | null }>;
      };
      if (typeof session.sessionId === 'string') sessionsSeen.add(session.sessionId);
      // Cost is summed in a separate pass below so cross-midnight sessions
      // (loaded via loadSessionsOverlappingToday) contribute their today
      // portion only. See "(2b) cost from sessions overlapping today" below.
      antiPatternCount += session.antiPatterns?.length ?? 0;

      // Walk timeline entries within today. Persisted timelines and the
      // buffer cover disjoint time ranges by construction (persistence
      // runs at shutdown, after all events have been processed; buffer
      // contents are undrained events). Even in the resume-after-shutdown
      // case, the persisted JSON holds pre-shutdown events while the
      // buffer holds post-resume events — disjoint timestamps. Use a
      // per-session timestamp cutoff (earliest buffer event for that
      // sessionId) as a defensive dedup so we never double-count if the
      // ranges ever DO overlap.
      if (session.timeline) {
        const sid = session.sessionId ?? '';
        const bufferCutoff = liveSet.has(sid) ? bufferStartBySession.get(sid) : undefined;
        for (const entry of session.timeline) {
          if (entry.timestamp < startMs) continue;
          if (bufferCutoff !== undefined && entry.timestamp >= bufferCutoff) continue;
          toolCallCount++;
          const idx = Math.floor((entry.timestamp - startMs) / 60_000);
          if (idx >= 0 && idx < sparkline.length) sparkline[idx]++;
          if (entry.durationMs !== null) {
            totalDurationMs += entry.durationMs;
            durationSamples++;
          }
        }
      }
    }

    // (2b) cost from sessions overlapping today (separate pass so cross-
    // midnight sessions started yesterday but ending after midnight contribute
    // their today portion to spend, while NOT inflating tool-call or
    // anti-pattern counts above which are already today-bounded by timeline).
    //
    // Why a separate loader: loadTodaySessions() filters by file-name date
    // (= start date), so it drops sessions that started yesterday and ended
    // today. The cost path needs them; the tool-call path doesn't (its
    // timeline filter would skip pre-midnight entries anyway).
    const liveSid = deps.sessionTracker?.getMetrics().sessionId;
    // Prefer overlapping-today loader (catches yesterday→today sessions).
    // When the store doesn't implement it (older tests/fakes), reuse the
    // already-loaded `todaySessions` rather than re-invoking
    // loadTodaySessions — keeps disk reads at one per request and preserves
    // the cache-hit assertions in api-handler.test.ts.
    const overlappingTodaySessions =
      deps.sessionStore?.loadSessionsOverlappingToday?.() ?? todaySessions;
    for (const raw of overlappingTodaySessions) {
      const s = raw as {
        sessionId?: string;
        startTime: number;
        endTime: number;
        estimatedCostUsd: number | null;
        antiPatterns?: ReadonlyArray<unknown>;
        timeline?: ReadonlyArray<{ timestamp: number }>;
      };
      // Skip the live session here — its today-portion is added below from
      // costTracker.getCostForDay(), which is more accurate (per-token-event)
      // than pro-rating from a periodically-persisted snapshot.
      if (s.sessionId === liveSid) continue;
      totalCostUsd += todayPortionOfSessionCost(s, now);
      // Count anti-patterns and session for cross-midnight sessions not already
      // captured by the todaySessions loop (which filtered by start-date).
      if (typeof s.sessionId === 'string' && !sessionsSeen.has(s.sessionId)) {
        sessionsSeen.add(s.sessionId);
        antiPatternCount += s.antiPatterns?.length ?? 0;
      }
    }

    // (3) include this MCP's live session today-portion. Per-day attribution
    // comes from CostTracker, which buckets each token event by local-day at
    // record time (see CostTracker.accumulateTokens). Falls back to session
    // total if no per-day data is available (older deployments / first event).
    const liveAlreadyPersisted = todaySessions.some(
      (s) => (s as { sessionId?: string }).sessionId === liveSid,
    );

    if (!liveAlreadyPersisted) {
      const todayKey = localDateKey(now);
      const liveTodayUsd = deps.costTracker?.getCostForDay?.(todayKey) ?? null;
      if (typeof liveTodayUsd === 'number') {
        totalCostUsd += liveTodayUsd;
      } else {
        // Fallback for older deployments without per-day API. This is the
        // pre-fix behavior; only hit when getCostForDay is missing.
        const sessionCost = deps.costTracker?.getMetrics().sessionTotalCostUsd ?? null;
        if (typeof sessionCost === 'number') totalCostUsd += sessionCost;
      }
    }

    // Live session anti-patterns (in-memory, not yet persisted).
    // Mirror the alreadyPersisted guard used for cost above: if this MCP's
    // session is already in todaySessions, its anti-patterns were counted in
    // the loop above — don't double-count.
    if (deps.antiPatternDetector && !liveAlreadyPersisted) {
      const live = deps.antiPatternDetector.getCurrentPatterns() as ReadonlyArray<unknown>;
      antiPatternCount += live.length;
    }

    const avgDurationMs = durationSamples > 0 ? totalDurationMs / durationSamples : 0;

    const payload = {
      toolCallCount,
      totalCostUsd: Math.round(totalCostUsd * 1000) / 1000,
      antiPatternCount,
      avgDurationMs: Math.round(avgDurationMs),
      sessionCount: sessionsSeen.size,
      sparkline: { startTimestamp: startMs, bucketSizeMs: 60_000, points: sparkline },
    };
    aggregateCache = { bucket: currentBucket, payload };
    jsonOk(res, payload);
  });

  routes.set('GET /api/cost', (_req, res) => {
    if (!deps.costTracker) return unavailable(res, 'costTracker');
    const cost = deps.costTracker.getMetrics();
    const forecast = deps.costForecast?.() ?? null;
    // sessionTodayUsd lets the client compute the correct EoD forecast fallback:
    //   todayTotal + (forecastEndOfDayUsd − sessionTodayUsd) = todayTotal + projected
    // Without it, the client would add persistedTodaySpend to forecastEndOfDayUsd and
    // risk double-counting the live session when its snapshot is already in persisted data.
    const sessionTodayUsd = deps.costTracker.getCostForDay?.(localDateKey(Date.now())) ?? null;
    jsonOk(res, { cost, forecast, sessionTodayUsd });
  });

  routes.set('GET /api/anti-patterns', (_req, res) => {
    if (!deps.antiPatternDetector) return unavailable(res, 'antiPatternDetector');
    jsonOk(res, deps.antiPatternDetector.getCurrentPatterns());
  });

  routes.set('GET /api/audit', (_req, res) => {
    if (!deps.auditTrailManager) return unavailable(res, 'auditTrailManager');
    const log = deps.auditTrailManager.getAuditLog();
    jsonOk(res, log.map(toAuditEntry));
  });

  routes.set('GET /api/weekly', (req, res) => {
    if (!deps.weeklySummaryGenerator) return unavailable(res, 'weeklySummaryGenerator');
    const url = new URL(req.url ?? '/', 'http://localhost');
    const countStr = url.searchParams.get('count') ?? '';
    let count = 12;
    const parsed = parseInt(countStr, 10);
    if (!Number.isNaN(parsed)) {
      count = Math.min(Math.max(parsed, 1), 52);
    }
    try {
      deps.weeklySummaryGenerator.generate(getIsoWeekId(new Date()));
    } catch (err) {
      // best-effort — failure here means stale weekly data is returned, not a 500
      console.error('Weekly summary generation failed', err);
    }
    jsonOk(res, deps.weeklySummaryGenerator.loadRecentWeeks(count));
  });

  routes.set('GET /api/budget', (_req, res) => {
    if (!deps.budgetTracker) return unavailable(res, 'budgetTracker');
    jsonOk(res, deps.budgetTracker.getStatus());
  });

  routes.set('GET /api/latency', (_req, res) => {
    if (!deps.latencyTracker) return unavailable(res, 'latencyTracker');
    jsonOk(res, deps.latencyTracker.getMetrics());
  });

  routes.set('GET /api/model-usage', (_req, res) => {
    if (!deps.modelUsageTracker) return unavailable(res, 'modelUsageTracker');
    jsonOk(res, deps.modelUsageTracker.getMetrics());
  });

  routes.set('GET /api/cost-per-outcome', (req, res) => {
    if (!deps.sessionStore?.loadAllSessions)
      return unavailable(res, 'sessionStore.loadAllSessions');
    const url = new URL(req.url ?? '/', 'http://localhost');
    const daysStr = url.searchParams.get('days') ?? '';
    let days = 30;
    const parsedDays = parseInt(daysStr, 10);
    if (!Number.isNaN(parsedDays)) {
      days = Math.min(Math.max(parsedDays, 1), 365);
    }
    const since = new Date(Date.now() - days * 86_400_000);
    const sessions = deps.sessionStore.loadAllSessions({ since });
    jsonOk(res, attributeSessionCosts(sessions));
  });

  routes.set('GET /api/personal-coach', (_req, res) => {
    if (!deps.personalCoach) return unavailable(res, 'personalCoach');
    jsonOk(res, deps.personalCoach.generate());
  });

  routes.set('GET /api/alerts/recent', async (_req, res) => {
    // 404 (not 503) when alerts are not configured — the route does not
    // exist as a logical resource in cloud-only mode or when alerts are
    // disabled. Plan §8 acceptance criterion calls for 404.
    if (!deps.alertLog) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    // Fixed limit (50) — matches the dashboard panel cap.
    try {
      const entries = await deps.alertLog.readRecent(50);
      jsonOk(res, entries);
    } catch (err) {
      // Log full error details server-side; never echo to the HTTP client.
      // Stringifying the raw Error leaks file paths, env-var names, and
      // potential connection-string fragments via stack frames.
      console.error('alertLog.readRecent failed', err);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal' }));
    }
  });

  routes.set('GET /api/quality-proxy', (_req, res) => {
    if (!deps.qualityProxyTracker) return unavailable(res, 'qualityProxyTracker');
    const live = deps.qualityProxyTracker.getMetrics() as { totalSignals: number };
    if (live.totalSignals > 0 || !deps.sessionStore) {
      jsonOk(res, live);
      return;
    }
    jsonOk(res, aggregateQualityFromHistory(deps.sessionStore.loadTodaySessions()));
  });

  routes.set('GET /api/tool-selection-score', (_req, res) => {
    if (!deps.toolSelectionScorer) return unavailable(res, 'toolSelectionScorer');
    const calls = deps.toolCallBuffer?.getRecords() ?? [];
    jsonOk(res, deps.toolSelectionScorer.scoreSession(calls));
  });

  routes.set('GET /api/git-efficiency', (_req, res) => {
    if (!deps.gitEfficiencyTracker) return unavailable(res, 'gitEfficiencyTracker');
    jsonOk(res, deps.gitEfficiencyTracker.getMetrics());
  });

  routes.set('GET /api/context', (req, res) => {
    if (!deps.contextTracker) return unavailable(res, 'contextTracker');
    const url = new URL(req.url ?? '/', 'http://localhost');
    const sessionId = url.searchParams.get('sessionId') ?? undefined;
    jsonOk(res, deps.contextTracker.getMetrics(sessionId));
  });

  routes.set('GET /api/concurrency', (req, res) => {
    if (!deps.concurrencyTracker) return unavailable(res, 'concurrencyTracker');
    try {
      const todaySessions = deps.sessionStore?.loadTodaySessions() ?? [];
      const historicalPeak = computeTodayPeakConcurrency(todaySessions);
      const livePeak = deps.concurrencyTracker.getPeakConcurrent();

      const url = new URL(req.url ?? '/', 'http://localhost');
      const view = url.searchParams.get('view');
      if (view === 'history') {
        const daysParam = url.searchParams.get('days');
        const days = daysParam ? Math.min(Math.max(parseInt(daysParam, 10) || 30, 1), 90) : 30;
        const since = new Date(localStartOfDay());
        since.setDate(since.getDate() - days);
        const allSessions = deps.sessionStore?.loadAllSessions?.({ since }) ?? [];
        const dailyPeaks = computeDailyPeakConcurrency(allSessions, days);
        // Override today's bucket with the live peak — disk-derived
        // concurrency only sees persisted (completed) sessions, so a
        // dashboard with active concurrent sessions but nothing flushed
        // to disk yet would otherwise report peak=0 for today.
        if (dailyPeaks.length > 0 && livePeak > 0) {
          const today = dailyPeaks[dailyPeaks.length - 1];
          if (today.peak < livePeak) {
            dailyPeaks[dailyPeaks.length - 1] = { ...today, peak: livePeak };
          }
        }
        jsonOk(res, { dailyPeaks });
        return;
      }

      const allSessions = deps.sessionStore?.loadAllSessions?.() ?? [];
      const allTimePeak = computeTodayPeakConcurrency(allSessions);

      // 96 × 15-minute fixed-grid buckets covering today (local midnight →
      // local midnight + 24h). Each bucket holds the peak concurrent
      // session count within its window. Bounded payload (~10 KB) and
      // renders cleanly at any zoom level. Replaces the prior unbounded
      // 30-second rolling timeSeries.
      const startTimestamp = localStartOfDay();
      const liveIds = deps.liveSessionRegistry?.getLiveSessions() ?? [];
      const bufferRecords = deps.toolCallBuffer?.getRecords() ?? [];
      // Synthetic session ids (`local-*`, `proxy-*`) are hidden from
      // /api/sessions and /api/sessions/live. Apply the same filter here
      // so persisted synthetic records on disk don't contribute to bucket
      // counts either — otherwise the buckets disagree with the session
      // list shown alongside the chart.
      const filteredTodaySessions = todaySessions.filter((s) => {
        const sid = (s as { sessionId?: string | null }).sessionId;
        return !isSyntheticSessionId(sid);
      });
      const intervals = collectTodaySessionIntervals(
        filteredTodaySessions,
        liveIds.filter((id) => !isSyntheticSessionId(id)),
        bufferRecords,
        Date.now(),
      );
      const buckets = computeTodayConcurrencyBuckets(intervals, startTimestamp);

      jsonOk(res, {
        current: deps.concurrencyTracker.getConcurrentCount(),
        peak: Math.max(livePeak, historicalPeak),
        allTimePeak: Math.max(livePeak, historicalPeak, allTimePeak),
        bucketSizeMs: CONCURRENCY_BUCKET_SIZE_MS,
        startTimestamp,
        buckets,
      });
    } catch {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal_error' }));
    }
  });

  routes.set('GET /api/activity-heatmap', (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const view = url.searchParams.get('view') ?? 'today';

      if (view === 'today') {
        const now = Date.now();
        const startMs = localStartOfDay(now);
        const bucketSizeMs = 900_000;
        const bucketCount = Math.ceil((now - startMs) / bucketSizeMs) || 1;
        const buckets = new Array<number>(bucketCount).fill(0);

        const bufferRecords = deps.toolCallBuffer?.getRecords() ?? [];
        for (const r of bufferRecords) {
          if (r.timestamp >= startMs) {
            const idx = Math.floor((r.timestamp - startMs) / bucketSizeMs);
            if (idx >= 0 && idx < bucketCount) {
              buckets[idx]++;
            }
          }
        }

        const todaySessions = deps.sessionStore?.loadTodaySessions() ?? [];
        for (const s of todaySessions) {
          const session = s as { timeline?: readonly { timestamp: number }[] };
          if (session.timeline) {
            for (const entry of session.timeline) {
              if (entry.timestamp >= startMs) {
                const idx = Math.floor((entry.timestamp - startMs) / bucketSizeMs);
                if (idx >= 0 && idx < bucketCount) {
                  buckets[idx]++;
                }
              }
            }
          }
        }

        const maxCount = Math.max(...buckets, 1);
        jsonOk(res, { buckets, bucketSizeMs, startTimestamp: startMs, maxCount });
        return;
      }

      if (view === 'history') {
        const weeksParam = url.searchParams.get('weeks');
        const weeks = weeksParam ? Math.min(Math.max(parseInt(weeksParam, 10) || 12, 1), 52) : 12;
        const now = new Date();
        const startDate = new Date(now);
        startDate.setUTCDate(startDate.getUTCDate() - weeks * 7);
        startDate.setUTCHours(0, 0, 0, 0);

        const sessions = deps.sessionStore?.loadAllSessions?.({ since: startDate }) ?? [];

        const dayMap = new Map<string, number>();
        const cursor = new Date(startDate);
        while (cursor <= now) {
          dayMap.set(cursor.toISOString().slice(0, 10), 0);
          cursor.setUTCDate(cursor.getUTCDate() + 1);
        }

        for (const s of sessions) {
          const session = s as { startTime?: string | number; toolCallCount?: number };
          if (!session.startTime) continue;
          const d = new Date(
            typeof session.startTime === 'number' ? session.startTime : session.startTime,
          );
          if (d < startDate) continue;
          const key = d.toISOString().slice(0, 10);
          if (dayMap.has(key)) {
            dayMap.set(key, (dayMap.get(key) ?? 0) + (session.toolCallCount ?? 0));
          }
        }

        const days = Array.from(dayMap.entries()).map(([date, count]) => ({ date, count }));
        const maxCount = Math.max(...days.map((d) => d.count), 1);
        jsonOk(res, { days, maxCount });
        return;
      }

      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_view', message: 'Use view=today or view=history' }));
    } catch {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal_error' }));
    }
  });

  routes.set('GET /api/git-efficiency/repos', (_req, res) => {
    if (!deps.sessionStore) return unavailable(res, 'sessionStore');
    const todaySessions = deps.sessionStore.loadTodaySessions() as Array<{
      repoName?: string | null;
      sessionId: string;
    }>;
    const repoSet = new Set<string>();
    for (const session of todaySessions) {
      if (typeof session.repoName === 'string' && session.repoName) {
        repoSet.add(session.repoName);
      }
    }
    // Include the current repo from git efficiency tracker if available
    let currentRepo: string | null = null;
    if (deps.gitEfficiencyTracker) {
      const metrics = deps.gitEfficiencyTracker.getMetrics() as {
        repoContext?: { repoName?: string | null };
      };
      const trackerRepo = metrics.repoContext?.repoName ?? null;
      if (trackerRepo) {
        currentRepo = trackerRepo;
        repoSet.add(trackerRepo);
      }
    }
    jsonOk(res, { repos: [...repoSet].sort(), currentRepo });
  });

  // ── Settings endpoints ──────────────────────────────────────────────────

  routes.set('GET /api/settings', (_req, res) => {
    if (!deps.config) return unavailable(res, 'config');
    const c = deps.config;

    // Read editable fields from disk so the UI reflects the latest saved
    // values after a PATCH (deps.config is frozen at startup and never
    // updated in memory).
    let disk: Record<string, unknown> = {};
    if (deps.configFilePath) {
      try {
        disk = JSON.parse(readFileSync(deps.configFilePath, 'utf-8')) as Record<string, unknown>;
      } catch {
        /* config file may not exist yet — fall through to startup defaults */
      }
    }

    const diskAlerts = (disk.alerts ?? {}) as Record<string, unknown>;
    const diskPersonal = (diskAlerts['personal'] ?? {}) as Record<string, unknown>;

    jsonOk(res, {
      // Editable fields: prefer disk, fall back to startup config
      developer: typeof disk.developer === 'string' ? disk.developer : c.developer,
      teamId: 'teamId' in disk ? (disk.teamId as string | null) : c.teamId,
      sessionBudgetUsd:
        'sessionBudgetUsd' in disk ? (disk.sessionBudgetUsd as number | null) : c.sessionBudgetUsd,
      dailyBudgetUsd:
        'dailyBudgetUsd' in disk ? (disk.dailyBudgetUsd as number | null) : c.dailyBudgetUsd,
      weeklyBudgetUsd:
        'weeklyBudgetUsd' in disk ? (disk.weeklyBudgetUsd as number | null) : c.weeklyBudgetUsd,
      retainSessionsDays:
        'retainSessionsDays' in disk
          ? (disk.retainSessionsDays as number | null)
          : c.retainSessionsDays,
      digestWebhookUrl:
        'digestWebhookUrl' in disk ? (disk.digestWebhookUrl as string | null) : c.digestWebhookUrl,
      digestSchedule:
        typeof disk.digestSchedule === 'string' ? disk.digestSchedule : c.digestSchedule,
      alerts: {
        personal: {
          dailyCostUsd:
            typeof diskPersonal['dailyCostUsd'] === 'number'
              ? diskPersonal['dailyCostUsd']
              : c.personalAlertThresholds.dailyCostUsd,
          sessionCostUsd:
            typeof diskPersonal['sessionCostUsd'] === 'number'
              ? diskPersonal['sessionCostUsd']
              : c.personalAlertThresholds.sessionCostUsd,
          efficiencyScoreMin:
            typeof diskPersonal['efficiencyScoreMin'] === 'number'
              ? diskPersonal['efficiencyScoreMin']
              : c.personalAlertThresholds.efficiencyScoreMin,
          stuckLoopCountMax:
            typeof diskPersonal['stuckLoopCountMax'] === 'number'
              ? diskPersonal['stuckLoopCountMax']
              : c.personalAlertThresholds.stuckLoopCountMax,
          antiPatternCountMax:
            typeof diskPersonal['antiPatternCountMax'] === 'number'
              ? diskPersonal['antiPatternCountMax']
              : c.personalAlertThresholds.antiPatternCountMax,
        },
      },
      // Read-only fields always from startup config
      accountId: c.accountId ?? null,
      appName: c.appName,
      mode: c.mode,
      storagePath: c.storagePath,
      highSecurity: c.highSecurity,
      licenseKey: c.licenseKey ? '••••' + c.licenseKey.slice(-4) : null,
    });
  });

  routes.set('PATCH /api/settings', async (req, res) => {
    if (!deps.configFilePath) return unavailable(res, 'configFilePath');
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_json' }));
      return;
    }

    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(readFileSync(deps.configFilePath, 'utf-8')) as Record<string, unknown>;
    } catch {
      /* no existing config — start fresh */
    }

    const errors: string[] = [];
    let digestUrlOnly = true; // tracks whether only digest URL changed

    if ('developer' in body) {
      if (typeof body.developer !== 'string') {
        errors.push('developer must be a string');
      } else {
        existing.developer = normalizeDeveloperName(body.developer);
        digestUrlOnly = false;
      }
    }
    if ('teamId' in body) {
      if (body.teamId !== null && typeof body.teamId !== 'string') {
        errors.push('teamId must be string or null');
      } else {
        existing.teamId = body.teamId;
        digestUrlOnly = false;
      }
    }
    if ('sessionBudgetUsd' in body) {
      if (
        body.sessionBudgetUsd !== null &&
        (typeof body.sessionBudgetUsd !== 'number' || body.sessionBudgetUsd <= 0)
      ) {
        errors.push('sessionBudgetUsd must be a positive number or null');
      } else {
        existing.sessionBudgetUsd = body.sessionBudgetUsd;
        digestUrlOnly = false;
      }
    }
    if ('dailyBudgetUsd' in body) {
      if (
        body.dailyBudgetUsd !== null &&
        (typeof body.dailyBudgetUsd !== 'number' || body.dailyBudgetUsd <= 0)
      ) {
        errors.push('dailyBudgetUsd must be a positive number or null');
      } else {
        existing.dailyBudgetUsd = body.dailyBudgetUsd;
        digestUrlOnly = false;
      }
    }
    if ('weeklyBudgetUsd' in body) {
      if (
        body.weeklyBudgetUsd !== null &&
        (typeof body.weeklyBudgetUsd !== 'number' || body.weeklyBudgetUsd <= 0)
      ) {
        errors.push('weeklyBudgetUsd must be a positive number or null');
      } else {
        existing.weeklyBudgetUsd = body.weeklyBudgetUsd;
        digestUrlOnly = false;
      }
    }
    if ('retainSessionsDays' in body) {
      if (
        body.retainSessionsDays !== null &&
        (!Number.isInteger(body.retainSessionsDays) ||
          (body.retainSessionsDays as number) < 1 ||
          (body.retainSessionsDays as number) > 365)
      ) {
        errors.push('retainSessionsDays must be integer 1-365 or null');
      } else {
        existing.retainSessionsDays = body.retainSessionsDays;
        digestUrlOnly = false;
      }
    }
    if ('digestWebhookUrl' in body) {
      if (
        body.digestWebhookUrl !== null &&
        (typeof body.digestWebhookUrl !== 'string' ||
          !body.digestWebhookUrl.startsWith('https://hooks.slack.com/'))
      ) {
        errors.push(
          'digestWebhookUrl must be a Slack incoming webhook URL (https://hooks.slack.com/...) or null',
        );
      } else {
        existing.digestWebhookUrl = body.digestWebhookUrl ?? undefined;
        if (existing.digestWebhookUrl === undefined) {
          delete existing.digestWebhookUrl;
        }
      }
    }
    if ('digestSchedule' in body) {
      if (typeof body.digestSchedule !== 'string') {
        errors.push('digestSchedule must be a string');
      } else {
        existing.digestSchedule = body.digestSchedule;
        digestUrlOnly = false;
      }
    }
    if ('alerts' in body) {
      const alertsBody = body.alerts as Record<string, unknown> | undefined;
      const personal = alertsBody?.['personal'] as Record<string, unknown> | undefined;
      if (personal) {
        const existingAlerts = (existing.alerts ?? {}) as Record<string, unknown>;
        const existingPersonal = (existingAlerts['personal'] ?? {}) as Record<string, unknown>;
        if ('dailyCostUsd' in personal) {
          if (typeof personal.dailyCostUsd !== 'number' || personal.dailyCostUsd < 0) {
            errors.push('alerts.personal.dailyCostUsd must be a non-negative number');
          } else {
            existingPersonal.dailyCostUsd = personal.dailyCostUsd;
          }
        }
        if ('sessionCostUsd' in personal) {
          if (typeof personal.sessionCostUsd !== 'number' || personal.sessionCostUsd < 0) {
            errors.push('alerts.personal.sessionCostUsd must be a non-negative number');
          } else {
            existingPersonal.sessionCostUsd = personal.sessionCostUsd;
          }
        }
        if ('efficiencyScoreMin' in personal) {
          if (
            typeof personal.efficiencyScoreMin !== 'number' ||
            personal.efficiencyScoreMin < 0 ||
            personal.efficiencyScoreMin > 1
          ) {
            errors.push('alerts.personal.efficiencyScoreMin must be 0-1');
          } else {
            existingPersonal.efficiencyScoreMin = personal.efficiencyScoreMin;
          }
        }
        if ('stuckLoopCountMax' in personal) {
          if (
            !Number.isInteger(personal.stuckLoopCountMax) ||
            (personal.stuckLoopCountMax as number) < 0
          ) {
            errors.push('alerts.personal.stuckLoopCountMax must be a non-negative integer');
          } else {
            existingPersonal.stuckLoopCountMax = personal.stuckLoopCountMax;
          }
        }
        if ('antiPatternCountMax' in personal) {
          if (
            !Number.isInteger(personal.antiPatternCountMax) ||
            (personal.antiPatternCountMax as number) < 0
          ) {
            errors.push('alerts.personal.antiPatternCountMax must be a non-negative integer');
          } else {
            existingPersonal.antiPatternCountMax = personal.antiPatternCountMax;
          }
        }
        existingAlerts['personal'] = existingPersonal;
        existing.alerts = existingAlerts;
        digestUrlOnly = false;
      }
    }

    if (errors.length > 0) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'validation_failed', errors }));
      return;
    }

    writeFileSync(deps.configFilePath, JSON.stringify(existing, null, 2), { mode: 0o600 });
    jsonOk(res, { ok: true, restartRequired: !digestUrlOnly });
  });

  routes.set('POST /api/digest/send', async (_req, res) => {
    if (!deps.weeklySummaryGenerator || !deps.configFilePath) return unavailable(res, 'digest');
    const result = await handleSendDigest(
      deps.weeklySummaryGenerator as unknown as WeeklySummaryGenerator,
      deps.configFilePath,
    );
    jsonOk(res, result);
  });

  return async (req, res) => {
    try {
      const path = (req.url ?? '/').split('?')[0] ?? '/';
      const key = `${req.method ?? 'GET'} ${path}`;
      const fn = routes.get(key);
      if (fn) {
        await fn(req, res);
        return;
      }

      // Try dynamic routes
      const replayMatch = /^\/api\/sessions\/([A-Za-z0-9_-]{1,128})\/replay$/.exec(path);
      if (req.method === 'GET' && replayMatch) {
        const sessionId = replayMatch[1]!;
        const replay = buildReplayResponse(sessionId, deps);
        if (replay === null) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'no_replay_data' }));
          return;
        }
        jsonOk(res, replay);
        return;
      }

      const sessionIdMatch = /^\/api\/sessions\/([A-Za-z0-9_-]{1,128})$/.exec(path);
      if (req.method === 'GET' && sessionIdMatch) {
        const sessionId = sessionIdMatch[1]!;
        if (!deps.sessionStore) return unavailable(res, 'sessionStore');
        const session = deps.sessionStore.loadSession(sessionId);
        if (session != null) {
          jsonOk(res, session);
          return;
        }
        // Not persisted — check if it's the current live session
        if (deps.sessionTracker) {
          const live = deps.sessionTracker.getMetrics();
          if (live.sessionId === sessionId) {
            const costMetrics = deps.costTracker?.getMetrics();
            const costUsd = costMetrics?.sessionTotalCostUsd ?? null;
            const model = costMetrics?.model ?? null;
            const antiPatterns = deps.antiPatternDetector
              ? (deps.antiPatternDetector.getCurrentPatterns() as Array<{
                  type: string;
                  count: number;
                }>)
              : [];
            jsonOk(res, {
              sessionId: live.sessionId,
              sessionName: live.sessionName ?? null,
              startTime: live.sessionStartTime,
              durationMs: live.sessionDurationMs,
              toolCallCount: live.toolCallCount,
              estimatedCostUsd: costUsd,
              model,
              outcome: 'in progress',
              toolBreakdown: live.toolCallCountByTool,
              antiPatterns,
              // Use the same `timeline` shape as persisted sessions so the
              // Sessions and Replay views can consume one type. See
              // src/storage/types.ts ReplayTimelineEntry.
              timeline: live.toolCallTimeline.map((t) => ({
                timestamp: t.timestamp,
                toolName: t.toolName,
                durationMs: t.durationMs,
                success: t.success ?? true,
              })),
            });
            return;
          }
        }
        // Concurrent live session tracked by the registry but not this server's
        // own session — synthesize from tool call buffer records.
        if (deps.liveSessionRegistry?.getLiveSessions().includes(sessionId)) {
          const allRecords = deps.toolCallBuffer?.getRecords() ?? [];
          const records = allRecords.filter(
            (r) => (r as { sessionId?: string | null }).sessionId === sessionId,
          );
          const timeline = records
            .map((r) => ({
              timestamp: r.timestamp,
              toolName: r.toolName,
              durationMs: r.durationMs ?? null,
              success: r.success,
              filePath: r.filePath ? redactSensitive(String(r.filePath)) : undefined,
              command: r.command ? redactSensitive(String(r.command)) : undefined,
            }))
            .sort((a, b) => a.timestamp - b.timestamp);
          const breakdown: Record<string, number> = Object.create(null);
          for (const r of records) {
            breakdown[r.toolName] = (breakdown[r.toolName] ?? 0) + 1;
          }
          const startTime = timeline.length > 0 ? timeline[0]!.timestamp : Date.now();
          const lastTs = timeline.length > 0 ? timeline[timeline.length - 1]!.timestamp : startTime;
          jsonOk(res, {
            sessionId,
            sessionName: deps.liveSessionRegistry.getSessionName(sessionId),
            startTime,
            durationMs: lastTs - startTime,
            toolCallCount: records.length,
            estimatedCostUsd: null,
            model: null,
            outcome: 'in progress',
            toolBreakdown: breakdown,
            antiPatterns: [],
            timeline,
          });
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    } catch (err) {
      const logger = (await import('../../shared/index.js')).createLogger('api-handler');
      logger.error('Unhandled error in API route handler', { error: String(err) });
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal_error' }));
      }
    }
  };
}
