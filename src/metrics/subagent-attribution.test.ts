import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SubagentAttributionIndex,
  type LiveSubagentTranscriptReader,
} from './subagent-attribution.js';
import { HookEventProcessor, type SubagentTurnEvent } from '../hooks/event-processor.js';
import { SubagentWatcher } from '../hooks/subagent-watcher.js';
import { MAX_AGENT_TYPE_LENGTH } from '../lib/agent-id.js';
import { AuditTrailManager, type AuditRecord } from '../security/audit-trail.js';
import { LocalStore } from '../storage/local-store.js';
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

  it("leaves a parent call's envelope agentType (the session's --agent name) untouched", () => {
    const index = new SubagentAttributionIndex();
    index.recordSubagentToolUses('agent-a', ['toolu_sub_1']);
    index.recordAgentToolCall(makeAgentCall('agent-a', 'Explore'));
    const record = makeRecord({ toolUseId: 'toolu_parent_1', agentType: 'claude' });

    const result = index.backfill(record);

    expect(result).toBe(record);
    expect(result.agentId).toBeUndefined();
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

describe('SubagentAttributionIndex.attributeAtIntake', () => {
  /** A reader standing in for SubagentWatcher: reading feeds the turn back into the index. */
  function makeReader(
    index: SubagentAttributionIndex,
    turn?: { agentId: string; toolUseIds: string[]; agentType?: string },
  ): LiveSubagentTranscriptReader & { calls: Array<string | undefined> } {
    const calls: Array<string | undefined> = [];
    return {
      calls,
      readLiveTails(sessionId) {
        calls.push(sessionId);
        if (!turn) return 0;
        index.recordSubagentTurn(turn);
        return 1;
      },
    };
  }

  it('reads live subagent transcripts when the backfill finds no agentId, then backfills again', () => {
    const index = new SubagentAttributionIndex();
    const reader = makeReader(index, {
      agentId: 'agent-a',
      toolUseIds: ['toolu_sub_1'],
      agentType: 'Explore',
    });

    const result = index.attributeAtIntake(makeRecord({ toolUseId: 'toolu_sub_1' }), reader);

    expect(reader.calls).toEqual(['sess-001']);
    expect(result.agentId).toBe('agent-a');
    expect(result.agentType).toBe('Explore');
  });

  it('does not read when the envelope or the existing join already gives the agentId', () => {
    const index = new SubagentAttributionIndex();
    index.recordSubagentToolUses('agent-a', ['toolu_sub_1']);
    const reader = makeReader(index);

    index.attributeAtIntake(makeRecord({ toolUseId: 'toolu_sub_1' }), reader);
    index.attributeAtIntake(makeRecord({ toolUseId: 'toolu_x', agentId: 'agent-env' }), reader);

    expect(reader.calls).toEqual([]);
  });

  it('reads for every record the backfill leaves without an agentId, whatever its toolUseId', () => {
    // HookEventProcessor gives every record a toolUseId, falling back to a
    // synthetic pairing key when the hook pair carried none, so the read has
    // no toolUseId condition: a record without one is never produced.
    const index = new SubagentAttributionIndex();
    const reader = makeReader(index);

    index.attributeAtIntake(makeRecord({ toolUseId: 'Read:1000:synthetic-pairing-key' }), reader);
    index.attributeAtIntake(makeRecord({ toolUseId: undefined }), reader);

    expect(reader.calls).toEqual(['sess-001', 'sess-001']);
  });

  it('returns the plain backfill, unattributed, when the read finds nothing or no reader exists', () => {
    const index = new SubagentAttributionIndex();
    const record = makeRecord({ toolUseId: 'toolu_parent_1' });

    expect(index.attributeAtIntake(record, makeReader(index))).toBe(record);
    expect(index.attributeAtIntake(record, null)).toBe(record);
  });

  it('falls back to the plain backfill when the read throws', () => {
    const index = new SubagentAttributionIndex();
    const record = makeRecord({ toolUseId: 'toolu_sub_1' });
    const reader: LiveSubagentTranscriptReader = {
      readLiveTails: () => {
        throw new Error('EIO');
      },
    };

    expect(index.attributeAtIntake(record, reader)).toBe(record);
  });

  it('learns the subagent type from an envelope that carries both agent_id and agent_type', () => {
    const index = new SubagentAttributionIndex();

    index.attributeAtIntake(makeRecord({ agentId: 'agent-a', agentType: 'Explore' }), null);

    expect(index.agentTypeFor('agent-a')).toBe('Explore');
  });

  it("does not learn a type from a parent call's --agent envelope, which has no agent_id", () => {
    const index = new SubagentAttributionIndex();

    index.attributeAtIntake(makeRecord({ agentType: 'claude' }), null);

    expect(index.size.subagents).toBe(0);
  });
});

/**
 * The production order from #681's review: a subagent's fast tool call
 * reaches hook intake before any watcher poll has read its tool_use line,
 * on an install whose hook payload sends neither agent_id nor agent_type.
 * Wired as src/index.ts wires it: the watcher feeds the index from every line
 * it reads, and onRecord attributes each record before the audit trail sees it.
 */
describe('record-first intake: hook record before the watcher has polled its tool_use line', () => {
  const PARENT_SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const AGENT_ID = 'a1234567890abcdef';
  let storagePath: string;
  let projectsDir: string;
  let transcriptPath: string;

  beforeEach(() => {
    storagePath = mkdtempSync(join(tmpdir(), 'subagent-intake-store-'));
    projectsDir = mkdtempSync(join(tmpdir(), 'subagent-intake-projects-'));
    const subagentsDir = join(projectsDir, 'project-slug', PARENT_SESSION, 'subagents');
    mkdirSync(subagentsDir, { recursive: true });
    transcriptPath = join(subagentsDir, `agent-${AGENT_ID}.jsonl`);
    // Written at spawn: the meta sidecar and the prompt line.
    writeFileSync(join(subagentsDir, `agent-${AGENT_ID}.meta.json`), '{"agentType":"Explore"}');
    writeFileSync(
      transcriptPath,
      JSON.stringify({
        type: 'user',
        isSidechain: true,
        sessionId: PARENT_SESSION,
        message: { role: 'user', content: 'Check the env file' },
      }) + '\n',
    );
  });

  afterEach(() => {
    rmSync(storagePath, { recursive: true, force: true });
    rmSync(projectsDir, { recursive: true, force: true });
  });

  function assistantLine(messageId: string, block: Record<string, unknown>): string {
    return JSON.stringify({
      type: 'assistant',
      isSidechain: true,
      sessionId: PARENT_SESSION,
      uuid: `uuid-${messageId}-${String(block.type)}`,
      timestamp: '2026-10-05T12:00:00.000Z',
      message: {
        id: messageId,
        role: 'assistant',
        model: 'claude-opus-4-7',
        content: [block],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });
  }

  function readEnvLine(messageId: string, toolUseId: string): string {
    return assistantLine(messageId, {
      type: 'tool_use',
      id: toolUseId,
      name: 'Read',
      input: { file_path: '/repo/.env' },
    });
  }

  /** The collector's pre/post lines for a subagent Read, with no agent fields. */
  function appendHookPair(toolUseId: string): void {
    const base = { tool: 'Read', toolUseId, sessionId: PARENT_SESSION };
    appendFileSync(
      join(storagePath, `buffer-${PARENT_SESSION}.jsonl`),
      JSON.stringify({
        ...base,
        mode: 'pre',
        timestamp: 1000,
        toolInput: { file_path: '/repo/.env' },
      }) +
        '\n' +
        JSON.stringify({ ...base, mode: 'post', timestamp: 1050, success: true }) +
        '\n',
    );
  }

  function wire(): {
    watcher: SubagentWatcher;
    drain: () => void;
    audits: AuditRecord[];
    turns: SubagentTurnEvent[];
  } {
    const index = new SubagentAttributionIndex();
    const audit = new AuditTrailManager({ developer: 'alice', sessionId: PARENT_SESSION });
    const audits: AuditRecord[] = [];
    const turns: SubagentTurnEvent[] = [];
    const watcher = new SubagentWatcher({
      storagePath,
      projectsDir,
      parentSessionId: PARENT_SESSION,
      onTurnRead: (turn) => index.recordSubagentTurn(turn),
    });
    const store = new LocalStore(storagePath, PARENT_SESSION);
    store.initialize();
    const processor = new HookEventProcessor({
      store,
      onRecord: (record) =>
        audits.push(audit.recordToolCall(index.attributeAtIntake(record, watcher))),
      onSubagentTurn: (turn) => {
        index.recordSubagentTurn(turn);
        turns.push(turn);
      },
    });
    return { watcher, drain: () => processor.processEvents(store.drainBuffer()), audits, turns };
  }

  it('attributes the audit record by reading the transcript on demand', () => {
    const { watcher, drain, audits, turns } = wire();
    watcher.poll(); // the poll after spawn: only the prompt is on disk yet
    appendFileSync(transcriptPath, readEnvLine('msg_1', 'toolu_sub_1') + '\n');
    appendHookPair('toolu_sub_1');

    drain();

    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ agentId: AGENT_ID, agentType: 'Explore' });
    expect(audits[0]?.securityAlert).toBeDefined();
    // The turn the on-demand read found reaches cost tracking once, through
    // the buffer like any polled turn, and the next poll does not repeat it.
    expect(turns).toHaveLength(0);
    drain();
    watcher.poll();
    drain();
    expect(turns.map((t) => t.messageId)).toEqual(['msg_1']);
  });

  it('attributes a call whose tool_use block is on a later line of an already-counted message', () => {
    const { watcher, drain, audits, turns } = wire();
    appendFileSync(
      transcriptPath,
      assistantLine('msg_1', { type: 'thinking', thinking: '' }) +
        '\n' +
        readEnvLine('msg_1', 'toolu_sub_1') +
        '\n',
    );
    watcher.poll();
    drain(); // the turn, deduped by message id for cost
    appendHookPair('toolu_sub_1');

    drain();

    expect(turns).toHaveLength(1);
    expect(audits[0]).toMatchObject({ agentId: AGENT_ID, agentType: 'Explore' });
  });

  it('audits a parent call unattributed, without reading, when no subagent transcript has changed', () => {
    const { watcher, drain, audits } = wire();
    watcher.poll();
    appendHookPair('toolu_parent_1');

    drain();

    expect(audits).toHaveLength(1);
    expect(audits[0]?.agentId).toBeUndefined();
    expect(audits[0]?.agentType).toBeUndefined();
  });
});
