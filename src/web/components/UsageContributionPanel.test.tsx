import { describe, it, expect } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';

import {
  UsageContributionPanel,
  aggregateToolUsage,
  buildToolTableRows,
  type ModelShareRow,
} from './UsageContributionPanel';
import type { UsageInsightsReport } from '../api/client';

const SAMPLE_USAGE_INSIGHTS: UsageInsightsReport = {
  windowDays: 30,
  sessionCount: 12,
  totalCostUsd: 40,
  totalTokens: 200000,
  insights: [
    {
      id: 'high_context',
      key: 'high_context',
      costUsd: 12,
      tokens: 50000,
      count: 4,
      sharePct: 30,
      sessionCount: 12,
      headline: 'High-context sessions are driving spend',
      advice: 'Trim context before starting new sessions.',
    },
    {
      id: 'subagent_heavy',
      key: 'subagent_heavy',
      costUsd: 8,
      tokens: 20000,
      count: 3,
      sharePct: 20,
      sessionCount: 12,
      headline: 'Subagent delegation is a large cost driver',
      advice: 'Review which subagents are being spawned.',
    },
  ],
  skills: [{ key: 'code-review', costUsd: 5, tokens: 10000, count: 6, sharePct: 12 }],
  subagents: [{ key: 'general-purpose', costUsd: 4, tokens: 8000, count: 3, sharePct: 10 }],
  plugins: [{ key: 'pstack', costUsd: 2, tokens: 3000, count: 1, sharePct: 5 }],
  loops: [
    {
      sessionId: 'loop-session-1',
      sessionName: 'Nightly loop',
      runs: 5,
      tokens: 6000,
      tokensPerRun: 1200,
      costUsd: 1.5,
      lastRunMs: Date.now() - 5 * 60 * 1000,
    },
  ],
  skillsTotalCount: 1,
  subagentsTotalCount: 1,
  pluginsTotalCount: 1,
  loopsTotalCount: 1,
  attributionRatePct: 40,
};

const SAMPLE_TOOL_SESSIONS: Array<{ toolBreakdown: Record<string, number> }> = [
  { toolBreakdown: { Read: 10, Edit: 5, Bash: 3 } },
  { toolBreakdown: { Read: 8, Edit: 7, Write: 2 } },
];

function findPanel(title: string): HTMLElement {
  return screen.getByText(title).closest('.glass-card') as HTMLElement;
}

describe('aggregateToolUsage', () => {
  it('merges tool breakdowns across sessions and returns top 8', () => {
    const result = aggregateToolUsage(SAMPLE_TOOL_SESSIONS);
    expect(result[0]).toEqual({ tool: 'Read', count: 18 });
    expect(result[1]).toEqual({ tool: 'Edit', count: 12 });
    expect(result[2]).toEqual({ tool: 'Bash', count: 3 });
    expect(result[3]).toEqual({ tool: 'Write', count: 2 });
  });

  it('limits to top 8 tools', () => {
    const toolBreakdown: Record<string, number> = {};
    for (let i = 0; i < 12; i++) {
      toolBreakdown[`tool_${i}`] = 12 - i;
    }
    const result = aggregateToolUsage([{ toolBreakdown }]);
    expect(result).toHaveLength(8);
    expect(result[0].tool).toBe('tool_0');
    expect(result[7].tool).toBe('tool_7');
  });

  it('skips sessions without toolBreakdown', () => {
    const result = aggregateToolUsage([{}, { toolBreakdown: { Read: 5 } }]);
    expect(result).toEqual([{ tool: 'Read', count: 5 }]);
  });

  it('returns empty array for empty input', () => {
    expect(aggregateToolUsage([])).toEqual([]);
  });
});

describe('UsageContributionPanel — Tools table', () => {
  it('renders a Tools row for the leading tool with its share of calls', () => {
    render(
      <UsageContributionPanel
        data={SAMPLE_USAGE_INSIGHTS}
        isError={false}
        title="What's contributing to your spend"
        subtitle="Last 30 days"
        toolRows={buildToolTableRows(SAMPLE_TOOL_SESSIONS)}
      />,
    );
    const panel = findPanel("What's contributing to your spend");
    // aggregateToolUsage(SAMPLE_TOOL_SESSIONS): Read=18, Edit=12, Bash=3,
    // Write=2, total=35 -> Read's share = round(18/35*100) = 51%.
    const cell = within(panel).getByRole('cell', { name: 'Read' });
    const row = cell.closest('tr') as HTMLElement;
    expect(within(row).getByRole('cell', { name: '18' })).toBeInTheDocument();
    expect(within(row).getByRole('cell', { name: '51%' })).toBeInTheDocument();
    // No windowed per-tool cost figure exists, so the header says what the
    // share is actually of.
    expect(within(panel).getByRole('columnheader', { name: 'Share of calls' })).toBeInTheDocument();
  });

  it('says how many rows a capped share table dropped', () => {
    render(
      <UsageContributionPanel
        data={{ ...SAMPLE_USAGE_INSIGHTS, skillsTotalCount: 14 }}
        isError={false}
        title="What's contributing to your spend"
        subtitle="Last 30 days"
        toolRows={buildToolTableRows(SAMPLE_TOOL_SESSIONS)}
      />,
    );
    const panel = findPanel("What's contributing to your spend");
    expect(within(panel).getByText('top 1 of 14')).toBeInTheDocument();
    expect(within(panel).queryByText('top 1 of 1')).not.toBeInTheDocument();
  });

  it('sorts the Tools table by its clicked column', () => {
    render(
      <UsageContributionPanel
        data={SAMPLE_USAGE_INSIGHTS}
        isError={false}
        title="What's contributing to your spend"
        subtitle="Last 30 days"
        toolRows={buildToolTableRows(SAMPLE_TOOL_SESSIONS)}
      />,
    );
    const toolsTable = screen.getByText('Tools', { selector: 'h4' }).closest('div') as HTMLElement;
    const toolNameForRow = (row: HTMLElement) => within(row).getAllByRole('cell')[0]!.textContent;

    // Default sort is share of calls descending.
    expect(within(toolsTable).getAllByRole('row').slice(1).map(toolNameForRow)).toEqual([
      'Read',
      'Edit',
      'Bash',
      'Write',
    ]);

    // A second click on the same (already-descending) column reverses it.
    fireEvent.click(within(toolsTable).getByRole('button', { name: 'Share of calls' }));
    expect(within(toolsTable).getAllByRole('row').slice(1).map(toolNameForRow)).toEqual([
      'Write',
      'Bash',
      'Edit',
      'Read',
    ]);
  });

  // Edit intentionally has no entry — a tool with calls but no attributed
  // cost yet (a windowed fetch mixing attributed and unattributed sessions).
  const SAMPLE_COST_BY_TOOL = {
    Read: { totalCost: 4, callCount: 18, avgCost: 4 / 18, tokens: 9000 },
    Bash: { totalCost: 1, callCount: 3, avgCost: 1 / 3, tokens: 500 },
  };

  it('shows Cost and Tokens columns, and "% of spend" as share, when toolCostAvailable is set', () => {
    render(
      <UsageContributionPanel
        data={SAMPLE_USAGE_INSIGHTS}
        isError={false}
        title="What's contributing to your spend"
        subtitle="Last 30 days"
        toolRows={buildToolTableRows(SAMPLE_TOOL_SESSIONS, SAMPLE_COST_BY_TOOL)}
        toolCostAvailable
      />,
    );
    const panel = findPanel("What's contributing to your spend");
    // Skills/Subagents/Plugins already have their own "% of spend" columns,
    // so scope to the Tools table specifically.
    const toolsTable = within(panel)
      .getByText('Tools', { selector: 'h4' })
      .closest('div') as HTMLElement;
    expect(
      within(toolsTable).getByRole('columnheader', { name: '% of spend' }),
    ).toBeInTheDocument();
    expect(within(toolsTable).queryByRole('columnheader', { name: 'Share of calls' })).toBeNull();

    // Read=$4, Bash=$1, total attributed cost=$5 -> Read's share = 80%.
    const readRow = within(toolsTable)
      .getByRole('cell', { name: 'Read' })
      .closest('tr') as HTMLElement;
    expect(within(readRow).getByRole('cell', { name: '$4.00' })).toBeInTheDocument();
    expect(within(readRow).getByRole('cell', { name: '9.0k' })).toBeInTheDocument();
    expect(within(readRow).getByRole('cell', { name: '80%' })).toBeInTheDocument();

    // Edit has calls but no cost entry — its cost/tokens cells show a dash,
    // not a fabricated 0, and its share of the $5 attributed total is 0%.
    const editRow = within(toolsTable)
      .getByRole('cell', { name: 'Edit' })
      .closest('tr') as HTMLElement;
    expect(within(editRow).getAllByRole('cell', { name: '—' })).toHaveLength(2);
    expect(within(editRow).getByRole('cell', { name: '0%' })).toBeInTheDocument();
  });

  it('renders the tool coverage caveat only when set', () => {
    render(
      <UsageContributionPanel
        data={SAMPLE_USAGE_INSIGHTS}
        isError={false}
        title="What's contributing to your spend"
        subtitle="Last 30 days"
        toolRows={[]}
        toolCoverageCaveat="Cost/token breakdown only available for 3 of 4 sessions in this window — older sessions predate per-tool attribution."
      />,
    );
    expect(
      screen.getByText(/Cost\/token breakdown only available for 3 of 4 sessions/),
    ).toBeInTheDocument();
  });

  it('omits the tool coverage caveat when unset', () => {
    render(
      <UsageContributionPanel
        data={SAMPLE_USAGE_INSIGHTS}
        isError={false}
        title="What's contributing to your spend"
        subtitle="Last 30 days"
        toolRows={[]}
      />,
    );
    expect(screen.queryByText(/predate per-tool attribution/)).toBeNull();
  });
});

describe('buildToolTableRows with cost data', () => {
  it('switches share to cost-share and leaves an unattributed tool undefined', () => {
    const rows = buildToolTableRows(SAMPLE_TOOL_SESSIONS, {
      Read: { totalCost: 4, tokens: 9000 },
      Bash: { totalCost: 1 },
    });
    const read = rows.find((r) => r.tool === 'Read')!;
    const edit = rows.find((r) => r.tool === 'Edit')!;
    expect(read.costUsd).toBe(4);
    expect(read.tokens).toBe(9000);
    expect(read.sharePct).toBe(80);
    expect(edit.costUsd).toBeUndefined();
    expect(edit.tokens).toBeUndefined();
    expect(edit.sharePct).toBe(0);
  });

  it('falls back to call-share when no tool in costByToolType has any cost', () => {
    const rows = buildToolTableRows(SAMPLE_TOOL_SESSIONS, {});
    const read = rows.find((r) => r.tool === 'Read')!;
    // aggregateToolUsage total = 35, Read = 18 -> same call-based share as the no-cost-data case.
    expect(read.sharePct).toBeCloseTo((18 / 35) * 100, 10);
  });
});

describe('UsageContributionPanel', () => {
  it('renders the given title and subtitle with no per-panel toggle', () => {
    render(
      <UsageContributionPanel
        data={SAMPLE_USAGE_INSIGHTS}
        isError={false}
        title="What's contributing to your spend"
        subtitle="Last 30 days"
        toolRows={[]}
      />,
    );
    const panel = findPanel("What's contributing to your spend");
    expect(within(panel).getByText('Last 30 days')).toBeInTheDocument();
    expect(within(panel).queryByRole('tab')).toBeNull();
  });

  it('renders each insight headline, one row from each of the five tables, and the low-attribution footnote', () => {
    render(
      <UsageContributionPanel
        data={SAMPLE_USAGE_INSIGHTS}
        isError={false}
        title="What's contributing to your spend"
        subtitle="Last 30 days"
        toolRows={buildToolTableRows(SAMPLE_TOOL_SESSIONS)}
      />,
    );
    expect(screen.getByText('High-context sessions are driving spend')).toBeInTheDocument();
    expect(screen.getByText('Subagent delegation is a large cost driver')).toBeInTheDocument();
    expect(screen.getByText('code-review')).toBeInTheDocument();
    expect(screen.getByText('general-purpose')).toBeInTheDocument();
    expect(screen.getByText('pstack')).toBeInTheDocument();
    expect(screen.getByText('Nightly loop')).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Read' })).toBeInTheDocument();
    expect(screen.getByText(/40% of spend with/)).toBeInTheDocument();
  });

  it('links the Loops Session cell to that session, keyed by sessionId', () => {
    render(
      <UsageContributionPanel
        data={SAMPLE_USAGE_INSIGHTS}
        isError={false}
        title="What's contributing to your spend"
        subtitle="Last 30 days"
        toolRows={[]}
      />,
    );
    const link = screen.getByRole('link', { name: 'Nightly loop' });
    expect(link).toHaveAttribute('href', '/sessions?sessionIds=loop-session-1');
  });

  it('links the Loops Session cell to the 8-char session id when it has no name', () => {
    render(
      <UsageContributionPanel
        data={{
          ...SAMPLE_USAGE_INSIGHTS,
          loops: [
            {
              sessionId: 'unnamed-session-42',
              sessionName: null,
              runs: 2,
              tokens: 1000,
              tokensPerRun: 500,
              costUsd: 0.3,
              lastRunMs: Date.now(),
            },
          ],
        }}
        isError={false}
        title="What's contributing to your spend"
        subtitle="Last 30 days"
        toolRows={[]}
      />,
    );
    const link = screen.getByRole('link', { name: 'unnamed-' });
    expect(link).toHaveAttribute('href', '/sessions?sessionIds=unnamed-session-42');
  });

  it('renders "<1%" instead of "0%" for a row with spend that rounds to a zero share', () => {
    render(
      <UsageContributionPanel
        data={{
          ...SAMPLE_USAGE_INSIGHTS,
          plugins: [{ key: 'tiny-plugin', costUsd: 0.01, tokens: 50, count: 1, sharePct: 0 }],
        }}
        isError={false}
        title="What's contributing to your spend"
        subtitle="Last 30 days"
        toolRows={[]}
      />,
    );
    expect(screen.getByText('tiny-plugin')).toBeInTheDocument();
    expect(screen.getByText('<1%')).toBeInTheDocument();
  });

  it('shows "No sessions in this window." when sessionCount is 0', () => {
    render(
      <UsageContributionPanel
        data={{
          ...SAMPLE_USAGE_INSIGHTS,
          sessionCount: 0,
          insights: [],
          skills: [],
          subagents: [],
          plugins: [],
          loops: [],
        }}
        isError={false}
        title="What's contributing to your spend"
        subtitle="Last 30 days"
        toolRows={[]}
      />,
    );
    expect(screen.getByText('No sessions in this window.')).toBeInTheDocument();
  });

  it('shows "Nothing stands out in this window." with empty insights while still rendering a populated skills table', () => {
    render(
      <UsageContributionPanel
        data={{
          ...SAMPLE_USAGE_INSIGHTS,
          insights: [],
          subagents: [],
          plugins: [],
          loops: [],
        }}
        isError={false}
        title="What's contributing to your spend"
        subtitle="Last 30 days"
        toolRows={[]}
      />,
    );
    expect(screen.getByText('Nothing stands out in this window.')).toBeInTheDocument();
    expect(screen.getByText('code-review')).toBeInTheDocument();
  });

  it('shows a loading state when data is undefined', () => {
    render(
      <UsageContributionPanel
        data={undefined}
        isError={false}
        title="What's contributing to your spend"
        subtitle="Last 30 days"
        toolRows={[]}
      />,
    );
    expect(screen.getByText('Loading usage insights…')).toBeInTheDocument();
  });

  it('shows an unavailable state on isError', () => {
    render(
      <UsageContributionPanel
        data={undefined}
        isError={true}
        title="What's contributing to your spend"
        subtitle="Last 30 days"
        toolRows={[]}
      />,
    );
    expect(screen.getByText('Usage insights unavailable')).toBeInTheDocument();
  });
});

describe('UsageContributionPanel — Models table', () => {
  const SAMPLE_MODEL_ROWS: ModelShareRow[] = [
    {
      model: 'claude-sonnet-5',
      requestCount: 8,
      costPerMillionTokens: 0.75,
      totalCostUsd: 4.2,
      sharePct: 100,
    },
  ];

  it('renders a Models row with requests, cost per million tokens, cost, and share, ahead of Skills', () => {
    render(
      <UsageContributionPanel
        data={SAMPLE_USAGE_INSIGHTS}
        isError={false}
        title="What's contributing to your spend"
        subtitle="Last 30 days"
        modelRows={SAMPLE_MODEL_ROWS}
        toolRows={[]}
      />,
    );
    const row = screen.getByRole('cell', { name: 'claude-sonnet-5' }).closest('tr') as HTMLElement;
    expect(within(row).getByRole('cell', { name: '8' })).toBeInTheDocument();
    expect(within(row).getByRole('cell', { name: '$0.75' })).toBeInTheDocument();
    expect(within(row).getByRole('cell', { name: '$4.20' })).toBeInTheDocument();
    expect(within(row).getByRole('cell', { name: '100%' })).toBeInTheDocument();

    const modelsHeading = screen.getByText('Models', { selector: 'h4' });
    const skillsHeading = screen.getByText('Skills', { selector: 'h4' });
    expect(
      modelsHeading.compareDocumentPosition(skillsHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('renders no Models table when modelRows is omitted', () => {
    render(
      <UsageContributionPanel
        data={SAMPLE_USAGE_INSIGHTS}
        isError={false}
        title="What's contributing to your spend"
        subtitle="Last 30 days"
        toolRows={[]}
      />,
    );
    expect(screen.queryByText('Models')).toBeNull();
  });

  it('renders no Models table when modelRows is empty', () => {
    render(
      <UsageContributionPanel
        data={SAMPLE_USAGE_INSIGHTS}
        isError={false}
        title="What's contributing to your spend"
        subtitle="Last 30 days"
        modelRows={[]}
        toolRows={[]}
      />,
    );
    expect(screen.queryByText('Models')).toBeNull();
  });
});

describe('UsageContributionPanel — Skills/Subagents/Plugins column consistency', () => {
  it('shows a Cost column on the Skills and Subagents tables', () => {
    render(
      <UsageContributionPanel
        data={SAMPLE_USAGE_INSIGHTS}
        isError={false}
        title="What's contributing to your spend"
        subtitle="Last 30 days"
        toolRows={[]}
      />,
    );
    const skillRow = screen.getByRole('cell', { name: 'code-review' }).closest('tr') as HTMLElement;
    expect(within(skillRow).getByRole('cell', { name: '$5.00' })).toBeInTheDocument();

    const subagentRow = screen
      .getByRole('cell', { name: 'general-purpose' })
      .closest('tr') as HTMLElement;
    expect(within(subagentRow).getByRole('cell', { name: '$4.00' })).toBeInTheDocument();
  });

  it('shows Calls and Tokens columns on the Plugins table', () => {
    render(
      <UsageContributionPanel
        data={SAMPLE_USAGE_INSIGHTS}
        isError={false}
        title="What's contributing to your spend"
        subtitle="Last 30 days"
        toolRows={[]}
      />,
    );
    const pluginRow = screen.getByRole('cell', { name: 'pstack' }).closest('tr') as HTMLElement;
    expect(within(pluginRow).getByRole('cell', { name: '1' })).toBeInTheDocument();
    expect(within(pluginRow).getByRole('cell', { name: '3.0k' })).toBeInTheDocument();
  });

  it('shows a Cost column on the Plugins table matching Skills and Subagents', () => {
    render(
      <UsageContributionPanel
        data={SAMPLE_USAGE_INSIGHTS}
        isError={false}
        title="What's contributing to your spend"
        subtitle="Last 30 days"
        toolRows={[]}
      />,
    );
    const pluginRow = screen.getByRole('cell', { name: 'pstack' }).closest('tr') as HTMLElement;
    expect(within(pluginRow).getByRole('cell', { name: '$2.00' })).toBeInTheDocument();
  });

  it('sets the token-breakdown title on the Tokens and Cost cells when the row carries one, and omits it otherwise', () => {
    const withBreakdown: UsageInsightsReport = {
      ...SAMPLE_USAGE_INSIGHTS,
      skills: [
        {
          key: 'code-review',
          costUsd: 5,
          tokens: 10000,
          count: 6,
          sharePct: 12,
          breakdown: {
            inputTokens: 1200,
            outputTokens: 800,
            cacheReadTokens: 30000,
            cacheCreationTokens: 2000,
          },
        },
      ],
    };
    render(
      <UsageContributionPanel
        data={withBreakdown}
        isError={false}
        title="What's contributing to your spend"
        subtitle="Last 30 days"
        toolRows={[]}
      />,
    );

    const skillRow = screen.getByRole('cell', { name: 'code-review' }).closest('tr') as HTMLElement;
    const expectedTitle = 'Input 1.2k · Output 800 · Cache read 30.0k · Cache write 2.0k';
    expect(within(skillRow).getByRole('cell', { name: '10.0k' })).toHaveAttribute(
      'title',
      expectedTitle,
    );
    expect(within(skillRow).getByRole('cell', { name: '$5.00' })).toHaveAttribute(
      'title',
      expectedTitle,
    );

    // Subagents row in SAMPLE_USAGE_INSIGHTS carries no breakdown.
    const subagentRow = screen
      .getByRole('cell', { name: 'general-purpose' })
      .closest('tr') as HTMLElement;
    expect(within(subagentRow).getByRole('cell', { name: '8.0k' })).not.toHaveAttribute('title');
    expect(within(subagentRow).getByRole('cell', { name: '$4.00' })).not.toHaveAttribute('title');
  });

  it('includes per-category dollars in the hover when the breakdown carries cost', () => {
    const withCost: UsageInsightsReport = {
      ...SAMPLE_USAGE_INSIGHTS,
      skills: [
        {
          key: 'code-review',
          costUsd: 5,
          tokens: 10000,
          count: 6,
          sharePct: 12,
          breakdown: {
            inputTokens: 1200,
            outputTokens: 800,
            cacheReadTokens: 30000,
            cacheCreationTokens: 2000,
            cost: {
              inputUsd: 0.36,
              outputUsd: 1.2,
              cacheReadUsd: 0.009,
              cacheCreationUsd: 0.015,
            },
          },
        },
      ],
    };
    render(
      <UsageContributionPanel
        data={withCost}
        isError={false}
        title="What's contributing to your spend"
        subtitle="Last 30 days"
        toolRows={[]}
      />,
    );

    const skillRow = screen.getByRole('cell', { name: 'code-review' }).closest('tr') as HTMLElement;
    const expectedTitle =
      'Input 1.2k ($0.36) · Output 800 ($1.20) · Cache read 30.0k ($0.009) · Cache write 2.0k ($0.015)';
    expect(within(skillRow).getByRole('cell', { name: '10.0k' })).toHaveAttribute(
      'title',
      expectedTitle,
    );
    expect(within(skillRow).getByRole('cell', { name: '$5.00' })).toHaveAttribute(
      'title',
      expectedTitle,
    );
  });
});
