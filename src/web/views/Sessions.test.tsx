import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Sessions } from './Sessions';

interface DetailMap {
  readonly [sessionId: string]: unknown;
}

function renderSessions(listData: unknown, detailMap: DetailMap = {}, workflowsData: unknown = []) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
  globalThis.fetch = ((url: string) => {
    if (url.startsWith('/api/sessions/')) {
      const id = decodeURIComponent(url.split('/').pop() ?? '');
      const detail = detailMap[id] ?? { sessionId: id, timeline: [] };
      return Promise.resolve(
        new Response(JSON.stringify(detail), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    if (url.startsWith('/api/workflows')) {
      return Promise.resolve(
        new Response(JSON.stringify(workflowsData), {
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

  it('states the actual number of visible sessions in the runs-outside-page disclosure, not the page-size cap', async () => {
    // Fewer sessions than the page-size cap are loaded (2), and one run
    // belongs to a session that isn't among them — the disclosure must
    // report against the real visible count, not the fetch cap.
    renderSessions(SAMPLE_LIST, {}, [
      {
        runId: 'run-1',
        parentSessionId: 'missing-session',
        taskId: null,
        workflowName: 'wf',
        status: 'completed',
        defaultModel: 'claude',
      },
    ]);
    await waitFor(() => expect(screen.getByText(/s1/)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(/\+1 run above/i)).toBeInTheDocument());
    expect(screen.getByText(/outside the 2 shown below/i)).toBeInTheDocument();
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
      expect(screen.getByText(/only the 50 most recent sessions are loaded/i)).toBeInTheDocument(),
    );
  });

  it('hides the cap notice when fewer than the page size are returned', async () => {
    renderSessions(SAMPLE_LIST);
    await waitFor(() => expect(screen.getByText(/s1/)).toBeInTheDocument());
    expect(
      screen.queryByText(/only the 50 most recent sessions are loaded/i),
    ).not.toBeInTheDocument();
  });

  it('clarifies the cap notice further narrows when a run filter is active', async () => {
    // A run filter can shrink the visible list to far fewer rows than the
    // fetch cap; the notice must not read as a description of that
    // narrowed view.
    const fullPage = Array.from({ length: 50 }, (_, i) => ({
      sessionId: `cap-${i}`,
      startTime: '2026-05-28T09:00:00Z',
      toolCallCount: 1,
      estimatedCostUsd: 0,
    }));
    renderSessions(fullPage);
    await waitFor(() =>
      expect(screen.getByText(/only the 50 most recent sessions are loaded/i)).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/only the 50 most recent sessions are loaded/i).textContent,
    ).not.toMatch(/narrow/i);

    const statusGroup = screen.getByRole('group', { name: /status filter/i });
    fireEvent.click(within(statusGroup).getByRole('button', { name: 'Completed' }));

    await waitFor(() =>
      expect(screen.getByText(/only the 50 most recent sessions are loaded/i).textContent).toMatch(
        /filters narrow this further/i,
      ),
    );
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
    // SessionTrace defaults to Gantt view — tool names appear as row labels
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

  it('renders every model in the Model card when modelBreakdown has more than one entry, most-called first', async () => {
    const detail = {
      sessionId: 's1',
      model: 'claude-opus-5',
      modelBreakdown: {
        'claude-opus-5': {
          requestCount: 2,
          totalInputTokens: 100,
          totalOutputTokens: 50,
          totalCostUsd: 0.5,
        },
        'claude-sonnet-5': {
          requestCount: 8,
          totalInputTokens: 400,
          totalOutputTokens: 200,
          totalCostUsd: 1.5,
        },
      },
      timeline: [{ timestamp: 1_000, toolName: 'Read', durationMs: 120, success: true }],
    };
    const { container } = renderSessions(SAMPLE_LIST, { s1: detail });
    await waitFor(() => expect(screen.getAllByText('Read').length).toBeGreaterThanOrEqual(1));
    expect(screen.getByText('Models (2)')).toBeInTheDocument();
    expect(screen.getByText('claude-sonnet-5')).toBeInTheDocument();
    expect(screen.getByText('claude-opus-5')).toBeInTheDocument();
    // Most-called model (claude-sonnet-5, 8 requests) renders before the
    // last-seen one (claude-opus-5, `model` above, only 2 requests).
    const text = container.textContent ?? '';
    expect(text.indexOf('claude-sonnet-5')).toBeLessThan(text.indexOf('claude-opus-5'));
  });

  it('renders the single-model layout unchanged when modelBreakdown has exactly one entry', async () => {
    const detail = {
      sessionId: 's1',
      model: 'claude-sonnet-5',
      modelBreakdown: {
        'claude-sonnet-5': {
          requestCount: 5,
          totalInputTokens: 200,
          totalOutputTokens: 100,
          totalCostUsd: 1,
        },
      },
      timeline: [{ timestamp: 1_000, toolName: 'Read', durationMs: 120, success: true }],
    };
    renderSessions(SAMPLE_LIST, { s1: detail });
    await waitFor(() => expect(screen.getAllByText('Read').length).toBeGreaterThanOrEqual(1));
    expect(screen.getByText('Model')).toBeInTheDocument();
    expect(screen.queryByText(/Models \(/)).toBeNull();
    expect(screen.getByText('claude-sonnet-5')).toBeInTheDocument();
  });

  it('falls back to data.model when modelBreakdown is absent or empty', async () => {
    const detail = {
      sessionId: 's1',
      model: 'claude-sonnet-5',
      modelBreakdown: {},
      timeline: [{ timestamp: 1_000, toolName: 'Read', durationMs: 120, success: true }],
    };
    renderSessions(SAMPLE_LIST, { s1: detail });
    await waitFor(() => expect(screen.getAllByText('Read').length).toBeGreaterThanOrEqual(1));
    expect(screen.getByText('Model')).toBeInTheDocument();
    expect(screen.getByText('claude-sonnet-5')).toBeInTheDocument();
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

  it('renders antiPatterns pills reusing the SEGMENT_LABELS taxonomy, summing real magnitude across grouped incidents', async () => {
    // Real API shape: one entry per detected incident, each carrying its
    // own file/command target.
    const detail = {
      sessionId: 's1',
      timeline: [{ timestamp: 1_000, toolName: 'Read', durationMs: 120, success: true }],
      antiPatterns: [
        { type: 'thrashing', file: 'a.ts', iterations: 3 },
        { type: 'thrashing', file: 'b.ts', iterations: 2 },
        { type: 'thrashing', file: 'c.ts', iterations: 4 },
        { type: 'over_delegation', agentCount: 5 },
      ],
    };
    const { container } = renderSessions(SAMPLE_LIST, { s1: detail });
    await waitFor(() => expect(container.textContent).toContain('Edit/Test Thrashing'));
    // Three thrashing incidents (3 + 2 + 4 iterations) sum to the real
    // magnitude, not the count of incident objects (which would be 3).
    expect(container.textContent).toContain('× 9');
    // over_delegation has a SEGMENT_LABELS entry and its own magnitude.
    expect(container.textContent).toContain('Over-Delegation');
    expect(container.textContent).not.toContain('over_delegation');
    expect(container.textContent).toContain('× 5');
  });

  it('groups same-type anti-pattern incidents into one pill with a stable key, summing to 1 per incident when no magnitude field is present', async () => {
    const detail = {
      sessionId: 's1',
      timeline: [{ timestamp: 1_000, toolName: 'Read', durationMs: 120, success: true }],
      antiPatterns: [
        { type: 'stuck_loop', command: 'npm test' },
        { type: 'stuck_loop', command: 'npm run build' },
      ],
    };
    const { container } = renderSessions(SAMPLE_LIST, { s1: detail });
    await waitFor(() => expect(container.textContent).toContain('× 2'));
    // Exactly one pill for the type — not two pills sharing a React key,
    // and no "undefined" from a missing top-level count field.
    expect(screen.getAllByText(/stuck.loop/i)).toHaveLength(1);
    expect(container.textContent).not.toContain('undefined');
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

  // A run's durationMs being null (unfinished/killed, still upstream in
  // workflow-store.ts/workflow-watcher.ts) is not the same as a confirmed
  // 0ms run. Averaging must exclude it rather than let it drag the average
  // toward zero.
  it('excludes a null durationMs from the Avg duration KPI average instead of treating it as zero', async () => {
    const runsWithUnknownDuration = [RUNS[0], { ...RUNS[1], durationMs: null }];
    const { container } = renderSessionsFull(SESSIONS, runsWithUnknownDuration);
    await waitFor(() => expect(screen.getByText(/sess-a/)).toBeInTheDocument());
    // Only run-1's 60_000ms contributes — average of just that one run is
    // "1m", not (60_000 + 0) / 2 = "30s" (which is what treating the null
    // run's duration as 0 would produce).
    expect(container.textContent).toContain('1m');
    expect(container.textContent).not.toContain('30s');
  });

  it('shows a session with no workflow runs under the Today tab when it started today', async () => {
    // sessionId kept to 8 chars: SessionListRow renders `sessionId.slice(0, 8)`,
    // so a longer id would never render in full and this assertion would be
    // vacuous regardless of the filtering fix under test.
    const todaySession = {
      sessionId: 'sess-tdy',
      startTime: new Date().toISOString(),
      toolCallCount: 3,
      estimatedCostUsd: 0.1,
    };
    const { container } = renderSessionsFull([...SESSIONS, todaySession], RUNS);
    await waitFor(() => expect(screen.getByText(/sess-a/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: 'Today' }));
    await waitFor(() => expect(within(container).getByText(/sess-tdy/)).toBeInTheDocument());
  });

  it('hides a session under the Today tab when it did not start today, even with no workflow runs', async () => {
    const oldSession = {
      sessionId: 'sess-old',
      startTime: '2020-01-01T00:00:00Z',
      toolCallCount: 3,
      estimatedCostUsd: 0.1,
    };
    const { container } = renderSessionsFull([...SESSIONS, oldSession], RUNS);
    await waitFor(() => expect(screen.getByText(/sess-a/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: 'Today' }));
    await waitFor(() => expect(container.textContent).not.toContain('sess-old'));
  });

  // A run's totalUsd being null is ambiguous between "confirmed $0" and "no
  // process ever observed this run's cost". costUnknown distinguishes the
  // two (a partial mitigation); the KPI must disclose when it does.
  it('flags the Workflow spend KPI as partial when a run has an unknown (not confirmed-zero) cost', async () => {
    const runsWithUnknownCost = [RUNS[0], { ...RUNS[1], totalUsd: null, costUnknown: true }];
    renderSessionsFull(SESSIONS, runsWithUnknownCost);
    await waitFor(() => expect(screen.getByText(/sess-a/)).toBeInTheDocument());
    expect(screen.getByText(/partial/i)).toBeInTheDocument();
  });

  it('does not flag the Workflow spend KPI as partial when every null cost is a confirmed $0', async () => {
    const runsWithConfirmedZero = [RUNS[0], { ...RUNS[1], totalUsd: null, costUnknown: false }];
    renderSessionsFull(SESSIONS, runsWithConfirmedZero);
    await waitFor(() => expect(screen.getByText(/sess-a/)).toBeInTheDocument());
    expect(screen.queryByText(/partial/i)).not.toBeInTheDocument();
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
    window.location = { ...original, search: '?session=sess-b' } as unknown as string & Location;
    renderSessionsFull(SESSIONS, RUNS);
    await waitFor(() => expect(screen.getByText(/sess-b/)).toBeInTheDocument());
    window.location = original as unknown as string & Location;
  });
});

describe('Sessions view — subagent fetch failure fallback', () => {
  // Documented fallback in SessionTraceSection: when the /subagents fetch
  // fails (retry: false, so a 404 or network error settles immediately as
  // isError), the section must still render the parent tool-call trace
  // (agents={[]}) rather than going blank.
  it('still renders the parent trace when /api/sessions/:id/subagents 404s', async () => {
    const detail = {
      sessionId: 's1',
      timeline: [{ timestamp: 1_000, toolName: 'Read', durationMs: 120, success: true }],
    };
    const subagentsCalls: string[] = [];
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    globalThis.fetch = ((url: string) => {
      if (url.includes('/subagents')) {
        subagentsCalls.push(url);
        return Promise.resolve(
          new Response('{"error":"not_found"}', {
            status: 404,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url.startsWith('/api/sessions/')) {
        return Promise.resolve(
          new Response(JSON.stringify(detail), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(SAMPLE_LIST), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch;

    render(
      <QueryClientProvider client={qc}>
        <Sessions />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText(/s1/)).toBeInTheDocument());
    fireEvent.click(screen.getAllByText(/s1/)[0]);

    // The parent lane's own group header must render — proof the section
    // fell through to the fallback SessionTrace render rather than blanking.
    await waitFor(() => expect(screen.getByText('Parent')).toBeInTheDocument());
    expect(screen.queryByText('Loading subagents')).toBeNull();
    await waitFor(() => expect(subagentsCalls.length).toBeGreaterThan(0));
  });
});

describe('Sessions view — live-detection and selection reliability', () => {
  // A deep link to a non-existent session (e.g., ?session=bad-id) should
  // show an error state with a "clear selection" action, not blank the detail pane.
  it('shows error state and clear-selection action when a deep-linked session does not exist', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    globalThis.fetch = ((url: string) => {
      if (url.startsWith('/api/sessions/')) {
        const id = decodeURIComponent(url.split('/').pop() ?? '');
        // Simulate a 404 for the bad deep-linked id
        if (id === 'bad-id') {
          return Promise.resolve(new Response('{"error":"not_found"}', { status: 404 }));
        }
        return Promise.resolve(
          new Response(JSON.stringify({ sessionId: id, timeline: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(SAMPLE_LIST), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch;

    const original = window.location;
    // @ts-expect-error -- test-only reassignment
    delete window.location;
    window.location = { ...original, search: '?session=bad-id' } as unknown as string & Location;

    render(
      <QueryClientProvider client={qc}>
        <Sessions />
      </QueryClientProvider>,
    );

    // The error state should render with the title "Session not found"
    await waitFor(() => expect(screen.getByText('Session not found')).toBeInTheDocument());
    // And a "Clear selection" button must be present to dismiss the error
    const clearBtn = screen.getByRole('button', { name: /clear selection/i });
    expect(clearBtn).toBeInTheDocument();

    // Clicking the button should clear selectedId. The error state should disappear.
    fireEvent.click(clearBtn);
    await waitFor(() => expect(screen.queryByText('Session not found')).not.toBeInTheDocument());

    window.location = original as unknown as string & Location;
  });

  // When current.data.sessionId is present but liveSessions is empty (a
  // session has ended), the liveSessionIds derivation should not fall back to
  // treating the ended session as live. It should return an empty set.
  it('treats empty liveSessions array as "nothing is live" and does not fall back to current.data.sessionId', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    const sessionList = [
      {
        sessionId: 's1',
        startTime: '2026-05-28T09:00:00Z',
        toolCallCount: 10,
      },
      {
        sessionId: 's2',
        startTime: '2026-05-27T09:00:00Z',
        toolCallCount: 5,
      },
    ];

    globalThis.fetch = ((url: string) => {
      if (url === '/api/session/current') {
        // Session s1 was active before but has ended: no liveSessions, but sessionId is present
        return Promise.resolve(
          new Response(
            JSON.stringify({
              sessionId: 's1',
              liveSessions: [],
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          ),
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

    render(
      <QueryClientProvider client={qc}>
        <Sessions />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText(/s1/)).toBeInTheDocument());
    // s1 should NOT have the "live" badge because liveSessions is empty (even
    // though current.data.sessionId = 's1'). Instead, the oldest item (s1)
    // should be auto-selected by the fallback once current settles.
    const liveElements = screen.queryAllByText(/live/i);
    expect(liveElements.length).toBe(0);
  });

  // Race condition guard: /api/sessions (list) can resolve before
  // /api/session/current (live check). The auto-select fallback to rows[0]
  // must wait until current.isLoading has settled to false at least once,
  // so it never clobbers a potential live-session selection.
  it('does not auto-select from rows before the live-session check has settled', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    const sessionList = [
      { sessionId: 's1', startTime: '2026-05-28T09:00:00Z', toolCallCount: 10 },
      { sessionId: 's2', startTime: '2026-05-27T09:00:00Z', toolCallCount: 5 },
    ];

    let currentFetchResolved = false;
    const detailFetchCalls: string[] = [];

    globalThis.fetch = ((url: string) => {
      if (url === '/api/session/current') {
        // Simulate a delay: this resolves after /api/sessions
        return new Promise((resolve) => {
          setTimeout(() => {
            currentFetchResolved = true;
            resolve(
              new Response(
                JSON.stringify({
                  sessionId: 's2',
                  liveSessions: ['s2'],
                }),
                {
                  status: 200,
                  headers: { 'content-type': 'application/json' },
                },
              ),
            );
          }, 100);
        });
      }
      if (url.startsWith('/api/sessions/')) {
        const id = decodeURIComponent(url.split('/').pop() ?? '');
        // Track which session detail is fetched to verify correct selection.
        // Without the fix, s1 would be fetched (buggy early auto-select).
        // With the fix, s2 is fetched (correct selection after live check settles).
        detailFetchCalls.push(id);
        return Promise.resolve(
          new Response(JSON.stringify({ sessionId: id, timeline: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      // /api/sessions list resolves immediately
      return Promise.resolve(
        new Response(JSON.stringify(sessionList), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch;

    render(
      <QueryClientProvider client={qc}>
        <Sessions />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText(/s1/)).toBeInTheDocument());
    // Even though s1 loads first from the list, the effect should NOT auto-select
    // it immediately. Once the live-session check settles (current.isLoading → false),
    // it should select s2 (the live session), not s1.
    await waitFor(() => expect(currentFetchResolved).toBe(true), { timeout: 1000 });
    // Verify that s2's detail was fetched, not s1's. This proves s2 was
    // selected — if s1 had been selected immediately, the "selectedId is
    // already set" guard would block ever switching to s2.
    await waitFor(() => expect(detailFetchCalls).toContain('s2'));
  });
});

describe('Sessions view — Tools panel Context tab', () => {
  it('fetches Context tab data through fetchContext(sessionId), rendering real contribution data', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    const sessionList = [
      { sessionId: 'live-sess', startTime: '2026-05-28T09:00:00Z', toolCallCount: 5 },
    ];
    const contextRequests: string[] = [];

    globalThis.fetch = ((url: string) => {
      if (url === '/api/session/current') {
        return Promise.resolve(
          new Response(JSON.stringify({ sessionId: 'live-sess', liveSessions: ['live-sess'] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url.startsWith('/api/context')) {
        contextRequests.push(url);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              turnCount: 3,
              growth: { startTokens: 0, currentTokens: 1000, deltaTokens: 1000 },
              currentBreakdown: { system: 100, tools: 500, user: 200, assistant: 200 },
              fillPercent: 0.5,
              contextWindow: 200_000,
              toolContributions: [
                { tool: 'Read', totalBytes: 2000, estimatedTokens: 500, percentOfToolOutput: 1 },
              ],
              history: [],
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          ),
        );
      }
      if (url.startsWith('/api/sessions/')) {
        const id = decodeURIComponent(url.split('/').pop() ?? '');
        return Promise.resolve(
          new Response(JSON.stringify({ sessionId: id, toolBreakdown: { Bash: 3 } }), {
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

    render(
      <QueryClientProvider client={qc}>
        <Sessions />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText(/^Tools$/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: 'Context' }));
    await waitFor(() => expect(screen.getByText('Read')).toBeInTheDocument());
    // Requesting the exact endpoint shape fetchContext(sessionId) builds
    // confirms the query goes through the shared client helper, not just
    // that some request happened to succeed.
    expect(contextRequests[0]).toBe('/api/context?sessionId=live-sess');
  });

  // Switching from a live session with the Context tab open to a different,
  // non-live session must reset the Tools panel to the Calls tab — a
  // session with real tool-call data should never render as if it has no
  // data.
  it('resets the Tools panel back to the Calls tab when switching from a live session to a non-live one', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    const sessionList = [
      { sessionId: 'live-sess', startTime: '2026-05-28T09:00:00Z', toolCallCount: 5 },
      { sessionId: 'done-sess', startTime: '2026-05-27T09:00:00Z', toolCallCount: 3 },
    ];

    globalThis.fetch = ((url: string) => {
      if (url === '/api/session/current') {
        return Promise.resolve(
          new Response(JSON.stringify({ sessionId: 'live-sess', liveSessions: ['live-sess'] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url.startsWith('/api/context')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              turnCount: 0,
              growth: { startTokens: 0, currentTokens: 0, deltaTokens: 0 },
              currentBreakdown: { system: 0, tools: 0, user: 0, assistant: 0 },
              fillPercent: 0,
              contextWindow: 200_000,
              toolContributions: [],
              history: [],
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          ),
        );
      }
      if (url.startsWith('/api/sessions/')) {
        const id = decodeURIComponent(url.split('/').pop() ?? '');
        const toolBreakdown = id === 'live-sess' ? { Bash: 3 } : { Edit: 7 };
        return Promise.resolve(
          new Response(JSON.stringify({ sessionId: id, toolBreakdown }), {
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

    render(
      <QueryClientProvider client={qc}>
        <Sessions />
      </QueryClientProvider>,
    );

    // Auto-selects the live session; open its Context tab.
    await waitFor(() => expect(screen.getByText(/^Tools$/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: 'Context' }));
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Context' })).toHaveAttribute('aria-selected', 'true'),
    );

    // Switch to the non-live session.
    fireEvent.click(screen.getAllByText(/done-ses/)[0]);
    await waitFor(() => expect(screen.getByText('Edit')).toBeInTheDocument());
    // The non-live session has no tab switcher at all (isLive is false), and
    // the Calls breakdown — not a stuck "No context data" empty state —
    // must be what's showing.
    expect(screen.queryByRole('tab', { name: 'Context' })).toBeNull();
    expect(screen.queryByText(/no context data/i)).toBeNull();
  });
});
