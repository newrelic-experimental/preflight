import { describe, it, expect } from '@jest/globals';
import { partitionByAgent, backfillAgentId, backfillAgentType } from './agent-partition.js';
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

describe('backfillAgentType', () => {
  it('backfills agentType from the agentId map when the record has an id but no type', () => {
    const record = makeRecord({ agentId: 'a1234567890abcdef', agentType: undefined });
    const map = new Map([['a1234567890abcdef', 'Explore']]);

    const result = backfillAgentType(record, map);

    expect(result.agentType).toBe('Explore');
    expect(result.agentId).toBe('a1234567890abcdef');
  });

  it('carries type from the same agentId after a toolUseId join', () => {
    const record = makeRecord({ toolUseId: 'toolu_abc', agentId: undefined, agentType: undefined });
    const idMap = new Map([['toolu_abc', 'a1234567890abcdef']]);
    const typeMap = new Map([['a1234567890abcdef', 'Explore']]);

    const result = backfillAgentType(backfillAgentId(record, idMap), typeMap);

    expect(result.agentId).toBe('a1234567890abcdef');
    expect(result.agentType).toBe('Explore');
  });

  it('leaves agentType undefined when agentId backfills but the type map has no entry', () => {
    const record = makeRecord({ toolUseId: 'toolu_abc', agentId: undefined, agentType: undefined });
    const withId = backfillAgentId(record, new Map([['toolu_abc', 'a1234567890abcdef']]));

    const result = backfillAgentType(withId, new Map());

    expect(result).toBe(withId);
    expect(result.agentId).toBe('a1234567890abcdef');
    expect(result.agentType).toBeUndefined();
  });

  it('leaves an already-typed record unchanged even when the map disagrees', () => {
    const record = makeRecord({ agentId: 'a1234567890abcdef', agentType: 'Plan' });
    const map = new Map([['a1234567890abcdef', 'Explore']]);

    const result = backfillAgentType(record, map);

    expect(result).toBe(record);
    expect(result.agentType).toBe('Plan');
  });

  it('leaves the record unchanged when it has no agentId', () => {
    const record = makeRecord({ agentId: undefined, agentType: undefined });
    const map = new Map([['a1234567890abcdef', 'Explore']]);

    const result = backfillAgentType(record, map);

    expect(result).toBe(record);
    expect(result.agentType).toBeUndefined();
  });

  it('leaves the record unchanged when agentId has no map entry', () => {
    const record = makeRecord({ agentId: 'unknown-agent', agentType: undefined });
    const map = new Map([['a1234567890abcdef', 'Explore']]);

    const result = backfillAgentType(record, map);

    expect(result).toBe(record);
    expect(result.agentType).toBeUndefined();
  });
});
