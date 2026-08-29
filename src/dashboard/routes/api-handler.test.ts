import { jest } from '@jest/globals';
import {
  createApiHandler,
  computeCrossProcessLiveSessionIds,
  buildContextReplayEvents,
} from './api-handler.js';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getIsoWeekId } from '../../storage/weekly-summary.js';
import {
  ToolSelectionScorer,
  toToolSelectionSummary,
} from '../../metrics/tool-selection-scorer.js';
import { ModelUsageTracker } from '../../metrics/model-usage-tracker.js';
import { QualityProxyTracker } from '../../metrics/quality-proxy-tracker.js';
import { localStartOfDay, localDateKey } from '../../lib/date.js';

import type { ToolCallRecord } from '../../storage/types.js';

jest.mock('../../install/diagnostics.js', () => ({
  runDiagnostics: jest.fn(async () => [
    { check: 'Config valid', status: 'ok', detail: 'ok', fix: undefined },
  ]),
}));

function fakeRes(): {
  res: ServerResponse;
  status: () => number;
  body: () => string;
  headers: () => Record<string, string>;
} {
  let status = 0;
  let body = '';
  const headers: Record<string, string> = {};
  const res = {
    writeHead: (s: number, h?: Record<string, string>) => {
      status = s;
      if (h) Object.assign(headers, h);
    },
    setHeader: (k: string, v: string) => {
      headers[k.toLowerCase()] = v;
    },
    end: (chunk?: string | Buffer) => {
      if (chunk) body += chunk.toString();
    },
    headersSent: false,
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => body, headers: () => headers };
}

describe('api-handler GET /api/session/current', () => {
  it('returns sessionTracker.getMetrics() with efficiencyScore: null when scorer is absent', async () => {
    const fake = { id: 'sess-1', toolCallCount: 5 };
    const handler = createApiHandler({
      sessionTracker: { getMetrics: () => fake } as unknown as Parameters<
        typeof createApiHandler
      >[0]['sessionTracker'],
    });
    const req = { method: 'GET', url: '/api/session/current' } as IncomingMessage;
    const { res, status, body, headers } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(headers()['content-type']).toMatch(/application\/json/);
    expect(JSON.parse(body())).toEqual({ ...fake, efficiencyScore: null, liveSessions: [] });
  });

  it('includes efficiencyScore from getSessionAverage() when scorer is wired in', async () => {
    const fake = { id: 'sess-2', toolCallCount: 7 };
    const handler = createApiHandler({
      sessionTracker: { getMetrics: () => fake } as unknown as Parameters<
        typeof createApiHandler
      >[0]['sessionTracker'],
      efficiencyScorer: { getSessionAverage: () => ({ score: 0.78 }) },
    });
    const req = { method: 'GET', url: '/api/session/current' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(JSON.parse(body())).toEqual({ ...fake, efficiencyScore: 0.78, liveSessions: [] });
  });

  it('keeps efficiencyScore null when scorer returns null (no tasks scored yet)', async () => {
    const fake = { id: 'sess-3', toolCallCount: 0 };
    const handler = createApiHandler({
      sessionTracker: { getMetrics: () => fake } as unknown as Parameters<
        typeof createApiHandler
      >[0]['sessionTracker'],
      efficiencyScorer: { getSessionAverage: () => null },
    });
    const req = { method: 'GET', url: '/api/session/current' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(JSON.parse(body())).toEqual({ ...fake, efficiencyScore: null, liveSessions: [] });
  });

  it('includes a session live only in another process (via localStore buffer) in liveSessions', async () => {
    const fake = { id: 'sess-cross-process', toolCallCount: 2 };
    const now = Date.now();
    const handler = createApiHandler({
      sessionTracker: { getMetrics: () => fake } as unknown as Parameters<
        typeof createApiHandler
      >[0]['sessionTracker'],
      liveSessionRegistry: {
        getLiveSessions: () => [],
        getSessionName: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['liveSessionRegistry'],
      localStore: {
        peekAllBuffers: () => [
          { mode: 'post', sessionId: 'other-process-session', timestamp: now - 1_000 },
        ],
      } as unknown as Parameters<typeof createApiHandler>[0]['localStore'],
    });
    const req = { method: 'GET', url: '/api/session/current' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as { liveSessions: string[] };
    expect(parsed.liveSessions).toContain('other-process-session');
  });

  it('returns 503 with { error, what } body when sessionTracker is missing', async () => {
    const handler = createApiHandler({});
    const req = { method: 'GET', url: '/api/session/current' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(503);
    expect(JSON.parse(body())).toEqual({ error: 'unavailable', what: 'sessionTracker' });
  });

  it('returns 404 for unknown /api/* routes', async () => {
    const handler = createApiHandler({});
    const req = { method: 'GET', url: '/api/unknown' } as IncomingMessage;
    const { res, status } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(404);
  });
});

describe('api-handler GET /api/session/today', () => {
  it('returns today sessions as JSON array', async () => {
    const fakeToday = [
      { sessionId: 'sess-1', startTime: Date.now() - 1000, toolCallCount: 5 },
      { sessionId: 'sess-2', startTime: Date.now() - 2000, toolCallCount: 3 },
    ];
    const handler = createApiHandler({
      sessionStore: {
        loadTodaySessions: () => fakeToday,
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/session/today' } as IncomingMessage;
    const { res, status, body, headers } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(headers()['content-type']).toMatch(/application\/json/);
    expect(JSON.parse(body())).toEqual(fakeToday);
  });

  it('returns 503 when sessionStore is missing', async () => {
    const handler = createApiHandler({});
    const req = { method: 'GET', url: '/api/session/today' } as IncomingMessage;
    const { res, status } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(503);
  });
});

describe('api-handler GET /api/sessions', () => {
  it('returns list of sessions as JSON array, sliced by limit', async () => {
    const fakeSessions = Array.from({ length: 100 }, (_v, i) => ({
      filename: `2026-05-${String(i + 1).padStart(2, '0')}_sess-${i}.json`,
      sessionId: `sess-${i}`,
      date: `2026-05-${String(i + 1).padStart(2, '0')}`,
      toolCallCount: i + 1,
    }));
    const handler = createApiHandler({
      sessionStore: {
        loadTodaySessions: () => [],
        listSessions: () => fakeSessions,
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/sessions?limit=10' } as IncomingMessage;
    const { res, status, body, headers } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(headers()['content-type']).toMatch(/application\/json/);
    const result = JSON.parse(body());
    expect(result).toHaveLength(10);
    expect(result[0].sessionId).toBe('sess-90'); // Most recent (highest index)
  });

  it('uses default limit of 50 when not specified', async () => {
    const fakeSessions = Array.from({ length: 100 }, (_v, i) => ({
      filename: `2026-05-${String(i + 1).padStart(2, '0')}_sess-${i}.json`,
      sessionId: `sess-${i}`,
      date: `2026-05-${String(i + 1).padStart(2, '0')}`,
      toolCallCount: i + 1,
    }));
    const handler = createApiHandler({
      sessionStore: {
        loadTodaySessions: () => [],
        listSessions: () => fakeSessions,
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/sessions' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const result = JSON.parse(body());
    expect(result).toHaveLength(50);
  });

  it('caps limit at 500', async () => {
    const fakeSessions = Array.from({ length: 600 }, (_v, i) => ({
      filename: `2026-05-${String((i % 30) + 1).padStart(2, '0')}_sess-${i}.json`,
      sessionId: `sess-${i}`,
      date: `2026-05-${String((i % 30) + 1).padStart(2, '0')}`,
      toolCallCount: i + 1,
    }));
    const handler = createApiHandler({
      sessionStore: {
        loadTodaySessions: () => [],
        listSessions: () => fakeSessions,
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/sessions?limit=9999' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const result = JSON.parse(body());
    expect(result).toHaveLength(500);
  });

  it('treats invalid limit as default 50', async () => {
    const fakeSessions = Array.from({ length: 100 }, (_v, i) => ({
      filename: `2026-05-${String(i + 1).padStart(2, '0')}_sess-${i}.json`,
      sessionId: `sess-${i}`,
      date: `2026-05-${String(i + 1).padStart(2, '0')}`,
      toolCallCount: i + 1,
    }));
    const handler = createApiHandler({
      sessionStore: {
        loadTodaySessions: () => [],
        listSessions: () => fakeSessions,
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/sessions?limit=abc' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const result = JSON.parse(body());
    expect(result).toHaveLength(50);
  });

  it('returns 503 when sessionStore is missing', async () => {
    const handler = createApiHandler({});
    const req = { method: 'GET', url: '/api/sessions' } as IncomingMessage;
    const { res, status } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(503);
  });

  it('uses loadAllSessions for /api/sessions list when available', async () => {
    const fakeSessions = Array.from({ length: 5 }, (_v, i) => ({
      sessionId: `sess-${i}`,
      startTime: Date.now(),
      toolCallCount: i + 1,
    }));
    const listSessionsSpy = jest.fn(() => []);
    const loadAllSessionsSpy = jest.fn(() => fakeSessions);
    const handler = createApiHandler({
      sessionStore: {
        loadTodaySessions: () => [],
        listSessions: listSessionsSpy,
        loadAllSessions: loadAllSessionsSpy,
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/sessions' } as IncomingMessage;
    const { res, status } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(loadAllSessionsSpy).toHaveBeenCalled();
    expect(listSessionsSpy).not.toHaveBeenCalled();
  });

  // The live-session stub appended for the current process's own
  // in-progress session (not yet persisted to disk) must carry its real
  // model, sourced from costTracker.getMetrics().model, so
  // aggregateModelPerformance (History.tsx) doesn't bucket it under
  // "unknown" while the session is still running.
  it('carries the real model on the live-session stub', async () => {
    const handler = createApiHandler({
      sessionStore: {
        loadTodaySessions: () => [],
        listSessions: () => [],
        loadAllSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
      sessionTracker: {
        getMetrics: () => ({
          sessionId: 'live-session-with-model',
          sessionName: null,
          sessionStartTime: 1000,
          sessionDurationMs: 500,
          toolCallCount: 3,
          toolCallCountByTool: { Read: 3 },
          uniqueFilesRead: 1,
          uniqueFilesWritten: 0,
          toolCallTimeline: [],
        }),
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionTracker'],
      costTracker: {
        getMetrics: () => ({
          sessionTotalCostUsd: 0.42,
          model: 'claude-sonnet-4-20250514',
        }),
      } as unknown as Parameters<typeof createApiHandler>[0]['costTracker'],
    });
    const req = { method: 'GET', url: '/api/sessions' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const result = JSON.parse(body()) as Array<{ sessionId: string; model: string | null }>;
    const live = result.find((s) => s.sessionId === 'live-session-with-model');
    expect(live).toBeDefined();
    expect(live?.model).toBe('claude-sonnet-4-20250514');
  });

  it('defaults model to null on the live-session stub when costTracker has none', async () => {
    const handler = createApiHandler({
      sessionStore: {
        loadTodaySessions: () => [],
        listSessions: () => [],
        loadAllSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
      sessionTracker: {
        getMetrics: () => ({
          sessionId: 'live-session-no-model',
          sessionName: null,
          sessionStartTime: 1000,
          sessionDurationMs: 500,
          toolCallCount: 3,
          toolCallCountByTool: { Read: 3 },
          uniqueFilesRead: 1,
          uniqueFilesWritten: 0,
          toolCallTimeline: [],
        }),
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionTracker'],
    });
    const req = { method: 'GET', url: '/api/sessions' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const result = JSON.parse(body()) as Array<{ sessionId: string; model: string | null }>;
    const live = result.find((s) => s.sessionId === 'live-session-no-model');
    expect(live).toBeDefined();
    expect(live?.model ?? null).toBeNull();
  });

  it('injects a stub row for a session live only in another process', async () => {
    const now = Date.now();
    const handler = createApiHandler({
      sessionStore: {
        loadTodaySessions: () => [],
        listSessions: () => [],
        loadAllSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
      liveSessionRegistry: {
        getLiveSessions: () => [],
        getLastActivity: () => null,
        getSessionName: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['liveSessionRegistry'],
      localStore: {
        peekAllBuffers: () => [
          { mode: 'post', sessionId: 'other-process-session', timestamp: now - 1_000 },
        ],
      } as unknown as Parameters<typeof createApiHandler>[0]['localStore'],
    });
    const req = { method: 'GET', url: '/api/sessions' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const result = JSON.parse(body()) as Array<{ sessionId: string }>;
    expect(result.some((s) => s.sessionId === 'other-process-session')).toBe(true);
  });
});

describe('api-handler GET /api/sessions/:id', () => {
  it('returns session details when found', async () => {
    const fakeSession = {
      sessionId: 'sess-abc-123',
      startTime: Date.now() - 5000,
      toolCallCount: 10,
      developer: 'alice',
    };
    const handler = createApiHandler({
      sessionStore: {
        loadTodaySessions: () => [],
        listSessions: () => [],
        loadSession: (id: string) => (id === 'sess-abc-123' ? fakeSession : null),
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/sessions/sess-abc-123' } as IncomingMessage;
    const { res, status, body, headers } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(headers()['content-type']).toMatch(/application\/json/);
    expect(JSON.parse(body())).toEqual(fakeSession);
  });

  it('returns 404 with error when session not found', async () => {
    const handler = createApiHandler({
      sessionStore: {
        loadTodaySessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/sessions/nonexistent' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(404);
    expect(JSON.parse(body())).toEqual({ error: 'not_found' });
  });

  it('returns 503 when sessionStore is missing', async () => {
    const handler = createApiHandler({});
    const req = { method: 'GET', url: '/api/sessions/sess-123' } as IncomingMessage;
    const { res, status } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(503);
  });

  it('rejects invalid session IDs with 404', async () => {
    const handler = createApiHandler({
      sessionStore: {
        loadTodaySessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/sessions/../../etc/passwd' } as IncomingMessage;
    const { res, status } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(404);
  });

  it('returns an in-progress shell instead of 404 for a session live only in another process', async () => {
    const now = Date.now();
    const handler = createApiHandler({
      sessionStore: {
        loadTodaySessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
      liveSessionRegistry: {
        getLiveSessions: () => [],
        getSessionName: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['liveSessionRegistry'],
      localStore: {
        peekAllBuffers: () => [
          { mode: 'post', sessionId: 'other-process-session', timestamp: now - 1_000 },
        ],
      } as unknown as Parameters<typeof createApiHandler>[0]['localStore'],
    });
    const req = {
      method: 'GET',
      url: '/api/sessions/other-process-session',
    } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as { sessionId: string; outcome: string };
    expect(parsed.sessionId).toBe('other-process-session');
    expect(parsed.outcome).toBe('in progress');
  });

  it('includes modelBreakdown for the current live session when modelUsageTracker is present', async () => {
    const tracker = new ModelUsageTracker();
    tracker.recordUsage('claude-sonnet-5', 1000, 500, 3.2);
    tracker.recordUsage('claude-opus-5', 200, 100, 1.5);
    const handler = createApiHandler({
      sessionStore: {
        loadTodaySessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
      sessionTracker: {
        getMetrics: () =>
          ({
            sessionId: 'sess-live-1',
            sessionName: null,
            sessionNameSource: null,
            sessionStartTime: Date.now() - 1_000,
            sessionDurationMs: 1_000,
            toolCallCount: 2,
            toolCallCountByTool: {},
            toolCallTimeline: [],
          }) as unknown as ReturnType<
            NonNullable<Parameters<typeof createApiHandler>[0]['sessionTracker']>['getMetrics']
          >,
      },
      modelUsageTracker: tracker,
    });
    const req = { method: 'GET', url: '/api/sessions/sess-live-1' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as { modelBreakdown: unknown };
    expect(parsed.modelBreakdown).toEqual(tracker.getRawBreakdown());
    expect(Object.keys(parsed.modelBreakdown as object)).toEqual([
      'claude-sonnet-5',
      'claude-opus-5',
    ]);
  });

  it('omits modelBreakdown for the current live session when modelUsageTracker is absent', async () => {
    const handler = createApiHandler({
      sessionStore: {
        loadTodaySessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
      sessionTracker: {
        getMetrics: () =>
          ({
            sessionId: 'sess-live-2',
            sessionName: null,
            sessionNameSource: null,
            sessionStartTime: Date.now() - 1_000,
            sessionDurationMs: 1_000,
            toolCallCount: 0,
            toolCallCountByTool: {},
            toolCallTimeline: [],
          }) as unknown as ReturnType<
            NonNullable<Parameters<typeof createApiHandler>[0]['sessionTracker']>['getMetrics']
          >,
      },
    });
    const req = { method: 'GET', url: '/api/sessions/sess-live-2' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as { modelBreakdown?: unknown };
    expect(parsed.modelBreakdown).toBeUndefined();
  });

  it('attaches qualityProxy (derived from persisted raw counts) to a persisted session with real signals', async () => {
    const fakeSession = {
      sessionId: 'sess-quality-1',
      qualityProxy: {
        totalSignals: 2,
        diffApplyCleanCount: 1,
        diffFailCount: 1,
        testPassCount: 0,
        testFailCount: 0,
        backtrackCount: 0,
        selfCorrectionCount: 0,
      },
    };
    const handler = createApiHandler({
      sessionStore: {
        loadTodaySessions: () => [],
        listSessions: () => [],
        loadSession: (id: string) => (id === 'sess-quality-1' ? fakeSession : null),
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/sessions/sess-quality-1' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as { qualityProxy?: { diffApplyRate: number | null } };
    expect(parsed.qualityProxy).toBeDefined();
    expect(parsed.qualityProxy?.diffApplyRate).toBeCloseTo(0.5);
  });

  it('does not attach qualityProxy to a persisted session with zero signals (regression guard)', async () => {
    const fakeSession = {
      sessionId: 'sess-abc-999',
      startTime: Date.now() - 5000,
      toolCallCount: 10,
    };
    const handler = createApiHandler({
      sessionStore: {
        loadTodaySessions: () => [],
        listSessions: () => [],
        loadSession: (id: string) => (id === 'sess-abc-999' ? fakeSession : null),
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/sessions/sess-abc-999' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(JSON.parse(body())).toEqual(fakeSession);
  });

  it('attaches qualityProxy and session-filtered toolSelectionScore to the own-live-session branch', async () => {
    const handler = createApiHandler({
      sessionStore: {
        loadTodaySessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
      sessionTracker: {
        getMetrics: () => ({
          sessionId: 'live1',
          sessionName: null,
          sessionStartTime: 1000,
          sessionDurationMs: 500,
          toolCallCount: 2,
          toolCallCountByTool: { Read: 2 },
          uniqueFilesRead: 1,
          uniqueFilesWritten: 0,
          toolCallTimeline: [],
        }),
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionTracker'],
      qualityProxyTracker: {
        getMetrics: () => ({
          totalSignals: 3,
          diffApplyRate: 1,
          testPassRate: null,
          backtrackCount: 0,
          selfCorrectionCount: 0,
          qualityByTurnBucket: [],
          degradationDetected: false,
          events: [],
        }),
        getRawCounts: () => ({
          totalSignals: 3,
          diffApplyCleanCount: 3,
          diffFailCount: 0,
          testPassCount: 0,
          testFailCount: 0,
          backtrackCount: 0,
          selfCorrectionCount: 0,
        }),
      },
      toolSelectionScorer: {
        scoreSession: (calls: readonly unknown[]) => ({
          score: 0.9,
          totalCalls: calls.length,
          penalizedCalls: 0,
          penalties: [],
          worstOffenders: [],
          redundantReadCount: calls.length,
          repeatedFailureCount: 0,
          unusedOutputCount: 0,
        }),
      } as unknown as Parameters<typeof createApiHandler>[0]['toolSelectionScorer'],
      toolCallBuffer: {
        getRecords: () => [
          {
            id: '1',
            sessionId: 'live1',
            toolName: 'Read',
            toolUseId: 'u1',
            timestamp: 1,
            durationMs: 1,
            success: true,
          },
          {
            id: '2',
            sessionId: 'other',
            toolName: 'Read',
            toolUseId: 'u2',
            timestamp: 2,
            durationMs: 1,
            success: true,
          },
        ],
      } as unknown as Parameters<typeof createApiHandler>[0]['toolCallBuffer'],
    });
    const req = { method: 'GET', url: '/api/sessions/live1' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as {
      qualityProxy?: { diffApplyRate: number | null };
      toolSelectionScore?: { score: number; redundantReadCount: number };
    };
    expect(parsed.qualityProxy?.diffApplyRate).toBe(1);
    // Only the 1 record belonging to 'live1' should have been scored, not the 'other' session's record.
    expect(parsed.toolSelectionScore?.redundantReadCount).toBe(1);
  });

  it('reports live-session anti-patterns as one entry per incident, preserving file/count detail', async () => {
    const handler = createApiHandler({
      sessionStore: {
        loadTodaySessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
      sessionTracker: {
        getMetrics: () => ({
          sessionId: 'live-anti',
          sessionName: null,
          sessionStartTime: 1000,
          sessionDurationMs: 500,
          toolCallCount: 3,
          toolCallCountByTool: { Read: 3 },
          uniqueFilesRead: 1,
          uniqueFilesWritten: 0,
          toolCallTimeline: [],
        }),
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionTracker'],
      antiPatternDetector: {
        getCurrentPatterns: () => [
          { type: 're_reading', file: '/a.ts', readCount: 4, suggestion: 'Consider breaking task' },
          { type: 're_reading', file: '/b.ts', readCount: 5, suggestion: 'Consider breaking task' },
          { type: 'thrashing', file: '/c.ts', iterations: 3, suggestion: 'Try different approach' },
        ],
      } as unknown as Parameters<typeof createApiHandler>[0]['antiPatternDetector'],
    });
    const req = { method: 'GET', url: '/api/sessions/live-anti' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as {
      antiPatterns?: Array<{
        type: string;
        file?: string;
        readCount?: number;
        iterations?: number;
      }>;
    };
    expect(parsed.antiPatterns).toEqual([
      { type: 're_reading', file: '/a.ts', readCount: 4 },
      { type: 're_reading', file: '/b.ts', readCount: 5 },
      { type: 'thrashing', file: '/c.ts', iterations: 3 },
    ]);
  });

  it('attaches toolSelectionScore, antiPatterns, and qualityProxy to the registry-synthesized branch', async () => {
    const handler = createApiHandler({
      sessionStore: {
        loadTodaySessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
      sessionTracker: {
        getMetrics: () => ({
          sessionId: 'mine',
          sessionName: null,
          sessionStartTime: 0,
          sessionDurationMs: 0,
          toolCallCount: 0,
          toolCallCountByTool: {},
          uniqueFilesRead: 0,
          uniqueFilesWritten: 0,
          toolCallTimeline: [],
        }),
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionTracker'],
      liveSessionRegistry: {
        getLiveSessions: () => ['concurrent1'],
        getSessionName: () => null,
      },
      toolSelectionScorer: {
        scoreSession: (calls: readonly unknown[]) => ({
          score: 0.5,
          redundantReadCount: 0,
          repeatedFailureCount: calls.length,
          unusedOutputCount: 0,
        }),
      } as unknown as Parameters<typeof createApiHandler>[0]['toolSelectionScorer'],
      toolCallBuffer: {
        // 3 consecutive failing `npm test` Bash calls on the same session:
        // enough to trip AntiPatternDetector's stuck_loop threshold AND to
        // produce 3 test_fail QualityProxyTracker signals. Both fields must
        // be computed from this branch's own filtered records, using
        // detector/tracker instances scoped to this one request — not a
        // shared, stateful instance owned by a different (this process's
        // own) session.
        getRecords: () => [
          {
            id: '1',
            sessionId: 'concurrent1',
            toolName: 'Bash',
            toolUseId: 'u1',
            timestamp: 1,
            durationMs: 1,
            success: false,
            command: 'npm test',
            isTestCommand: true,
          },
          {
            id: '2',
            sessionId: 'concurrent1',
            toolName: 'Bash',
            toolUseId: 'u2',
            timestamp: 2,
            durationMs: 1,
            success: false,
            command: 'npm test',
            isTestCommand: true,
          },
          {
            id: '3',
            sessionId: 'concurrent1',
            toolName: 'Bash',
            toolUseId: 'u3',
            timestamp: 3,
            durationMs: 1,
            success: false,
            command: 'npm test',
            isTestCommand: true,
          },
        ],
      } as unknown as Parameters<typeof createApiHandler>[0]['toolCallBuffer'],
    });
    const req = { method: 'GET', url: '/api/sessions/concurrent1' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as {
      qualityProxy?: { testPassRate: number | null };
      antiPatterns?: Array<{ type: string; repeatCount?: number }>;
      toolSelectionScore?: { repeatedFailureCount: number };
    };
    expect(parsed.toolSelectionScore?.repeatedFailureCount).toBe(3);
    expect(parsed.antiPatterns).toEqual([
      expect.objectContaining({ type: 'stuck_loop', repeatCount: 3 }),
    ]);
    expect(parsed.qualityProxy?.testPassRate).toBe(0);
  });

  it('leaves antiPatterns empty and qualityProxy absent on the registry-synthesized branch when there are no records to analyze', async () => {
    const handler = createApiHandler({
      sessionStore: {
        loadTodaySessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
      liveSessionRegistry: {
        getLiveSessions: () => ['concurrent-empty'],
        getSessionName: () => null,
      },
      toolCallBuffer: {
        getRecords: () => [],
      } as unknown as Parameters<typeof createApiHandler>[0]['toolCallBuffer'],
    });
    const req = { method: 'GET', url: '/api/sessions/concurrent-empty' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as { qualityProxy?: unknown; antiPatterns?: unknown[] };
    expect(parsed.antiPatterns).toEqual([]);
    expect(parsed.qualityProxy).toBeUndefined();
  });

  it("remaps a persisted session's toolSelectionMetrics onto toolSelectionScore", async () => {
    const fakeSession = {
      sessionId: 'sess-tool-selection-1',
      toolSelectionMetrics: {
        score: 0.75,
        totalCalls: 4,
        penalizedCalls: 1,
        redundantReadCount: 1,
        repeatedFailureCount: 0,
        unusedOutputCount: 0,
      },
    };
    const handler = createApiHandler({
      sessionStore: {
        loadTodaySessions: () => [],
        listSessions: () => [],
        loadSession: (id: string) => (id === 'sess-tool-selection-1' ? fakeSession : null),
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/sessions/sess-tool-selection-1' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as {
      toolSelectionScore?: { score: number; redundantReadCount: number };
    };
    expect(parsed.toolSelectionScore?.score).toBe(0.75);
    expect(parsed.toolSelectionScore?.redundantReadCount).toBe(1);
  });

  it('does not attach toolSelectionScore to a persisted session with no toolSelectionMetrics (regression guard)', async () => {
    const fakeSession = { sessionId: 'sess-no-tool-selection', toolCallCount: 3 };
    const handler = createApiHandler({
      sessionStore: {
        loadTodaySessions: () => [],
        listSessions: () => [],
        loadSession: (id: string) => (id === 'sess-no-tool-selection' ? fakeSession : null),
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/sessions/sess-no-tool-selection' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as { toolSelectionScore?: unknown };
    expect(parsed.toolSelectionScore).toBeUndefined();
  });

  // session.timeline is append-only in processing order, not timestamp
  // order — parallel tool calls can complete (and be pushed) in a different
  // order than they started. SessionActivityStrip reads timeline[0]/[-1] as
  // start/end assuming ascending order, so an unsorted response can produce
  // a negative durationMs and collapse the activity-density bucket count.
  it('sorts an out-of-order persisted session.timeline chronologically before returning it', async () => {
    const outOfOrderTimeline = [
      { timestamp: 300, toolName: 'Read', durationMs: 10, success: true },
      { timestamp: 100, toolName: 'Edit', durationMs: 20, success: true },
      { timestamp: 200, toolName: 'Bash', durationMs: 30, success: true },
    ];
    const handler = createApiHandler({
      sessionStore: {
        loadTodaySessions: () => [],
        listSessions: () => [],
        loadSession: (id: string) =>
          id === 'sess-detail' ? { sessionId: 'sess-detail', timeline: outOfOrderTimeline } : null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/sessions/sess-detail' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as { timeline: Array<{ timestamp: number }> };
    // Unsorted, this would equal [300, 100, 200] — the raw push order — so
    // timeline[0].timestamp (300) would be greater than timeline[-1].timestamp
    // (200), a negative apparent duration.
    expect(parsed.timeline.map((e) => e.timestamp)).toEqual([100, 200, 300]);
  });

  it('sorts an out-of-order own-live-session toolCallTimeline chronologically before returning it', async () => {
    const handler = createApiHandler({
      sessionStore: {
        loadTodaySessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
      sessionTracker: {
        getMetrics: () => ({
          sessionId: 'live-timeline',
          sessionName: null,
          sessionStartTime: 100,
          sessionDurationMs: 200,
          toolCallCount: 3,
          toolCallCountByTool: { Read: 3 },
          uniqueFilesRead: 1,
          uniqueFilesWritten: 0,
          // A later-started, earlier-finishing parallel call landed first.
          toolCallTimeline: [
            { timestamp: 300, toolName: 'Read', durationMs: 10, success: true },
            { timestamp: 100, toolName: 'Edit', durationMs: 20, success: true },
            { timestamp: 200, toolName: 'Bash', durationMs: 30, success: true },
          ],
        }),
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionTracker'],
    });
    const req = { method: 'GET', url: '/api/sessions/live-timeline' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as { timeline: Array<{ timestamp: number }> };
    expect(parsed.timeline.map((e) => e.timestamp)).toEqual([100, 200, 300]);
  });
});

describe('api-handler GET /api/sessions/:id/replay', () => {
  it('sorts an out-of-order persisted timeline chronologically before returning it', async () => {
    const outOfOrderTimeline = [
      { timestamp: 300, toolName: 'Read', durationMs: 10, success: true },
      { timestamp: 100, toolName: 'Edit', durationMs: 20, success: true },
      { timestamp: 200, toolName: 'Bash', durationMs: 30, success: true },
    ];
    const handler = createApiHandler({
      sessionStore: {
        loadTodaySessions: () => [],
        listSessions: () => [],
        loadSession: (id: string) =>
          id === 'sess-replay' ? { sessionId: 'sess-replay', timeline: outOfOrderTimeline } : null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/sessions/sess-replay/replay' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as { timeline: Array<{ timestamp: number }> };
    expect(parsed.timeline.map((e) => e.timestamp)).toEqual([100, 200, 300]);
  });
});

describe('api-handler GET /api/sessions/:sessionId/subagents', () => {
  const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  it('returns the subagent timeline payload as JSON (200)', async () => {
    const payload = {
      window: { startMs: 100, endMs: 200 },
      agents: [
        {
          agentId: 'a1111111111111111',
          workflowRunId: null,
          workflowName: null,
          label: 'agent a1111111',
          model: 'claude-opus-4-7',
          startMs: 100,
          endMs: 200,
          durationMs: 100,
          turnCount: 2,
          totalTokens: 430,
          usd: 0.01,
        },
      ],
    };
    const handler = createApiHandler({
      subagentTimeline: {
        getSubagentsForSession: (id: string) => {
          expect(id).toBe(SESSION);
          return payload;
        },
        getAgentCalls: () => ({ calls: [] }),
      },
    });
    const req = {
      method: 'GET',
      url: `/api/sessions/${SESSION}/subagents`,
    } as IncomingMessage;
    const { res, status, body, headers } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(headers()['content-type']).toMatch(/application\/json/);
    expect(JSON.parse(body())).toEqual(payload);
  });

  it('returns 503 unavailable when subagentTimeline dep is absent', async () => {
    const handler = createApiHandler({});
    const req = {
      method: 'GET',
      url: `/api/sessions/${SESSION}/subagents`,
    } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(503);
    expect(JSON.parse(body())).toEqual({ error: 'unavailable', what: 'subagentTimeline' });
  });
});

describe('api-handler GET /api/sessions/:sessionId/subagents/:agentId/calls', () => {
  const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const AGENT_ID = 'a1111111111111111';

  it("returns ONE subagent's calls as JSON (200), routing sessionId + agentId through", async () => {
    const payload = {
      calls: [
        { toolName: 'Read', timestamp: 100, durationMs: 50, success: true },
        { toolName: 'Bash', timestamp: 200, durationMs: null, success: false },
      ],
    };
    let receivedSession = '';
    let receivedAgent = '';
    const handler = createApiHandler({
      subagentTimeline: {
        getSubagentsForSession: () => ({ window: { startMs: 0, endMs: 0 }, agents: [] }),
        getAgentCalls: (sessionId: string, agentId: string) => {
          receivedSession = sessionId;
          receivedAgent = agentId;
          return payload;
        },
      },
    });
    const req = {
      method: 'GET',
      url: `/api/sessions/${SESSION}/subagents/${AGENT_ID}/calls`,
    } as IncomingMessage;
    const { res, status, body, headers } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(headers()['content-type']).toMatch(/application\/json/);
    expect(JSON.parse(body())).toEqual(payload);
    expect(receivedSession).toBe(SESSION);
    expect(receivedAgent).toBe(AGENT_ID);
  });

  it('matches the /calls route before the /subagents route (does not collapse to the swimlane endpoint)', async () => {
    let calledTimeline = false;
    const handler = createApiHandler({
      subagentTimeline: {
        getSubagentsForSession: () => {
          calledTimeline = true;
          return { window: { startMs: 0, endMs: 0 }, agents: [] };
        },
        getAgentCalls: () => ({ calls: [] }),
      },
    });
    const req = {
      method: 'GET',
      url: `/api/sessions/${SESSION}/subagents/${AGENT_ID}/calls`,
    } as IncomingMessage;
    const { res, status } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(calledTimeline).toBe(false);
  });

  it('returns 503 unavailable when subagentTimeline dep is absent', async () => {
    const handler = createApiHandler({});
    const req = {
      method: 'GET',
      url: `/api/sessions/${SESSION}/subagents/${AGENT_ID}/calls`,
    } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(503);
    expect(JSON.parse(body())).toEqual({ error: 'unavailable', what: 'subagentTimeline' });
  });
});

describe('api-handler GET /api/cost', () => {
  it('returns cost and forecast as JSON', async () => {
    const fakeCost = { sessionTotalCostUsd: 0.25, costByModel: { 'claude-sonnet': 0.25 } };
    const fakeForecast = { forecastEndOfDayUsd: 2.5, spentUsd: 0.25 };
    const handler = createApiHandler({
      costTracker: { getMetrics: () => fakeCost } as unknown as Parameters<
        typeof createApiHandler
      >[0]['costTracker'],
      // Fake only carries the two fields this test asserts on; safe because
      // the route just forwards the value from costForecast() as JSON.
      costForecast: (() => fakeForecast) as unknown as Parameters<
        typeof createApiHandler
      >[0]['costForecast'],
    });
    const req = { method: 'GET', url: '/api/cost' } as IncomingMessage;
    const { res, status, body, headers } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(headers()['content-type']).toMatch(/application\/json/);
    const result = JSON.parse(body());
    expect(result.cost).toEqual(fakeCost);
    expect(result.forecast).toEqual(fakeForecast);
  });

  it('returns null forecast when costForecast is missing', async () => {
    const fakeCost = { sessionTotalCostUsd: 0.25 };
    const handler = createApiHandler({
      costTracker: { getMetrics: () => fakeCost } as unknown as Parameters<
        typeof createApiHandler
      >[0]['costTracker'],
    });
    const req = { method: 'GET', url: '/api/cost' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const result = JSON.parse(body());
    expect(result.cost).toEqual(fakeCost);
    expect(result.forecast).toBeNull();
  });

  it('returns 503 when costTracker is missing', async () => {
    const handler = createApiHandler({});
    const req = { method: 'GET', url: '/api/cost' } as IncomingMessage;
    const { res, status } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(503);
  });
});

describe('api-handler GET /api/anti-patterns', () => {
  it('returns anti-patterns as JSON array', async () => {
    const fakePatterns = [
      { type: 're_reading', file: '/a.ts', readCount: 4, suggestion: 'Consider breaking task' },
      { type: 'thrashing', file: '/b.ts', iterations: 3, suggestion: 'Try different approach' },
    ];
    const handler = createApiHandler({
      antiPatternDetector: { getCurrentPatterns: () => fakePatterns } as unknown as Parameters<
        typeof createApiHandler
      >[0]['antiPatternDetector'],
    });
    const req = { method: 'GET', url: '/api/anti-patterns' } as IncomingMessage;
    const { res, status, body, headers } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(headers()['content-type']).toMatch(/application\/json/);
    expect(JSON.parse(body())).toEqual(fakePatterns);
  });

  it('returns 503 when antiPatternDetector is missing', async () => {
    const handler = createApiHandler({});
    const req = { method: 'GET', url: '/api/anti-patterns' } as IncomingMessage;
    const { res, status } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(503);
  });
});

describe('api-handler GET /api/retry-alerts', () => {
  it('returns 503 when retryDetector is missing', async () => {
    const handler = createApiHandler({});
    const req = { method: 'GET', url: '/api/retry-alerts' } as IncomingMessage;
    const { res, status } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(503);
  });

  it('returns retry detector metrics as JSON', async () => {
    const fakeMetrics = {
      alerts: [
        {
          toolName: 'Read',
          occurrences: 4,
          windowSize: 5,
          similarity: 0.9,
          tokensWastedEstimate: 750,
          timestamp: 1700000000000,
        },
      ],
      totalTokensWasted: 750,
      totalAlertsEmitted: 1,
    };
    const handler = createApiHandler({
      retryDetector: { getMetrics: () => fakeMetrics } as unknown as Parameters<
        typeof createApiHandler
      >[0]['retryDetector'],
    });
    const req = { method: 'GET', url: '/api/retry-alerts' } as IncomingMessage;
    const { res, status, body, headers } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(headers()['content-type']).toMatch(/application\/json/);
    expect(JSON.parse(body())).toEqual(fakeMetrics);
  });
});

describe('api-handler GET /api/api-failures', () => {
  it('returns 503 when apiFailureTracker is missing', async () => {
    const handler = createApiHandler({});
    const req = { method: 'GET', url: '/api/api-failures' } as IncomingMessage;
    const { res, status } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(503);
  });

  it('returns api failure metrics as JSON', async () => {
    const fakeMetrics = {
      totalFailures: 2,
      byErrorType: { rate_limit: 2 },
      byModel: {},
      bySessionPhase: { early: 0, middle: 2, late: 0 },
      totalTokensLost: 0,
      totalEstimatedCostLostUsd: 0,
      meanTimeToRecoveryMs: null,
      throttleAlerts: [],
      recentFailures: [],
      dataAvailable: true,
      note: 'partial data',
    };
    const handler = createApiHandler({
      apiFailureTracker: { getMetrics: () => fakeMetrics } as unknown as Parameters<
        typeof createApiHandler
      >[0]['apiFailureTracker'],
    });
    const req = { method: 'GET', url: '/api/api-failures' } as IncomingMessage;
    const { res, status, body, headers } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(headers()['content-type']).toMatch(/application\/json/);
    expect(JSON.parse(body())).toEqual(fakeMetrics);
  });
});

describe('api-handler GET /api/instruction-drift', () => {
  it('returns 503 when instructionDriftTracker is missing', async () => {
    const handler = createApiHandler({});
    const req = { method: 'GET', url: '/api/instruction-drift' } as IncomingMessage;
    const { res, status } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(503);
  });

  it('returns instruction drift metrics as JSON', async () => {
    const fakeMetrics = {
      currentPromptHash: 'abc123',
      uniquePromptVariants: 2,
      variantStats: [],
      recentCorrelations: [
        {
          fromHash: 'aaa',
          toHash: 'bbb',
          successRateDelta: -0.15,
          tokensDelta: 6000,
          thrashingDelta: 0.6,
          efficiencyDelta: -0.1,
          verdict: 'degraded',
        },
      ],
      currentVariantSessionCount: 3,
    };
    const handler = createApiHandler({
      instructionDriftTracker: { getMetrics: () => fakeMetrics } as unknown as Parameters<
        typeof createApiHandler
      >[0]['instructionDriftTracker'],
    });
    const req = { method: 'GET', url: '/api/instruction-drift' } as IncomingMessage;
    const { res, status, body, headers } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(headers()['content-type']).toMatch(/application\/json/);
    expect(JSON.parse(body())).toEqual(fakeMetrics);
  });
});

describe('api-handler GET /api/collaboration-profile', () => {
  it('returns 503 when collaborationProfiler is missing', async () => {
    const handler = createApiHandler({});
    const req = { method: 'GET', url: '/api/collaboration-profile' } as IncomingMessage;
    const { res, status } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(503);
  });

  it('returns developerCount from computeTeamBaseline alongside the profile and team deltas', async () => {
    const handler = createApiHandler({
      collaborationProfiler: {
        computeProfile: () => ({
          classification: 'Power User',
          dimensions: {
            specificity: 0.7,
            autonomy: 0.65,
            correctionRate: 0.5,
            taskComplexity: 0.6,
          },
          sessionCount: 12,
        }),
        compareToTeam: () => ({
          deltas: { specificity: 0, autonomy: 0, correctionRate: 0, taskComplexity: 0 },
        }),
        computeTeamBaseline: () => ({ developerCount: 1 }),
      } as unknown as Parameters<typeof createApiHandler>[0]['collaborationProfiler'],
    });
    const req = { method: 'GET', url: '/api/collaboration-profile' } as IncomingMessage;
    const { res, status, body, headers } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(headers()['content-type']).toMatch(/application\/json/);
    const parsed = JSON.parse(body());
    expect(parsed.developerCount).toBe(1);
    expect(parsed.classification).toBe('Power User');
  });
});

describe('api-handler GET /api/decision-tree', () => {
  it('returns 503 when decisionTracker is missing', async () => {
    const handler = createApiHandler({});
    const req = { method: 'GET', url: '/api/decision-tree' } as IncomingMessage;
    const { res, status } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(503);
  });

  it('returns decision tree metrics as JSON', async () => {
    const fakeMetrics = {
      totalBranches: 4,
      successRate: 0.5,
      failurePoints: [],
      longestFailureStreak: 2,
      firstFailureIndex: 1,
      note: '',
    };
    const handler = createApiHandler({
      decisionTracker: { getMetrics: () => fakeMetrics } as unknown as Parameters<
        typeof createApiHandler
      >[0]['decisionTracker'],
    });
    const req = { method: 'GET', url: '/api/decision-tree' } as IncomingMessage;
    const { res, status, body, headers } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(headers()['content-type']).toMatch(/application\/json/);
    expect(JSON.parse(body())).toEqual(fakeMetrics);
  });
});

describe('api-handler GET /api/turn-costs', () => {
  it('returns 503 when turnCostAttributor is missing', async () => {
    const handler = createApiHandler({});
    const req = { method: 'GET', url: '/api/turn-costs' } as IncomingMessage;
    const { res, status } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(503);
  });

  it('returns turn cost metrics as JSON', async () => {
    const fakeMetrics = {
      turns: [
        {
          turnId: 't1',
          startTime: 1,
          endTime: 2,
          toolCalls: ['toolu_001', 'toolu_002'],
          toolNames: ['Read', 'Edit'],
          inputTokens: 500,
          outputTokens: 200,
          cacheReadTokens: 0,
          model: 'claude-sonnet-5',
          estimatedCostUsd: 0.02,
          costPerToolCall: 0.01,
        },
      ],
      costByToolType: {},
      totalAttributedCost: 0.02,
      attributionRate: 1,
    };
    const handler = createApiHandler({
      turnCostAttributor: { getMetrics: () => fakeMetrics } as unknown as Parameters<
        typeof createApiHandler
      >[0]['turnCostAttributor'],
    });
    const req = { method: 'GET', url: '/api/turn-costs' } as IncomingMessage;
    const { res, status, body, headers } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(headers()['content-type']).toMatch(/application\/json/);
    expect(JSON.parse(body())).toEqual(fakeMetrics);
  });
});

describe('api-handler GET /api/compute-waste', () => {
  it('returns clean status with correct totals when waste is low', async () => {
    const handler = createApiHandler({
      retryDetector: { getMetrics: () => ({ totalTokensWasted: 100 }) } as unknown as Parameters<
        typeof createApiHandler
      >[0]['retryDetector'],
      antiPatternDetector: {
        getCurrentPatterns: () => [
          { type: 'stuck_loop', tokensWasted: 200, command: 'npm test', suggestion: '' },
        ],
        getTotalAntiPatternWaste: () => 200,
      } as unknown as Parameters<typeof createApiHandler>[0]['antiPatternDetector'],
    });
    const req = { method: 'GET', url: '/api/compute-waste' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const json = JSON.parse(body()) as Record<string, unknown>;
    expect(json.total_tokens_wasted).toBe(300);
    expect(json.retry_tokens_wasted).toBe(100);
    expect(json.anti_pattern_tokens_wasted).toBe(200);
    expect(json.status).toBe('clean');
    expect((json.breakdown as unknown[]).length).toBe(1);
  });

  it('returns needs_attention when totalTokensWasted >= 2000', async () => {
    const handler = createApiHandler({
      retryDetector: { getMetrics: () => ({ totalTokensWasted: 1500 }) } as unknown as Parameters<
        typeof createApiHandler
      >[0]['retryDetector'],
      antiPatternDetector: {
        getCurrentPatterns: () => [
          { type: 're_reading', tokensWasted: 600, file: '/a.ts', suggestion: '' },
        ],
        getTotalAntiPatternWaste: () => 600,
      } as unknown as Parameters<typeof createApiHandler>[0]['antiPatternDetector'],
    });
    const req = { method: 'GET', url: '/api/compute-waste' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const json = JSON.parse(body()) as Record<string, unknown>;
    expect(json.total_tokens_wasted).toBe(2100);
    expect(json.status).toBe('needs_attention');
    expect((json.breakdown as Array<Record<string, unknown>>).length).toBe(1);
    expect((json.breakdown as Array<Record<string, unknown>>)[0].type).toBe('re_reading');
    expect((json.breakdown as Array<Record<string, unknown>>)[0].tokens_wasted).toBe(600);
  });

  it('returns 503 when retryDetector is missing', async () => {
    const handler = createApiHandler({
      antiPatternDetector: {
        getCurrentPatterns: () => [],
        getTotalAntiPatternWaste: () => 0,
      } as unknown as Parameters<typeof createApiHandler>[0]['antiPatternDetector'],
    });
    const req = { method: 'GET', url: '/api/compute-waste' } as IncomingMessage;
    const { res, status } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(503);
  });

  it('returns 503 when antiPatternDetector is missing', async () => {
    const handler = createApiHandler({
      retryDetector: { getMetrics: () => ({ totalTokensWasted: 0 }) } as unknown as Parameters<
        typeof createApiHandler
      >[0]['retryDetector'],
    });
    const req = { method: 'GET', url: '/api/compute-waste' } as IncomingMessage;
    const { res, status } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(503);
  });

  it('returns moderate status when totalTokensWasted is in 500-1999 range', async () => {
    const handler = createApiHandler({
      retryDetector: { getMetrics: () => ({ totalTokensWasted: 400 }) } as unknown as Parameters<
        typeof createApiHandler
      >[0]['retryDetector'],
      antiPatternDetector: {
        getCurrentPatterns: () => [
          { type: 're_reading', tokensWasted: 200, file: '/a.ts', suggestion: '' },
        ],
        getTotalAntiPatternWaste: () => 200,
      } as unknown as Parameters<typeof createApiHandler>[0]['antiPatternDetector'],
    });
    const req = { method: 'GET', url: '/api/compute-waste' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const json = JSON.parse(body()) as Record<string, unknown>;
    expect(json.total_tokens_wasted).toBe(600);
    expect(json.status).toBe('moderate');
  });
});

describe('api-handler GET /api/audit', () => {
  it('returns audit log mapped to SPA AuditEntry shape', async () => {
    const ts1 = Date.now() - 5000;
    const ts2 = Date.now() - 1000;
    const fakeAuditLog = [
      {
        timestamp: ts1,
        sessionId: 'session-a',
        action: 'FileRead',
        tool: 'Read',
        detail: 'Read /etc/passwd',
        developer: 'alice',
        securityAlert: { severity: 'high', alertType: 'sensitive_file' },
      },
      {
        timestamp: ts2,
        sessionId: 'session-a',
        action: 'BashCommand',
        tool: 'Bash',
        detail: 'rm -rf /tmp/foo',
        developer: 'alice',
        command: 'rm -rf /tmp/foo',
        securityAlert: { severity: 'critical', alertType: 'destructive_command' },
      },
    ];
    const handler = createApiHandler({
      auditTrailManager: { getAuditLog: () => fakeAuditLog } as unknown as Parameters<
        typeof createApiHandler
      >[0]['auditTrailManager'],
    });
    const req = { method: 'GET', url: '/api/audit' } as IncomingMessage;
    const { res, status, body, headers } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(headers()['content-type']).toMatch(/application\/json/);
    expect(JSON.parse(body())).toEqual([
      {
        ts: ts1,
        sessionId: 'session-a',
        tool: 'Read',
        target: 'Read /etc/passwd',
        classification: 'sensitive_file',
        severity: 'high',
      },
      {
        ts: ts2,
        sessionId: 'session-a',
        tool: 'Bash',
        target: 'rm -rf /tmp/foo',
        classification: 'destructive_command',
        severity: 'critical',
      },
    ]);
  });

  it("classifies entries without a securityAlert as 'other'", async () => {
    const fakeAuditLog = [
      {
        timestamp: 1700000000000,
        sessionId: null,
        action: 'FileRead',
        tool: 'Read',
        detail: '/some/normal/file.ts',
        developer: 'alice',
      },
    ];
    const handler = createApiHandler({
      auditTrailManager: { getAuditLog: () => fakeAuditLog } as unknown as Parameters<
        typeof createApiHandler
      >[0]['auditTrailManager'],
    });
    const req = { method: 'GET', url: '/api/audit' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as Array<Record<string, unknown>>;
    expect(parsed[0]!.classification).toBe('other');
    expect(parsed[0]!.target).toBe('/some/normal/file.ts');
  });

  it('omits severity when there is no securityAlert', async () => {
    const fakeAuditLog = [
      {
        timestamp: 1700000000000,
        sessionId: null,
        action: 'FileRead',
        tool: 'Read',
        detail: '/some/normal/file.ts',
        developer: 'alice',
      },
    ];
    const handler = createApiHandler({
      auditTrailManager: { getAuditLog: () => fakeAuditLog } as unknown as Parameters<
        typeof createApiHandler
      >[0]['auditTrailManager'],
    });
    const req = { method: 'GET', url: '/api/audit' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as Array<Record<string, unknown>>;
    expect(parsed[0]!.severity).toBeUndefined();
  });

  it('passes through the AuditRecord.id as the DTO id field', async () => {
    const fakeAuditLog = [
      {
        id: 'call-abc123',
        timestamp: 1700000000000,
        sessionId: 'session-a',
        action: 'FileRead',
        tool: 'Read',
        detail: '/some/file.ts',
        developer: 'alice',
      },
    ];
    const handler = createApiHandler({
      auditTrailManager: { getAuditLog: () => fakeAuditLog } as unknown as Parameters<
        typeof createApiHandler
      >[0]['auditTrailManager'],
    });
    const req = { method: 'GET', url: '/api/audit' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as Array<Record<string, unknown>>;
    expect(parsed[0]!.id).toBe('call-abc123');
  });

  it('returns 503 when auditTrailManager is missing', async () => {
    const handler = createApiHandler({});
    const req = { method: 'GET', url: '/api/audit' } as IncomingMessage;
    const { res, status } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(503);
  });

  it('redacts secret-bearing strings in target (formerly detail) before serializing', async () => {
    // Use a Bearer token that matches DEFAULT_REDACTION_PATTERNS (>=20 chars after prefix).
    const secret = 'Bearer abcdefghijklmnopqrstuvwxyz0123456789';
    const fakeAuditLog = [
      {
        timestamp: 1700000000000,
        sessionId: 'session-a',
        action: 'BashCommand',
        tool: 'Bash',
        detail: `Bash: curl -H "Authorization: ${secret}" https://api.example.com`,
        developer: 'alice',
        command: `curl -H "Authorization: ${secret}" https://api.example.com`,
        filePath: '/home/alice/.aws/credentials',
        securityAlert: { severity: 'medium', alertType: 'external_network' },
      },
    ];
    const handler = createApiHandler({
      auditTrailManager: { getAuditLog: () => fakeAuditLog } as unknown as Parameters<
        typeof createApiHandler
      >[0]['auditTrailManager'],
    });
    const req = { method: 'GET', url: '/api/audit' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as Array<Record<string, string>>;
    expect(parsed[0]!.target).not.toContain(secret);
    expect(parsed[0]!.target).toContain('[REDACTED]');
    expect(parsed[0]!.classification).toBe('external_network');
    // command/filePath/developer/action are NOT in the SPA DTO.
    expect(parsed[0]).not.toHaveProperty('command');
    expect(parsed[0]).not.toHaveProperty('filePath');
    expect(parsed[0]).not.toHaveProperty('developer');
    expect(parsed[0]).not.toHaveProperty('action');
  });

  // Regression: the route must bound how many rows it asks getAuditLog()
  // for, rather than always calling it with no argument (which used to mean
  // "return everything").
  it('calls getAuditLog() with a bounded default limit when the query has none', async () => {
    const getAuditLog = jest.fn((_limit?: number): unknown[] => []);
    const handler = createApiHandler({
      auditTrailManager: { getAuditLog } as unknown as Parameters<
        typeof createApiHandler
      >[0]['auditTrailManager'],
    });
    const req = { method: 'GET', url: '/api/audit' } as IncomingMessage;
    const { res, status } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(getAuditLog).toHaveBeenCalledTimes(1);
    const calledLimit = getAuditLog.mock.calls[0]?.[0] as number | undefined;
    expect(typeof calledLimit).toBe('number');
    expect(calledLimit as number).toBeGreaterThan(0);
  });

  it('clamps an oversized ?limit= query param instead of passing it straight through', async () => {
    const getAuditLog = jest.fn((_limit?: number): unknown[] => []);
    const handler = createApiHandler({
      auditTrailManager: { getAuditLog } as unknown as Parameters<
        typeof createApiHandler
      >[0]['auditTrailManager'],
    });
    const req = { method: 'GET', url: '/api/audit?limit=999999999' } as IncomingMessage;
    const { res, status } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const calledLimit = getAuditLog.mock.calls[0]?.[0] as number | undefined;
    expect(calledLimit as number).toBeLessThan(999999999);
  });

  it('honors a reasonable explicit ?limit= query param', async () => {
    const getAuditLog = jest.fn((_limit?: number): unknown[] => []);
    const handler = createApiHandler({
      auditTrailManager: { getAuditLog } as unknown as Parameters<
        typeof createApiHandler
      >[0]['auditTrailManager'],
    });
    const req = { method: 'GET', url: '/api/audit?limit=50' } as IncomingMessage;
    const { res, status } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(getAuditLog).toHaveBeenCalledWith(50);
  });
});

describe('api-handler GET /api/weekly', () => {
  it('returns weekly summaries as JSON array', async () => {
    const fakeWeekly = [
      { week: '2026-W22', sessionCount: 5, totalCostUsd: 1.5 },
      { week: '2026-W21', sessionCount: 3, totalCostUsd: 0.8 },
    ];
    const handler = createApiHandler({
      weeklySummaryGenerator: {
        loadRecentWeeks: (count: number) => fakeWeekly.slice(0, count),
      } as unknown as Parameters<typeof createApiHandler>[0]['weeklySummaryGenerator'],
    });
    const req = { method: 'GET', url: '/api/weekly?count=2' } as IncomingMessage;
    const { res, status, body, headers } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(headers()['content-type']).toMatch(/application\/json/);
    expect(JSON.parse(body())).toEqual(fakeWeekly);
  });

  it('uses default count of 12 when not specified', async () => {
    let passedCount = 0;
    const handler = createApiHandler({
      weeklySummaryGenerator: {
        loadRecentWeeks: (count: number) => {
          passedCount = count;
          return [];
        },
      } as unknown as Parameters<typeof createApiHandler>[0]['weeklySummaryGenerator'],
    });
    const req = { method: 'GET', url: '/api/weekly' } as IncomingMessage;
    const { res, status } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(passedCount).toBe(12);
  });

  it('caps count at 52', async () => {
    let passedCount = 0;
    const handler = createApiHandler({
      weeklySummaryGenerator: {
        loadRecentWeeks: (count: number) => {
          passedCount = count;
          return [];
        },
      } as unknown as Parameters<typeof createApiHandler>[0]['weeklySummaryGenerator'],
    });
    const req = { method: 'GET', url: '/api/weekly?count=365' } as IncomingMessage;
    const { res, status } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(passedCount).toBe(52);
  });

  it('treats invalid count as default 12', async () => {
    let passedCount = 0;
    const handler = createApiHandler({
      weeklySummaryGenerator: {
        loadRecentWeeks: (count: number) => {
          passedCount = count;
          return [];
        },
      } as unknown as Parameters<typeof createApiHandler>[0]['weeklySummaryGenerator'],
    });
    const req = { method: 'GET', url: '/api/weekly?count=invalid' } as IncomingMessage;
    const { res, status } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(passedCount).toBe(12);
  });

  it('returns 503 when weeklySummaryGenerator is missing', async () => {
    const handler = createApiHandler({});
    const req = { method: 'GET', url: '/api/weekly' } as IncomingMessage;
    const { res, status } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(503);
  });
});

describe('api-handler GET /api/budget', () => {
  it('returns budget status as JSON', async () => {
    const fakeBudgetStatus = {
      sessionSpentUsd: 0.5,
      sessionBudgetUsd: 10,
      sessionPercentUsed: 5,
      dailySpentUsd: 2.0,
      dailyBudgetUsd: 50,
      dailyPercentUsed: 4,
      weeklySpentUsd: 5.0,
      weeklyBudgetUsd: 200,
      weeklyPercentUsed: 2.5,
    };
    const handler = createApiHandler({
      budgetTracker: { getStatus: () => fakeBudgetStatus } as unknown as Parameters<
        typeof createApiHandler
      >[0]['budgetTracker'],
    });
    const req = { method: 'GET', url: '/api/budget' } as IncomingMessage;
    const { res, status, body, headers } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(headers()['content-type']).toMatch(/application\/json/);
    expect(JSON.parse(body())).toEqual(fakeBudgetStatus);
  });

  it('returns 503 when budgetTracker is missing', async () => {
    const handler = createApiHandler({});
    const req = { method: 'GET', url: '/api/budget' } as IncomingMessage;
    const { res, status } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(503);
  });
});

describe('api-handler GET /api/latency', () => {
  const startOfToday = (): number => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };

  const persistedLatencyDeps = (): Parameters<typeof createApiHandler>[0] => {
    const startMs = startOfToday();
    return {
      sessionStore: {
        loadTodaySessions: () => [
          {
            sessionId: 'persisted-1',
            timeline: [
              { timestamp: startMs + 30_000, durationMs: 50, toolName: 'Read', success: true },
              { timestamp: startMs + 60_000, durationMs: 150, toolName: 'Read', success: true },
            ],
          },
        ],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    };
  };

  it('serves percentiles rehydrated from persisted sessions, not just live tracker state', async () => {
    // A restarted process has an empty tracker but the day's calls are on disk.
    const handler = createApiHandler({
      ...persistedLatencyDeps(),
      latencyTracker: {
        getMetrics: () => ({ overall: null, byTool: {}, slowestCalls: [] }),
      } as unknown as Parameters<typeof createApiHandler>[0]['latencyTracker'],
    });
    const req = { method: 'GET', url: '/api/latency' } as IncomingMessage;
    const { res, status, body, headers } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(headers()['content-type']).toMatch(/application\/json/);
    const parsed = JSON.parse(body()) as {
      overall: { count: number } | null;
      byTool: Record<string, { count: number } | null>;
    };
    expect(parsed.overall?.count).toBe(2);
    expect(parsed.byTool.Read?.count).toBe(2);
  });

  it('keeps slowestCalls from the live tracker, which has no persisted counterpart', async () => {
    const slowest = [{ toolName: 'Bash', durationMs: 9_000, timestamp: Date.now() }];
    const handler = createApiHandler({
      ...persistedLatencyDeps(),
      latencyTracker: {
        getMetrics: () => ({ overall: null, byTool: {}, slowestCalls: slowest }),
      } as unknown as Parameters<typeof createApiHandler>[0]['latencyTracker'],
    });
    const req = { method: 'GET', url: '/api/latency' } as IncomingMessage;
    const { res, body } = fakeRes();
    await handler(req, res);
    expect((JSON.parse(body()) as { slowestCalls: unknown[] }).slowestCalls).toEqual(slowest);
  });

  it('still responds without a latencyTracker, since the store is now the source', async () => {
    const handler = createApiHandler({});
    const req = { method: 'GET', url: '/api/latency' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(JSON.parse(body())).toEqual({ overall: null, byTool: {}, slowestCalls: [] });
  });
});

describe('api-handler GET /api/cost-per-outcome', () => {
  it('classifies sessions and returns outcome distribution', async () => {
    const fakeSessions = [
      // failed_attempt: test command ran (testRunCount > 0) but exited non-zero (testPassCount === 0)
      {
        testRunCount: 2,
        testPassCount: 0,
        filesModified: ['src/foo.ts'],
        toolBreakdown: { Edit: 1 },
        toolCallCount: 5,
        estimatedCostUsd: 0.5,
      },
      // bug_fix: tests run, some passed, files modified
      {
        testRunCount: 3,
        testPassCount: 2,
        filesModified: ['src/bar.ts'],
        toolBreakdown: { Edit: 2 },
        toolCallCount: 8,
        estimatedCostUsd: 0.8,
      },
      // documentation: only .md modified
      {
        testRunCount: 0,
        testPassCount: 0,
        filesModified: ['README.md'],
        toolBreakdown: { Edit: 1 },
        toolCallCount: 4,
        estimatedCostUsd: 0.2,
      },
    ];
    const handler = createApiHandler({
      sessionStore: {
        loadTodaySessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
        loadAllSessions: () => fakeSessions,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/cost-per-outcome?days=7' } as IncomingMessage;
    const { res, status, body, headers } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(headers()['content-type']).toMatch(/application\/json/);
    const result = JSON.parse(body());
    expect(result.outcomeDistribution.failed_attempt.count).toBe(1);
    expect(result.outcomeDistribution.bug_fix.count).toBe(1);
    expect(result.outcomeDistribution.documentation.count).toBe(1);
    expect(result.totalTasks).toBe(3);
    // wasteRatio = 0.50 / 1.50 = 0.3333
    expect(result.wasteRatio).toBeCloseTo(0.3333, 2);
  });

  it('clamps the days parameter to [1,365]', async () => {
    let receivedSince: Date | undefined;
    const handler = createApiHandler({
      sessionStore: {
        loadTodaySessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
        loadAllSessions: (opts?: { since?: Date }) => {
          receivedSince = opts?.since;
          return [];
        },
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/cost-per-outcome?days=9999' } as IncomingMessage;
    const { res } = fakeRes();
    await handler(req, res);
    expect(receivedSince).toBeInstanceOf(Date);
    const ageMs = Date.now() - (receivedSince as Date).getTime();
    // Clamped to 365 days
    expect(ageMs).toBeLessThanOrEqual(366 * 86_400_000);
    expect(ageMs).toBeGreaterThanOrEqual(364 * 86_400_000);
  });

  it('returns 503 when sessionStore.loadAllSessions is missing', async () => {
    const handler = createApiHandler({
      sessionStore: {
        loadTodaySessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/cost-per-outcome' } as IncomingMessage;
    const { res, status } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(503);
  });

  it("excludes a session whose real startTime falls outside the local N-day window, even when loadAllSessions' own (looser) pre-filter returns it", async () => {
    const days = 7;
    // Matches the route's own local-day-aligned window computation, so this
    // test exercises the real boundary rather than an arbitrary offset.
    const windowStartMs = localStartOfDay() - (days - 1) * 86_400_000;
    const outsideSession = {
      startTime: windowStartMs - 60_000, // just before the local window starts
      testRunCount: 0,
      testPassCount: 0,
      filesModified: [],
      toolBreakdown: {},
      toolCallCount: 1,
      estimatedCostUsd: 5,
    };
    const insideSession = {
      startTime: windowStartMs + 60_000, // just after the local window starts
      testRunCount: 0,
      testPassCount: 0,
      filesModified: [],
      toolBreakdown: {},
      toolCallCount: 1,
      estimatedCostUsd: 1,
    };
    const handler = createApiHandler({
      sessionStore: {
        loadTodaySessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
        // Simulates loadAllSessions()'s own UTC-anchored filename-date
        // pre-filter (session-store.ts) being looser than the local window
        // and returning both sessions regardless.
        loadAllSessions: () => [outsideSession, insideSession],
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: `/api/cost-per-outcome?days=${days}` } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const result = JSON.parse(body());
    // Only the in-window session counts — without an explicit startTime
    // check, a raw rolling `since` instant would pass straight through, so a
    // session outside the intended local window (but inside the looser
    // pre-filter) would leak into the total.
    expect(result.totalTasks).toBe(1);
    expect(result.totalCost).toBeCloseTo(1);
  });
});

describe('api-handler GET /api/alerts/recent', () => {
  it('returns alertLog.readRecent(50) entries as JSON', async () => {
    const fakeEntries = [
      {
        id: 'rule-a',
        state: 'firing',
        severity: 'warning',
        title: 'A',
        description: 'd',
        value: 1,
        threshold: 0,
        firedAt: 1000,
      },
      {
        id: 'rule-b',
        state: 'cleared',
        severity: 'critical',
        title: 'B',
        description: 'd',
        value: 0,
        threshold: 5,
        firedAt: 500,
      },
    ];
    let receivedLimit = 0;
    const handler = createApiHandler({
      alertLog: {
        // fakeEntries' `state` fields widen to `string`; safe cast since the
        // route just JSON-serializes whatever readRecent() returns.
        readRecent: async (limit: number) => {
          receivedLimit = limit;
          return fakeEntries;
        },
      } as unknown as Parameters<typeof createApiHandler>[0]['alertLog'],
    });
    const req = { method: 'GET', url: '/api/alerts/recent' } as IncomingMessage;
    const { res, status, body, headers } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(headers()['content-type']).toMatch(/application\/json/);
    expect(JSON.parse(body())).toEqual(fakeEntries);
    expect(receivedLimit).toBe(50);
  });

  it('returns 404 when alertLog is missing (cloud mode or alerts disabled)', async () => {
    const handler = createApiHandler({});
    const req = { method: 'GET', url: '/api/alerts/recent' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(404);
    expect(JSON.parse(body())).toEqual({ error: 'not_found' });
  });

  it('returns 500 with a generic error code when alertLog.readRecent rejects', async () => {
    // Suppress the server-side console.error log triggered by this case so the
    // expected error doesn't pollute test output.
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const handler = createApiHandler({
      alertLog: {
        readRecent: async () => {
          throw new Error('disk gone /Users/secret/path with token sk-test-deadbeef');
        },
      },
    });
    const req = { method: 'GET', url: '/api/alerts/recent' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(500);
    const parsed = JSON.parse(body());
    expect(parsed).toEqual({ error: 'internal' });
    // Defensive: the response body must NOT echo any part of the raw error to
    // the client — paths/tokens/stack frames stay server-side only.
    expect(body()).not.toContain('disk gone');
    expect(body()).not.toContain('sk-test-deadbeef');
    consoleSpy.mockRestore();
  });

  it('returns an empty array when the log is empty', async () => {
    const handler = createApiHandler({
      alertLog: { readRecent: async () => [] },
    });
    const req = { method: 'GET', url: '/api/alerts/recent' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(JSON.parse(body())).toEqual([]);
  });
});

describe('api-handler GET /api/personal-coach', () => {
  it('returns the PersonalCoach.generate() result', async () => {
    const fake = {
      status: 'ok',
      developer: 'alice',
      generatedAt: 1000,
      weeksAnalyzed: 4,
      highlights: ['nice'],
      regressions: [],
      streaks: [],
      topRecommendation: 'keep going',
      thisWeek: { weekId: '2026-W22' },
      lastWeek: null,
      baseline: { weekId: 'baseline' },
    };
    const handler = createApiHandler({
      personalCoach: { generate: () => fake } as unknown as Parameters<
        typeof createApiHandler
      >[0]['personalCoach'],
    });
    const req = { method: 'GET', url: '/api/personal-coach' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(JSON.parse(body())).toEqual(fake);
  });

  it('returns 503 when personalCoach is missing', async () => {
    const handler = createApiHandler({});
    const req = { method: 'GET', url: '/api/personal-coach' } as IncomingMessage;
    const { res, status } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(503);
  });

  it('regenerates the current week summary before reading, so "this week" is never stale', async () => {
    const generatedWeekIds: string[] = [];
    const handler = createApiHandler({
      personalCoach: { generate: () => ({ status: 'insufficient_data' }) } as unknown as Parameters<
        typeof createApiHandler
      >[0]['personalCoach'],
      weeklySummaryGenerator: {
        generate: (weekId: string) => generatedWeekIds.push(weekId),
      } as unknown as Parameters<typeof createApiHandler>[0]['weeklySummaryGenerator'],
    });
    const req = { method: 'GET', url: '/api/personal-coach' } as IncomingMessage;
    const { res, status } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(generatedWeekIds).toEqual([getIsoWeekId(new Date())]);
  });

  it('still returns personalCoach.generate() when the regeneration throws', async () => {
    const fake = { status: 'insufficient_data' };
    const handler = createApiHandler({
      personalCoach: { generate: () => fake } as unknown as Parameters<
        typeof createApiHandler
      >[0]['personalCoach'],
      weeklySummaryGenerator: {
        generate: () => {
          throw new Error('disk full');
        },
      } as unknown as Parameters<typeof createApiHandler>[0]['weeklySummaryGenerator'],
    });
    const req = { method: 'GET', url: '/api/personal-coach' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(JSON.parse(body())).toEqual(fake);
  });
});

// ---------------------------------------------------------------------------
// Cross-session aggregate + live session list
// ---------------------------------------------------------------------------

describe('api-handler GET /api/sessions/live', () => {
  it('returns sessions sorted most-recently-active first', async () => {
    const ids = ['old', 'newest', 'mid'];
    const lastActivityMap: Record<string, number> = {
      old: 1_000_000,
      newest: 9_000_000,
      mid: 5_000_000,
    };
    const handler = createApiHandler({
      liveSessionRegistry: {
        getLiveSessions: () => ids,
        getSessionName: (id: string) => (id === 'newest' ? 'frontend' : null),
        getLastActivity: (id: string) => lastActivityMap[id] ?? null,
      },
      toolCallBuffer: {
        getRecords: () => [
          { sessionId: 'old', timestamp: 100, toolName: 'Read' } as never,
          { sessionId: 'newest', timestamp: 200, toolName: 'Read' } as never,
        ],
      },
    });
    const req = { method: 'GET', url: '/api/sessions/live' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as Array<{
      sessionId: string;
      sessionName: string | null;
      startTime: number;
      lastActivity: number;
    }>;
    expect(parsed.map((p) => p.sessionId)).toEqual(['newest', 'mid', 'old']);
    expect(parsed[0]!.sessionName).toBe('frontend');
    expect(parsed[0]!.lastActivity).toBe(9_000_000);
  });

  it('includes a session seen only via peekAllBuffers, not touched by this process', async () => {
    const now = Date.now();
    const handler = createApiHandler({
      liveSessionRegistry: {
        getLiveSessions: () => ['owned-by-this-process'],
        getSessionName: () => null,
        getLastActivity: () => now,
      },
      localStore: {
        peekAllBuffers: () => [
          { mode: 'post', sessionId: 'owned-by-other-process', timestamp: now - 1_000 },
        ],
      },
      toolCallBuffer: { getRecords: () => [] },
    });
    const req = { method: 'GET', url: '/api/sessions/live' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as Array<{ sessionId: string }>;
    expect(parsed.map((p) => p.sessionId).sort()).toEqual([
      'owned-by-other-process',
      'owned-by-this-process',
    ]);
  });

  it('returns 503 when liveSessionRegistry is missing', async () => {
    const handler = createApiHandler({});
    const req = { method: 'GET', url: '/api/sessions/live' } as IncomingMessage;
    const { res, status } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(503);
  });
});

describe('api-handler GET /api/sessions/today/aggregate', () => {
  it('aggregates tool calls and costs across buffer + persisted sessions', async () => {
    const now = Date.now();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const startMs = startOfDay.getTime();

    const handler = createApiHandler({
      // Two live tool calls in the per-session buffers (post events only).
      localStore: {
        peekAllBuffers: () => [
          { mode: 'post', sessionId: 's1', timestamp: startMs + 60_000, durationMs: 100 },
          { mode: 'pre', sessionId: 's1', timestamp: startMs + 60_001 },
          { mode: 'post', sessionId: 's2', timestamp: startMs + 120_000, durationMs: 200 },
          // Yesterday — must be ignored.
          { mode: 'post', sessionId: 's3', timestamp: startMs - 1, durationMs: 999 },
        ],
      },
      sessionStore: {
        loadTodaySessions: () => [
          {
            sessionId: 'persisted-1',
            estimatedCostUsd: 0.42,
            antiPatterns: [{ type: 'thrashing', count: 2 }],
            timeline: [
              { timestamp: startMs + 30_000, durationMs: 50, toolName: 'Read', success: true },
              { timestamp: startMs + 90_000, durationMs: 75, toolName: 'Edit', success: true },
            ],
          },
        ],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
      antiPatternDetector: {
        getCurrentPatterns: () => [{ type: 'rereading', readCount: 4 }],
      } as unknown as Parameters<typeof createApiHandler>[0]['antiPatternDetector'],
      liveSessionRegistry: {
        getLiveSessions: () => ['s1', 's2'],
        getSessionName: () => null,
      },
    });
    const req = { method: 'GET', url: '/api/sessions/today/aggregate' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as {
      toolCallCount: number;
      totalCostUsd: number;
      antiPatternCount: number;
      avgDurationMs: number;
      sessionCount: number;
      sparkline: { startTimestamp: number; bucketSizeMs: number; points: number[] };
    };
    // 2 buffer post events + 2 timeline events (persisted-1 not in live set)
    expect(parsed.toolCallCount).toBe(4);
    // 1 (persisted) + 2 (live, but no antiPatternCount entry) +
    // antiPatternDetector currentPatterns (1)
    expect(parsed.antiPatternCount).toBe(2);
    expect(parsed.totalCostUsd).toBe(0.42);
    // average of 100, 200, 50, 75 = 106.25 → 106
    expect(parsed.avgDurationMs).toBe(106);
    // s1, s2, persisted-1
    expect(parsed.sessionCount).toBeGreaterThanOrEqual(3);
    expect(parsed.sparkline.bucketSizeMs).toBe(60_000);
    expect(parsed.sparkline.startTimestamp).toBe(startMs);
    expect(parsed.sparkline.points.length).toBeGreaterThan(0);
  });

  it('includes cross-session latency percentiles in the aggregate payload', async () => {
    const now = Date.now();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const startMs = startOfDay.getTime();

    const handler = createApiHandler({
      localStore: {
        peekAllBuffers: () => [
          {
            mode: 'post',
            sessionId: 's1',
            timestamp: startMs + 10_000,
            durationMs: 100,
            tool: 'Read',
          },
          {
            mode: 'post',
            sessionId: 's1',
            timestamp: startMs + 20_000,
            durationMs: 200,
            tool: 'Edit',
          },
          {
            mode: 'post',
            sessionId: 's1',
            timestamp: startMs + 30_000,
            durationMs: 300,
            tool: 'Read',
          },
        ],
      },
      sessionStore: {
        loadTodaySessions: () => [
          {
            sessionId: 'persisted-1',
            timeline: [
              { timestamp: startMs + 40_000, durationMs: 400, toolName: 'Edit', success: true },
              { timestamp: startMs + 50_000, durationMs: 500, toolName: 'Read', success: true },
            ],
          },
        ],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/sessions/today/aggregate' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as {
      latency: {
        overall: {
          p50: number;
          p95: number;
          p99: number;
          min: number;
          max: number;
          count: number;
        } | null;
        byTool: Record<
          string,
          { p50: number; p95: number; p99: number; min: number; max: number; count: number } | null
        >;
      };
    };
    // Overall sorted durations: [100, 200, 300, 400, 500], n=5
    expect(parsed.latency.overall).toEqual({
      p50: 300,
      p95: 400,
      p99: 400,
      min: 100,
      max: 500,
      count: 5,
    });
    // Read: [100, 300, 500], n=3
    expect(parsed.latency.byTool.Read).toEqual({
      p50: 300,
      p95: 300,
      p99: 300,
      min: 100,
      max: 500,
      count: 3,
    });
    // Edit: [200, 400], n=2
    expect(parsed.latency.byTool.Edit).toEqual({
      p50: 200,
      p95: 200,
      p99: 200,
      min: 200,
      max: 400,
      count: 2,
    });
  });

  it('returns zeros when no data is present', async () => {
    const handler = createApiHandler({
      localStore: { peekAllBuffers: () => [] },
      sessionStore: {
        loadTodaySessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/sessions/today/aggregate' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as { toolCallCount: number; totalCostUsd: number };
    expect(parsed.toolCallCount).toBe(0);
    expect(parsed.totalCostUsd).toBe(0);
  });

  // Regression: a resumed multi-day session persists a LIFETIME estimatedCostUsd
  // (e.g. a month of cache-read tokens ≈ $250) but only spent a little today.
  // "Spend Today" must sum the session's real today-bucket (costByDayUsd), not
  // the lifetime total. Before the fix, a timeline-less session pro-rated to
  // ratio 1.0 and dumped its whole lifetime onto today (the $248/$863 phantoms).
  it('sums a persisted session today-bucket, not its lifetime estimatedCostUsd', async () => {
    const now = Date.now();
    const startMs = localStartOfDay();
    const todayKey = localDateKey(now);
    const yesterdayKey = localDateKey(startMs - 1);

    const handler = createApiHandler({
      localStore: { peekAllBuffers: () => [] },
      sessionStore: {
        loadTodaySessions: () => [
          {
            sessionId: 'resumed-1',
            startTime: startMs + 10_000,
            endTime: startMs + 70_000,
            // Lifetime cumulative — most of it spent on prior days.
            estimatedCostUsd: 250.0,
            subagentCostUsd: 0,
            costByDayUsd: { [yesterdayKey]: 245.0, [todayKey]: 5.0 },
            subagentCostByDayUsd: {},
            // No tool-call activity recorded today (the phantom shape).
            timeline: [],
          },
        ],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/sessions/today/aggregate' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as { totalCostUsd: number };
    // Today's bucket only — NOT the $250 lifetime, NOT 0.
    expect(parsed.totalCostUsd).toBeCloseTo(5.0, 6);
  });

  // Phantom guard: a session file without day buckets (no costByDayUsd) with
  // cost but ZERO attributable activity — no tool calls, no timeline, no
  // subagent spend — is an unverifiable re-read artifact. Its estimatedCostUsd
  // is a lifetime total, and todayPortionRatio returns 1.0 for its
  // entirely-today window, dumping the whole lifetime onto today (the observed
  // $248/$863 phantoms, which had toolCallCount 0 and subagentCostUsd 0). It
  // must contribute 0; the real figure is recovered once the session
  // re-persists with day buckets.
  it('excludes a zero-activity session cost from today when it has no day buckets (unverifiable re-read artifact)', async () => {
    const startMs = localStartOfDay();
    const handler = createApiHandler({
      localStore: { peekAllBuffers: () => [] },
      sessionStore: {
        loadTodaySessions: () => [
          {
            sessionId: 'phantom-1',
            startTime: startMs + 10_000,
            endTime: startMs + 70_000,
            estimatedCostUsd: 248.83,
            // No day buckets (no costByDayUsd), with zero activity signals of any kind.
            toolCallCount: 0,
            subagentCostUsd: 0,
            timeline: [],
          },
        ],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/sessions/today/aggregate' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as { totalCostUsd: number };
    expect(parsed.totalCostUsd).toBe(0);
  });

  // A legitimate cross-session subagent-only session has an EMPTY parent
  // timeline (subagent tool calls are not in it) yet real subagentCostUsd — it
  // must NOT be treated as a phantom. The guard keys on subagent spend, so this
  // session's cost pro-rates normally on both the total and subagent lines.
  it('still counts a subagent-only session without day buckets (empty timeline, real subagent cost)', async () => {
    const startMs = localStartOfDay();
    const handler = createApiHandler({
      localStore: { peekAllBuffers: () => [] },
      sessionStore: {
        loadTodaySessions: () => [
          {
            sessionId: 'subagent-only',
            startTime: startMs + 10_000,
            endTime: startMs + 70_000,
            estimatedCostUsd: 3.0,
            subagentCostUsd: 3.0,
            toolCallCount: 0,
            timeline: [],
          },
        ],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/sessions/today/aggregate' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as { totalCostUsd: number; subagentUsd: number };
    // Entirely-today window → ratio 1.0 → full 3.0 on both lines.
    expect(parsed.totalCostUsd).toBeCloseTo(3.0, 6);
    expect(parsed.subagentUsd).toBeCloseTo(3.0, 6);
  });

  // Guard: a session without day buckets that DID record tool-call activity
  // today still pro-rates its cost as before.
  it('still pro-rates a session cost when it has no day buckets but has timeline activity', async () => {
    const startMs = localStartOfDay();
    const handler = createApiHandler({
      localStore: { peekAllBuffers: () => [] },
      sessionStore: {
        loadTodaySessions: () => [
          {
            sessionId: 'legit-prefix-1',
            startTime: startMs + 10_000,
            endTime: startMs + 70_000,
            estimatedCostUsd: 0.5,
            timeline: [
              { timestamp: startMs + 20_000, durationMs: 50, toolName: 'Read', success: true },
              { timestamp: startMs + 40_000, durationMs: 60, toolName: 'Edit', success: true },
            ],
          },
        ],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/sessions/today/aggregate' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as { totalCostUsd: number };
    // Both timeline entries are today → ratio 1.0 → full 0.5.
    expect(parsed.totalCostUsd).toBeCloseTo(0.5, 6);
  });

  it('reports today-scoped subagent spend without double-counting the total', async () => {
    const handler = createApiHandler({
      localStore: { peekAllBuffers: () => [] },
      sessionStore: {
        loadTodaySessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
      costTracker: {
        getMetrics: () => ({ sessionTotalCostUsd: 0 }),
        // All-in today spend (already includes the subagent portion).
        getCostForDay: () => 9,
        // Today's subagent portion of that 9 — the breakdown, not an addend.
        getSubagentCostForDay: () => 6,
        // Session-cumulative; must NOT be what the aggregate reports.
        getSubagentMetrics: () => ({
          subagentUsd: 99,
          parentUsd: 3,
          subagentSharePct: 97,
          reconciliationDeltaPct: null,
        }),
      } as unknown as Parameters<typeof createApiHandler>[0]['costTracker'],
    });
    const req = { method: 'GET', url: '/api/sessions/today/aggregate' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as { totalCostUsd: number; subagentUsd: number };
    // Total is the all-in day spend — NOT inflated by folding subagent in again.
    expect(parsed.totalCostUsd).toBeCloseTo(9, 3);
    // Subagent KPI is the today-scoped portion (6), not the cumulative 99.
    expect(parsed.subagentUsd).toBeCloseTo(6, 3);
  });

  // A NEW-format session with day buckets contributes exactly its today-bucket
  // for both total and subagent, even with an empty timeline.
  it('uses day buckets for subagent spend regardless of timeline presence', async () => {
    const startMs = localStartOfDay();
    const todayKey = localDateKey(Date.now());
    const yesterdayKey = localDateKey(startMs - 1);
    const handler = createApiHandler({
      localStore: { peekAllBuffers: () => [] },
      sessionStore: {
        loadTodaySessions: () => [
          {
            sessionId: 'bucketed-sub',
            startTime: startMs + 10_000,
            endTime: startMs + 70_000,
            estimatedCostUsd: 250.0,
            subagentCostUsd: 200.0,
            costByDayUsd: { [yesterdayKey]: 245.0, [todayKey]: 5.0 },
            subagentCostByDayUsd: { [yesterdayKey]: 196.0, [todayKey]: 4.0 },
            timeline: [],
          },
        ],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/sessions/today/aggregate' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as { totalCostUsd: number; subagentUsd: number };
    expect(parsed.totalCostUsd).toBeCloseTo(5.0, 6);
    expect(parsed.subagentUsd).toBeCloseTo(4.0, 6);
  });

  it('does not add its own live today-portion when the live session id is an unscoped aggregator (--local/proxy)', async () => {
    // A `--local` process's SubagentWatcher runs unscoped (parentSessionId:
    // undefined) — if NR_AI_WATCHER_MODE=local is set, its own live
    // CostTracker may hold cost that belongs to OTHER, already-separately-
    // persisted sessions. Adding it on top of the (empty, here) persisted-
    // sessions sum would double-count. Session id prefix 'local-' signals
    // this process is such an unscoped aggregator, not a single real session.
    const handler = createApiHandler({
      localStore: { peekAllBuffers: () => [] },
      sessionStore: {
        loadTodaySessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
      sessionTracker: {
        getMetrics: () => ({ sessionId: 'local-1785400000000', sessionStartTime: Date.now() }),
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionTracker'],
      costTracker: {
        getMetrics: () => ({ sessionTotalCostUsd: 0 }),
        getCostForDay: () => 9,
        getSubagentCostForDay: () => 6,
      } as unknown as Parameters<typeof createApiHandler>[0]['costTracker'],
    });
    const req = { method: 'GET', url: '/api/sessions/today/aggregate' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as { totalCostUsd: number; subagentUsd: number };
    expect(parsed.totalCostUsd).toBe(0);
    expect(parsed.subagentUsd).toBe(0);
  });

  it('still adds its own live today-portion for a pending-* provisional stdio session', async () => {
    // A pending-<ts> id is still exactly one real --stdio session mid
    // session-ID-resolution, not an unscoped aggregator — its live cost is
    // genuinely its own and must still be added.
    const handler = createApiHandler({
      localStore: { peekAllBuffers: () => [] },
      sessionStore: {
        loadTodaySessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
      sessionTracker: {
        getMetrics: () => ({ sessionId: 'pending-1785400000000', sessionStartTime: Date.now() }),
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionTracker'],
      costTracker: {
        getMetrics: () => ({ sessionTotalCostUsd: 0 }),
        getCostForDay: () => 9,
        getSubagentCostForDay: () => 6,
      } as unknown as Parameters<typeof createApiHandler>[0]['costTracker'],
    });
    const req = { method: 'GET', url: '/api/sessions/today/aggregate' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as { totalCostUsd: number; subagentUsd: number };
    expect(parsed.totalCostUsd).toBeCloseTo(9, 3);
    expect(parsed.subagentUsd).toBeCloseTo(6, 3);
  });

  it('sums subagentCostUsd across every persisted session today, not just the live process', async () => {
    const now = Date.now();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const startMs = startOfDay.getTime();

    const handler = createApiHandler({
      localStore: { peekAllBuffers: () => [] },
      sessionStore: {
        // Two sessions persisted by OTHER Claude Code processes — their
        // subagent activity was never seen by this process's own live
        // CostTracker/SubagentWatcher.
        loadTodaySessions: () => [
          {
            sessionId: 'other-session-A',
            startTime: startMs + 10_000,
            endTime: startMs + 20_000,
            estimatedCostUsd: 5,
            subagentCostUsd: 1.5,
          },
          {
            sessionId: 'other-session-B',
            startTime: startMs + 30_000,
            endTime: startMs + 40_000,
            estimatedCostUsd: 3,
            subagentCostUsd: 2.25,
          },
        ],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
      // This process's own live tracker never saw any subagent turns.
      costTracker: {
        getMetrics: () => ({ sessionTotalCostUsd: 0 }),
        getCostForDay: () => 0,
        getSubagentCostForDay: () => 0,
      } as unknown as Parameters<typeof createApiHandler>[0]['costTracker'],
    });
    const req = { method: 'GET', url: '/api/sessions/today/aggregate' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as { subagentUsd: number };
    // 1.5 + 2.25 — summed across both other sessions, not read from the
    // (empty) live process tracker.
    expect(parsed.subagentUsd).toBeCloseTo(3.75, 3);
  });

  it('skips events older than the start of today', async () => {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const handler = createApiHandler({
      localStore: {
        peekAllBuffers: () => [
          // Yesterday — must NOT be counted.
          { mode: 'post', sessionId: 's1', timestamp: startOfDay.getTime() - 60_000 },
          // Today
          { mode: 'post', sessionId: 's1', timestamp: startOfDay.getTime() + 1_000 },
        ],
      },
      sessionStore: {
        loadTodaySessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/sessions/today/aggregate' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as { toolCallCount: number };
    expect(parsed.toolCallCount).toBe(1);
  });

  // Bug 1 regression: a session that ran earlier in the day, persisted at
  // shutdown, and was then resumed (same sessionId, new buffer events) used
  // to drop its ENTIRE persisted timeline because the live-session check
  // skipped the inner loop. Persisted timeline + buffer cover disjoint time
  // ranges, so both must be counted. The persisted entries are strictly
  // older than any live buffer entry for the same sessionId.
  it('counts persisted timeline entries even when the session is currently live', async () => {
    const now = Date.now();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const startMs = startOfDay.getTime();

    // Persisted timeline: 200 entries between 10:00 and 12:00 (relative to
    // start of day). Buffer: 5 post events at 13:00. Same sessionId.
    const persistedTimeline = Array.from({ length: 200 }, (_, i) => ({
      timestamp: startMs + 10 * 3_600_000 + i * 1_000,
      durationMs: 10,
      toolName: 'Read',
      success: true,
    }));
    const bufferEvents = Array.from({ length: 5 }, (_, i) => ({
      mode: 'post' as const,
      sessionId: 'long-session',
      timestamp: startMs + 13 * 3_600_000 + i * 1_000,
      durationMs: 20,
    }));

    const handler = createApiHandler({
      localStore: { peekAllBuffers: () => bufferEvents },
      sessionStore: {
        loadTodaySessions: () => [
          {
            sessionId: 'long-session',
            estimatedCostUsd: 0,
            antiPatterns: [],
            timeline: persistedTimeline,
          },
        ],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
      liveSessionRegistry: {
        getLiveSessions: () => ['long-session'],
        getSessionName: () => null,
      },
    });
    const req = { method: 'GET', url: '/api/sessions/today/aggregate' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as { toolCallCount: number };
    // 200 persisted timeline entries + 5 buffer post events = 205.
    expect(parsed.toolCallCount).toBe(205);
  });

  // Bug 2: dashboards poll this endpoint every 5–10s. A 5-second TTL cache
  // collapses bursty repeat reads to one disk fan-out per bucket. Within the
  // same bucket the response payload must be identical AND we must not
  // re-invoke the disk reads.
  it('caches the aggregate response within the same 5-second bucket', async () => {
    const peekSpy = jest.fn(() => [] as never[]);
    const loadTodaySpy = jest.fn(() => [] as never[]);
    const handler = createApiHandler({
      localStore: { peekAllBuffers: peekSpy },
      sessionStore: {
        loadTodaySessions: loadTodaySpy,
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });

    const req1 = { method: 'GET', url: '/api/sessions/today/aggregate' } as IncomingMessage;
    const r1 = fakeRes();
    await handler(req1, r1.res);
    expect(r1.status()).toBe(200);
    const body1 = r1.body();

    expect(peekSpy).toHaveBeenCalledTimes(1);
    expect(loadTodaySpy).toHaveBeenCalledTimes(1);

    // Second call within the same bucket — must return identical payload
    // without re-reading disk.
    const req2 = { method: 'GET', url: '/api/sessions/today/aggregate' } as IncomingMessage;
    const r2 = fakeRes();
    await handler(req2, r2.res);
    expect(r2.status()).toBe(200);
    expect(r2.body()).toBe(body1);
    expect(peekSpy).toHaveBeenCalledTimes(1);
    expect(loadTodaySpy).toHaveBeenCalledTimes(1);

    // A third call after the TTL window must hit disk again. Simulate by
    // monkey-patching Date.now forward by 5 seconds.
    const realNow = Date.now;
    Date.now = () => realNow() + 5_001;
    try {
      const req3 = { method: 'GET', url: '/api/sessions/today/aggregate' } as IncomingMessage;
      const r3 = fakeRes();
      await handler(req3, r3.res);
      expect(r3.status()).toBe(200);
      expect(peekSpy).toHaveBeenCalledTimes(2);
      expect(loadTodaySpy).toHaveBeenCalledTimes(2);
    } finally {
      Date.now = realNow;
    }
  });

  it('averages efficiencyScore across today persisted sessions', async () => {
    const handler = createApiHandler({
      localStore: { peekAllBuffers: () => [] },
      sessionStore: {
        loadTodaySessions: () => [
          { sessionId: 'a', efficiencyScore: 0.8 },
          { sessionId: 'b', efficiencyScore: 0.6 },
          // null efficiencyScore must be excluded from the average, not treated as 0.
          { sessionId: 'c', efficiencyScore: null },
        ],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/sessions/today/aggregate' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as { avgEfficiencyScore: number | null };
    // (0.8 + 0.6) / 2 = 0.7
    expect(parsed.avgEfficiencyScore).toBeCloseTo(0.7);
  });

  it('folds in this process own live efficiency score when its session is not yet persisted', async () => {
    const handler = createApiHandler({
      localStore: { peekAllBuffers: () => [] },
      sessionStore: {
        loadTodaySessions: () => [{ sessionId: 'other', efficiencyScore: 0.5 }],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
      sessionTracker: { getMetrics: () => ({ sessionId: 'live-1' }) } as unknown as Parameters<
        typeof createApiHandler
      >[0]['sessionTracker'],
      efficiencyScorer: { getSessionAverage: () => ({ score: 0.9 }) },
    });
    const req = { method: 'GET', url: '/api/sessions/today/aggregate' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as { avgEfficiencyScore: number | null };
    // (0.5 + 0.9) / 2 = 0.7 — 'live-1' isn't in loadTodaySessions(), so its live score is added.
    expect(parsed.avgEfficiencyScore).toBeCloseTo(0.7);
  });

  it('does not double-count the live score when its session is already persisted', async () => {
    const handler = createApiHandler({
      localStore: { peekAllBuffers: () => [] },
      sessionStore: {
        loadTodaySessions: () => [{ sessionId: 'live-1', efficiencyScore: 0.5 }],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
      sessionTracker: { getMetrics: () => ({ sessionId: 'live-1' }) } as unknown as Parameters<
        typeof createApiHandler
      >[0]['sessionTracker'],
      efficiencyScorer: { getSessionAverage: () => ({ score: 0.9 }) },
    });
    const req = { method: 'GET', url: '/api/sessions/today/aggregate' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as { avgEfficiencyScore: number | null };
    // Only the persisted 0.5 counts — 'live-1' is already in loadTodaySessions(), so its
    // live 0.9 must NOT be added again.
    expect(parsed.avgEfficiencyScore).toBeCloseTo(0.5);
  });

  it('returns null avgEfficiencyScore when no session has a score yet', async () => {
    const handler = createApiHandler({
      localStore: { peekAllBuffers: () => [] },
      sessionStore: {
        loadTodaySessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/sessions/today/aggregate' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as { avgEfficiencyScore: number | null };
    expect(parsed.avgEfficiencyScore).toBeNull();
  });

  it('blends cache tokens from live buffer events and persisted sessions into cacheHealth', async () => {
    const now = Date.now();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const startMs = startOfDay.getTime();

    const handler = createApiHandler({
      localStore: {
        peekAllBuffers: () => [
          // Live, undrained token event for a session not yet persisted.
          {
            mode: 'token',
            sessionId: 'live-1',
            timestamp: startMs + 10_000,
            inputTokens: 100,
            cacheReadTokens: 300,
            cacheCreationTokens: 0,
          },
          // Yesterday — must be ignored.
          {
            mode: 'token',
            sessionId: 'live-1',
            timestamp: startMs - 1,
            inputTokens: 9_999,
            cacheReadTokens: 9_999,
            cacheCreationTokens: 0,
          },
        ],
      },
      sessionStore: {
        loadTodaySessions: () => [],
        loadSessionsOverlappingToday: () => [
          {
            sessionId: 'persisted-1',
            startTime: startMs + 1_000,
            endTime: startMs + 2_000,
            estimatedCostUsd: 0,
            tokensInput: 100,
            tokensCacheRead: 100,
            tokensCacheCreation: 0,
            cacheSavingsUsd: 0.01,
          },
        ],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/sessions/today/aggregate' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as {
      cacheHealth: {
        status: string;
        cacheHitRatePct: number | null;
        totalCacheReadTokens: number;
        totalCacheCreationTokens: number;
        totalSavingsUsd: number;
      };
    };
    // read: 300 (live) + 100 (persisted) = 400; input: 100 (live) + 100 (persisted) = 200
    // hit rate = 400 / (200 + 400 + 0) = 0.6667 -> 67%
    expect(parsed.cacheHealth.totalCacheReadTokens).toBe(400);
    expect(parsed.cacheHealth.totalCacheCreationTokens).toBe(0);
    expect(parsed.cacheHealth.cacheHitRatePct).toBe(67);
    expect(parsed.cacheHealth.totalSavingsUsd).toBeCloseTo(0.01);
    // 67% >= the 60% "excellent" threshold.
    expect(parsed.cacheHealth.status).toBe('excellent');
  });

  it("pro-rates a cross-midnight persisted session's cache tokens by todayPortionRatio", async () => {
    const now = Date.now();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const startMs = startOfDay.getTime();

    const handler = createApiHandler({
      localStore: { peekAllBuffers: () => [] },
      sessionStore: {
        loadTodaySessions: () => [],
        loadSessionsOverlappingToday: () => [
          {
            sessionId: 'cross-midnight-1',
            // Started 2h before midnight, ended 2h after — no timeline, so
            // todayPortionRatio falls back to elapsed-time overlap: 2h of 4h = 0.5.
            startTime: startMs - 2 * 60 * 60 * 1000,
            endTime: startMs + 2 * 60 * 60 * 1000,
            estimatedCostUsd: 0,
            tokensInput: 1000,
            tokensCacheRead: 1000,
            tokensCacheCreation: 0,
            cacheSavingsUsd: 1.0,
          },
        ],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/sessions/today/aggregate' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as {
      cacheHealth: { totalCacheReadTokens: number; totalSavingsUsd: number };
    };
    expect(parsed.cacheHealth.totalCacheReadTokens).toBe(500);
    expect(parsed.cacheHealth.totalSavingsUsd).toBeCloseTo(0.5);
  });

  it('tops up cacheHealth savings AND token counts with this process own live session when not yet persisted', async () => {
    const now = Date.now();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const startMs = startOfDay.getTime();

    const handler = createApiHandler({
      localStore: { peekAllBuffers: () => [] },
      sessionStore: {
        loadTodaySessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
      sessionTracker: {
        getMetrics: () => ({ sessionId: 'live-1', sessionStartTime: startMs + 5_000 }),
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionTracker'],
      costTracker: {
        getMetrics: () => ({
          totalCacheSavingsUsd: 0.25,
          totalCacheReadTokens: 800,
          totalCacheCreationTokens: 0,
          totalInputTokens: 200,
        }),
      } as unknown as Parameters<typeof createApiHandler>[0]['costTracker'],
    });
    const req = { method: 'GET', url: '/api/sessions/today/aggregate' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as {
      cacheHealth: {
        totalSavingsUsd: number;
        totalCacheReadTokens: number;
        cacheHitRatePct: number | null;
      };
    };
    // Without this top-up, totalSavingsUsd would show 0.25 while
    // totalCacheReadTokens/cacheHitRatePct stayed at 0 — an inconsistent
    // panel for the session someone is actively watching. Both must move
    // together: read tokens = 800, hit rate = 800 / (200 + 800 + 0) = 80%.
    expect(parsed.cacheHealth.totalSavingsUsd).toBeCloseTo(0.25);
    expect(parsed.cacheHealth.totalCacheReadTokens).toBe(800);
    expect(parsed.cacheHealth.cacheHitRatePct).toBe(80);
  });

  it('sums cache tokens from both the buffer and a persisted checkpoint for a session live in another process (documents the accepted no-cutoff overlap risk shared with cost/subagentUsd)', async () => {
    const now = Date.now();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const startMs = startOfDay.getTime();

    const handler = createApiHandler({
      localStore: {
        peekAllBuffers: () => [
          // peekAllBuffers() spans every process's buffer files, so this
          // shows up even though it belongs to a session this process
          // isn't running.
          {
            mode: 'token',
            sessionId: 'other-live-1',
            timestamp: startMs + 10_000,
            inputTokens: 50,
            cacheReadTokens: 200,
            cacheCreationTokens: 0,
          },
        ],
      },
      sessionStore: {
        loadTodaySessions: () => [],
        loadSessionsOverlappingToday: () => [
          {
            sessionId: 'other-live-1',
            startTime: startMs + 1_000,
            endTime: startMs + 5_000,
            estimatedCostUsd: 0,
            tokensInput: 50,
            tokensCacheRead: 200,
            tokensCacheCreation: 0,
            cacheSavingsUsd: 0.02,
          },
        ],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
      sessionTracker: {
        getMetrics: () => ({ sessionId: 'this-process-1' }),
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionTracker'],
    });
    const req = { method: 'GET', url: '/api/sessions/today/aggregate' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as {
      cacheHealth: { totalCacheReadTokens: number; totalSavingsUsd: number };
    };
    // Both sources are summed with no cross-source cutoff for a session
    // live in ANOTHER process: 200 (buffer) + 200 (persisted, ratio 1.0
    // since fully within today) = 400 read tokens. This mirrors the
    // pre-existing, equally-unguarded totalCostUsd/subagentUsd overlap in
    // the same (2b) loop — see the comment above cacheReadTokensSum's
    // accumulation in api-handler.ts. Not asserting this is "correct",
    // only that it's the known, accepted current behavior. Dollar savings
    // only comes from the persisted checkpoint (buffer 'token' events
    // carry no savings field), so it's unaffected: 0.02.
    expect(parsed.cacheHealth.totalCacheReadTokens).toBe(400);
    expect(parsed.cacheHealth.totalSavingsUsd).toBeCloseTo(0.02);
  });

  it('sets forecastEndOfDayUsd (not null) from a live buffer timestamp when no session has been persisted yet', async () => {
    const now = Date.now();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const startMs = startOfDay.getTime();

    const handler = createApiHandler({
      localStore: {
        peekAllBuffers: () => [
          { mode: 'post', sessionId: 'live-1', timestamp: startMs + 5_000, durationMs: 10 },
        ],
      },
      sessionStore: {
        loadTodaySessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/sessions/today/aggregate' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as {
      totalCostUsd: number;
      forecastEndOfDayUsd: number | null;
    };
    // No cost anywhere yet, so totalCostUsd is 0 and buildCostForecastFromInputs
    // takes its deterministic "nothing spent yet" branch (forecastEndOfDayUsd: 0,
    // not null). Asserting it's 0 rather than null proves a `dailyFirstActivityMs`
    // anchor WAS established from the buffer event — if it hadn't been, the whole
    // forecast computation would have been skipped and this would be null.
    expect(parsed.totalCostUsd).toBe(0);
    expect(parsed.forecastEndOfDayUsd).toBe(0);
  });

  it("anchors the forecast to a cross-midnight session's first TODAY-scoped timeline entry, not its startTime", async () => {
    const now = Date.now();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const startMs = startOfDay.getTime();

    // Started 1h before midnight, still active. loadTodaySessions() (file-date
    // = start date = yesterday) excludes it entirely; only
    // loadSessionsOverlappingToday() sees it. 1 of its 4 timeline entries is
    // before midnight, 3 are after -> todayPortionRatio = 0.75 -> today's cost
    // contribution is 10 * 0.75 = 7.5.
    const crossMidnightSession = {
      sessionId: 'cross-midnight-1',
      startTime: startMs - 60 * 60 * 1000,
      endTime: startMs + 10_000,
      estimatedCostUsd: 10,
      timeline: [
        { timestamp: startMs - 30 * 60 * 1000 },
        { timestamp: startMs + 1_000 },
        { timestamp: startMs + 2_000 },
        { timestamp: startMs + 3_000 },
      ],
    };

    const handler = createApiHandler({
      localStore: { peekAllBuffers: () => [] },
      sessionStore: {
        loadTodaySessions: () => [],
        loadSessionsOverlappingToday: () => [crossMidnightSession],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/sessions/today/aggregate' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as {
      totalCostUsd: number;
      forecastEndOfDayUsd: number | null;
    };
    expect(parsed.totalCostUsd).toBeCloseTo(7.5, 3);
    // Must not be null: the session has real spend today, so a null forecast
    // here means dailyFirstActivityMs was never anchored for it.
    expect(parsed.forecastEndOfDayUsd).not.toBeNull();
    // effectiveBaseUsd is totalCostUsd and the rate is >= 0, so the forecast
    // can never be less than the amount already spent today.
    expect(parsed.forecastEndOfDayUsd as number).toBeGreaterThanOrEqual(parsed.totalCostUsd);
  });

  it('returns forecastEndOfDayUsd null when there is no activity today from any source', async () => {
    const handler = createApiHandler({
      localStore: { peekAllBuffers: () => [] },
      sessionStore: {
        loadTodaySessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/sessions/today/aggregate' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as { forecastEndOfDayUsd: number | null };
    expect(parsed.forecastEndOfDayUsd).toBeNull();
  });

  it("tops up dailyFirstActivityMs from this process's own CostTracker when neither the buffer nor persisted sessions have it", async () => {
    const handler = createApiHandler({
      localStore: { peekAllBuffers: () => [] },
      sessionStore: {
        loadTodaySessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
      costTracker: {
        getMetrics: () => ({ sessionTotalCostUsd: 0 }),
        getCostForDay: () => 9,
        getFirstActivityMsForDay: () => Date.now() - 60_000,
      } as unknown as Parameters<typeof createApiHandler>[0]['costTracker'],
    });
    const req = { method: 'GET', url: '/api/sessions/today/aggregate' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as {
      totalCostUsd: number;
      forecastEndOfDayUsd: number | null;
    };
    expect(parsed.totalCostUsd).toBeCloseTo(9, 3);
    expect(parsed.forecastEndOfDayUsd).not.toBeNull();
    expect(parsed.forecastEndOfDayUsd as number).toBeGreaterThanOrEqual(parsed.totalCostUsd);
  });
});

describe('api-handler GET /api/workflows', () => {
  it('returns 503 unavailable when workflowStore dep is absent', async () => {
    const handler = createApiHandler({});
    const req = { method: 'GET', url: '/api/workflows' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(503);
    expect(JSON.parse(body())).toEqual({ error: 'unavailable', what: 'workflowStore' });
  });

  it('passes since/run_source/status query params through to listRuns() unchanged, and returns a bare array', async () => {
    const fakeRow = {
      workflow_run_id: 'wf_abc12345-6dd',
      parent_session_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      task_id: null,
      workflow_name: 'sample',
      status: 'completed',
      incomplete: false,
      error_reason: null,
      default_model: 'claude-opus-4-7',
      started_at: 1_781_652_144_959,
      duration_ms: 745_892,
      agent_count: 2,
      total_tokens: 826_463,
      total_usd: null,
      declared_phases: null,
      observed_phases: 1,
      declared_parallel_widths: [],
      token_reconciliation_delta: null,
      run_source: 'script',
      script_path: null,
      workflow_json_path: '/tmp/wf_abc12345-6dd.json',
    };
    const listRunsSpy = jest.fn(() => [fakeRow]);
    const handler = createApiHandler({
      workflowStore: {
        listRuns: listRunsSpy,
        getRun: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['workflowStore'],
    });
    const req = {
      method: 'GET',
      url: '/api/workflows?since=1000&run_source=agent_tool&status=incomplete',
    } as IncomingMessage;
    const { res, status, body, headers } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(headers()['content-type']).toMatch(/application\/json/);
    expect(listRunsSpy).toHaveBeenCalledWith({
      since: 1000,
      runSource: 'agent_tool',
      status: 'incomplete',
    });
    const parsed = JSON.parse(body());
    // Bare array, not { runs: [...] } — the SPA feeds this straight into
    // Array.isArray().
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].runId).toBe('wf_abc12345-6dd');
  });

  // An unfinished/killed run's duration_ms is null (unknown), not 0 — the
  // DTO must pass that null through unchanged rather than defaulting it.
  it('passes a null duration_ms through as durationMs: null, not 0', async () => {
    const fakeRow = {
      workflow_run_id: 'wf_abc12345-6dd',
      parent_session_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      task_id: null,
      workflow_name: 'sample',
      status: 'running',
      incomplete: true,
      error_reason: null,
      default_model: 'claude-opus-4-7',
      started_at: 1_781_652_144_959,
      duration_ms: null,
      agent_count: 2,
      total_tokens: 826_463,
      total_usd: null,
      declared_phases: null,
      observed_phases: 1,
      declared_parallel_widths: [],
      token_reconciliation_delta: null,
      run_source: 'script',
      script_path: null,
      workflow_json_path: '/tmp/wf_abc12345-6dd.json',
    };
    const handler = createApiHandler({
      workflowStore: {
        listRuns: () => [fakeRow],
        getRun: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['workflowStore'],
    });
    const req = { method: 'GET', url: '/api/workflows' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body());
    expect(parsed[0].durationMs).toBeNull();
  });
});

describe('api-handler GET /api/observability-health', () => {
  it('returns 503 unavailable when observabilityHealth dep is absent', async () => {
    const handler = createApiHandler({});
    const req = { method: 'GET', url: '/api/observability-health' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(503);
    expect(JSON.parse(body())).toEqual({ error: 'unavailable', what: 'observabilityHealth' });
  });

  it('passes through observabilityHealth.getSnapshot()', async () => {
    const snapshot = {
      watcherActive: true,
      filesWatched: 3,
      parseErrors: 0,
      watcherDisabledByLock: false,
      costSelfCheckDeltaPct: null,
      watcherDisabledReason: null,
    };
    const handler = createApiHandler({
      observabilityHealth: { getSnapshot: () => snapshot },
    });
    const req = { method: 'GET', url: '/api/observability-health' } as IncomingMessage;
    const { res, status, body, headers } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(headers()['content-type']).toMatch(/application\/json/);
    expect(JSON.parse(body())).toEqual(snapshot);
  });
});

describe('api-handler GET /api/workflows/:runId', () => {
  it('returns 503 unavailable when workflowStore dep is absent', async () => {
    const handler = createApiHandler({});
    const req = { method: 'GET', url: '/api/workflows/wf_abc12345-6dd' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(503);
    expect(JSON.parse(body())).toEqual({ error: 'unavailable', what: 'workflowStore' });
  });

  it('returns 404 {error:"not_found"} when getRun() returns null', async () => {
    const handler = createApiHandler({
      workflowStore: { listRuns: () => [], getRun: () => null },
    });
    const req = { method: 'GET', url: '/api/workflows/wf_nonexistent' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(404);
    expect(JSON.parse(body())).toEqual({ error: 'not_found' });
  });

  it('maps the run + agents + topology fields to their DTO shape when found', async () => {
    const runRow = {
      workflow_run_id: 'wf_abc12345-6dd',
      parent_session_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      task_id: 'task-1',
      workflow_name: 'sample',
      status: 'completed',
      incomplete: false,
      error_reason: null,
      default_model: 'claude-opus-4-7',
      started_at: 1_781_652_144_959,
      duration_ms: 745_892,
      agent_count: 1,
      total_tokens: 137_810,
      total_usd: 4.56,
      declared_phases: 2,
      observed_phases: 1,
      declared_parallel_widths: [1, 'dynamic'],
      token_reconciliation_delta: null,
      run_source: 'script',
      script_path: null,
      workflow_json_path: '/tmp/wf_abc12345-6dd.json',
      agents: [
        {
          agent_id: 'a45d96d201bf2f1ef',
          label: 'investigate:hooks-coverage',
          phase_index: 1,
          phase_title: 'Investigate',
          model: 'claude-opus-4-7',
          state: 'done',
          attempt: 1,
          duration_ms: 222_186,
          tokens: 137_810,
          tool_calls: 35,
          started_at: 1,
        },
      ],
      topology: {
        workflowName: 'sample',
        declaredPhases: 2,
        declaredParallelWidths: [1, 'dynamic'],
      },
    };
    const handler = createApiHandler({
      workflowStore: {
        listRuns: () => [],
        getRun: (runId: string) => (runId === 'wf_abc12345-6dd' ? runRow : null),
      } as unknown as Parameters<typeof createApiHandler>[0]['workflowStore'],
    });
    const req = { method: 'GET', url: '/api/workflows/wf_abc12345-6dd' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body());
    expect(parsed.run.runId).toBe('wf_abc12345-6dd');
    expect(parsed.run.taskId).toBe('task-1');
    expect(parsed.run.totalUsd).toBeCloseTo(4.56, 2);
    expect(parsed.agents).toHaveLength(1);
    expect(parsed.agents[0].agentId).toBe('a45d96d201bf2f1ef');
    expect(parsed.topology).toEqual(runRow.topology);
  });
});

describe('api-handler GET /api/concurrency (96-bucket grid)', () => {
  function midnightToday(): number {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function makeConcurrencyTracker(): NonNullable<
    Parameters<typeof createApiHandler>[0]['concurrencyTracker']
  > {
    return {
      getConcurrentCount: () => 0,
      getPeakConcurrent: () => 0,
      getConcurrencyTimeSeries: () => [],
    };
  }

  function makeLiveRegistry(): NonNullable<
    Parameters<typeof createApiHandler>[0]['liveSessionRegistry']
  > {
    return {
      getLiveSessions: () => [],
      getSessionName: () => null,
      getLastActivity: () => null,
    };
  }

  // Build a session timeline covering [fromMin, toMin] (minutes past local
  // midnight) with one tool-call sample per minute. Since samples sit ≤ the
  // 3-minute ACTIVITY_WINDOW_MS apart, mergeActivityWindows() folds them into a
  // single activity window [fromMin, toMin + 3min] — the same model the headline
  // peak uses, so the chart's tallest column equals the headline peak.
  function makeTimeline(fromMin: number, toMin: number): Array<{ timestamp: number }> {
    const start = midnightToday();
    const entries: Array<{ timestamp: number }> = [];
    for (let m = fromMin; m <= toMin; m++) entries.push({ timestamp: start + m * 60_000 });
    return entries;
  }

  function makeBufferRecord(sessionId: string, atMin: number): ToolCallRecord {
    return {
      id: `r-${sessionId}-${atMin}`,
      sessionId,
      toolName: 'Read',
      toolUseId: `tu-${sessionId}-${atMin}`,
      timestamp: midnightToday() + atMin * 60_000,
      durationMs: 100,
      success: true,
    };
  }

  it('returns the new bucket shape with exactly 96 buckets at 15-minute spacing', async () => {
    const handler = createApiHandler({
      concurrencyTracker: makeConcurrencyTracker(),
      liveSessionRegistry: makeLiveRegistry(),
      sessionStore: {
        loadTodaySessions: () => [],
        loadAllSessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/concurrency' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const result = JSON.parse(body());
    expect(result.bucketSizeMs).toBe(900_000);
    expect(result.startTimestamp).toBe(midnightToday());
    expect(Array.isArray(result.buckets)).toBe(true);
    expect(result.buckets).toHaveLength(96);
    // No timeSeries field on the new shape.
    expect(result.timeSeries).toBeUndefined();
    // Bucket spacing must be exactly 15 min and start at midnight.
    for (let i = 0; i < 96; i++) {
      expect(result.buckets[i].timestamp).toBe(midnightToday() + i * 900_000);
      expect(result.buckets[i].count).toBe(0);
    }
  });

  it('computes per-bucket peak concurrent sessions via sweepline', async () => {
    // Activity windows (session timelines, folded to [from, to+3min]):
    //   A active 00:00–00:17 → window [00:00, 00:20]
    //   B active 00:00–00:22 → window [00:00, 00:25]
    //   C active 00:50–00:55 → window [00:50, 00:58]
    // Bucket 0 (00:00–00:15): A + B overlap → peak=2
    // Bucket 1 (00:15–00:30): A ends 00:20, B ends 00:25 → peak=2
    // Bucket 2 (00:30–00:45): no activity → peak=0
    // Bucket 3 (00:45–01:00): only C → peak=1
    const todaySessions = [
      { sessionId: 's-a', timeline: makeTimeline(0, 17) },
      { sessionId: 's-b', timeline: makeTimeline(0, 22) },
      { sessionId: 's-c', timeline: makeTimeline(50, 55) },
    ];
    const handler = createApiHandler({
      concurrencyTracker: makeConcurrencyTracker(),
      liveSessionRegistry: makeLiveRegistry(),
      sessionStore: {
        loadTodaySessions: () => todaySessions,
        loadAllSessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/concurrency' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const result = JSON.parse(body());
    expect(result.buckets[0].count).toBe(2);
    expect(result.buckets[1].count).toBe(2);
    expect(result.buckets[2].count).toBe(0);
    expect(result.buckets[3].count).toBe(1);
    // Bucket 4 onward have no activity today → all zero
    for (let i = 4; i < 96; i++) {
      expect(result.buckets[i].count).toBe(0);
    }
    // Whole-day peak from buckets equals 2 — the actual concurrent peak.
    const maxBucket = Math.max(...result.buckets.map((b: { count: number }) => b.count));
    expect(maxBucket).toBe(2);
    // peak is still derived from livePeak/historicalPeak (NOT recomputed
    // from buckets), so it's whatever the existing path returned.
    expect(typeof result.peak).toBe('number');
  });

  it('does not exceed overall day peak in any bucket', async () => {
    // 5 sessions all active inside bucket 0 → bucket peak=5, day peak=5.
    // Session i active [i, i+5]min → window [i, i+8]; all overlap around
    // [00:04, 00:08], entirely within bucket 0.
    const todaySessions = Array.from({ length: 5 }, (_v, i) => ({
      sessionId: `s-${i}`,
      timeline: makeTimeline(i, i + 5),
    }));
    const handler = createApiHandler({
      concurrencyTracker: makeConcurrencyTracker(),
      liveSessionRegistry: makeLiveRegistry(),
      sessionStore: {
        loadTodaySessions: () => todaySessions,
        loadAllSessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/concurrency' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const result = JSON.parse(body());
    const counts = result.buckets.map((b: { count: number }) => b.count);
    const bucketMax = Math.max(...counts);
    expect(bucketMax).toBe(5);
    // Bucket peak equals day peak when peak occurs within today's window.
    for (const c of counts) expect(c).toBeLessThanOrEqual(bucketMax);
  });

  it('includes a cross-midnight session (started yesterday, still active) via loadSessionsOverlappingToday', async () => {
    // Session started 10min before local midnight and is still active 5min
    // after — loadTodaySessions() would exclude it (filename date = yesterday),
    // but loadSessionsOverlappingToday() must pick it up so its today-portion
    // still counts toward concurrency.
    const crossMidnightSessions = [{ sessionId: 'cross-midnight', timeline: makeTimeline(-10, 5) }];
    const handler = createApiHandler({
      concurrencyTracker: makeConcurrencyTracker(),
      liveSessionRegistry: makeLiveRegistry(),
      sessionStore: {
        loadTodaySessions: () => [],
        loadSessionsOverlappingToday: () => crossMidnightSessions,
        loadAllSessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/concurrency' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const result = JSON.parse(body());
    // The session is active at 00:00 (bucket 0) regardless of its 00:00-before start.
    expect(result.buckets[0].count).toBe(1);
    const maxBucket = Math.max(...result.buckets.map((b: { count: number }) => b.count));
    expect(maxBucket).toBe(1);
  });

  it("counts a live session's buffered activity as discrete 3-minute windows, not a continuous span to now", async () => {
    // A live session's not-yet-persisted activity comes from the tool-call
    // buffer. Each cluster of activity is a 3-minute window — an idle gap
    // between clusters is NOT filled (the old span model extended the session
    // to `now`, which over-counted every idle-but-live session).
    const handler = createApiHandler({
      concurrencyTracker: makeConcurrencyTracker(),
      liveSessionRegistry: {
        getLiveSessions: () => ['live-1'],
        getSessionName: () => null,
        getLastActivity: () => null,
      },
      toolCallBuffer: {
        // Activity at 00:05 (bucket 0) and again at 00:30 (bucket 2); idle
        // from 00:08 → 00:30 (bucket 1) with no buffered events.
        getRecords: () => [makeBufferRecord('live-1', 5), makeBufferRecord('live-1', 30)],
      },
      sessionStore: {
        loadTodaySessions: () => [],
        loadAllSessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/concurrency' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const result = JSON.parse(body());
    // Window [00:05, 00:08] → bucket 0; window [00:30, 00:33] → bucket 2.
    expect(result.buckets[0].count).toBe(1);
    // Idle bucket 1 is NOT filled — the two windows do not merge across the gap.
    expect(result.buckets[1].count).toBe(0);
    expect(result.buckets[2].count).toBe(1);
    expect(result.buckets[3].count).toBe(0);
  });

  it('does not double-count a session that appears in both the persisted store and the live buffer', async () => {
    // The same session id contributes a persisted timeline AND a live buffer
    // record. Their timestamps are unioned per id and merged into one window
    // set, so the session can never overlap itself.
    const handler = createApiHandler({
      concurrencyTracker: makeConcurrencyTracker(),
      liveSessionRegistry: {
        getLiveSessions: () => ['dup-1'],
        getSessionName: () => null,
        getLastActivity: () => null,
      },
      toolCallBuffer: {
        // Buffered activity at 00:07 — adjacent to the persisted 00:05–00:06
        // timeline, so it merges into a single window rather than a second one.
        getRecords: () => [makeBufferRecord('dup-1', 7)],
      },
      sessionStore: {
        loadTodaySessions: () => [{ sessionId: 'dup-1', timeline: makeTimeline(5, 6) }],
        loadAllSessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/concurrency' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const result = JSON.parse(body());
    // One merged window [00:05, 00:10] → bucket 0 count is 1, not 2.
    expect(result.buckets[0].count).toBe(1);
    const maxBucket = Math.max(...result.buckets.map((b: { count: number }) => b.count));
    expect(maxBucket).toBe(1);
  });

  it('counts a bucket peak of 2 when one session ends exactly as another starts (boundary tiebreaker matches headline peak)', async () => {
    // A active 00:00–00:07 → window [00:00, 00:10]; B active 00:10–00:17 →
    // window [00:10, 00:20]. At t=00:10 A's window closes as B's opens. With
    // the open-before-close tiebreaker (+1 fires before -1) the bucket peak is
    // 2 — matching the headline peak semantics. Close-before-open would give 1.
    const todaySessions = [
      { sessionId: 's-a', timeline: makeTimeline(0, 7) },
      { sessionId: 's-b', timeline: makeTimeline(10, 17) },
    ];
    const handler = createApiHandler({
      concurrencyTracker: makeConcurrencyTracker(),
      liveSessionRegistry: makeLiveRegistry(),
      sessionStore: {
        loadTodaySessions: () => todaySessions,
        loadAllSessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/concurrency' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const result = JSON.parse(body());
    // Bucket 0 (00:00–00:15) contains the boundary touch at 00:10. Peak=2.
    expect(result.buckets[0].count).toBe(2);
    // Bucket peak max should equal day peak (the headline `peak`), not be
    // off by 1 because of a tiebreaker mismatch.
    const maxBucket = Math.max(...result.buckets.map((b: { count: number }) => b.count));
    expect(maxBucket).toBe(2);
  });

  it('counts persisted-timeline and live-buffer activity for one session as separate windows across an idle gap', async () => {
    // The same session has persisted activity 09:00–10:00 and later live
    // buffer activity at 11:00, with an idle gap in between. Both contribute
    // (neither is dropped), but they do NOT merge into one continuous span —
    // the gap reads 0, unlike the old model which extended the session to now.
    const handler = createApiHandler({
      concurrencyTracker: makeConcurrencyTracker(),
      liveSessionRegistry: {
        getLiveSessions: () => ['sess-x'],
        getSessionName: () => null,
        getLastActivity: () => null,
      },
      toolCallBuffer: {
        // Live buffered activity at 11:00 (bucket 44), 60 min after the
        // persisted window closes — well beyond the 3-min merge threshold.
        getRecords: () => [makeBufferRecord('sess-x', 11 * 60)],
      },
      sessionStore: {
        // Persisted activity spans 09:00–10:00.
        loadTodaySessions: () => [{ sessionId: 'sess-x', timeline: makeTimeline(9 * 60, 10 * 60) }],
        loadAllSessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/concurrency' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const result = JSON.parse(body());
    // Persisted window [09:00, 10:03] → buckets 36..40 show >= 1.
    for (let i = 36; i <= 40; i++) {
      expect(result.buckets[i].count).toBeGreaterThanOrEqual(1);
    }
    // Idle gap 10:15–10:45 (buckets 41..42) is NOT filled.
    expect(result.buckets[42].count).toBe(0);
    // Live buffered window [11:00, 11:03] → bucket 44 shows 1.
    expect(result.buckets[44].count).toBe(1);
  });

  it('does not inflate the next bucket when a session ends exactly at a bucket boundary', async () => {
    // Regression: events deferred via `ts < bucketEnd` (not `<=`) left the
    // session's -1 to be processed at the START of the next bucket, after
    // peak was already initialised from the carried-over current=1, so the
    // next bucket falsely read count=1.
    // Session active 00:00–00:12 → window [00:00, 00:15], ending exactly at
    // the 15-min bucket boundary.
    const todaySessions = [{ sessionId: 's-boundary', timeline: makeTimeline(0, 12) }];
    const handler = createApiHandler({
      concurrencyTracker: makeConcurrencyTracker(),
      liveSessionRegistry: makeLiveRegistry(),
      sessionStore: {
        loadTodaySessions: () => todaySessions,
        loadAllSessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/concurrency' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const result = JSON.parse(body());
    // Bucket 0 [00:00, 00:15): session was active → count=1.
    expect(result.buckets[0].count).toBe(1);
    // Bucket 1 [00:15, 00:30): session already ended at 00:15 → count=0.
    expect(result.buckets[1].count).toBe(0);
    // All remaining buckets also 0.
    for (let i = 2; i < 96; i++) expect(result.buckets[i].count).toBe(0);
  });

  it('counts a bucket peak of 2 when one session ends exactly as another starts on a bucket grid line', async () => {
    // A active 00:00–00:12 → window [00:00, 00:15]; B active 00:15–00:22 →
    // window [00:15, 00:25]. Unlike the mid-bucket touch test above (t=00:10,
    // inside bucket0), this touch lands EXACTLY on the bucket0/bucket1 grid
    // line: both A's close and B's open fall into bucket1's flush loop
    // (events with ts <= bucketStart). Without tracking peak during that
    // flush, the momentary 2-session overlap is missed and bucket1
    // undercounts to 1.
    const todaySessions = [
      { sessionId: 's-a', timeline: makeTimeline(0, 12) },
      { sessionId: 's-b', timeline: makeTimeline(15, 22) },
    ];
    const handler = createApiHandler({
      concurrencyTracker: makeConcurrencyTracker(),
      liveSessionRegistry: makeLiveRegistry(),
      sessionStore: {
        loadTodaySessions: () => todaySessions,
        loadAllSessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/concurrency' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const result = JSON.parse(body());
    // Bucket 0 [00:00, 00:15): only A is open → count=1.
    expect(result.buckets[0].count).toBe(1);
    // Bucket 1 [00:15, 00:30): A's close and B's open both land exactly at
    // 00:15 → momentary overlap → count=2.
    expect(result.buckets[1].count).toBe(2);
    const maxBucket = Math.max(...result.buckets.map((b: { count: number }) => b.count));
    expect(maxBucket).toBe(2);
    // The headline peak is derived from these same buckets — it must agree.
    expect(result.peak).toBe(2);
  });

  it('does not fold livePeak into the headline peak (avoids reintroducing chart/headline disagreement)', async () => {
    // Chart's tallest bucket is 1 (one session, briefly active). If a stale
    // or synthetic-inflated livePeak (e.g. 5, from LiveSessionRegistry's
    // never-reset, unfiltered lifetime max) were folded into `peak` via
    // Math.max, the headline would read 5 while the tallest visible bar
    // reads 1 — reproducing the exact class of bug this route exists to
    // eliminate.
    const todaySessions = [{ sessionId: 's-a', timeline: makeTimeline(0, 5) }];
    const handler = createApiHandler({
      concurrencyTracker: {
        getConcurrentCount: () => 0,
        getPeakConcurrent: () => 5,
        getConcurrencyTimeSeries: () => [],
      },
      liveSessionRegistry: makeLiveRegistry(),
      sessionStore: {
        loadTodaySessions: () => todaySessions,
        loadAllSessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/concurrency' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const result = JSON.parse(body());
    const maxBucket = Math.max(...result.buckets.map((b: { count: number }) => b.count));
    expect(maxBucket).toBe(1);
    expect(result.peak).toBe(1);
  });

  it('preserves view=history branch unchanged', async () => {
    const handler = createApiHandler({
      concurrencyTracker: makeConcurrencyTracker(),
      liveSessionRegistry: makeLiveRegistry(),
      sessionStore: {
        loadTodaySessions: () => [],
        loadAllSessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/concurrency?view=history&days=7' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const result = JSON.parse(body());
    expect(Array.isArray(result.dailyPeaks)).toBe(true);
    expect(result.dailyPeaks).toHaveLength(7);
    // history branch must NOT include the new bucket fields
    expect(result.buckets).toBeUndefined();
    expect(result.bucketSizeMs).toBeUndefined();
  });

  it('computes real peak/allTimePeak values from live, historical, and all-time session data', async () => {
    const start = midnightToday();
    const overlapTs = start + 5 * 60_000;
    const historicalSessions = [
      { sessionId: 'h-1', timeline: [{ timestamp: overlapTs }] },
      { sessionId: 'h-2', timeline: [{ timestamp: overlapTs }] },
      { sessionId: 'h-3', timeline: [{ timestamp: overlapTs }] },
    ];
    const allTimeTs = start - 10 * 24 * 60 * 60_000;
    const allTimeSessions = [
      { sessionId: 'a-1', timeline: [{ timestamp: allTimeTs }] },
      { sessionId: 'a-2', timeline: [{ timestamp: allTimeTs }] },
      { sessionId: 'a-3', timeline: [{ timestamp: allTimeTs }] },
      { sessionId: 'a-4', timeline: [{ timestamp: allTimeTs }] },
      { sessionId: 'a-5', timeline: [{ timestamp: allTimeTs }] },
    ];
    const handler = createApiHandler({
      concurrencyTracker: { ...makeConcurrencyTracker(), getPeakConcurrent: () => 1 },
      liveSessionRegistry: makeLiveRegistry(),
      sessionStore: {
        loadTodaySessions: () => historicalSessions,
        loadAllSessions: () => allTimeSessions,
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/concurrency' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const result = JSON.parse(body());
    // livePeak=1, historicalPeak=3 (3 sessions overlapping at the same instant) → peak = max(1,3) = 3.
    expect(result.peak).toBe(3);
    // allTimePeak = max(livePeak=1, historicalPeak=3, allTimePeak=5) = 5.
    expect(result.allTimePeak).toBe(5);
  });

  it("view=history overrides today's dailyPeaks bucket with the live peak when it exceeds the disk-derived peak", async () => {
    const handler = createApiHandler({
      concurrencyTracker: { ...makeConcurrencyTracker(), getPeakConcurrent: () => 9 },
      liveSessionRegistry: makeLiveRegistry(),
      sessionStore: {
        loadTodaySessions: () => [],
        loadAllSessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/concurrency?view=history&days=3' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const result = JSON.parse(body());
    expect(result.dailyPeaks).toHaveLength(3);
    expect(result.dailyPeaks[2].peak).toBe(9);
  });

  it("view=history leaves today's dailyPeaks bucket alone when the disk-derived peak already meets the live peak", async () => {
    // Local (not UTC) midnight — computeDailyPeakConcurrency buckets by the
    // dashboard server's local day, so the overlap timestamp used
    // here to land in "today"'s bucket must be anchored the same way.
    const todayStart = localStartOfDay();
    const todayOverlapTs = todayStart + 5 * 60_000;
    const allSessions = [
      { sessionId: 'd-1', timeline: [{ timestamp: todayOverlapTs }] },
      { sessionId: 'd-2', timeline: [{ timestamp: todayOverlapTs }] },
    ];
    const handler = createApiHandler({
      concurrencyTracker: { ...makeConcurrencyTracker(), getPeakConcurrent: () => 1 },
      liveSessionRegistry: makeLiveRegistry(),
      sessionStore: {
        loadTodaySessions: () => [],
        loadAllSessions: () => allSessions,
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/concurrency?view=history&days=3' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const result = JSON.parse(body());
    expect(result.dailyPeaks).toHaveLength(3);
    expect(result.dailyPeaks[2].peak).toBe(2);
  });

  it("view=history keys each day's dailyPeaks entry by local date, not UTC", async () => {
    const handler = createApiHandler({
      concurrencyTracker: makeConcurrencyTracker(),
      liveSessionRegistry: makeLiveRegistry(),
      sessionStore: {
        loadTodaySessions: () => [],
        loadAllSessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/concurrency?view=history&days=3' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const result = JSON.parse(body());
    // Last of 3 buckets is today's — its date key must be today's *local*
    // day key, not `dayStart.toISOString().slice(0, 10)` with dayStart
    // advanced via setUTCDate/setUTCHours, which disagrees with
    // localDateKey() for any developer not in UTC.
    expect(result.dailyPeaks[2].date).toBe(localDateKey());
  });

  it('keys dailyPeaks correctly across a DST transition, where a local day is 23h (not 86_400_000ms)', async () => {
    const originalTz = process.env.TZ;
    process.env.TZ = 'America/New_York';
    jest.useFakeTimers();
    try {
      // 2026-03-08 is a "spring forward" DST transition day in
      // America/New_York — local midnight to local midnight is only 23 real
      // hours (82_800_000ms), not 86_400_000ms.
      const mar8Start = new Date(2026, 2, 8, 0, 0, 0).getTime();
      const mar9Start = mar8Start + 23 * 60 * 60_000;
      // "Today" = March 9 mid-afternoon, so days=3 covers Mar 7, 8, 9.
      jest.setSystemTime(new Date(mar9Start + 15 * 60 * 60_000));

      // Two overlapping sessions active 30 minutes into March 9 local time —
      // after the *correct* boundary (mar9Start) but still before the
      // *buggy* one (mar8Start + 86_400_000 = mar9Start + 1h).
      const overlapTs = mar9Start + 30 * 60_000;
      const sessions = [
        { sessionId: 's1', timeline: [{ timestamp: overlapTs }] },
        { sessionId: 's2', timeline: [{ timestamp: overlapTs }] },
      ];

      const handler = createApiHandler({
        concurrencyTracker: makeConcurrencyTracker(),
        liveSessionRegistry: makeLiveRegistry(),
        sessionStore: {
          loadTodaySessions: () => [],
          loadAllSessions: () => sessions,
          listSessions: () => [],
          loadSession: () => null,
        } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
      });
      const req = {
        method: 'GET',
        url: '/api/concurrency?view=history&days=3',
      } as IncomingMessage;
      const { res, status, body } = fakeRes();
      await handler(req, res);
      expect(status()).toBe(200);
      const result = JSON.parse(body());
      // 3-day window [Mar7, Mar8, Mar9] → indices [0, 1, 2].
      expect(result.dailyPeaks[1].date).toBe('2026-03-08');
      expect(result.dailyPeaks[2].date).toBe('2026-03-09');
      // A naive `dayEndMs = mar8Start + 86_400_000` (March 9 01:00 local —
      // an hour past the true DST-shortened boundary) would wrongly
      // attribute this overlap to March 8 instead of 9.
      expect(result.dailyPeaks[1].peak).toBe(0);
      expect(result.dailyPeaks[2].peak).toBe(2);
    } finally {
      jest.useRealTimers();
      // `process.env.TZ = undefined` coerces to the literal string
      // "undefined" (env vars are always strings), which then makes
      // `Intl.DateTimeFormat().resolvedOptions().timeZone` resolve to
      // "undefined" and silently breaks local-time computation for every
      // later test in this Jest worker (maxWorkers: 1) — including this
      // file's own local-vs-UTC tests. Delete the key outright when TZ was
      // never set, rather than assigning `undefined` to it.
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });

  it('counts a session seen only via peekAllBuffers in the current field', async () => {
    const now = Date.now();
    const handler = createApiHandler({
      concurrencyTracker: makeConcurrencyTracker(),
      liveSessionRegistry: {
        getLiveSessions: () => ['owned-by-this-process'],
        getSessionName: () => null,
        getLastActivity: () => now,
      },
      localStore: {
        peekAllBuffers: () => [
          { mode: 'post', sessionId: 'owned-by-other-process', timestamp: now - 1_000 },
        ],
      },
      sessionStore: {
        loadTodaySessions: () => [],
        loadAllSessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/concurrency' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const result = JSON.parse(body()) as { current: number };
    expect(result.current).toBe(2);
  });
});

import * as diagnosticsModule from '../../install/diagnostics.js';

const mockedRunDiagnostics = diagnosticsModule.runDiagnostics as jest.MockedFunction<
  typeof diagnosticsModule.runDiagnostics
>;

describe('GET /api/diagnostics', () => {
  it('returns the DiagnosticCheck array from runDiagnostics', async () => {
    const expected = [
      { check: 'Config valid', status: 'ok' as const, detail: 'loaded', fix: undefined },
    ];
    mockedRunDiagnostics.mockResolvedValue(expected);

    const handler = createApiHandler({});
    const req = { method: 'GET', url: '/api/diagnostics' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);

    expect(status()).toBe(200);
    expect(JSON.parse(body())).toEqual(expected);
  });
});

describe('GET /api/diagnostics platform forwarding', () => {
  it("forwards getActivePlatform()'s return value as the platform option to runDiagnostics", async () => {
    mockedRunDiagnostics.mockResolvedValue([]);
    const handler = createApiHandler({ getActivePlatform: () => 'cursor' });
    const req = { method: 'GET', url: '/api/diagnostics' } as IncomingMessage;
    const { res } = fakeRes();
    await handler(req, res);
    expect(mockedRunDiagnostics).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'cursor' }),
    );
  });

  it('passes platform: undefined when getActivePlatform is not provided (no change to existing Claude Code behavior)', async () => {
    mockedRunDiagnostics.mockResolvedValue([]);
    const handler = createApiHandler({});
    const req = { method: 'GET', url: '/api/diagnostics' } as IncomingMessage;
    const { res } = fakeRes();
    await handler(req, res);
    expect(mockedRunDiagnostics).toHaveBeenCalledWith(
      expect.objectContaining({ platform: undefined }),
    );
  });
});

describe('api-handler PATCH /api/settings', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeConfigFilePath(initialContent?: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-settings-test-'));
    tmpDirs.push(dir);
    const filePath = path.join(dir, 'config.json');
    if (initialContent) {
      fs.writeFileSync(filePath, JSON.stringify(initialContent, null, 2));
    }
    return filePath;
  }

  function makePatchRequest(bodyObj: unknown): IncomingMessage {
    const json = JSON.stringify(bodyObj);
    const readable = Readable.from([Buffer.from(json)]);
    const req = readable as unknown as IncomingMessage;
    req.method = 'PATCH';
    req.url = '/api/settings';
    return req;
  }

  it('returns 503 when configFilePath is missing', async () => {
    const handler = createApiHandler({});
    const req = makePatchRequest({ developer: 'x' });
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(503);
    expect(JSON.parse(body())).toEqual({ error: 'unavailable', what: 'configFilePath' });
  });

  it('returns 400 invalid_json when the request body is not valid JSON', async () => {
    const configFilePath = makeConfigFilePath({});
    const handler = createApiHandler({ configFilePath });
    const readable = Readable.from([Buffer.from('not valid json')]);
    const req = readable as unknown as IncomingMessage;
    req.method = 'PATCH';
    req.url = '/api/settings';
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(400);
    expect(JSON.parse(body())).toEqual({ error: 'invalid_json' });
  });

  it('writes a valid developer field, normalizes it, and sets restartRequired true', async () => {
    const configFilePath = makeConfigFilePath({});
    const handler = createApiHandler({ configFilePath });
    const req = makePatchRequest({ developer: 'Jane Doe' });
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(JSON.parse(body())).toEqual({ ok: true, restartRequired: true });
    const written = JSON.parse(fs.readFileSync(configFilePath, 'utf-8'));
    expect(written.developer).toBe('jane_doe');
  });

  it('rejects a non-string developer field', async () => {
    const configFilePath = makeConfigFilePath({});
    const handler = createApiHandler({ configFilePath });
    const req = makePatchRequest({ developer: 123 });
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(400);
    expect(JSON.parse(body())).toEqual({
      error: 'validation_failed',
      errors: ['developer must be a string'],
    });
  });

  it('accepts teamId as a string or null, rejects other types', async () => {
    const configFilePath = makeConfigFilePath({});
    const handler = createApiHandler({ configFilePath });

    const reqOk = makePatchRequest({ teamId: 'team-a' });
    const { res: resOk, status: statusOk } = fakeRes();
    await handler(reqOk, resOk);
    expect(statusOk()).toBe(200);

    const reqNull = makePatchRequest({ teamId: null });
    const { res: resNull, status: statusNull } = fakeRes();
    await handler(reqNull, resNull);
    expect(statusNull()).toBe(200);

    const reqBad = makePatchRequest({ teamId: 42 });
    const { res: resBad, status: statusBad, body: bodyBad } = fakeRes();
    await handler(reqBad, resBad);
    expect(statusBad()).toBe(400);
    expect(JSON.parse(bodyBad())).toEqual({
      error: 'validation_failed',
      errors: ['teamId must be string or null'],
    });
  });

  it.each([
    ['sessionBudgetUsd', 'sessionBudgetUsd must be a positive number or null'],
    ['dailyBudgetUsd', 'dailyBudgetUsd must be a positive number or null'],
    ['weeklyBudgetUsd', 'weeklyBudgetUsd must be a positive number or null'],
  ])(
    'accepts a positive number or null for %s, rejects zero/negative/non-number',
    async (field, errorMsg) => {
      const configFilePath = makeConfigFilePath({});
      const handler = createApiHandler({ configFilePath });

      const reqOk = makePatchRequest({ [field]: 10 });
      const { res: resOk, status: statusOk } = fakeRes();
      await handler(reqOk, resOk);
      expect(statusOk()).toBe(200);

      const reqNull = makePatchRequest({ [field]: null });
      const { res: resNull, status: statusNull } = fakeRes();
      await handler(reqNull, resNull);
      expect(statusNull()).toBe(200);

      const reqZero = makePatchRequest({ [field]: 0 });
      const { res: resZero, status: statusZero, body: bodyZero } = fakeRes();
      await handler(reqZero, resZero);
      expect(statusZero()).toBe(400);
      expect(JSON.parse(bodyZero())).toEqual({ error: 'validation_failed', errors: [errorMsg] });
    },
  );

  it('accepts retainSessionsDays as integer 1-365 or null, rejects out-of-range/non-integer', async () => {
    const configFilePath = makeConfigFilePath({});
    const handler = createApiHandler({ configFilePath });

    const reqOk = makePatchRequest({ retainSessionsDays: 90 });
    const { res: resOk, status: statusOk } = fakeRes();
    await handler(reqOk, resOk);
    expect(statusOk()).toBe(200);

    const reqNull = makePatchRequest({ retainSessionsDays: null });
    const { res: resNull, status: statusNull } = fakeRes();
    await handler(reqNull, resNull);
    expect(statusNull()).toBe(200);

    const reqTooHigh = makePatchRequest({ retainSessionsDays: 366 });
    const { res: resTooHigh, status: statusTooHigh, body: bodyTooHigh } = fakeRes();
    await handler(reqTooHigh, resTooHigh);
    expect(statusTooHigh()).toBe(400);
    expect(JSON.parse(bodyTooHigh())).toEqual({
      error: 'validation_failed',
      errors: ['retainSessionsDays must be integer 1-365 or null'],
    });

    const reqFloat = makePatchRequest({ retainSessionsDays: 1.5 });
    const { res: resFloat, status: statusFloat } = fakeRes();
    await handler(reqFloat, resFloat);
    expect(statusFloat()).toBe(400);
  });

  it('accepts a Slack webhook URL or null for digestWebhookUrl, rejects any other string', async () => {
    const configFilePath = makeConfigFilePath({});
    const handler = createApiHandler({ configFilePath });

    const reqOk = makePatchRequest({ digestWebhookUrl: 'https://hooks.slack.com/services/T/B/X' });
    const { res: resOk, status: statusOk } = fakeRes();
    await handler(reqOk, resOk);
    expect(statusOk()).toBe(200);

    const reqNull = makePatchRequest({ digestWebhookUrl: null });
    const { res: resNull, status: statusNull } = fakeRes();
    await handler(reqNull, resNull);
    expect(statusNull()).toBe(200);

    const reqBad = makePatchRequest({ digestWebhookUrl: 'https://evil.example.com/hook' });
    const { res: resBad, status: statusBad, body: bodyBad } = fakeRes();
    await handler(reqBad, resBad);
    expect(statusBad()).toBe(400);
    expect(JSON.parse(bodyBad())).toEqual({
      error: 'validation_failed',
      errors: [
        'digestWebhookUrl must be a Slack incoming webhook URL (https://hooks.slack.com/...) or null',
      ],
    });
  });

  it('sets restartRequired: false when the ONLY changed field is digestWebhookUrl', async () => {
    const configFilePath = makeConfigFilePath({});
    const handler = createApiHandler({ configFilePath });
    const req = makePatchRequest({
      digestWebhookUrl: 'https://hooks.slack.com/services/T/B/X',
    });
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(JSON.parse(body())).toEqual({ ok: true, restartRequired: false });
  });

  it('sets restartRequired: true when digestWebhookUrl is changed alongside any other field', async () => {
    const configFilePath = makeConfigFilePath({});
    const handler = createApiHandler({ configFilePath });
    const req = makePatchRequest({
      digestWebhookUrl: 'https://hooks.slack.com/services/T/B/X',
      teamId: 'team-a',
    });
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(JSON.parse(body())).toEqual({ ok: true, restartRequired: true });
  });

  it('rejects a non-string digestSchedule', async () => {
    const configFilePath = makeConfigFilePath({});
    const handler = createApiHandler({ configFilePath });
    const req = makePatchRequest({ digestSchedule: 42 });
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(400);
    expect(JSON.parse(body())).toEqual({
      error: 'validation_failed',
      errors: ['digestSchedule must be a string'],
    });
  });

  it('validates alerts.personal.* fields, merging into any existing personal thresholds', async () => {
    const configFilePath = makeConfigFilePath({
      alerts: { personal: { dailyCostUsd: 5, sessionCostUsd: 1 } },
    });
    const handler = createApiHandler({ configFilePath });
    const req = makePatchRequest({
      alerts: {
        personal: { efficiencyScoreMin: 0.6, stuckLoopCountMax: 3, antiPatternCountMax: 2 },
      },
    });
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(JSON.parse(body())).toEqual({ ok: true, restartRequired: true });
    const written = JSON.parse(fs.readFileSync(configFilePath, 'utf-8'));
    // Pre-existing dailyCostUsd/sessionCostUsd survive the merge; new fields added.
    expect(written.alerts.personal).toEqual({
      dailyCostUsd: 5,
      sessionCostUsd: 1,
      efficiencyScoreMin: 0.6,
      stuckLoopCountMax: 3,
      antiPatternCountMax: 2,
    });
  });

  it('rejects alerts.personal.efficiencyScoreMin outside 0-1', async () => {
    const configFilePath = makeConfigFilePath({});
    const handler = createApiHandler({ configFilePath });
    const req = makePatchRequest({ alerts: { personal: { efficiencyScoreMin: 1.5 } } });
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(400);
    expect(JSON.parse(body())).toEqual({
      error: 'validation_failed',
      errors: ['alerts.personal.efficiencyScoreMin must be 0-1'],
    });
  });

  it('rejects a negative alerts.personal.stuckLoopCountMax', async () => {
    const configFilePath = makeConfigFilePath({});
    const handler = createApiHandler({ configFilePath });
    const req = makePatchRequest({ alerts: { personal: { stuckLoopCountMax: -1 } } });
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(400);
    expect(JSON.parse(body())).toEqual({
      error: 'validation_failed',
      errors: ['alerts.personal.stuckLoopCountMax must be a non-negative integer'],
    });
  });

  it('rejects a negative alerts.personal.antiPatternCountMax', async () => {
    const configFilePath = makeConfigFilePath({});
    const handler = createApiHandler({ configFilePath });
    const req = makePatchRequest({ alerts: { personal: { antiPatternCountMax: -5 } } });
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(400);
    expect(JSON.parse(body())).toEqual({
      error: 'validation_failed',
      errors: ['alerts.personal.antiPatternCountMax must be a non-negative integer'],
    });
  });

  it('rejects a negative alerts.personal.dailyCostUsd and sessionCostUsd', async () => {
    const configFilePath = makeConfigFilePath({});
    const handler = createApiHandler({ configFilePath });
    const req = makePatchRequest({
      alerts: { personal: { dailyCostUsd: -1, sessionCostUsd: -2 } },
    });
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(400);
    expect(JSON.parse(body())).toEqual({
      error: 'validation_failed',
      errors: [
        'alerts.personal.dailyCostUsd must be a non-negative number',
        'alerts.personal.sessionCostUsd must be a non-negative number',
      ],
    });
  });

  it('accumulates multiple validation errors across unrelated fields in one response', async () => {
    const configFilePath = makeConfigFilePath({});
    const handler = createApiHandler({ configFilePath });
    const req = makePatchRequest({ developer: 123, teamId: 42, retainSessionsDays: 0 });
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(400);
    expect(JSON.parse(body())).toEqual({
      error: 'validation_failed',
      errors: [
        'developer must be a string',
        'teamId must be string or null',
        'retainSessionsDays must be integer 1-365 or null',
      ],
    });
  });

  it('does not write to disk at all when validation fails', async () => {
    const configFilePath = makeConfigFilePath({ developer: 'original' });
    const handler = createApiHandler({ configFilePath });
    const req = makePatchRequest({ developer: 999 });
    const { res, status } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(400);
    const written = JSON.parse(fs.readFileSync(configFilePath, 'utf-8'));
    expect(written.developer).toBe('original');
  });

  it('starts fresh (empty existing object) when the config file does not exist yet', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-settings-test-'));
    tmpDirs.push(dir);
    const configFilePath = path.join(dir, 'does-not-exist-yet.json');
    const handler = createApiHandler({ configFilePath });
    const req = makePatchRequest({ teamId: 'team-a' });
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(JSON.parse(body())).toEqual({ ok: true, restartRequired: true });
    const written = JSON.parse(fs.readFileSync(configFilePath, 'utf-8'));
    expect(written).toEqual({ teamId: 'team-a' });
  });
});

describe('api-handler GET /api/settings', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeConfigFile(content?: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-get-settings-test-'));
    tmpDirs.push(dir);
    const filePath = path.join(dir, 'config.json');
    if (content) fs.writeFileSync(filePath, JSON.stringify(content, null, 2));
    return filePath;
  }

  function fakeStartupConfig(): Parameters<typeof createApiHandler>[0]['config'] {
    return {
      developer: 'startup-dev',
      teamId: 'startup-team',
      sessionBudgetUsd: 10,
      dailyBudgetUsd: 50,
      weeklyBudgetUsd: 200,
      retainSessionsDays: 30,
      digestWebhookUrl: 'https://hooks.slack.com/services/T/B/STARTUP',
      digestSchedule: '0 9 * * 1',
      personalAlertThresholds: {
        dailyCostUsd: 2,
        sessionCostUsd: 0.5,
        efficiencyScoreMin: 0.5,
        stuckLoopCountMax: 5,
        antiPatternCountMax: 3,
      },
      accountId: '12345',
      appName: 'preflight-test',
      mode: 'local',
      storagePath: '/tmp/does-not-matter',
      highSecurity: false,
      licenseKey: 'NRAK-ABCDEFGHIJKLMNOP1234',
    } as unknown as Parameters<typeof createApiHandler>[0]['config'];
  }

  it('returns 503 when config is missing', async () => {
    const handler = createApiHandler({});
    const req = { method: 'GET', url: '/api/settings' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(503);
    expect(JSON.parse(body())).toEqual({ error: 'unavailable', what: 'config' });
  });

  it('falls back to startup config values when no config file exists', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-get-settings-test-'));
    tmpDirs.push(dir);
    const configFilePath = path.join(dir, 'does-not-exist.json');
    const handler = createApiHandler({ config: fakeStartupConfig(), configFilePath });
    const req = { method: 'GET', url: '/api/settings' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const result = JSON.parse(body());
    expect(result.developer).toBe('startup-dev');
    expect(result.teamId).toBe('startup-team');
    expect(result.sessionBudgetUsd).toBe(10);
    expect(result.dailyBudgetUsd).toBe(50);
    expect(result.weeklyBudgetUsd).toBe(200);
    expect(result.retainSessionsDays).toBe(30);
    expect(result.digestWebhookUrl).toBe('https://hooks.slack.com/services/T/B/STARTUP');
    expect(result.digestSchedule).toBe('0 9 * * 1');
    expect(result.alerts.personal).toEqual({
      dailyCostUsd: 2,
      sessionCostUsd: 0.5,
      efficiencyScoreMin: 0.5,
      stuckLoopCountMax: 5,
      antiPatternCountMax: 3,
    });
  });

  it('prefers disk values over startup config for every editable field, per-field', async () => {
    const configFilePath = makeConfigFile({
      developer: 'disk-dev',
      teamId: 'disk-team',
      sessionBudgetUsd: 99,
      dailyBudgetUsd: 999,
      weeklyBudgetUsd: 9999,
      retainSessionsDays: 7,
      digestWebhookUrl: 'https://hooks.slack.com/services/T/B/DISK',
      digestSchedule: '0 8 * * 2',
      alerts: {
        personal: {
          dailyCostUsd: 1,
          sessionCostUsd: 0.1,
          efficiencyScoreMin: 0.9,
          stuckLoopCountMax: 1,
          antiPatternCountMax: 1,
        },
      },
    });
    const handler = createApiHandler({ config: fakeStartupConfig(), configFilePath });
    const req = { method: 'GET', url: '/api/settings' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const result = JSON.parse(body());
    expect(result.developer).toBe('disk-dev');
    expect(result.teamId).toBe('disk-team');
    expect(result.sessionBudgetUsd).toBe(99);
    expect(result.dailyBudgetUsd).toBe(999);
    expect(result.weeklyBudgetUsd).toBe(9999);
    expect(result.retainSessionsDays).toBe(7);
    expect(result.digestWebhookUrl).toBe('https://hooks.slack.com/services/T/B/DISK');
    expect(result.digestSchedule).toBe('0 8 * * 2');
    expect(result.alerts.personal).toEqual({
      dailyCostUsd: 1,
      sessionCostUsd: 0.1,
      efficiencyScoreMin: 0.9,
      stuckLoopCountMax: 1,
      antiPatternCountMax: 1,
    });
  });

  it('falls back to startup defaults when the disk config file has invalid JSON', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-get-settings-test-'));
    tmpDirs.push(dir);
    const configFilePath = path.join(dir, 'config.json');
    fs.writeFileSync(configFilePath, 'not valid json{{{');
    const handler = createApiHandler({ config: fakeStartupConfig(), configFilePath });
    const req = { method: 'GET', url: '/api/settings' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const result = JSON.parse(body());
    expect(result.developer).toBe('startup-dev');
  });

  it('masks licenseKey to a "••••" + last-4 suffix, and reports read-only fields verbatim', async () => {
    const configFilePath = makeConfigFile({});
    const handler = createApiHandler({ config: fakeStartupConfig(), configFilePath });
    const req = { method: 'GET', url: '/api/settings' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const result = JSON.parse(body());
    expect(result.licenseKey).toBe('••••1234');
    expect(result.accountId).toBe('12345');
    expect(result.appName).toBe('preflight-test');
    expect(result.mode).toBe('local');
    expect(result.storagePath).toBe('/tmp/does-not-matter');
    expect(result.highSecurity).toBe(false);
  });

  it('returns licenseKey: null when no license key is configured', async () => {
    const configFilePath = makeConfigFile({});
    const config = { ...fakeStartupConfig(), licenseKey: undefined } as unknown as Parameters<
      typeof createApiHandler
    >[0]['config'];
    const handler = createApiHandler({ config, configFilePath });
    const req = { method: 'GET', url: '/api/settings' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(JSON.parse(body()).licenseKey).toBeNull();
  });
});

describe('api-handler POST /api/digest/send', () => {
  const tmpDirs: string[] = [];
  const originalFetch = global.fetch;

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    global.fetch = originalFetch;
  });

  function makeConfigFile(content: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-digest-send-test-'));
    tmpDirs.push(dir);
    const filePath = path.join(dir, 'config.json');
    fs.writeFileSync(filePath, JSON.stringify(content, null, 2));
    return filePath;
  }

  it('returns 503 when weeklySummaryGenerator is missing', async () => {
    const configFilePath = makeConfigFile({});
    const handler = createApiHandler({ configFilePath });
    const req = { method: 'POST', url: '/api/digest/send' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(503);
    expect(JSON.parse(body())).toEqual({ error: 'unavailable', what: 'digest' });
  });

  it('returns 503 when configFilePath is missing', async () => {
    const handler = createApiHandler({
      weeklySummaryGenerator: {
        generate: () => ({}),
        loadRecentWeeks: () => [],
      } as unknown as Parameters<typeof createApiHandler>[0]['weeklySummaryGenerator'],
    });
    const req = { method: 'POST', url: '/api/digest/send' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(503);
    expect(JSON.parse(body())).toEqual({ error: 'unavailable', what: 'digest' });
  });

  it('returns the "no webhook configured" content payload when digestWebhookUrl is unset', async () => {
    const configFilePath = makeConfigFile({});
    const handler = createApiHandler({
      configFilePath,
      weeklySummaryGenerator: {
        generate: () => ({}),
        loadRecentWeeks: () => [],
      } as unknown as Parameters<typeof createApiHandler>[0]['weeklySummaryGenerator'],
    });
    const req = { method: 'POST', url: '/api/digest/send' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const result = JSON.parse(body());
    const inner = JSON.parse(result.content[0].text);
    expect(inner.error).toBe('No webhook URL configured. Call nr_observe_subscribe_digest first.');
  });

  it('sends the digest and returns ok:true when a webhook URL is configured and the send succeeds', async () => {
    const configFilePath = makeConfigFile({
      digestWebhookUrl: 'https://hooks.slack.com/services/T/B/X',
    });
    const fakeSummary = {
      week: '2026-W29',
      totalCostUsd: 12.5,
      avgEfficiencyScore: 0.8,
      sessionCount: 4,
      antiPatternCounts: {},
    };
    global.fetch = jest.fn(async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
    const handler = createApiHandler({
      configFilePath,
      // fakeSummary only carries the fields this test asserts on; safe
      // because handleSendDigest just forwards generate()'s return value.
      weeklySummaryGenerator: {
        generate: () => fakeSummary,
        loadRecentWeeks: () => [],
      } as unknown as Parameters<typeof createApiHandler>[0]['weeklySummaryGenerator'],
    });
    const req = { method: 'POST', url: '/api/digest/send' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const result = JSON.parse(body());
    const inner = JSON.parse(result.content[0].text);
    expect(inner.ok).toBe(true);
    expect(inner.message).toBe('Digest sent successfully.');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('returns a "Failed to send digest" content payload when the webhook POST fails', async () => {
    const configFilePath = makeConfigFile({
      digestWebhookUrl: 'https://hooks.slack.com/services/T/B/X',
    });
    const fakeSummary = {
      week: '2026-W29',
      totalCostUsd: 12.5,
      avgEfficiencyScore: 0.8,
      sessionCount: 4,
      antiPatternCounts: {},
    };
    global.fetch = jest.fn(async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
    const handler = createApiHandler({
      configFilePath,
      // fakeSummary only carries the fields this test asserts on; safe
      // because handleSendDigest just forwards generate()'s return value.
      weeklySummaryGenerator: {
        generate: () => fakeSummary,
        loadRecentWeeks: () => [],
      } as unknown as Parameters<typeof createApiHandler>[0]['weeklySummaryGenerator'],
    });
    const req = { method: 'POST', url: '/api/digest/send' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const result = JSON.parse(body());
    const inner = JSON.parse(result.content[0].text);
    expect(inner.error).toMatch(/^Failed to send digest:/);
  });
});

describe('api-handler GET /api/cache-health', () => {
  it('returns 503 when costTracker is missing', async () => {
    const handler = createApiHandler({});
    const req = { method: 'GET', url: '/api/cache-health' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(503);
    expect(JSON.parse(body())).toEqual({ error: 'unavailable', what: 'costTracker' });
  });

  it('reports no_cache_activity when cacheHitRate is null', async () => {
    const handler = createApiHandler({
      costTracker: {
        getMetrics: () => ({ cacheHitRate: null }),
      } as unknown as Parameters<typeof createApiHandler>[0]['costTracker'],
    });
    const req = { method: 'GET', url: '/api/cache-health' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const result = JSON.parse(body());
    expect(result.status).toBe('no_cache_activity');
    expect(result.cache_hit_rate_pct).toBeNull();
    expect(result.week_over_week_delta_pts).toBeNull();
  });

  it.each([
    [0.75, 'excellent'],
    [0.45, 'can_improve'],
    [0.1, 'needs_attention'],
  ])('classifies cacheHitRate=%p as status=%p', async (rate, expectedStatus) => {
    const handler = createApiHandler({
      costTracker: {
        getMetrics: () => ({
          cacheHitRate: rate,
          totalCacheReadTokens: 1000,
          totalCacheCreationTokens: 200,
          totalCacheSavingsUsd: 0.5,
        }),
      } as unknown as Parameters<typeof createApiHandler>[0]['costTracker'],
    });
    const req = { method: 'GET', url: '/api/cache-health' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const result = JSON.parse(body());
    expect(result.status).toBe(expectedStatus);
    expect(result.cache_hit_rate_pct).toBe(Math.round(rate * 100));
    expect(result.total_cache_read_tokens).toBe(1000);
    expect(result.total_cache_creation_tokens).toBe(200);
    expect(result.total_savings_usd).toBe(0.5);
  });

  it('computes week_over_week_delta_pts against the today-scoped aggregate rate, excluding the current ISO week', async () => {
    const currentWeek = getIsoWeekId(new Date());
    const now = Date.now();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const startMs = startOfDay.getTime();

    const handler = createApiHandler({
      localStore: { peekAllBuffers: () => [] },
      sessionStore: {
        loadTodaySessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
      sessionTracker: {
        getMetrics: () => ({ sessionId: 'live-1', sessionStartTime: startMs + 5_000 }),
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionTracker'],
      costTracker: {
        // Lifetime cacheHitRate (0.99) deliberately disagrees with the
        // today-scoped totals below (which resolve to a 50% hit rate) —
        // the delta must be computed from the latter, matching the
        // aggregate's headline rate, not CostTracker's lifetime rate.
        getMetrics: () => ({
          cacheHitRate: 0.99,
          totalCacheReadTokens: 500,
          totalCacheCreationTokens: 0,
          totalInputTokens: 500,
          totalCacheSavingsUsd: 0,
        }),
      } as unknown as Parameters<typeof createApiHandler>[0]['costTracker'],
      trendAnalyzer: {
        computeTrends: () => ({
          weeklyCacheHitRateTrend: [
            { week: '2026-W01', value: 0.3 },
            { week: currentWeek, value: 0.99 }, // must be filtered out — it's "this week"
          ],
        }),
      },
    });
    const req = { method: 'GET', url: '/api/cache-health' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const result = JSON.parse(body());
    // today-scoped cacheHitRatePct = 500 / (500 + 500) = 50, lastWeekEntry
    // (after excluding currentWeek) = 0.3 → 30, delta = 20.
    expect(result.week_over_week_delta_pts).toBe(20);
  });

  it('returns week_over_week_delta_pts: null when there is no trend data', async () => {
    const handler = createApiHandler({
      costTracker: {
        getMetrics: () => ({ cacheHitRate: 0.5 }),
      } as unknown as Parameters<typeof createApiHandler>[0]['costTracker'],
    });
    const req = { method: 'GET', url: '/api/cache-health' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(JSON.parse(body()).week_over_week_delta_pts).toBeNull();
  });
});

describe('api-handler GET /api/quality-proxy', () => {
  it('returns 503 when qualityProxyTracker is missing', async () => {
    const handler = createApiHandler({});
    const req = { method: 'GET', url: '/api/quality-proxy' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(503);
    expect(JSON.parse(body())).toEqual({ error: 'unavailable', what: 'qualityProxyTracker' });
  });

  it('returns just this process live counts (as derived rates) when no persisted-today sessions exist', async () => {
    const tracker = new QualityProxyTracker();
    const record = (overrides: Partial<ToolCallRecord>): ToolCallRecord => ({
      id: `id-${Math.random()}`,
      sessionId: 'live1',
      toolName: 'Edit',
      toolUseId: `tu-${Math.random()}`,
      timestamp: 1,
      durationMs: 1,
      success: true,
      ...overrides,
    });
    tracker.recordToolCall(record({ toolName: 'Edit', filePath: '/a.ts', success: true }));
    tracker.recordToolCall(record({ toolName: 'Edit', filePath: '/b.ts', success: false }));
    const handler = createApiHandler({ qualityProxyTracker: tracker });
    const req = { method: 'GET', url: '/api/quality-proxy' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body());
    expect(parsed.totalSignals).toBe(2);
    expect(parsed.diffApplyRate).toBeCloseTo(0.5);
    // qualityByTurnBucket/degradationDetected/events come straight from the
    // live tracker's own getMetrics(), unchanged by aggregation.
    expect(parsed.qualityByTurnBucket).toEqual(tracker.getMetrics().qualityByTurnBucket);
    expect(parsed.degradationDetected).toBe(false);
  });

  it('combines this process live counts with every other persisted-today session, excluding its own already-persisted entry', async () => {
    const tracker = new QualityProxyTracker();
    const record = (overrides: Partial<ToolCallRecord>): ToolCallRecord => ({
      id: `id-${Math.random()}`,
      sessionId: 'sess-own',
      toolName: 'Edit',
      toolUseId: `tu-${Math.random()}`,
      timestamp: 1,
      durationMs: 1,
      success: true,
      ...overrides,
    });
    // Live, not-yet-persisted: 1 applied / 1 failed = 50% apply rate.
    tracker.recordToolCall(record({ toolName: 'Edit', filePath: '/a.ts', success: true }));
    tracker.recordToolCall(record({ toolName: 'Edit', filePath: '/c.ts', success: false }));
    const ownRawCounts = tracker.getRawCounts();
    const persistedToday = [
      {
        // Same session as the live tracker above — must NOT be double
        // counted on top of the live counts.
        sessionId: 'sess-own',
        qualityProxy: ownRawCounts,
      },
      {
        sessionId: 'sess-other',
        qualityProxy: {
          totalSignals: 8,
          diffApplyCleanCount: 8,
          diffFailCount: 0,
          testPassCount: 0,
          testFailCount: 0,
          backtrackCount: 0,
          selfCorrectionCount: 0,
        },
      },
    ] as unknown as ReturnType<
      NonNullable<Parameters<typeof createApiHandler>[0]['sessionStore']>['loadTodaySessions']
    >;
    const handler = createApiHandler({
      qualityProxyTracker: tracker,
      sessionTracker: {
        getMetrics: () =>
          ({ sessionId: 'sess-own' }) as unknown as ReturnType<
            NonNullable<Parameters<typeof createApiHandler>[0]['sessionTracker']>['getMetrics']
          >,
      },
      sessionStore: {
        loadTodaySessions: () => persistedToday,
        listSessions: () => [],
        loadSession: () => null,
      },
    });
    const req = { method: 'GET', url: '/api/quality-proxy' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body());
    // Own live (1 applied / 1 failed) is not double-counted with its own
    // persisted entry (identical) — only sess-other's 8 applies are added on
    // top: 1 (live applied) + 8 (other) = 9 applied, 1 failed => 10 total,
    // diffApplyRate = 9/10 = 0.9. A naive average of 50% and 100% would give
    // 75%, which is wrong.
    expect(parsed.totalSignals).toBe(10);
    expect(parsed.diffApplyRate).toBeCloseTo(0.9);
  });

  it('ignores persisted-today sessions with no qualityProxy field (legacy files)', async () => {
    const tracker = new QualityProxyTracker();
    const record = (overrides: Partial<ToolCallRecord>): ToolCallRecord => ({
      id: `id-${Math.random()}`,
      sessionId: 'live1',
      toolName: 'Edit',
      toolUseId: `tu-${Math.random()}`,
      timestamp: 1,
      durationMs: 1,
      success: true,
      ...overrides,
    });
    tracker.recordToolCall(record({ toolName: 'Edit', filePath: '/a.ts', success: true }));
    const persistedToday = [{ sessionId: 'sess-legacy' }] as unknown as ReturnType<
      NonNullable<Parameters<typeof createApiHandler>[0]['sessionStore']>['loadTodaySessions']
    >;
    const handler = createApiHandler({
      qualityProxyTracker: tracker,
      sessionStore: {
        loadTodaySessions: () => persistedToday,
        listSessions: () => [],
        loadSession: () => null,
      },
    });
    const req = { method: 'GET', url: '/api/quality-proxy' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body());
    expect(parsed.totalSignals).toBe(1);
    expect(parsed.diffApplyRate).toBe(1);
  });

  it("day-filters this process's own live signals to today, excluding a stale signal recorded on a prior day", async () => {
    jest.useFakeTimers();
    try {
      const tracker = new QualityProxyTracker();
      const record = (overrides: Partial<ToolCallRecord>): ToolCallRecord => ({
        id: `id-${Math.random()}`,
        sessionId: 'live1',
        toolName: 'Edit',
        toolUseId: `tu-${Math.random()}`,
        timestamp: Date.now(),
        durationMs: 1,
        success: true,
        ...overrides,
      });

      // Yesterday: a failed diff. QualityEvent.timestamp is stamped from
      // Date.now() at record time (not from the ToolCallRecord itself), so
      // this must be recorded under yesterday's mocked system time to land
      // outside today's window.
      jest.setSystemTime(new Date(2026, 5, 14, 23, 0, 0));
      tracker.recordToolCall(record({ toolName: 'Edit', filePath: '/stale.ts', success: false }));

      // Today: a clean diff — this is the only signal that should count.
      jest.setSystemTime(new Date(2026, 5, 15, 8, 0, 0));
      tracker.recordToolCall(record({ toolName: 'Edit', filePath: '/fresh.ts', success: true }));

      const handler = createApiHandler({ qualityProxyTracker: tracker });
      const req = { method: 'GET', url: '/api/quality-proxy' } as IncomingMessage;
      const { res, status, body } = fakeRes();
      await handler(req, res);
      expect(status()).toBe(200);
      const parsed = JSON.parse(body());
      // Only today's signal counts toward the top-level totals/rates —
      // yesterday's failed diff must not drag diffApplyRate down. Before the
      // fix, GET /api/quality-proxy used tracker.getRawCounts() unfiltered,
      // which would have included both signals (totalSignals: 2,
      // diffApplyRate: 0.5).
      expect(parsed.totalSignals).toBe(1);
      expect(parsed.diffApplyRate).toBe(1);
      // events/qualityByTurnBucket still reflect the tracker's whole
      // lifetime — inherently within-session signals with no persisted
      // cross-session equivalent, unaffected by the day filter above.
      expect(parsed.events).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('api-handler GET /api/tool-selection-score', () => {
  it('returns 503 when toolSelectionScorer is missing', async () => {
    const handler = createApiHandler({});
    const req = { method: 'GET', url: '/api/tool-selection-score' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(503);
    expect(JSON.parse(body())).toEqual({ error: 'unavailable', what: 'toolSelectionScorer' });
  });

  it('scores only this process live records when nothing else is wired in (no cross-process, no persisted)', async () => {
    const now = Date.now();
    const ownRecords = [
      {
        id: 'o1',
        sessionId: 'sess-own',
        toolName: 'Read',
        toolUseId: 'o1',
        timestamp: now,
        durationMs: 5,
        success: true,
        filePath: '/a.ts',
      },
      {
        id: 'o2',
        sessionId: 'sess-own',
        toolName: 'Read',
        toolUseId: 'o2',
        timestamp: now,
        durationMs: 5,
        success: true,
        filePath: '/b.ts',
      },
    ] as unknown as ReturnType<
      NonNullable<Parameters<typeof createApiHandler>[0]['toolCallBuffer']>['getRecords']
    >;
    const handler = createApiHandler({
      toolSelectionScorer: new ToolSelectionScorer(),
      toolCallBuffer: { getRecords: () => ownRecords },
    });
    const req = { method: 'GET', url: '/api/tool-selection-score' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(JSON.parse(body())).toEqual({
      score: 1,
      totalCalls: 2,
      penalizedCalls: 0,
      penalties: [],
      worstOffenders: [],
      redundantReadCount: 0,
      repeatedFailureCount: 0,
      unusedOutputCount: 0,
    });
  });

  it('returns the trivial empty result when nothing is wired in at all', async () => {
    const handler = createApiHandler({ toolSelectionScorer: new ToolSelectionScorer() });
    const req = { method: 'GET', url: '/api/tool-selection-score' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(JSON.parse(body())).toEqual({
      score: 1,
      totalCalls: 0,
      penalizedCalls: 0,
      penalties: [],
      worstOffenders: [],
      redundantReadCount: 0,
      repeatedFailureCount: 0,
      unusedOutputCount: 0,
    });
  });

  it('blends another process live activity (via peekAllBuffers pairing) into the score', async () => {
    const now = Date.now();
    // Three reads of the same file from a DIFFERENT process's live session —
    // the 3rd read (index 2, 0-based) is the first one past the "one
    // re-read is normal" allowance, so it's the one penalized.
    const peekedEvents = [
      {
        mode: 'pre',
        tool: 'Read',
        timestamp: now,
        toolUseId: 'x1',
        sessionId: 'sess-other',
        toolInput: { file_path: '/g.ts' },
      },
      {
        mode: 'post',
        tool: 'Read',
        timestamp: now,
        toolUseId: 'x1',
        sessionId: 'sess-other',
        toolOutput: {},
        outputSize: 100,
        success: true,
      },
      {
        mode: 'pre',
        tool: 'Read',
        timestamp: now + 1,
        toolUseId: 'x2',
        sessionId: 'sess-other',
        toolInput: { file_path: '/g.ts' },
      },
      {
        mode: 'post',
        tool: 'Read',
        timestamp: now + 1,
        toolUseId: 'x2',
        sessionId: 'sess-other',
        toolOutput: {},
        outputSize: 100,
        success: true,
      },
      {
        mode: 'pre',
        tool: 'Read',
        timestamp: now + 2,
        toolUseId: 'x3',
        sessionId: 'sess-other',
        toolInput: { file_path: '/g.ts' },
      },
      {
        mode: 'post',
        tool: 'Read',
        timestamp: now + 2,
        toolUseId: 'x3',
        sessionId: 'sess-other',
        toolOutput: {},
        outputSize: 100,
        success: true,
      },
    ] as unknown as ReturnType<
      NonNullable<Parameters<typeof createApiHandler>[0]['localStore']>['peekAllBuffers']
    >;
    const handler = createApiHandler({
      toolSelectionScorer: new ToolSelectionScorer(),
      localStore: { peekAllBuffers: () => peekedEvents },
    });
    const req = { method: 'GET', url: '/api/tool-selection-score' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body());
    expect(parsed.totalCalls).toBe(3);
    expect(parsed.redundantReadCount).toBe(1);
    expect(parsed.penalizedCalls).toBe(1);
    expect(parsed.score).toBe(0.97); // 1 - (1 * DEFAULT_REDUNDANT_READ_PENALTY of 0.03)
  });

  it('excludes cross-process buffer events from before today', async () => {
    const beforeToday = localStartOfDay(Date.now()) - 60_000;
    const peekedEvents = [
      {
        mode: 'pre',
        tool: 'Read',
        timestamp: beforeToday,
        toolUseId: 'y1',
        sessionId: 'sess-other',
        toolInput: { file_path: '/g.ts' },
      },
      {
        mode: 'post',
        tool: 'Read',
        timestamp: beforeToday,
        toolUseId: 'y1',
        sessionId: 'sess-other',
        toolOutput: {},
        outputSize: 100,
        success: true,
      },
    ] as unknown as ReturnType<
      NonNullable<Parameters<typeof createApiHandler>[0]['localStore']>['peekAllBuffers']
    >;
    const handler = createApiHandler({
      toolSelectionScorer: new ToolSelectionScorer(),
      localStore: { peekAllBuffers: () => peekedEvents },
    });
    const req = { method: 'GET', url: '/api/tool-selection-score' } as IncomingMessage;
    const { res, body } = fakeRes();
    await handler(req, res);
    expect(JSON.parse(body()).totalCalls).toBe(0);
  });

  it('excludes this own live session id from cross-process reconstruction (no double count)', async () => {
    const now = Date.now();
    const peekedEvents = [
      {
        mode: 'pre',
        tool: 'Read',
        timestamp: now,
        toolUseId: 'z1',
        sessionId: 'sess-own',
        toolInput: { file_path: '/g.ts' },
      },
      {
        mode: 'post',
        tool: 'Read',
        timestamp: now,
        toolUseId: 'z1',
        sessionId: 'sess-own',
        toolOutput: {},
        outputSize: 100,
        success: true,
      },
    ] as unknown as ReturnType<
      NonNullable<Parameters<typeof createApiHandler>[0]['localStore']>['peekAllBuffers']
    >;
    const handler = createApiHandler({
      toolSelectionScorer: new ToolSelectionScorer(),
      localStore: { peekAllBuffers: () => peekedEvents },
      sessionTracker: {
        getMetrics: () =>
          ({ sessionId: 'sess-own' }) as unknown as ReturnType<
            NonNullable<Parameters<typeof createApiHandler>[0]['sessionTracker']>['getMetrics']
          >,
      },
    });
    const req = { method: 'GET', url: '/api/tool-selection-score' } as IncomingMessage;
    const { res, body } = fakeRes();
    await handler(req, res);
    expect(JSON.parse(body()).totalCalls).toBe(0);
  });

  it('blends a persisted today session summary into the combined score', async () => {
    const persistedToday = [
      {
        // Real FullSessionSummary rows always carry a sessionId; give this
        // fixture a distinct one so it isn't coincidentally treated as the
        // (unset, i.e. undefined) live session in this test.
        sessionId: 'sess-other-persisted',
        toolSelectionMetrics: {
          score: 0.5,
          totalCalls: 5,
          penalizedCalls: 3,
          redundantReadCount: 0,
          repeatedFailureCount: 3,
          unusedOutputCount: 0,
        },
      },
    ] as unknown as ReturnType<
      NonNullable<Parameters<typeof createApiHandler>[0]['sessionStore']>['loadTodaySessions']
    >;
    const handler = createApiHandler({
      toolSelectionScorer: new ToolSelectionScorer(),
      sessionStore: {
        loadTodaySessions: () => persistedToday,
        listSessions: () => [],
        loadSession: () => null,
      },
    });
    const req = { method: 'GET', url: '/api/tool-selection-score' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body());
    // Combining {score:1, totalCalls:0, ...} (live, empty) with the persisted
    // summary above: repeatedFailureCount=3 * DEFAULT_REPEATED_FAILURE_PENALTY
    // of 0.08 = 0.24 raw penalty -> score = 1 - 0.24 = 0.76.
    expect(parsed.totalCalls).toBe(5);
    expect(parsed.penalizedCalls).toBe(3);
    expect(parsed.repeatedFailureCount).toBe(3);
    expect(parsed.score).toBe(0.76);
  });

  it('does not double-count this own live session when its own in-progress checkpoint is also persisted today', async () => {
    // index.ts's periodic 30s checkpoint writes THIS process's own
    // in-progress session to disk (outcome: 'in progress') with a
    // toolSelectionMetrics summary computed from the exact same in-memory
    // tool calls toolCallBuffer.getRecords() also exposes.
    // loadTodaySessions() returns that checkpoint with no exclusion, so
    // without a guard the route would sum the own session's contribution
    // twice: once via ownRecords -> liveMetrics, and again via its own
    // persisted checkpoint inside persistedSummaries.
    const now = Date.now();
    const ownSessionId = 'sess-own';
    // 3 reads of the same file: the 3rd is the first past the "one re-read
    // is normal" allowance, so it draws exactly one redundant-read penalty —
    // enough to make a doubled penalty (2x) diverge in score from the
    // correct single application.
    const ownRecords = [
      {
        id: 'r1',
        sessionId: ownSessionId,
        toolName: 'Read',
        toolUseId: 'r1',
        timestamp: now,
        durationMs: 5,
        success: true,
        filePath: '/dup.ts',
      },
      {
        id: 'r2',
        sessionId: ownSessionId,
        toolName: 'Read',
        toolUseId: 'r2',
        timestamp: now + 1,
        durationMs: 5,
        success: true,
        filePath: '/dup.ts',
      },
      {
        id: 'r3',
        sessionId: ownSessionId,
        toolName: 'Read',
        toolUseId: 'r3',
        timestamp: now + 2,
        durationMs: 5,
        success: true,
        filePath: '/dup.ts',
      },
    ] as unknown as ReturnType<
      NonNullable<Parameters<typeof createApiHandler>[0]['toolCallBuffer']>['getRecords']
    >;

    // Score the own records once with a real scorer, exactly as the
    // periodic checkpoint (buildSessionSummary in session-store.ts) would
    // have when it persisted this same session's in-progress state today.
    const scorer = new ToolSelectionScorer();
    const expectedOwnMetrics = scorer.scoreSession(
      ownRecords as unknown as Parameters<typeof scorer.scoreSession>[0],
    );
    const expectedOwnSummary = toToolSelectionSummary(expectedOwnMetrics);
    // Sanity: this fixture must actually exercise a penalty, or a doubling
    // bug wouldn't move the score and the test would pass vacuously.
    expect(expectedOwnSummary.redundantReadCount).toBe(1);
    expect(expectedOwnSummary.totalCalls).toBe(3);

    const persistedToday = [
      {
        sessionId: ownSessionId,
        toolSelectionMetrics: expectedOwnSummary,
      },
    ] as unknown as ReturnType<
      NonNullable<Parameters<typeof createApiHandler>[0]['sessionStore']>['loadTodaySessions']
    >;

    const handler = createApiHandler({
      toolSelectionScorer: new ToolSelectionScorer(),
      toolCallBuffer: { getRecords: () => ownRecords },
      sessionTracker: {
        getMetrics: () =>
          ({ sessionId: ownSessionId }) as unknown as ReturnType<
            NonNullable<Parameters<typeof createApiHandler>[0]['sessionTracker']>['getMetrics']
          >,
      },
      sessionStore: {
        loadTodaySessions: () => persistedToday,
        listSessions: () => [],
        loadSession: () => null,
      },
    });
    const req = { method: 'GET', url: '/api/tool-selection-score' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body());

    // The own session's 3 calls must be counted exactly once, not twice
    // (6) via the undeduplicated own-checkpoint-in-persistedSummaries path.
    expect(parsed.totalCalls).toBe(expectedOwnSummary.totalCalls);
    expect(parsed.penalizedCalls).toBe(expectedOwnSummary.penalizedCalls);
    expect(parsed.redundantReadCount).toBe(expectedOwnSummary.redundantReadCount);
    expect(parsed.repeatedFailureCount).toBe(expectedOwnSummary.repeatedFailureCount);
    expect(parsed.unusedOutputCount).toBe(expectedOwnSummary.unusedOutputCount);
    // Score must match the single (correct) application of penalties, not
    // the deflated score a doubled penalty would produce.
    expect(parsed.score).toBe(expectedOwnSummary.score);
  });
});

describe('api-handler GET /api/model-usage', () => {
  it('returns 503 when modelUsageTracker is missing', async () => {
    const handler = createApiHandler({});
    const req = { method: 'GET', url: '/api/model-usage' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(503);
    expect(JSON.parse(body())).toEqual({ error: 'unavailable', what: 'modelUsageTracker' });
  });

  it('returns just this process live breakdown when no persisted-today sessions exist', async () => {
    const tracker = new ModelUsageTracker();
    tracker.recordUsage('claude-sonnet-5', 1000, 500, 3.2);
    const handler = createApiHandler({ modelUsageTracker: tracker });
    const req = { method: 'GET', url: '/api/model-usage' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(JSON.parse(body())).toEqual(tracker.getMetrics());
  });

  it('combines this process live breakdown with every other persisted-today session, excluding its own already-persisted entry', async () => {
    const tracker = new ModelUsageTracker();
    // Live, not-yet-persisted: $1 / 100 output tokens.
    tracker.recordUsage('model-a', 0, 100, 1);
    const persistedToday = [
      {
        // Same session as the live tracker above — must NOT be double
        // counted on top of the live breakdown.
        sessionId: 'sess-own',
        modelBreakdown: {
          'model-a': {
            requestCount: 1,
            totalInputTokens: 0,
            totalOutputTokens: 100,
            totalCostUsd: 1,
          },
        },
      },
      {
        sessionId: 'sess-other',
        modelBreakdown: {
          'model-a': {
            requestCount: 9,
            totalInputTokens: 0,
            totalOutputTokens: 900,
            totalCostUsd: 1,
          },
        },
      },
    ] as unknown as ReturnType<
      NonNullable<Parameters<typeof createApiHandler>[0]['sessionStore']>['loadTodaySessions']
    >;
    const handler = createApiHandler({
      modelUsageTracker: tracker,
      sessionTracker: {
        getMetrics: () =>
          ({ sessionId: 'sess-own' }) as unknown as ReturnType<
            NonNullable<Parameters<typeof createApiHandler>[0]['sessionTracker']>['getMetrics']
          >,
      },
      sessionStore: {
        loadTodaySessions: () => persistedToday,
        listSessions: () => [],
        loadSession: () => null,
      },
    });
    const req = { method: 'GET', url: '/api/model-usage' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body());
    // Own live ($1/100tok) is not double-counted with its own persisted entry
    // (also $1/100tok) — only sess-other's persisted entry is added on top:
    // 100 (live) + 900 (other) = 1000 output tokens, $1 + $1 = $2 total.
    // Weighted: $2 / 1000 = $0.002/token — not the naive average of $0.01 and
    // ~$0.00111 (~$0.0056), which would be wrong.
    expect(parsed.byModel['model-a'].totalOutputTokens).toBe(1000);
    expect(parsed.byModel['model-a'].totalCostUsd).toBeCloseTo(2);
    expect(parsed.byModel['model-a'].costPerOutputToken).toBeCloseTo(0.002);
    expect(parsed.byModel['model-a'].requestCount).toBe(10);
  });

  it('ignores persisted-today sessions with no modelBreakdown field (legacy files)', async () => {
    const tracker = new ModelUsageTracker();
    tracker.recordUsage('model-a', 100, 50, 0.5);
    const persistedToday = [{ sessionId: 'sess-legacy' }] as unknown as ReturnType<
      NonNullable<Parameters<typeof createApiHandler>[0]['sessionStore']>['loadTodaySessions']
    >;
    const handler = createApiHandler({
      modelUsageTracker: tracker,
      sessionStore: {
        loadTodaySessions: () => persistedToday,
        listSessions: () => [],
        loadSession: () => null,
      },
    });
    const req = { method: 'GET', url: '/api/model-usage' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(JSON.parse(body())).toEqual(tracker.getMetrics());
  });
});

describe('api-handler GET /api/git-efficiency', () => {
  it('returns 503 when gitEfficiencyTracker is missing', async () => {
    const handler = createApiHandler({});
    const req = { method: 'GET', url: '/api/git-efficiency' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(503);
    expect(JSON.parse(body())).toEqual({ error: 'unavailable', what: 'gitEfficiencyTracker' });
  });

  it('returns gitEfficiencyTracker.getMetrics() as JSON', async () => {
    const fakeMetrics = {
      totalGitCommands: 10,
      mergeConflicts: 2,
      rebaseConflicts: 0,
      abortedOperations: 0,
      forcePushes: 0,
      resetHards: 0,
      discardedChanges: 0,
      pullCount: 2,
      pushCount: 3,
      commitCount: 5,
      branchOperations: 1,
      conflictResolutionRate: 1,
      avgConflictResolutionMs: 5000,
      staleBranchPulls: 0,
      gitCommandTimeline: [],
      conflictHistory: [],
      suggestions: [],
      bestPractices: [],
      preventionScore: 0.8,
      efficiencyScore: 0.9,
      riskIndicators: {
        syncedBeforeEditing: true,
        timeSinceLastSyncMs: 5000,
        commitsSinceLastSync: 1,
        pushRejections: 0,
        forceAfterReject: 0,
        hotFiles: [],
        usesWorktrees: false,
        usesForceWithLease: false,
        avgCommitsBetweenSyncs: null,
        commitsAheadOfMain: null,
        commitsBehindMain: null,
        sessionDurationMs: 30000,
        quickConflictResolutions: 0,
      },
      velocityMetrics: {
        avgTimeBetweenCommitsMs: 10000,
        commitBurstCount: 0,
        longestGapMs: 20000,
        worktreeCount: 0,
        buildBeforePush: null,
        testBeforePush: null,
      },
      conflictResolutionStrategy: {
        oursCount: 0,
        theirsCount: 0,
        manualMergeCount: 0,
        cherryPickCount: 0,
        totalResolutions: 0,
      },
      prMetrics: {
        created: 0,
        merged: 2,
        checksViewed: 0,
        prsUpdated: 0,
        prActivity: [],
        avgTimeToCreateMs: null,
      },
      repoContext: {
        repoName: 'preflight',
        branch: 'main',
        remoteName: 'origin',
        defaultBranch: 'main',
      },
    };
    const handler = createApiHandler({
      gitEfficiencyTracker: { getMetrics: () => fakeMetrics },
    });
    const req = { method: 'GET', url: '/api/git-efficiency' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(JSON.parse(body())).toEqual(fakeMetrics);
  });
});

describe('api-handler GET /api/git-efficiency/repos', () => {
  it('returns 503 when sessionStore is missing', async () => {
    const handler = createApiHandler({});
    const req = { method: 'GET', url: '/api/git-efficiency/repos' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(503);
    expect(JSON.parse(body())).toEqual({ error: 'unavailable', what: 'sessionStore' });
  });

  it("dedupes repo names across today's sessions and sorts them", async () => {
    const handler = createApiHandler({
      sessionStore: {
        loadTodaySessions: () => [
          { sessionId: 's1', repoName: 'zeta-repo' },
          { sessionId: 's2', repoName: 'alpha-repo' },
          { sessionId: 's3', repoName: 'alpha-repo' },
          { sessionId: 's4', repoName: null },
        ],
        loadAllSessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/git-efficiency/repos' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const result = JSON.parse(body());
    expect(result.repos).toEqual(['alpha-repo', 'zeta-repo']);
    expect(result.currentRepo).toBeNull();
  });

  it('includes and merges in the current repo from gitEfficiencyTracker', async () => {
    const handler = createApiHandler({
      sessionStore: {
        loadTodaySessions: () => [{ sessionId: 's1', repoName: 'alpha-repo' }],
        loadAllSessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
      gitEfficiencyTracker: {
        getMetrics: () => ({
          totalGitCommands: 0,
          mergeConflicts: 0,
          rebaseConflicts: 0,
          abortedOperations: 0,
          forcePushes: 0,
          resetHards: 0,
          discardedChanges: 0,
          pullCount: 0,
          pushCount: 0,
          commitCount: 0,
          branchOperations: 0,
          conflictResolutionRate: null,
          avgConflictResolutionMs: null,
          staleBranchPulls: 0,
          gitCommandTimeline: [],
          conflictHistory: [],
          suggestions: [],
          bestPractices: [],
          preventionScore: null,
          efficiencyScore: null,
          riskIndicators: {
            syncedBeforeEditing: null,
            timeSinceLastSyncMs: null,
            commitsSinceLastSync: 0,
            pushRejections: 0,
            forceAfterReject: 0,
            hotFiles: [],
            usesWorktrees: false,
            usesForceWithLease: false,
            avgCommitsBetweenSyncs: null,
            commitsAheadOfMain: null,
            commitsBehindMain: null,
            sessionDurationMs: null,
            quickConflictResolutions: 0,
          },
          velocityMetrics: {
            avgTimeBetweenCommitsMs: null,
            commitBurstCount: 0,
            longestGapMs: null,
            worktreeCount: 0,
            buildBeforePush: null,
            testBeforePush: null,
          },
          conflictResolutionStrategy: {
            oursCount: 0,
            theirsCount: 0,
            manualMergeCount: 0,
            cherryPickCount: 0,
            totalResolutions: 0,
          },
          prMetrics: {
            created: 0,
            merged: 0,
            checksViewed: 0,
            prsUpdated: 0,
            prActivity: [],
            avgTimeToCreateMs: null,
          },
          repoContext: {
            repoName: 'current-repo',
            branch: null,
            remoteName: null,
            defaultBranch: null,
          },
        }),
      },
    });
    const req = { method: 'GET', url: '/api/git-efficiency/repos' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const result = JSON.parse(body());
    expect(result.repos).toEqual(['alpha-repo', 'current-repo']);
    expect(result.currentRepo).toBe('current-repo');
  });

  it("prefers loadSessionsOverlappingToday() so a cross-midnight session's repo is not dropped from the pills", async () => {
    const handler = createApiHandler({
      sessionStore: {
        // Excluded here — its filename date is yesterday's.
        loadTodaySessions: () => [],
        // loadSessionsOverlappingToday() must supply it instead, matching
        // the day-boundary hydration path in src/index.ts.
        loadSessionsOverlappingToday: () => [
          { sessionId: 'cross-midnight', repoName: 'cross-midnight-repo' },
        ],
        loadAllSessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/git-efficiency/repos' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const result = JSON.parse(body());
    expect(result.repos).toEqual(['cross-midnight-repo']);
  });
});

describe('api-handler GET /api/context', () => {
  it('returns 503 when contextTracker is missing', async () => {
    const handler = createApiHandler({});
    const req = { method: 'GET', url: '/api/context' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(503);
    expect(JSON.parse(body())).toEqual({ error: 'unavailable', what: 'contextTracker' });
  });

  it('calls getMetrics() with undefined sessionId when no query param is given', async () => {
    const fakeMetrics = {
      turnCount: 5,
      growth: { startTokens: 1000, currentTokens: 1500, deltaTokens: 500 },
      currentBreakdown: { system: 100, tools: 200, user: 300, assistant: 400 },
      fillPercent: 42,
      contextWindow: 200000,
      toolContributions: [],
      history: [],
    };
    const getMetrics = jest.fn(() => fakeMetrics);
    const handler = createApiHandler({ contextTracker: { getMetrics } });
    const req = { method: 'GET', url: '/api/context' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(JSON.parse(body())).toEqual(fakeMetrics);
    expect(getMetrics).toHaveBeenCalledWith(undefined);
  });

  it('forwards the sessionId query param to getMetrics()', async () => {
    const fakeMetrics = {
      turnCount: 3,
      growth: { startTokens: 1000, currentTokens: 1200, deltaTokens: 200 },
      currentBreakdown: { system: 50, tools: 100, user: 150, assistant: 200 },
      fillPercent: 10,
      contextWindow: 200000,
      toolContributions: [],
      history: [],
    };
    const getMetrics = jest.fn(() => fakeMetrics);
    const handler = createApiHandler({ contextTracker: { getMetrics } });
    const req = { method: 'GET', url: '/api/context?sessionId=sess-abc' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(JSON.parse(body())).toEqual(fakeMetrics);
    expect(getMetrics).toHaveBeenCalledWith('sess-abc');
  });

  it("recomputes metrics from peekAllBuffers when this process's own registry has zero turns for the session", async () => {
    const emptyMetrics = {
      turnCount: 0,
      growth: { startTokens: 0, currentTokens: 0, deltaTokens: 0 },
      currentBreakdown: { system: 0, tools: 0, user: 0, assistant: 0 },
      fillPercent: 0,
      contextWindow: 200_000,
      toolContributions: [],
      history: [],
    };
    const handler = createApiHandler({
      contextTracker: { getMetrics: () => emptyMetrics },
      localStore: {
        peekAllBuffers: () => [
          {
            mode: 'post',
            sessionId: 'sess-other-process',
            timestamp: 1_000,
            tool: 'Read',
            outputSize: 40_000,
          },
          {
            mode: 'token',
            sessionId: 'sess-other-process',
            timestamp: 2_000,
            inputTokens: 10_000,
            outputTokens: 5_000,
            cacheReadTokens: 50_000,
            cacheCreationTokens: 20_000,
            model: 'claude-opus-4-6',
          },
        ],
      },
    });
    const req = {
      method: 'GET',
      url: '/api/context?sessionId=sess-other-process',
    } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const result = JSON.parse(body()) as { turnCount: number; fillPercent: number };
    expect(result.turnCount).toBe(1);
    // claude-opus-4-6 has a 1M context window, so the recomputed tracker grows
    // past the 200K default: 80,000 / 1,000,000 = 8%.
    expect(result.fillPercent).toBe(8);
  });

  it('falls back to the empty local default when no buffer events match the session either', async () => {
    const emptyMetrics = {
      turnCount: 0,
      growth: { startTokens: 0, currentTokens: 0, deltaTokens: 0 },
      currentBreakdown: { system: 0, tools: 0, user: 0, assistant: 0 },
      fillPercent: 0,
      contextWindow: 200_000,
      toolContributions: [],
      history: [],
    };
    const handler = createApiHandler({
      contextTracker: { getMetrics: () => emptyMetrics },
      localStore: {
        peekAllBuffers: () => [{ mode: 'token', sessionId: 'unrelated-session', timestamp: 2_000 }],
      },
    });
    const req = {
      method: 'GET',
      url: '/api/context?sessionId=sess-with-no-data',
    } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(JSON.parse(body())).toEqual(emptyMetrics);
  });
});

describe('api-handler GET /api/context-composition', () => {
  it('returns 503 when contextCompositionTracker is missing', async () => {
    const handler = createApiHandler({});
    const req = { method: 'GET', url: '/api/context-composition' } as IncomingMessage;
    const { res, status } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(503);
  });

  it('returns context composition metrics as JSON', async () => {
    const fakeMetrics = {
      currentFillPercent: 62,
      currentBreakdown: {
        system_prompt: 1000,
        conversation_history: 3000,
        tool_results: 5000,
        injected_file_content: 500,
        other: 100,
      },
      turnCount: 5,
      thresholdAlerts: [],
      dominanceAlerts: [],
      history: [],
      note: '',
    };
    const handler = createApiHandler({
      contextCompositionTracker: { getMetrics: () => fakeMetrics } as unknown as Parameters<
        typeof createApiHandler
      >[0]['contextCompositionTracker'],
    });
    const req = { method: 'GET', url: '/api/context-composition' } as IncomingMessage;
    const { res, status, body, headers } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(headers()['content-type']).toMatch(/application\/json/);
    expect(JSON.parse(body())).toEqual(fakeMetrics);
  });
});

describe('api-handler GET /api/context-efficiency', () => {
  it('returns 503 when contextEfficiencyTracker is missing', async () => {
    const handler = createApiHandler({});
    const req = { method: 'GET', url: '/api/context-efficiency' } as IncomingMessage;
    const { res, status } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(503);
  });

  it('returns context efficiency metrics as JSON', async () => {
    const fakeMetrics = {
      uniqueFilesRead: 12,
      totalReadOperations: 20,
      repeatedReadCount: 8,
      repeatedReadRatio: 0.4,
      topRepeatedFiles: [{ file: 'src/index.ts', readCount: 4 }],
    };
    const handler = createApiHandler({
      contextEfficiencyTracker: { getMetrics: () => fakeMetrics } as unknown as Parameters<
        typeof createApiHandler
      >[0]['contextEfficiencyTracker'],
    });
    const req = { method: 'GET', url: '/api/context-efficiency' } as IncomingMessage;
    const { res, status, body, headers } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(headers()['content-type']).toMatch(/application\/json/);
    expect(JSON.parse(body())).toEqual(fakeMetrics);
  });
});

describe('buildContextReplayEvents', () => {
  it('maps a post event to a tool replay event using tool/outputSize fields', () => {
    const events = buildContextReplayEvents(
      [{ mode: 'post', sessionId: 'sess-1', timestamp: 1_000, tool: 'Bash', outputSize: 500 }],
      'sess-1',
    );
    expect(events).toEqual([
      { kind: 'tool', timestamp: 1_000, toolName: 'Bash', outputSizeBytes: 500 },
    ]);
  });

  it('maps a token event to a token replay event, defaulting missing numeric fields to 0', () => {
    const events = buildContextReplayEvents(
      [{ mode: 'token', sessionId: 'sess-1', timestamp: 2_000, inputTokens: 100 }],
      'sess-1',
    );
    expect(events).toEqual([
      {
        kind: 'token',
        timestamp: 2_000,
        inputTokens: 100,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        model: 'unknown',
      },
    ]);
  });

  it('ignores pre events and events belonging to a different session', () => {
    const events = buildContextReplayEvents(
      [
        { mode: 'pre', sessionId: 'sess-1', timestamp: 1_000, tool: 'Bash' },
        { mode: 'post', sessionId: 'sess-2', timestamp: 1_000, tool: 'Bash', outputSize: 500 },
      ],
      'sess-1',
    );
    expect(events).toEqual([]);
  });

  it('skips events with a non-numeric timestamp', () => {
    const events = buildContextReplayEvents(
      [{ mode: 'token', sessionId: 'sess-1', timestamp: 'not-a-number', inputTokens: 100 }],
      'sess-1',
    );
    expect(events).toEqual([]);
  });
});

describe('api-handler GET /api/activity-heatmap', () => {
  it('returns view=today buckets sized to elapsed time since local midnight', async () => {
    const handler = createApiHandler({
      toolCallBuffer: { getRecords: () => [] },
      sessionStore: {
        loadTodaySessions: () => [],
        loadAllSessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/activity-heatmap?view=today' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const result = JSON.parse(body());
    expect(result.bucketSizeMs).toBe(900_000);
    expect(Array.isArray(result.buckets)).toBe(true);
    expect(result.buckets.length).toBeGreaterThan(0);
    expect(result.maxCount).toBeGreaterThanOrEqual(1);
  });

  it('defaults to view=today when no view param is given', async () => {
    const handler = createApiHandler({
      toolCallBuffer: { getRecords: () => [] },
      sessionStore: {
        loadTodaySessions: () => [],
        loadAllSessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/activity-heatmap' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(JSON.parse(body()).bucketSizeMs).toBe(900_000);
  });

  it('buckets both toolCallBuffer records and today-sessions timeline entries by 15-minute window', async () => {
    const now = Date.now();
    const startMs = new Date(now);
    startMs.setHours(0, 0, 0, 0);
    const start = startMs.getTime();
    const handler = createApiHandler({
      toolCallBuffer: {
        getRecords: () =>
          [
            {
              id: 'r1',
              sessionId: 's1',
              toolName: 'Read',
              toolUseId: 't1',
              timestamp: start + 60_000,
              durationMs: 10,
              success: true,
            },
          ] as unknown as ReturnType<
            NonNullable<Parameters<typeof createApiHandler>[0]['toolCallBuffer']>['getRecords']
          >,
      },
      sessionStore: {
        loadTodaySessions: () => [
          {
            sessionId: 's2',
            timeline: [{ timestamp: start + 61_000, toolName: 'Edit', success: true }],
          },
        ],
        loadAllSessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/activity-heatmap?view=today' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const result = JSON.parse(body());
    // Both events land in bucket 0 (00:00-00:15) → count 2.
    expect(result.buckets[0]).toBe(2);
  });

  it('includes a cross-midnight session (started yesterday, still active) via loadSessionsOverlappingToday', async () => {
    const now = Date.now();
    const startMs = new Date(now);
    startMs.setHours(0, 0, 0, 0);
    const start = startMs.getTime();
    const handler = createApiHandler({
      toolCallBuffer: { getRecords: () => [] },
      sessionStore: {
        // Excluded by loadTodaySessions() — its filename date is yesterday's.
        loadTodaySessions: () => [],
        // loadSessionsOverlappingToday() must supply it instead. Its timeline
        // has one entry before local midnight (must be excluded from the
        // bucket count) and one entry after (must be included).
        loadSessionsOverlappingToday: () => [
          {
            sessionId: 'cross-midnight',
            timeline: [
              { timestamp: start - 60_000, toolName: 'Read', success: true },
              { timestamp: start + 61_000, toolName: 'Edit', success: true },
            ],
          },
        ],
        loadAllSessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/activity-heatmap?view=today' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const result = JSON.parse(body());
    // Only the post-midnight entry counts.
    expect(result.buckets[0]).toBe(1);
  });

  it('returns view=history days aggregated by local date, walking each timeline entry rather than attributing the whole toolCallCount to the start day', async () => {
    const todayStart = localStartOfDay();
    const todayKey = localDateKey(todayStart);
    const handler = createApiHandler({
      sessionStore: {
        loadTodaySessions: () => [],
        loadAllSessions: () => [
          {
            startTime: todayStart + 60_000,
            // Must be IGNORED — only the timeline entries below should be
            // counted (mirroring the already-correct view=today branch).
            toolCallCount: 999,
            timeline: [
              { timestamp: todayStart + 60_000 },
              { timestamp: todayStart + 120_000 },
              { timestamp: todayStart + 180_000 },
            ],
          },
        ],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = {
      method: 'GET',
      url: '/api/activity-heatmap?view=history&weeks=1',
    } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const result = JSON.parse(body());
    expect(Array.isArray(result.days)).toBe(true);
    const todayEntry = result.days.find((d: { date: string }) => d.date === todayKey);
    expect(todayEntry).toBeDefined();
    expect(todayEntry.count).toBe(3);
    expect(result.maxCount).toBeGreaterThanOrEqual(3);
  });

  it("attributes a cross-midnight session's timeline entries to the local day each one actually happened on, not the session's start day", async () => {
    const todayStart = localStartOfDay();
    const todayKey = localDateKey(todayStart);
    const yesterdayEntryTs = todayStart - 1_800_000; // 30 min before local midnight
    const yesterdayKey = localDateKey(yesterdayEntryTs);
    const handler = createApiHandler({
      sessionStore: {
        loadTodaySessions: () => [],
        loadAllSessions: () => [
          {
            // Started yesterday evening...
            startTime: todayStart - 3_600_000,
            // ...and the OLD code would have dumped this whole count onto
            // yesterday's bucket (the start day) and left today's at 0.
            toolCallCount: 10,
            timeline: [
              { timestamp: yesterdayEntryTs },
              { timestamp: todayStart + 600_000 },
              { timestamp: todayStart + 1_200_000 },
            ],
          },
        ],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = {
      method: 'GET',
      url: '/api/activity-heatmap?view=history&weeks=2',
    } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const result = JSON.parse(body());
    const todayEntry = result.days.find((d: { date: string }) => d.date === todayKey);
    const yesterdayEntry = result.days.find((d: { date: string }) => d.date === yesterdayKey);
    expect(todayEntry?.count).toBe(2);
    expect(yesterdayEntry?.count).toBe(1);
  });

  it('falls back to attributing toolCallCount to the start day for a session with no timeline field, instead of contributing zero', async () => {
    const todayStart = localStartOfDay();
    const todayKey = localDateKey(todayStart);
    const handler = createApiHandler({
      sessionStore: {
        loadTodaySessions: () => [],
        loadAllSessions: () => [
          {
            // `timeline` was only added to persisted sessions ~2026-06-02
            // (session-store.ts) — this route's default 12-week window
            // still reaches sessions saved before that field existed. Such
            // a session has no `timeline` property at all (not an empty
            // array).
            startTime: todayStart + 60_000,
            toolCallCount: 5,
          },
        ],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = {
      method: 'GET',
      url: '/api/activity-heatmap?view=history&weeks=1',
    } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const result = JSON.parse(body());
    const todayEntry = result.days.find((d: { date: string }) => d.date === todayKey);
    // A bare `if (!session.timeline) continue;` would skip this session
    // entirely, silently zeroing out all history predating the timeline
    // field instead of falling back to the old (still non-zero)
    // toolCallCount/start-day attribution.
    expect(todayEntry?.count).toBe(5);
  });

  it("uses the tz query param, not the server process's own timezone, for view=today", async () => {
    jest.useFakeTimers();
    try {
      const now = Date.UTC(2026, 5, 10, 12, 0, 0);
      jest.setSystemTime(now);

      // Asia/Kolkata (UTC+5:30), computed via the same shared helper the
      // route itself calls, so this test is not tied to any one host
      // timezone. Guard against a vacuous scenario by checking Kolkata
      // against an explicit UTC computation — not against "whatever this
      // test process's own default timezone happens to be" (that would
      // itself go vacuous, and wrongly fail this guard, if the suite ever
      // ran with TZ=Asia/Kolkata or an equal-offset zone like Asia/Colombo).
      const kolkataStart = localStartOfDay(now, 'Asia/Kolkata');
      expect(kolkataStart).not.toBe(localStartOfDay(now, 'UTC'));
      const defaultStart = localStartOfDay(now);

      const recordTs = kolkataStart + 60_000;
      const handler = createApiHandler({
        toolCallBuffer: {
          getRecords: () =>
            [
              {
                id: 'r1',
                sessionId: 's1',
                toolName: 'Read',
                toolUseId: 't1',
                timestamp: recordTs,
                durationMs: 10,
                success: true,
              },
            ] as unknown as ReturnType<
              NonNullable<Parameters<typeof createApiHandler>[0]['toolCallBuffer']>['getRecords']
            >,
        },
        sessionStore: {
          loadTodaySessions: () => [],
          loadAllSessions: () => [],
          listSessions: () => [],
          loadSession: () => null,
        } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
      });

      const reqWithTz = {
        method: 'GET',
        url: '/api/activity-heatmap?view=today&tz=Asia%2FKolkata',
      } as IncomingMessage;
      const { res: resWithTz, status: statusWithTz, body: bodyWithTz } = fakeRes();
      await handler(reqWithTz, resWithTz);
      expect(statusWithTz()).toBe(200);
      const resultWithTz = JSON.parse(bodyWithTz());
      expect(resultWithTz.startTimestamp).toBe(kolkataStart);
      expect((resultWithTz.buckets as number[]).reduce((sum, n) => sum + n, 0)).toBe(1);

      const reqWithoutTz = {
        method: 'GET',
        url: '/api/activity-heatmap?view=today',
      } as IncomingMessage;
      const { res: resNoTz, status: statusNoTz, body: bodyNoTz } = fakeRes();
      await handler(reqWithoutTz, resNoTz);
      expect(statusNoTz()).toBe(200);
      const resultNoTz = JSON.parse(bodyNoTz());
      expect(resultNoTz.startTimestamp).toBe(defaultStart);
    } finally {
      jest.useRealTimers();
    }
  });

  it("uses the tz query param, not the server process's own timezone, for view=history day-keying", async () => {
    jest.useFakeTimers();
    try {
      const now = Date.UTC(2026, 5, 10, 12, 0, 0);
      jest.setSystemTime(now);

      const kolkataStart = localStartOfDay(now, 'Asia/Kolkata');
      // See the view=today test above for why this guards against UTC
      // specifically rather than against this process's own default tz.
      expect(kolkataStart).not.toBe(localStartOfDay(now, 'UTC'));

      const entryTs = kolkataStart + 60_000;
      const kolkataKey = localDateKey(entryTs, 'Asia/Kolkata');
      const defaultKey = localDateKey(entryTs);
      const handler = createApiHandler({
        sessionStore: {
          loadTodaySessions: () => [],
          loadAllSessions: () => [
            {
              startTime: entryTs,
              toolCallCount: 1,
              timeline: [{ timestamp: entryTs }],
            },
          ],
          listSessions: () => [],
          loadSession: () => null,
        } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
      });

      const reqWithTz = {
        method: 'GET',
        url: '/api/activity-heatmap?view=history&weeks=1&tz=Asia%2FKolkata',
      } as IncomingMessage;
      const { res: resWithTz, status: statusWithTz, body: bodyWithTz } = fakeRes();
      await handler(reqWithTz, resWithTz);
      expect(statusWithTz()).toBe(200);
      const resultWithTz = JSON.parse(bodyWithTz());
      const kolkataDay = (resultWithTz.days as Array<{ date: string; count: number }>).find(
        (d) => d.date === kolkataKey,
      );
      expect(kolkataDay?.count).toBe(1);

      const reqWithoutTz = {
        method: 'GET',
        url: '/api/activity-heatmap?view=history&weeks=1',
      } as IncomingMessage;
      const { res: resNoTz, status: statusNoTz, body: bodyNoTz } = fakeRes();
      await handler(reqWithoutTz, resNoTz);
      expect(statusNoTz()).toBe(200);
      const resultNoTz = JSON.parse(bodyNoTz());
      const defaultDay = (resultNoTz.days as Array<{ date: string; count: number }>).find(
        (d) => d.date === defaultKey,
      );
      expect(defaultDay?.count).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it("falls back to the server's own timezone (200, not 500) when tz is not a recognized IANA name", async () => {
    // Intl.DateTimeFormat throws a RangeError on an unrecognized timeZone —
    // reachable without any client bug via ICU version skew between the
    // browser and this server's Node/ICU. That must degrade to the default
    // behavior for the whole panel, not surface as a 500.
    jest.useFakeTimers();
    try {
      const now = Date.UTC(2026, 5, 10, 12, 0, 0);
      jest.setSystemTime(now);
      const handler = createApiHandler({
        toolCallBuffer: { getRecords: () => [] },
        sessionStore: {
          loadTodaySessions: () => [],
          loadAllSessions: () => [],
          listSessions: () => [],
          loadSession: () => null,
        } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
      });
      const req = {
        method: 'GET',
        url: '/api/activity-heatmap?view=today&tz=Not%2FARealZone',
      } as IncomingMessage;
      const { res, status, body } = fakeRes();
      await handler(req, res);
      expect(status()).toBe(200);
      expect(JSON.parse(body()).startTimestamp).toBe(localStartOfDay(now));
    } finally {
      jest.useRealTimers();
    }
  });

  it('trims whitespace from tz before validating and forwarding it', async () => {
    jest.useFakeTimers();
    try {
      const now = Date.UTC(2026, 5, 10, 12, 0, 0);
      jest.setSystemTime(now);
      const kolkataStart = localStartOfDay(now, 'Asia/Kolkata');

      const handler = createApiHandler({
        toolCallBuffer: { getRecords: () => [] },
        sessionStore: {
          loadTodaySessions: () => [],
          loadAllSessions: () => [],
          listSessions: () => [],
          loadSession: () => null,
        } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
      });
      // Leading space (`%20`) is inside the emptiness check but must not
      // survive into what's actually forwarded to localStartOfDay — a
      // space-padded IANA name would otherwise fail Intl.DateTimeFormat's
      // validation and silently fall back to the server's own timezone
      // instead of Kolkata.
      const req = {
        method: 'GET',
        url: '/api/activity-heatmap?view=today&tz=%20Asia%2FKolkata',
      } as IncomingMessage;
      const { res, status, body } = fakeRes();
      await handler(req, res);
      expect(status()).toBe(200);
      expect(JSON.parse(body()).startTimestamp).toBe(kolkataStart);
    } finally {
      jest.useRealTimers();
    }
  });

  it('returns 400 invalid_view for an unrecognized view param', async () => {
    const handler = createApiHandler({});
    const req = { method: 'GET', url: '/api/activity-heatmap?view=bogus' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(400);
    expect(JSON.parse(body())).toEqual({
      error: 'invalid_view',
      message: 'Use view=today or view=history',
    });
  });

  it('returns 500 internal_error when computing the response throws', async () => {
    const handler = createApiHandler({
      toolCallBuffer: {
        getRecords: () => {
          throw new Error('boom');
        },
      },
    });
    const req = { method: 'GET', url: '/api/activity-heatmap?view=today' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(500);
    expect(JSON.parse(body())).toEqual({ error: 'internal_error' });
  });
});

describe('api-handler GET /api/workflows/:runId', () => {
  const RUN_ID = 'wf_abc12345-6dd';
  const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  type Deps = Parameters<typeof createApiHandler>[0];

  it('serves the on-disk rollup (200) when the run has terminated', async () => {
    const handler = createApiHandler({
      workflowStore: {
        listRuns: () => [],
        getRun: (id: string) => {
          expect(id).toBe(RUN_ID);
          return {
            workflow_run_id: RUN_ID,
            parent_session_id: SESSION,
            workflow_name: 'demo',
            status: 'completed',
            incomplete: false,
            default_model: 'claude-opus-4-7',
            started_at: 1000,
            duration_ms: 5000,
            agent_count: 1,
            total_tokens: 430,
            total_usd: 0.02,
            observed_phases: 2,
            declared_parallel_widths: [],
            token_reconciliation_delta: 0,
            run_source: 'script',
            workflow_json_path: '/x/wf.json',
            agents: [],
            topology: null,
          };
        },
      } as unknown as Deps['workflowStore'],
    });
    const req = { method: 'GET', url: `/api/workflows/${RUN_ID}` } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body());
    expect(parsed.run.status).toBe('completed');
    expect(parsed.run.runId).toBe(RUN_ID);
  });

  it('falls back to a live detail (200, status running) when no rollup exists yet', async () => {
    const handler = createApiHandler({
      workflowStore: {
        listRuns: () => [],
        getRun: () => null, // still running → no rollup on disk
      } as unknown as Deps['workflowStore'],
      subagentTimeline: {
        getSubagentsForSession: () => ({ window: { startMs: 0, endMs: 0 }, agents: [] }),
        getAgentCalls: () => ({ calls: [] }),
        getRunLive: (id: string) => {
          expect(id).toBe(RUN_ID);
          return {
            runId: RUN_ID,
            parentSessionId: SESSION,
            workflowName: 'live-demo',
            defaultModel: 'claude-opus-4-7',
            startedAt: 1000,
            durationMs: 20000,
            agentCount: 1,
            totalTokens: 430,
            totalUsd: 0.02,
            scriptPath: '/x/scripts/live-demo-wf_abc12345-6dd.js',
            topology: {
              workflowName: 'live-demo',
              declaredPhases: 2,
              declaredPhaseCalls: 2,
              declaredAgents: 1,
              declaredParallelWidths: [],
            },
            agents: [
              {
                agentId: 'a45d96d201bf2f1ef',
                label: 'agent a45d96d2',
                model: 'claude-opus-4-7',
                durationMs: 20000,
                tokens: 430,
                toolCalls: 3,
                startedAt: 1000,
              },
            ],
          };
        },
      } as unknown as Deps['subagentTimeline'],
    });
    const req = { method: 'GET', url: `/api/workflows/${RUN_ID}` } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body());
    expect(parsed.run.status).toBe('running');
    expect(parsed.run.incomplete).toBe(true);
    expect(parsed.run.runId).toBe(RUN_ID);
    expect(parsed.run.workflowName).toBe('live-demo');
    expect(parsed.run.workflowJsonPath).toBe('');
    expect(parsed.agents).toHaveLength(1);
    expect(parsed.agents[0].state).toBe('running');
    expect(parsed.agents[0].toolCalls).toBe(3);
    expect(parsed.topology.declaredPhases).toBe(2);
  });

  it('falls back to the runId as the name when the live script name is absent', async () => {
    const handler = createApiHandler({
      workflowStore: {
        listRuns: () => [],
        getRun: () => null,
      } as unknown as Deps['workflowStore'],
      subagentTimeline: {
        getSubagentsForSession: () => ({ window: { startMs: 0, endMs: 0 }, agents: [] }),
        getAgentCalls: () => ({ calls: [] }),
        getRunLive: () => ({
          runId: RUN_ID,
          parentSessionId: SESSION,
          workflowName: null,
          defaultModel: '',
          startedAt: 1000,
          durationMs: 0,
          agentCount: 1,
          totalTokens: 10,
          totalUsd: null,
          scriptPath: null,
          topology: null,
          agents: [
            {
              agentId: 'a45d96d201bf2f1ef',
              label: 'agent a45d96d2',
              model: '',
              durationMs: 0,
              tokens: 10,
              toolCalls: 0,
              startedAt: 1000,
            },
          ],
        }),
      } as unknown as Deps['subagentTimeline'],
    });
    const req = { method: 'GET', url: `/api/workflows/${RUN_ID}` } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body());
    expect(parsed.run.workflowName).toBe(RUN_ID);
    expect(parsed.run.totalUsd).toBeNull();
    expect(parsed.topology).toBeNull();
  });

  it('404s when neither a rollup nor live data exists', async () => {
    const handler = createApiHandler({
      workflowStore: {
        listRuns: () => [],
        getRun: () => null,
      } as unknown as Deps['workflowStore'],
      subagentTimeline: {
        getSubagentsForSession: () => ({ window: { startMs: 0, endMs: 0 }, agents: [] }),
        getAgentCalls: () => ({ calls: [] }),
        getRunLive: () => null,
      } as unknown as Deps['subagentTimeline'],
    });
    const req = { method: 'GET', url: `/api/workflows/${RUN_ID}` } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(404);
    expect(JSON.parse(body())).toEqual({ error: 'not_found' });
  });

  it('404s when the run is absent and no subagentTimeline dep is wired', async () => {
    const handler = createApiHandler({
      workflowStore: {
        listRuns: () => [],
        getRun: () => null,
      } as unknown as Deps['workflowStore'],
    });
    const req = { method: 'GET', url: `/api/workflows/${RUN_ID}` } as IncomingMessage;
    const { res, status } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(404);
  });
});

describe('computeCrossProcessLiveSessionIds', () => {
  it('unions registry-live ids with recent buffer-only ids', () => {
    const now = Date.now();
    const ids = computeCrossProcessLiveSessionIds({
      liveSessionRegistry: { getLiveSessions: () => ['from-registry'], getSessionName: () => null },
      localStore: {
        peekAllBuffers: () => [
          { mode: 'post', sessionId: 'from-buffer-only', timestamp: now - 1_000 },
        ],
      },
    } as unknown as Parameters<typeof createApiHandler>[0]);
    expect(ids.sort()).toEqual(['from-buffer-only', 'from-registry']);
  });

  it('excludes buffer ids older than the staleness threshold', () => {
    const now = Date.now();
    const ids = computeCrossProcessLiveSessionIds({
      liveSessionRegistry: { getLiveSessions: () => [], getSessionName: () => null },
      localStore: {
        peekAllBuffers: () => [
          { mode: 'post', sessionId: 'stale', timestamp: now - 200_000 },
          { mode: 'post', sessionId: 'fresh', timestamp: now - 1_000 },
        ],
      },
    } as unknown as Parameters<typeof createApiHandler>[0]);
    expect(ids).toEqual(['fresh']);
  });

  it('excludes synthetic session ids seen only via the buffer', () => {
    const now = Date.now();
    const ids = computeCrossProcessLiveSessionIds({
      liveSessionRegistry: { getLiveSessions: () => [], getSessionName: () => null },
      localStore: {
        peekAllBuffers: () => [
          { mode: 'post', sessionId: 'local-1730000000000', timestamp: now - 1_000 },
          { mode: 'post', sessionId: 'real-session', timestamp: now - 1_000 },
        ],
      },
    } as unknown as Parameters<typeof createApiHandler>[0]);
    expect(ids).toEqual(['real-session']);
  });

  it('dedups an id present in both the registry and the buffer', () => {
    const now = Date.now();
    const ids = computeCrossProcessLiveSessionIds({
      liveSessionRegistry: { getLiveSessions: () => ['shared'], getSessionName: () => null },
      localStore: {
        peekAllBuffers: () => [{ mode: 'post', sessionId: 'shared', timestamp: now - 1_000 }],
      },
    } as unknown as Parameters<typeof createApiHandler>[0]);
    expect(ids).toEqual(['shared']);
  });

  it('returns an empty array when neither dependency is available', () => {
    const ids = computeCrossProcessLiveSessionIds({} as Parameters<typeof createApiHandler>[0]);
    expect(ids).toEqual([]);
  });
});

describe('api-handler — session_intent is never exposed on the HTTP surface', () => {
  // session_intent (the first user prompt) is SENSITIVE content: captured only
  // under recordContent, redacted, and persisted for the MCP tools + 0o600 disk
  // summary — but the dashboard HTTP surface is broader, so every route that
  // returns a session must drop it. These guard against a regression that would
  // silently leak intent while every other assertion stays green.
  const INTENT = 'redacted first prompt text';

  const summaryWithIntent = {
    sessionId: 'sess-intent-1',
    startTime: Date.now() - 5000,
    toolCallCount: 10,
    developer: 'alice',
    sessionName: 'my session',
    sessionNameSource: 'ai-title',
    sessionIntent: INTENT,
  };

  it('GET /api/session/current strips sessionIntent from live metrics', async () => {
    const handler = createApiHandler({
      sessionTracker: {
        getMetrics: () => ({ sessionId: 'sess-intent-1', toolCallCount: 3, sessionIntent: INTENT }),
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionTracker'],
    });
    const req = { method: 'GET', url: '/api/session/current' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body());
    expect('sessionIntent' in parsed).toBe(false);
  });

  it('GET /api/session/today strips sessionIntent from each summary', async () => {
    const handler = createApiHandler({
      sessionStore: {
        loadTodaySessions: () => [summaryWithIntent],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/session/today' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as Array<Record<string, unknown>>;
    expect(parsed.length).toBe(1);
    expect('sessionIntent' in parsed[0]!).toBe(false);
    // the non-sensitive fields still come through
    expect(parsed[0]!.sessionName).toBe('my session');
  });

  it('GET /api/sessions strips sessionIntent from the slimmed list', async () => {
    const handler = createApiHandler({
      sessionStore: {
        loadAllSessions: () => [summaryWithIntent],
        loadTodaySessions: () => [],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/sessions' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as Array<Record<string, unknown>>;
    expect(parsed.length).toBe(1);
    expect('sessionIntent' in parsed[0]!).toBe(false);
  });

  it('GET /api/sessions/:id strips sessionIntent from the detail response', async () => {
    const handler = createApiHandler({
      sessionStore: {
        loadTodaySessions: () => [],
        listSessions: () => [],
        loadSession: (id: string) => (id === 'sess-intent-1' ? summaryWithIntent : null),
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
    });
    const req = { method: 'GET', url: '/api/sessions/sess-intent-1' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as Record<string, unknown>;
    expect('sessionIntent' in parsed).toBe(false);
    expect(parsed.sessionName).toBe('my session');
  });
});
