/**
 * Property test for session cost accounting: whatever order estimates, token
 * events, duplicates, self-reports, restarts, forks and a second writer arrive
 * in, a session's total is the sum of its unique API calls plus the byte
 * estimates no later exact turn has replaced yet.
 *
 * It drives the real pieces a running Preflight wires together — the billed
 * turn ledger the watchers claim through, the hook buffer, HookEventProcessor,
 * CostTracker, SessionStore's save/load/merge, the restart seed, and a
 * `--local` LocalSessionAggregator writing the same session file — with a
 * seeded PRNG so a failure prints a replayable action trace.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TokenUsage } from '../shared/index.js';

import { BilledTurnLedger } from '../hooks/billed-turn-ledger.js';
import { HookEventProcessor } from '../hooks/event-processor.js';
import type { SubagentTurnEvent } from '../hooks/event-processor.js';
import { LocalStore } from '../storage/local-store.js';
import { SessionStore, buildSessionSummary } from '../storage/session-store.js';
import type { FullSessionSummary } from '../storage/session-store.js';
import type { HookEvent, TokenEvent } from '../storage/types.js';
import { handleReportTokens } from '../tools/cost-tools.js';
import type { TokenReport } from '../tools/cost-tools.js';
import { CostTracker } from './cost-tracker.js';
import { buildCostTrackerSeed } from './cost-tracker-seed.js';
import { shouldApplyCostEstimate } from './cost-estimate-gate.js';
import { LocalSessionAggregator, RepoNameResolver } from './local-session-aggregator.js';
import type { SessionTracker } from './session-tracker.js';
import { ToolSelectionScorer } from './tool-selection-scorer.js';

const P = '11111111-2222-4333-8444-555555555555';
const FORK = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const MODEL = 'claude-sonnet-4-5';
const AGENT = 'agent-a1';
const TOOLS = ['transcript', 'copilot-usage', 'copilot-sdk-usage'] as const;

type Action =
  | 'turn'
  | 'turnBoth'
  | 'subagentTurn'
  | 'redeliver'
  | 'estimate'
  | 'selfReportKnownId'
  | 'selfReportFreshId'
  | 'selfReportNoId'
  | 'pumpE'
  | 'pumpW'
  | 'saveE'
  | 'saveW'
  | 'restartE'
  | 'restartW'
  | 'fork';

const ACTIONS: readonly Action[] = [
  'turn',
  'turn',
  'turnBoth',
  'subagentTurn',
  'redeliver',
  'estimate',
  'estimate',
  'selfReportKnownId',
  'selfReportFreshId',
  'selfReportNoId',
  'pumpE',
  'pumpE',
  'pumpW',
  'saveE',
  'saveW',
  'restartE',
  'restartW',
  'fork',
];

/** One real API call, the unit the session total must count exactly once. */
interface Call {
  readonly id: string;
  readonly session: string;
  readonly ts: number;
  readonly usage: TokenUsage;
  readonly usd: number;
  readonly subagent: boolean;
  /** `req`: self-reported with an id first; `self`: self-reported with no id. */
  readonly kind: 'turn' | 'req' | 'self';
  /** Reported by a watcher that replays history (so it replaces estimates). */
  replaying: boolean;
  /** The buffer line a watcher wrote for it, once one has. */
  line?: HookEvent;
}

interface Estimate {
  readonly ts: number;
  readonly usd: number;
  readonly inputTokens: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sessionTrackerFor(sessionId: string, startMs: number): SessionTracker {
  return {
    getMetrics: () => ({
      sessionId,
      sessionName: null,
      sessionStartTime: startMs,
      toolCallCount: 0,
      toolCallCountByTool: {},
      bashCommandsRun: 0,
      toolSuccessRate: null,
    }),
  } as unknown as SessionTracker;
}

function usageOf(e: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens?: number;
}): TokenUsage {
  const thinking = e.reasoningTokens ?? 0;
  return {
    inputTokens: e.inputTokens,
    outputTokens: e.outputTokens,
    thinkingTokens: thinking,
    cacheReadTokens: e.cacheReadTokens,
    cacheCreationTokens: e.cacheCreationTokens,
    totalTokens: e.inputTokens + e.outputTokens + thinking,
  };
}

/** The `--stdio` engine that owns session P (mirrors src/index.ts's wiring). */
class Engine {
  readonly ledger: BilledTurnLedger;
  readonly store: LocalStore;
  readonly cost = new CostTracker();
  readonly processor: HookEventProcessor;
  /** This process has recorded a replaying token event for P. */
  sawReplaying = false;

  constructor(
    readonly storagePath: string,
    private readonly startMs: number,
  ) {
    this.ledger = new BilledTurnLedger({ storagePath });
    this.store = new LocalStore(storagePath, P);
    const persisted = new SessionStore({ storagePath }).loadSession(P);
    if (persisted) this.cost.seedFromPersisted(buildCostTrackerSeed(persisted));
    this.processor = new HookEventProcessor({
      store: this.store,
      onRecord: () => undefined,
      onTokenEvent: (e: TokenEvent) => {
        if (e.sessionId !== undefined && e.sessionId !== P) return;
        this.sawReplaying = true;
        this.cost.recordTokenUsage(usageOf(e), e.model, {
          timestampMs: e.timestamp,
          replacesEstimates: true,
          ...(e.usageId !== undefined && { usageId: e.usageId }),
        });
      },
      onSubagentTurn: (t: SubagentTurnEvent) => {
        if (t.parentSessionId !== P) return;
        this.cost.recordTokenUsage(usageOf(t), t.model, {
          timestampMs: t.timestampMs,
          workflowRunId: t.workflowRunId,
          agentId: t.agentId,
          usageId: t.messageId,
        });
      },
    });
  }

  pump(): void {
    this.processor.processEvents(this.store.drainBuffer());
  }

  save(): void {
    new SessionStore({ storagePath: this.storagePath }).saveSession(
      buildSessionSummary({
        sessionTracker: sessionTrackerFor(P, this.startMs),
        costTracker: this.cost,
        developer: 'dev',
      }),
    );
  }
}

/** A `--local` dashboard draining every buffer and writing rollups (mirrors src/index.ts). */
class LocalWriter {
  readonly ledger: BilledTurnLedger;
  readonly store: LocalStore;
  readonly aggregator: LocalSessionAggregator;
  readonly processor: HookEventProcessor;
  private readonly pricer = new CostTracker();

  constructor(readonly storagePath: string) {
    this.ledger = new BilledTurnLedger({ storagePath });
    this.store = new LocalStore(storagePath);
    this.aggregator = new LocalSessionAggregator();
    this.processor = new HookEventProcessor({
      store: this.store,
      drainAllSessions: true,
      onRecord: () => undefined,
      onTokenEvent: (e: TokenEvent) => {
        this.aggregator.recordTokenUsage(e.sessionId, {
          timestamp: e.timestamp,
          costUsd: this.pricer.priceUsage(usageOf(e), e.model).totalUsd,
          model: e.model,
          inputTokens: e.inputTokens,
          outputTokens: e.outputTokens,
          cacheReadTokens: e.cacheReadTokens,
          cacheCreationTokens: e.cacheCreationTokens,
          ...(e.usageId !== undefined && { usageId: e.usageId }),
        });
      },
      onSubagentTurn: (t: SubagentTurnEvent) => {
        this.aggregator.recordTokenUsage(t.parentSessionId, {
          timestamp: t.timestampMs,
          costUsd: this.pricer.priceUsage(usageOf(t), t.model).totalUsd,
          model: t.model,
          inputTokens: t.inputTokens,
          outputTokens: t.outputTokens,
          cacheReadTokens: t.cacheReadTokens,
          cacheCreationTokens: t.cacheCreationTokens,
          thinkingTokens: t.reasoningTokens,
          agentId: t.agentId,
          usageId: t.messageId,
        });
      },
    });
  }

  pump(): void {
    this.processor.processEvents(this.store.drainAllBuffers());
  }

  save(): void {
    const sessions = new SessionStore({ storagePath: this.storagePath });
    const rollups = this.aggregator.toSummaries({
      developer: 'dev',
      outcome: 'in progress',
      repoResolver: new RepoNameResolver(),
      toolSelectionScorer: new ToolSelectionScorer(),
    });
    for (const rollup of rollups) sessions.saveSession(rollup as unknown as FullSessionSummary);
  }
}

class World {
  clock: number;
  readonly startMs: number;
  readonly calls: Call[] = [];
  readonly estimates: Estimate[] = [];
  readonly trace: string[] = [];
  engine: Engine;
  local: LocalWriter;
  private readonly pricer = new CostTracker();
  private seq = 0;
  private forked = false;

  constructor(
    readonly storagePath: string,
    private readonly rand: () => number,
    private readonly setNow: (ms: number) => void,
  ) {
    this.clock = Date.now();
    this.startMs = this.clock;
    this.engine = new Engine(storagePath, this.startMs);
    this.local = new LocalWriter(storagePath);
  }

  private pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.rand() * xs.length)]!;
  }

  private int(min: number, max: number): number {
    return min + Math.floor(this.rand() * (max - min + 1));
  }

  private newCall(session: string, subagent: boolean, kind: Call['kind'] = 'turn'): Call {
    const usage = usageOf({
      inputTokens: this.int(1, 5_000),
      outputTokens: this.int(1, 2_000),
      cacheReadTokens: this.int(0, 50_000),
      cacheCreationTokens: this.int(0, 5_000),
    });
    const call: Call = {
      id: `${kind}_${++this.seq}_${Math.floor(this.rand() * 1e9).toString(36)}`,
      session,
      ts: this.clock,
      usage,
      usd: this.pricer.priceUsage(usage, MODEL).totalUsd,
      subagent,
      kind,
      replaying: false,
    };
    this.calls.push(call);
    return call;
  }

  private lineFor(call: Call, session: string): HookEvent {
    if (call.subagent) {
      return {
        mode: 'subagent_token',
        tool: 'subagent',
        timestamp: call.ts,
        sessionId: session,
        agentId: AGENT,
        messageId: call.id,
        workflowRunId: null,
        model: MODEL,
        inputTokens: call.usage.inputTokens,
        outputTokens: call.usage.outputTokens,
        cacheReadTokens: call.usage.cacheReadTokens,
        cacheCreationTokens: call.usage.cacheCreationTokens,
        reasoningTokens: 0,
      } as unknown as HookEvent;
    }
    return {
      mode: 'token',
      tool: this.pick(TOOLS),
      timestamp: call.ts,
      sessionId: session,
      messageId: call.id,
      model: MODEL,
      inputTokens: call.usage.inputTokens,
      outputTokens: call.usage.outputTokens,
      cacheReadTokens: call.usage.cacheReadTokens,
      cacheCreationTokens: call.usage.cacheCreationTokens,
    } as unknown as HookEvent;
  }

  /** A watcher in `via`'s process claims the turn, then buffers it. */
  private emit(call: Call, via: BilledTurnLedger, session = call.session): void {
    const line = this.lineFor(call, session);
    via.deliver(session, [{ messageId: call.id, timestampMs: call.ts }], () => {
      new LocalStore(this.storagePath, session).appendToBuffer(line);
    });
    if (session === call.session) {
      call.line = line;
      if (!call.subagent) call.replaying = true;
    }
  }

  private selfReport(usage: TokenUsage, requestId?: string): void {
    const args: TokenReport = {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_read_tokens: usage.cacheReadTokens,
      cache_creation_tokens: usage.cacheCreationTokens,
      model: MODEL,
      ...(requestId !== undefined && { request_id: requestId }),
    };
    handleReportTokens(this.engine.cost, args);
  }

  step(action: Action): void {
    this.clock += 1_000;
    this.setNow(this.clock);
    this.trace.push(action);
    switch (action) {
      case 'turn': {
        const pending = this.calls.filter((c) => c.kind === 'req' && c.line === undefined);
        // Now and then the transcript reports a response already self-reported by id.
        const call =
          pending.length > 0 && this.rand() < 0.5 ? this.pick(pending) : this.newCall(P, false);
        this.emit(call, this.rand() < 0.5 ? this.engine.ledger : this.local.ledger);
        break;
      }
      case 'turnBoth': {
        const call = this.newCall(P, false);
        this.emit(call, this.engine.ledger);
        this.emit(call, this.local.ledger);
        break;
      }
      case 'subagentTurn': {
        const call = this.newCall(P, true);
        this.emit(call, this.rand() < 0.5 ? this.engine.ledger : this.local.ledger);
        break;
      }
      case 'redeliver': {
        // A drain claim re-delivered after a crash: the same buffer line again.
        const delivered = this.calls.filter((c) => c.line !== undefined);
        if (delivered.length === 0) return;
        const call = this.pick(delivered);
        new LocalStore(this.storagePath, call.session).appendToBuffer(call.line!);
        break;
      }
      case 'estimate': {
        const inputChars = this.int(400, 40_000);
        const outputChars = this.int(400, 40_000);
        const allowed = shouldApplyCostEstimate({
          estimateBytes: inputChars + outputChars,
          reportCount: this.engine.cost.getMetrics().reportCount,
          recordSessionId: P,
          ownSessionId: P,
        });
        if (!allowed) return;
        const est = this.engine.cost.recordEstimatedTokens(inputChars, outputChars, MODEL);
        this.estimates.push({
          ts: this.clock,
          usd: est.totalUsd,
          inputTokens: Math.round(inputChars / 4),
        });
        break;
      }
      case 'selfReportKnownId': {
        const known = this.calls.filter((c) => c.session === P && !c.subagent && c.kind !== 'self');
        if (known.length === 0) return;
        const call = this.pick(known);
        this.selfReport(call.usage, call.id);
        break;
      }
      case 'selfReportFreshId': {
        const call = this.newCall(P, false, 'req');
        this.selfReport(call.usage, call.id);
        break;
      }
      case 'selfReportNoId': {
        if (this.engine.sawReplaying) {
          // The same response the transcript already reported, with no id.
          const seen = this.calls.filter((c) => c.session === P && c.replaying);
          if (seen.length === 0) return;
          this.selfReport(this.pick(seen).usage);
        } else if (!this.calls.some((c) => c.session === P && c.replaying)) {
          // A platform with no watcher: the self-report is the only record.
          this.selfReport(this.newCall(P, false, 'self').usage);
        }
        break;
      }
      case 'pumpE':
        this.engine.pump();
        break;
      case 'pumpW':
        this.local.pump();
        break;
      case 'saveE':
        this.engine.save();
        break;
      case 'saveW':
        this.local.save();
        break;
      case 'restartE':
        this.engine.save();
        this.engine = new Engine(this.storagePath, this.startMs);
        break;
      case 'restartW':
        this.local.save();
        this.local = new LocalWriter(this.storagePath);
        break;
      case 'fork': {
        // `--fork-session` copies every parent line under the fork's id, then
        // adds its own turn. Only the unscoped watcher tails the fork.
        if (this.forked) return;
        this.forked = true;
        for (const c of this.calls.filter((x) => x.session === P && x.line !== undefined)) {
          if (!c.subagent) this.emit(c, this.local.ledger, FORK);
        }
        this.emit(this.newCall(FORK, false), this.local.ledger);
        break;
      }
    }
  }

  /** Drains everything, saves both writers, then restarts the engine. */
  settle(): void {
    this.step('pumpE');
    this.step('pumpW');
    this.step('saveE');
    this.step('saveW');
    this.step('restartE');
  }

  expected(session: string): { costUsd: number; subagentUsd: number; inputTokens: number } {
    const calls = this.calls.filter((c) => c.session === session);
    let costUsd = 0;
    let subagentUsd = 0;
    let inputTokens = 0;
    for (const c of calls) {
      costUsd += c.usd;
      inputTokens += c.usage.inputTokens;
      if (c.subagent) subagentUsd += c.usd;
    }
    if (session === P) {
      for (const e of this.estimates) {
        const replaced = calls.some((c) => c.replaying && !c.subagent && c.ts >= e.ts);
        if (replaced) continue;
        costUsd += e.usd;
        inputTokens += e.inputTokens;
      }
    }
    return { costUsd, subagentUsd, inputTokens };
  }

  check(): string[] {
    const problems: string[] = [];
    const store = new SessionStore({ storagePath: this.storagePath });
    const close = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 + 1e-9 * Math.abs(b);
    for (const session of [P, FORK]) {
      const want = this.expected(session);
      const file = store.loadSession(session);
      if (!file) {
        if (want.costUsd > 0) problems.push(`${session}: no session file, want $${want.costUsd}`);
        continue;
      }
      const fileCost = file.estimatedCostUsd ?? 0;
      if (!close(fileCost, want.costUsd)) {
        problems.push(`${session}: file cost ${fileCost} != want ${want.costUsd}`);
      }
      if (!close(file.subagentCostUsd, want.subagentUsd)) {
        problems.push(
          `${session}: file subagent ${file.subagentCostUsd} != want ${want.subagentUsd}`,
        );
      }
      if (file.tokensInput !== want.inputTokens) {
        problems.push(`${session}: file input tokens ${file.tokensInput} != ${want.inputTokens}`);
      }
    }
    const live = this.engine.cost.getMetrics().sessionTotalCostUsd ?? 0;
    const wantP = this.expected(P).costUsd;
    if (!close(live, wantP)) problems.push(`engine live total ${live} != want ${wantP}`);
    return problems;
  }
}

describe('usage ledger: one API call is counted once', () => {
  let storagePath: string;
  let clock: number;

  beforeEach(() => {
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    clock = Date.now() - 60 * 60 * 1000;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function run(rand: () => number, actions: readonly Action[] | null, length = 0): World {
    storagePath = mkdtempSync(join(tmpdir(), 'usage-ledger-'));
    const world = new World(storagePath, rand, (ms) => {
      clock = ms;
    });
    if (actions) for (const a of actions) world.step(a);
    else for (let i = 0; i < length; i++) world.step(ACTIONS[Math.floor(rand() * ACTIONS.length)]!);
    world.settle();
    return world;
  }

  function expectCountedOnce(world: World): void {
    const problems = world.check();
    rmSync(storagePath, { recursive: true, force: true });
    expect({ trace: world.trace, problems }).toEqual({ trace: world.trace, problems: [] });
  }

  it('random interleavings', () => {
    const failures: Array<{ seed: number; trace: string[]; problems: string[] }> = [];
    for (let seed = 1; seed <= 150; seed++) {
      const world = run(mulberry32(seed), null, 28);
      const problems = world.check();
      rmSync(storagePath, { recursive: true, force: true });
      if (problems.length > 0) failures.push({ seed, trace: world.trace, problems });
    }
    expect(failures.slice(0, 3)).toEqual([]);
  });

  // Known cases, pinned so a regression names the fix class it reopens.

  it('a buffer line re-delivered after an engine restart', () => {
    expectCountedOnce(run(mulberry32(7), ['turn', 'pumpE', 'restartE', 'redeliver', 'pumpE']));
  });

  it('the engine and the dashboard each draining part of a session', () => {
    expectCountedOnce(
      run(mulberry32(11), ['turn', 'pumpE', 'turn', 'pumpW', 'saveW', 'turn', 'pumpE', 'saveE']),
    );
  });

  it('a self-report carrying the id the transcript also reports', () => {
    expectCountedOnce(run(mulberry32(3), ['turn', 'pumpE', 'selfReportKnownId']));
  });

  it('an id-less self-report of a turn the transcript already reported', () => {
    expectCountedOnce(run(mulberry32(5), ['turn', 'pumpE', 'selfReportNoId']));
  });

  it('a byte estimate replaced by a turn the dashboard drained', () => {
    expectCountedOnce(run(mulberry32(13), ['estimate', 'saveE', 'turn', 'pumpW', 'saveW']));
  });

  it('a subagent turn after the dashboard folded the session file', () => {
    expectCountedOnce(
      run(mulberry32(17), ['turn', 'pumpW', 'saveW', 'subagentTurn', 'pumpW', 'saveW', 'saveW']),
    );
  });

  it('a fork copying the parent lines', () => {
    expectCountedOnce(run(mulberry32(19), ['turn', 'turn', 'pumpE', 'fork', 'pumpW', 'saveW']));
  });
});
