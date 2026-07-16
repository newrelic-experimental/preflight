/**
 * @jest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentTable, type AgentRow } from './AgentTable';

function makeAgent(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    agentId: 'a1111111111111111',
    label: 'reviewer',
    phaseIndex: 0,
    phaseTitle: 'Review',
    model: 'claude-opus-4-7',
    state: 'done',
    attempt: 1,
    durationMs: 1000,
    tokens: 500,
    toolCalls: 3,
    startedAt: 0,
    ...overrides,
  };
}

describe('AgentTable sortable headers', () => {
  it('exposes aria-sort on the active column header', () => {
    render(
      <AgentTable
        agents={[
          makeAgent({ agentId: 'a1', tokens: 100 }),
          makeAgent({ agentId: 'a2', tokens: 200 }),
        ]}
      />,
    );
    // Default sort is tokens/desc per AgentTable's initial state.
    const tokensHeader = screen.getByRole('columnheader', { name: /tokens/i });
    expect(tokensHeader).toHaveAttribute('aria-sort', 'descending');
  });

  it('sorts by a column when its header button receives a keyboard activation', async () => {
    const user = userEvent.setup();
    render(
      <AgentTable
        agents={[
          makeAgent({ agentId: 'a1', label: 'bravo', tokens: 100 }),
          makeAgent({ agentId: 'a2', label: 'alpha', tokens: 200 }),
        ]}
      />,
    );
    const agentButton = screen.getByRole('button', { name: 'Agent' });
    agentButton.focus();
    await user.keyboard('{Enter}');

    const agentHeader = screen.getByRole('columnheader', { name: 'Agent' });
    expect(agentHeader).toHaveAttribute('aria-sort', 'descending');
  });
});
