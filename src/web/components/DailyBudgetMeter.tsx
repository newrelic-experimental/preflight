import type { JSX } from 'react';
import { Link } from 'wouter';

import { useBudgetStatus } from '../hooks/useBudgetStatus';
import { BudgetPeriodRow } from './BudgetPeriodRow';

export function DailyBudgetMeter(): JSX.Element | null {
  const budgetQ = useBudgetStatus();

  if (budgetQ.isError) {
    return <div className="mt-2 text-xs text-accent-red">Error loading daily budget.</div>;
  }
  const daily = budgetQ.data?.daily;
  if (!daily) return null;

  return (
    <div className="mt-3 border-t border-border-subtle pt-2">
      <BudgetPeriodRow label="daily" p={daily} />
      {daily.budgetUsd === null && (
        <p className="text-xs text-ink-muted">
          No daily budget set.{' '}
          <Link
            href="/settings"
            className="text-accent-cyan hover:underline transition-colors duration-150"
          >
            Set limits in Settings
          </Link>{' '}
          to enable warnings.
        </p>
      )}
    </div>
  );
}
