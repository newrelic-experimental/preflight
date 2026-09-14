import { describe, it, expect } from 'vitest';
import { localStartOfDay } from '../../lib/date.js';
import { buildWeekForecast, buildMonthForecast, type ForecastSessionInput } from './forecast.js';

describe('buildWeekForecast()', () => {
  // Fixed local calendar dates (not Date.now()) so the test is deterministic
  // regardless of which day it actually runs on.
  function nextWeekday(base: Date, targetDay: number): Date {
    const d = new Date(base);
    while (d.getDay() !== targetDay) d.setDate(d.getDate() + 1);
    d.setHours(12, 0, 0, 0);
    return d;
  }

  function makeSession(startTime: number, estimatedCostUsd: number): ForecastSessionInput {
    return { startTime, estimatedCostUsd };
  }

  it('sums week-to-date (Monday through yesterday) and projects the remaining days from the average daily pace', () => {
    const wednesday = nextWeekday(new Date(2026, 0, 1), 3); // Wednesday
    const todayStart = localStartOfDay(wednesday.getTime());
    const monday = todayStart - 2 * 86_400_000;
    const sessions = [
      makeSession(monday + 60_000, 10),
      makeSession(monday + 86_400_000 + 60_000, 10), // Tuesday
    ];

    // weekToDateExcludingToday = 20, effectiveEod = max(15, 12) = 15.
    // daysElapsedIncludingToday = 3 (Mon/Tue/Wed), remainingFullDays = 4 (Thu-Sun).
    // avgDailySpend = (20 + 15) / 3 = 11.666...; endOfWeek = 20 + 15 + 11.666...*4.
    const result = buildWeekForecast(sessions, 15, 12, wednesday.getTime());
    expect(result).toBeCloseTo(20 + 15 + ((20 + 15) / 3) * 4, 5);
  });

  it('projects zero remaining days on a Sunday, so end of week is exactly week-to-date plus the end-of-day forecast', () => {
    const sunday = nextWeekday(new Date(2026, 0, 1), 0);
    const todayStart = localStartOfDay(sunday.getTime());
    const monday = todayStart - 6 * 86_400_000;
    const sessions = [
      makeSession(monday + 60_000, 10), // Monday
      makeSession(monday + 86_400_000 + 60_000, 5), // Tuesday
    ];

    const result = buildWeekForecast(sessions, 8, 8, sunday.getTime());
    expect(result).toBe(15 + 8);
  });

  it('never returns less than the end-of-day forecast', () => {
    const wednesday = nextWeekday(new Date(2026, 0, 1), 3);
    // No week-to-date sessions and a forecast below todayTotal — the
    // effective floor (todayTotal) must still be respected.
    const result = buildWeekForecast([], 5, 20, wednesday.getTime());
    expect(result).toBeGreaterThanOrEqual(20);
  });

  it('excludes sessions from a previous week', () => {
    const wednesday = nextWeekday(new Date(2026, 0, 1), 3);
    const todayStart = localStartOfDay(wednesday.getTime());
    const monday = todayStart - 2 * 86_400_000;
    const thisWeekOnly = [makeSession(monday + 60_000, 10)];
    const withLastWeek = [
      ...thisWeekOnly,
      makeSession(monday - 7 * 86_400_000 + 60_000, 1000), // last week's Monday
    ];

    const baseline = buildWeekForecast(thisWeekOnly, 15, 12, wednesday.getTime());
    const withStale = buildWeekForecast(withLastWeek, 15, 12, wednesday.getTime());
    expect(withStale).toBe(baseline);
  });
});

describe('buildMonthForecast()', () => {
  function makeSession(startTime: number, estimatedCostUsd: number): ForecastSessionInput {
    return { startTime, estimatedCostUsd };
  }

  it('sums month-to-date and projects the remaining days from the average daily pace', () => {
    const todayMs = new Date(2026, 4, 15, 12, 0, 0, 0).getTime(); // May 15, 2026
    const monthFirst = localStartOfDay(new Date(2026, 4, 1, 12, 0, 0, 0).getTime());

    const sessions = [
      makeSession(monthFirst + 60_000, 10), // May 1
      makeSession(monthFirst + 86_400_000 + 60_000, 8), // May 2
    ];

    // monthToDateExcludingToday = 18, effectiveEod = max(12, 10) = 12.
    // daysElapsedIncludingToday = 15 (May 1-15), remainingFullDays = 16 (May 16-31).
    // avgDailySpend = (18 + 12) / 15 = 2; endOfMonth = 18 + 12 + 2 * 16 = 62.
    const result = buildMonthForecast(sessions, 12, 10, todayMs);
    expect(result).toBeCloseTo(18 + 12 + ((18 + 12) / 15) * 16, 5);
  });

  it('handles sessions from the current month correctly and excludes sessions from prior months', () => {
    const todayMs = new Date(2026, 4, 20, 12, 0, 0, 0).getTime(); // May 20, 2026
    const monthFirst = localStartOfDay(new Date(2026, 4, 1, 12, 0, 0, 0).getTime());
    const aprilLast = monthFirst - 86_400_000; // Last day of April

    const thisMonthOnly = [makeSession(monthFirst + 60_000, 15)];
    const withLastMonth = [
      ...thisMonthOnly,
      makeSession(aprilLast, 1000), // April 30 — should be excluded
    ];

    const baseline = buildMonthForecast(thisMonthOnly, 12, 10, todayMs);
    const withStale = buildMonthForecast(withLastMonth, 12, 10, todayMs);
    expect(withStale).toBe(baseline);
  });

  it('projects zero remaining days at month-end, so end of month is exactly month-to-date plus the end-of-day forecast', () => {
    const todayMs = new Date(2026, 4, 31, 12, 0, 0, 0).getTime(); // May 31, 2026 (last day)
    const monthFirst = localStartOfDay(new Date(2026, 4, 1, 12, 0, 0, 0).getTime());

    const sessions = [makeSession(monthFirst + 60_000, 20)];

    const result = buildMonthForecast(sessions, 8, 8, todayMs);
    expect(result).toBe(20 + 8);
  });

  it('never returns less than the end-of-day forecast', () => {
    const todayMs = new Date(2026, 4, 15, 12, 0, 0, 0).getTime();
    const result = buildMonthForecast([], 5, 20, todayMs);
    expect(result).toBeGreaterThanOrEqual(20);
  });
});
