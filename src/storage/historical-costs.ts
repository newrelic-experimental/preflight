import { todayPortionOfSessionCost } from '../lib/date.js';
import { createLogger } from '../shared/index.js';
import type { FullSessionSummary, ListSessionsOptions } from './session-store.js';

const logger = createLogger('historical-costs');

/** Rolling window the weekly baseline is summed over. */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The slice of `SessionStore` this module needs. Narrower than the class so a
 * test can supply a fake without touching the filesystem; a real `SessionStore`
 * satisfies it.
 */
export interface HistoricalCostSessionSource {
  loadAllSessions(options?: ListSessionsOptions): FullSessionSummary[];
}

export interface HistoricalCosts {
  priorDailyCostUsd: number;
  priorWeeklyCostUsd: number;
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
  sessionStore: HistoricalCostSessionSource,
  currentSessionId: string,
  refTs: number = Date.now(),
): HistoricalCosts {
  const weekAgo = new Date(refTs - WEEK_MS);
  let priorDailyCostUsd = 0;
  let priorWeeklyCostUsd = 0;
  try {
    const sessions = sessionStore.loadAllSessions({ since: weekAgo });
    for (const session of sessions) {
      if (session.sessionId === currentSessionId) continue;
      if (session.estimatedCostUsd === null) continue;
      priorDailyCostUsd += todayPortionOfSessionCost(session, refTs);
      priorWeeklyCostUsd += session.estimatedCostUsd;
    }
  } catch (err) {
    // Non-fatal: fall back to session-only costs if history is unreadable
    logger.warn('Failed to load historical costs — budget thresholds may be inaccurate', {
      error: String(err),
    });
  }
  return { priorDailyCostUsd, priorWeeklyCostUsd };
}
