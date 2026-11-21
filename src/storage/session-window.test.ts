import { localDateKey, localEndOfDay, localStartOfDay } from '../lib/date.js';
import type { FullSessionSummary } from './session-store.js';
import { windowShare, windowedSessions, type ActivityWindow } from './session-window.js';
import type { ReplayTimelineEntry } from './types.js';

const HOUR_MS = 3_600_000;
// A fixed local day well clear of any DST change.
const DAY = localStartOfDay(Date.UTC(2026, 5, 10, 12));
const at = (hour: number): number => DAY + hour * HOUR_MS;

type Source = Parameters<typeof windowShare>[0];

function calls(...hours: number[]): ReplayTimelineEntry[] {
  return hours.map((h) => ({
    timestamp: at(h),
    toolName: 'Read',
    durationMs: null,
    success: true,
  }));
}

function source(overrides: Partial<Source>): Source {
  return {
    startTime: at(8),
    endTime: at(16),
    durationMs: 8 * HOUR_MS,
    toolCallCount: 4,
    estimatedCostUsd: 8,
    ...overrides,
  };
}

const fromNoon: ActivityWindow = { startMs: at(12), endMs: Infinity };

describe('windowShare', () => {
  it('splits a day the window cuts by that day’s calls', () => {
    const share = windowShare(
      source({ costByDayUsd: { [localDateKey(DAY)]: 8 }, timeline: calls(9, 13, 14, 15) }),
      fromNoon,
    );
    expect(share).toEqual({ weight: 0.75, costUsd: 6, toolCalls: 3 });
  });

  it('keeps whole days the window covers and drops days before it', () => {
    const prior = localStartOfDay(DAY - 12 * HOUR_MS);
    const share = windowShare(
      source({
        startTime: prior + 9 * HOUR_MS,
        estimatedCostUsd: 10,
        costByDayUsd: { [localDateKey(prior)]: 7, [localDateKey(DAY)]: 3 },
        timeline: [
          { timestamp: prior + 9 * HOUR_MS, toolName: 'Read', durationMs: null, success: true },
          ...calls(9),
        ],
      }),
      { startMs: DAY, endMs: Infinity },
    );
    expect(share.costUsd).toBe(3);
    expect(share.weight).toBeCloseTo(0.3, 10);
    expect(share.toolCalls).toBe(1);
  });

  it('drops cost booked before the window for a session that started inside it', () => {
    const prior = localStartOfDay(DAY - 12 * HOUR_MS);
    const share = windowShare(
      source({
        startTime: DAY + 10 * 60_000,
        estimatedCostUsd: 1,
        costByDayUsd: { [localDateKey(prior)]: 0.4, [localDateKey(DAY)]: 0.6 },
        timeline: calls(9, 10),
      }),
      { startMs: DAY, endMs: Infinity },
    );
    expect(share.costUsd).toBeCloseTo(0.6, 10);
    expect(share.weight).toBeCloseTo(0.6, 10);
    expect(share.toolCalls).toBe(2);
  });

  it('splits the whole cost by calls when there is no day map', () => {
    expect(windowShare(source({ timeline: calls(9, 13, 14, 15) }), fromNoon).costUsd).toBe(6);
  });

  it('splits by elapsed time when there are no calls to go by', () => {
    const share = windowShare(source({}), fromNoon);
    expect(share).toEqual({ weight: 0.5, costUsd: 4, toolCalls: 2 });
  });

  it('counts a session inside the window whole, including calls its timeline dropped', () => {
    const share = windowShare(source({ toolCallCount: 7, timeline: calls(9, 10) }), {
      startMs: at(0),
      endMs: Infinity,
    });
    expect(share).toEqual({ weight: 1, costUsd: 8, toolCalls: 7 });
  });

  it('keeps cost booked to a day the session’s recorded span does not reach', () => {
    const nextDay = localEndOfDay(DAY);
    const s = source({
      endTime: nextDay,
      estimatedCostUsd: 10,
      costByDayUsd: { [localDateKey(DAY)]: 8, [localDateKey(nextDay)]: 2 },
    });
    expect(windowShare(s, fromNoon).costUsd).toBe(8);
    expect(windowShare(s, { startMs: nextDay, endMs: Infinity }).costUsd).toBe(2);
    expect(windowShare(s, { startMs: DAY, endMs: nextDay }).costUsd).toBe(8);
  });

  it('counts nothing for a session that ended before the window or started after it', () => {
    const none = { weight: 0, costUsd: 0, toolCalls: 0 };
    expect(windowShare(source({}), { startMs: at(17), endMs: Infinity })).toEqual(none);
    expect(windowShare(source({}), { startMs: at(0), endMs: at(8) })).toEqual(none);
    const instant = source({ endTime: at(8), durationMs: 0 });
    expect(windowShare(instant, fromNoon)).toEqual(none);
  });
});

describe('windowedSessions', () => {
  it('keeps sessions active in the window and ones that started in it with no activity', () => {
    const summary = (sessionId: string, overrides: Partial<Source>) =>
      ({ sessionId, ...source(overrides) }) as FullSessionSummary;
    const kept = windowedSessions(
      [
        summary('resumed', { timeline: calls(9, 13) }),
        summary('ended-before', { startTime: at(1), endTime: at(2), timeline: calls(1) }),
        summary('idle-in-window', {
          startTime: at(12),
          endTime: at(20),
          estimatedCostUsd: 0,
          toolCallCount: 0,
        }),
        summary('idle-after-start', {
          estimatedCostUsd: 0,
          toolCallCount: 0,
          timeline: calls(9),
        }),
      ],
      fromNoon,
    );
    expect(kept.map((w) => w.session.sessionId)).toEqual(['resumed', 'idle-in-window']);
  });

  it('keeps a session with in-window cost and no in-window calls', () => {
    const prior = localStartOfDay(DAY - 12 * HOUR_MS);
    const chattedOnly = {
      sessionId: 'chatted-only',
      ...source({
        startTime: prior + 9 * HOUR_MS,
        costByDayUsd: { [localDateKey(prior)]: 5, [localDateKey(DAY)]: 3 },
        timeline: [
          { timestamp: prior + 9 * HOUR_MS, toolName: 'Read', durationMs: null, success: true },
        ],
      }),
    } as FullSessionSummary;
    const [kept] = windowedSessions([chattedOnly], { startMs: DAY, endMs: Infinity });
    expect(kept.share).toEqual({ weight: 3 / 8, costUsd: 3, toolCalls: 0 });
  });

  it('drops an idle session that started after the window closed', () => {
    const later = {
      sessionId: 'later',
      ...source({ startTime: at(20), endTime: at(21), estimatedCostUsd: 0, toolCallCount: 0 }),
    } as FullSessionSummary;
    expect(windowedSessions([later], { startMs: at(12), endMs: at(18) })).toEqual([]);
  });
});
