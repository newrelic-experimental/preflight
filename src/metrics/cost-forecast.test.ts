import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { buildCostForecast, buildCostForecastFromInputs } from './cost-forecast.js';
import { localEndOfDay, localStartOfDay } from '../lib/date.js';

describe('buildCostForecast', () => {
  // Local 14:00 so no test depends on how close the real clock is to midnight.
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date(2024, 0, 3, 14).getTime() });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns null forecasts when elapsed time is < 1 ms', () => {
    const nowMs = Date.now();
    const f = buildCostForecast(0, nowMs, nowMs); // elapsedMs === 0
    expect(f.forecastEndOfDayUsd).toBeNull();
    expect(f.forecastEndOfWeekUsd).toBeNull();
    expect(f.forecastSessionEndUsd).toBeNull();
    expect(f.confidenceNote).toMatch(/Insufficient/i);
  });

  it('returns zero forecasts when session is running but nothing spent yet', () => {
    const startMs = Date.now() - 60_000;
    const f = buildCostForecast(0, startMs);
    expect(f.forecastEndOfDayUsd).toBe(0);
    expect(f.forecastEndOfWeekUsd).toBe(0);
    expect(f.forecastSessionEndUsd).toBe(0);
    expect(f.rateUsdPerMs).toBe(0);
    expect(f.elapsedMs).toBeGreaterThan(0);
    expect(f.confidenceNote).toMatch(/no spend/i);
  });

  it('returns a positive end-of-day forecast for ongoing spend', () => {
    const startMs = Date.now() - 30 * 60_000;
    const f = buildCostForecast(1.5, startMs);
    expect(f.forecastEndOfDayUsd).toBeGreaterThan(1.5);
    expect(f.rateUsdPerMs).toBeGreaterThan(0);
  });

  it('confidenceNote mentions low confidence for <10 minutes', () => {
    const startMs = Date.now() - 5 * 60_000;
    const f = buildCostForecast(0.1, startMs);
    expect(f.confidenceNote).toMatch(/Low confidence/i);
  });

  it('confidenceNote mentions moderate confidence for <30 minutes', () => {
    const startMs = Date.now() - 15 * 60_000;
    const f = buildCostForecast(0.5, startMs);
    expect(f.confidenceNote).toMatch(/Moderate confidence/i);
  });

  it('confidenceNote mentions reasonable confidence for 30+ minutes', () => {
    const startMs = Date.now() - 45 * 60_000;
    const f = buildCostForecast(2.0, startMs);
    expect(f.confidenceNote).toMatch(/Reasonable confidence/i);
  });

  it('computes correct spending rate', () => {
    const startMs = Date.now() - 60_000;
    const f = buildCostForecast(1.0, startMs);
    expect(f.rateUsdPerMs).toBeCloseTo(1.0 / 60_000, 8);
  });

  it('forecasts end-of-session cost correctly', () => {
    const startMs = Date.now() - 30 * 60_000;
    const f = buildCostForecast(1.0, startMs);
    expect(f.forecastSessionEndUsd).toBeGreaterThan(1.0);
    expect(f.forecastSessionEndUsd).toBeLessThan(100);
  });

  it('returns correct elapsed time', () => {
    const elapsedMs = 3 * 60_000;
    const startMs = Date.now() - elapsedMs;
    const f = buildCostForecast(1.0, startMs);
    expect(f.elapsedMs).toBeCloseTo(elapsedMs, -2);
  });

  describe('daily-anchored forecast', () => {
    it('uses daily rate for both EoD and EoW when daily anchor is supplied', () => {
      // Session started yesterday; today's activity started 2 h ago at $1/h daily rate.
      // Wednesday 14:00 local, since the forecast reads the local weekday.
      const nowMs = new Date(2024, 0, 3, 14).getTime();
      const sessionStartMs = nowMs - 16 * 60 * 60_000; // 16 h ago (crossed midnight)
      const dailyFirstActivityMs = nowMs - 2 * 60 * 60_000; // 2 h ago
      const dailySpentUsd = 2; // $1/h × 2 h
      const f = buildCostForecastFromInputs(
        { sessionSpentUsd: 10, sessionStartMs, dailySpentUsd, dailyFirstActivityMs },
        nowMs,
      );
      // EoD and EoW must use the same daily rate — week remaining ≥ day remaining.
      expect(f.forecastEndOfWeekUsd!).toBeGreaterThan(f.forecastEndOfDayUsd!);
      // Both forecasts share the same base (dailySpentUsd=$2) and daily rate ($1/h).
      // EoD: $2 + $1/h * msUntilEoD.  EoW: $2 + $1/h * msUntilEoW.
      // Difference = $1/h * (msUntilEoW - msUntilEoD) = $1/h * daysRemaining * 24h.
      // Wednesday → 4 days remaining (Thu + Fri + Sat + Sun).
      const dailyRatePerMs = dailySpentUsd / (2 * 60 * 60_000);
      const diff = f.forecastEndOfWeekUsd! - f.forecastEndOfDayUsd!;
      const expectedDiff = dailyRatePerMs * 4 * 86_400_000;
      expect(diff).toBeCloseTo(expectedDiff, 0);
    });

    it('EoD and EoW use session rate when daily anchor is absent', () => {
      const nowMs = new Date(2024, 0, 3, 14).getTime();
      const sessionStartMs = nowMs - 60 * 60_000; // 1 h
      const f = buildCostForecastFromInputs({ sessionSpentUsd: 1, sessionStartMs }, nowMs);
      // Without anchor, session rate is used for both projections.
      expect(f.rateUsdPerMs).toBeCloseTo(1 / (60 * 60_000), 10);
      // EoD ≥ current spend (there is time remaining in the day).
      expect(f.forecastEndOfDayUsd!).toBeGreaterThanOrEqual(f.spentUsd);
      // EoW ≥ EoD (the week has at least as much time remaining as the day).
      expect(f.forecastEndOfWeekUsd!).toBeGreaterThanOrEqual(f.forecastEndOfDayUsd!);
    });
  });

  describe('minimum forecast window', () => {
    const nowMs = new Date(2024, 0, 3, 14).getTime();
    const SPEND_USD = 0.01;
    const justAfterMidnight = new Date(2024, 0, 3, 0, 5).getTime();

    it('holds EoD and EoW when the session window is under 10 minutes', () => {
      const f = buildCostForecastFromInputs(
        { sessionSpentUsd: SPEND_USD, sessionStartMs: nowMs - 15_000 },
        nowMs,
      );
      expect(f.forecastEndOfDayUsd).toBeNull();
      expect(f.forecastEndOfWeekUsd).toBeNull();
    });

    it('holds EoD and EoW when the daily window is under 10 minutes', () => {
      const f = buildCostForecastFromInputs(
        {
          sessionSpentUsd: SPEND_USD,
          sessionStartMs: nowMs - 15_000,
          dailySpentUsd: SPEND_USD,
          dailyFirstActivityMs: nowMs - 15_000,
        },
        nowMs,
      );
      expect(f.forecastEndOfDayUsd).toBeNull();
      expect(f.forecastEndOfWeekUsd).toBeNull();
    });

    it('projects EoD and EoW once the daily window is past the minimum', () => {
      const f = buildCostForecastFromInputs(
        {
          sessionSpentUsd: SPEND_USD,
          sessionStartMs: nowMs - 30 * 60_000,
          dailySpentUsd: SPEND_USD,
          dailyFirstActivityMs: nowMs - 30 * 60_000,
        },
        nowMs,
      );
      expect(f.forecastEndOfDayUsd).not.toBeNull();
      expect(f.forecastEndOfWeekUsd).not.toBeNull();
      expect(f.forecastEndOfDayUsd!).toBeLessThanOrEqual(f.forecastEndOfWeekUsd!);
    });

    it('holds at 9m59s and projects at exactly 10m00s', () => {
      const at = (windowMs: number) =>
        buildCostForecastFromInputs(
          {
            sessionSpentUsd: SPEND_USD,
            sessionStartMs: nowMs - windowMs,
            dailySpentUsd: SPEND_USD,
            dailyFirstActivityMs: nowMs - windowMs,
          },
          nowMs,
        );
      const justUnder = at(10 * 60_000 - 1_000);
      const exactly = at(10 * 60_000);
      expect(justUnder.forecastEndOfDayUsd).toBeNull();
      expect(justUnder.forecastSessionEndUsd).toBeNull();
      expect(exactly.forecastEndOfDayUsd).not.toBeNull();
      expect(exactly.forecastSessionEndUsd).not.toBeNull();
    });

    it('holds the session-end forecast while the session is under 10 minutes', () => {
      const f = buildCostForecastFromInputs(
        { sessionSpentUsd: SPEND_USD, sessionStartMs: nowMs - 15_000 },
        nowMs,
      );
      expect(f.forecastSessionEndUsd).toBeNull();
    });

    it('names the minimum window and the moderate window in the confidence note', () => {
      const low = buildCostForecast(SPEND_USD, nowMs - 5 * 60_000, nowMs);
      const moderate = buildCostForecast(SPEND_USD, nowMs - 15 * 60_000, nowMs);
      const reasonable = buildCostForecast(SPEND_USD, nowMs - 45 * 60_000, nowMs);
      expect(low.confidenceNote).toContain('10 minutes');
      expect(moderate.confidenceNote).toContain('30 minutes');
      expect(reasonable.confidenceNote).toContain('30+ minutes');
    });

    it('holds EoD and EoW for a cross-midnight session with no daily anchor', () => {
      const f = buildCostForecastFromInputs(
        { sessionSpentUsd: 10, sessionStartMs: justAfterMidnight - 6 * 60 * 60_000 },
        justAfterMidnight,
      );
      expect(f.forecastEndOfDayUsd).toBeNull();
      expect(f.forecastEndOfWeekUsd).toBeNull();
    });

    it('grades a held session-end-only forecast on the session window, not the daily one', () => {
      const f = buildCostForecastFromInputs(
        { sessionSpentUsd: 10, sessionStartMs: justAfterMidnight - 6 * 60 * 60_000 },
        justAfterMidnight,
      );
      expect(f.forecastEndOfDayUsd).toBeNull();
      expect(f.forecastSessionEndUsd).not.toBeNull();
      expect(f.confidenceNote).toMatch(/Reasonable confidence/i);
    });

    it('holds EoD on a short daily window but keeps session-end graded on its own longer window', () => {
      const f = buildCostForecastFromInputs(
        {
          sessionSpentUsd: 10,
          sessionStartMs: nowMs - 2 * 60 * 60_000,
          dailySpentUsd: SPEND_USD,
          dailyFirstActivityMs: nowMs - 2 * 60_000,
        },
        nowMs,
      );
      expect(f.forecastEndOfDayUsd).toBeNull();
      expect(f.forecastSessionEndUsd).not.toBeNull();
      expect(f.confidenceNote).toMatch(/Reasonable confidence/i);
    });

    it('says why EoD and EoW are held while session-end is shown', () => {
      const shortWindow = buildCostForecastFromInputs(
        {
          sessionSpentUsd: 10,
          sessionStartMs: nowMs - 2 * 60 * 60_000,
          dailySpentUsd: SPEND_USD,
          dailyFirstActivityMs: nowMs - 2 * 60_000,
        },
        nowMs,
      );
      const noAnchor = buildCostForecastFromInputs(
        { sessionSpentUsd: 10, sessionStartMs: justAfterMidnight - 6 * 60 * 60_000 },
        justAfterMidnight,
      );
      const shown = buildCostForecast(SPEND_USD, nowMs - 45 * 60_000, nowMs);
      expect(shortWindow.heldReason).toBe("held: under 10 minutes of today's data");
      expect(noAnchor.heldReason).toBe('held: no spend yet today');
      expect(shown.heldReason).toBeNull();
    });

    it('treats a 1 ms session as data, not as no data', () => {
      const f = buildCostForecastFromInputs(
        { sessionSpentUsd: SPEND_USD, sessionStartMs: nowMs - 1 },
        nowMs,
      );
      expect(f.elapsedMs).toBe(1);
    });

    it('carries no heldReason when the clock reads before the session start', () => {
      const f = buildCostForecastFromInputs(
        { sessionSpentUsd: SPEND_USD, sessionStartMs: nowMs },
        nowMs,
      );
      expect(f.heldReason).toBeNull();
    });

    it('carries no heldReason while a session has no spend yet', () => {
      const f = buildCostForecastFromInputs(
        { sessionSpentUsd: 0, sessionStartMs: nowMs - 60_000 },
        nowMs,
      );
      expect(f.heldReason).toBeNull();
    });

    it('projects EoD for a session that started exactly at local midnight with no daily anchor', () => {
      const f = buildCostForecastFromInputs(
        { sessionSpentUsd: SPEND_USD, sessionStartMs: new Date(2024, 0, 3).getTime() },
        nowMs,
      );
      expect(f.forecastEndOfDayUsd).not.toBeNull();
    });

    it('grades a shown forecast on the daily window, not the longer session window', () => {
      const f = buildCostForecastFromInputs(
        {
          sessionSpentUsd: 10,
          sessionStartMs: nowMs - 2 * 60 * 60_000,
          dailySpentUsd: SPEND_USD,
          dailyFirstActivityMs: nowMs - 15 * 60_000,
        },
        nowMs,
      );
      expect(f.confidenceNote).toMatch(/Moderate confidence/i);
    });

    it('grades exactly 10 minutes as moderate, not low', () => {
      const f = buildCostForecast(SPEND_USD, nowMs - 10 * 60_000, nowMs);
      expect(f.confidenceNote).toMatch(/Moderate confidence/i);
    });

    it('grades exactly 30 minutes as reasonable, not moderate', () => {
      const f = buildCostForecast(SPEND_USD, nowMs - 30 * 60_000, nowMs);
      expect(f.confidenceNote).toMatch(/Reasonable confidence/i);
    });

    it('projects from a fresh daily anchor when the session started before local midnight', () => {
      const f = buildCostForecastFromInputs(
        {
          sessionSpentUsd: 10,
          sessionStartMs: nowMs - 20 * 60 * 60_000,
          dailySpentUsd: SPEND_USD,
          dailyFirstActivityMs: nowMs - 30 * 60_000,
        },
        nowMs,
      );
      expect(f.forecastEndOfDayUsd).not.toBeNull();
      expect(f.heldReason).toBeNull();
    });

    it('says low confidence only when every forecast is held', () => {
      const f = buildCostForecastFromInputs(
        {
          sessionSpentUsd: SPEND_USD,
          sessionStartMs: nowMs - 2 * 60_000,
          dailySpentUsd: SPEND_USD,
          dailyFirstActivityMs: nowMs - 2 * 60_000,
        },
        nowMs,
      );
      expect(f.forecastEndOfDayUsd).toBeNull();
      expect(f.forecastSessionEndUsd).toBeNull();
      expect(f.confidenceNote).toMatch(/Low confidence/i);
    });
  });

  // ISO week (Mon–Sun) end-of-week math — one test per weekday.
  // Pinned to local noon on 2024-01-01 (Mon) through 2024-01-07 (Sun).
  //
  // msUntilEndOfWeek = daysRemaining * 86_400_000 + msUntilEndOfDay
  // where msUntilEndOfDay is computed from the *local* day boundary (the
  // forecast aligns with the dashboard's local-time day bucketing), and the
  // remaining days from the local weekday. Both the fixture instant and the
  // expected value are local, so the test passes in any host timezone.
  describe('msUntilEndOfWeek is correct for each ISO weekday', () => {
    const MS_IN_DAY = 86_400_000;

    const cases: Array<{ label: string; dayOfMonth: number; daysRemaining: number }> = [
      { label: 'Monday', dayOfMonth: 1, daysRemaining: 6 },
      { label: 'Tuesday', dayOfMonth: 2, daysRemaining: 5 },
      { label: 'Wednesday', dayOfMonth: 3, daysRemaining: 4 },
      { label: 'Thursday', dayOfMonth: 4, daysRemaining: 3 },
      { label: 'Friday', dayOfMonth: 5, daysRemaining: 2 },
      { label: 'Saturday', dayOfMonth: 6, daysRemaining: 1 },
      { label: 'Sunday', dayOfMonth: 7, daysRemaining: 0 },
    ];

    for (const { label, dayOfMonth, daysRemaining } of cases) {
      it(`${label} has ${daysRemaining} day(s) remaining in the ISO week`, () => {
        const nowMs = new Date(2024, 0, dayOfMonth, 12).getTime();
        const startMs = nowMs - 60 * 60_000; // 1 hour elapsed
        const f = buildCostForecast(1.0, startMs, nowMs);

        // Local end-of-day boundary — same helper the forecast uses.
        const localDayStart = new Date(nowMs);
        localDayStart.setHours(0, 0, 0, 0);
        const localDayEnd = localDayStart.getTime() + MS_IN_DAY;
        const msUntilEndOfDay = Math.max(0, localDayEnd - nowMs);
        const expected = daysRemaining * MS_IN_DAY + msUntilEndOfDay;

        const rate = f.rateUsdPerMs!;
        const remaining = (f.forecastEndOfWeekUsd! - f.spentUsd) / rate;
        expect(remaining).toBeCloseTo(expected, -1); // within 1 ms
      });
    }
  });

  // Jest can't pin `process.env.TZ` per test (see the matching scan in
  // api-handler.test.ts), so find a DST change in the host's own zone. CI runs
  // this file under America/New_York, Pacific/Auckland and America/Havana; in a
  // zone without DST every local day is 86_400_000ms and the test is skipped.
  const dstWeek = ((): { nowMs: number; daysRemaining: number } | null => {
    for (let i = 1; i < 366; i++) {
      const dayStart = localStartOfDay(new Date(2026, 0, 1 + i).getTime());
      if (localEndOfDay(dayStart) - dayStart === 86_400_000) continue;
      // Noon the day before the DST day, unless that falls in the previous ISO week.
      const before = new Date(2026, 0, i, 12);
      const isoDay = before.getDay() === 0 ? 7 : before.getDay();
      if (isoDay === 7) continue;
      return { nowMs: before.getTime(), daysRemaining: 7 - isoDay };
    }
    return null;
  })();

  (dstWeek === null ? it.skip : it)(
    'projects to the real end of a week that contains a DST change',
    () => {
      const { nowMs, daysRemaining } = dstWeek!;
      const f = buildCostForecast(1.0, nowMs - 60 * 60_000, nowMs);

      // Walk the remaining local days by their real lengths (23h or 25h on the DST day).
      let end = localEndOfDay(localStartOfDay(nowMs));
      for (let d = 0; d < daysRemaining; d++) end = localEndOfDay(end);
      const expected = end - nowMs;

      const remaining = (f.forecastEndOfWeekUsd! - f.spentUsd) / f.rateUsdPerMs;
      expect(remaining).toBeCloseTo(expected, -1);
      // A fixed 24h per remaining day is off by the DST shift.
      const fixedMs = localEndOfDay(localStartOfDay(nowMs)) - nowMs + daysRemaining * 86_400_000;
      expect(Math.abs(expected - fixedMs)).toBeGreaterThanOrEqual(30 * 60_000);
    },
  );
});
