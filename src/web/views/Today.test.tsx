import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Today } from './Today';
import { useLiveStore } from '../store/liveStore';

function renderToday(qc?: QueryClient) {
  const client =
    qc ??
    new QueryClient({
      defaultOptions: { queries: { retry: 0 } },
    });
  return render(
    <QueryClientProvider client={client}>
      <Today />
    </QueryClientProvider>,
  );
}

function resetStore(): void {
  useLiveStore.setState({
    connected: true,
    recentToolCalls: [
      { id: 'a', tool: 'Read', durationMs: 120, costUsd: 0.001, ts: 1 },
      { id: 'b', tool: 'Edit', durationMs: 85, costUsd: 0.002, ts: 2 },
    ],
    cost: { sessionTotalUsd: 3.42, todayTotalUsd: 12.17, forecastEodUsd: 18.4 },
    antiPatterns: [{ type: 'thrashing', target: 'auth.ts', count: 4 }],
    firingAlerts: new Map(),
    dismissedAlerts: new Set(),
  });
}

describe('Today view', () => {
  beforeEach(() => {
    resetStore();
    // Default: stub fetch with an empty alerts array so the panel doesn't
    // throw a network error during the basic-render assertions below.
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as typeof fetch;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the four KPI labels', () => {
    renderToday();
    expect(screen.getByText('spend')).toBeInTheDocument();
    expect(screen.getByText('calls')).toBeInTheDocument();
    expect(screen.getByText('eff.')).toBeInTheDocument();
    expect(screen.getByText('flags')).toBeInTheDocument();
  });

  it('renders today total cost in the spend KPI', () => {
    renderToday();
    expect(screen.getByText('$12.17')).toBeInTheDocument();
  });

  it('renders the recent tool calls table', () => {
    renderToday();
    expect(screen.getByText('Read')).toBeInTheDocument();
    expect(screen.getByText('Edit')).toBeInTheDocument();
  });

  it('renders an anti-pattern banner when patterns exist', () => {
    renderToday();
    expect(screen.getByText(/thrashing/i)).toBeInTheDocument();
    expect(screen.getByText(/auth\.ts/)).toBeInTheDocument();
  });

  it('hides the banner when no anti-patterns', () => {
    useLiveStore.setState({ antiPatterns: [] });
    renderToday();
    expect(screen.queryByText(/thrashing/i)).toBeNull();
  });

  it('renders the forecast-EOD card with the projected end-of-day spend', () => {
    renderToday();
    expect(screen.getByText(/forecast/i)).toBeInTheDocument();
    expect(screen.getByText('$18.40')).toBeInTheDocument();
  });

  it('shows the delta from current spend to forecast', () => {
    // todayTotal=12.17, forecastEodUsd=18.4 → delta=6.23
    renderToday();
    expect(screen.getByText(/\+\$6\.23/)).toBeInTheDocument();
  });

  it('shows an "insufficient data" message when forecast is null', () => {
    useLiveStore.setState({
      cost: { sessionTotalUsd: 3.42, todayTotalUsd: 12.17, forecastEodUsd: null },
    });
    renderToday();
    expect(screen.getByText(/insufficient data/i)).toBeInTheDocument();
    // Should not display a dollar value for the forecast.
    expect(screen.queryByText(/\$18\.40/)).toBeNull();
  });

  it('shows insufficient-data when cost has not loaded', () => {
    useLiveStore.setState({ cost: null });
    renderToday();
    expect(screen.getByText(/insufficient data/i)).toBeInTheDocument();
  });
});

describe('Today header timestamp', () => {
  beforeEach(() => {
    useLiveStore.setState({
      connected: true,
      recentToolCalls: [],
      cost: { sessionTotalUsd: 0, todayTotalUsd: 0, forecastEodUsd: null },
      antiPatterns: [],
      firingAlerts: new Map(),
      dismissedAlerts: new Set(),
    });
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as typeof fetch;
    vi.useFakeTimers();
    // 2026-05-29 14:00 local-ish — exact zone doesn't matter; the
    // assertion below only checks the value is stable across
    // re-renders, not what the formatted string contains.
    vi.setSystemTime(new Date('2026-05-29T18:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('memoizes the header timestamp across re-renders', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    const { rerender, container } = render(
      <QueryClientProvider client={qc}>
        <Today />
      </QueryClientProvider>,
    );

    const headerSpan = container.querySelector('header span')!;
    const before = headerSpan.textContent;
    expect(before).toBeTruthy();

    // Advance the system clock far enough that an unmemoized
    // timestamp would format to a different minute, then trigger
    // a re-render via a store update.
    vi.setSystemTime(new Date('2026-05-29T19:30:00Z'));
    act(() => {
      useLiveStore.setState({ antiPatterns: [{ type: 'flag', target: 'x', count: 1 }] });
    });
    rerender(
      <QueryClientProvider client={qc}>
        <Today />
      </QueryClientProvider>,
    );

    const after = container.querySelector('header span')!.textContent;
    expect(after).toBe(before);
  });
});

describe('Today view — Recent alerts panel', () => {
  beforeEach(() => {
    resetStore();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls /api/alerts/recent and renders an empty state when the log is empty', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    renderToday();

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });
    const calls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes('/api/alerts/recent'))).toBe(true);

    expect(await screen.findByText(/No alerts in recent history/i)).toBeInTheDocument();
  });

  it('renders rows from a non-empty response', async () => {
    const now = Date.now();
    const fakeAlerts = [
      {
        id: 'rule-cost',
        state: 'firing',
        severity: 'warning',
        title: 'Cost spike',
        description: 'desc',
        value: 12.5,
        threshold: 10,
        firedAt: now - 5 * 60_000,
      },
      {
        id: 'rule-stuck',
        state: 'cleared',
        severity: 'critical',
        title: 'Stuck loop',
        description: 'desc',
        value: 2,
        threshold: 3,
        firedAt: now - 60 * 60_000,
      },
    ];
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(fakeAlerts), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as typeof fetch;

    renderToday();

    expect(await screen.findByText('Cost spike')).toBeInTheDocument();
    expect(screen.getByText('Stuck loop')).toBeInTheDocument();
    // value/threshold formatted column.
    expect(screen.getByText(/12\.50 \/ 10/)).toBeInTheDocument();
    // state column shows firing vs cleared.
    expect(screen.getByText('firing')).toBeInTheDocument();
    expect(screen.getByText('cleared')).toBeInTheDocument();
  });

  it('shows an error message when the request fails', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response('boom', {
          status: 500,
          statusText: 'Internal',
        }),
    ) as typeof fetch;

    renderToday();

    expect(await screen.findByText(/Error loading recent alerts/i)).toBeInTheDocument();
  });
});
