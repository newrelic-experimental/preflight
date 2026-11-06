import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { DailyBudgetMeter } from './DailyBudgetMeter';

function budgetWithDaily(daily: {
  budgetUsd: number | null;
  spentUsd: number;
  pctUsed: number | null;
  exceeded: boolean;
}) {
  return {
    session: { budgetUsd: null, spentUsd: 0, pctUsed: null, exceeded: false },
    daily,
    weekly: { budgetUsd: null, spentUsd: 0, pctUsed: null, exceeded: false },
    alerts: [],
  };
}

function renderMeter(body: unknown) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
  globalThis.fetch = (async (url: string) => {
    if (url !== '/api/budget') throw new Error(`unexpected fetch ${url}`);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return render(
    <QueryClientProvider client={qc}>
      <DailyBudgetMeter />
    </QueryClientProvider>,
  );
}

describe('DailyBudgetMeter', () => {
  it('shows spend and a settings hint when no daily budget is set', async () => {
    renderMeter(
      budgetWithDaily({ budgetUsd: null, spentUsd: 1.5, pctUsed: null, exceeded: false }),
    );

    expect(await screen.findByText('$1.50')).toBeInTheDocument();
    expect(screen.getByText(/No daily budget set/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Set limits in Settings' })).toHaveAttribute(
      'href',
      '/settings',
    );
    expect(screen.queryByText('exceeded')).not.toBeInTheDocument();
  });

  it('shows spend against the cap while under budget', async () => {
    renderMeter(budgetWithDaily({ budgetUsd: 10, spentUsd: 4, pctUsed: 40, exceeded: false }));

    expect(await screen.findByText('$4.00 / $10.00 (40%)')).toBeInTheDocument();
    expect(screen.queryByText(/No daily budget set/)).not.toBeInTheDocument();
    expect(screen.queryByText('exceeded')).not.toBeInTheDocument();
  });

  it('flags the day as exceeded once spend passes the cap', async () => {
    renderMeter(budgetWithDaily({ budgetUsd: 10, spentUsd: 12.5, pctUsed: 125, exceeded: true }));

    expect(await screen.findByText('$12.50 / $10.00 (125%)')).toBeInTheDocument();
    expect(screen.getByText('exceeded')).toBeInTheDocument();
  });
});
