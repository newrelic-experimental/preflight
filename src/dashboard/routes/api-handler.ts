import { IncomingMessage, ServerResponse } from 'node:http';
import { redactSensitive } from '../../config.js';
import {
  attributeSessionCosts,
  type SessionLikeForCostOutcome,
} from '../../metrics/cost-per-outcome.js';

interface RawAuditRecord {
  readonly timestamp: number;
  readonly sessionId: string | null;
  readonly action: string;
  readonly tool: string;
  readonly detail: string;
  readonly developer: string;
  readonly filePath?: string;
  readonly command?: string;
  readonly securityAlert?: unknown;
}

// Strip secret-bearing substrings from an audit record before it crosses the
// HTTP boundary. Mirrors the redaction applied to NR audit events in
// auditRecordToNrEvent so /api/audit doesn't leak raw filePath/command tokens.
function redactAuditRecord(entry: unknown): unknown {
  if (entry == null || typeof entry !== 'object') return entry;
  const r = entry as RawAuditRecord;
  return {
    ...r,
    detail: typeof r.detail === 'string' ? redactSensitive(r.detail) : r.detail,
    ...(r.filePath != null ? { filePath: redactSensitive(r.filePath) } : {}),
    ...(r.command != null ? { command: redactSensitive(r.command) } : {}),
  };
}

export interface ApiHandlerDeps {
  readonly sessionTracker?: { getMetrics: () => unknown };
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
  readonly weeklySummaryGenerator?: { loadRecentWeeks: (count: number) => unknown[] };
  readonly budgetTracker?: { getStatus: () => unknown };
  readonly latencyTracker?: { getMetrics: () => unknown };
  readonly personalCoach?: { generate: () => unknown };
  readonly alertLog?: { readRecent: (limit: number) => Promise<readonly unknown[]> };
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
  res.writeHead(503, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'unavailable', what }));
}

export function createApiHandler(deps: ApiHandlerDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const routes = new Map<string, RouteFn>();

  routes.set('GET /api/session/current', (_req, res) => {
    if (!deps.sessionTracker) return unavailable(res, 'sessionTracker');
    jsonOk(res, deps.sessionTracker.getMetrics());
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
    const allSessions = deps.sessionStore.loadAllSessions?.() ?? deps.sessionStore.listSessions();
    const sliced = allSessions.slice(-limit);
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
    jsonOk(res, log.map(redactAuditRecord));
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

  return async (req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const key = `${req.method ?? 'GET'} ${path}`;
    const fn = routes.get(key);
    if (fn) {
      await fn(req, res);
      return;
    }

    // Try dynamic routes
    const sessionIdMatch = /^\/api\/sessions\/([A-Za-z0-9_-]{1,128})$/.exec(path);
    if (req.method === 'GET' && sessionIdMatch) {
      const sessionId = sessionIdMatch[1]!;
      if (!deps.sessionStore) return unavailable(res, 'sessionStore');
      const session = deps.sessionStore.loadSession(sessionId);
      if (session === null) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }
      jsonOk(res, session);
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  };
}
