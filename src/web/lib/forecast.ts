import { localStartOfDay } from '../../lib/date.js';

export interface ForecastSessionInput {
  readonly startTime?: number | null;
  readonly estimatedCostUsd?: number | null;
}

const MS_PER_DAY = 86_400_000;

/** Local midnight of the Monday starting the ISO week containing `nowMs`. */
function isoWeekMonday(nowMs: number): number {
  const todayStart = localStartOfDay(nowMs);
  const weekday = new Date(todayStart).getDay(); // 0 = Sunday .. 6 = Saturday
  const daysSinceMonday = weekday === 0 ? 6 : weekday - 1;
  return todayStart - daysSinceMonday * MS_PER_DAY;
}

/**
 * Projects end-of-week spend from the same basis as the end-of-day forecast:
 * `weekToDateExcludingToday + forecastEod + avgDailySpend * remainingFullDays`.
 *
 * `weekToDateExcludingToday` attributes each persisted session's full cost to
 * its local start day (rather than prorating cross-midnight sessions by
 * overlap, as `todayPortionOfSession` does) and sums the days from this
 * week's Monday up to, but excluding, today — sessions from a previous week
 * are excluded by the Monday floor. `forecastEod` is clamped to at least
 * `todayTotal` first (mirroring ForecastEodCard's own clamp) so the
 * projection never regresses below money already spent today.
 *
 * `avgDailySpend` divides that same numerator by the number of days elapsed
 * so far this week including today, then multiplies by the full days
 * remaining through Sunday — zero on a Sunday, since there are none left.
 * The result is never below the end-of-day figure it's built on.
 */
export function buildWeekForecast(
  sessions: readonly ForecastSessionInput[],
  forecastEod: number,
  todayTotal: number,
  nowMs: number,
): number {
  const effectiveEod = Math.max(forecastEod, todayTotal);
  const todayStart = localStartOfDay(nowMs);
  const weekMonday = isoWeekMonday(nowMs);

  let weekToDateExcludingToday = 0;
  for (const s of sessions) {
    if (s.startTime == null || s.estimatedCostUsd == null || s.estimatedCostUsd <= 0) continue;
    if (s.startTime < weekMonday || s.startTime >= todayStart) continue;
    weekToDateExcludingToday += s.estimatedCostUsd;
  }

  const daysElapsedIncludingToday = Math.round((todayStart - weekMonday) / MS_PER_DAY) + 1;
  const weekday = new Date(todayStart).getDay();
  const remainingFullDays = weekday === 0 ? 0 : 7 - weekday;
  const avgDailySpend =
    (weekToDateExcludingToday + effectiveEod) / Math.max(1, daysElapsedIncludingToday);

  const endOfWeek = weekToDateExcludingToday + effectiveEod + avgDailySpend * remainingFullDays;
  return Math.max(endOfWeek, effectiveEod);
}

/** Local midnight of the 1st of the calendar month containing `nowMs`. */
function monthStart(nowMs: number): number {
  const d = new Date(nowMs);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

/** Number of days in the calendar month containing `nowMs`. */
function daysInMonth(nowMs: number): number {
  const d = new Date(nowMs);
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

/**
 * Projects end-of-month spend using the same basis as `buildWeekForecast`,
 * substituting calendar-month boundaries for ISO-week boundaries:
 * `monthToDateExcludingToday + forecastEod + avgDailySpend * remainingFullDays`.
 * See `buildWeekForecast`'s doc comment for the shape of this reasoning —
 * it applies identically here, just against the 1st-of-month floor and the
 * month's actual day count instead of Monday and 7.
 */
export function buildMonthForecast(
  sessions: readonly ForecastSessionInput[],
  forecastEod: number,
  todayTotal: number,
  nowMs: number,
): number {
  const effectiveEod = Math.max(forecastEod, todayTotal);
  const todayStart = localStartOfDay(nowMs);
  const monthFirst = monthStart(nowMs);

  let monthToDateExcludingToday = 0;
  for (const s of sessions) {
    if (s.startTime == null || s.estimatedCostUsd == null || s.estimatedCostUsd <= 0) continue;
    if (s.startTime < monthFirst || s.startTime >= todayStart) continue;
    monthToDateExcludingToday += s.estimatedCostUsd;
  }

  const daysElapsedIncludingToday = Math.round((todayStart - monthFirst) / MS_PER_DAY) + 1;
  const dayOfMonth = new Date(todayStart).getDate();
  const remainingFullDays = Math.max(0, daysInMonth(nowMs) - dayOfMonth);
  const avgDailySpend =
    (monthToDateExcludingToday + effectiveEod) / Math.max(1, daysElapsedIncludingToday);

  const endOfMonth = monthToDateExcludingToday + effectiveEod + avgDailySpend * remainingFullDays;
  return Math.max(endOfMonth, effectiveEod);
}
