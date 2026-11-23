import { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createApiHandler } from './api-handler.js';
import { localDateKey, localStartOfDay } from '../../lib/date.js';
import {
  SessionStore,
  deserializeFullSessionSummary,
  type FullSessionSummary,
} from '../../storage/session-store.js';
import type { ReplayTimelineEntry } from '../../storage/types.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

function noonDaysAgo(days: number): number {
  return localStartOfDay(localStartOfDay() - days * DAY_MS + 12 * HOUR_MS) + 12 * HOUR_MS;
}

function calls(at: number, n: number): ReplayTimelineEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: at + i * 60_000,
    toolName: 'Read',
    durationMs: null,
    success: true,
  }));
}

// The load path's parser fills every field a test leaves out.
function makeSummary(overrides: Partial<FullSessionSummary>): FullSessionSummary {
  return deserializeFullSessionSummary({ sessionId: 'sess', ...overrides } as Parameters<
    typeof deserializeFullSessionSummary
  >[0]);
}

async function get(store: SessionStore, url: string): Promise<Record<string, unknown>> {
  let status = 0;
  let body = '';
  const res = {
    writeHead: (s: number) => {
      status = s;
    },
    setHeader: () => undefined,
    end: (chunk?: string) => {
      if (chunk) body += chunk;
    },
    headersSent: false,
  } as unknown as ServerResponse;
  // The windowed paths read persisted sessions only, never the live tracker.
  const turnCostAttributor = {
    getMetrics: () => {
      throw new Error('windowed path read the live tracker');
    },
  } as unknown as Parameters<typeof createApiHandler>[0]['turnCostAttributor'];
  await createApiHandler({ sessionStore: store, turnCostAttributor })(
    { method: 'GET', url } as IncomingMessage,
    res,
  );
  expect(status).toBe(200);
  return JSON.parse(body) as Record<string, unknown>;
}

describe('windowed dashboard views and resumed sessions', () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'windowed-activity-'));
    store = new SessionStore({ storagePath: dir });
    const started = noonDaysAgo(20);
    const resumed = noonDaysAgo(2);
    // Started 20 days ago and resumed 2 days ago: $3 and 3 calls before the
    // 7-day window, $1 and 2 calls inside it.
    store.saveSession(
      makeSummary({
        sessionId: 'resumed',
        startTime: started,
        endTime: resumed + HOUR_MS,
        durationMs: resumed + HOUR_MS - started,
        toolCallCount: 5,
        estimatedCostUsd: 4,
        costByDayUsd: { [localDateKey(started)]: 3, [localDateKey(resumed)]: 1 },
        timeline: [...calls(started, 3), ...calls(resumed, 2)],
        attribution: {
          buckets: {
            tool: { Read: { costUsd: 2, tokens: 400, count: 4, durationMs: 0 } },
            skill: { unslop: { costUsd: 2, tokens: 400, count: 1, durationMs: 0 } },
          },
          highContextCostUsd: 0,
          apiDurationMs: null,
        },
      }),
    );
    // Wholly before the window, though its file was written just now.
    store.saveSession(
      makeSummary({
        sessionId: 'old',
        startTime: started,
        endTime: started + HOUR_MS,
        durationMs: HOUR_MS,
        toolCallCount: 1,
        estimatedCostUsd: 7,
        costByDayUsd: { [localDateKey(started)]: 7 },
        timeline: calls(started, 1),
      }),
    );
    // Resumed once, half a day before the window opened.
    const justBefore = Date.now() - 7.5 * DAY_MS;
    store.saveSession(
      makeSummary({
        sessionId: 'just-before',
        startTime: started,
        endTime: justBefore + HOUR_MS,
        durationMs: justBefore + HOUR_MS - started,
        toolCallCount: 2,
        estimatedCostUsd: 6,
        costByDayUsd: { [localDateKey(started)]: 1, [localDateKey(justBefore)]: 5 },
        timeline: [...calls(started, 1), ...calls(justBefore, 1)],
      }),
    );
    const fresh = noonDaysAgo(1);
    store.saveSession(
      makeSummary({
        sessionId: 'fresh',
        startTime: fresh,
        endTime: fresh + HOUR_MS,
        durationMs: HOUR_MS,
        toolCallCount: 1,
        estimatedCostUsd: 2,
        costByDayUsd: { [localDateKey(fresh)]: 2 },
        timeline: calls(fresh, 1),
      }),
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('usage insights count only the in-window part of a resumed session', async () => {
    const report = await get(store, '/api/usage-insights?days=7');
    expect(report.sessionCount).toBe(2);
    expect(report.totalCostUsd).toBeCloseTo(3, 10);
    const skills = report.skills as Array<{ key: string; costUsd: number }>;
    expect(skills.find((r) => r.key === 'unslop')?.costUsd).toBeCloseTo(0.5, 10);
  });

  it('cost per tool counts only the in-window part of a resumed session', async () => {
    const result = await get(store, '/api/cost-per-tool?days=7');
    expect(result.totalSessionCount).toBe(2);
    expect(result.attributedSessionCount).toBe(1);
    const read = (result.costByToolType as Record<string, Record<string, number>>).Read;
    expect(read.totalCost).toBeCloseTo(0.5, 10);
    expect(read.callCount).toBe(1);
    expect(read.tokens).toBe(100);
    expect(result.attributionRate).toBeCloseTo(0.5 / 3, 10);
  });

  it('rounds counts once, after summing every session’s share', async () => {
    const [started, resumed] = [noonDaysAgo(20), noonDaysAgo(2)];
    const breakdown = {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 1,
      cacheCreationTokens: 1,
    };
    const bucket = { costUsd: 1, tokens: 1, count: 1, durationMs: 1, breakdown };
    // Each session has $0.30 of its $1 in the window, so its buckets scale by 0.3.
    for (let i = 0; i < 10; i++) {
      store.saveSession(
        makeSummary({
          sessionId: `resumed-${i}`,
          startTime: started,
          endTime: resumed + HOUR_MS,
          toolCallCount: 1,
          estimatedCostUsd: 1,
          costByDayUsd: { [localDateKey(started)]: 0.7, [localDateKey(resumed)]: 0.3 },
          timeline: calls(resumed, 1),
          attribution: {
            buckets: { tool: { Grep: bucket }, skill: { review: bucket } },
            highContextCostUsd: 0,
            apiDurationMs: null,
          },
        }),
      );
    }
    const result = await get(store, '/api/cost-per-tool?days=7');
    const grep = (result.costByToolType as Record<string, Record<string, number>>).Grep;
    expect(grep).toMatchObject({ callCount: 3, tokens: 3, inputTokens: 3, outputTokens: 3 });
    expect(grep).toMatchObject({ cacheReadTokens: 3, cacheCreationTokens: 3 });
    const review = (result.costBySkill as Record<string, Record<string, number>>).review;
    expect(review).toMatchObject({ callCount: 3, tokens: 3, totalDurationMs: 3 });
  });
});
