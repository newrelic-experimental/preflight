import { localDateKey } from '../lib/date.js';

export type BudgetPeriod = 'session' | 'daily' | 'weekly';

// Rolling 7-day spend moves in both directions, so a weekly threshold re-arms
// only once spend falls this many percentage points below it. Without the gap
// spend hovering at the threshold would re-alert on every update.
export const WEEKLY_REARM_MARGIN_PCT = 10;

export function budgetPeriodId(period: BudgetPeriod, now?: number): string {
  if (period === 'session') return 'session:infinite';
  if (period === 'daily') return `day:${localDateKey(now)}`;
  return 'week:rolling-7d';
}

export function isThresholdRearmed(period: BudgetPeriod, pctUsed: number, level: number): boolean {
  return period === 'weekly' && pctUsed < level - WEEKLY_REARM_MARGIN_PCT;
}
