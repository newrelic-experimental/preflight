/**
 * Property test for session cost accounting: whatever order estimates, token
 * events, duplicates, self-reports, restarts, forks and a second writer arrive
 * in, a session's total is the sum of its unique API calls plus the byte
 * estimates no later exact turn has replaced yet.
 *
 * It drives the real pieces a running Preflight wires together — the billed
 * turn ledger the watchers claim through, the hook buffer, HookEventProcessor,
 * the token-usage sinks src/index.ts routes reports into (usage-recording.ts),
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
import { localDateKey } from '../lib/date.js';
import { SessionStore, buildSessionSummary } from '../storage/session-store.js';
import type { FullSessionSummary } from '../storage/session-store.js';
import type { HookEvent, TokenEvent } from '../storage/types.js';
import type { UnpricedModelUsage } from './usage-ledger.js';
import { handleReportTokens } from '../tools/cost-tools.js';
import type { TokenReport } from '../tools/cost-tools.js';
import { CostTracker } from './cost-tracker.js';
import { costSeedOf } from './first-save-baselines.js';
import { ModelUsageTracker } from './model-usage-tracker.js';
import { recordSubagentTurnUsage, recordTokenEventUsage } from './usage-recording.js';
import type { UsageSinks } from './usage-recording.js';
import { isTokenEventForThisProcess, shouldApplyCostEstimate } from './cost-estimate-gate.js';
import { LocalSessionAggregator, RepoNameResolver } from './local-session-aggregator.js';
import type { SessionTracker } from './session-tracker.js';
import { ToolSelectionScorer } from './tool-selection-scorer.js';

const P = '11111111-2222-4333-8444-555555555555';
const FORK = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const MODEL = 'claude-sonnet-4-5';
/** No price in the table: recorded at $0 and counted in `unpricedByModel`. */
const UNPRICED = 'claude-foo-9-9';
/** Priced from a sibling: counted in `estimatedByModel`. */
const SIBLING = 'claude-opus-5-9';
const MODELS = [MODEL, MODEL, MODEL, UNPRICED, SIBLING] as const;
const HOUR_MS = 60 * 60 * 1000;
/** CostTracker keeps a call this much older than now out of the day buckets. */
const LATE_MS = 49 * HOUR_MS;
const AGENT = 'agent-a1';
const TOOLS = ['transcript', 'copilot-usage', 'copilot-sdk-usage'] as const;

type Action =
  | 'turn'
  | 'lateTurn'
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
  'lateTurn',
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
  readonly model: string;
  readonly usage: TokenUsage;
  readonly usd: number;
  readonly subagent: boolean;
  /**
   * `req`: self-reported with an id first; `self`: self-reported with no id;
   * `legacy`: in the session file a pre-ledger Preflight wrote before the run.
   */
  readonly kind: 'turn' | 'req' | 'self' | 'legacy';
  /** Reported by a watcher that replays history (so it replaces estimates). */
  replaying: boolean;
  /** The buffer line a watcher wrote for it, once one has. */
  line?: HookEvent;
}

interface Estimate {
  /**
   * The model turn this estimate stands in for: the first parent turn of the
   * session made after it, the one that reads the tool payload it was sized
   * from. The estimate counts until a watcher reports that turn. This is how
   * the oracle decides replacement; the implementation's own rule is by
   * timestamp, so the two are checked against each other.
   */
  standIn?: Call;
  readonly ts: number;
  readonly usd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

type CallCounts = Record<string, { calls: number; tokens: number }>;

/** Every additive figure of a session, computed from the calls without the ledger. */
interface Expected {
  costUsd: number;
  subagentUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costByDay: Record<string, number>;
  subagentByDay: Record<string, number>;
  unpriced: CallCounts;
  unpricedByDay: Record<string, CallCounts>;
  estimated: CallCounts;
  estimatedByDay: Record<string, CallCounts>;
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
  readonly models = new ModelUsageTracker();
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
    if (persisted) {
      const seed = costSeedOf(persisted);
      this.cost.seedFromPersisted(seed.costTracker);
      this.models.seedFromPersisted(seed.modelBreakdown);
    }
    // The same sinks src/index.ts builds for a --stdio engine.
    const sinks: UsageSinks = {
      costTracker: this.cost,
      modelUsageTracker: this.models,
      localSessionAggregator: new LocalSessionAggregator(),
    };
    this.processor = new HookEventProcessor({
      store: this.store,
      onRecord: () => undefined,
      onTokenEvent: (e: TokenEvent) => {
        const own = isTokenEventForThisProcess({
          stdio: true,
          eventSessionId: e.sessionId ?? null,
          ownSessionId: P,
        });
        if (own) this.sawReplaying = true;
        recordTokenEventUsage(sinks, e, own);
      },
      onSubagentTurn: (t: SubagentTurnEvent) => {
        recordSubagentTurnUsage(sinks, t, undefined);
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
        modelUsageTracker: this.models,
        developer: 'dev',
      }),
    );
  }
}

/** A `--local` dashboard draining every buffer and writing each session's rollup. */
class LocalWriter {
  readonly ledger: BilledTurnLedger;
  readonly store: LocalStore;
  readonly aggregator = new LocalSessionAggregator();
  readonly processor: HookEventProcessor;

  constructor(readonly storagePath: string) {
    this.ledger = new BilledTurnLedger({ storagePath });
    this.store = new LocalStore(storagePath);
    // The same sinks src/index.ts builds for --local, whose own CostTracker
    // belongs to its synthetic session and is never saved.
    const sinks: UsageSinks = {
      costTracker: new CostTracker(),
      modelUsageTracker: new ModelUsageTracker(),
      localSessionAggregator: this.aggregator,
    };
    this.processor = new HookEventProcessor({
      store: this.store,
      drainAllSessions: true,
      onRecord: () => undefined,
      onTokenEvent: (e: TokenEvent) => {
        recordTokenEventUsage(
          sinks,
          e,
          isTokenEventForThisProcess({
            stdio: false,
            eventSessionId: e.sessionId ?? null,
            ownSessionId: 'local-1',
          }),
        );
      },
      onSubagentTurn: (t: SubagentTurnEvent) => {
        recordSubagentTurnUsage(sinks, t, undefined);
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
    withLegacyFile = false,
  ) {
    this.clock = Date.now();
    this.startMs = this.clock;
    if (withLegacyFile) this.writeLegacyFile();
    this.engine = new Engine(storagePath, this.startMs);
    this.local = new LocalWriter(storagePath);
  }

  /**
   * A session file written by a Preflight that predates the ledger: totals
   * only, for calls made before the run, plus a byte-estimate share no report
   * has replaced yet. Its calls were never reported again.
   */
  private writeLegacyFile(): void {
    const ts = this.clock - 2 * HOUR_MS;
    const day = localDateKey(ts);
    const legacy = [
      this.newCall(P, false, 'legacy', ts),
      this.newCall(P, false, 'legacy', ts),
      this.newCall(P, true, 'legacy', ts),
    ];
    const estUsage = usageOf({
      inputTokens: 400,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    const estUsd = this.pricer.priceUsage(estUsage, MODEL).totalUsd;
    this.estimates.push({ ts, usd: estUsd, inputTokens: 400, outputTokens: 100 });
    const sum = (f: (c: Call) => number): number => legacy.reduce((n, c) => n + f(c), 0);
    const costUsd = sum((c) => c.usd) + estUsd;
    const counts = (want: (m: string) => boolean): CallCounts | undefined => {
      const out: CallCounts = {};
      for (const c of legacy.filter((x) => want(x.model))) {
        const prior = out[c.model] ?? { calls: 0, tokens: 0 };
        out[c.model] = { calls: prior.calls + 1, tokens: prior.tokens + tokensOf(c.usage) };
      }
      return Object.keys(out).length > 0 ? out : undefined;
    };
    const unpriced = counts((m) => m === UNPRICED);
    const estimated = counts((m) => m === SIBLING);
    const subagentUsd = sum((c) => (c.subagent ? c.usd : 0));
    new SessionStore({ storagePath: this.storagePath }).saveSession({
      sessionId: P,
      startTime: ts,
      endTime: ts,
      durationMs: 0,
      toolCallCount: 1,
      developer: 'dev',
      estimatedCostUsd: costUsd,
      subagentCostUsd: subagentUsd,
      costByDayUsd: { [day]: costUsd },
      subagentCostByDayUsd: subagentUsd > 0 ? { [day]: subagentUsd } : {},
      byteEstimates: {
        costUsd: estUsd,
        inputTokens: 400,
        outputTokens: 100,
        costByModel: { [MODEL]: estUsd },
        costByDayUsd: { [day]: estUsd },
      },
      tokensInput: sum((c) => c.usage.inputTokens) + 400,
      tokensOutput: sum((c) => c.usage.outputTokens) + 100,
      tokensThinking: 0,
      tokensCacheRead: sum((c) => c.usage.cacheReadTokens),
      tokensCacheCreation: sum((c) => c.usage.cacheCreationTokens),
      cacheSavingsUsd: 0,
      modelBreakdown: {},
      costByWorkflowRunId: {},
      ...(unpriced && { unpricedByModel: unpriced }),
      ...(estimated && {
        estimatedByModel: Object.fromEntries(
          Object.entries(estimated).map(([m, c]) => [m, { ...c, estimatedFrom: 'x' }]),
        ),
      }),
    } as unknown as FullSessionSummary);
  }

  private pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.rand() * xs.length)]!;
  }

  private int(min: number, max: number): number {
    return min + Math.floor(this.rand() * (max - min + 1));
  }

  private newCall(
    session: string,
    subagent: boolean,
    kind: Call['kind'] = 'turn',
    ts = this.clock,
  ): Call {
    const model = this.pick(MODELS);
    const usage = usageOf({
      inputTokens: this.int(1, 5_000),
      outputTokens: this.int(1, 2_000),
      cacheReadTokens: this.int(0, 50_000),
      cacheCreationTokens: this.int(0, 5_000),
    });
    const call: Call = {
      id: `${kind}_${++this.seq}_${Math.floor(this.rand() * 1e9).toString(36)}`,
      session,
      ts,
      model,
      usage,
      usd: this.pricer.priceUsage(usage, model).totalUsd,
      subagent,
      kind,
      replaying: false,
    };
    this.calls.push(call);
    // An id-less self-report only happens where no watcher reports turns, and
    // by design a self-report never replaces an estimate; such a turn is not
    // what a later watcher report is compared against.
    if (session === P && !subagent && (kind === 'turn' || kind === 'req') && ts === this.clock) {
      for (const e of this.estimates) e.standIn ??= call;
    }
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
        model: call.model,
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
      model: call.model,
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

  private selfReport(call: Call, requestId?: string): void {
    const { usage } = call;
    const args: TokenReport = {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_read_tokens: usage.cacheReadTokens,
      cache_creation_tokens: usage.cacheCreationTokens,
      model: call.model,
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
        // A transcript reports turns in order, so a response already
        // self-reported by id comes before any newer turn.
        const pending = this.calls.find((c) => c.kind === 'req' && c.line === undefined);
        const call = pending ?? this.newCall(P, false);
        this.emit(call, this.rand() < 0.5 ? this.engine.ledger : this.local.ledger);
        break;
      }
      case 'lateTurn': {
        // A transcript line read more than 48 hours after it was written.
        const call = this.newCall(P, false, 'turn', this.clock - LATE_MS);
        this.emit(call, this.rand() < 0.5 ? this.engine.ledger : this.local.ledger);
        break;
      }
      case 'turnBoth': {
        const call =
          this.calls.find((c) => c.kind === 'req' && c.line === undefined) ??
          this.newCall(P, false);
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
          outputTokens: Math.round(outputChars / 4),
        });
        break;
      }
      case 'selfReportKnownId': {
        const known = this.calls.filter(
          (c) => c.session === P && !c.subagent && (c.kind === 'turn' || c.kind === 'req'),
        );
        if (known.length === 0) return;
        const call = this.pick(known);
        this.selfReport(call, call.id);
        break;
      }
      case 'selfReportFreshId': {
        const call = this.newCall(P, false, 'req');
        this.selfReport(call, call.id);
        break;
      }
      case 'selfReportNoId': {
        if (this.engine.sawReplaying) {
          // The same response the transcript already reported, with no id.
          const seen = this.calls.filter((c) => c.session === P && c.replaying);
          if (seen.length === 0) return;
          this.selfReport(this.pick(seen));
        } else if (!this.calls.some((c) => c.session === P && c.replaying)) {
          // A platform with no watcher: the self-report is the only record.
          this.selfReport(this.newCall(P, false, 'self'));
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

  expected(session: string): Expected {
    const want: Expected = {
      costUsd: 0,
      subagentUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costByDay: {},
      subagentByDay: {},
      unpriced: {},
      unpricedByDay: {},
      estimated: {},
      estimatedByDay: {},
    };
    const add = (rec: Record<string, number>, key: string, v: number): void => {
      rec[key] = (rec[key] ?? 0) + v;
    };
    const count = (rec: CallCounts, model: string, tokens: number): void => {
      const prior = rec[model] ?? { calls: 0, tokens: 0 };
      rec[model] = { calls: prior.calls + 1, tokens: prior.tokens + tokens };
    };
    const calls = this.calls.filter((c) => c.session === session);
    for (const c of calls) {
      // Late by the time any process records it: the run lasts minutes.
      const day = c.ts < this.startMs - 48 * HOUR_MS ? null : localDateKey(c.ts);
      want.costUsd += c.usd;
      want.inputTokens += c.usage.inputTokens;
      want.outputTokens += c.usage.outputTokens;
      want.cacheReadTokens += c.usage.cacheReadTokens;
      want.cacheCreationTokens += c.usage.cacheCreationTokens;
      if (c.subagent) want.subagentUsd += c.usd;
      if (day !== null) {
        add(want.costByDay, day, c.usd);
        if (c.subagent) add(want.subagentByDay, day, c.usd);
      }
      const tokens = tokensOf(c.usage);
      const [byModel, byDay] =
        c.model === UNPRICED
          ? [want.unpriced, want.unpricedByDay]
          : c.model === SIBLING
            ? [want.estimated, want.estimatedByDay]
            : [null, null];
      if (byModel && byDay) {
        count(byModel, c.model, tokens);
        if (day !== null) count((byDay[day] ??= {}), c.model, tokens);
      }
    }
    if (session === P) {
      for (const e of this.estimates) {
        if (e.standIn?.replaying) continue;
        want.costUsd += e.usd;
        want.inputTokens += e.inputTokens;
        want.outputTokens += e.outputTokens;
        add(want.costByDay, localDateKey(e.ts), e.usd);
      }
    }
    return want;
  }

  check(): string[] {
    const problems: string[] = [];
    const store = new SessionStore({ storagePath: this.storagePath });
    for (const session of [P, FORK]) {
      const want = this.expected(session);
      const file = store.loadSession(session);
      if (!file) {
        if (want.costUsd > 0) problems.push(`${session}: no session file, want $${want.costUsd}`);
        continue;
      }
      compare(problems, `${session} file`, want, {
        costUsd: file.estimatedCostUsd ?? 0,
        subagentUsd: file.subagentCostUsd,
        inputTokens: file.tokensInput,
        outputTokens: file.tokensOutput,
        cacheReadTokens: file.tokensCacheRead,
        cacheCreationTokens: file.tokensCacheCreation,
        costByDay: file.costByDayUsd ?? {},
        subagentByDay: file.subagentCostByDayUsd ?? {},
        unpriced: callCounts(file.unpricedByModel),
        unpricedByDay: callCountsByDay(file.unpricedByDay),
        estimated: callCounts(file.estimatedByModel),
        estimatedByDay: callCountsByDay(file.estimatedByDay),
      });
    }
    const m = this.engine.cost.getMetrics();
    compare(problems, 'engine live', this.expected(P), {
      costUsd: m.sessionTotalCostUsd ?? 0,
      subagentUsd: m.subagentCostUsd,
      inputTokens: m.totalInputTokens,
      outputTokens: m.totalOutputTokens,
      cacheReadTokens: m.totalCacheReadTokens,
      cacheCreationTokens: m.totalCacheCreationTokens,
      costByDay: m.costByDayUsd,
      subagentByDay: m.subagentCostByDayUsd,
      unpriced: callCounts(m.unpricedByModel),
      unpricedByDay: callCountsByDay(m.unpricedByDay),
      estimated: callCounts(m.estimatedByModel),
      estimatedByDay: callCountsByDay(m.estimatedByDay),
    });
    return problems;
  }
}

function tokensOf(u: TokenUsage): number {
  return (
    u.inputTokens + u.outputTokens + u.thinkingTokens + u.cacheReadTokens + u.cacheCreationTokens
  );
}

function callCounts(rec: Readonly<Record<string, UnpricedModelUsage>> | undefined): CallCounts {
  return Object.fromEntries(
    Object.entries(rec ?? {}).map(([m, c]) => [m, { calls: c.calls, tokens: c.tokens }]),
  );
}

function callCountsByDay(
  rec: Readonly<Record<string, Readonly<Record<string, UnpricedModelUsage>>>> | undefined,
): Record<string, CallCounts> {
  return Object.fromEntries(Object.entries(rec ?? {}).map(([d, m]) => [d, callCounts(m)]));
}

const closeTo = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 + 1e-9 * Math.abs(b);

function sameNumbers(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((k) => closeTo(a[k] ?? 0, b[k] ?? 0));
}

function sameCounts(a: Record<string, CallCounts>, b: Record<string, CallCounts>): boolean {
  const days = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...days].every(
    (d) => JSON.stringify(sortKeys(a[d] ?? {})) === JSON.stringify(sortKeys(b[d] ?? {})),
  );
}

function sortKeys<T>(o: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(o).sort(([x], [y]) => x.localeCompare(y)));
}

function compare(problems: string[], where: string, want: Expected, got: Expected): void {
  for (const k of [
    'costUsd',
    'subagentUsd',
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheCreationTokens',
  ] as const) {
    if (!closeTo(got[k], want[k])) problems.push(`${where} ${k}: ${got[k]} != ${want[k]}`);
  }
  for (const k of ['costByDay', 'subagentByDay'] as const) {
    if (!sameNumbers(got[k], want[k])) {
      problems.push(`${where} ${k}: ${JSON.stringify(got[k])} != ${JSON.stringify(want[k])}`);
    }
  }
  for (const k of ['unpriced', 'estimated'] as const) {
    if (!sameCounts({ all: got[k] }, { all: want[k] })) {
      problems.push(`${where} ${k}: ${JSON.stringify(got[k])} != ${JSON.stringify(want[k])}`);
    }
  }
  for (const k of ['unpricedByDay', 'estimatedByDay'] as const) {
    if (!sameCounts(got[k], want[k])) {
      problems.push(`${where} ${k}: ${JSON.stringify(got[k])} != ${JSON.stringify(want[k])}`);
    }
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

  function run(
    rand: () => number,
    actions: readonly Action[] | null,
    length = 0,
    withLegacyFile = false,
  ): World {
    storagePath = mkdtempSync(join(tmpdir(), 'usage-ledger-'));
    const world = new World(
      storagePath,
      rand,
      (ms) => {
        clock = ms;
      },
      withLegacyFile,
    );
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
    for (let seed = 1; seed <= 200; seed++) {
      // Every third run starts from a session file a pre-ledger Preflight wrote.
      const world = run(mulberry32(seed), null, 28, seed % 3 === 0);
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

  it('a turn read more than 48 hours late, drained by either writer', () => {
    expectCountedOnce(run(mulberry32(23), ['lateTurn', 'pumpW', 'saveW', 'lateTurn', 'pumpE']));
  });

  it('a pre-ledger session file, then new turns the dashboard saves first', () => {
    expectCountedOnce(run(mulberry32(29), ['turn', 'pumpW', 'saveW', 'turn', 'pumpE'], 0, true));
  });

  it('a pre-ledger session file the dashboard saves new turns into', () => {
    // No settle: the engine's own save would otherwise restore the old totals.
    storagePath = mkdtempSync(join(tmpdir(), 'usage-ledger-'));
    const world = new World(
      storagePath,
      mulberry32(37),
      (ms) => {
        clock = ms;
      },
      true,
    );
    for (const a of ['turn', 'pumpW', 'saveW'] as const) world.step(a);
    const problems = world.check().filter((p) => !p.startsWith('engine live'));
    rmSync(storagePath, { recursive: true, force: true });
    expect({ trace: world.trace, problems }).toEqual({ trace: world.trace, problems: [] });
  });

  it('a pre-ledger byte estimate replaced by a new turn', () => {
    expectCountedOnce(run(mulberry32(31), ['restartE', 'turn', 'pumpE', 'saveE'], 0, true));
  });

  it('a fork copying the parent lines', () => {
    expectCountedOnce(run(mulberry32(19), ['turn', 'turn', 'pumpE', 'fork', 'pumpW', 'saveW']));
  });
});
