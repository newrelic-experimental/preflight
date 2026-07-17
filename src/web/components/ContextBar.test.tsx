import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ContextBar } from './ContextBar';
import type { ContextResponse } from '../api/client';

function renderContextBar(data: ContextResponse) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <ContextBar data={data} />
    </QueryClientProvider>,
  );
}

function makeContext(overrides: Partial<ContextResponse> = {}): ContextResponse {
  return {
    turnCount: 1,
    growth: { startTokens: 0, currentTokens: 100_000, deltaTokens: 100_000 },
    currentBreakdown: { system: 10_000, tools: 20_000, user: 30_000, assistant: 40_000 },
    fillPercent: 50,
    contextWindow: 200_000,
    toolContributions: [],
    history: [],
    ...overrides,
  };
}

describe('ContextBar', () => {
  it('flags the compacting state when currentTokens drops more than 30% from the previous render', () => {
    const { container, rerender } = renderContextBar(makeContext());
    const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    rerender(
      <QueryClientProvider client={client}>
        <ContextBar
          data={makeContext({
            growth: { startTokens: 0, currentTokens: 50_000, deltaTokens: -50_000 },
            fillPercent: 25,
          })}
        />
      </QueryClientProvider>,
    );
    expect(container.querySelector('.animate-compact-flash')).not.toBeNull();
  });

  it('does not flag compacting on a small drop (< 30%)', () => {
    const { container, rerender } = renderContextBar(makeContext());
    const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    rerender(
      <QueryClientProvider client={client}>
        <ContextBar
          data={makeContext({
            growth: { startTokens: 0, currentTokens: 90_000, deltaTokens: -10_000 },
            fillPercent: 45,
          })}
        />
      </QueryClientProvider>,
    );
    expect(container.querySelector('.animate-compact-flash')).toBeNull();
  });

  it('renders the "at capacity" pill only when fillPercent is at least 100', () => {
    renderContextBar(makeContext({ fillPercent: 100 }));
    expect(screen.getByText('at capacity')).toBeInTheDocument();
  });

  it('does not render the "at capacity" pill when fillPercent is below 100', () => {
    renderContextBar(makeContext({ fillPercent: 99 }));
    expect(screen.queryByText('at capacity')).not.toBeInTheDocument();
  });
});
