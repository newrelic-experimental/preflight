import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Today } from './Today';
import { useLiveStore } from '../store/liveStore';
import { qk } from '../api/client';
import { localStartOfDay } from '../../lib/date.js';

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

  it('renders a generic fallback banner when the flags KPI is nonzero but every anti-pattern source is empty', async () => {
    useLiveStore.setState({ antiPatterns: [] });
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/api/sessions/today/aggregate')) {
        return new Response(JSON.stringify({ antiPatternCount: 3 }), {
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
    expect(await screen.findByText(/3 flag\(s\) detected today/i)).toBeInTheDocument();
  });

  it('does not show a retry-detector tokens-wasted annotation on the thrashing banner', async () => {
    // Even when a retry-alerts entry happens to share a name with the
    // anti-pattern's file-path target, the banner must not cross-reference
    // it — RetryDetector groups by literal tool name, an unrelated key.
    useLiveStore.setState({ antiPatterns: [{ type: 'thrashing', target: 'auth.ts', count: 4 }] });
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url === '/api/retry-alerts') {
        return new Response(
          JSON.stringify({
            alerts: [
              {
                toolName: 'auth.ts',
                occurrences: 4,
                windowSize: 5,
                similarity: 0.9,
                tokensWastedEstimate: 750,
                timestamp: Date.now(),
              },
            ],
            totalTokensWasted: 750,
            totalAlertsEmitted: 1,
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
    expect(await screen.findByText(/thrashing/i)).toBeInTheDocument();
    expect(screen.queryByText(/tokens wasted/i)).toBeNull();
  });

  function stubTurnCostsAndDecisionTree(turnCount = 1): void {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.startsWith('/api/turn-costs')) {
        return new Response(
          JSON.stringify({
            turns: Array.from({ length: turnCount }, (_, i) => ({
              turnId: `t${i + 1}`,
              startTime: i,
              endTime: i + 1,
              toolCalls: [`toolu_00${i + 1}`],
              toolNames: [i === turnCount - 1 ? 'Bash' : 'Read'],
              inputTokens: 500,
              outputTokens: 200,
              cacheReadTokens: 0,
              model: 'claude-sonnet-5',
              estimatedCostUsd: (i + 1) / 100,
              costPerToolCall: (i + 1) / 100,
            })),
            costByToolType: {},
            totalAttributedCost: (turnCount * (turnCount + 1)) / 2 / 100,
            attributionRate: 1,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.startsWith('/api/decision-tree')) {
        return new Response(
          JSON.stringify({
            totalBranches: 4,
            successRate: 0.5,
            failurePoints: [],
            longestFailureStreak: 2,
            firstFailureIndex: 1,
            note: '',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.startsWith('/api/context-composition')) {
        return new Response(
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
        );
      }
      if (url.startsWith('/api/context-efficiency')) {
        return new Response(
          JSON.stringify({
            uniqueFilesRead: 12,
            totalReadOperations: 20,
            repeatedReadCount: 8,
            repeatedReadRatio: 0.4,
            topRepeatedFiles: [{ file: 'src/index.ts', readCount: 4 }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('null', { status: 200 });
    }) as typeof globalThis.fetch;
  }

  it('shows a one-line trigger (not the full detail) in LiveSessionPane when data exists', async () => {
    stubTurnCostsAndDecisionTree(1);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    render(
      <QueryClientProvider client={qc}>
        <Today />
      </QueryClientProvider>,
    );
    expect(
      await screen.findByText(/2 failure streak.*1 turns.*\$0\.01.*session detail/i),
    ).toBeInTheDocument();
    // The full breakdown must NOT be inline — that's the whole point of the dialog.
    expect(screen.queryByText('Recent turns')).toBeNull();
  });

  it('opens the session detail dialog with every turn (not sliced to the last 5) on click', async () => {
    stubTurnCostsAndDecisionTree(6);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    render(
      <QueryClientProvider client={qc}>
        <Today />
      </QueryClientProvider>,
    );
    const trigger = await screen.findByText(/session detail/i);
    fireEvent.click(trigger);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    // 6th turn's cost ($0.06) would have been sliced off by the old `.slice(-5)`.
    expect(screen.getByText('$0.06')).toBeInTheDocument();
    expect(screen.getByText(/longest failure streak/i)).toBeInTheDocument();
    expect(await screen.findByText('tool_results')).toBeInTheDocument();
  });

  it('hides the trigger when neither tracker has data', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as typeof fetch;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    render(
      <QueryClientProvider client={qc}>
        <Today />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.queryByText(/session detail/i)).toBeNull());
  });

  // With two concurrently-live sessions (a documented, supported
  // scenario in `--local` mode), the session-detail drawer must only ever
  // show the SELECTED session's turn-cost/decision-tree data, not a blend
  // of both or whichever session this process-global tracker last recorded.
  it('scopes the session-detail drawer to the selected session when two sessions are concurrently live', async () => {
    const liveSessions = [
      { sessionId: 'session-alpha', sessionName: 'alpha', startTime: 1, lastActivity: 9_000 },
      { sessionId: 'session-beta', sessionName: 'beta', startTime: 1, lastActivity: 1_000 },
    ];
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/api/sessions/live')) {
        return new Response(JSON.stringify(liveSessions), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.startsWith('/api/turn-costs')) {
        const sessionId = new URL(url, 'http://localhost').searchParams.get('sessionId');
        const isAlpha = sessionId === 'session-alpha';
        return new Response(
          JSON.stringify({
            turns: [
              {
                turnId: 't1',
                startTime: 0,
                endTime: 1,
                toolCalls: ['toolu_1'],
                toolNames: ['Read'],
                inputTokens: 500,
                outputTokens: 200,
                cacheReadTokens: 0,
                model: 'claude-sonnet-5',
                estimatedCostUsd: isAlpha ? 0.11 : 0.99,
                costPerToolCall: isAlpha ? 0.11 : 0.99,
              },
            ],
            costByToolType: {},
            totalAttributedCost: isAlpha ? 0.11 : 0.99,
            attributionRate: 1,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.startsWith('/api/decision-tree')) {
        return new Response(
          JSON.stringify({
            totalBranches: 0,
            successRate: null,
            failurePoints: [],
            longestFailureStreak: 0,
            firstFailureIndex: null,
            note: '',
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
      if (url.includes('/api/sessions/session-alpha/replay')) {
        return new Response(JSON.stringify({ sessionId: 'session-alpha', timeline: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/api/sessions/session-beta/replay')) {
        return new Response(JSON.stringify({ sessionId: 'session-beta', timeline: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.startsWith('/api/context')) {
        return new Response(
          JSON.stringify({
            turnCount: 0,
            growth: { startTokens: 0, currentTokens: 0, deltaTokens: 0 },
            currentBreakdown: { system: 0, tools: 0, user: 0, assistant: 0 },
            fillPercent: 0,
            contextWindow: 200_000,
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

    // Default selection is the most-recently-active session (alpha).
    const alphaTrigger = await screen.findByText(/\$0\.11.*session detail/i);
    expect(alphaTrigger).toBeInTheDocument();
    expect(screen.queryByText(/\$0\.99/)).toBeNull();

    // Switch to beta — the drawer trigger must update to beta's own data,
    // not stay pinned to alpha's or show a blend of both.
    fireEvent.click(screen.getByText('beta'));
    const betaTrigger = await screen.findByText(/\$0\.99.*session detail/i);
    expect(betaTrigger).toBeInTheDocument();
    expect(screen.queryByText(/\$0\.11/)).toBeNull();
  });

  it('shows the session detail trigger from context-history data alone, with no decision/cost data', async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.startsWith('/api/context')) {
        return new Response(
          JSON.stringify({
            turnCount: 3,
            growth: { startTokens: 10_000, currentTokens: 30_000, deltaTokens: 20_000 },
            currentBreakdown: { system: 10_000, tools: 10_000, user: 5_000, assistant: 5_000 },
            fillPercent: 15,
            contextWindow: 200_000,
            toolContributions: [],
            history: [
              {
                turnNumber: 1,
                timestamp: 0,
                inputTokens: 10_000,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheCreationTokens: 0,
                fillPercent: 5,
                breakdown: { system: 5_000, tools: 3_000, user: 1_500, assistant: 500 },
              },
              {
                turnNumber: 2,
                timestamp: 1,
                inputTokens: 20_000,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheCreationTokens: 0,
                fillPercent: 10,
                breakdown: { system: 5_000, tools: 6_000, user: 3_000, assistant: 1_000 },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      // Exact match (not `startsWith`) — the session id below starts with
      // "live", so a prefix match would also swallow its own
      // `/api/sessions/live-context-only/replay` request.
      if (url === '/api/sessions/live') {
        return new Response(
          JSON.stringify([
            {
              sessionId: 'live-context-only',
              sessionName: 'live-context-only',
              startTime: 1,
              lastActivity: 1_000,
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      // Selecting the live session re-keys the liveStore's cost/antiPatterns
      // (liveStore.ts's setActiveSession filters out entries whose sessionId
      // doesn't match), zeroing the `resetStore()`-seeded values. Stub a
      // nonzero aggregate — as the other live-session tests in this file do
      // (e.g. 'defaults to most-recently-active live session') — so
      // `noActivityToday` stays false and the pane actually renders.
      if (url.startsWith('/api/sessions/today/aggregate')) {
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
      // decision-tree/turn-costs deliberately absent (resolve to `null`) so the
      // trigger can only be showing because of context-history data.
      return new Response('null', { status: 200 });
    }) as typeof globalThis.fetch;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    render(
      <QueryClientProvider client={qc}>
        <Today />
      </QueryClientProvider>,
    );
    const trigger = await screen.findByText(/session detail/i);
    // Neither decision-tree nor turn-costs data is present, so there's no
    // fragment for the em-dash separator to attach to — the button text
    // must not start with an orphaned " — ".
    expect(trigger.textContent).toBe('session detail →');
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

  it('renders anti-pattern detail from a persisted session when no live/API detail exists', async () => {
    useLiveStore.setState({ antiPatterns: [] });
    const startOfToday = new Date();
    startOfToday.setHours(1, 0, 0, 0);
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url === '/api/anti-patterns') {
        // This process's own live detector saw nothing.
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.startsWith('/api/sessions?')) {
        // A persisted session from a DIFFERENT process already has a flagged pattern.
        return new Response(
          JSON.stringify([
            {
              sessionId: 'other-process-session',
              startTime: startOfToday.getTime(),
              toolCallCount: 12,
              antiPatterns: [{ type: 'stuck_loop', command: 'npm run build', repeatCount: 6 }],
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    renderToday();

    await waitFor(() => expect(screen.getByText(/6× on/)).toBeInTheDocument());
    expect(screen.getByText(/npm run build/)).toBeInTheDocument();
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
    // Scoped to the "spend today" tile specifically — the "subagent spend"
    // KPI also renders "$0.00" in this fixture state, so an unscoped
    // `getByText('$0.00')` would throw on multiple-element ambiguity.
    await waitFor(() => {
      const spendTile = screen.getByText('spend today').closest('.px-1') as HTMLElement;
      expect(within(spendTile).getByText('$0.00')).toBeInTheDocument();
    });

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
  it('clamps forecast to todayTotal when raw forecast is lower', () => {
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

  it('still renders a positive delta with "+$"', () => {
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

  it('falls back to the cross-process aggregate forecast when the SSE cost push is unavailable', async () => {
    useLiveStore.setState({ cost: null });
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/api/sessions/today/aggregate')) {
        return new Response(JSON.stringify({ totalCostUsd: 5, forecastEndOfDayUsd: 8 }), {
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
    await waitFor(() => expect(screen.getByText('$8.00')).toBeInTheDocument());
    // delta = 8 - 5 = 3
    expect(screen.getByText(/\+\$3\.00/)).toBeInTheDocument();
  });

  function stubObservabilityHealth(body: Record<string, unknown>): void {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/api/observability-health')) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
  }

  it('shows the env-var-disabled banner when watcherDisabledReason is env_var', async () => {
    stubObservabilityHealth({
      watcherActive: false,
      watcherDisabledByLock: false,
      watcherDisabledReason: 'env_var',
    });

    renderToday();
    expect(await screen.findByText(/subagent cost tracking is disabled/i)).toBeInTheDocument();
    expect(screen.getByText(/NR_AI_ENABLE_SUBAGENT_WATCHER=0/)).toBeInTheDocument();
  });

  it('falls back to the env-var-disabled banner when watcherDisabledReason is absent (older server)', async () => {
    // No watcherDisabledReason field at all — simulates a dashboard daemon
    // running an older build that predates this field. Must not silently
    // hide the (still broadly correct) message in that case.
    stubObservabilityHealth({ watcherActive: false, watcherDisabledByLock: false });

    renderToday();
    expect(await screen.findByText(/subagent cost tracking is disabled/i)).toBeInTheDocument();
  });

  it('shows a mode-mismatch banner (not the env-var message) when watcherDisabledReason is mode_mismatch', async () => {
    // This is the --local dashboard daemon's default state: the watcher only
    // auto-starts in --stdio mode, so watcherActive is false here by design,
    // NOT because NR_AI_ENABLE_SUBAGENT_WATCHER is set to 0. Telling the user
    // to unset a variable that was never set would be actively misleading.
    stubObservabilityHealth({
      watcherActive: false,
      watcherDisabledByLock: false,
      watcherDisabledReason: 'mode_mismatch',
    });

    renderToday();
    expect(await screen.findByText(/subagent activity from other sessions/i)).toBeInTheDocument();
    expect(screen.queryByText(/subagent cost tracking is disabled/i)).toBeNull();
    expect(screen.queryByText(/NR_AI_ENABLE_SUBAGENT_WATCHER=0/)).toBeNull();
  });

  it('does not show the watcher-disabled banner when the cross-session aggregate reports nonzero subagent turns, even though the live SSE turn count is 0', async () => {
    // The live-only subagentStats.turns stays 0 in this test (no SSE frames
    // are ever pushed for it) while the polled aggregate endpoint — the same
    // one the "subagent spend" KPI above these banners already falls back
    // to — reports turns for today. The gate must agree with that KPI.
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/api/observability-health')) {
        return new Response(
          JSON.stringify({
            watcherActive: false,
            watcherDisabledByLock: false,
            watcherDisabledReason: 'env_var',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/api/sessions/today/aggregate')) {
        return new Response(JSON.stringify({ subagentTurnCount: 5 }), {
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
    await screen.findByText('5 turns');
    expect(screen.queryByText(/subagent cost tracking is disabled/i)).toBeNull();
    expect(screen.queryByText(/subagent activity from other sessions/i)).toBeNull();
  });

  it('keeps the ForecastEodCard parent+subagent breakdown summing to the displayed total even when the page-wide todayTotal/subagentUsd would disagree', async () => {
    // A fresh live SSE subagent tick (todaySubagentUsd) has landed while the
    // SSE total-spend push is stale-low and the polled aggregate hasn't
    // caught up to that subagent tick either. Maxing todayTotal and
    // subagentUsd independently across their own, different endpoint pairs
    // would let subagentUsd (15) exceed todayTotal (10), clamping "parent"
    // to $0 even though aggregate.totalCostUsd (10) and aggregate.subagentUsd
    // (8) — sourced together in one request — agree that parent is $2.
    useLiveStore.setState({
      cost: { sessionTotalUsd: 3, todayTotalUsd: 5, forecastEodUsd: 20 },
      todaySubagentUsd: 15,
      todaySubagentTurnCount: 3,
    });
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/api/sessions/today/aggregate')) {
        return new Response(
          JSON.stringify({ totalCostUsd: 10, subagentUsd: 8, forecastEndOfDayUsd: 20 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/api/sessions?limit=')) {
        return new Response(
          JSON.stringify([
            {
              sessionId: 's1',
              startTime: Date.now() - 60_000,
              estimatedCostUsd: 5,
              toolCallCount: 3,
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    renderToday();

    // All four assertions must hold together in the same settled render —
    // splitting them across separate waitFor/synchronous checks risks
    // observing a transitional DOM state where only some values have
    // committed.
    await waitFor(() => {
      expect(screen.getByText(/parent \$2\.00/)).toBeInTheDocument();
      expect(screen.getByText(/subagent \$8\.00/)).toBeInTheDocument();
      // Must never clamp "parent" to $0 just because the page-wide
      // todayTotal/subagentUsd picked different underlying sources.
      expect(screen.queryByText(/parent \$0\.00/)).toBeNull();
      // parent ($2.00) + subagent ($8.00) sums to the $10.00 the "spend today"
      // KPI shows for the same aggregate-sourced total.
      const spendTile = screen.getByText('spend today').closest('.px-1') as HTMLElement;
      expect(within(spendTile).getByText('$10.00')).toBeInTheDocument();
    });
  });

  it('does not let a legitimate zero from the aggregate override the forecast breakdown total when other sources already know about real spend', async () => {
    // The aggregate endpoint can legitimately resolve to 0 while its
    // disk-only sources haven't yet seen any events from today, even though
    // the SSE push and a persisted session both already know about real
    // spend. The Forecast card's breakdown must still be computed against
    // that already-higher total, not the aggregate's zero, or it would
    // contradict the "spend today" KPI shown directly above it.
    useLiveStore.setState({
      cost: { sessionTotalUsd: 8, todayTotalUsd: 8, forecastEodUsd: 12 },
      todaySubagentUsd: 2,
      todaySubagentTurnCount: 1,
    });
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/api/sessions/today/aggregate')) {
        return new Response(JSON.stringify({ totalCostUsd: 0, subagentUsd: 0 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/api/sessions?limit=')) {
        return new Response(
          JSON.stringify([
            {
              sessionId: 's1',
              startTime: Date.now() - 60_000,
              estimatedCostUsd: 6,
              toolCallCount: 3,
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    renderToday();

    // All assertions must hold together in the same settled render — see
    // the sibling test above for why these aren't split across separate
    // waitFor/synchronous checks.
    await waitFor(() => {
      const spendTile = screen.getByText('spend today').closest('.px-1') as HTMLElement;
      expect(within(spendTile).getByText('$8.00')).toBeInTheDocument();
      expect(screen.getByText(/parent \$6\.00/)).toBeInTheDocument();
      expect(screen.getByText(/subagent \$2\.00/)).toBeInTheDocument();
      expect(screen.queryByText(/parent \$0\.00/)).toBeNull();
      expect(screen.queryByText(/parent \$8\.00/)).toBeNull();
    });
  });

  it('folds the /api/cost REST fallback into todayTotal so the KPI does not flash $0.00 before the first SSE frame arrives', async () => {
    // No SSE cost frame has arrived yet, and the aggregate endpoint has
    // legitimately resolved to 0 (no disk-backed data yet from this
    // process) — only the /api/cost REST payload has this session's actual
    // today-scoped spend.
    useLiveStore.setState({ cost: null });
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url === '/api/cost') {
        return new Response(
          JSON.stringify({ cost: { sessionTotalCostUsd: 7 }, forecast: null, sessionTodayUsd: 7 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/api/sessions/today/aggregate')) {
        return new Response(JSON.stringify({ totalCostUsd: 0 }), {
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

    await waitFor(() => {
      const spendTile = screen.getByText('spend today').closest('.px-1') as HTMLElement;
      expect(within(spendTile).getByText('$7.00')).toBeInTheDocument();
    });
    expect(screen.queryByText(/No activity yet today/)).toBeNull();
  });

  it('falls back to the /api/cost REST forecast when neither SSE nor the aggregate has one', async () => {
    useLiveStore.setState({ cost: null });
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url === '/api/cost') {
        return new Response(
          JSON.stringify({
            cost: { sessionTotalCostUsd: 5 },
            forecast: { forecastEndOfDayUsd: 12 },
            sessionTodayUsd: 5,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/api/sessions/today/aggregate')) {
        return new Response(JSON.stringify({ totalCostUsd: 5 }), {
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

    await waitFor(() => expect(screen.getByText('$12.00')).toBeInTheDocument());
    // delta = 12 - 5 = 7
    expect(screen.getByText(/\+\$7\.00/)).toBeInTheDocument();
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
// Cross-session aggregate KPIs and Today view UX
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

  it('renders the efficiency KPI from the aggregate endpoint, not session/current', async () => {
    globalThis.fetch = vi.fn(async (input: string | RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/session/current')) {
        // This process's own live score is null — it must NOT be what renders.
        return new Response(JSON.stringify({ efficiencyScore: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/api/sessions/today/aggregate')) {
        return new Response(
          JSON.stringify({
            toolCallCount: 1,
            totalCostUsd: 0.01,
            antiPatternCount: 0,
            avgDurationMs: 100,
            sessionCount: 1,
            sparkline: { startTimestamp: 0, bucketSizeMs: 60_000, points: [1] },
            avgEfficiencyScore: 0.85,
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

    await waitFor(() => expect(screen.getByText('85%')).toBeInTheDocument());
  });

  it("renders the Latency panel from the aggregate endpoint's latency field, not /api/latency", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/api/sessions/today/aggregate')) {
        return new Response(
          JSON.stringify({
            toolCallCount: 1,
            totalCostUsd: 0.01,
            antiPatternCount: 0,
            avgDurationMs: 100,
            sessionCount: 1,
            sparkline: { startTimestamp: 0, bucketSizeMs: 60_000, points: [1] },
            latency: {
              overall: { p50: 111, p95: 222, p99: 333, min: 50, max: 400, count: 5 },
              byTool: {
                Read: { p50: 90, p95: 444, p99: 444, min: 50, max: 444, count: 3 },
                Edit: { p50: 130, p95: 555, p99: 555, min: 100, max: 555, count: 2 },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/api/latency')) {
        throw new Error(
          'LatencyPanel must read latency from the aggregate endpoint, not /api/latency',
        );
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    renderToday();

    expect(await screen.findByText('111')).toBeInTheDocument();
    expect(screen.getByText('222')).toBeInTheDocument();
    expect(screen.getByText('333')).toBeInTheDocument();
    expect(screen.getByText('444ms p95')).toBeInTheDocument();
    expect(screen.getByText('555ms p95')).toBeInTheDocument();
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
      if (url.includes('/api/sessions/today/aggregate')) {
        return new Response(
          JSON.stringify({
            toolCallCount: 0,
            totalCostUsd: 0,
            antiPatternCount: 0,
            avgDurationMs: 0,
            sessionCount: 1,
            sparkline: { startTimestamp: 0, bucketSizeMs: 60_000, points: [] },
            cacheHealth: {
              status: 'can_improve',
              cacheHitRatePct: 48,
              totalCacheReadTokens: 10000,
              totalCacheCreationTokens: 2000,
              totalSavingsUsd: 0.0012,
            },
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
      if (url.includes('/api/sessions/today/aggregate')) {
        return new Response(
          JSON.stringify({
            toolCallCount: 0,
            totalCostUsd: 0,
            antiPatternCount: 0,
            avgDurationMs: 0,
            sessionCount: 1,
            sparkline: { startTimestamp: 0, bucketSizeMs: 60_000, points: [] },
            cacheHealth: {
              status: 'needs_attention',
              cacheHitRatePct: 18,
              totalCacheReadTokens: 5000,
              totalCacheCreationTokens: 1000,
              totalSavingsUsd: 0,
            },
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
      if (url.includes('/api/sessions/today/aggregate')) {
        return new Response(
          JSON.stringify({
            toolCallCount: 0,
            totalCostUsd: 0,
            antiPatternCount: 0,
            avgDurationMs: 0,
            sessionCount: 1,
            sparkline: { startTimestamp: 0, bucketSizeMs: 60_000, points: [] },
            cacheHealth: {
              status: 'needs_attention',
              cacheHitRatePct: 12,
              totalCacheReadTokens: 3000,
              totalCacheCreationTokens: 500,
              totalSavingsUsd: 0,
            },
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

  it('renders the cache hit rate from the aggregate endpoint, not the per-process cache-health snapshot', async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/api/cache-health')) {
        // This process's own live tracker has zero cache activity — it must
        // NOT be what renders the headline percentage.
        return new Response(
          JSON.stringify({
            status: 'no_cache_activity',
            cache_hit_rate_pct: null,
            total_cache_read_tokens: 0,
            total_cache_creation_tokens: 0,
            total_savings_usd: 0,
            week_over_week_delta_pts: null,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/api/sessions/today/aggregate')) {
        return new Response(
          JSON.stringify({
            toolCallCount: 0,
            totalCostUsd: 0,
            antiPatternCount: 0,
            avgDurationMs: 0,
            sessionCount: 1,
            sparkline: { startTimestamp: 0, bucketSizeMs: 60_000, points: [] },
            cacheHealth: {
              status: 'excellent',
              cacheHitRatePct: 72,
              totalCacheReadTokens: 700,
              totalCacheCreationTokens: 100,
              totalSavingsUsd: 0.5,
            },
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
    expect(await screen.findByText('72%')).toBeInTheDocument();
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
      async (_url: RequestInfo | URL) =>
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

  // Regression test: in cloud mode the alert engine isn't constructed
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
      async (_url: RequestInfo | URL) =>
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

  // Regression test: AlertLog.readRecent returns the file's last N
  // lines in append (chronological) order — oldest-first within the slice.
  // The panel must sort descending by firedAt so the most-recent firing
  // sits at the top.
  it('orders rows by firedAt descending (most recent first)', async () => {
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

describe('Today view — Compute Waste panel', () => {
  beforeEach(() => {
    useLiveStore.setState({
      connected: true,
      recentToolCalls: [],
      cost: { sessionTotalUsd: 1, todayTotalUsd: 1, forecastEodUsd: null },
      antiPatterns: [],
      firingAlerts: new Map(),
      dismissedAlerts: new Set(),
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows clean status when total_tokens_wasted is 0', async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/api/compute-waste')) {
        return new Response(
          JSON.stringify({
            total_tokens_wasted: 0,
            retry_tokens_wasted: 0,
            anti_pattern_tokens_wasted: 0,
            breakdown: [],
            status: 'clean',
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
    expect(await screen.findByText(/~0 wasted tokens/)).toBeInTheDocument();
    expect(screen.getByText('clean')).toBeInTheDocument();
    expect(screen.getByText('No compute waste detected this session.')).toBeInTheDocument();
  });

  it('shows needs_attention status with top offender chip', async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/api/compute-waste')) {
        return new Response(
          JSON.stringify({
            total_tokens_wasted: 2400,
            retry_tokens_wasted: 800,
            anti_pattern_tokens_wasted: 1600,
            breakdown: [{ type: 'stuck_loop', tokens_wasted: 1600, instances: 2 }],
            status: 'needs_attention',
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
    expect(await screen.findByText(/~2,400 wasted tokens/)).toBeInTheDocument();
    expect(screen.getByText('needs attention')).toBeInTheDocument();
    expect(screen.getByText(/stuck loop/i)).toBeInTheDocument();
    expect(screen.getByText(/~1,600 tokens/)).toBeInTheDocument();
  });

  it('shows per-source breakdown sub-line', async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/api/compute-waste')) {
        return new Response(
          JSON.stringify({
            total_tokens_wasted: 600,
            retry_tokens_wasted: 200,
            anti_pattern_tokens_wasted: 400,
            breakdown: [{ type: 're_reading', tokens_wasted: 400, instances: 1 }],
            status: 'moderate',
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
    expect(await screen.findByText(/retry: ~200/)).toBeInTheDocument();
    expect(screen.getByText(/anti-pattern: ~400/)).toBeInTheDocument();
  });
});

describe('Today view — cross-midnight session proration', () => {
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

  it("prorates a cross-midnight session's tool-call/flag counts and hourly spend by its today-portion, instead of its full lifetime count or excluding it entirely", async () => {
    const dayStart = localStartOfDay();
    // Started 2h before local midnight and ran 4h total (ends 2h into
    // today) — half the session's lifetime overlaps today, ratio 0.5.
    const crossMidnightSession = {
      sessionId: 'cross-midnight',
      startTime: dayStart - 2 * 60 * 60 * 1000,
      durationMs: 4 * 60 * 60 * 1000,
      toolCallCount: 100,
      estimatedCostUsd: 10,
      antiPatterns: Array.from({ length: 10 }, (_, i) => ({
        type: 'thrashing',
        target: `f${i}.ts`,
      })),
    };

    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/api/sessions/today/aggregate')) {
        return new Response(
          JSON.stringify({
            toolCallCount: 0,
            totalCostUsd: 0,
            antiPatternCount: 0,
            avgDurationMs: 0,
            sessionCount: 0,
            sparkline: { startTimestamp: 0, bucketSizeMs: 60_000, points: [] },
            forecastEndOfDayUsd: 5,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/api/sessions?limit=')) {
        return new Response(JSON.stringify([crossMidnightSession]), {
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

    // 100 tool calls * 0.5 ratio = 50 — not the full lifetime count of 100.
    // Using ratio only as an inclusion gate and adding the entire
    // toolCallCount once the session qualifies would show 100 instead.
    expect(await screen.findByText('50')).toBeInTheDocument();
    // 10 flags * 0.5 ratio = 5 — not the full lifetime count of 10, for the
    // same reason.
    expect(screen.getByText('5')).toBeInTheDocument();
    // buildHourlySpend must not skip a session that didn't *start* today
    // entirely (a naive `!isToday(s.startTime)` → continue would drop it),
    // or the hourly chart would be absent here even though todayTotal > 0.
    expect(screen.getByRole('img', { name: /Hourly spend today/ })).toBeInTheDocument();
  });
});

describe('Today view — day-rollover clears stale SSE snapshot', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as typeof fetch;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('clears the stale SSE cost/subagent snapshot once the 60s tick detects a local-midnight rollover', () => {
    vi.setSystemTime(new Date(2026, 5, 14, 23, 59, 0));
    useLiveStore.setState({
      connected: true,
      recentToolCalls: [],
      cost: { sessionTotalUsd: 12, todayTotalUsd: 999, forecastEodUsd: 999 },
      antiPatterns: [],
      firingAlerts: new Map(),
      dismissedAlerts: new Set(),
      todaySubagentUsd: 3,
      todaySubagentTurnCount: 4,
      activeSessionId: null,
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    render(
      <QueryClientProvider client={qc}>
        <Today />
      </QueryClientProvider>,
    );

    // Sanity check: the stale-but-same-day snapshot is present before the
    // rollover.
    expect(useLiveStore.getState().cost?.todayTotalUsd).toBe(999);

    // Cross local midnight and let the 60s tick run — asserted against the
    // store directly (not the rendered KPI text), since the KPI's displayed
    // value also depends on unrelated TanStack Query fetches settling,
    // which isn't what this test is verifying.
    act(() => {
      vi.setSystemTime(new Date(2026, 5, 15, 0, 1, 0));
      vi.advanceTimersByTime(60_000);
    });

    // Without invalidating this cached SSE snapshot, it would keep
    // reporting yesterday's numbers forever once the tab was left open
    // across midnight with no new SSE frame.
    const state = useLiveStore.getState();
    expect(state.cost).toBeNull();
    expect(state.todaySubagentUsd).toBe(0);
    expect(state.todaySubagentTurnCount).toBe(0);
  });
});

describe('Today view — traceWindow ignores the no-subagent sentinel window', () => {
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

  it('does not drag the shared trace window down to epoch 0 when the session has no subagents', async () => {
    const startMs = 1_700_000_000_000;
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/api/sessions/live')) {
        return new Response(
          JSON.stringify([
            {
              sessionId: 'no-agents',
              sessionName: 'solo',
              startTime: startMs,
              lastActivity: startMs,
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/api/sessions/no-agents/replay')) {
        return new Response(
          JSON.stringify({
            sessionId: 'no-agents',
            // Two entries spanning 65s of real, recent wall-clock time.
            timeline: [
              { timestamp: startMs, toolName: 'Read', durationMs: 0, success: true },
              { timestamp: startMs + 65_000, toolName: 'Read', durationMs: 0, success: true },
            ],
            segments: [],
            worstSegment: null,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/api/sessions/no-agents/subagents')) {
        // getSubagentsForSession's documented no-transcripts sentinel.
        return new Response(JSON.stringify({ window: { startMs: 0, endMs: 0 }, agents: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/api/sessions/today/aggregate')) {
        // Nonzero toolCallCount so the page doesn't fall into the
        // no-activity-today empty state, which would hide the trace pane
        // entirely.
        return new Response(
          JSON.stringify({
            toolCallCount: 2,
            totalCostUsd: 0,
            antiPatternCount: 0,
            avgDurationMs: 0,
            sessionCount: 1,
            sparkline: { startTimestamp: 0, bucketSizeMs: 60_000, points: [] },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/api/context')) {
        // The session is live, so ContextBar renders below the trace and
        // needs a well-shaped response.
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

    // Sanity: the trace pane actually rendered the Gantt view for this session.
    expect(await screen.findByText('Parent')).toBeInTheDocument();

    // With a real ~65s window, the axis's ticks land on small mm:ss values
    // (e.g. "1:00" at the 60s mark). A naive `Number.isFinite(0)` check
    // would let the {startMs:0,endMs:0} sentinel merge in, dragging startMs
    // to epoch 0 and inflating the span to ~1.7e12ms — every tick label
    // would then render as a multi-million-minute value instead.
    expect(await screen.findByText('1:00')).toBeInTheDocument();
    expect(screen.queryByText(/^\d{4,}:\d{2}$/)).toBeNull();
  });
});

describe('Today view — forecast end-of-week and session chips', () => {
  beforeEach(() => {
    useLiveStore.setState({
      connected: true,
      recentToolCalls: [],
      cost: { sessionTotalUsd: 1.2, todayTotalUsd: 4.8, forecastEodUsd: null },
      antiPatterns: [],
      firingAlerts: new Map(),
      dismissedAlerts: new Set(),
    });
    globalThis.fetch = vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes('/api/cost')) {
        return new Response(
          JSON.stringify({
            cost: { sessionTotalCostUsd: 1.2, model: null },
            forecast: {
              forecastEndOfDayUsd: 4.8,
              forecastEndOfWeekUsd: 18.4,
              forecastSessionEndUsd: 2.1,
              confidenceNote: 'Reasonable confidence — based on 30+ minutes of data.',
            },
            sessionTodayUsd: 1.2,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify(null), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders end-of-week and end-of-session forecast chips when API returns them', async () => {
    renderToday();
    await waitFor(() => expect(screen.getByText('End of week')).toBeInTheDocument());
    expect(screen.getByText('End of session')).toBeInTheDocument();
  });
});

describe('Today view — Cost by Tool panel', () => {
  beforeEach(() => {
    useLiveStore.setState({
      connected: true,
      recentToolCalls: [],
      cost: { sessionTotalUsd: 0, todayTotalUsd: 0, forecastEodUsd: null },
      antiPatterns: [],
      firingAlerts: new Map(),
      dismissedAlerts: new Set(),
    });
    globalThis.fetch = vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes('/api/cost-per-tool')) {
        return new Response(
          JSON.stringify({
            costByToolType: {
              Agent: { totalCost: 4.2, callCount: 8, avgCost: 0.525 },
              Read: { totalCost: 0.52, callCount: 61, avgCost: 0.0085 },
            },
            totalAttributedCost: 4.72,
            attributionRate: 0.88,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify(null), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders Cost by Tool panel with a chart instead of the empty state', async () => {
    // Recharts' ResponsiveContainer measures 0x0 under jsdom, so bar/axis
    // content doesn't render meaningfully in tests — assert the panel
    // rendered its chart branch (no empty state), matching the same
    // convention History.test.tsx uses for its own Recharts panels.
    renderToday();
    await waitFor(() => expect(screen.queryByText('No cost data yet')).toBeNull());
    expect(screen.getByText('Cost by Tool')).toBeInTheDocument();
  });

  it('renders Cost attribution unavailable when /api/cost-per-tool returns 503', async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes('/api/cost-per-tool')) {
        return new Response('Service Unavailable', { status: 503 });
      }
      return new Response(JSON.stringify(null), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    renderToday();
    await waitFor(() =>
      expect(screen.getByText('Cost attribution unavailable')).toBeInTheDocument(),
    );
  });

  it('renders the empty state instead of crashing when the query settles with a null value', async () => {
    // A 200 response whose body is the JSON literal `null` (distinct from a
    // request that errors) resolves the query successfully with `data` set
    // to `null`, not `undefined` — asserting against the pending state's
    // identical "No cost data yet" text wouldn't distinguish the two, so
    // seed the cache directly with the already-settled value instead of
    // waiting on the mocked fetch to resolve.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    qc.setQueryData(qk.costPerTool, null);
    renderToday(qc);
    expect(screen.getByText('No cost data yet')).toBeInTheDocument();
  });

  it('shows the low-attribution footnote when attributionRate is below 50%', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    qc.setQueryData(qk.costPerTool, {
      costByToolType: {
        Agent: { totalCost: 4.2, callCount: 8, avgCost: 0.525 },
      },
      totalAttributedCost: 4.2,
      attributionRate: 0.3,
    });
    renderToday(qc);
    expect(screen.getByText('Based on 30% of session cost')).toBeInTheDocument();
  });
});

describe('Today view — API Failures panel', () => {
  beforeEach(() => {
    // todayTotalUsd must be nonzero, or Today's `noActivityToday` short-circuit
    // (see Today.tsx) replaces the whole KPI/panel grid — including this
    // panel — with the top-level "No activity yet today" empty state,
    // regardless of what /api/api-failures returns.
    useLiveStore.setState({
      connected: true,
      recentToolCalls: [],
      cost: { sessionTotalUsd: 1, todayTotalUsd: 1, forecastEodUsd: null },
      antiPatterns: [],
      firingAlerts: new Map(),
      dismissedAlerts: new Set(),
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const zeroByErrorType = {
    rate_limit: 0,
    timeout: 0,
    connection_error: 0,
    server_error: 0,
    context_length_exceeded: 0,
    authentication: 0,
    unknown: 0,
  };

  it('shows the empty state when there are no failures', async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/api/api-failures')) {
        return new Response(
          JSON.stringify({
            totalFailures: 0,
            byErrorType: zeroByErrorType,
            byModel: {},
            bySessionPhase: { early: 0, middle: 0, late: 0 },
            totalTokensLost: 0,
            totalEstimatedCostLostUsd: 0,
            meanTimeToRecoveryMs: null,
            throttleAlerts: [],
            recentFailures: [],
            dataAvailable: true,
            note: '',
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
    expect(await screen.findByText('No API failures')).toBeInTheDocument();
  });

  it('shows failure count and error-type breakdown when failures exist', async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/api/api-failures')) {
        return new Response(
          JSON.stringify({
            totalFailures: 3,
            byErrorType: { ...zeroByErrorType, rate_limit: 2, server_error: 1 },
            byModel: {},
            bySessionPhase: { early: 1, middle: 1, late: 1 },
            totalTokensLost: 0,
            totalEstimatedCostLostUsd: 0,
            meanTimeToRecoveryMs: null,
            throttleAlerts: [],
            recentFailures: [],
            dataAvailable: true,
            note: '',
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
    expect(await screen.findByText('rate_limit: 2, server_error: 1')).toBeInTheDocument();
    expect(screen.getByText('API Failures')).toBeInTheDocument();
  });

  it('shows a throttle-alert warning line when throttleAlerts is non-empty', async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/api/api-failures')) {
        return new Response(
          JSON.stringify({
            totalFailures: 4,
            byErrorType: { ...zeroByErrorType, rate_limit: 4 },
            byModel: {},
            bySessionPhase: { early: 0, middle: 0, late: 4 },
            totalTokensLost: 0,
            totalEstimatedCostLostUsd: 0,
            meanTimeToRecoveryMs: null,
            throttleAlerts: [
              { model: 'claude-sonnet-5', count: 3, windowMinutes: 10, timestamp: Date.now() },
            ],
            recentFailures: [],
            dataAvailable: true,
            note: '',
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
    expect(await screen.findByText(/Rate-limit throttling detected/)).toBeInTheDocument();
  });
});
