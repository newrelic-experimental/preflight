import { createLogger } from '../shared/index.js';
import { localDateKey } from '../lib/date.js';
import { todayCostOfSummary } from '../metrics/cost-tracker-seed.js';
import type { FullSessionSummary, SessionStore } from './session-store.js';

const logger = createLogger('historical-costs');

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

// A resumed session keeps the start-date filename of its first day, so it can
// start before the window and still have spend inside it. Its cost for the
// window is the sum of its day map over the days in the window. Without a day
// map there is no way to say how much of it fell in the window, so it counts 0.
function startedBeforeWindow(session: FullSessionSummary, weekAgo: Date): boolean {
  return utcDay(session.startTime) < utcDay(weekAgo.getTime());
}

// The local day seven calendar days back. Subtracting 168 hours would land a
// day early in the hour after midnight when a clock change falls in the week.
function firstWindowDay(refTs: number): string {
  const date = new Date(refTs);
  date.setDate(date.getDate() - 7);
  return localDateKey(date.getTime());
}

function weeklyPortion(session: FullSessionSummary, weekAgo: Date, refTs: number): number {
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
function dailyPortion(session: FullSessionSummary, weekAgo: Date, refTs: number): number {
  if (!session.costByDayUsd && startedBeforeWindow(session, weekAgo)) return 0;
  return todayCostOfSummary(session, localDateKey(refTs), refTs).costUsd;
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
export function computeHistoricalCosts(
  sessionStore: Pick<SessionStore, 'loadAllSessions'>,
  /** Left out of the baseline; null leaves nothing out. */
  excluded: string | ReadonlySet<string> | null,
  refTs: number = Date.now(),
  /** Counts `summary` (nothing when null) in place of `sessionId`'s current file. */
  substitute?: { readonly sessionId: string; readonly summary: FullSessionSummary | null },
): { priorDailyCostUsd: number; priorWeeklyCostUsd: number } {
  const weekAgo = new Date(refTs - 7 * 24 * 60 * 60 * 1000);
  let priorDailyCostUsd = 0;
  let priorWeeklyCostUsd = 0;
  try {
    const sessions = sessionStore.loadAllSessions({
      since: weekAgo,
      includeModifiedSince: weekAgo,
    });
    for (const loaded of sessions) {
      if (
        typeof excluded === 'string'
          ? loaded.sessionId === excluded
          : excluded?.has(loaded.sessionId)
      ) {
        continue;
      }
      const session = loaded.sessionId === substitute?.sessionId ? substitute.summary : loaded;
      if (session === null || session.estimatedCostUsd === null) continue;
      priorDailyCostUsd += dailyPortion(session, weekAgo, refTs);
      priorWeeklyCostUsd += weeklyPortion(session, weekAgo, refTs);
    }
  } catch (err) {
    // Non-fatal: fall back to session-only costs if history is unreadable
    logger.warn('Failed to load historical costs — budget thresholds may be inaccurate', {
      error: String(err),
    });
  }
  return { priorDailyCostUsd, priorWeeklyCostUsd };
}
