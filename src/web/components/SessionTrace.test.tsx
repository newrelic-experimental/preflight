/**
 * @jest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionTrace, type SessionTraceProps } from './SessionTrace';

// Minimal valid props for a trace with one ad-hoc subagent group, so
// CollapsedGroupBar and GroupHeader both render.
function baseProps(overrides: Partial<SessionTraceProps> = {}): SessionTraceProps {
  return {
    sessionId: 'sess-1',
    parentEntries: [],
    agents: [
      {
        agentId: 'a1111111111111111',
        // Non-null workflowRunId + onSelectRun is what makes GanttView pass an
        // onOpenRun callback down into GroupHeader/CollapsedGroupBar — that's
        // the branch that renders the nested role="button" label span. A null
        // workflowRunId (ad-hoc group) renders a plain, non-interactive label
        // and would make this test trivially pass with zero nested buttons.
        workflowRunId: 'run-1',
        workflowName: 'Reviewer workflow',
        label: 'reviewer',
        model: 'claude-opus-4-7',
        startMs: 0,
        endMs: 1000,
        durationMs: 1000,
        turnCount: 3,
        totalTokens: 500,
        usd: 0.05,
      },
    ],
    window: { startMs: 0, endMs: 1000 },
    runStatusById: {},
    parentSegments: [],
    onSelectRun: vi.fn(),
    ...overrides,
  };
}

describe('SessionTrace group controls', () => {
  it('never nests an interactive role="button" element inside a literal <button>', () => {
    const { container } = render(<SessionTrace {...baseProps()} />);
    const buttons = container.querySelectorAll('button');
    for (const btn of buttons) {
      const nestedInteractive = btn.querySelector('[role="button"], button, a[href]');
      expect(nestedInteractive).toBeNull();
    }
  });
});

describe('SessionTrace three-level expand preset', () => {
  it('the "Agents" preset collapses the parent lane, expands the subagent group, and drills into no agent calls', async () => {
    const user = userEvent.setup();
    render(
      <SessionTrace
        {...baseProps({
          parentEntries: [{ timestamp: 0, toolName: 'Read', durationMs: 100, success: true }],
        })}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Agents' }));

    // Parent lane: shut (collapsedGroups contains PARENT_GROUP_ID).
    const parentHeader = screen.getByText('Parent').closest('div');
    expect(parentHeader?.querySelector('button[aria-expanded]')).toHaveAttribute(
      'aria-expanded',
      'false',
    );

    // Subagent group: open (not in collapsedGroups).
    const groupHeader = screen.getByText('Reviewer workflow').closest('div');
    expect(groupHeader?.querySelector('button[aria-expanded]')).toHaveAttribute(
      'aria-expanded',
      'true',
    );

    // No per-agent calls drilled in: the agent's own disclosure stays collapsed
    // and its lazy AgentCallsGantt query never mounts.
    expect(screen.getByRole('button', { name: 'Expand calls for reviewer' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.queryByText(/loading calls|no calls recorded/i)).not.toBeInTheDocument();
  });
});
