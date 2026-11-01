import { localStartOfDay } from '../lib/date.js';

const MIN_FORECAST_WINDOW_MS = 10 * 60_000;
const MODERATE_CONFIDENCE_WINDOW_MS = 30 * 60_000;
const minutes = (ms: number): number => ms / 60_000;

export interface CostForecast {
  readonly elapsedMs: number;
  readonly spentUsd: number;
  readonly rateUsdPerMs: number;
  readonly forecastEndOfDayUsd: number | null;
  readonly forecastEndOfWeekUsd: number | null;
  readonly forecastSessionEndUsd: number | null;
  readonly confidenceNote: string;
}

export interface CostForecastInputs {
  /** Total spend during the live session, used for the session-end forecast. */
  readonly sessionSpentUsd: number;
  /** Wall-clock start of the current session. */
  readonly sessionStartMs: number;
  /**
   * Optional daily anchor — when provided, the EoD forecast uses today's
   * burn rate (`dailySpentUsd / (now - dailyFirstActivityMs)`) instead of
   * the session-wide rate. This avoids two cross-midnight bugs:
   *   1) Inflated EoD baseline (yesterday's portion of a still-running
   *      session counted as "today's spend so far").
   *   2) Diluted burn rate (multi-day session averages busy hours with
   *      overnight idle hours, dragging the rate down).
   * When omitted, falls back to the session rate over `msUntilEndOfDay`,
   * which only matches reality when the session started today.
   */
  readonly dailySpentUsd?: number;
  readonly dailyFirstActivityMs?: number | null;
}

/**
 * Backward-compatible legacy entrypoint. Prefer `buildCostForecastFromInputs`
 * so the EoD forecast can be anchored to today's spend rather than the full
 * session.
 */
export function buildCostForecast(
  spentUsd: number,
  sessionStartMs: number,
  nowMs: number = Date.now(),
): CostForecast {
  return buildCostForecastFromInputs({ sessionSpentUsd: spentUsd, sessionStartMs }, nowMs);
}

export function buildCostForecastFromInputs(
  inputs: CostForecastInputs,
  nowMs: number = Date.now(),
): CostForecast {
  const { sessionSpentUsd, sessionStartMs, dailySpentUsd, dailyFirstActivityMs } = inputs;
  const elapsedMs = nowMs - sessionStartMs;
  if (elapsedMs < 1) {
    return {
      elapsedMs: 0,
      spentUsd: 0,
      rateUsdPerMs: 0,
      forecastEndOfDayUsd: null,
      forecastEndOfWeekUsd: null,
      forecastSessionEndUsd: null,
      confidenceNote: 'Insufficient data for forecast.',
    };
  }

  // Session running but nothing spent yet — return zero forecasts so callers
  // display $0.00 instead of "—".
  if (sessionSpentUsd === 0) {
    return {
      elapsedMs,
      spentUsd: 0,
      rateUsdPerMs: 0,
      forecastEndOfDayUsd: 0,
      forecastEndOfWeekUsd: 0,
      forecastSessionEndUsd: 0,
      confidenceNote: 'Session running — no spend recorded yet.',
    };
  }

  const sessionRateUsdPerMs = sessionSpentUsd / elapsedMs;

  // Local-time day boundary, matching the dashboard's day bucketing.
  const dayStartMs = localStartOfDay(nowMs);
  const dayEndMs = dayStartMs + 86_400_000;
  const msUntilEndOfDay = Math.max(0, dayEndMs - nowMs);

  // Day and week projections share one effective rate and base.
  let effectiveElapsedMs: number;
  let effectiveRateUsdPerMs: number;
  let effectiveBaseUsd: number;
  let anchorMissing = false;
  if (
    typeof dailySpentUsd === 'number' &&
    dailySpentUsd >= 0 &&
    typeof dailyFirstActivityMs === 'number' &&
    dailyFirstActivityMs > 0
  ) {
    effectiveElapsedMs = Math.max(1, nowMs - dailyFirstActivityMs);
    effectiveRateUsdPerMs = dailySpentUsd / effectiveElapsedMs;
    effectiveBaseUsd = dailySpentUsd;
  } else {
    // Without a daily anchor, only a session that began today has all its
    // spend in today's base. An older session's spend is mostly yesterday's.
    effectiveElapsedMs = elapsedMs;
    effectiveRateUsdPerMs = sessionRateUsdPerMs;
    effectiveBaseUsd = sessionSpentUsd;
    anchorMissing = sessionStartMs < dayStartMs;
  }
  const forecastHeld = anchorMissing || effectiveElapsedMs < MIN_FORECAST_WINDOW_MS;
  const project = (msRemaining: number): number | null =>
    forecastHeld ? null : effectiveBaseUsd + effectiveRateUsdPerMs * msRemaining;
  const forecastEndOfDayUsd = project(msUntilEndOfDay);

  // Local weekday, so the week boundary matches the local day boundary.
  const now = new Date(nowMs);
  const dayOfWeek = now.getDay();
  const isoDay = dayOfWeek === 0 ? 7 : dayOfWeek;
  const msUntilEndOfWeek = ((7 - isoDay) % 7) * 86_400_000 + msUntilEndOfDay;
  const forecastEndOfWeekUsd = project(msUntilEndOfWeek);

  // Assumes a full 8-hour workday as the session-end horizon — there's no
  // real "end of session" signal to anchor this forecast to otherwise.
  const SESSION_TARGET_MS = 8 * 60 * 60 * 1000;
  const msUntilSessionEnd = Math.max(0, SESSION_TARGET_MS - elapsedMs);
  const forecastSessionEndUsd =
    elapsedMs < MIN_FORECAST_WINDOW_MS
      ? null
      : sessionSpentUsd + sessionRateUsdPerMs * msUntilSessionEnd;

  // Grades the window of the number the caller sees: the day/week window while
  // those forecasts are shown, else the session window behind the session-end one.
  const sessionEndShown = forecastSessionEndUsd !== null;
  const gradedWindowMs = forecastHeld ? (sessionEndShown ? elapsedMs : 0) : effectiveElapsedMs;
  const minWindowMin = minutes(MIN_FORECAST_WINDOW_MS);
  const moderateWindowMin = minutes(MODERATE_CONFIDENCE_WINDOW_MS);
  let confidenceNote: string;
  if (gradedWindowMs < MIN_FORECAST_WINDOW_MS) {
    confidenceNote = `Low confidence — less than ${minWindowMin} minutes of data.`;
  } else if (gradedWindowMs < MODERATE_CONFIDENCE_WINDOW_MS) {
    confidenceNote = `Moderate confidence — based on less than ${moderateWindowMin} minutes of data.`;
  } else {
    confidenceNote = `Reasonable confidence — based on ${moderateWindowMin}+ minutes of data.`;
  }

  return {
    elapsedMs,
    spentUsd: sessionSpentUsd,
    rateUsdPerMs: sessionRateUsdPerMs,
    forecastEndOfDayUsd,
    forecastEndOfWeekUsd,
    forecastSessionEndUsd,
    confidenceNote,
  };
}
