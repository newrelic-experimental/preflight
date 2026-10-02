import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { SubagentAttributionIndex } from './subagent-attribution.js';
import { MAX_AGENT_TYPE_LENGTH } from '../lib/agent-id.js';
import { AuditTrailManager } from '../security/audit-trail.js';
import type { ToolCallRecord } from '../storage/types.js';

function makeRecord(overrides?: Partial<ToolCallRecord>): ToolCallRecord {
  return {
    id: 'rec-001',
    sessionId: 'sess-001',
    toolName: 'Read',
    toolUseId: 'toolu_001',
    timestamp: 0,
    durationMs: 50,
    success: true,
    ...overrides,
  };
}

function makeAgentCall(spawnedAgentId: string, subagentType: string): ToolCallRecord {
  return makeRecord({
    id: `agent-call-${spawnedAgentId}`,
    toolName: 'Agent',
    toolUseId: `toolu_parent_${spawnedAgentId}`,
    spawnedAgentId,
    subagentType,
  });
}

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

describe('SubagentAttributionIndex', () => {
  it("learns a subagent's type from the parent's Agent tool call", () => {
    const index = new SubagentAttributionIndex();
    index.recordAgentToolCall(makeAgentCall('agent-a', 'Explore'));

    expect(index.agentTypeFor('agent-a')).toBe('Explore');
  });

  it("learns a subagent's type from its own transcript metadata", () => {
    const index = new SubagentAttributionIndex();
    index.recordSubagentType('agent-a', 'Explore');
    index.recordSubagentToolUses('agent-a', ['toolu_sub_1']);

    const result = index.backfill(makeRecord({ toolUseId: 'toolu_sub_1' }));

    expect(result.agentId).toBe('agent-a');
    expect(result.agentType).toBe('Explore');
  });

  it('ignores an absent or empty transcript-metadata type', () => {
    const index = new SubagentAttributionIndex();
    index.recordSubagentType('agent-a', undefined);
    index.recordSubagentType('agent-b', '');

    expect(index.size.subagents).toBe(0);
  });

  it("drops an Agent call's subagentType that is oversized or contains a control character", () => {
    const index = new SubagentAttributionIndex();
    index.recordAgentToolCall(makeAgentCall('agent-long', 'x'.repeat(MAX_AGENT_TYPE_LENGTH + 1)));
    index.recordAgentToolCall(makeAgentCall('agent-ctl', 'Explore\nInjected'));
    index.recordSubagentToolUses('agent-long', ['toolu_long']);

    expect(index.agentTypeFor('agent-long')).toBeUndefined();
    expect(index.agentTypeFor('agent-ctl')).toBeUndefined();
    expect(index.size.subagents).toBe(0);
    expect(index.backfill(makeRecord({ toolUseId: 'toolu_long' })).agentType).toBeUndefined();
  });

  it('ignores non-Agent records and Agent records missing either signal', () => {
    const index = new SubagentAttributionIndex();
    index.recordAgentToolCall(
      makeRecord({ toolName: 'Read', spawnedAgentId: 'agent-a', subagentType: 'Explore' }),
    );
    index.recordAgentToolCall(makeRecord({ toolName: 'Agent', spawnedAgentId: 'agent-b' }));
    index.recordAgentToolCall(makeRecord({ toolName: 'Agent', subagentType: 'Plan' }));

    expect(index.agentTypeFor('agent-a')).toBeUndefined();
    expect(index.agentTypeFor('agent-b')).toBeUndefined();
    expect(index.size).toEqual({ toolUseIds: 0, subagents: 0 });
  });

  it('backfills both agentId (via toolUseId) and agentType (via agentId)', () => {
    const index = new SubagentAttributionIndex();
    index.recordSubagentToolUses('agent-a', ['toolu_sub_1', 'toolu_sub_2']);
    index.recordAgentToolCall(makeAgentCall('agent-a', 'Explore'));

    const result = index.backfill(makeRecord({ toolUseId: 'toolu_sub_2', toolName: 'Bash' }));

    expect(result.agentId).toBe('agent-a');
    expect(result.agentType).toBe('Explore');
  });

  it('backfills agentId alone when the type is not known yet', () => {
    const index = new SubagentAttributionIndex();
    index.recordSubagentToolUses('agent-a', ['toolu_sub_1']);

    const result = index.backfill(makeRecord({ toolUseId: 'toolu_sub_1' }));

    expect(result.agentId).toBe('agent-a');
    expect(result.agentType).toBeUndefined();
  });

  it('backfills agentType onto a record whose agentId was already present', () => {
    const index = new SubagentAttributionIndex();
    index.recordAgentToolCall(makeAgentCall('agent-a', 'Explore'));

    const result = index.backfill(makeRecord({ agentId: 'agent-a' }));

    expect(result.agentType).toBe('Explore');
  });

  it('never overwrites envelope-provided agentId or agentType', () => {
    const index = new SubagentAttributionIndex();
    index.recordSubagentToolUses('agent-a', ['toolu_sub_1']);
    index.recordAgentToolCall(makeAgentCall('agent-a', 'Explore'));
    index.recordAgentToolCall(makeAgentCall('agent-env', 'Plan'));
    const record = makeRecord({
      toolUseId: 'toolu_sub_1',
      agentId: 'agent-env',
      agentType: 'envelope-type',
    });

    expect(index.backfill(record)).toBe(record);
  });

  it("keeps an envelope agentType (the session's --agent name) when the join resolves an agentId", () => {
    const index = new SubagentAttributionIndex();
    // The record's own toolUseId is in the join, so backfillAgentType sees an
    // agentId with a known indexed type and only its no-overwrite guard keeps
    // the envelope value.
    index.recordSubagentToolUses('agent-a', ['toolu_parent_1']);
    index.recordAgentToolCall(makeAgentCall('agent-a', 'Explore'));
    const record = makeRecord({ toolUseId: 'toolu_parent_1', agentType: 'claude' });

    const result = index.backfill(record);

    expect(result.agentId).toBe('agent-a');
    expect(result.agentType).toBe('claude');
  });

  it("prefers the transcript-metadata type over the parent's Agent call, in either order", () => {
    const index = new SubagentAttributionIndex();
    index.recordSubagentType('agent-sidecar-first', 'Explore');
    index.recordAgentToolCall(makeAgentCall('agent-sidecar-first', 'general-purpose'));
    index.recordAgentToolCall(makeAgentCall('agent-call-first', 'general-purpose'));
    index.recordSubagentType('agent-call-first', 'Explore');

    expect(index.agentTypeFor('agent-sidecar-first')).toBe('Explore');
    expect(index.agentTypeFor('agent-call-first')).toBe('Explore');
  });

  it('returns the same record reference when nothing applies', () => {
    const index = new SubagentAttributionIndex();
    const record = makeRecord();
    expect(index.backfill(record)).toBe(record);
  });

  it('caps the toolUseId index at maxToolUseIds, evicting the oldest', () => {
    const index = new SubagentAttributionIndex({ maxToolUseIds: 3 });
    index.recordSubagentToolUses('agent-a', ['t1', 't2', 't3', 't4']);

    expect(index.size.toolUseIds).toBe(3);
    expect(index.backfill(makeRecord({ toolUseId: 't1' })).agentId).toBeUndefined();
    expect(index.backfill(makeRecord({ toolUseId: 't4' })).agentId).toBe('agent-a');
  });

  it('caps the subagent-type index at maxSubagents, evicting the oldest', () => {
    const index = new SubagentAttributionIndex({ maxSubagents: 2 });
    index.recordAgentToolCall(makeAgentCall('a1', 'Explore'));
    index.recordAgentToolCall(makeAgentCall('a2', 'Plan'));
    index.recordAgentToolCall(makeAgentCall('a3', 'general-purpose'));

    expect(index.size.subagents).toBe(2);
    expect(index.agentTypeFor('a1')).toBeUndefined();
    expect(index.agentTypeFor('a3')).toBe('general-purpose');
  });

  it('expires entries not used within ttlMs', () => {
    let now = 0;
    const index = new SubagentAttributionIndex({ ttlMs: 1000, now: () => now });
    index.recordSubagentToolUses('agent-a', ['t1']);
    index.recordAgentToolCall(makeAgentCall('agent-a', 'Explore'));
    now = 1001;

    expect(index.backfill(makeRecord({ toolUseId: 't1' })).agentId).toBeUndefined();
    expect(index.agentTypeFor('agent-a')).toBeUndefined();
  });

  it('stays bounded across a long-running daemon workload', () => {
    const index = new SubagentAttributionIndex({ maxToolUseIds: 500, maxSubagents: 50 });
    for (let agent = 0; agent < 1000; agent++) {
      const agentId = `agent-${agent}`;
      index.recordSubagentToolUses(
        agentId,
        Array.from({ length: 20 }, (_, i) => `toolu_${agent}_${i}`),
      );
      index.recordAgentToolCall(makeAgentCall(agentId, 'Explore'));
    }

    expect(index.size).toEqual({ toolUseIds: 500, subagents: 50 });
  });
});

describe('SubagentAttributionIndex -> AuditTrailManager', () => {
  it('attributes an audit record to the subagent type once both joins are known', () => {
    const index = new SubagentAttributionIndex();
    index.recordAgentToolCall(makeAgentCall('agent-a', 'Explore'));
    index.recordSubagentToolUses('agent-a', ['toolu_sub_1']);
    const audit = new AuditTrailManager({ developer: 'alice', sessionId: 'sess-001' });

    const auditRecord = audit.recordToolCall(
      index.backfill(
        makeRecord({ toolName: 'Read', toolUseId: 'toolu_sub_1', filePath: '/repo/.env' }),
      ),
    );

    expect(auditRecord.agentId).toBe('agent-a');
    expect(auditRecord.agentType).toBe('Explore');
  });
});
