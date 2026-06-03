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
    // F-051: 50 rows is the page-size sentinel — the API caps at this and
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

  it('shows a placeholder until a session is selected', async () => {
    renderSessions(SAMPLE_LIST);
    await waitFor(() => expect(screen.getByText(/s1/)).toBeInTheDocument());
    expect(screen.getByText(/pick a session on the left/i)).toBeInTheDocument();
  });

  it('shows the empty-timeline message when the selected session has no tool calls', async () => {
    renderSessions(SAMPLE_LIST, { s1: { sessionId: 's1', toolCallCount: 0, timeline: [] } });
    await waitFor(() => expect(screen.getByText(/s1/)).toBeInTheDocument());
    fireEvent.click(screen.getAllByText(/s1/)[0]);
    await waitFor(() =>
      expect(screen.getByText(/no tool calls in this session/i)).toBeInTheDocument(),
    );
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
    await waitFor(() => expect(screen.getByText('Read')).toBeInTheDocument());
    expect(screen.getByText('Edit')).toBeInTheDocument();
    expect(screen.getByText('Bash')).toBeInTheDocument();
    expect(screen.getByText('120ms')).toBeInTheDocument();
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
    await waitFor(() => expect(screen.getByText('50ms')).toBeInTheDocument());
    expect(screen.getByText('80ms')).toBeInTheDocument();
    expect(screen.getAllByText('Read').length).toBe(2);
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
    await waitFor(() =>
      expect(screen.getByText(/s1-abcde · 5 calls · 5s/)).toBeInTheDocument(),
    );
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
    expect(screen.getByText('$0.42')).toBeInTheDocument();
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
    await waitFor(() => expect(screen.getByText(/tool breakdown/i)).toBeInTheDocument());
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
    await waitFor(() =>
      expect(screen.getByText(/no tool calls in this session/i)).toBeInTheDocument(),
    );
  });
});
