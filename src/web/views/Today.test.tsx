import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Today } from './Today';
import { useLiveStore } from '../store/liveStore';
import { qk } from '../api/client';

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
    expect(screen.getByText('spend today')).toBeInTheDocument();
    expect(screen.getByText('tool calls')).toBeInTheDocument();
    expect(screen.getByText('efficiency')).toBeInTheDocument();
    expect(screen.getByText('flags')).toBeInTheDocument();
  });

  it('renders today total cost in the spend KPI', () => {
    renderToday();
    expect(screen.getByText('$12.17')).toBeInTheDocument();
  });

  it('renders the efficiency score KPI', () => {
    renderToday();
    expect(screen.getByText('efficiency')).toBeInTheDocument();
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

  it('renders a real count for stuck_loop via the API-fallback path, not "?"', async () => {
    useLiveStore.setState({ antiPatterns: [] });
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url === '/api/anti-patterns') {
        return new Response(
          JSON.stringify([{ type: 'stuck_loop', command: 'npm test', repeatCount: 5 }]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    renderToday();
    await waitFor(() => expect(screen.getByText(/5× on/)).toBeInTheDocument());
    expect(screen.queryByText(/\?× on/)).toBeNull();
  });

  it('renders a real count for blind_editing via the API-fallback path, not "?"', async () => {
    useLiveStore.setState({ antiPatterns: [] });
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url === '/api/anti-patterns') {
        return new Response(
          JSON.stringify([{ type: 'blind_editing', file: 'app.ts', editCount: 3 }]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    renderToday();
    await waitFor(() => expect(screen.getByText(/3× on/)).toBeInTheDocument());
    expect(screen.queryByText(/\?× on/)).toBeNull();
  });

  it('renders a real count for over_delegation via the API-fallback path, not "?"', async () => {
    useLiveStore.setState({ antiPatterns: [] });
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url === '/api/anti-patterns') {
        return new Response(JSON.stringify([{ type: 'over_delegation', agentCount: 7 }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    renderToday();
    await waitFor(() => expect(screen.getByText(/7× on/)).toBeInTheDocument());
    expect(screen.queryByText(/\?× on/)).toBeNull();
  });

  it('does not show the empty state while concurrency/heatmap/liveSessions are still pending', async () => {
    // Zero out the cost/antiPatterns/tool-call state that resetStore() (in
    // the outer beforeEach) set to non-zero values, so calls === 0,
    // todayTotal === 0, and flagsCount === 0 all hold here — i.e.
    // `noActivityToday` WOULD evaluate true in this test if the
    // concurrency/heatmap/liveSessions pending gate weren't wired in.
    useLiveStore.setState({
      recentToolCalls: [],
      cost: null,
      antiPatterns: [],
      firingAlerts: new Map(),
      dismissedAlerts: new Set(),
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    // /api/concurrency never resolves for the duration of this test — this
    // simulates the race window where every other query has already settled
    // but concurrency (backing `concurrencyPending`) has not. No resolver is
    // needed: the test only asserts the empty state stays suppressed while
    // this query is pending, not that it eventually stops being pending.
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url === '/api/concurrency') {
        return new Promise<Response>(() => {
          // Intentionally never settles.
        });
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    renderToday(qc);

    // Wait until every other query (cost, aggregate, sessions, anti-patterns)
    // has settled — the "spend today" KPI moves off its loading ellipsis to
    // a real dollar value. This is the exact moment `noActivityToday` would
    // flip to true if `concurrencyPending` weren't part of the gate.
    await waitFor(() => expect(screen.getByText('$0.00')).toBeInTheDocument());

    // The empty state must still be suppressed, because /api/concurrency is
    // still pending.
    expect(screen.queryByText(/No activity yet today/)).toBeNull();
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

  // After 45b17db the forecast is clamped to at least todayTotal (you can't
  // un-spend money), so a raw forecast below current spend renders the
  // clamped value with an "on pace" annotation (delta ≤ 0 branch in
  // ForecastEodCard) — never a negative delta.
  it('clamps forecast to todayTotal when raw forecast is lower (F-017)', () => {
    useLiveStore.setState({
      cost: { sessionTotalUsd: 3.42, todayTotalUsd: 10, forecastEodUsd: 8 },
    });
    renderToday();
    // Clamped forecast = todayTotal = 10, delta is zero → "on pace"
    expect(screen.getByText(/on pace/)).toBeInTheDocument();
    // Legacy bug substrings must never appear
    expect(screen.queryByText(/\+\$-2\.00/)).toBeNull();
    expect(screen.queryByText(/\+\$0\.00/)).toBeNull();
    // Raw (uncramped) forecast value must not surface either
    expect(screen.queryByText(/\$8\.00/)).toBeNull();
  });

  it('still renders a positive delta with "+$" (F-017 regression guard)', () => {
    useLiveStore.setState({
      cost: { sessionTotalUsd: 3.42, todayTotalUsd: 10, forecastEodUsd: 12 },
    });
    renderToday();
    expect(screen.getByText(/\+\$2\.00/)).toBeInTheDocument();
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

  it('shows the subagent-tracking-disabled banner when watcherActive is false', async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/api/observability-health')) {
        return new Response(
          JSON.stringify({ watcherActive: false, watcherDisabledByLock: false }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    renderToday();
    expect(await screen.findByText(/subagent cost tracking is disabled/i)).toBeInTheDocument();
  });
});

describe('Today view — empty state', () => {
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
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a full-page empty state when there is no today activity', async () => {
    renderToday();
    expect(await screen.findByText('No activity yet today')).toBeInTheDocument();
    expect(screen.queryByText('spend today')).toBeNull();
    expect(screen.queryByText('tool calls')).toBeNull();
  });

  it('still renders the header with "Today" title in empty state', async () => {
    renderToday();
    await screen.findByText('No activity yet today');
    expect(screen.getByText('Today')).toBeInTheDocument();
  });

  it('renders the normal KPI view when there is today activity', () => {
    useLiveStore.setState({
      cost: { sessionTotalUsd: 1.5, todayTotalUsd: 1.5, forecastEodUsd: null },
    });
    renderToday();
    expect(screen.getByText('spend today')).toBeInTheDocument();
    expect(screen.queryByText('No activity yet today')).toBeNull();
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

// ---------------------------------------------------------------------------
// Task #17 (D3): cross-session aggregate KPIs and Today view UX
// ---------------------------------------------------------------------------

describe('Today view — aggregate endpoint', () => {
  beforeEach(() => {
    useLiveStore.setState({
      connected: true,
      recentToolCalls: [],
      cost: null,
      antiPatterns: [],
      firingAlerts: new Map(),
      dismissedAlerts: new Set(),
      activeSessionId: null,
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders KPIs from /api/sessions/today/aggregate (calls + flags + spend)', async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/api/sessions/today/aggregate')) {
        return new Response(
          JSON.stringify({
            toolCallCount: 42,
            totalCostUsd: 7.75,
            antiPatternCount: 3,
            avgDurationMs: 80,
            sessionCount: 2,
            sparkline: { startTimestamp: 0, bucketSizeMs: 60_000, points: [1, 2, 3] },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    renderToday();
    expect(await screen.findByText('42')).toBeInTheDocument();
    expect(screen.getByText('$7.75')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });
});

describe('Today view — selector default + Session ended badge', () => {
  beforeEach(() => {
    useLiveStore.setState({
      connected: true,
      recentToolCalls: [],
      cost: { sessionTotalUsd: 1, todayTotalUsd: 1, forecastEodUsd: null },
      antiPatterns: [],
      firingAlerts: new Map(),
      dismissedAlerts: new Set(),
      activeSessionId: null,
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults to most-recently-active live session (server returns sorted desc)', async () => {
    const liveSessions = [
      { sessionId: 'newest-id', sessionName: 'frontend', startTime: 1, lastActivity: 9_000 },
      { sessionId: 'older-id', sessionName: 'backend', startTime: 1, lastActivity: 1_000 },
    ];
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/api/sessions/live')) {
        return new Response(JSON.stringify(liveSessions), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/api/session/current')) {
        return new Response(
          JSON.stringify({
            sessionId: 'newest-id',
            liveSessions: ['newest-id', 'older-id'],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/api/sessions/today/aggregate')) {
        return new Response(
          JSON.stringify({
            toolCallCount: 1,
            totalCostUsd: 0,
            antiPatternCount: 0,
            avgDurationMs: 0,
            sessionCount: 2,
            sparkline: { startTimestamp: 0, bucketSizeMs: 60_000, points: [] },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes(`/api/sessions/newest-id/replay`)) {
        return new Response(JSON.stringify({ sessionId: 'newest-id', timeline: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/api/context')) {
        return new Response(
          JSON.stringify({
            turnCount: 0,
            growth: { startTokens: 0, currentTokens: 0, deltaTokens: 0 },
            currentBreakdown: { system: 0, tools: 0, user: 0, assistant: 0 },
            fillPercent: 0,
            toolContributions: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    renderToday();
    // The "frontend" session card should appear, sourced from the live API.
    expect(await screen.findByText('frontend')).toBeInTheDocument();
    // activeSessionId in the store should equal the most-recently-active id.
    await waitFor(() => {
      expect(useLiveStore.getState().activeSessionId).toBe('newest-id');
    });
  });

  it('shows the Session ended badge when the selected session leaves the live set', async () => {
    // Initial: one live session.
    let liveSessions = [
      { sessionId: 'fading-id', sessionName: 'fading', startTime: 1, lastActivity: 1_000 },
    ];
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/api/sessions/live')) {
        return new Response(JSON.stringify(liveSessions), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/api/sessions/today/aggregate')) {
        return new Response(
          JSON.stringify({
            toolCallCount: 1,
            totalCostUsd: 0,
            antiPatternCount: 0,
            avgDurationMs: 0,
            sessionCount: 1,
            sparkline: { startTimestamp: 0, bucketSizeMs: 60_000, points: [] },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes(`/api/sessions/fading-id/replay`)) {
        return new Response(
          JSON.stringify({
            sessionId: 'fading-id',
            timeline: [
              {
                timestamp: 1,
                toolName: 'Read',
                durationMs: 10,
                success: true,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/api/context')) {
        // Valid empty ContextApiResponse — keeps ContextBar from crashing
        // when the per-session ContextBar tries to fetch.
        return new Response(
          JSON.stringify({
            turnCount: 0,
            growth: { startTokens: 0, currentTokens: 0, deltaTokens: 0 },
            currentBreakdown: { system: 0, tools: 0, user: 0, assistant: 0 },
            fillPercent: 0,
            toolContributions: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    renderToday(qc);
    const sessionButton = await screen.findByText('fading');
    // The user has to explicitly select the session before the "Session ended"
    // pin behavior kicks in — we deliberately don't pin the default-selected
    // session, only an explicit click.
    sessionButton.click();
    // Now simulate the session ending — it leaves the live set.
    liveSessions = [];
    await qc.invalidateQueries({ queryKey: qk.sessionsLive });
    await waitFor(() => {
      expect(screen.getByTestId('session-ended-badge')).toBeInTheDocument();
    });
  });
});

describe('Today view — Cache Health panel', () => {
  beforeEach(() => {
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

  it('renders the Cache Health eyebrow', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    render(
      <QueryClientProvider client={qc}>
        <Today />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Cache Health')).toBeInTheDocument();
  });

  it('shows week-over-week improvement chip when delta is positive', async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/api/cache-health')) {
        return new Response(
          JSON.stringify({
            status: 'can_improve',
            cache_hit_rate_pct: 48,
            total_cache_read_tokens: 10000,
            total_cache_creation_tokens: 2000,
            total_savings_usd: 0.0012,
            week_over_week_delta_pts: 5,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    render(
      <QueryClientProvider client={qc}>
        <Today />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/↑5pts vs last week/i)).toBeInTheDocument();
  });

  it('shows week-over-week decline chip when delta is negative', async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/api/cache-health')) {
        return new Response(
          JSON.stringify({
            status: 'needs_attention',
            cache_hit_rate_pct: 18,
            total_cache_read_tokens: 5000,
            total_cache_creation_tokens: 1000,
            total_savings_usd: 0,
            week_over_week_delta_pts: -3,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    render(
      <QueryClientProvider client={qc}>
        <Today />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/↓3pts vs last week/i)).toBeInTheDocument();
  });

  it('includes actual hit rate pct in recommendation text', async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/api/cache-health')) {
        return new Response(
          JSON.stringify({
            status: 'needs_attention',
            cache_hit_rate_pct: 12,
            total_cache_read_tokens: 3000,
            total_cache_creation_tokens: 500,
            total_savings_usd: 0,
            week_over_week_delta_pts: null,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    render(
      <QueryClientProvider client={qc}>
        <Today />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/Cache hit rate is 12%/)).toBeInTheDocument();
    expect(await screen.findByText(/above 60%/)).toBeInTheDocument();
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
    // value/threshold formatted column (formatNumber: 12.5 → "12.5", 10 → "10.0").
    expect(screen.getByText(/12\.5 \/ 10\.0/)).toBeInTheDocument();
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

  // Regression for F-007: in cloud mode the alert engine isn't constructed
  // and /api/alerts/recent returns 404. The panel must render nothing —
  // not a permanent red error banner. Without this fix users running the
  // dashboard in cloud mode see "Error loading recent alerts" indefinitely.
  //
  // IMPORTANT: this test uses a QueryClient with default retries (3) so the
  // suppression must come from the component's own `retry: false`, not the
  // test harness's `retry: 0` default. Without this distinction, removing
  // `retry: false` from Today.tsx would still pass with the default helper.
  it('renders nothing (no error banner) when /api/alerts/recent returns 404', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response('{"error":"not_found"}', {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    // Default QueryClient — would retry 3× on a thrown error if the
    // component itself didn't set `retry: false` on the alerts query.
    renderToday(new QueryClient());

    // Wait long enough that React Query's retry timers (~1s exponential
    // backoff) would have fired if `retry: false` weren't honored.
    await new Promise((r) => setTimeout(r, 100));

    expect(screen.queryByText(/Error loading recent alerts/i)).toBeNull();
    expect(screen.queryByText(/recent alerts/i)).toBeNull();
    expect(screen.queryByText(/No alerts in recent history/i)).toBeNull();
    // Only one fetch call — the component's retry: false suppressed retries.
    // (Plus other queries the Today view fires; we only count alerts/recent.)
    const alertsCalls = fetchSpy.mock.calls.filter((c) =>
      String(c[0]).includes('/api/alerts/recent'),
    );
    expect(alertsCalls).toHaveLength(1);
  });

  // Regression for F-016: AlertLog.readRecent returns the file's last N
  // lines in append (chronological) order — oldest-first within the slice.
  // The panel must sort descending by firedAt so the most-recent firing
  // sits at the top.
  it('orders rows by firedAt descending (most recent first — F-016)', async () => {
    const oldAlert = {
      id: 'rule-old',
      state: 'firing' as const,
      severity: 'warning' as const,
      title: 'Old alert',
      description: 'd',
      value: 1,
      threshold: 0,
      firedAt: 1000,
    };
    const middleAlert = {
      id: 'rule-mid',
      state: 'firing' as const,
      severity: 'warning' as const,
      title: 'Middle alert',
      description: 'd',
      value: 1,
      threshold: 0,
      firedAt: 2000,
    };
    const newAlert = {
      id: 'rule-new',
      state: 'firing' as const,
      severity: 'warning' as const,
      title: 'New alert',
      description: 'd',
      value: 1,
      threshold: 0,
      firedAt: 3000,
    };
    // Server returns in append order (oldest first); UI must reverse.
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify([oldAlert, middleAlert, newAlert]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as typeof fetch;

    renderToday();

    await screen.findByText('New alert');
    const titles = screen.getAllByText(/(?:Old|Middle|New) alert/);
    expect(titles.map((el) => el.textContent)).toEqual(['New alert', 'Middle alert', 'Old alert']);
  });
});
