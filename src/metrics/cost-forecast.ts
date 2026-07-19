import { localStartOfDay } from '../lib/date.js';

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

  // End-of-day boundary in **local** time, matching the rest of the dashboard
  // (lib/date.ts localStartOfDay). Previously this used UTC, which drifted
  // a forecast across the day boundary for non-UTC users.
  const dayStartMs = localStartOfDay(nowMs);
  const dayEndMs = dayStartMs + 86_400_000;
  const msUntilEndOfDay = Math.max(0, dayEndMs - nowMs);

  // Daily-anchored EoD/EoW forecast when caller supplies today's spend +
  // first-activity-of-day. Both the day and week projections use the same
  // effective rate and base so they are internally consistent: the week
  // forecast is simply the day forecast extended to the full remaining week.
  // Falls back to session rate/base when the daily anchor is absent.
  let effectiveRateUsdPerMs: number;
  let effectiveBaseUsd: number;
  if (
    typeof dailySpentUsd === 'number' &&
    dailySpentUsd >= 0 &&
    typeof dailyFirstActivityMs === 'number' &&
    dailyFirstActivityMs > 0
  ) {
    const dailyElapsedMs = Math.max(1, nowMs - dailyFirstActivityMs);
    effectiveRateUsdPerMs = dailySpentUsd / dailyElapsedMs;
    effectiveBaseUsd = dailySpentUsd;
  } else {
    effectiveRateUsdPerMs = sessionRateUsdPerMs;
    effectiveBaseUsd = sessionSpentUsd;
  }
  const forecastEndOfDayUsd = effectiveBaseUsd + effectiveRateUsdPerMs * msUntilEndOfDay;

  // ISO week ends on Sunday. Convert local getDay() (0=Sun…6=Sat) to ISO day (1=Mon…7=Sun)
  // then compute remaining days: Sunday → 0 remaining, Monday → 6, …, Saturday → 1.
  // Use getDay() (local) not getUTCDay() — the week boundary must match the local EoD boundary.
  const now = new Date(nowMs);
  const dayOfWeek = now.getDay();
  const isoDay = dayOfWeek === 0 ? 7 : dayOfWeek;
  const msUntilEndOfWeek = ((7 - isoDay) % 7) * 86_400_000 + msUntilEndOfDay;
  const forecastEndOfWeekUsd = effectiveBaseUsd + effectiveRateUsdPerMs * msUntilEndOfWeek;

  // Assumes a full 8-hour workday as the session-end horizon — there's no
  // real "end of session" signal to anchor this forecast to otherwise.
  const SESSION_TARGET_MS = 8 * 60 * 60 * 1000;
  const msUntilSessionEnd = Math.max(0, SESSION_TARGET_MS - elapsedMs);
  const forecastSessionEndUsd = sessionSpentUsd + sessionRateUsdPerMs * msUntilSessionEnd;

  const elapsedMinutes = elapsedMs / 60_000;
  const confidenceNote =
    elapsedMinutes < 10
      ? 'Low confidence — less than 10 minutes of data.'
      : elapsedMinutes < 30
        ? 'Moderate confidence — based on less than 30 minutes of data.'
        : 'Reasonable confidence — based on 30+ minutes of data.';

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
