import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentSwimlanes, type AgentSpan } from './AgentSwimlanes';

function makeAgent(overrides: Partial<AgentSpan> = {}): AgentSpan {
  return {
    agentId: 'a-1',
    workflowRunId: 'run-1',
    workflowName: 'Big run',
    label: 'agent',
    model: 'claude-sonnet',
    startMs: 0,
    endMs: 1000,
    durationMs: 1000,
    turnCount: 1,
    totalTokens: 100,
    usd: 0.01,
    ...overrides,
  };
}

describe('AgentSwimlanes', () => {
  it('starts a group with more than 15 agents collapsed', () => {
    const agents: AgentSpan[] = Array.from({ length: 16 }, (_, i) =>
      makeAgent({ agentId: `a-${i}`, label: `agent-${i}`, startMs: i * 100, endMs: i * 100 + 50 }),
    );
    render(<AgentSwimlanes agents={agents} window={{ startMs: 0, endMs: 2000 }} />);
    const groupHeader = screen.getByText('Big run').closest('button');
    expect(groupHeader).not.toBeNull();
    expect(groupHeader!.getAttribute('aria-expanded')).toBe('false');
  });

  it('leaves a group with 15 or fewer agents expanded by default', () => {
    const agents: AgentSpan[] = Array.from({ length: 15 }, (_, i) =>
      makeAgent({ agentId: `a-${i}`, label: `agent-${i}`, startMs: i * 100, endMs: i * 100 + 50 }),
    );
    render(<AgentSwimlanes agents={agents} window={{ startMs: 0, endMs: 2000 }} />);
    const groupHeader = screen.getByText('Big run').closest('button');
    expect(groupHeader!.getAttribute('aria-expanded')).toBe('true');
  });

  it('shows the empty-state message only when there are no agents and no parent lane', () => {
    render(<AgentSwimlanes agents={[]} window={{ startMs: 0, endMs: 1000 }} />);
    expect(screen.getByText('No subagents ran in this session.')).toBeInTheDocument();
  });

  it('does not show the empty-state message when a parent lane is supplied, even with zero agents', () => {
    render(<AgentSwimlanes agents={[]} window={{ startMs: 0, endMs: 1000 }} parentEntries={[]} />);
    expect(screen.queryByText('No subagents ran in this session.')).not.toBeInTheDocument();
    expect(screen.getByText('Parent activity')).toBeInTheDocument();
  });
});
