import { groupAgents, GROUP_BAR_COLORS, subagentGroupId, fmtTickLabel } from './agent-groups.js';
import type { AgentSpan } from '../api/client.js';

function makeAgent(overrides: Partial<AgentSpan> = {}): AgentSpan {
  return {
    agentId: 'a1',
    workflowRunId: null,
    workflowName: null,
    label: 'agent 1',
    model: 'claude-sonnet-5',
    startMs: 1_000,
    endMs: 2_000,
    durationMs: 1_000,
    turnCount: 1,
    totalTokens: 100,
    usd: null,
    ...overrides,
  };
}

describe('groupAgents', () => {
  it('buckets agents by workflowRunId and sorts groups by earliest start', () => {
    const agents = [
      makeAgent({ agentId: 'a1', workflowRunId: 'run-2', startMs: 5_000 }),
      makeAgent({ agentId: 'a2', workflowRunId: 'run-1', startMs: 1_000 }),
      makeAgent({ agentId: 'a3', workflowRunId: null, startMs: 3_000 }),
    ];
    const groups = groupAgents(agents);
    expect(groups.map((g) => g.runId)).toEqual(['run-1', null, 'run-2']);
  });

  it('names the null-runId group "Ad-hoc subagents"', () => {
    const groups = groupAgents([makeAgent({ workflowRunId: null })]);
    expect(groups[0]!.name).toBe('Ad-hoc subagents');
  });
});

describe('subagentGroupId', () => {
  it('returns a stable ad-hoc token for null and a run-prefixed id otherwise', () => {
    expect(subagentGroupId(null)).toBe('__adhoc__');
    expect(subagentGroupId('run-1')).toBe('run:run-1');
  });
});

describe('fmtTickLabel', () => {
  it('formats milliseconds as mm:ss', () => {
    expect(fmtTickLabel(65_000)).toBe('1:05');
  });
});

describe('GROUP_BAR_COLORS', () => {
  it('has 6 stable color tokens', () => {
    expect(GROUP_BAR_COLORS).toHaveLength(6);
  });
});
