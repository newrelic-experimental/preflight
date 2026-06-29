import { jest } from '@jest/globals';
import { createApiHandler } from './api-handler.js';
import { IncomingMessage, ServerResponse } from 'node:http';

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
});

describe('api-handler GET /api/cost', () => {
  it('returns cost and forecast as JSON', async () => {
    const fakeCost = { sessionTotalCostUsd: 0.25, costByModel: { 'claude-sonnet': 0.25 } };
    const fakeForecast = { forecastEndOfDayUsd: 2.5, spentUsd: 0.25 };
    const handler = createApiHandler({
      costTracker: { getMetrics: () => fakeCost } as unknown as Parameters<
        typeof createApiHandler
      >[0]['costTracker'],
      costForecast: () => fakeForecast,
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
      },
      {
        ts: ts2,
        sessionId: 'session-a',
        tool: 'Bash',
        target: 'rm -rf /tmp/foo',
        classification: 'destructive_command',
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
  it('returns latency metrics as JSON', async () => {
    const fakeLatencyMetrics = {
      p50ByTool: { Read: 50, Edit: 100, Bash: 200 },
      p95ByTool: { Read: 150, Edit: 300, Bash: 600 },
      p99ByTool: { Read: 250, Edit: 500, Bash: 1000 },
    };
    const handler = createApiHandler({
      latencyTracker: { getMetrics: () => fakeLatencyMetrics } as unknown as Parameters<
        typeof createApiHandler
      >[0]['latencyTracker'],
    });
    const req = { method: 'GET', url: '/api/latency' } as IncomingMessage;
    const { res, status, body, headers } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(headers()['content-type']).toMatch(/application\/json/);
    expect(JSON.parse(body())).toEqual(fakeLatencyMetrics);
  });

  it('returns 503 when latencyTracker is missing', async () => {
    const handler = createApiHandler({});
    const req = { method: 'GET', url: '/api/latency' } as IncomingMessage;
    const { res, status } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(503);
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
        readRecent: async (limit: number) => {
          receivedLimit = limit;
          return fakeEntries;
        },
      },
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
});

// ---------------------------------------------------------------------------
// Task #17 (D3): cross-session aggregate + live session list
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

  it('filters synthetic session IDs (local- and proxy- prefixes) from the response', async () => {
    const ids = ['local-1234567890', 'real-session-abc', 'proxy-9876543210'];
    const handler = createApiHandler({
      liveSessionRegistry: {
        getLiveSessions: () => ids,
        getSessionName: () => null,
        getLastActivity: () => null,
      },
      toolCallBuffer: { getRecords: () => [] },
    });
    const req = { method: 'GET', url: '/api/sessions/live' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as Array<{ sessionId: string }>;
    expect(parsed.map((p) => p.sessionId)).toEqual(['real-session-abc']);
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
    // Pre-fix this returned 5.
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
    const start = midnightToday();
    const fifteen = 900_000;
    // Bucket 0 (00:00–00:15): two sessions overlap fully → peak=2
    // Bucket 1 (00:15–00:30): one session ends at 00:20, another spans → peak=2
    //   - sessions A=[start, start+20min], B=[start, start+25min] overlap in bucket 1
    //     up to start+20min then only B → peak=2
    // Bucket 2 (00:30–00:45): no sessions → peak=0
    // Bucket 3 (00:45–01:00): one session [start+50min, start+58min] → peak=1
    const todaySessions = [
      { sessionId: 's-a', startTime: start, endTime: start + 20 * 60_000 },
      { sessionId: 's-b', startTime: start, endTime: start + 25 * 60_000 },
      { sessionId: 's-c', startTime: start + 50 * 60_000, endTime: start + 58 * 60_000 },
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
    // Bucket 4 onward have no sessions today → all zero
    for (let i = 4; i < 96; i++) {
      expect(result.buckets[i].count).toBe(0);
    }
    // Whole-day peak from buckets equals 2 — the actual concurrent peak.
    const maxBucket = Math.max(...result.buckets.map((b: { count: number }) => b.count));
    expect(maxBucket).toBe(2);
    // peak is still derived from livePeak/historicalPeak (NOT recomputed
    // from buckets), so it's whatever the existing path returned.
    expect(typeof result.peak).toBe('number');
    // Reference unused local to keep eslint happy — the bucket size is the
    // grid's invariant width.
    expect(fifteen).toBe(900_000);
  });

  it('does not exceed overall day peak in any bucket', async () => {
    const start = midnightToday();
    // 5 sessions all overlapping in bucket 0 → bucket peak=5, day peak=5
    const todaySessions = Array.from({ length: 5 }, (_v, i) => ({
      sessionId: `s-${i}`,
      startTime: start + i * 60_000, // staggered by 1 min
      endTime: start + 14 * 60_000, // all end inside bucket 0
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

  it('treats live sessions as extending to "now" using the buffer for startTime', async () => {
    const start = midnightToday();
    const realNow = Date.now;
    // Pin Date.now to a known instant well past midnight so live extension
    // lands in a predictable bucket.
    const mockNow = start + 32 * 60_000; // 00:32 — bucket 2
    Date.now = () => mockNow;
    try {
      const handler = createApiHandler({
        concurrencyTracker: makeConcurrencyTracker(),
        liveSessionRegistry: {
          getLiveSessions: () => ['live-1'],
          getSessionName: () => null,
          getLastActivity: () => mockNow,
        },
        toolCallBuffer: {
          getRecords: () => [
            // Live session's first observed event is at 00:05 (bucket 0)
            {
              id: 'r1',
              sessionId: 'live-1',
              toolName: 'Read',
              toolUseId: 'tu1',
              timestamp: start + 5 * 60_000,
              durationMs: 100,
              success: true,
            },
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
      const result = JSON.parse(body());
      // Live session [00:05, 00:32) overlaps buckets 0, 1, 2.
      expect(result.buckets[0].count).toBe(1);
      expect(result.buckets[1].count).toBe(1);
      expect(result.buckets[2].count).toBe(1);
      // Bucket 3 (00:45–01:00) is in the future relative to mockNow → 0.
      expect(result.buckets[3].count).toBe(0);
    } finally {
      Date.now = realNow;
    }
  });

  it('dedupes a session that appears in both persisted store and live registry', async () => {
    const start = midnightToday();
    const realNow = Date.now;
    const mockNow = start + 30 * 60_000; // 00:30
    Date.now = () => mockNow;
    try {
      const handler = createApiHandler({
        concurrencyTracker: makeConcurrencyTracker(),
        liveSessionRegistry: {
          getLiveSessions: () => ['dup-1'],
          getSessionName: () => null,
          getLastActivity: () => mockNow,
        },
        toolCallBuffer: {
          getRecords: () => [
            {
              id: 'r1',
              sessionId: 'dup-1',
              toolName: 'Read',
              toolUseId: 'tu1',
              timestamp: start + 5 * 60_000,
              durationMs: 100,
              success: true,
            },
          ],
        },
        sessionStore: {
          loadTodaySessions: () => [
            // Same session id, partial flush had endTime in the past.
            { sessionId: 'dup-1', startTime: start, endTime: start + 10 * 60_000 },
          ],
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
      // Only one session counted — bucket 1 (00:15–00:30) sees the live
      // interval [00:05, 00:30), so peak=1, not 2 (no double-count).
      expect(result.buckets[1].count).toBe(1);
    } finally {
      Date.now = realNow;
    }
  });

  it('counts a bucket peak of 2 when one session ends exactly as another starts (boundary tiebreaker matches headline peak)', async () => {
    const start = midnightToday();
    // Sessions A=[00:00, 00:10] and B=[00:10, 00:20]. At t=00:10 A closes
    // as B opens. With open-before-close tiebreaker (the +1 fires before
    // the -1), the bucket peak should be 2 — matching the headline peak
    // semantics. The previous tiebreaker (close-before-open) would have
    // produced 1.
    const todaySessions = [
      { sessionId: 's-a', startTime: start, endTime: start + 10 * 60_000 },
      { sessionId: 's-b', startTime: start + 10 * 60_000, endTime: start + 20 * 60_000 },
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

  it('keeps persisted startTime when the same id is also live (does not regress to buffer.firstTs)', async () => {
    const start = midnightToday();
    const realNow = Date.now;
    const mockNow = start + 12 * 60 * 60_000; // 12:00
    Date.now = () => mockNow;
    try {
      const handler = createApiHandler({
        concurrencyTracker: makeConcurrencyTracker(),
        liveSessionRegistry: {
          getLiveSessions: () => ['sess-x'],
          getSessionName: () => null,
          getLastActivity: () => mockNow,
        },
        toolCallBuffer: {
          // Buffer was drained recently; earliest buffered event is at 11:00.
          getRecords: () => [
            {
              id: 'r1',
              sessionId: 'sess-x',
              toolName: 'Read',
              toolUseId: 'tu1',
              timestamp: start + 11 * 60 * 60_000,
              durationMs: 100,
              success: true,
            },
          ],
        },
        sessionStore: {
          // Authoritative persisted record knows the real start: 09:00.
          loadTodaySessions: () => [
            {
              sessionId: 'sess-x',
              startTime: start + 9 * 60 * 60_000,
              endTime: start + 10 * 60 * 60_000,
            },
          ],
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
      // Resulting interval should be [09:00, 12:00). Buckets covering
      // 09:00–11:00 (inclusive of bucket starts at 09:00, 09:15, ..., 10:45)
      // must show count >= 1, proving the persisted startTime survived.
      // Bucket index for 09:00 = (9*60)/15 = 36. Bucket for 10:45 = 43.
      for (let i = 36; i <= 43; i++) {
        expect(result.buckets[i].count).toBeGreaterThanOrEqual(1);
      }
    } finally {
      Date.now = realNow;
    }
  });

  it('excludes synthetic-id (local-/proxy-) persisted sessions from bucket counts', async () => {
    const start = midnightToday();
    const todaySessions = [
      // Synthetic id — must be filtered out, contributes 0.
      { sessionId: 'local-abc123', startTime: start, endTime: start + 20 * 60_000 },
      // Real id — should still contribute.
      { sessionId: 'real-session-1', startTime: start, endTime: start + 20 * 60_000 },
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
    // Bucket 0 should see only the one real session, not both → count=1.
    expect(result.buckets[0].count).toBe(1);
    expect(result.buckets[1].count).toBe(1);
  });

  it('does not inflate the next bucket when a session ends exactly at a bucket boundary', async () => {
    // Regression: events deferred via `ts < bucketEnd` (not `<=`) left the
    // session's -1 to be processed at the START of the next bucket, after
    // peak was already initialised from the carried-over current=1, so the
    // next bucket falsely read count=1.
    const start = midnightToday();
    const fifteen = 900_000; // 15 min in ms
    const todaySessions = [
      // Session ends exactly at the 15-min bucket boundary (t=15min).
      { sessionId: 's-boundary', startTime: start, endTime: start + fifteen },
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
    // Bucket 0 [00:00, 00:15): session was active → count=1.
    expect(result.buckets[0].count).toBe(1);
    // Bucket 1 [00:15, 00:30): session already ended at 00:15 → count=0.
    expect(result.buckets[1].count).toBe(0);
    // All remaining buckets also 0.
    for (let i = 2; i < 96; i++) expect(result.buckets[i].count).toBe(0);
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
});
