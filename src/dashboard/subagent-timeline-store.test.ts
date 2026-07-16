import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SubagentTimelineStore } from './subagent-timeline-store.js';

const STDERR_WRITE = process.stderr.write;
const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SLUG = 'project-slug';

// Agent ids are `a` + 16 hex chars (matches the watcher's AGENT_ID_RE).
const AGENT_A = 'a1111111111111111';
const AGENT_B = 'a2222222222222222';
const WF_AGENT = 'a45d96d201bf2f1ef';
const WF_RUN_ID = 'wf_abc12345-6dd';

const KNOWN_MODEL = 'claude-opus-4-7';
const UNKNOWN_MODEL = 'totally-made-up-model-9000';

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), 'subagent-timeline-test-'));
}

/** Build a single assistant-turn JSONL line. */
function assistantLine(opts: {
  timestamp: string;
  model?: string;
  input?: number;
  output?: number;
  cacheCreation?: number;
  cacheRead?: number;
}): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: opts.timestamp,
    uuid: 'u-' + opts.timestamp,
    message: {
      id: 'msg-' + opts.timestamp,
      model: opts.model ?? KNOWN_MODEL,
      stop_reason: 'end_turn',
      usage: {
        input_tokens: opts.input ?? 0,
        output_tokens: opts.output ?? 0,
        cache_creation_input_tokens: opts.cacheCreation ?? 0,
        cache_read_input_tokens: opts.cacheRead ?? 0,
      },
    },
  });
}

describe('SubagentTimelineStore', () => {
  let projectsDir: string;
  let subDir: string;

  beforeEach(() => {
    process.stderr.write = jest.fn(() => true) as unknown as typeof process.stderr.write;
    projectsDir = mkTmp();
    subDir = join(projectsDir, SLUG, SESSION, 'subagents');
    mkdirSync(subDir, { recursive: true });
  });

  afterEach(() => {
    process.stderr.write = STDERR_WRITE;
    rmSync(projectsDir, { recursive: true, force: true });
  });

  it('computes an ad-hoc agent span (start/end/turnCount/tokens) with usd', () => {
    writeFileSync(
      join(subDir, `agent-${AGENT_A}.jsonl`),
      [
        assistantLine({ timestamp: '2026-06-16T12:00:00.000Z', input: 100, output: 50 }),
        assistantLine({ timestamp: '2026-06-16T12:00:10.000Z', input: 200, output: 80 }),
      ].join('\n') + '\n',
    );

    const store = new SubagentTimelineStore({ projectsDir });
    const result = store.getSubagentsForSession(SESSION);

    expect(result.agents).toHaveLength(1);
    const agent = result.agents[0]!;
    expect(agent.agentId).toBe(AGENT_A);
    expect(agent.workflowRunId).toBeNull();
    expect(agent.workflowName).toBeNull();
    expect(agent.label).toBe(`agent ${AGENT_A.slice(0, 8)}`);
    expect(agent.model).toBe(KNOWN_MODEL);
    expect(agent.startMs).toBe(Date.parse('2026-06-16T12:00:00.000Z'));
    expect(agent.endMs).toBe(Date.parse('2026-06-16T12:00:10.000Z'));
    expect(agent.durationMs).toBe(10_000);
    expect(agent.turnCount).toBe(2);
    expect(agent.totalTokens).toBe(100 + 50 + 200 + 80);
    // Known model → usd computed and positive.
    expect(agent.usd).not.toBeNull();
    expect(agent.usd!).toBeGreaterThan(0);
    // Window spans all agents.
    expect(result.window.startMs).toBe(agent.startMs);
    expect(result.window.endMs).toBe(agent.endMs);
  });

  it('dedups streaming-duplicate lines sharing one message.id (counts the turn once)', () => {
    // Claude Code logs one JSONL line per streaming snapshot of a single
    // assistant turn — same message.id, byte-identical per-prompt usage
    // (cache_read in particular). Summing every line multiplied tokens/usd ~2x.
    const dup = (output: number) =>
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-06-16T12:00:00.000Z',
        uuid: 'u-dup',
        message: {
          id: 'msg_streaming_one',
          model: KNOWN_MODEL,
          usage: {
            input_tokens: 100,
            output_tokens: output,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 100_000, // identical across snapshots
          },
        },
      });
    writeFileSync(
      join(subDir, `agent-${AGENT_A}.jsonl`),
      // 4 partial snapshots (output_tokens grows) + 1 final — all one message.id
      [dup(1), dup(1), dup(1), dup(1), dup(500)].join('\n') + '\n',
    );

    const store = new SubagentTimelineStore({ projectsDir });
    const result = store.getSubagentsForSession(SESSION);

    expect(result.agents).toHaveLength(1);
    const agent = result.agents[0]!;
    // One logical turn, not five.
    expect(agent.turnCount).toBe(1);
    // First-occurrence tokens (matches the cost path's keep-first dedup):
    // input 100 + output 1 + cache_read 100_000 — NOT summed across snapshots.
    expect(agent.totalTokens).toBe(100 + 1 + 100_000);
  });

  it('skips assistant lines without a message.id (matches the CostTracker feed)', () => {
    const noId = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-06-16T12:00:00.000Z',
      message: { model: KNOWN_MODEL, usage: { input_tokens: 10, output_tokens: 5 } },
    });
    writeFileSync(
      join(subDir, `agent-${AGENT_A}.jsonl`),
      [noId, assistantLine({ timestamp: '2026-06-16T12:00:10.000Z', input: 7, output: 3 })].join(
        '\n',
      ) + '\n',
    );

    const store = new SubagentTimelineStore({ projectsDir });
    const result = store.getSubagentsForSession(SESSION);

    expect(result.agents).toHaveLength(1);
    // Only the line carrying a message.id is counted.
    expect(result.agents[0]!.turnCount).toBe(1);
    expect(result.agents[0]!.totalTokens).toBe(7 + 3);
  });

  it('resolves workflowRunId from the path for workflow-spawned agents', () => {
    const wfRunDir = join(subDir, 'workflows', WF_RUN_ID);
    mkdirSync(wfRunDir, { recursive: true });
    writeFileSync(
      join(wfRunDir, `agent-${WF_AGENT}.jsonl`),
      assistantLine({ timestamp: '2026-06-16T12:05:00.000Z', input: 10, output: 5 }) + '\n',
    );

    const store = new SubagentTimelineStore({ projectsDir });
    const result = store.getSubagentsForSession(SESSION);

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]!.agentId).toBe(WF_AGENT);
    expect(result.agents[0]!.workflowRunId).toBe(WF_RUN_ID);
  });

  it('resolves workflowName + label from the workflow rollup (injected store)', () => {
    const wfRunDir = join(subDir, 'workflows', WF_RUN_ID);
    mkdirSync(wfRunDir, { recursive: true });
    writeFileSync(
      join(wfRunDir, `agent-${WF_AGENT}.jsonl`),
      assistantLine({ timestamp: '2026-06-16T12:05:00.000Z', input: 10, output: 5 }) + '\n',
    );

    const workflowStore = {
      getRun: (runId: string) => {
        expect(runId).toBe(WF_RUN_ID);
        return {
          workflow_name: 'investigate-and-fix',
          agents: [{ agent_id: WF_AGENT, label: 'investigate:hooks-coverage' }],
        };
      },
    };

    const store = new SubagentTimelineStore({ projectsDir, workflowStore });
    const result = store.getSubagentsForSession(SESSION);

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]!.workflowName).toBe('investigate-and-fix');
    expect(result.agents[0]!.label).toBe('investigate:hooks-coverage');
  });

  it('falls back to `agent <id8>` when the workflow rollup has no label', () => {
    const wfRunDir = join(subDir, 'workflows', WF_RUN_ID);
    mkdirSync(wfRunDir, { recursive: true });
    writeFileSync(
      join(wfRunDir, `agent-${WF_AGENT}.jsonl`),
      assistantLine({ timestamp: '2026-06-16T12:05:00.000Z', input: 10, output: 5 }) + '\n',
    );
    const workflowStore = {
      getRun: () => ({ workflow_name: 'wf-no-agents', agents: [] }),
    };

    const store = new SubagentTimelineStore({ projectsDir, workflowStore });
    const result = store.getSubagentsForSession(SESSION);
    expect(result.agents[0]!.label).toBe(`agent ${WF_AGENT.slice(0, 8)}`);
    expect(result.agents[0]!.workflowName).toBe('wf-no-agents');
  });

  it('sets usd null for unknown models', () => {
    writeFileSync(
      join(subDir, `agent-${AGENT_A}.jsonl`),
      assistantLine({
        timestamp: '2026-06-16T12:00:00.000Z',
        model: UNKNOWN_MODEL,
        input: 1000,
        output: 500,
      }) + '\n',
    );

    const store = new SubagentTimelineStore({ projectsDir });
    const result = store.getSubagentsForSession(SESSION);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]!.model).toBe(UNKNOWN_MODEL);
    expect(result.agents[0]!.usd).toBeNull();
    // Tokens are still summed even for an unpriced model.
    expect(result.agents[0]!.totalTokens).toBe(1500);
  });

  it('skips malformed JSONL lines but counts the valid ones', () => {
    writeFileSync(
      join(subDir, `agent-${AGENT_A}.jsonl`),
      [
        'not json at all',
        '{"type":"user","message":{}}', // valid json, not an assistant turn
        assistantLine({ timestamp: '2026-06-16T12:00:00.000Z', input: 10, output: 5 }),
        '{ broken', // truncated json
        assistantLine({ timestamp: '2026-06-16T12:00:30.000Z', input: 20, output: 5 }),
      ].join('\n') + '\n',
    );

    const store = new SubagentTimelineStore({ projectsDir });
    const result = store.getSubagentsForSession(SESSION);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]!.turnCount).toBe(2);
    expect(result.agents[0]!.totalTokens).toBe(10 + 5 + 20 + 5);
  });

  it('skips files larger than the 64 MiB cap', () => {
    // Construct a >64 MiB file cheaply: one valid line, then pad with a giant
    // run of newlines so the byte size crosses the cap without huge memory.
    const validLine = assistantLine({
      timestamp: '2026-06-16T12:00:00.000Z',
      input: 10,
      output: 5,
    });
    const padding = '\n'.repeat(64 * 1024 * 1024 + 1024);
    writeFileSync(join(subDir, `agent-${AGENT_A}.jsonl`), validLine + '\n' + padding);

    const store = new SubagentTimelineStore({ projectsDir });
    const result = store.getSubagentsForSession(SESSION);
    expect(result.agents).toHaveLength(0);
    expect(result.window).toEqual({ startMs: 0, endMs: 0 });
  });

  it('returns agents sorted by startMs ASC', () => {
    // Write B (earlier start) and A (later start); expect B first.
    writeFileSync(
      join(subDir, `agent-${AGENT_A}.jsonl`),
      assistantLine({ timestamp: '2026-06-16T12:10:00.000Z', input: 10, output: 5 }) + '\n',
    );
    writeFileSync(
      join(subDir, `agent-${AGENT_B}.jsonl`),
      assistantLine({ timestamp: '2026-06-16T12:00:00.000Z', input: 10, output: 5 }) + '\n',
    );

    const store = new SubagentTimelineStore({ projectsDir });
    const result = store.getSubagentsForSession(SESSION);
    expect(result.agents.map((a) => a.agentId)).toEqual([AGENT_B, AGENT_A]);
    expect(result.window.startMs).toBe(Date.parse('2026-06-16T12:00:00.000Z'));
    expect(result.window.endMs).toBe(Date.parse('2026-06-16T12:10:00.000Z'));
  });

  it('returns empty window/agents for a session with no subagents', () => {
    const store = new SubagentTimelineStore({ projectsDir });
    const result = store.getSubagentsForSession('ffffffff-1111-2222-3333-444444444444');
    expect(result).toEqual({ window: { startMs: 0, endMs: 0 }, agents: [] });
  });

  it('rejects malformed session ids without throwing', () => {
    const store = new SubagentTimelineStore({ projectsDir });
    expect(store.getSubagentsForSession('../../etc/passwd')).toEqual({
      window: { startMs: 0, endMs: 0 },
      agents: [],
    });
  });

  it('mtime-caches parsed spans (re-poll does not re-read unchanged files)', () => {
    const file = join(subDir, `agent-${AGENT_A}.jsonl`);
    writeFileSync(
      file,
      assistantLine({ timestamp: '2026-06-16T12:00:00.000Z', input: 10, output: 5 }) + '\n',
    );
    const store = new SubagentTimelineStore({ projectsDir });
    const first = store.getSubagentsForSession(SESSION);
    const second = store.getSubagentsForSession(SESSION);
    expect(second.agents).toHaveLength(1);
    expect(second.agents[0]!.totalTokens).toBe(first.agents[0]!.totalTokens);
  });
});

// ---------------------------------------------------------------------------
// getAgentCalls — ONE subagent's individual tool calls (attributed trace view)
// ---------------------------------------------------------------------------

/** Build an assistant-turn JSONL line carrying `tool_use` content blocks. */
function assistantToolUseLine(opts: {
  timestamp: string;
  uses: ReadonlyArray<{ id: string; name: string; input?: Record<string, unknown> }>;
}): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: opts.timestamp,
    uuid: 'u-' + opts.timestamp,
    message: {
      id: 'msg-' + opts.timestamp,
      model: KNOWN_MODEL,
      stop_reason: 'tool_use',
      content: opts.uses.map((u) => ({
        type: 'tool_use',
        id: u.id,
        name: u.name,
        // Inputs are present on disk but must NEVER surface in getAgentCalls.
        input: u.input ?? { secret_path: '/etc/passwd', command: 'rm -rf /' },
      })),
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
}

/** Build a user-turn JSONL line carrying `tool_result` content blocks. */
function userToolResultLine(opts: {
  timestamp: string;
  results: ReadonlyArray<{ toolUseId: string; isError?: boolean; content?: string }>;
}): string {
  return JSON.stringify({
    type: 'user',
    timestamp: opts.timestamp,
    uuid: 'ur-' + opts.timestamp,
    message: {
      role: 'user',
      content: opts.results.map((r) => ({
        type: 'tool_result',
        tool_use_id: r.toolUseId,
        is_error: r.isError ?? false,
        // Output content is present on disk but must NEVER surface either.
        content: r.content ?? 'SENSITIVE OUTPUT 0xDEADBEEF',
      })),
    },
  });
}

describe('SubagentTimelineStore.getAgentCalls', () => {
  let projectsDir: string;
  let subDir: string;

  beforeEach(() => {
    process.stderr.write = jest.fn(() => true) as unknown as typeof process.stderr.write;
    projectsDir = mkTmp();
    subDir = join(projectsDir, SLUG, SESSION, 'subagents');
    mkdirSync(subDir, { recursive: true });
  });

  afterEach(() => {
    process.stderr.write = STDERR_WRITE;
    rmSync(projectsDir, { recursive: true, force: true });
  });

  it('pairs tool_use → tool_result for success, duration, and sorts by timestamp ASC', () => {
    writeFileSync(
      join(subDir, `agent-${AGENT_A}.jsonl`),
      [
        // Two tool_use blocks issued at 12:00:00.
        assistantToolUseLine({
          timestamp: '2026-06-16T12:00:00.000Z',
          uses: [
            { id: 'tu_read', name: 'Read' },
            { id: 'tu_bash', name: 'Bash' },
          ],
        }),
        // Results in a LATER user turn at 12:00:02 — Read ok, Bash errored.
        userToolResultLine({
          timestamp: '2026-06-16T12:00:02.000Z',
          results: [
            { toolUseId: 'tu_read', isError: false },
            { toolUseId: 'tu_bash', isError: true },
          ],
        }),
        // A later tool_use with no matching result → durationMs null, success true.
        assistantToolUseLine({
          timestamp: '2026-06-16T12:00:05.000Z',
          uses: [{ id: 'tu_grep', name: 'Grep' }],
        }),
      ].join('\n') + '\n',
    );

    const store = new SubagentTimelineStore({ projectsDir });
    const { calls } = store.getAgentCalls(SESSION, AGENT_A);

    expect(calls.map((c) => c.toolName)).toEqual(['Read', 'Bash', 'Grep']);
    // Sorted by timestamp ASC (Read+Bash at :00, Grep at :05).
    expect(calls.map((c) => c.timestamp)).toEqual([
      Date.parse('2026-06-16T12:00:00.000Z'),
      Date.parse('2026-06-16T12:00:00.000Z'),
      Date.parse('2026-06-16T12:00:05.000Z'),
    ]);
    const read = calls.find((c) => c.toolName === 'Read')!;
    const bash = calls.find((c) => c.toolName === 'Bash')!;
    const grep = calls.find((c) => c.toolName === 'Grep')!;
    expect(read.success).toBe(true);
    expect(read.durationMs).toBe(2_000);
    expect(bash.success).toBe(false);
    expect(bash.durationMs).toBe(2_000);
    // No matching result.
    expect(grep.success).toBe(true);
    expect(grep.durationMs).toBeNull();
  });

  it('emits ONLY toolName/timestamp/durationMs/success — no tool inputs or outputs leak (NFR-2)', () => {
    writeFileSync(
      join(subDir, `agent-${AGENT_A}.jsonl`),
      [
        assistantToolUseLine({
          timestamp: '2026-06-16T12:00:00.000Z',
          uses: [
            {
              id: 'tu_1',
              name: 'Bash',
              input: { command: 'cat /Users/secret/.aws/credentials', timeout: 5000 },
            },
          ],
        }),
        userToolResultLine({
          timestamp: '2026-06-16T12:00:01.000Z',
          results: [{ toolUseId: 'tu_1', content: 'AKIAIOSFODNN7EXAMPLE leaked key' }],
        }),
      ].join('\n') + '\n',
    );

    const store = new SubagentTimelineStore({ projectsDir });
    const { calls } = store.getAgentCalls(SESSION, AGENT_A);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    // Exactly the four contracted keys — nothing else.
    expect(Object.keys(call).sort()).toEqual(
      ['durationMs', 'success', 'timestamp', 'toolName'].sort(),
    );
    // Belt-and-suspenders: no input/output substring anywhere in the payload.
    const serialized = JSON.stringify(calls);
    expect(serialized).not.toContain('credentials');
    expect(serialized).not.toContain('/Users/secret');
    expect(serialized).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(serialized).not.toContain('leaked key');
    expect(call.toolName).toBe('Bash');
  });

  it('resolves calls for a workflow-spawned agent transcript', () => {
    const wfRunDir = join(subDir, 'workflows', WF_RUN_ID);
    mkdirSync(wfRunDir, { recursive: true });
    writeFileSync(
      join(wfRunDir, `agent-${WF_AGENT}.jsonl`),
      [
        assistantToolUseLine({
          timestamp: '2026-06-16T12:05:00.000Z',
          uses: [{ id: 'tu_x', name: 'Edit' }],
        }),
        userToolResultLine({
          timestamp: '2026-06-16T12:05:03.000Z',
          results: [{ toolUseId: 'tu_x' }],
        }),
      ].join('\n') + '\n',
    );

    const store = new SubagentTimelineStore({ projectsDir });
    const { calls } = store.getAgentCalls(SESSION, WF_AGENT);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.toolName).toBe('Edit');
    expect(calls[0]!.durationMs).toBe(3_000);
    expect(calls[0]!.success).toBe(true);
  });

  it('returns [] for a malformed agent id (no path traversal)', () => {
    writeFileSync(
      join(subDir, `agent-${AGENT_A}.jsonl`),
      assistantToolUseLine({
        timestamp: '2026-06-16T12:00:00.000Z',
        uses: [{ id: 'tu_1', name: 'Read' }],
      }) + '\n',
    );
    const store = new SubagentTimelineStore({ projectsDir });
    expect(store.getAgentCalls(SESSION, '../../etc/passwd')).toEqual({ calls: [] });
    expect(store.getAgentCalls(SESSION, 'not-an-agent-id')).toEqual({ calls: [] });
  });

  it('returns [] for a malformed session id', () => {
    const store = new SubagentTimelineStore({ projectsDir });
    expect(store.getAgentCalls('../../etc/passwd', AGENT_A)).toEqual({ calls: [] });
  });

  it('returns [] when the agent transcript is missing', () => {
    const store = new SubagentTimelineStore({ projectsDir });
    expect(store.getAgentCalls(SESSION, AGENT_B)).toEqual({ calls: [] });
  });

  it('returns [] when the transcript exceeds the 64 MiB size cap', () => {
    const validLine = assistantToolUseLine({
      timestamp: '2026-06-16T12:00:00.000Z',
      uses: [{ id: 'tu_1', name: 'Read' }],
    });
    const padding = '\n'.repeat(64 * 1024 * 1024 + 1024);
    writeFileSync(join(subDir, `agent-${AGENT_A}.jsonl`), validLine + '\n' + padding);

    const store = new SubagentTimelineStore({ projectsDir });
    expect(store.getAgentCalls(SESSION, AGENT_A)).toEqual({ calls: [] });
  });

  it('ignores malformed JSONL lines but keeps the valid tool calls', () => {
    writeFileSync(
      join(subDir, `agent-${AGENT_A}.jsonl`),
      [
        'not json at all',
        '{ broken',
        assistantToolUseLine({
          timestamp: '2026-06-16T12:00:00.000Z',
          uses: [{ id: 'tu_1', name: 'Read' }],
        }),
        userToolResultLine({
          timestamp: '2026-06-16T12:00:01.000Z',
          results: [{ toolUseId: 'tu_1' }],
        }),
      ].join('\n') + '\n',
    );
    const store = new SubagentTimelineStore({ projectsDir });
    const { calls } = store.getAgentCalls(SESSION, AGENT_A);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.toolName).toBe('Read');
  });

  it('mtime-caches the call list (re-poll returns an equal result)', () => {
    writeFileSync(
      join(subDir, `agent-${AGENT_A}.jsonl`),
      [
        assistantToolUseLine({
          timestamp: '2026-06-16T12:00:00.000Z',
          uses: [{ id: 'tu_1', name: 'Read' }],
        }),
        userToolResultLine({
          timestamp: '2026-06-16T12:00:01.000Z',
          results: [{ toolUseId: 'tu_1' }],
        }),
      ].join('\n') + '\n',
    );
    const store = new SubagentTimelineStore({ projectsDir });
    const first = store.getAgentCalls(SESSION, AGENT_A);
    const second = store.getAgentCalls(SESSION, AGENT_A);
    expect(second).toEqual(first);
    expect(second.calls).toHaveLength(1);
  });
});
