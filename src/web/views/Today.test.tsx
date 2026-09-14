import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Today, aggregateAttentionFlags, bucketByHour, buildSpendTodaySeries } from './Today';
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
    expect(screen.getByText('sessions today')).toBeInTheDocument();
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

  it('renders the spend chart before Needs attention in page order', async () => {
    renderToday();
    const spendHeading = await screen.findByText('Spend by hour');
    const attentionHeading = await screen.findByText('Needs attention');
    expect(
      spendHeading.compareDocumentPosition(attentionHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  // Anti-pattern/flag rendering moved to the "Needs attention" panel — see
  // the dedicated "Today view — Needs attention panel" describe block below.

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

  it('renders a real count for stuck_loop via the API-fallback path, humanized as a pill', async () => {
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
    expect(await screen.findByText('Stuck loop ×5')).toBeInTheDocument();
    expect(screen.getByText('npm test')).toBeInTheDocument();
  });

  it('renders a real count for blind_editing via the API-fallback path, humanized as a pill', async () => {
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
    expect(await screen.findByText('Blind editing ×3')).toBeInTheDocument();
    expect(screen.getByText('app.ts')).toBeInTheDocument();
  });

  it('renders a real count for over_delegation with no target suffix when the source has none', async () => {
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
    // No file/command on this source → target resolves to 'unknown', which
    // AttentionStrip suppresses rather than rendering "on unknown".
    expect(await screen.findByText('Over-delegation ×7')).toBeInTheDocument();
    expect(screen.queryByText(/on unknown/)).toBeNull();
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

    expect(await screen.findByText('Stuck loop ×6')).toBeInTheDocument();
    expect(screen.getByText('npm run build')).toBeInTheDocument();
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

  it('shows no end-of-day projection on the spend KPI when the forecast is not above current spend', () => {
    useLiveStore.setState({
      cost: { sessionTotalUsd: 3.42, todayTotalUsd: 10, forecastEodUsd: 8 },
    });
    renderToday();
    expect(screen.queryByText(/by end of day/)).toBeNull();
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
    await waitFor(() => expect(screen.getByText(/^→ \$8\.00 by end of day/)).toBeInTheDocument());
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

  it('shows the muted watcher-off line when watcherActive is false and no subagent turns have been recorded', async () => {
    // Both watcherDisabledReason variants (env_var, mode_mismatch) collapse
    // into the same single condition and the same muted line — the reason
    // no longer changes what's displayed.
    stubObservabilityHealth({ watcherActive: false, watcherDisabledByLock: false });

    renderToday();
    expect(await screen.findByText(/Subagent cost tracking is disabled/)).toBeInTheDocument();
  });

  it('does not show the watcher-disabled banner when the cross-session aggregate reports nonzero subagent spend, even though its turn count is 0', async () => {
    // aggregate.subagentTurnCount only counts Workflow-tool script runs, so it
    // reads 0 on any day where the subagents were ordinary Task/Agent-tool
    // spawns, while aggregate.subagentUsd is summed from every persisted
    // session's subagentCostUsd and is correct for both kinds. The banner
    // must gate on the figure the KPI beside it trusts.
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/api/observability-health')) {
        return new Response(
          JSON.stringify({ watcherActive: false, watcherDisabledByLock: false }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/api/sessions/today/aggregate')) {
        return new Response(JSON.stringify({ subagentUsd: 5.5, subagentTurnCount: 0 }), {
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
    await waitFor(() => expect(screen.getByText('efficiency')).toBeInTheDocument());
    expect(screen.queryByText(/subagent cost tracking is disabled/i)).toBeNull();
    expect(screen.queryByText(/subagent activity from other sessions/i)).toBeNull();
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

    await waitFor(() => expect(screen.getByText(/^→ \$12\.00 by end of day/)).toBeInTheDocument());
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
    expect(screen.queryByText('sessions today')).toBeNull();
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

  it('renders KPIs from /api/sessions/today/aggregate (sessions + flags + spend)', async () => {
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
    expect(await screen.findByText('2')).toBeInTheDocument();
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

    // Hero value is p95 via formatMs; p50/p99 are HealthCard rows, and the
    // two slowest tools (by p95, descending) are additional rows keyed by
    // their own label/value cells rather than a combined "Nms p95" string.
    expect(await screen.findByText('222 ms')).toBeInTheDocument();
    expect(screen.getByText('111 ms')).toBeInTheDocument();
    expect(screen.getByText('333 ms')).toBeInTheDocument();
    expect(screen.getByText('Edit')).toBeInTheDocument();
    expect(screen.getByText('555 ms')).toBeInTheDocument();
    expect(screen.getByText('Read')).toBeInTheDocument();
    expect(screen.getByText('444 ms')).toBeInTheDocument();
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

  // Regression test: when nothing is currently live, the pane must still
  // default to the most recently active historical session instead of
  // leaving activeId null and showing the trace pane's empty state.
  it('defaults to the most recently active historical session when nothing is live', async () => {
    const historicalSession = {
      sessionId: 'yesterday-id',
      sessionName: 'legacy-work',
      startTime: localStartOfDay() + 60 * 60 * 1000,
      durationMs: 5 * 60 * 1000,
      toolCallCount: 3,
      estimatedCostUsd: 0.1,
    };
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/api/sessions/live')) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/api/session/current')) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/api/sessions?limit=')) {
        return new Response(JSON.stringify([historicalSession]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/api/sessions/yesterday-id/replay')) {
        return new Response(
          JSON.stringify({
            sessionId: 'yesterday-id',
            timeline: [{ timestamp: 1, toolName: 'Read', durationMs: 10, success: true }],
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

    expect(await screen.findByText('legacy-work')).toBeInTheDocument();
    await waitFor(() => {
      expect(useLiveStore.getState().activeSessionId).toBe('yesterday-id');
    });
    expect(screen.queryByText('Select a session to view its timeline.')).toBeNull();
    expect(screen.queryByText('Waiting for tool calls')).toBeNull();
    expect(screen.queryByText('No tool calls')).toBeNull();
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
    // HealthCard renders a row as separate label/value cells, not one
    // combined string.
    expect(await screen.findByText('vs last week')).toBeInTheDocument();
    expect(screen.getByText('+5pts')).toBeInTheDocument();
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
    expect(await screen.findByText('vs last week')).toBeInTheDocument();
    expect(screen.getByText('-3pts')).toBeInTheDocument();
  });

  it('shows total savings in the detail line', async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
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
              totalSavingsUsd: 1.5,
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
    expect(await screen.findByText(/\$1\.50 saved today/)).toBeInTheDocument();
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

describe('Today view — Needs attention panel', () => {
  beforeEach(() => {
    useLiveStore.setState({
      connected: true,
      recentToolCalls: [],
      cost: { sessionTotalUsd: 1, todayTotalUsd: 1, forecastEodUsd: null },
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

  it('shows "Nothing needs attention" when there are no flags and no alerts', async () => {
    renderToday();
    expect(await screen.findByText(/Nothing needs attention/)).toBeInTheDocument();
  });

  it('shows a humanized flag pill and a firing count linking to /alerts, together with an alert row', async () => {
    useLiveStore.setState({ antiPatterns: [{ type: 'thrashing', target: 'auth.ts', count: 4 }] });
    const now = Date.now();
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
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
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ) as typeof fetch;

    renderToday();

    // Humanized flag pill (not the raw `thrashing` enum).
    expect(await screen.findByText('Edit/test thrashing ×4')).toBeInTheDocument();
    expect(screen.getByText('auth.ts')).toBeInTheDocument();
    // Firing count, linked to /alerts.
    const firingLink = await screen.findByText('1 firing');
    expect(firingLink).toHaveAttribute('href', '/alerts');
    // Alert row: when / severity / rule / value-threshold / state.
    expect(screen.getByText('Cost spike')).toBeInTheDocument();
    expect(screen.getByText('warning')).toBeInTheDocument();
    expect(screen.getByText(/12\.5 \/ 10\.0/)).toBeInTheDocument();
    expect(screen.getByText('firing')).toBeInTheDocument();
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
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/api/alerts/recent')) {
        return new Response(JSON.stringify(fakeAlerts), {
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
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/api/alerts/recent')) {
        return new Response(JSON.stringify([oldAlert, middleAlert, newAlert]), {
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

    await screen.findByText('New alert');
    const titles = screen.getAllByText(/(?:Old|Middle|New) alert/);
    expect(titles.map((el) => el.textContent)).toEqual(['New alert', 'Middle alert', 'Old alert']);
  });

  // Regression test: persistedAntiPatterns (the panel's third-priority
  // fallback, used when both the live SSE list and /api/anti-patterns are
  // empty) must scope to today the same way every sibling KPI does via
  // todayOverlapRatio. Without the filter, a days-old session with
  // antiPatterns still surfaces here even though it has zero overlap with
  // today.
  it("excludes a days-old session's anti-patterns while still showing today's", async () => {
    const todayStart = localStartOfDay();
    const oldSession = {
      sessionId: 'old-session',
      startTime: todayStart - 5 * 24 * 60 * 60 * 1000,
      durationMs: 30 * 60 * 1000,
      toolCallCount: 20,
      estimatedCostUsd: 1,
      antiPatterns: [{ type: 'blind_editing', target: 'auth.ts', count: 7 }],
    };
    const todaySession = {
      sessionId: 'today-session',
      startTime: todayStart + 60 * 60 * 1000,
      durationMs: 10 * 60 * 1000,
      toolCallCount: 5,
      estimatedCostUsd: 0.5,
      antiPatterns: [{ type: 'stuck_loop', target: 'npm test', count: 3 }],
    };

    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/api/sessions?limit=')) {
        return new Response(JSON.stringify([oldSession, todaySession]), {
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

    expect(await screen.findByText('Stuck loop ×3')).toBeInTheDocument();
    expect(screen.queryByText(/Blind editing/)).toBeNull();
  });
});

describe("Today view — Where today's spend went panel", () => {
  const SAMPLE_USAGE_INSIGHTS = {
    windowDays: 1,
    sessionCount: 3,
    totalCostUsd: 10,
    totalTokens: 50000,
    insights: [
      {
        id: 'high_context',
        key: 'high_context',
        costUsd: 6,
        tokens: 30000,
        count: 2,
        sharePct: 60,
        sessionCount: 3,
        headline: 'High-context sessions are driving spend',
        advice: 'Trim context before starting new sessions.',
      },
    ],
    skills: [{ key: 'code-review', costUsd: 3, tokens: 6000, count: 4, sharePct: 30 }],
    subagents: [{ key: 'general-purpose', costUsd: 2, tokens: 4000, count: 3, sharePct: 20 }],
    plugins: [{ key: 'pstack', costUsd: 1, tokens: 2000, count: 2, sharePct: 10 }],
    loops: [],
    attributionRatePct: 80,
  };

  beforeEach(() => {
    useLiveStore.setState({
      connected: true,
      recentToolCalls: [],
      cost: { sessionTotalUsd: 1, todayTotalUsd: 1, forecastEodUsd: null },
      antiPatterns: [],
      firingAlerts: new Map(),
      dismissedAlerts: new Set(),
    });
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(null), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the consolidated title exactly once, with the old contributing title gone', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    qc.setQueryData(qk.usageInsights('today'), SAMPLE_USAGE_INSIGHTS);
    renderToday(qc);
    expect(await screen.findAllByText("Where today's spend went")).toHaveLength(1);
    expect(screen.queryByText("What's contributing to today's spend")).toBeNull();
    expect(screen.getAllByText('Since midnight').length).toBeGreaterThan(0);
  });

  it('proves the Skills-shown-twice bug is gone: exactly one Skills table renders', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    qc.setQueryData(qk.usageInsights('today'), SAMPLE_USAGE_INSIGHTS);
    renderToday(qc);
    await screen.findByText('code-review');
    expect(screen.getAllByRole('columnheader', { name: 'Skill' })).toHaveLength(1);
    expect(screen.getAllByText('code-review')).toHaveLength(1);
  });

  it('renders a Models table row with requests, cost per million tokens, cost, and share', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    qc.setQueryData(qk.usageInsights('today'), SAMPLE_USAGE_INSIGHTS);
    qc.setQueryData(qk.modelUsage, {
      byModel: {
        'claude-sonnet-5': { requestCount: 8, totalCostUsd: 4.2, costPerMillionTokens: 0.75 },
      },
      mostUsedModel: 'claude-sonnet-5',
    });
    renderToday(qc);
    await screen.findByText("Where today's spend went");
    const row = screen.getByText('claude-sonnet-5').closest('tr') as HTMLElement;
    expect(within(row).getByText('8')).toBeInTheDocument();
    expect(within(row).getByText('$0.75')).toBeInTheDocument();
    expect(within(row).getByText('$4.20')).toBeInTheDocument();
    expect(within(row).getByText('100%')).toBeInTheDocument();
  });

  it("renders a Tools row with a Cost column, built from today's session list plus windowed cost data", async () => {
    const now = Date.now();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    qc.setQueryData(qk.usageInsights('today'), SAMPLE_USAGE_INSIGHTS);
    qc.setQueryData(qk.costPerTool(), {
      costByToolType: { Read: { totalCost: 3, callCount: 8, avgCost: 0.375, tokens: 1000 } },
      totalAttributedCost: 3,
      attributionRate: 1,
    });
    qc.setQueryData(qk.sessionsList(200), [
      {
        sessionId: 's1',
        startTime: now - 1_800_000,
        durationMs: 1_800_000,
        toolBreakdown: { Read: 6, Edit: 2 },
      },
      {
        sessionId: 's2',
        startTime: now - 600_000,
        durationMs: 600_000,
        toolBreakdown: { Read: 2 },
      },
    ]);
    renderToday(qc);
    await screen.findByText("Where today's spend went");
    const row = screen.getByRole('cell', { name: 'Read' }).closest('tr') as HTMLElement;
    expect(within(row).getByRole('cell', { name: '8' })).toBeInTheDocument();
    expect(within(row).getByRole('cell', { name: '$3.00' })).toBeInTheDocument();
  });

  it("excludes sessions outside today's window from the Tools table", async () => {
    const dayStart = localStartOfDay();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    qc.setQueryData(qk.usageInsights('today'), SAMPLE_USAGE_INSIGHTS);
    qc.setQueryData(qk.sessionsList(200), [
      {
        sessionId: 's1',
        startTime: dayStart - 3 * 24 * 60 * 60 * 1000,
        durationMs: 1_800_000,
        toolBreakdown: { Read: 100, Edit: 50 },
      },
      {
        sessionId: 's2',
        startTime: Date.now() - 600_000,
        durationMs: 600_000,
        toolBreakdown: { Read: 2 },
      },
    ]);
    renderToday(qc);
    await screen.findByText('code-review');
    const row = screen.getByRole('cell', { name: 'Read' }).closest('tr') as HTMLElement;
    expect(within(row).getByRole('cell', { name: '2' })).toBeInTheDocument();
  });

  it('shows a Cost column on the Skills and Subagents tables', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    qc.setQueryData(qk.usageInsights('today'), SAMPLE_USAGE_INSIGHTS);
    renderToday(qc);
    const skillRow = (await screen.findByText('code-review')).closest('tr') as HTMLElement;
    expect(within(skillRow).getByText('$3.00')).toBeInTheDocument();
    const subagentRow = screen.getByText('general-purpose').closest('tr') as HTMLElement;
    expect(within(subagentRow).getByText('$2.00')).toBeInTheDocument();
  });

  it('shows Calls and Tokens columns on the Plugins table', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    qc.setQueryData(qk.usageInsights('today'), SAMPLE_USAGE_INSIGHTS);
    renderToday(qc);
    const pluginRow = (await screen.findByText('pstack')).closest('tr') as HTMLElement;
    expect(within(pluginRow).getByText('2')).toBeInTheDocument();
    expect(within(pluginRow).getByText('2.0k')).toBeInTheDocument();
  });

  it('shows "No sessions in this window." when sessionCount is 0', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    qc.setQueryData(qk.usageInsights('today'), { ...SAMPLE_USAGE_INSIGHTS, sessionCount: 0 });
    renderToday(qc);
    expect(await screen.findByText('No sessions in this window.')).toBeInTheDocument();
  });

  it('shows the unavailable empty state when the usage-insights query errors', async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.startsWith('/api/usage-insights')) {
        return new Response('Service Unavailable', { status: 503 });
      }
      return new Response(JSON.stringify(null), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    renderToday();
    expect(await screen.findByText('Usage insights unavailable')).toBeInTheDocument();
  });
});

describe('Today view — Compute Waste panel', () => {
  beforeEach(() => {
    useLiveStore.setState({
      connected: true,
      recentToolCalls: [],
      cost: { sessionTotalUsd: 1, todayTotalUsd: 1, forecastEodUsd: null },
      antiPatterns: [],
      retryAlerts: [],
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
    expect(await screen.findByText('~0 tokens')).toBeInTheDocument();
    expect(screen.getAllByText('Healthy').length).toBeGreaterThan(0);
    expect(screen.getByText('No compute waste detected this session.')).toBeInTheDocument();
  });

  it('shows needs_attention status with a hero token count and top-offender advice', async () => {
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
    // Hero value via formatTokensCompact (2400 → "2.4k").
    expect(await screen.findByText('~2.4k tokens')).toBeInTheDocument();
    expect(screen.getAllByText('Needs attention').length).toBeGreaterThan(0);
    // Detail is the top offender's advice text, not the raw pattern name.
    expect(
      screen.getByText('Address the command output before re-running the same command.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Anti-pattern')).toBeInTheDocument();
    expect(screen.getByText('~1.6k')).toBeInTheDocument();
  });

  it('shows per-source breakdown rows', async () => {
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
    expect(await screen.findByText('Retry')).toBeInTheDocument();
    expect(screen.getByText('~200')).toBeInTheDocument();
    expect(screen.getByText('Anti-pattern')).toBeInTheDocument();
    expect(screen.getByText('~400')).toBeInTheDocument();
  });

  it('shows the top contributing session when by_session is present', async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/api/compute-waste')) {
        return new Response(
          JSON.stringify({
            total_tokens_wasted: 900,
            retry_tokens_wasted: 900,
            anti_pattern_tokens_wasted: 0,
            breakdown: [],
            by_session: [{ session_id: 'abcdef1234567890', tokens_wasted: 900, alert_count: 3 }],
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
    // liveSessions resolves to [] under the generic mock above, so
    // sessionPillLabel falls back to the truncated session id.
    expect(await screen.findByText('Top session')).toBeInTheDocument();
    expect(screen.getByText('abcdef12 (~900)')).toBeInTheDocument();
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

  it("prorates a cross-midnight session's flag counts and hourly spend by its today-portion, instead of its full lifetime count or excluding it entirely", async () => {
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
            sessionCount: 1,
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

    // 10 flags * 0.5 ratio = 5 — not the full lifetime count of 10, for
    // the same reason. This verifies the pro-rating logic works for
    // cross-midnight sessions in the persisted data path.
    expect(await screen.findByText('5')).toBeInTheDocument();
    // buildHourlySpend must not skip a session that didn't *start* today
    // entirely (a naive `!isToday(s.startTime)` → continue would drop it),
    // or the spend chart would render its empty state here even though
    // todayTotal > 0.
    const spendPanel = screen.getByText('Spend by hour').closest('.glass-card') as HTMLElement;
    expect(within(spendPanel).queryByText('No spend data yet')).toBeNull();
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
      if (typeof url === 'string' && url.includes('/api/sessions?limit=')) {
        return new Response(
          JSON.stringify([
            {
              sessionId: 's1',
              startTime: Date.now() - 60_000,
              estimatedCostUsd: 4.8,
              toolCallCount: 3,
            },
          ]),
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

  it('shows the on-pace-this-week caption under the spend chart when the API returns an end-of-day forecast', async () => {
    renderToday();
    await waitFor(() =>
      expect(screen.getByText(/On pace for ~\$[\d.]+ this week/)).toBeInTheDocument(),
    );
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

  it('shows the zero/good state when there are no failures', async () => {
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
    const card = (await screen.findByText('API Failures')).closest('.glass-card') as HTMLElement;
    expect(within(card).getByText('0')).toBeInTheDocument();
    expect(within(card).getByText('Healthy')).toBeInTheDocument();
  });

  it('shows failure count, failing status, and an error-type breakdown row when failures exist', async () => {
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
    const card = (await screen.findByText('API Failures')).closest('.glass-card') as HTMLElement;
    await waitFor(() => expect(within(card).getByText('Needs attention')).toBeInTheDocument());
    expect(within(card).getByText('3')).toBeInTheDocument();
    expect(within(card).getByText('rate_limit')).toBeInTheDocument();
    expect(within(card).getByText('server_error')).toBeInTheDocument();
  });
});

describe('Today view — Activity today panel', () => {
  beforeEach(() => {
    resetStore();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders two stacked charts — tool calls above concurrent sessions', async () => {
    const now = Date.now();
    const dayStart = localStartOfDay();
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/api/sessions?limit=')) {
        return new Response(
          JSON.stringify([
            {
              sessionId: 's1',
              startTime: dayStart + 9 * 60 * 60 * 1000 + 5 * 60 * 1000,
              durationMs: 10 * 60 * 1000,
              toolCallCount: 3,
              estimatedCostUsd: 2,
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/api/activity-heatmap')) {
        return new Response(
          JSON.stringify({
            buckets: [1, 2, 0, 3],
            maxCount: 3,
            bucketSizeMs: 900_000,
            startTimestamp: dayStart,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === '/api/concurrency') {
        return new Response(
          JSON.stringify({
            current: 2,
            peak: 3,
            allTimePeak: 3,
            bucketSizeMs: 900_000,
            startTimestamp: now,
            buckets: [{ timestamp: now, count: 2 }],
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

    const panel = (await screen.findByText('Activity today')).closest('.glass-card') as HTMLElement;
    expect(within(panel).getByText('Tool calls')).toBeInTheDocument();
    expect(within(panel).getByText('Concurrent sessions')).toBeInTheDocument();
    expect(within(panel).queryByText('Spend by hour')).toBeNull();

    const heatmapChart = await within(panel).findByRole('img', {
      name: "Today's activity density by hour",
    });
    const concurrencyChart = await within(panel).findByRole('img', {
      name: 'Concurrency over time, peak 3',
    });
    expect(within(panel).getAllByRole('img').length).toBe(2);
    // Both charts share the same 24-hourly-bucket granularity.
    for (const chart of [heatmapChart, concurrencyChart]) {
      expect(chart.querySelectorAll('g').length).toBe(24);
    }

    // DOM order: Tool calls before Concurrent sessions
    const toolCallsHeading = within(panel).getByText('Tool calls');
    const concurrencyHeading = within(panel).getByText('Concurrent sessions');
    expect(
      toolCallsHeading.compareDocumentPosition(concurrencyHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // All 4 heatmap buckets ([1, 2, 0, 3], 15 minutes each) fall inside
    // hour 0 once re-bucketed hourly: 1+2+0+3 = 6.
    expect(within(panel).getByText('Peak 00:00 — 6 calls')).toBeInTheDocument();
    expect(within(panel).getByText('now 2 · peak 3')).toBeInTheDocument();

    // The concurrency sample (count 2) lands in whichever hour `now` falls
    // in; the chart tooltip for that column still reads the raw count.
    const nowHour = new Date(now).getHours();
    const concurrencyGroups = concurrencyChart.querySelectorAll('g');
    fireEvent.mouseEnter(concurrencyGroups[nowHour]!);
    expect(
      await screen.findByText(`${String(nowHour).padStart(2, '0')}:00 — 2 concurrent`),
    ).toBeInTheDocument();
  });
});

describe('bucketByHour()', () => {
  it('sums multiple points landing in the same hour by default', () => {
    const dayStart = localStartOfDay();
    const nowMs = dayStart + 12 * 60 * 60 * 1000;
    const hour9Start = dayStart + 9 * 60 * 60 * 1000;
    const buckets = bucketByHour(
      [
        { ts: hour9Start + 60_000, value: 2 },
        { ts: hour9Start + 30 * 60_000, value: 3 },
      ],
      nowMs,
    );
    expect(buckets[9]).toBe(5);
    expect(buckets.filter((_, i) => i !== 9).every((v) => v === 0)).toBe(true);
  });

  it('takes the max instead of summing when mode is "max"', () => {
    const dayStart = localStartOfDay();
    const nowMs = dayStart + 12 * 60 * 60 * 1000;
    const hour9Start = dayStart + 9 * 60 * 60 * 1000;
    const buckets = bucketByHour(
      [
        { ts: hour9Start + 60_000, value: 2 },
        { ts: hour9Start + 30 * 60_000, value: 5 },
        { ts: hour9Start + 45 * 60_000, value: 1 },
      ],
      nowMs,
      'max',
    );
    expect(buckets[9]).toBe(5);
  });

  it('drops a point before local midnight', () => {
    const dayStart = localStartOfDay();
    const nowMs = dayStart + 12 * 60 * 60 * 1000;
    const buckets = bucketByHour([{ ts: dayStart - 1, value: 9 }], nowMs);
    expect(buckets.every((v) => v === 0)).toBe(true);
  });

  it('drops a point at or after local midnight + 24h', () => {
    const dayStart = localStartOfDay();
    const nowMs = dayStart + 12 * 60 * 60 * 1000;
    const buckets = bucketByHour([{ ts: dayStart + 86_400_000, value: 9 }], nowMs);
    expect(buckets.every((v) => v === 0)).toBe(true);
  });

  it('returns a 24-length array of zeros for an empty points array', () => {
    const buckets = bucketByHour([], Date.now());
    expect(buckets.length).toBe(24);
    expect(buckets.every((v) => v === 0)).toBe(true);
  });
});

describe('aggregateAttentionFlags()', () => {
  it('collapses per-file flags into one pill per type with a file count', () => {
    const out = aggregateAttentionFlags([
      { type: 're_reading', count: 3, target: '/a/one.ts' },
      { type: 're_reading', count: 4, target: '/a/two.ts' },
      { type: 'over_delegation', count: 2, target: 'unknown' },
    ]);
    expect(out).toEqual([
      { type: 're_reading', count: 7, targets: ['/a/one.ts', '/a/two.ts'], sessionIds: [] },
      { type: 'over_delegation', count: 2, targets: [], sessionIds: [] },
    ]);
  });

  it('collects distinct session ids per type', () => {
    expect(
      aggregateAttentionFlags([
        { type: 'blind_editing', count: 1, target: '/x/y/z.ts', sessionId: 's1' },
        { type: 'blind_editing', count: 2, target: '/x/y/z.ts', sessionId: 's2' },
        { type: 'blind_editing', count: 1, sessionId: 's1' },
      ]),
    ).toEqual([
      { type: 'blind_editing', count: 4, targets: ['/x/y/z.ts'], sessionIds: ['s1', 's2'] },
    ]);
  });
});

describe('buildSpendTodaySeries()', () => {
  function hourlySpendFixture(costs: Record<number, number>): { hour: number; cost: number }[] {
    return Array.from({ length: 24 }, (_, hour) => ({ hour, cost: costs[hour] ?? 0 }));
  }

  it('keeps the cumulative and projected lines continuous at the current hour', () => {
    const nowMs = new Date(2026, 5, 14, 10, 30).getTime();
    const series = buildSpendTodaySeries(hourlySpendFixture({ 8: 2, 9: 1, 10: 3 }), 20, nowMs);
    const atHour10 = series[10]!;
    expect(atHour10.cumulativeUsd).toBe(6);
    expect(atHour10.projectedUsd).toBe(6);
  });

  it('projects the last hour to exactly the forecasted end-of-day total', () => {
    const nowMs = new Date(2026, 5, 14, 10, 30).getTime();
    const series = buildSpendTodaySeries(hourlySpendFixture({ 8: 2, 9: 1, 10: 3 }), 20, nowMs);
    expect(series[23]!.projectedUsd).toBe(20);
  });

  it('has no projected series when the forecast is null', () => {
    const nowMs = new Date(2026, 5, 14, 10, 30).getTime();
    const series = buildSpendTodaySeries(hourlySpendFixture({ 10: 3 }), null, nowMs);
    expect(series.every((d) => d.projectedUsd === null)).toBe(true);
  });

  it('has no projected series when the forecast does not exceed spend so far', () => {
    const nowMs = new Date(2026, 5, 14, 10, 30).getTime();
    const series = buildSpendTodaySeries(hourlySpendFixture({ 8: 2, 9: 1, 10: 3 }), 6, nowMs);
    expect(series.every((d) => d.projectedUsd === null)).toBe(true);
  });
});
