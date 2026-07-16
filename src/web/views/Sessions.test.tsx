import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Sessions } from './Sessions';

interface DetailMap {
  readonly [sessionId: string]: unknown;
}

function renderSessions(listData: unknown, detailMap: DetailMap = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
  globalThis.fetch = ((url: string) => {
    if (url.startsWith('/api/sessions/')) {
      // InlineReplay fetches /api/sessions/:id/replay — return timeline as ReplayData
      if (url.includes('/replay')) {
        const sessionId = decodeURIComponent(url.split('/').slice(-2)[0] ?? '');
        const detail = (detailMap[sessionId] ?? {}) as { timeline?: unknown[] };
        const replayData = { timeline: detail.timeline ?? [], segments: [] };
        return Promise.resolve(
          new Response(JSON.stringify(replayData), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      const id = decodeURIComponent(url.split('/').pop() ?? '');
      const detail = detailMap[id] ?? { sessionId: id, timeline: [] };
      return Promise.resolve(
        new Response(JSON.stringify(detail), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify(listData), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof globalThis.fetch;
  return render(
    <QueryClientProvider client={qc}>
      <Sessions />
    </QueryClientProvider>,
  );
}

const SAMPLE_LIST = [
  {
    sessionId: 's1',
    startTime: '2026-05-28T09:00:00Z',
    toolCallCount: 42,
    estimatedCostUsd: 1.23,
    outcome: 'feature',
  },
  {
    sessionId: 's2',
    startTime: '2026-05-27T15:30:00Z',
    toolCallCount: 18,
    estimatedCostUsd: 0.45,
    outcome: 'bug_fix',
  },
];

describe('Sessions view', () => {
  it('renders one row per session in the list', async () => {
    renderSessions(SAMPLE_LIST);
    await waitFor(() => expect(screen.getByText(/s1/)).toBeInTheDocument());
    expect(screen.getByText(/s2/)).toBeInTheDocument();
  });

  it('renders the consolidated workflow KPI strip and filter controls', async () => {
    renderSessions(SAMPLE_LIST);
    await waitFor(() => expect(screen.getByText(/s1/)).toBeInTheDocument());
    // Fleet KPI strip folded in from the former Workflows view.
    expect(screen.getByText('Workflow runs')).toBeInTheDocument();
    expect(screen.getByText('Workflow spend')).toBeInTheDocument();
    // Run-level filter controls.
    expect(screen.getByRole('group', { name: /run source filter/i })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /status filter/i })).toBeInTheDocument();
  });

  it('shows tool-call count and cost per row', async () => {
    renderSessions(SAMPLE_LIST);
    await waitFor(() => expect(screen.getByText(/s1/)).toBeInTheDocument());
    expect(screen.getByText('42 calls')).toBeInTheDocument();
    expect(screen.getByText('$1.23')).toBeInTheDocument();
  });

  it('shows an empty-state message when list is empty', async () => {
    renderSessions([]);
    await waitFor(() => expect(screen.getByText(/no sessions yet/i)).toBeInTheDocument());
  });

  it('shows a cap notice when the list returns the full page', async () => {
    // 50 rows is the page-size sentinel — the API caps at this and
    // the SPA uses the same constant. Asserting the notice appears at the
    // boundary protects the contract without having to inspect the literal.
    const fullPage = Array.from({ length: 50 }, (_, i) => ({
      sessionId: `cap-${i}`,
      startTime: '2026-05-28T09:00:00Z',
      toolCallCount: 1,
      estimatedCostUsd: 0,
    }));
    renderSessions(fullPage);
    await waitFor(() =>
      expect(screen.getByText(/showing 50 most recent sessions/i)).toBeInTheDocument(),
    );
  });

  it('hides the cap notice when fewer than the page size are returned', async () => {
    renderSessions(SAMPLE_LIST);
    await waitFor(() => expect(screen.getByText(/s1/)).toBeInTheDocument());
    expect(screen.queryByText(/showing 50 most recent sessions/i)).not.toBeInTheDocument();
  });

  it('auto-selects the first session on load (no manual pick required)', async () => {
    renderSessions(SAMPLE_LIST);
    await waitFor(() => expect(screen.getByText(/s1/)).toBeInTheDocument());
    // Component auto-selects the first session — "pick a session" prompt never shows
    expect(screen.queryByText(/pick a session/i)).not.toBeInTheDocument();
  });

  it('shows the empty-timeline message when the selected session has no tool calls', async () => {
    renderSessions(SAMPLE_LIST, { s1: { sessionId: 's1', toolCallCount: 0, timeline: [] } });
    await waitFor(() => expect(screen.getByText(/s1/)).toBeInTheDocument());
    fireEvent.click(screen.getAllByText(/s1/)[0]);
    await waitFor(() => expect(screen.getByText(/no tool calls/i)).toBeInTheDocument());
  });

  it('renders one timeline row per tool call with name and duration', async () => {
    const detail = {
      sessionId: 's1',
      timeline: [
        { timestamp: 1_000, toolName: 'Read', durationMs: 120, success: true },
        { timestamp: 1_200, toolName: 'Edit', durationMs: 240, success: true },
        { timestamp: 1_500, toolName: 'Bash', durationMs: 80, success: true },
      ],
    };
    renderSessions(SAMPLE_LIST, { s1: detail });
    await waitFor(() => expect(screen.getByText(/s1/)).toBeInTheDocument());
    fireEvent.click(screen.getAllByText(/s1/)[0]);
    // InlineReplay defaults to Gantt view — tool names appear as row labels
    await waitFor(() => expect(screen.getAllByText('Read').length).toBeGreaterThanOrEqual(1));
    expect(screen.getAllByText('Edit').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Bash').length).toBeGreaterThanOrEqual(1);
    // Switch to list view to verify per-row duration text. Use role=tab to
    // disambiguate from the aside "List" eyebrow heading, which has the same text.
    fireEvent.click(screen.getByRole('tab', { name: 'List' }));
    await waitFor(() => expect(screen.getByText('120ms')).toBeInTheDocument());
    expect(screen.getByText('240ms')).toBeInTheDocument();
    expect(screen.getByText('80ms')).toBeInTheDocument();
  });

  it('renders both rows when two timeline entries share timestamp and toolName', async () => {
    const detail = {
      sessionId: 's1',
      timeline: [
        { timestamp: 1_000, toolName: 'Read', durationMs: 50, success: true },
        { timestamp: 1_000, toolName: 'Read', durationMs: 80, success: true },
      ],
    };
    renderSessions(SAMPLE_LIST, { s1: detail });
    await waitFor(() => expect(screen.getByText(/s1/)).toBeInTheDocument());
    fireEvent.click(screen.getAllByText(/s1/)[0]);
    // Switch to list view to verify per-row duration text. Use role=tab to
    // disambiguate from the aside "List" eyebrow heading, which has the same text.
    await waitFor(() => expect(screen.getByRole('tab', { name: 'List' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: 'List' }));
    await waitFor(() => expect(screen.getByText('50ms')).toBeInTheDocument());
    expect(screen.getByText('80ms')).toBeInTheDocument();
    expect(screen.getAllByText('Read').length).toBeGreaterThanOrEqual(2);
  });

  it('labels the outcome field as Status, not Outcome', async () => {
    const detailWithOutcome = {
      sessionId: 's1',
      durationMs: 5000,
      toolCallCount: 1,
      outcome: 'completed',
      timeline: [{ timestamp: 1_000, toolName: 'Read', durationMs: 120, success: true }],
    };
    renderSessions(SAMPLE_LIST, { s1: detailWithOutcome });
    // Auto-selects s1, so just wait for it to load
    await waitFor(() => expect(screen.getAllByText('Read').length).toBeGreaterThanOrEqual(1));
    // Verify the label is now "Status" instead of "Outcome"
    expect(screen.queryByText('Outcome')).toBeNull();
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.getByText('completed')).toBeInTheDocument();
  });

  it('renders a Files Read list from data.filesRead, truncated to the last two path segments', async () => {
    const detail = {
      sessionId: 's1',
      timeline: [{ timestamp: 1_000, toolName: 'Read', durationMs: 120, success: true }],
      filesRead: ['src/deep/nested/path/foo.ts', 'src/bar.ts'],
    };
    renderSessions(SAMPLE_LIST, { s1: detail });
    await waitFor(() => expect(screen.getByText('Files Read')).toBeInTheDocument());
    expect(screen.getByText('path/foo.ts')).toBeInTheDocument();
    expect(screen.getByText('src/bar.ts')).toBeInTheDocument();
  });

  it('does not render the Files Read section when filesRead is absent or empty', async () => {
    const detail = {
      sessionId: 's1',
      timeline: [{ timestamp: 1_000, toolName: 'Read', durationMs: 120, success: true }],
    };
    renderSessions(SAMPLE_LIST, { s1: detail });
    await waitFor(() => expect(screen.getAllByText('Read').length).toBeGreaterThanOrEqual(1));
    expect(screen.queryByText('Files Read')).toBeNull();
  });

  it('renders antiPatterns pills reusing the SEGMENT_LABELS taxonomy, falling back to the raw type for unmapped values', async () => {
    const detail = {
      sessionId: 's1',
      timeline: [{ timestamp: 1_000, toolName: 'Read', durationMs: 120, success: true }],
      antiPatterns: [
        { type: 'thrashing', count: 3 },
        { type: 'over_delegation', count: 1 },
      ],
    };
    const { container } = renderSessions(SAMPLE_LIST, { s1: detail });
    await waitFor(() => expect(container.textContent).toContain('Edit/Test Thrashing'));
    expect(container.textContent).toContain('× 3');
    // over_delegation has no SEGMENT_LABELS entry — falls back to the raw type string.
    expect(container.textContent).toContain('over_delegation');
    expect(container.textContent).toContain('× 1');
  });

  it('does not render the Anti-Patterns section when antiPatterns is absent or empty', async () => {
    const detail = {
      sessionId: 's1',
      timeline: [{ timestamp: 1_000, toolName: 'Read', durationMs: 120, success: true }],
    };
    renderSessions(SAMPLE_LIST, { s1: detail });
    await waitFor(() => expect(screen.getAllByText('Read').length).toBeGreaterThanOrEqual(1));
    expect(screen.queryByText('Anti-Patterns')).toBeNull();
  });

  it('shows the timeline header with session ID and call count', async () => {
    const detail = {
      sessionId: 's1-abcdef',
      toolCallCount: 5,
      durationMs: 5000,
      toolBreakdown: { Read: 3, Edit: 2 },
    };
    renderSessions(SAMPLE_LIST, { s1: detail });
    await waitFor(() => expect(screen.getByText(/s1/)).toBeInTheDocument());
    fireEvent.click(screen.getAllByText(/s1/)[0]);
    // Header is split across multiple spans (identifier in mono, bullet
    // separators outside any uppercase scope, "5 calls" in uppercase, the
    // duration in its own tabular-nums span) — assert each piece independently.
    await waitFor(() => expect(screen.getByText(/s1-abcde/)).toBeInTheDocument());
    expect(screen.getByText(/5 calls/)).toBeInTheDocument();
    expect(screen.getByText('5s')).toBeInTheDocument();
  });
});

describe('Sessions view — real API shapes', () => {
  const REAL_API_LIST = [
    {
      sessionId: 'abc-123',
      startTime: 1780361259600,
      endTime: 1780361457932,
      durationMs: 198332,
      toolCallCount: 28,
      developer: 'adamjohnson',
      model: 'claude-sonnet-4-6',
      toolBreakdown: { Bash: 12, Read: 13, Edit: 2, Write: 1 },
      filesRead: ['src/foo.ts'],
      filesModified: ['src/bar.ts'],
      estimatedCostUsd: 0.42,
      outcome: 'feature',
    },
    {
      sessionId: 'def-456',
      startTime: 1780275000000,
      endTime: 1780275200000,
      durationMs: 200000,
      toolCallCount: 5,
      developer: 'adamjohnson',
      model: 'claude-sonnet-4-6',
      toolBreakdown: { Read: 5 },
      filesRead: ['src/index.ts'],
      filesModified: [],
      estimatedCostUsd: 0.08,
      outcome: 'exploration',
    },
  ];

  it('renders without crashing when sessions have epoch-ms startTime (number)', async () => {
    renderSessions(REAL_API_LIST);
    await waitFor(() => expect(screen.getByText(/abc-123/)).toBeInTheDocument());
    expect(screen.getByText(/def-456/)).toBeInTheDocument();
    expect(screen.getByText('28 calls')).toBeInTheDocument();
    // Sub-dollar costs render with 4 decimals via the shared formatUsd helper
    // (0 < value < $1 keeps meaningful digits): 0.42 → "$0.4200".
    expect(screen.getByText('$0.4200')).toBeInTheDocument();
  });

  it('renders without crashing when estimatedCostUsd is undefined', async () => {
    const listWithNoCost = [
      {
        sessionId: 'nocost01',
        startTime: 1780361259600,
        toolCallCount: 10,
        outcome: 'feature',
      },
    ];
    renderSessions(listWithNoCost);
    await waitFor(() => expect(screen.getByText(/nocost01/)).toBeInTheDocument());
    expect(screen.getByText('10 calls')).toBeInTheDocument();
  });

  it('renders without crashing when estimatedCostUsd is null', async () => {
    const listWithNullCost = [
      {
        sessionId: 'nullcst1',
        startTime: 1780361259600,
        toolCallCount: 7,
        estimatedCostUsd: null,
        outcome: 'bug_fix',
      },
    ];
    renderSessions(listWithNullCost);
    await waitFor(() => expect(screen.getByText(/nullcst1/)).toBeInTheDocument());
    expect(screen.getByText('7 calls')).toBeInTheDocument();
  });

  it('shows tool breakdown when session detail has no toolCalls array', async () => {
    const detailWithBreakdownOnly = {
      sessionId: 'abc-123',
      durationMs: 198332,
      toolCallCount: 28,
      model: 'claude-sonnet-4-6',
      toolBreakdown: { Bash: 12, Read: 13, Edit: 2, Write: 1 },
      filesRead: ['src/foo.ts'],
      filesModified: ['src/bar.ts'],
      estimatedCostUsd: 0.42,
      outcome: 'feature',
    };
    renderSessions(REAL_API_LIST, { 'abc-123': detailWithBreakdownOnly });
    await waitFor(() => expect(screen.getByText(/abc-123/)).toBeInTheDocument());
    fireEvent.click(screen.getAllByText(/abc-123/)[0]);
    // The breakdown lives under the "Tools" eyebrow section.
    await waitFor(() => expect(screen.getByText(/^Tools$/)).toBeInTheDocument());
    expect(screen.getByText('Bash')).toBeInTheDocument();
    expect(screen.getByText('Read')).toBeInTheDocument();
    expect(screen.getByText('Edit')).toBeInTheDocument();
    expect(screen.getByText('Write')).toBeInTheDocument();
  });

  it('renders without crashing when session detail has no toolCalls and no toolBreakdown', async () => {
    const emptyDetail = {
      sessionId: 'abc-123',
      durationMs: 198332,
      toolCallCount: 0,
    };
    renderSessions(REAL_API_LIST, { 'abc-123': emptyDetail });
    await waitFor(() => expect(screen.getByText(/abc-123/)).toBeInTheDocument());
    fireEvent.click(screen.getAllByText(/abc-123/)[0]);
    await waitFor(() => expect(screen.getByText(/no tool calls/i)).toBeInTheDocument());
  });

  it('renders the Session Quality and Tool Selection cards when the API attaches them', async () => {
    renderSessions(SAMPLE_LIST, {
      s1: {
        sessionId: 's1',
        timeline: [],
        toolBreakdown: { Edit: 2 },
        qualityProxy: {
          diffApplyRate: 0.8,
          testPassRate: 0.6,
          backtrackCount: 2,
          selfCorrectionCount: 1,
        },
        toolSelectionScore: {
          score: 0.75,
          redundantReadCount: 3,
          repeatedFailureCount: 1,
          unusedOutputCount: 0,
        },
      },
    });
    await waitFor(() => expect(screen.getByText('Session Quality')).toBeInTheDocument());
    expect(screen.getByText('Tool Selection')).toBeInTheDocument();
    expect(screen.getByText('80%')).toBeInTheDocument();
    expect(screen.getByText('0.75')).toBeInTheDocument();
  });
});

describe('Sessions view — workflow consolidation', () => {
  interface WorkflowDetailMap {
    readonly [runId: string]: unknown;
  }

  function renderSessionsFull(
    sessionList: unknown,
    workflowRuns: unknown,
    workflowDetails: WorkflowDetailMap = {},
  ) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    globalThis.fetch = ((url: string) => {
      if (url.startsWith('/api/workflows/')) {
        const runId = decodeURIComponent(url.split('/').pop() ?? '');
        const detail = workflowDetails[runId] ?? { run: null, agents: [], topology: null };
        return Promise.resolve(
          new Response(JSON.stringify(detail), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url === '/api/workflows') {
        return Promise.resolve(
          new Response(JSON.stringify(workflowRuns), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url.startsWith('/api/sessions/')) {
        const id = decodeURIComponent(url.split('/').pop() ?? '');
        return Promise.resolve(
          new Response(JSON.stringify({ sessionId: id, timeline: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(sessionList), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch;
    return render(
      <QueryClientProvider client={qc}>
        <Sessions />
      </QueryClientProvider>,
    );
  }

  const SESSIONS = [
    {
      sessionId: 'sess-a',
      startTime: '2026-05-28T09:00:00Z',
      toolCallCount: 10,
      estimatedCostUsd: 1,
    },
    {
      sessionId: 'sess-b',
      startTime: '2026-05-27T09:00:00Z',
      toolCallCount: 5,
      estimatedCostUsd: 0.5,
    },
  ];

  const RUNS = [
    {
      runId: 'run-1',
      parentSessionId: 'sess-a',
      taskId: null,
      workflowName: 'review',
      status: 'completed',
      defaultModel: 'claude-sonnet-5',
      startedAt: Date.parse('2026-05-28T09:05:00Z'),
      durationMs: 60_000,
      agentCount: 3,
      totalUsd: 2,
      runSource: 'script',
    },
    {
      runId: 'run-2',
      parentSessionId: 'sess-b',
      taskId: null,
      workflowName: 'migrate',
      status: 'failed',
      defaultModel: 'claude-sonnet-5',
      startedAt: Date.parse('2026-05-27T09:05:00Z'),
      durationMs: 30_000,
      agentCount: 1,
      totalUsd: 1,
      runSource: 'agent_tool',
    },
  ];

  it('computes real KPI aggregation from workflow run data, not session-shaped stand-ins', async () => {
    const { container } = renderSessionsFull(SESSIONS, RUNS);
    await waitFor(() => expect(screen.getByText(/sess-a/)).toBeInTheDocument());
    // avgDurationMs = (60000 + 30000) / 2 = 45000ms — same formatDuration()
    // convention as the existing "5s" assertion for durationMs: 5000 above.
    expect(container.textContent).toContain('45s');
    // totalSpend = 2 + 1 = 3 — regex tolerates whatever decimal padding
    // formatUsdOrDash uses.
    expect(container.textContent).toMatch(/\$3(\.0+)?/);
  });

  it('scopes the visible session list to the run-source filter', async () => {
    renderSessionsFull(SESSIONS, RUNS);
    await waitFor(() => expect(screen.getByText(/sess-a/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Script' }));
    await waitFor(() => expect(screen.queryByText(/sess-b/)).not.toBeInTheDocument());
    expect(screen.getByText(/sess-a/)).toBeInTheDocument();
  });

  it('scopes the visible session list to the status filter', async () => {
    renderSessionsFull(SESSIONS, RUNS);
    await waitFor(() => expect(screen.getByText(/sess-a/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Failed' }));
    await waitFor(() => expect(screen.queryByText(/sess-a/)).not.toBeInTheDocument());
    expect(screen.getByText(/sess-b/)).toBeInTheDocument();
  });

  it('expands a session to reveal its workflow runs, then expands a run to reveal its agents', async () => {
    renderSessionsFull(SESSIONS, RUNS, {
      'run-1': {
        run: RUNS[0],
        agents: [
          {
            agentId: 'a1',
            label: 'agent 1',
            model: 'claude-sonnet-5',
            startedAt: 1000,
            durationMs: 500,
            toolCalls: 3,
            tokens: 100,
          },
        ],
        topology: null,
      },
    });
    await waitFor(() => expect(screen.getByText(/sess-a/)).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole('button', { name: 'Expand workflows' })[0]!);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /View workflow run review/ })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Expand agents' }));
    await waitFor(() => expect(screen.getByText('agent 1')).toBeInTheDocument());
  });

  it('opens the in-place workflow-run drawer when a run row is clicked', async () => {
    renderSessionsFull(SESSIONS, RUNS, {
      'run-1': { run: RUNS[0], agents: [], topology: null },
    });
    await waitFor(() => expect(screen.getByText(/sess-a/)).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole('button', { name: 'Expand workflows' })[0]!);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /View workflow run review/ })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /View workflow run review/ }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    // The dialog shell mounts immediately on open, before its own
    // WorkflowRunDetail query resolves — wait for the heading separately so
    // this doesn't race the fetch.
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'review' })).toBeInTheDocument(),
    );
  });

  it('selects the session named in the ?session= query param on mount', async () => {
    const original = window.location;
    // @ts-expect-error -- test-only reassignment of a read-only global
    delete window.location;
    window.location = { ...original, search: '?session=sess-b' } as Location;
    renderSessionsFull(SESSIONS, RUNS);
    await waitFor(() => expect(screen.getByText(/sess-b/)).toBeInTheDocument());
    window.location = original;
  });
});
