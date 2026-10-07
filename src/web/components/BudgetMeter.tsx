import type { JSX } from 'react';

import { Kpi, type KpiTone } from './Kpi';
import type { BudgetPeriod, ReportedSpend } from '../api/client';
import { fmtDateTime, fmtTimeOfDay, formatUsd } from '../lib/format';
import { isSameLocalDay, localStartOfDay } from '../../lib/date.js';

// Mirrors THRESHOLD_LEVELS in src/metrics/budget-tracker.ts (not importable —
// tsconfig.web.json excludes server source). 50 and 80 render as ticks on the
// bar; the tone turns amber at 80 and red at 100, matching Alerts' SpendBar.
const TICK_PCTS = [50, 80] as const;
const WARN_PCT = 80;
const EXCEEDED_PCT = 100;

export function budgetTone(pct: number): KpiTone {
  if (pct >= EXCEEDED_PCT) return 'bad';
  if (pct >= WARN_PCT) return 'warn';
  return 'neutral';
}

const BAR_COLOR: Record<KpiTone, string> = {
  neutral: 'bg-accent-green',
  good: 'bg-accent-green',
  warn: 'bg-accent-amber',
  bad: 'bg-accent-red',
};

/** Local Monday 00:00 of the week containing `ts`. */
function localStartOfWeek(ts: number): number {
  const d = new Date(localStartOfDay(ts));
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

/**
 * A reported value is stale once its period has rolled over: a daily figure
 * entered yesterday, or a weekly figure from before this Monday.
 */
export function isReportedSpendStale(reported: ReportedSpend, now: number): boolean {
  if (reported.periodKind === 'daily') return !isSameLocalDay(reported.asOf, now);
  return localStartOfWeek(reported.asOf) !== localStartOfWeek(now);
}

function MeterBar({
  label,
  pct,
  color,
  testId,
}: {
  label: string;
  pct: number;
  color: string;
  testId: string;
}): JSX.Element {
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-12 shrink-0">{label}</span>
      <div
        className="relative flex-1 h-1.5 bg-surface-5 rounded-full overflow-hidden"
        role="meter"
        aria-label={`${label} spend`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        data-testid={testId}
      >
        <div
          className={`h-full rounded-full ${color}`}
          style={{ width: `${Math.min(Math.max(pct, 0), 100)}%` }}
        />
        {TICK_PCTS.map((t) => (
          <span
            key={t}
            className="absolute top-0 h-full w-px bg-ink-subtle/50"
            style={{ left: `${t}%` }}
          />
        ))}
      </div>
    </div>
  );
}

export interface BudgetMeterProps {
  /** `GET /api/budget` → `daily`. The only source of the estimate. */
  readonly daily: BudgetPeriod | undefined;
  /** Org-reported spend from Settings; drawn as a second bar, never blended in. */
  readonly reported?: ReportedSpend | null;
  readonly now?: number;
}

/**
 * Today KPI-strip meter for the daily budget. Renders nothing when no daily
 * budget is set.
 */
export function BudgetMeter({
  daily,
  reported = null,
  now = Date.now(),
}: BudgetMeterProps): JSX.Element | null {
  if (!daily || daily.budgetUsd === null) return null;
  const budget = daily.budgetUsd;
  const pct = daily.pctUsed ?? (budget > 0 ? (daily.spentUsd / budget) * 100 : 0);
  const tone = budgetTone(pct);

  // Only a daily reported figure matches this meter's period.
  const dailyReported = reported?.periodKind === 'daily' ? reported : null;
  const stale = dailyReported ? isReportedSpendStale(dailyReported, now) : false;

  return (
    <Kpi
      label="daily budget"
      tone={tone}
      value={`${formatUsd(daily.spentUsd)} / ${formatUsd(budget)}`}
      sub={
        <div className="mt-1 space-y-1">
          <MeterBar
            label="estimate"
            pct={pct}
            color={BAR_COLOR[tone]}
            testId="budget-meter-estimate"
          />
          {dailyReported && (
            <MeterBar
              label="reported"
              pct={budget > 0 ? (dailyReported.amountUsd / budget) * 100 : 0}
              color={stale ? 'bg-ink-subtle' : 'bg-accent-blue'}
              testId="budget-meter-reported"
            />
          )}
          <div>
            {`${Math.round(pct)}% used`}
            {dailyReported &&
              (stale
                ? ` · reported ${formatUsd(dailyReported.amountUsd)} is stale (as of ${fmtDateTime(dailyReported.asOf)})`
                : ` · reported ${formatUsd(dailyReported.amountUsd)} as of ${fmtTimeOfDay(dailyReported.asOf)}`)}
          </div>
        </div>
      }
    />
  );
}
