import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HookEventProcessor } from '../hooks/event-processor.js';
import { appendToHookBuffer } from '../storage/hook-buffer.js';
import { LocalStore } from '../storage/local-store.js';
import type { SkillStamp, ToolCallRecord, TokenEvent } from '../storage/types.js';
import { NrIngestManager } from '../transport/nr-ingest.js';
import { SessionTracker } from './session-tracker.js';
import { SkillActivationTracker } from './skill-activation-tracker.js';
import { createWorkUnitEmitter } from './skill-run-emitter.js';
import { type ClosedSkillRun, SkillRunLedger } from './skill-run-ledger.js';
import { TurnCostAttributor } from './turn-cost-attributor.js';

const SESSION = 'sess-unit';
const MODEL = 'claude-sonnet-4-5-20250929';

function makeStamp(runId: string, name = 'review'): SkillStamp {
  return { name, source: 'tool', runId };
}

function makeCall(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: overrides.toolUseId ?? 'r',
    sessionId: SESSION,
    toolName: 'Read',
    toolUseId: 'tu',
    timestamp: 1_000,
    durationMs: 100,
    success: true,
    ...overrides,
  };
}

function makeTokens(timestamp: number): TokenEvent {
  return {
    mode: 'token',
    sessionId: SESSION,
    timestamp,
    inputTokens: 1_000,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    model: MODEL,
  } as TokenEvent;
}

function makeLedger() {
  const closed: ClosedSkillRun[] = [];
  const attributor = new TurnCostAttributor();
  const ledger = new SkillRunLedger((run) => closed.push(run));
  const call = (record: ToolCallRecord) => {
    attributor.recordToolCall(record);
    ledger.recordToolCall(record);
  };
  const tokens = (timestamp: number) =>
    ledger.recordClosedTurn(attributor.recordTokenEvent(makeTokens(timestamp)));
  return { closed, ledger, call, tokens };
}

describe('SkillRunLedger', () => {
  it('holds a closed run until its last call is priced', () => {
    const { closed, ledger, call, tokens } = makeLedger();
    const stamp = makeStamp('run-1');
    ledger.recordRunOpened(stamp, { sessionId: SESSION, timestamp: 500 });
    call(makeCall({ activeSkill: stamp, timestamp: 1_000, durationMs: 200 }));
    ledger.recordPrompt(SESSION, 5_000);

    expect(closed).toEqual([]);
    tokens(6_000);
    expect(closed).toMatchObject([
      { stamp, startedAt: 500, endedAt: 1_200, toolCallCount: 1, pricedCallCount: 1 },
    ]);
    expect(closed[0]!.costUsd).toBeGreaterThan(0);
    expect(closed[0]!.inputTokens).toBe(1_000);
  });

  it('ends a main-agent run at its Stop, not at the next prompt', () => {
    const { closed, ledger } = makeLedger();
    ledger.recordRunOpened(makeStamp('run-1'), { sessionId: SESSION, timestamp: 1_000 });
    ledger.recordStop(SESSION, 4_000);
    ledger.recordPrompt(SESSION, 90_000);

    expect(closed).toMatchObject([{ startedAt: 1_000, endedAt: 4_000, toolCallCount: 0 }]);
  });

  it('closes a run when the same agent opens the next skill, ending it there', () => {
    const { closed, ledger } = makeLedger();
    ledger.recordRunOpened(makeStamp('run-1'), { sessionId: SESSION, timestamp: 1_000 });
    ledger.recordRunOpened(makeStamp('run-sub'), {
      sessionId: SESSION,
      timestamp: 2_000,
      agentId: 'agent-a',
    });
    expect(closed).toEqual([]);

    ledger.recordRunOpened(makeStamp('run-2'), { sessionId: SESSION, timestamp: 3_000 });
    expect(closed).toMatchObject([{ stamp: { runId: 'run-1' }, endedAt: 3_000 }]);
  });

  it('keeps the subagent that opened a run on its record', () => {
    const { closed, ledger } = makeLedger();
    ledger.recordRunOpened(makeStamp('run-sub'), {
      sessionId: SESSION,
      timestamp: 2_000,
      agentId: 'agent-a',
    });
    ledger.recordStop(SESSION, 9_000);
    ledger.recordPrompt(SESSION, 10_000);

    expect(closed).toMatchObject([{ agentId: 'agent-a', endedAt: 2_000 }]);
  });

  it('hands over a run whose call is never priced once the burst would be evicted', () => {
    const { closed, ledger, call, tokens } = makeLedger();
    const stamp = makeStamp('run-1');
    ledger.recordRunOpened(stamp, { sessionId: SESSION, timestamp: 500 });
    call(makeCall({ activeSkill: stamp, timestamp: 1_000 }));
    ledger.recordPrompt(SESSION, 2_000);
    tokens(900);
    expect(closed).toEqual([]);

    tokens(2_000 + 10 * 60 * 1000 + 1);
    expect(closed).toMatchObject([{ toolCallCount: 1 }]);
  });

  it('hands over open runs on flush, once', () => {
    const { closed, ledger } = makeLedger();
    ledger.recordRunOpened(makeStamp('run-1'), { sessionId: SESSION, timestamp: 500 });
    ledger.flush();
    ledger.flush();
    ledger.recordPrompt(SESSION, 1_000);

    expect(closed).toHaveLength(1);
  });

  it('hands over a closed run before an open one when it holds too many', () => {
    const { closed, ledger, call } = makeLedger();
    ledger.recordRunOpened(makeStamp('run-open'), { sessionId: 's-open', timestamp: 0 });
    const waiting = makeStamp('run-waiting');
    ledger.recordRunOpened(waiting, { sessionId: SESSION, timestamp: 1 });
    call(makeCall({ activeSkill: waiting, timestamp: 2 }));
    ledger.recordPrompt(SESSION, 3);
    for (let i = 0; i < 255; i++) {
      ledger.recordRunOpened(makeStamp(`run-${i}`), { sessionId: `s-${i}`, timestamp: 4 });
    }

    expect(closed.map((run) => run.stamp.runId)).toEqual(['run-waiting']);
  });

  it('hands over the oldest open run when none is closed', () => {
    const { closed, ledger } = makeLedger();
    for (let i = 0; i <= 256; i++) {
      ledger.recordRunOpened(makeStamp(`run-${i}`), { sessionId: `s-${i}`, timestamp: i });
    }

    expect(closed.map((run) => run.stamp.runId)).toEqual(['run-0']);
  });
});

describe('AiWorkUnit through the hook buffer', () => {
  let dir: string;
  let processor: HookEventProcessor | undefined;

  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    dir = mkdtempSync(join(tmpdir(), 'nr-work-unit-'));
  });

  afterEach(() => {
    processor?.stop();
    jest.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  async function runFrames(frames: readonly object[]): Promise<Record<string, unknown>[]> {
    const sent: Record<string, unknown>[] = [];
    const ok = async (events: readonly Record<string, unknown>[]) => {
      sent.push(...events);
      return { success: true, statusCode: 202, retryCount: 0 };
    };
    const manager = new NrIngestManager({
      licenseKey: 'test-license-key',
      transportOptions: {},
      developer: 'dev',
      appName: 'app',
      sessionTracker: new SessionTracker(SESSION),
      eventHarvestIntervalMs: 3_600_000,
      metricHarvestIntervalMs: 3_600_000,
      logHarvestIntervalMs: 3_600_000,
      sendEventsFn: ok as never,
      sendMetricsFn: ok as never,
      sendLogsFn: ok as never,
    });
    const attributor = new TurnCostAttributor();
    const ledger = new SkillRunLedger(
      createWorkUnitEmitter({
        stdio: true,
        getOwnSessionId: () => SESSION,
        getSink: () => manager,
      }),
    );
    const skills = new SkillActivationTracker({
      onRunOpened: (stamp, ctx) => ledger.recordRunOpened(stamp, ctx),
    });
    processor = new HookEventProcessor({
      store: new LocalStore(dir, SESSION),
      pollIntervalMs: 3_600_000,
      onRecord: (record) => {
        const activeSkill = skills.recordToolCall(record);
        const stamped = activeSkill ? { ...record, activeSkill } : record;
        attributor.recordToolCall(stamped);
        ledger.recordToolCall(stamped);
      },
      onTokenEvent: (event) => {
        const turn = attributor.recordTokenEvent(event, skills.openRun(event.sessionId));
        ledger.recordClosedTurn(turn);
        manager.ingestTurnCost(turn);
      },
      onUserPromptSubmit: (frame) => {
        ledger.recordPrompt(frame.sessionId, frame.timestamp);
        skills.recordPrompt(frame.sessionId, frame.slashCommand ?? null, frame.timestamp);
      },
      onStop: (frame) => ledger.recordStop(frame.sessionId, frame.timestamp),
    });
    manager.start();
    processor.start();
    const buffer = join(dir, `buffer-${SESSION}.jsonl`);
    for (const frame of frames) appendToHookBuffer(buffer, JSON.stringify(frame) + '\n');
    processor.stop();
    await manager.stop();
    return sent;
  }

  const prompt = (timestamp: number, slashCommand?: string) => ({
    mode: 'user_prompt_submit',
    tool: 'user_prompt_submit',
    timestamp,
    sessionId: SESSION,
    ...(slashCommand && { slashCommand }),
  });
  const pair = (toolUseId: string, tool: string, start: number, end: number, extra = {}) => [
    { mode: 'pre', tool, timestamp: start, toolUseId, sessionId: SESSION, ...extra },
    { mode: 'post', tool, timestamp: end, toolUseId, sessionId: SESSION, success: true, ...extra },
  ];
  const tokens = (timestamp: number) => ({ ...makeTokens(timestamp), tool: 'transcript' });
  const stop = (timestamp: number) => ({
    mode: 'stop',
    tool: 'stop',
    timestamp,
    sessionId: SESSION,
  });

  it('closes a slash run with its cost, tokens and duration on one row', async () => {
    const sent = await runFrames([
      prompt(1_000, 'review'),
      ...pair('tu-1', 'Read', 2_000, 2_100),
      ...pair('tu-2', 'Grep', 2_200, 2_300),
      tokens(3_000),
      stop(3_500),
      prompt(60_000),
    ]);

    const units = sent.filter((e) => e.eventType === 'AiWorkUnit');
    expect(units).toHaveLength(1);
    const runId = units[0]!.skill_run_id;
    const shares = sent.filter(
      (e) => e.eventType === 'AiTurnCost' && e.skill_run_id === runId && e.tool,
    );
    const sum = (key: string) => shares.reduce((total, e) => total + (e[key] as number), 0);
    expect(shares).toHaveLength(2);
    expect(units[0]).toMatchObject({
      event_version: 1,
      unit_kind: 'skill_run',
      skill_name: 'review',
      skill_source: 'slash',
      session_id: SESSION,
      started_at: 1_000,
      duration_ms: 2_500,
      timestamp: 3_500,
      tool_call_count: 2,
      priced_call_count: 2,
      input_tokens: 1_000,
      output_tokens: 200,
    });
    expect(units[0]!.cost_usd).toBeGreaterThan(0);
    expect(units[0]!.cost_usd).toBeCloseTo(sum('cost_usd'), 12);
    expect(units[0]).not.toHaveProperty('parent_session_id');
  });

  it('names the parent session of a run a subagent opened', async () => {
    const agent = { agentId: 'agent-sub-1', agentType: 'Explore' };
    const sent = await runFrames([
      prompt(1_000),
      ...pair('tu-skill', 'Skill', 2_000, 2_050, { ...agent, toolInput: { skill: 'lint' } }),
      ...pair('tu-read', 'Read', 2_100, 2_400, agent),
      tokens(3_000),
      prompt(9_000),
    ]);

    expect(sent.filter((e) => e.eventType === 'AiWorkUnit')).toMatchObject([
      {
        skill_name: 'lint',
        skill_source: 'tool',
        agent_id: 'agent-sub-1',
        session_id: SESSION,
        parent_session_id: SESSION,
        started_at: 2_000,
        duration_ms: 400,
        tool_call_count: 2,
        priced_call_count: 2,
      },
    ]);
  });
});
