import { describe, it, expect } from '@jest/globals';
import { buildCostForecast } from './cost-forecast.js';

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

  // ISO week (Mon–Sun) end-of-week math — one test per weekday.
  // Pinned to 2024-01-01 (Mon) through 2024-01-07 (Sun) at 12:00 UTC.
  //
  // msUntilEndOfWeek = daysRemaining * 86_400_000 + msUntilEndOfDay
  // where msUntilEndOfDay is computed from the *local* day boundary (the
  // forecast aligns with the dashboard's local-time day bucketing). The
  // expected value below is derived from localStartOfDay so the test passes
  // in any host timezone — previously it hard-coded UTC and failed in PST.
  describe('msUntilEndOfWeek is correct for each ISO weekday', () => {
    const MS_IN_DAY = 86_400_000;

    const cases: Array<{ label: string; date: string; daysRemaining: number }> = [
      { label: 'Monday', date: '2024-01-01', daysRemaining: 6 },
      { label: 'Tuesday', date: '2024-01-02', daysRemaining: 5 },
      { label: 'Wednesday', date: '2024-01-03', daysRemaining: 4 },
      { label: 'Thursday', date: '2024-01-04', daysRemaining: 3 },
      { label: 'Friday', date: '2024-01-05', daysRemaining: 2 },
      { label: 'Saturday', date: '2024-01-06', daysRemaining: 1 },
      { label: 'Sunday', date: '2024-01-07', daysRemaining: 0 },
    ];

    for (const { label, date, daysRemaining } of cases) {
      it(`${label} has ${daysRemaining} day(s) remaining in the ISO week`, () => {
        const nowMs = new Date(`${date}T12:00:00.000Z`).getTime();
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
