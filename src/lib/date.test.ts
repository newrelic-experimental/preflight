import {
  isSameLocalDay,
  localDateKey,
  localStartOfDay,
  todayPortionOfSessionCost,
  todayPortionRatio,
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

  it('computes midnight in a given IANA tz with a non-whole-hour UTC offset', () => {
    // Asia/Kolkata is UTC+5:30 year-round (no DST). Noon UTC on 2026-06-10 is
    // 17:30 Kolkata time on the same calendar day, so Kolkata midnight for
    // that day is 2026-06-09T18:30:00Z.
    const noonUtc = Date.UTC(2026, 5, 10, 12, 0, 0);
    const start = localStartOfDay(noonUtc, 'Asia/Kolkata');
    expect(start).toBe(Date.UTC(2026, 5, 9, 18, 30, 0));
  });

  it('computes midnight in a given IANA tz across a spring-forward DST transition', () => {
    // America/New_York springs forward on 2026-03-08 (02:00 -> 03:00 local),
    // making that a 23h local day. A timestamp just after that day's local
    // midnight must still resolve to that same day's midnight, not drift
    // into the previous day because of the shortened day length.
    // 2026-03-08T05:00:00Z = 00:00 EST (UTC-5, DST not yet in effect at
    // midnight local time on transition day).
    const justAfterMidnight = Date.UTC(2026, 2, 8, 5, 30, 0);
    const start = localStartOfDay(justAfterMidnight, 'America/New_York');
    expect(start).toBe(Date.UTC(2026, 2, 8, 5, 0, 0));

    // The following day (2026-03-09) is a normal 24h day, now at UTC-4 (EDT).
    const nextDayNoon = Date.UTC(2026, 2, 9, 16, 0, 0);
    const nextDayStart = localStartOfDay(nextDayNoon, 'America/New_York');
    expect(nextDayStart).toBe(Date.UTC(2026, 2, 9, 4, 0, 0));
  });

  it('computes midnight in a given IANA tz across a fall-back DST transition', () => {
    // America/New_York falls back on 2026-11-01 (02:00 -> 01:00 local),
    // making that a 25h local day.
    // 2026-11-01T04:00:00Z = 00:00 EDT (UTC-4, DST still in effect at
    // midnight local time on transition day).
    const justAfterMidnight = Date.UTC(2026, 10, 1, 4, 30, 0);
    const start = localStartOfDay(justAfterMidnight, 'America/New_York');
    expect(start).toBe(Date.UTC(2026, 10, 1, 4, 0, 0));

    // The following day (2026-11-02) is a normal 24h day, now at UTC-5 (EST).
    const nextDayNoon = Date.UTC(2026, 10, 2, 17, 0, 0);
    const nextDayStart = localStartOfDay(nextDayNoon, 'America/New_York');
    expect(nextDayStart).toBe(Date.UTC(2026, 10, 2, 5, 0, 0));
  });

  it('resolves to the first instant of the target day, not the previous day, for zones that spring forward at or near midnight', () => {
    // These three zones spring forward exactly at (or immediately touching)
    // local midnight, so local midnight itself doesn't exist on the
    // transition day — the day instead begins at the first instant after
    // the gap. The offset re-read after the first correction belongs to the
    // transition that skipped midnight, so applying it a second time without
    // validation walks the candidate back onto the *previous* day.
    //
    // America/Havana springs forward 2026-03-08: 00:00 CST -> 01:00 CDT.
    expect(localStartOfDay(Date.UTC(2026, 2, 8, 12), 'America/Havana')).toBe(
      Date.UTC(2026, 2, 8, 5, 0, 0),
    );
    // America/Santiago springs forward 2026-09-06: 00:00 -04:00 -> 01:00 -03:00.
    expect(localStartOfDay(Date.UTC(2026, 8, 6, 15), 'America/Santiago')).toBe(
      Date.UTC(2026, 8, 6, 4, 0, 0),
    );
    // Atlantic/Azores springs forward 2026-03-29: 00:00 -01:00 -> 01:00 +00:00.
    expect(localStartOfDay(Date.UTC(2026, 2, 29, 12), 'Atlantic/Azores')).toBe(
      Date.UTC(2026, 2, 29, 1, 0, 0),
    );
  });
});

describe('localStartOfDay / localDateKey round-trip invariant', () => {
  it('localDateKey(localStartOfDay(ts, tz), tz) always equals localDateKey(ts, tz)', () => {
    // The start of "ts"'s local day must, by definition, fall back on the
    // same local calendar day as ts itself. This is a stronger check than
    // asserting a specific epoch value: it fails for *any* zone/date where
    // localStartOfDay resolves to the wrong side of a DST transition,
    // including zones this suite doesn't otherwise name explicitly.
    const zones = [
      'UTC',
      'America/New_York',
      'Asia/Kolkata',
      'America/Havana',
      'America/Santiago',
      'Atlantic/Azores',
    ];
    const timestamps = [
      Date.UTC(2026, 0, 1, 6),
      Date.UTC(2026, 2, 8, 12),
      Date.UTC(2026, 2, 29, 12),
      Date.UTC(2026, 5, 15, 6),
      Date.UTC(2026, 8, 6, 15),
      Date.UTC(2026, 10, 1, 12),
      Date.UTC(2026, 11, 31, 23),
    ];
    for (const tz of zones) {
      for (const ts of timestamps) {
        const start = localStartOfDay(ts, tz);
        expect(`${tz} @ ${new Date(ts).toISOString()}: ${localDateKey(start, tz)}`).toBe(
          `${tz} @ ${new Date(ts).toISOString()}: ${localDateKey(ts, tz)}`,
        );
      }
    }
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

  it('compares Y/M/D in a given IANA tz with a non-whole-hour UTC offset', () => {
    // 2026-06-10T18:00:00Z is 23:30 Kolkata (UTC+5:30) on 2026-06-10, and
    // 2026-06-10T19:00:00Z is 00:30 Kolkata on 2026-06-11 — different
    // Kolkata calendar days despite being only 1h apart in UTC.
    const beforeMidnightKolkata = Date.UTC(2026, 5, 10, 18, 0, 0);
    const afterMidnightKolkata = Date.UTC(2026, 5, 10, 19, 0, 0);
    expect(isSameLocalDay(beforeMidnightKolkata, afterMidnightKolkata, 'Asia/Kolkata')).toBe(false);
    // But in UTC itself both instants fall on 2026-06-10.
    expect(isSameLocalDay(beforeMidnightKolkata, afterMidnightKolkata, 'UTC')).toBe(true);
  });

  it('compares Y/M/D in a given IANA tz across a DST transition', () => {
    // Both instants fall on the same America/New_York calendar day
    // (2026-03-08) even though the 2:00-3:00 local spring-forward jump
    // happens in between them.
    const earlyMorning = Date.UTC(2026, 2, 8, 6, 0, 0); // 01:00 EST, pre-transition
    const lateMorning = Date.UTC(2026, 2, 8, 15, 0, 0); // 11:00 EDT, post-transition
    expect(isSameLocalDay(earlyMorning, lateMorning, 'America/New_York')).toBe(true);
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

  it('produces the key for a given IANA tz with a non-whole-hour UTC offset', () => {
    // 2026-06-10T19:00:00Z is 00:30 on 2026-06-11 in Asia/Kolkata (UTC+5:30).
    const ts = Date.UTC(2026, 5, 10, 19, 0, 0);
    expect(localDateKey(ts, 'Asia/Kolkata')).toBe('2026-06-11');
    expect(localDateKey(ts, 'UTC')).toBe('2026-06-10');
  });

  it('produces the key for a given IANA tz across a DST transition', () => {
    // 2026-11-01T05:00:00Z is 01:00 EDT on 2026-11-01, before that day's
    // fall-back transition at 06:00 UTC (02:00 EDT -> 01:00 EST).
    const ts = Date.UTC(2026, 10, 1, 5, 0, 0);
    expect(localDateKey(ts, 'America/New_York')).toBe('2026-11-01');
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

describe('todayPortionRatio', () => {
  // Same reference instant and fixtures as todayPortionOfSessionCost above,
  // so the ratio can be cross-checked against that function's known-good
  // outputs (ratio * cost === todayPortionOfSessionCost's result).
  const refTs = new Date(2026, 5, 10, 14, 0).getTime();
  const startOfToday = new Date(2026, 5, 10, 0, 0).getTime();
  const startOfYesterday = new Date(2026, 5, 9, 0, 0).getTime();
  const endOfToday = startOfToday + 86_400_000;

  it('returns 0 for sessions entirely before today', () => {
    const session = {
      startTime: startOfYesterday + 9 * 3_600_000,
      endTime: startOfYesterday + 11 * 3_600_000,
    };
    expect(todayPortionRatio(session, refTs)).toBe(0);
  });

  it('returns 0 for sessions in the future relative to refTs', () => {
    const session = {
      startTime: endOfToday + 1_000,
      endTime: endOfToday + 60_000,
    };
    expect(todayPortionRatio(session, refTs)).toBe(0);
  });

  it('returns 1 for sessions entirely within today', () => {
    const session = {
      startTime: startOfToday + 9 * 3_600_000,
      endTime: startOfToday + 11 * 3_600_000,
    };
    expect(todayPortionRatio(session, refTs)).toBe(1);
  });

  it('pro-rates by timeline tool-call count when timeline is present', () => {
    // Same shape as the todayPortionOfSessionCost timeline test: 4 entries,
    // 1 of them today → ratio 0.25.
    const session = {
      startTime: startOfYesterday + 22 * 3_600_000,
      endTime: startOfToday + 2 * 3_600_000,
      timeline: [
        { timestamp: startOfYesterday + 22 * 3_600_000 + 1_000 },
        { timestamp: startOfYesterday + 22 * 3_600_000 + 30 * 60_000 },
        { timestamp: startOfYesterday + 23 * 3_600_000 },
        { timestamp: startOfToday + 60_000 },
      ],
    };
    expect(todayPortionRatio(session, refTs)).toBe(0.25);
  });

  it('pro-rates by elapsed-time overlap when no timeline is present', () => {
    // 22:00 yesterday → 02:00 today = 4h total, 2h within today → ratio 0.5.
    const session = {
      startTime: startOfYesterday + 22 * 3_600_000,
      endTime: startOfToday + 2 * 3_600_000,
    };
    expect(todayPortionRatio(session, refTs)).toBe(0.5);
  });

  it('agrees with todayPortionOfSessionCost when multiplied by cost', () => {
    const session = {
      startTime: startOfYesterday + 22 * 3_600_000,
      endTime: startOfToday + 2 * 3_600_000,
      estimatedCostUsd: 8,
    };
    const ratio = todayPortionRatio(session, refTs);
    expect(ratio * session.estimatedCostUsd).toBe(todayPortionOfSessionCost(session, refTs));
  });
});
