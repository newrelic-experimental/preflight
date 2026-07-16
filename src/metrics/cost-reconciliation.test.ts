import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SubagentTimelineStore } from '../dashboard/subagent-timeline-store.js';
import { HookEventProcessor, type SubagentTurnEvent } from '../hooks/event-processor.js';
import type { TokenUsage } from '../shared/index.js';
import { LocalStore } from '../storage/local-store.js';
import type { HookEvent } from '../storage/types.js';
import { CostTracker } from './cost-tracker.js';

/**
 * Cross-pipeline cost reconciliation — the "seam" tests.
 *
 * Cost is computed by two independent subsystems that must agree:
 *   1. CostTracker (the headline / persisted `estimatedCostUsd` path), fed
 *      per-turn via the onSubagentTurn feed.
 *   2. SubagentTimelineStore (the session-trace "Ad-hoc subagents" $ path),
 *      which re-parses the same JSONL transcripts on demand.
 *
 * The production incident this guards against: the trace summed every
 * streaming-duplicate JSONL line (no message.id dedup) and reported ~2x the
 * real subagent cost, while the headline omitted subagent cost entirely — so a
 * session showed $6 at the top and $19 of subagents right below it. These
 * tests assert the invariants that would have failed CI on that bug:
 *   - sum(per-agent trace usd)  ==  CostTracker.subagentUsd   (trace == headline)
 *   - parentUsd + subagentUsd   ==  sessionTotalCostUsd
 *   - subagentUsd               <=  sessionTotalCostUsd
 */

const STDERR_WRITE = process.stderr.write;
const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SLUG = 'project-slug';
const AGENT_A = 'a1111111111111111';
const KNOWN_MODEL = 'claude-opus-4-7';

/** One assistant-turn JSONL line. `id` is the message id used for dedup. */
function assistantLine(opts: {
  id: string;
  timestamp: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation?: number;
}): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: opts.timestamp,
    uuid: 'u-' + opts.id + '-' + opts.timestamp,
    message: {
      id: opts.id,
      model: KNOWN_MODEL,
      usage: {
        input_tokens: opts.input,
        output_tokens: opts.output,
        cache_read_input_tokens: opts.cacheRead,
        cache_creation_input_tokens: opts.cacheCreation ?? 0,
      },
    },
  });
}

function usageOf(opts: {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation?: number;
}): TokenUsage {
  return {
    inputTokens: opts.input,
    outputTokens: opts.output,
    thinkingTokens: 0,
    cacheReadTokens: opts.cacheRead,
    cacheCreationTokens: opts.cacheCreation ?? 0,
    totalTokens: opts.input + opts.output + opts.cacheRead + (opts.cacheCreation ?? 0),
  };
}

describe('cost reconciliation: trace (SubagentTimelineStore) == headline (CostTracker)', () => {
  let projectsDir: string;
  let subDir: string;

  beforeEach(() => {
    process.stderr.write = jest.fn(() => true) as unknown as typeof process.stderr.write;
    projectsDir = mkdtempSync(join(tmpdir(), 'cost-reconcile-'));
    subDir = join(projectsDir, SLUG, SESSION, 'subagents');
    mkdirSync(subDir, { recursive: true });
  });

  afterEach(() => {
    process.stderr.write = STDERR_WRITE;
    rmSync(projectsDir, { recursive: true, force: true });
  });

  it('the two pipelines agree on subagent cost for the same transcript', () => {
    // Two logical turns, each logged as 3 streaming-duplicate lines (same
    // message id, byte-identical per-prompt usage — exactly the Claude Code
    // transcript shape that triggered the ~2x over-count).
    const turn1 = { input: 1200, output: 800, cacheRead: 100_000, cacheCreation: 2000 };
    const turn2 = { input: 1500, output: 1100, cacheRead: 120_000, cacheCreation: 0 };

    writeFileSync(
      join(subDir, `agent-${AGENT_A}.jsonl`),
      [
        assistantLine({ id: 'msg_one', timestamp: '2026-06-16T12:00:00.000Z', ...turn1 }),
        assistantLine({ id: 'msg_one', timestamp: '2026-06-16T12:00:00.100Z', ...turn1 }),
        assistantLine({ id: 'msg_one', timestamp: '2026-06-16T12:00:00.200Z', ...turn1 }),
        assistantLine({ id: 'msg_two', timestamp: '2026-06-16T12:00:05.000Z', ...turn2 }),
        assistantLine({ id: 'msg_two', timestamp: '2026-06-16T12:00:05.100Z', ...turn2 }),
        assistantLine({ id: 'msg_two', timestamp: '2026-06-16T12:00:05.200Z', ...turn2 }),
      ].join('\n') + '\n',
    );

    // Pipeline 1: the trace path. Dedups the 6 raw lines internally.
    const timeline = new SubagentTimelineStore({ projectsDir });
    const agents = timeline.getSubagentsForSession(SESSION).agents;
    const traceUsd = agents.reduce((sum, a) => sum + (a.usd ?? 0), 0);

    // Pipeline 2: the headline path — routed through the REAL production
    // dedup (HookEventProcessor.handleSubagentTokenEvent's (agentId,
    // messageId) dedup), not a hand-deduped shortcut. Six raw
    // mode:'subagent_token' events (one per streaming-duplicate line, same
    // shape SubagentWatcher emits) go in; the processor's dedup must
    // collapse them to exactly 2 SubagentTurnEvents before they ever reach
    // CostTracker — this is the actual seam the test name promises to guard.
    const rawTurns = [
      { messageId: 'msg_one', turnUuid: 'u-msg_one-1', ...turn1 },
      { messageId: 'msg_one', turnUuid: 'u-msg_one-2', ...turn1 },
      { messageId: 'msg_one', turnUuid: 'u-msg_one-3', ...turn1 },
      { messageId: 'msg_two', turnUuid: 'u-msg_two-1', ...turn2 },
      { messageId: 'msg_two', turnUuid: 'u-msg_two-2', ...turn2 },
      { messageId: 'msg_two', turnUuid: 'u-msg_two-3', ...turn2 },
    ];
    const rawEvents: HookEvent[] = rawTurns.map((t) => ({
      mode: 'subagent_token',
      tool: 'subagent',
      timestamp: 1718539200000,
      sessionId: SESSION,
      agentId: AGENT_A,
      workflowRunId: null,
      messageId: t.messageId,
      turnUuid: t.turnUuid,
      model: KNOWN_MODEL,
      inputTokens: t.input,
      outputTokens: t.output,
      cacheReadTokens: t.cacheRead,
      cacheCreationTokens: t.cacheCreation ?? 0,
      reasoningTokens: 0,
      stopReason: 'end_turn',
      schemaFingerprint: 'fp',
    }));

    const dedupedTurns: SubagentTurnEvent[] = [];
    const localStore = new LocalStore(projectsDir);
    const processor = new HookEventProcessor({
      store: localStore,
      onRecord: () => undefined,
      onSubagentTurn: (t) => dedupedTurns.push(t),
    });
    processor.processEvents(rawEvents);

    // The processor's own dedup must have already collapsed 6 raw events to 2.
    expect(dedupedTurns).toHaveLength(2);

    const tracker = new CostTracker();
    for (const turn of dedupedTurns) {
      // Mirrors src/index.ts's real onSubagentTurn -> CostTracker wiring
      // exactly (see that file's `reasoningTokens` -> `thinkingTokens`
      // mapping comment) — not a test-invented shortcut.
      const usage: TokenUsage = {
        inputTokens: turn.inputTokens,
        outputTokens: turn.outputTokens,
        thinkingTokens: turn.reasoningTokens,
        cacheReadTokens: turn.cacheReadTokens,
        cacheCreationTokens: turn.cacheCreationTokens,
        totalTokens:
          turn.inputTokens +
          turn.outputTokens +
          turn.reasoningTokens +
          turn.cacheReadTokens +
          turn.cacheCreationTokens,
      };
      tracker.recordTokenUsage(usage, turn.model, {
        timestampMs: turn.timestampMs,
        workflowRunId: turn.workflowRunId,
        agentId: turn.agentId,
      });
    }
    const headlineSubagentUsd = tracker.getSubagentMetrics().subagentUsd;

    // Both pipelines — each running its OWN independent dedup over the same
    // raw, duplicated input — must arrive at the same price.
    expect(traceUsd).toBeGreaterThan(0);
    expect(traceUsd).toBeCloseTo(headlineSubagentUsd, 6);
  });
});

describe('cost reconciliation: CostTracker internal invariants', () => {
  beforeEach(() => {
    process.stderr.write = jest.fn(() => true) as unknown as typeof process.stderr.write;
  });
  afterEach(() => {
    process.stderr.write = STDERR_WRITE;
  });

  it('parentUsd + subagentUsd == sessionTotalCostUsd, and subagentUsd <= total', () => {
    const tracker = new CostTracker();
    // Parent turns (no agentId) + subagent turns (agentId set).
    tracker.recordTokenUsage(
      usageOf({ input: 5000, output: 3000, cacheRead: 50_000 }),
      KNOWN_MODEL,
    );
    tracker.recordTokenUsage(
      usageOf({ input: 4000, output: 2000, cacheRead: 40_000 }),
      KNOWN_MODEL,
    );
    tracker.recordTokenUsage(
      usageOf({ input: 1000, output: 800, cacheRead: 90_000 }),
      KNOWN_MODEL,
      {
        agentId: 'a1111111111111111',
      },
    );
    tracker.recordTokenUsage(
      usageOf({ input: 1200, output: 900, cacheRead: 95_000 }),
      KNOWN_MODEL,
      {
        agentId: 'a2222222222222222',
      },
    );

    const total = tracker.getMetrics().sessionTotalCostUsd ?? 0;
    const { subagentUsd, parentUsd } = tracker.getSubagentMetrics();

    expect(total).toBeGreaterThan(0);
    expect(subagentUsd).toBeGreaterThan(0);
    expect(parentUsd).toBeGreaterThan(0);
    // The split must sum to the whole — no cost is unattributed or double-counted.
    expect(parentUsd + subagentUsd).toBeCloseTo(total, 6);
    // Subagents are a subset of the session; never more than the total. This is
    // the exact invariant the UI violated ($19 subagents under a $6 session).
    expect(subagentUsd).toBeLessThanOrEqual(total + 1e-9);
  });

  it('a session with only subagent spend still has subagentUsd <= total', () => {
    const tracker = new CostTracker();
    tracker.recordTokenUsage(
      usageOf({ input: 1000, output: 500, cacheRead: 200_000 }),
      KNOWN_MODEL,
      {
        agentId: 'a1111111111111111',
      },
    );
    const total = tracker.getMetrics().sessionTotalCostUsd ?? 0;
    const { subagentUsd } = tracker.getSubagentMetrics();
    expect(subagentUsd).toBeCloseTo(total, 6);
    expect(subagentUsd).toBeLessThanOrEqual(total + 1e-9);
  });
});
