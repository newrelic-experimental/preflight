import {
  isSameLocalDay,
  localDateKey,
  localStartOfDay,
  todayPortionOfSessionCost,
} from './date.js';

describe('localStartOfDay', () => {
  it('returns the start of the local day for a given timestamp', () => {
    const noon = new Date(2026, 5, 10, 12, 30, 45, 678).getTime();
    const start = localStartOfDay(noon);
    expect(new Date(start).getHours()).toBe(0);
    expect(new Date(start).getMinutes()).toBe(0);
    expect(new Date(start).getSeconds()).toBe(0);
    expect(new Date(start).getMilliseconds()).toBe(0);
    expect(new Date(start).getDate()).toBe(10);
  });

  it('uses now when no argument is passed', () => {
    const before = Date.now();
    const start = localStartOfDay();
    const after = Date.now();
    expect(start).toBeLessThanOrEqual(before);
    expect(start).toBeLessThanOrEqual(after);
    expect(new Date(start).getHours()).toBe(0);
  });
});

describe('isSameLocalDay', () => {
  it('returns true for two timestamps on the same local day', () => {
    const morning = new Date(2026, 5, 10, 8, 15).getTime();
    const evening = new Date(2026, 5, 10, 22, 45).getTime();
    expect(isSameLocalDay(morning, evening)).toBe(true);
  });

  it('returns false for two timestamps on different local days', () => {
    const yesterday = new Date(2026, 5, 9, 23, 50).getTime();
    const today = new Date(2026, 5, 10, 0, 5).getTime();
    expect(isSameLocalDay(yesterday, today)).toBe(false);
  });

  it('compares against now when refTs is omitted', () => {
    const now = Date.now();
    expect(isSameLocalDay(now)).toBe(true);
    const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
    expect(isSameLocalDay(oneWeekAgo)).toBe(false);
  });
});

describe('localDateKey', () => {
  it('produces YYYY-MM-DD in local time', () => {
    const ts = new Date(2026, 0, 9, 14, 30).getTime(); // Jan 9, 2026 local
    expect(localDateKey(ts)).toBe('2026-01-09');
  });

  it('zero-pads single-digit months and days', () => {
    const ts = new Date(2026, 2, 5, 10, 0).getTime(); // March 5
    expect(localDateKey(ts)).toBe('2026-03-05');
  });

  it('rolls over on local midnight, not UTC midnight', () => {
    // 23:30 local = either same or next UTC day depending on tz, but
    // localDateKey must always reflect the *local* day for the input.
    const lateNight = new Date(2026, 5, 10, 23, 30).getTime();
    expect(localDateKey(lateNight)).toBe('2026-06-10');
    const earlyMorning = new Date(2026, 5, 11, 0, 30).getTime();
    expect(localDateKey(earlyMorning)).toBe('2026-06-11');
  });
});

describe('todayPortionOfSessionCost', () => {
  // Reference instant: 2026-06-10 14:00 local. Used as `refTs` so the
  // helper's notion of "today" is deterministic regardless of when tests run.
  const refTs = new Date(2026, 5, 10, 14, 0).getTime();
  const startOfToday = new Date(2026, 5, 10, 0, 0).getTime();
  const startOfYesterday = new Date(2026, 5, 9, 0, 0).getTime();
  const endOfToday = startOfToday + 86_400_000;

  it('returns 0 for sessions entirely before today', () => {
    const session = {
      startTime: startOfYesterday + 9 * 3_600_000,
      endTime: startOfYesterday + 11 * 3_600_000,
      estimatedCostUsd: 5,
    };
    expect(todayPortionOfSessionCost(session, refTs)).toBe(0);
  });

  it('returns 0 for sessions in the future relative to refTs', () => {
    const session = {
      startTime: endOfToday + 1_000,
      endTime: endOfToday + 60_000,
      estimatedCostUsd: 5,
    };
    expect(todayPortionOfSessionCost(session, refTs)).toBe(0);
  });

  it('returns full cost for sessions entirely within today', () => {
    const session = {
      startTime: startOfToday + 9 * 3_600_000,
      endTime: startOfToday + 11 * 3_600_000,
      estimatedCostUsd: 5,
    };
    expect(todayPortionOfSessionCost(session, refTs)).toBe(5);
  });

  it('pro-rates by timeline tool-call count when timeline is present', () => {
    // Session starts at 22:00 yesterday, ends at 02:00 today; 4 timeline
    // entries — 3 yesterday, 1 today. Today portion = 1/4 of total cost.
    const session = {
      startTime: startOfYesterday + 22 * 3_600_000,
      endTime: startOfToday + 2 * 3_600_000,
      estimatedCostUsd: 8,
      timeline: [
        { timestamp: startOfYesterday + 22 * 3_600_000 + 1_000 },
        { timestamp: startOfYesterday + 22 * 3_600_000 + 30 * 60_000 },
        { timestamp: startOfYesterday + 23 * 3_600_000 },
        { timestamp: startOfToday + 60_000 },
      ],
    };
    expect(todayPortionOfSessionCost(session, refTs)).toBe(2);
  });

  it('pro-rates by elapsed-time overlap when no timeline is present', () => {
    // Session 22:00 yesterday → 02:00 today = 4h total, 2h within today.
    const session = {
      startTime: startOfYesterday + 22 * 3_600_000,
      endTime: startOfToday + 2 * 3_600_000,
      estimatedCostUsd: 8,
    };
    expect(todayPortionOfSessionCost(session, refTs)).toBe(4);
  });

  it('returns 0 for null/zero/negative cost', () => {
    const base = {
      startTime: startOfToday + 60_000,
      endTime: startOfToday + 120_000,
      timeline: [{ timestamp: startOfToday + 60_000 }],
    };
    expect(todayPortionOfSessionCost({ ...base, estimatedCostUsd: null }, refTs)).toBe(0);
    expect(todayPortionOfSessionCost({ ...base, estimatedCostUsd: 0 }, refTs)).toBe(0);
    expect(todayPortionOfSessionCost({ ...base, estimatedCostUsd: -1 }, refTs)).toBe(0);
  });
});
