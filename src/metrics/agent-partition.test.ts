import { describe, it, expect } from '@jest/globals';
import { partitionByAgent, backfillAgentId } from './agent-partition.js';
import type { ToolCallRecord } from '../storage/types.js';

function makeRecord(overrides?: Partial<ToolCallRecord>): ToolCallRecord {
  return {
    id: 'rec-001',
    sessionId: 'sess-001',
    toolName: 'Read',
    toolUseId: 'toolu_001',
    timestamp: Date.now(),
    durationMs: 50,
    success: true,
    ...overrides,
  };
}

describe('partitionByAgent', () => {
  it('returns a single group when no agentId is present', () => {
    const calls = [makeRecord({ id: '1' }), makeRecord({ id: '2' })];
    expect(partitionByAgent(calls)).toEqual([calls]);
  });

  it('splits parent and subagent calls into separate groups, preserving relative order', () => {
    const parentA = makeRecord({ id: 'p1' });
    const agentA1 = makeRecord({ id: 'a1', agentId: 'agent-a' });
    const parentB = makeRecord({ id: 'p2' });
    const agentA2 = makeRecord({ id: 'a2', agentId: 'agent-a' });
    const agentB1 = makeRecord({ id: 'b1', agentId: 'agent-b' });

    const groups = partitionByAgent([parentA, agentA1, parentB, agentA2, agentB1]);

    expect(groups).toHaveLength(3);
    expect(groups[0]).toEqual([parentA, parentB]);
    expect(groups[1]).toEqual([agentA1, agentA2]);
    expect(groups[2]).toEqual([agentB1]);
  });

  it('returns an empty array for an empty input', () => {
    expect(partitionByAgent([])).toEqual([]);
  });
});

describe('backfillAgentId', () => {
  it('backfills agentId from the toolUseId map when the record has none', () => {
    const record = makeRecord({ toolUseId: 'toolu_abc', agentId: undefined });
    const map = new Map([['toolu_abc', 'a1234567890abcdef']]);

    const result = backfillAgentId(record, map);

    expect(result.agentId).toBe('a1234567890abcdef');
  });

  it('leaves an already-attributed record unchanged', () => {
    const record = makeRecord({ toolUseId: 'toolu_abc', agentId: 'existing-agent' });
    const map = new Map([['toolu_abc', 'a1234567890abcdef']]);

    const result = backfillAgentId(record, map);

    expect(result).toBe(record);
  });

  it('leaves the record unchanged when the toolUseId has no map entry', () => {
    const record = makeRecord({ toolUseId: 'toolu_unknown', agentId: undefined });
    const map = new Map([['toolu_abc', 'a1234567890abcdef']]);

    const result = backfillAgentId(record, map);

    expect(result).toBe(record);
  });

  it('leaves the record unchanged when it has no toolUseId', () => {
    const record = makeRecord({ toolUseId: undefined, agentId: undefined });
    const map = new Map([['toolu_abc', 'a1234567890abcdef']]);

    const result = backfillAgentId(record, map);

    expect(result).toBe(record);
  });
});
