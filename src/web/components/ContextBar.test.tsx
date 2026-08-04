import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ContextBar, type ContextBarProps } from './ContextBar';
import type { ContextResponse } from '../api/client';
import { useLiveStore } from '../store/liveStore';

function makeHistory(count: number): ContextResponse['history'] {
  return Array.from({ length: count }, (_, i) => ({
    turnNumber: i + 1,
    timestamp: 0,
    inputTokens: (i + 1) * 10_000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    fillPercent: (((i + 1) * 10_000) / 200_000) * 100,
    breakdown: { system: 5_000, tools: 3_000, user: 1_500, assistant: 500 },
  }));
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

function renderContextBar(props: ContextBarProps): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <ContextBar {...props} />
    </QueryClientProvider>,
  );
}

function resetStore(): void {
  useLiveStore.setState({ contextBySession: new Map() });
}

describe('ContextBar — timeline expand/collapse', () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  it('hides the chevron toggle when history is empty', () => {
    renderContextBar({ data: makeContext({ history: [] }) });
    expect(screen.queryByRole('button', { name: 'Toggle context timeline' })).toBeNull();
  });

  it('hides the chevron toggle when history has exactly 1 turn', () => {
    renderContextBar({ data: makeContext({ history: makeHistory(1) }) });
    expect(screen.queryByRole('button', { name: 'Toggle context timeline' })).toBeNull();
  });

  it('shows the chevron toggle when history has 2 or more turns', () => {
    renderContextBar({ data: makeContext({ history: makeHistory(2) }) });
    expect(screen.getByRole('button', { name: 'Toggle context timeline' })).toBeInTheDocument();
  });

  it('timeline is collapsed by default (aria-expanded=false)', () => {
    renderContextBar({ data: makeContext({ history: makeHistory(3) }) });
    const btn = screen.getByRole('button', { name: 'Toggle context timeline' });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });

  it('expands the timeline on click (aria-expanded becomes true)', () => {
    renderContextBar({ data: makeContext({ history: makeHistory(3) }) });
    const btn = screen.getByRole('button', { name: 'Toggle context timeline' });
    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
  });

  it('collapses the timeline on second click', () => {
    renderContextBar({ data: makeContext({ history: makeHistory(3) }) });
    const btn = screen.getByRole('button', { name: 'Toggle context timeline' });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });

  it('resets the timeline to collapsed when sessionId changes', () => {
    const data = makeContext({ history: makeHistory(3) });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <ContextBar data={data} sessionId="s1" />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Toggle context timeline' }));
    expect(screen.getByRole('button', { name: 'Toggle context timeline' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );

    rerender(
      <QueryClientProvider client={qc}>
        <ContextBar data={data} sessionId="s2" />
      </QueryClientProvider>,
    );
    expect(screen.getByRole('button', { name: 'Toggle context timeline' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('omits the chevron toggle when expandable is false, even with 2+ turns', () => {
    renderContextBar({ data: makeContext({ history: makeHistory(3) }), expandable: false });
    expect(screen.queryByRole('button', { name: 'Toggle context timeline' })).toBeNull();
  });

  it('still shows the chevron toggle when expandable is true (explicit, not just default)', () => {
    renderContextBar({ data: makeContext({ history: makeHistory(3) }), expandable: true });
    expect(screen.getByRole('button', { name: 'Toggle context timeline' })).toBeInTheDocument();
  });
});

describe('ContextBar — composition/efficiency drill-down', () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  it('shows the top re-read file and dominant category once expanded', async () => {
    globalThis.fetch = ((url: string) => {
      if (url.startsWith('/api/context-efficiency')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              uniqueFilesRead: 12,
              totalReadOperations: 20,
              repeatedReadCount: 8,
              repeatedReadRatio: 0.4,
              topRepeatedFiles: [{ file: 'src/index.ts', readCount: 4 }],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      if (url.startsWith('/api/context-composition')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              currentFillPercent: 62,
              currentBreakdown: {
                system_prompt: 1000,
                conversation_history: 3000,
                tool_results: 5000,
                injected_file_content: 500,
                other: 100,
              },
              turnCount: 5,
              thresholdAlerts: [],
              dominanceAlerts: [],
              history: [],
              note: '',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      return Promise.resolve(new Response('null', { status: 200 }));
    }) as typeof globalThis.fetch;
    renderContextBar({ data: makeContext({ history: makeHistory(3) }) });
    fireEvent.click(screen.getByRole('button', { name: 'Toggle context timeline' }));
    expect(await screen.findByText(/src\/index\.ts/)).toBeInTheDocument();
    expect(screen.getByText(/40%/)).toBeInTheDocument();
  });
});

describe('ContextBar', () => {
  it('flags the compacting state when currentTokens drops more than 30% from the previous render', () => {
    const { container, rerender } = renderContextBar({ data: makeContext() });
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
    const { container, rerender } = renderContextBar({ data: makeContext() });
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
    renderContextBar({ data: makeContext({ fillPercent: 100 }) });
    expect(screen.getByText('at capacity')).toBeInTheDocument();
  });

  it('does not render the "at capacity" pill when fillPercent is below 100', () => {
    renderContextBar({ data: makeContext({ fillPercent: 99 }) });
    expect(screen.queryByText('at capacity')).not.toBeInTheDocument();
  });
});
