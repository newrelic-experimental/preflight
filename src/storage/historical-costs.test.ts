import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { localStartOfDay } from '../lib/date.js';
import { computeHistoricalCosts } from './historical-costs.js';
import type { HistoricalCostSessionSource } from './historical-costs.js';
import type { FullSessionSummary, ListSessionsOptions } from './session-store.js';
import type { ReplayTimelineEntry } from './types.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Anchored on the local start of day, not on a raw UTC instant: the code under
// test buckets "today" with localStartOfDay(), so a fixture pinned to a UTC
// wall-clock hour would land on a different side of midnight depending on the
// runner's zone. Deriving every timestamp from DAY_START keeps the suite
// zone-independent without pinning TZ.
const REF_TS = localStartOfDay(Date.UTC(2026, 0, 15, 12, 0, 0)) + 12 * HOUR;
const DAY_START = localStartOfDay(REF_TS);

const CURRENT_SESSION_ID = 'session-current';

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

function makeSession(overrides: Partial<FullSessionSummary> = {}): FullSessionSummary {
  return {
    sessionId: 'session-1',
    startTime: DAY_START + 9 * HOUR,
    endTime: DAY_START + 10 * HOUR,
    estimatedCostUsd: 1,
    ...overrides,
  } as unknown as FullSessionSummary;
}

function makeTimelineEntry(timestamp: number): ReplayTimelineEntry {
  return { timestamp, toolName: 'Read', durationMs: 10, success: true };
}

/**
 * Stands in for `SessionStore`, honouring the `since` filter the real store
 * applies so the seven-day window is actually exercised.
 */
function makeSource(sessions: FullSessionSummary[]): HistoricalCostSessionSource {
  return {
    loadAllSessions(options?: ListSessionsOptions): FullSessionSummary[] {
      const since = options?.since?.getTime();
      if (since === undefined) return sessions;
      return sessions.filter((s) => s.endTime >= since);
    },
  };
}

describe('computeHistoricalCosts', () => {
  it('counts today sessions in both the daily and the weekly baseline', () => {
    const source = makeSource([makeSession({ estimatedCostUsd: 2.5 })]);

    expect(computeHistoricalCosts(source, CURRENT_SESSION_ID, REF_TS)).toEqual({
      priorDailyCostUsd: 2.5,
      priorWeeklyCostUsd: 2.5,
    });
  });

  it('counts a session from earlier in the week weekly but not daily', () => {
    const source = makeSource([
      makeSession({
        sessionId: 'session-yesterday',
        startTime: DAY_START - 6 * HOUR,
        endTime: DAY_START - 5 * HOUR,
        estimatedCostUsd: 4,
      }),
    ]);

    expect(computeHistoricalCosts(source, CURRENT_SESSION_ID, REF_TS)).toEqual({
      priorDailyCostUsd: 0,
      priorWeeklyCostUsd: 4,
    });
  });

  it('pro-rates a session that spans midnight by its timeline', () => {
    const source = makeSource([
      makeSession({
        sessionId: 'session-midnight',
        startTime: DAY_START - 1 * HOUR,
        endTime: DAY_START + 2 * HOUR,
        estimatedCostUsd: 10,
        timeline: [
          makeTimelineEntry(DAY_START - 30 * MINUTE),
          makeTimelineEntry(DAY_START + 30 * MINUTE),
          makeTimelineEntry(DAY_START + 1 * HOUR),
          makeTimelineEntry(DAY_START + 90 * MINUTE),
        ],
      }),
    ]);

    // 3 of 4 timeline entries land after midnight.
    expect(computeHistoricalCosts(source, CURRENT_SESSION_ID, REF_TS)).toEqual({
      priorDailyCostUsd: 7.5,
      priorWeeklyCostUsd: 10,
    });
  });

  it('ignores sessions older than the seven-day window', () => {
    const source = makeSource([
      makeSession({
        sessionId: 'session-ancient',
        startTime: DAY_START - 9 * DAY,
        endTime: DAY_START - 9 * DAY + HOUR,
        estimatedCostUsd: 99,
      }),
      makeSession({ sessionId: 'session-today', estimatedCostUsd: 1 }),
    ]);

    expect(computeHistoricalCosts(source, CURRENT_SESSION_ID, REF_TS)).toEqual({
      priorDailyCostUsd: 1,
      priorWeeklyCostUsd: 1,
    });
  });

  it('excludes the current session from both baselines', () => {
    const source = makeSource([
      makeSession({ sessionId: CURRENT_SESSION_ID, estimatedCostUsd: 50 }),
      makeSession({ sessionId: 'session-other', estimatedCostUsd: 3 }),
    ]);

    expect(computeHistoricalCosts(source, CURRENT_SESSION_ID, REF_TS)).toEqual({
      priorDailyCostUsd: 3,
      priorWeeklyCostUsd: 3,
    });
  });

  it('skips sessions with no cost estimate', () => {
    const source = makeSource([
      makeSession({ sessionId: 'session-uncosted', estimatedCostUsd: null }),
      makeSession({ sessionId: 'session-costed', estimatedCostUsd: 2 }),
    ]);

    expect(computeHistoricalCosts(source, CURRENT_SESSION_ID, REF_TS)).toEqual({
      priorDailyCostUsd: 2,
      priorWeeklyCostUsd: 2,
    });
  });

  it('returns zeroes instead of throwing when history is unreadable', () => {
    const source: HistoricalCostSessionSource = {
      loadAllSessions(): FullSessionSummary[] {
        throw new Error('sessions directory is unreadable');
      },
    };

    expect(computeHistoricalCosts(source, CURRENT_SESSION_ID, REF_TS)).toEqual({
      priorDailyCostUsd: 0,
      priorWeeklyCostUsd: 0,
    });
  });
});
