import { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
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
    listSessions: (opts?: { since?: Date; developer?: string }) => unknown[];
    loadSession: (id: string) => unknown | null;
    loadAllSessions?: (opts?: {
      since?: Date;
      developer?: string;
    }) => readonly SessionLikeForCostOutcome[];
  };
  readonly costTracker?: {
    getMetrics: () => { sessionTotalCostUsd?: number | null; model?: string | null };
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
  };
  readonly concurrencyTracker?: {
    getConcurrentCount: () => number;
    getPeakConcurrent: () => number;
    getConcurrencyTimeSeries: () => readonly { timestamp: number; count: number }[];
  };
  readonly contextTracker?: { getMetrics: (sessionId?: string) => unknown };
  readonly config?: McpServerConfig;
  readonly configFilePath?: string;
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

function computeHourlyConcurrency(
  sessions: readonly unknown[],
): Array<{ timestamp: number; count: number }> {
  const now = Date.now();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const startMs = startOfDay.getTime();

  // Build activity windows from actual tool call timestamps
  const events: Array<{ ts: number; delta: number }> = [];
  for (const s of sessions) {
    const session = s as { timeline?: readonly { timestamp: number }[] };
    if (!session.timeline || session.timeline.length === 0) continue;

    const windows = mergeActivityWindows(session.timeline);

    for (const w of windows) {
      events.push({ ts: w.start, delta: 1 }, { ts: w.end, delta: -1 });
    }
  }

  if (events.length === 0) return [];
  events.sort((a, b) => a.ts - b.ts || b.delta - a.delta);

  // Compute peak concurrent within each 30-min window
  const windowMs = 1_800_000; // 30 minutes
  const currentWindow = Math.floor((now - startMs) / windowMs);
  const peaks = new Array<number>(currentWindow + 1).fill(0);

  let concurrent = 0;
  for (const e of events) {
    concurrent += e.delta;
    if (e.ts >= startMs) {
      const windowIdx = Math.min(Math.floor((e.ts - startMs) / windowMs), currentWindow);
      if (concurrent > peaks[windowIdx]!) {
        peaks[windowIdx] = concurrent;
      }
    }
  }

  return peaks.map((count, i) => ({
    timestamp: startMs + i * windowMs,
    count,
  }));
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

  return null;
}

export function createApiHandler(
  deps: ApiHandlerDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const routes = new Map<string, RouteFn>();

  routes.set('GET /api/session/current', (_req, res) => {
    if (!deps.sessionTracker) return unavailable(res, 'sessionTracker');
    // F-050: surface the rolling efficiency score as a sibling field so the
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
    const withActivity = (allSessions as unknown[]).filter(
      (s) => ((s as { toolCallCount?: number }).toolCallCount ?? 0) > 0,
    );
    const sliced = withActivity.slice(-limit);

    // Append the current live session so it appears in the list before shutdown
    if (deps.sessionTracker) {
      const live = deps.sessionTracker.getMetrics();
      const alreadyPersisted = sliced.some(
        (s) => (s as { sessionId?: string }).sessionId === live.sessionId,
      );
      if (!alreadyPersisted && live.toolCallCount > 0) {
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
          sliced.push({
            sessionId: id,
            sessionName: deps.liveSessionRegistry.getSessionName(id),
            startTime: stats?.firstTs ?? Date.now(),
            durationMs: stats ? stats.lastTs - stats.firstTs : 0,
            toolCallCount: stats?.count ?? 0,
            estimatedCostUsd: null,
          });
        }
      }
    }

    jsonOk(res, sliced.length > limit ? sliced.slice(-limit) : sliced);
  });

  routes.set('GET /api/cost', (_req, res) => {
    if (!deps.costTracker) return unavailable(res, 'costTracker');
    const cost = deps.costTracker.getMetrics();
    const forecast = deps.costForecast?.() ?? null;
    jsonOk(res, { cost, forecast });
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
    // Fixed limit (50) for v1.1 — matches the dashboard panel cap.
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
      const hourlySeries = computeHourlyConcurrency(todaySessions);

      const url = new URL(req.url ?? '/', 'http://localhost');
      const view = url.searchParams.get('view');
      if (view === 'history') {
        const daysParam = url.searchParams.get('days');
        const days = daysParam ? Math.min(Math.max(parseInt(daysParam, 10) || 30, 1), 90) : 30;
        const since = new Date();
        since.setDate(since.getDate() - days);
        since.setHours(0, 0, 0, 0);
        const allSessions = deps.sessionStore?.loadAllSessions?.({ since }) ?? [];
        const dailyPeaks = computeDailyPeakConcurrency(allSessions, days);
        jsonOk(res, { dailyPeaks });
        return;
      }

      const allSessions = deps.sessionStore?.loadAllSessions?.() ?? [];
      const allTimePeak = computeTodayPeakConcurrency(allSessions);

      jsonOk(res, {
        current: deps.concurrencyTracker.getConcurrentCount(),
        peak: Math.max(livePeak, historicalPeak),
        allTimePeak: Math.max(livePeak, historicalPeak, allTimePeak),
        timeSeries: hourlySeries,
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
        const startOfDay = new Date(now);
        startOfDay.setHours(0, 0, 0, 0);
        const startMs = startOfDay.getTime();
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
