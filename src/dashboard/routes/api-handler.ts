import { IncomingMessage, ServerResponse } from 'node:http';
import { redactSensitive } from '../../config.js';
import {
  attributeSessionCosts,
  type SessionLikeForCostOutcome,
} from '../../metrics/cost-per-outcome.js';
import { getIsoWeekId } from '../../storage/weekly-summary.js';
import { analyzeReplayTimeline } from './replay-analyzer.js';
import type { ReplayTimelineEntry, ToolCallRecord } from '../../storage/types.js';

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
  }>;
}

export interface ApiHandlerDeps {
  readonly sessionTracker?: { getMetrics: () => LiveSessionMetrics };
  readonly sessionStore?: {
    loadTodaySessions: () => unknown[];
    listSessions: (opts?: { since?: Date; developer?: string }) => unknown[];
    loadSession: (id: string) => unknown | null;
    loadAllSessions?: (opts?: { since?: Date; developer?: string }) => readonly SessionLikeForCostOutcome[];
  };
  readonly costTracker?: { getMetrics: () => { sessionTotalCostUsd?: number | null } };
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
  readonly qualityProxyTracker?: { getMetrics: () => unknown };
  readonly toolSelectionScorer?: { scoreSession: (calls: readonly ToolCallRecord[]) => unknown };
  readonly toolCallBuffer?: { getRecords: () => readonly ToolCallRecord[] };
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
      const timeline = session['timeline'] as ReplayTimelineEntry[];
      const analysis = analyzeReplayTimeline(timeline);
      return { sessionId, timeline, segments: analysis.segments, worstSegment: analysis.worstSegment };
    }
  }

  // Try live session from TaskDetector
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
    if (allCalls.length > 0) {
      allCalls.sort((a, b) => a.timestamp - b.timestamp);
      const timeline = allCalls.map(toolCallToTimelineEntry);
      const analysis = analyzeReplayTimeline(timeline);
      return { sessionId, timeline, segments: analysis.segments, worstSegment: analysis.worstSegment };
    }
  }

  return null;
}

export function createApiHandler(deps: ApiHandlerDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const routes = new Map<string, RouteFn>();

  routes.set('GET /api/session/current', (_req, res) => {
    if (!deps.sessionTracker) return unavailable(res, 'sessionTracker');
    // F-050: surface the rolling efficiency score as a sibling field so the
    // SPA Today KPI can render it without a second round-trip. `null` when
    // no tasks have been scored yet (or when the scorer wasn't wired in).
    const efficiencyScore = deps.efficiencyScorer?.getSessionAverage()?.score ?? null;
    jsonOk(res, { ...deps.sessionTracker.getMetrics(), efficiencyScore });
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
          startTime: live.sessionStartTime,
          durationMs: live.sessionDurationMs,
          toolCallCount: live.toolCallCount,
          estimatedCostUsd: deps.costTracker?.getMetrics().sessionTotalCostUsd ?? null,
        });
      }
    }

    jsonOk(res, sliced);
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
    try { deps.weeklySummaryGenerator.generate(getIsoWeekId(new Date())); } catch { /* best-effort */ }
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
    if (!deps.sessionStore?.loadAllSessions) return unavailable(res, 'sessionStore.loadAllSessions');
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
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal', detail: String(err) }));
    }
  });

  routes.set('GET /api/quality-proxy', (_req, res) => {
    if (!deps.qualityProxyTracker) return unavailable(res, 'qualityProxyTracker');
    jsonOk(res, deps.qualityProxyTracker.getMetrics());
  });

  routes.set('GET /api/tool-selection-score', (_req, res) => {
    if (!deps.toolSelectionScorer) return unavailable(res, 'toolSelectionScorer');
    const calls = deps.toolCallBuffer?.getRecords() ?? [];
    jsonOk(res, deps.toolSelectionScorer.scoreSession(calls));
  });

  return async (req, res) => {
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
      if (session !== null) {
        jsonOk(res, session);
        return;
      }
      // Not persisted — check if it's the current live session
      if (deps.sessionTracker) {
        const live = deps.sessionTracker.getMetrics();
        if (live.sessionId === sessionId) {
          const costUsd = deps.costTracker?.getMetrics().sessionTotalCostUsd ?? null;
          const antiPatterns = deps.antiPatternDetector
            ? (deps.antiPatternDetector.getCurrentPatterns() as Array<{ type: string; count: number }>)
            : [];
          jsonOk(res, {
            sessionId: live.sessionId,
            startTime: live.sessionStartTime,
            durationMs: live.sessionDurationMs,
            toolCallCount: live.toolCallCount,
            estimatedCostUsd: costUsd,
            toolBreakdown: live.toolCallCountByTool,
            antiPatterns,
            // Use the same `timeline` shape as persisted sessions so the
            // Sessions and Replay views can consume one type. See
            // src/storage/types.ts ReplayTimelineEntry.
            timeline: live.toolCallTimeline.map((t) => ({
              timestamp: t.timestamp,
              toolName: t.toolName,
              durationMs: t.durationMs,
              success: true,
            })),
          });
          return;
        }
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  };
}
