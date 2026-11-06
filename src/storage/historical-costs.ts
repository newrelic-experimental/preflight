import { createLogger } from '../shared/index.js';
import { localDateKey, todayPortionOfSessionCost } from '../lib/date.js';
import type { FullSessionSummary, SessionStore } from './session-store.js';

const logger = createLogger('historical-costs');

// A save folds split files into the file of their earliest day, whose name can
// fall before the window while its spend is recent. A session that started before
// the window counts only its days inside it, so older spend is not this week's.
function weeklyPortion(session: FullSessionSummary, weekAgo: Date): number {
  const utcDay = (date: Date): string => date.toISOString().slice(0, 10);
  if (utcDay(new Date(session.startTime)) >= utcDay(weekAgo)) {
    return session.estimatedCostUsd ?? 0;
  }
  const firstDay = localDateKey(weekAgo.getTime());
  return Object.entries(session.costByDayUsd ?? {}).reduce(
    (total, [day, cost]) => (day >= firstDay ? total + cost : total),
    0,
  );
}

// A record combined from days of pieces pro-rates badly, so its day map decides.
function dailyPortion(session: FullSessionSummary, refTs: number): number {
  return session.costByDayUsd
    ? (session.costByDayUsd[localDateKey(refTs)] ?? 0)
    : todayPortionOfSessionCost(session, refTs);
}

// Compute cost baselines from prior sessions for daily/weekly budget tracking.
//
// Called on every cost-update emission, not just at session start. Three reasons:
//   1) Sessions persisted by other MCP instances during this session need to
//      land in the daily/weekly totals.
//   2) Day rollover — a session running past midnight needs a refreshed
//      "today" baseline. Snapshotting at startup left long-running sessions
//      with stale yesterday-as-today bookkeeping forever.
//   3) Cross-midnight prior sessions need today-portion attribution, not
//      whole-session attribution by startTime. We use timeline-based
//      pro-rating via todayPortionOfSessionCost() so a session that ran
//      11pm→2am only contributes its 2-hour today slice to the daily total.
//
// The current in-flight session is excluded from the prior totals so we don't
// double-count with costTracker.getCostForDay(today) on the caller side.
export function computeHistoricalCosts(
  sessionStore: Pick<SessionStore, 'loadAllSessions'>,
  currentSessionId: string,
  refTs: number = Date.now(),
): { priorDailyCostUsd: number; priorWeeklyCostUsd: number } {
  const weekAgo = new Date(refTs - 7 * 24 * 60 * 60 * 1000);
  let priorDailyCostUsd = 0;
  let priorWeeklyCostUsd = 0;
  try {
    const sessions = sessionStore.loadAllSessions({
      since: weekAgo,
      includeModifiedSince: weekAgo,
    });
    for (const session of sessions) {
      if (session.sessionId === currentSessionId) continue;
      if (session.estimatedCostUsd === null) continue;
      priorDailyCostUsd += dailyPortion(session, refTs);
      priorWeeklyCostUsd += weeklyPortion(session, weekAgo);
    }
  } catch (err) {
    // Non-fatal: fall back to session-only costs if history is unreadable
    logger.warn('Failed to load historical costs — budget thresholds may be inaccurate', {
      error: String(err),
    });
  }
  return { priorDailyCostUsd, priorWeeklyCostUsd };
}
