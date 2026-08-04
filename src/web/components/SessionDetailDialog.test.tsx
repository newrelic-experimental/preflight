import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SessionDetailDialog } from './SessionDetailDialog';
import type { DecisionTreeResponse, TurnCostsResponse, ContextResponse } from '../api/client';

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
