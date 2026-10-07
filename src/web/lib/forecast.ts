import { localStartOfDay } from '../../lib/date.js';

export interface ForecastSessionInput {
  readonly startTime?: number | null;
  readonly estimatedCostUsd?: number | null;
}

const MS_PER_DAY = 86_400_000;
const RUN_RATE_WINDOW_DAYS = 28;

/** Local midnight of the Monday starting the ISO week containing `nowMs`. */
function isoWeekMonday(nowMs: number): number {
  const todayStart = localStartOfDay(nowMs);
  const weekday = new Date(todayStart).getDay(); // 0 = Sunday .. 6 = Saturday
  const daysSinceMonday = weekday === 0 ? 6 : weekday - 1;
  return todayStart - daysSinceMonday * MS_PER_DAY;
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
 * Projects end-of-period spend as
 * `periodToDateExcludingToday + forecastEod + dailyRunRate * remainingFullDays`.
 *
 * `periodToDateExcludingToday` attributes each persisted session's full cost
 * to its local start day and sums the days from `periodStart` up to, but
 * excluding, today. `forecastEod` is clamped to at least `todayTotal` first
 * (mirroring ForecastEodCard's own clamp) so the projection never regresses
 * below money already spent today.
 *
 * `dailyRunRate` averages the trailing 28 days plus today's end-of-day
 * figure rather than only the period so far, so a quiet start to the week
 * or month doesn't project $0 for the rest of it. The window starts no
 * earlier than the oldest session's day, so a new user or a sample that
 * ran out of rows isn't diluted by days it has no data for.
 */
function projectPeriod(
  sessions: readonly ForecastSessionInput[],
  forecastEod: number,
  todayTotal: number,
  nowMs: number,
  periodStart: number,
  remainingFullDays: number,
): number {
  const effectiveEod = Math.max(forecastEod, todayTotal);
  const todayStart = localStartOfDay(nowMs);
  const windowStart = todayStart - RUN_RATE_WINDOW_DAYS * MS_PER_DAY;

  let periodToDateExcludingToday = 0;
  let windowSpend = 0;
  let earliestDayInWindow = todayStart;
  for (const s of sessions) {
    if (s.startTime == null || s.estimatedCostUsd == null || s.estimatedCostUsd <= 0) continue;
    if (s.startTime >= todayStart) continue;
    if (s.startTime >= periodStart) periodToDateExcludingToday += s.estimatedCostUsd;
    if (s.startTime >= windowStart) {
      windowSpend += s.estimatedCostUsd;
      earliestDayInWindow = Math.min(earliestDayInWindow, localStartOfDay(s.startTime));
    }
  }

  const windowDaysIncludingToday = Math.round((todayStart - earliestDayInWindow) / MS_PER_DAY) + 1;
  const dailyRunRate = (windowSpend + effectiveEod) / windowDaysIncludingToday;

  const endOfPeriod = periodToDateExcludingToday + effectiveEod + dailyRunRate * remainingFullDays;
  return Math.max(endOfPeriod, effectiveEod);
}

/** End-of-ISO-week projection; zero remaining days on a Sunday. */
export function buildWeekForecast(
  sessions: readonly ForecastSessionInput[],
  forecastEod: number,
  todayTotal: number,
  nowMs: number,
): number {
  const weekday = new Date(localStartOfDay(nowMs)).getDay();
  const remainingFullDays = weekday === 0 ? 0 : 7 - weekday;
  return projectPeriod(
    sessions,
    forecastEod,
    todayTotal,
    nowMs,
    isoWeekMonday(nowMs),
    remainingFullDays,
  );
}

/** End-of-calendar-month projection; zero remaining days on the last day. */
export function buildMonthForecast(
  sessions: readonly ForecastSessionInput[],
  forecastEod: number,
  todayTotal: number,
  nowMs: number,
): number {
  const remainingFullDays = Math.max(0, daysInMonth(nowMs) - new Date(nowMs).getDate());
  return projectPeriod(
    sessions,
    forecastEod,
    todayTotal,
    nowMs,
    monthStart(nowMs),
    remainingFullDays,
  );
}
