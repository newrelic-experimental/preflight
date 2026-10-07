import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { BudgetMeter, budgetTone, isReportedSpendStale } from './BudgetMeter';
import type { BudgetPeriod, ReportedSpend } from '../api/client';

function makePeriod(overrides: Partial<BudgetPeriod> = {}): BudgetPeriod {
  return { budgetUsd: 10, spentUsd: 3, pctUsed: 30, exceeded: false, ...overrides };
}

// Noon local time, so "yesterday" and "earlier today" never straddle a DST edge.
const NOW = new Date(2026, 8, 29, 12, 0, 0).getTime();
const HOUR = 3_600_000;

function makeReported(overrides: Partial<ReportedSpend> = {}): ReportedSpend {
  return { periodKind: 'daily', amountUsd: 5, asOf: NOW - HOUR, ...overrides };
}

describe('BudgetMeter', () => {
  it('renders nothing when no daily budget is set', () => {
    const { container } = render(<BudgetMeter daily={makePeriod({ budgetUsd: null })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing before the budget has loaded', () => {
    const { container } = render(<BudgetMeter daily={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows spent over budget and percent used in the neutral treatment', () => {
    render(<BudgetMeter daily={makePeriod()} now={NOW} />);
    expect(screen.getByText('daily budget')).toBeInTheDocument();
    const value = screen.getByText('$3.00 / $10.00');
    expect(value.className).toMatch(/text-ink-base/);
    expect(screen.getByText('30% used')).toBeInTheDocument();
    expect(screen.getByTestId('budget-meter-estimate')).toHaveAttribute('aria-valuenow', '30');
    expect(screen.queryByTestId('budget-meter-reported')).not.toBeInTheDocument();
  });

  it('switches to the warning treatment at 80 percent', () => {
    render(<BudgetMeter daily={makePeriod({ spentUsd: 8, pctUsed: 80 })} now={NOW} />);
    expect(screen.getByText('$8.00 / $10.00').className).toMatch(/text-accent-amber/);
    const bar = screen.getByTestId('budget-meter-estimate').firstElementChild;
    expect(bar?.className).toMatch(/bg-accent-amber/);
  });

  it('switches to the exceeded treatment at 100 percent', () => {
    render(
      <BudgetMeter daily={makePeriod({ spentUsd: 12, pctUsed: 120, exceeded: true })} now={NOW} />,
    );
    expect(screen.getByText('$12.00 / $10.00').className).toMatch(/text-accent-red/);
  });

  it('draws a separate reported bar with its as-of time, leaving the estimate as-is', () => {
    render(<BudgetMeter daily={makePeriod()} reported={makeReported()} now={NOW} />);
    const reported = screen.getByTestId('budget-meter-reported');
    expect(reported).toHaveAttribute('aria-valuenow', '50');
    expect(reported.firstElementChild?.className).toMatch(/bg-accent-blue/);
    expect(screen.getByTestId('budget-meter-estimate')).toHaveAttribute('aria-valuenow', '30');
    expect(screen.getByText('$3.00 / $10.00')).toBeInTheDocument();
    expect(screen.getByText(/reported \$5\.00 as of/)).toBeInTheDocument();
  });

  it('greys a reported value from a previous day and labels it stale', () => {
    render(
      <BudgetMeter
        daily={makePeriod()}
        reported={makeReported({ asOf: NOW - 24 * HOUR })}
        now={NOW}
      />,
    );
    const reported = screen.getByTestId('budget-meter-reported');
    expect(reported.firstElementChild?.className).toMatch(/bg-ink-subtle/);
    expect(screen.getByText(/reported \$5\.00 is stale/)).toBeInTheDocument();
  });

  it('ignores a weekly reported value on the daily meter', () => {
    render(
      <BudgetMeter
        daily={makePeriod()}
        reported={makeReported({ periodKind: 'weekly' })}
        now={NOW}
      />,
    );
    expect(screen.queryByTestId('budget-meter-reported')).not.toBeInTheDocument();
  });
});

describe('budgetTone', () => {
  it.each([
    [0, 'neutral'],
    [50, 'neutral'],
    [79.9, 'neutral'],
    [80, 'warn'],
    [99.9, 'warn'],
    [100, 'bad'],
  ] as const)('%s%% → %s', (pct, tone) => {
    expect(budgetTone(pct)).toBe(tone);
  });
});

describe('isReportedSpendStale', () => {
  // 2026-09-29 is a Tuesday.
  it('keeps a daily value fresh within the same local day', () => {
    expect(isReportedSpendStale(makeReported({ asOf: NOW - HOUR }), NOW)).toBe(false);
  });

  it('marks a daily value from yesterday stale', () => {
    expect(isReportedSpendStale(makeReported({ asOf: NOW - 24 * HOUR }), NOW)).toBe(true);
  });

  it('keeps a weekly value from Monday fresh and one from last Sunday stale', () => {
    expect(
      isReportedSpendStale(makeReported({ periodKind: 'weekly', asOf: NOW - 24 * HOUR }), NOW),
    ).toBe(false);
    expect(
      isReportedSpendStale(makeReported({ periodKind: 'weekly', asOf: NOW - 48 * HOUR }), NOW),
    ).toBe(true);
  });
});
