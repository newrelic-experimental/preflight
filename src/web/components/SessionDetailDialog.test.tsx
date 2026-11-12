import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SessionDetailDialog } from './SessionDetailDialog';
import type {
  DecisionTreeResponse,
  TurnCostsResponse,
  ContextResponse,
  ContextCompositionResponse,
  ContextEfficiencyResponse,
  SessionListEntry,
} from '../api/client';

function makeDecisionTree(overrides: Partial<DecisionTreeResponse> = {}): DecisionTreeResponse {
  return {
    totalBranches: 4,
    successRate: 0.75,
    failurePoints: [],
    longestFailureStreak: 2,
    firstFailureIndex: 1,
    note: 'reasoning fields are the model’s own thinking/text output for that turn',
    ...overrides,
  };
}

function makeTurnCosts(overrides: Partial<TurnCostsResponse> = {}): TurnCostsResponse {
  return {
    turns: [
      {
        turnId: 't1',
        startTime: 1,
        endTime: 2,
        toolCalls: ['toolu_001'],
        toolNames: ['Read'],
        inputTokens: 500,
        outputTokens: 100,
        cacheReadTokens: 0,
        model: 'claude-sonnet-5',
        estimatedCostUsd: 0.01,
        costPerToolCall: 0.01,
      },
    ],
    costByToolType: {},
    totalAttributedCost: 0.01,
    attributionRate: 1,
    ...overrides,
  };
}

function makeSixTurns(): TurnCostsResponse['turns'] {
  return Array.from({ length: 6 }, (_, i) => ({
    turnId: `t${i + 1}`,
    startTime: i,
    endTime: i + 1,
    toolCalls: [`toolu_00${i + 1}`],
    toolNames: [i === 5 ? 'Bash' : 'Read'],
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    model: 'claude-sonnet-5',
    estimatedCostUsd: (i + 1) / 100,
    costPerToolCall: (i + 1) / 100,
  }));
}

function makeContextComposition(
  overrides: Partial<ContextCompositionResponse> = {},
): ContextCompositionResponse {
  return {
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
    ...overrides,
  };
}

function makeContextEfficiency(
  overrides: Partial<ContextEfficiencyResponse> = {},
): ContextEfficiencyResponse {
  return {
    uniqueFilesRead: 12,
    totalReadOperations: 20,
    repeatedReadCount: 8,
    repeatedReadRatio: 0.4,
    topRepeatedFiles: [{ file: 'src/index.ts', readCount: 4 }],
    ...overrides,
  };
}

function makeContextHistory(count: number): ContextResponse['history'] {
  return Array.from({ length: count }, (_, i) => ({
    turnNumber: i + 1,
    timestamp: i,
    inputTokens: (i + 1) * 10_000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    fillPercent: (((i + 1) * 10_000) / 200_000) * 100,
    breakdown: { system: 5_000, tools: 3_000, user: 1_500, assistant: 500 },
  }));
}

describe('SessionDetailDialog', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders decision-tree stats and every turn row, not just the last 5', () => {
    render(
      <SessionDetailDialog
        decisionTree={makeDecisionTree()}
        turnCosts={makeTurnCosts({ turns: makeSixTurns(), totalAttributedCost: 0.21 })}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/longest failure streak/i)).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('75%')).toBeInTheDocument();
    // The 6th turn would have been sliced off by the old `.slice(-5)` — assert
    // it's visible here since the dialog has room to show every turn.
    expect(screen.getByText('$0.06')).toBeInTheDocument();
    expect(screen.getByText('$0.21')).toBeInTheDocument();
  });

  it('shows a "No data yet" fallback for an empty/undefined decision tree', () => {
    render(
      <SessionDetailDialog
        decisionTree={undefined}
        turnCosts={makeTurnCosts()}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/no decision-tree data yet/i)).toBeInTheDocument();
  });

  it('shows a "No data yet" fallback for an empty/undefined turn-cost list', () => {
    render(
      <SessionDetailDialog
        decisionTree={makeDecisionTree()}
        turnCosts={makeTurnCosts({ turns: [] })}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/no turn-cost data yet/i)).toBeInTheDocument();
  });

  it('calls onClose on Escape', () => {
    const onClose = vi.fn();
    render(
      <SessionDetailDialog
        decisionTree={makeDecisionTree()}
        turnCosts={makeTurnCosts()}
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn();
    render(
      <SessionDetailDialog
        decisionTree={makeDecisionTree()}
        turnCosts={makeTurnCosts()}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /close session detail/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('focuses the close button on mount', () => {
    render(
      <SessionDetailDialog
        decisionTree={makeDecisionTree()}
        turnCosts={makeTurnCosts()}
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /close session detail/i })).toHaveFocus();
  });
});

describe('SessionDetailDialog — context timeline section', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the empty state when contextHistory has fewer than 2 turns', () => {
    render(
      <SessionDetailDialog
        decisionTree={makeDecisionTree()}
        turnCosts={makeTurnCosts()}
        contextHistory={makeContextHistory(1)}
        contextWindow={200_000}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('No context timeline data yet.')).toBeInTheDocument();
  });

  it('shows the empty state when contextHistory is undefined', () => {
    render(
      <SessionDetailDialog
        decisionTree={makeDecisionTree()}
        turnCosts={makeTurnCosts()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('No context timeline data yet.')).toBeInTheDocument();
  });

  it('renders the Context Timeline section label when 2+ turns are present', () => {
    render(
      <SessionDetailDialog
        decisionTree={makeDecisionTree()}
        turnCosts={makeTurnCosts()}
        contextHistory={makeContextHistory(3)}
        contextWindow={200_000}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('Context Timeline')).toBeInTheDocument();
    expect(screen.queryByText('No context timeline data yet.')).toBeNull();
  });
});

describe('SessionDetailDialog — context composition/efficiency section', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the dominant category and repeated-read percentage', () => {
    render(
      <SessionDetailDialog
        decisionTree={makeDecisionTree()}
        turnCosts={makeTurnCosts()}
        contextComposition={makeContextComposition()}
        contextEfficiency={makeContextEfficiency()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('tool_results')).toBeInTheDocument();
    expect(screen.getByText(/40%/)).toBeInTheDocument();
    expect(screen.getByText(/src\/index\.ts/)).toBeInTheDocument();
    expect(screen.getByText(/4x/)).toBeInTheDocument();
  });

  it('shows the empty state when both props are omitted', () => {
    render(
      <SessionDetailDialog
        decisionTree={makeDecisionTree()}
        turnCosts={makeTurnCosts()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('No composition/efficiency data yet.')).toBeInTheDocument();
  });
});

function makeSummary(overrides: Partial<SessionListEntry> = {}): SessionListEntry {
  return {
    sessionId: 'sess-abc',
    sessionName: 'billing-refactor',
    startTime: Date.UTC(2026, 10, 5, 14, 30),
    durationMs: 198_000,
    toolCallCount: 42,
    estimatedCostUsd: 1.37,
    model: 'claude-sonnet-5',
    tokensInput: 120_000,
    tokensOutput: 8_000,
    tokensCacheRead: 900_000,
    antiPatterns: [
      { type: 're_reading', file: 'src/billing.ts', readCount: 5 },
      { type: 'stuck_loop', command: 'npm test -- --token=secret123', iterations: 3 },
    ],
    ...overrides,
  };
}

function installClipboard(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
  return writeText;
}

describe('SessionDetailDialog — copy session', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('copies a Markdown summary of the session', async () => {
    const writeText = installClipboard();
    render(
      <SessionDetailDialog
        decisionTree={makeDecisionTree()}
        turnCosts={makeTurnCosts()}
        summary={makeSummary()}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /copy as markdown/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const text = writeText.mock.calls[0]![0];
    expect(text).toContain('billing-refactor');
    expect(text).toContain('3m 18s');
    expect(text).toContain('$1.37');
    expect(text).toContain('42');
    expect(text).toContain('claude-sonnet-5');
    expect(text).toContain('re_reading');
    expect(text).toContain('stuck_loop');
    expect(text).not.toContain('secret123');
    expect(text).not.toContain('npm test');
  });

  it('copies the session summary as pretty-printed JSON', async () => {
    const writeText = installClipboard();
    const summary = makeSummary();
    render(
      <SessionDetailDialog
        decisionTree={makeDecisionTree()}
        turnCosts={makeTurnCosts()}
        summary={summary}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /copy as json/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const text = writeText.mock.calls[0]![0];
    expect(JSON.parse(text)).toEqual(summary);
    expect(text).toContain('\n  "sessionId"');
  });

  it('shows a Copied state after a successful copy', async () => {
    installClipboard();
    render(
      <SessionDetailDialog
        decisionTree={makeDecisionTree()}
        turnCosts={makeTurnCosts()}
        summary={makeSummary()}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /copy as json/i }));
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('disables both copy buttons when there is no session summary', () => {
    render(
      <SessionDetailDialog
        decisionTree={makeDecisionTree()}
        turnCosts={makeTurnCosts()}
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /copy as markdown/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /copy as json/i })).toBeDisabled();
  });

  it('lists every model from the breakdown in the Markdown copy within fifteen lines', async () => {
    const writeText = installClipboard();
    render(
      <SessionDetailDialog
        decisionTree={makeDecisionTree()}
        turnCosts={makeTurnCosts()}
        summary={makeSummary({
          modelBreakdown: {
            'claude-sonnet-5': { requestCount: 3 },
            'claude-opus-5': { requestCount: 1 },
          },
        })}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /copy as markdown/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const text = writeText.mock.calls[0]![0];
    expect(text).toContain('claude-sonnet-5');
    expect(text).toContain('claude-opus-5');
    expect(text.split('\n').length).toBeLessThan(15);
  });

  async function copyMarkdownOf(summary: SessionListEntry): Promise<string> {
    const writeText = installClipboard();
    render(
      <SessionDetailDialog
        decisionTree={makeDecisionTree()}
        turnCosts={makeTurnCosts()}
        summary={summary}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /copy as markdown/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    return writeText.mock.calls[0]![0];
  }

  it('writes the start time and every token total', async () => {
    const text = await copyMarkdownOf(makeSummary());
    expect(text).toContain('- Started: 2026-11-05T14:30:00.000Z');
    expect(text).toContain('- Tokens: 120.0k in / 8.0k out / 900.0k cache read');
  });

  it('names the breakdown models rather than the single model field', async () => {
    const text = await copyMarkdownOf(
      makeSummary({ modelBreakdown: { 'claude-opus-5': { requestCount: 1 } } }),
    );
    expect(text).toContain('- Models: claude-opus-5');
    expect(text).not.toContain('claude-sonnet-5');
  });

  it('omits the model line when no model is known', async () => {
    const text = await copyMarkdownOf(makeSummary({ model: null }));
    expect(text).not.toContain('- Model');
  });

  it('keeps the tokens line when only the input count is known', async () => {
    const text = await copyMarkdownOf(makeSummary({ tokensOutput: undefined }));
    expect(text).toContain('- Tokens: 120.0k in / 0 out / 900.0k cache read');
  });

  it('lists at most three anti-patterns, with the file path where one is known', async () => {
    const text = await copyMarkdownOf(
      makeSummary({
        antiPatterns: [
          { type: 'thrashing' },
          { type: 're_reading', file: 'a.ts', readCount: 3 },
          { type: 'blind_editing' },
          { type: 'over_delegation' },
        ],
      }),
    );
    expect(text).toContain('- Anti-patterns: thrashing, re_reading (a.ts), blind_editing');
    expect(text).not.toContain('over_delegation');
  });

  it('omits the anti-pattern line when there are none', async () => {
    const text = await copyMarkdownOf(makeSummary({ antiPatterns: [] }));
    expect(text).not.toContain('Anti-patterns');
  });

  it('shows Copy failed when the clipboard refuses the write', async () => {
    const writeText = vi
      .fn<(text: string) => Promise<void>>()
      .mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(
      <SessionDetailDialog
        decisionTree={makeDecisionTree()}
        turnCosts={makeTurnCosts()}
        summary={makeSummary()}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /copy as json/i }));
    expect(await screen.findByText('Copy failed')).toBeInTheDocument();
    expect(screen.queryByText('Copied')).toBeNull();
  });

  it('returns the copy label to idle after 1.5 seconds', async () => {
    installClipboard();
    render(
      <SessionDetailDialog
        decisionTree={makeDecisionTree()}
        turnCosts={makeTurnCosts()}
        summary={makeSummary()}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /copy as json/i }));
    expect(await screen.findByText('Copied')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Copied')).toBeNull(), { timeout: 2500 });
    expect(screen.getByRole('button', { name: /copy as json/i })).toHaveTextContent('Copy as JSON');
  });

  it('changes only the label of the button that was clicked', async () => {
    installClipboard();
    render(
      <SessionDetailDialog
        decisionTree={makeDecisionTree()}
        turnCosts={makeTurnCosts()}
        summary={makeSummary()}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /copy as markdown/i }));
    expect(await screen.findByText('Copied')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copy as json/i })).toHaveTextContent('Copy as JSON');
  });
});

describe('SessionDetailDialog — focus trap with copy buttons disabled', () => {
  function renderWithoutSummary(): HTMLElement {
    render(
      <SessionDetailDialog
        decisionTree={makeDecisionTree()}
        turnCosts={makeTurnCosts()}
        onClose={() => {}}
      />,
    );
    return screen.getByRole('button', { name: /close session detail/i });
  }

  it('wraps Shift+Tab on Close instead of letting focus escape', () => {
    const close = renderWithoutSummary();
    expect(document.activeElement).toBe(close);
    const notPrevented = fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(notPrevented).toBe(false);
    expect(document.activeElement).toBe(close);
  });

  it('wraps Tab on Close back to the first enabled control', () => {
    const close = renderWithoutSummary();
    const notPrevented = fireEvent.keyDown(document, { key: 'Tab' });
    expect(notPrevented).toBe(false);
    expect(document.activeElement).toBe(close);
  });
});
