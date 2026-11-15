import { createLogger } from '../shared/index.js';
import { localDateKey } from '../lib/date.js';
import { todayCostOfSummary } from '../metrics/cost-tracker-seed.js';
import type { TodayCostSource } from '../metrics/cost-tracker-seed.js';
import type { FullSessionSummary, SessionStore } from './session-store.js';

const logger = createLogger('historical-costs');

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

// A resumed session keeps the start-date filename of its first day, so it can
// start before the window and still have spend inside it. Its cost for the
// window is the sum of its day map over the days in the window. Without a day
// map there is no way to say how much of it fell in the window, so it counts 0.
function startedBeforeWindow(session: TodayCostSource, weekAgo: Date): boolean {
  return utcDay(session.startTime) < utcDay(weekAgo.getTime());
}

// The local day seven calendar days back. Subtracting 168 hours would land a
// day early in the hour after midnight when a clock change falls in the week.
function firstWindowDay(refTs: number): string {
  const date = new Date(refTs);
  date.setDate(date.getDate() - 7);
  return localDateKey(date.getTime());
}

function weeklyPortion(session: TodayCostSource, weekAgo: Date, refTs: number): number {
  if (!startedBeforeWindow(session, weekAgo)) return session.estimatedCostUsd ?? 0;
  const firstDay = firstWindowDay(refTs);
  return Object.entries(session.costByDayUsd ?? {}).reduce(
    (total, [day, cost]) => (day >= firstDay ? total + cost : total),
    0,
  );
}

// todayCostOfSummary decides, so the budget baseline, Spend Today and the cost
// seed agree on one number: the day map when present, else a pro-rate that
// counts 0 for a session with no attributable activity. A session that started
// before the window and has no day map counts 0 here too, the same as in
// weeklyPortion, so it adds nothing to the day that it left out of the week.
function dailyPortion(session: TodayCostSource, weekAgo: Date, refTs: number): number {
  if (!session.costByDayUsd && startedBeforeWindow(session, weekAgo)) return 0;
  return todayCostOfSummary(session, localDateKey(refTs), refTs).costUsd;
}

/** A session's spend in each budget period, by the same rules for every writer. */
export interface PeriodCost {
  readonly todayUsd: number;
  readonly weekUsd: number;
}

export function periodCostOf(session: TodayCostSource, refTs: number): PeriodCost {
  const weekAgo = new Date(refTs - 7 * 24 * 60 * 60 * 1000);
  return {
    todayUsd: dailyPortion(session, weekAgo, refTs),
    weekUsd: weeklyPortion(session, weekAgo, refTs),
  };
}

// Compute cost baselines from prior sessions for daily/weekly budget tracking.
//
// Called on every cost-update emission, not just at session start. Four reasons:
//   1) Sessions persisted by other MCP instances during this session need to
//      land in the daily/weekly totals.
//   2) Day rollover — a session running past midnight needs a refreshed
//      "today" baseline. Snapshotting at startup left long-running sessions
//      with stale yesterday-as-today bookkeeping forever.
//   3) Cross-midnight prior sessions need today-portion attribution, not
//      whole-session attribution by startTime. We use timeline-based
//      pro-rating via todayPortionOfSessionCost() so a session that ran
//      11pm→2am only contributes its 2-hour today slice to the daily total.
//      A session that recorded a per-day cost map uses the map instead.
//   4) A session resumed from an earlier week keeps its first day's filename.
//      It is found by file modification time and counts only the days of its
//      day map that fall inside the window.
//
// The current in-flight session is excluded from the prior totals so we don't
// double-count with costTracker.getCostForDay(today) on the caller side.
//
// `held` names the sessions the caller's tracker already counts, each with the
// cost it holds for it: lifetime in its total, the day map in its day totals.
// Such a session adds what its file shows beyond that holding, so cost another
// writer saved still counts, and adds its in-window share minus the lifetime to
// the week, so prior total plus tracker total counts only the window's days.
export function computeHistoricalCosts(
  sessionStore: Pick<SessionStore, 'loadAllSessions'>,
  /** Left out of the baseline; null leaves nothing out. */
  currentSessionId: string | null,
  refTs: number = Date.now(),
  /** Counts `summary` (nothing when null) in place of `sessionId`'s current file. */
  substitute?: { readonly sessionId: string; readonly summary: FullSessionSummary | null },
  held: ReadonlyMap<string, TodayCostSource> = new Map(),
): { priorDailyCostUsd: number; priorWeeklyCostUsd: number } {
  const weekAgo = new Date(refTs - 7 * 24 * 60 * 60 * 1000);
  let priorDailyCostUsd = 0;
  let priorWeeklyCostUsd = 0;
  try {
    const sessions = sessionStore.loadAllSessions({
      since: weekAgo,
      includeModifiedSince: weekAgo,
    });
    const saved = new Map<string, FullSessionSummary>();
    for (const loaded of sessions) {
      if (loaded.sessionId === currentSessionId) continue;
      if (held.has(loaded.sessionId)) {
        saved.set(loaded.sessionId, loaded);
        continue;
      }
      const session = loaded.sessionId === substitute?.sessionId ? substitute.summary : loaded;
      if (session === null || session.estimatedCostUsd === null) continue;
      const period = periodCostOf(session, refTs);
      priorDailyCostUsd += period.todayUsd;
      priorWeeklyCostUsd += period.weekUsd;
    }
    for (const [sessionId, holding] of held) {
      const mine = periodCostOf(holding, refTs);
      const file = saved.get(sessionId);
      const theirs = file && file.estimatedCostUsd !== null ? periodCostOf(file, refTs) : mine;
      priorDailyCostUsd += Math.max(theirs.todayUsd, mine.todayUsd) - mine.todayUsd;
      priorWeeklyCostUsd +=
        Math.max(theirs.weekUsd, mine.weekUsd) - (holding.estimatedCostUsd ?? 0);
    }
  } catch (err) {
    // Non-fatal: fall back to session-only costs if history is unreadable
    logger.warn('Failed to load historical costs — budget thresholds may be inaccurate', {
      error: String(err),
    });
  }
  return { priorDailyCostUsd, priorWeeklyCostUsd };
}
