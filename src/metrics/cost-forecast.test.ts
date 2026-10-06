import { describe, it, expect } from '@jest/globals';
import { buildCostForecast, buildCostForecastFromInputs } from './cost-forecast.js';

describe('buildCostForecast', () => {
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
      const nowMs = Date.now();
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
});
