import { randomUUID } from 'node:crypto';

import { calculateCost } from '../shared/index.js';
import type { TokenUsage } from '../shared/index.js';
import type { TokenCategoryCost, ToolCallRecord, TokenEvent } from '../storage/types.js';
import { categoryCostFromBreakdown, scalePricedBreakdown } from './category-cost.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TurnCostAttribution {
  readonly turnId: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly toolCalls: string[];
  readonly toolNames: string[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly model: string;
  readonly estimatedCostUsd: number;
  readonly costPerToolCall: number;
  /**
   * Owning session — tagged from the `ToolCallRecord.sessionId` that
   * started the turn's pending accumulator. `getMetrics(sessionId)` uses
   * this to scope the dashboard's session-detail drawer to the session
   * actually selected, instead of whichever session(s) this process-global
   * tracker happened to have most recently accumulated.
   */
  readonly sessionId: string | null;
}

export interface ToolTypeCostEntry {
  readonly totalCost: number;
  readonly callCount: number;
  readonly avgCost: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  /** input + output + cache-read + cache-creation tokens across `callCount`'s attributed calls; mirrors SkillCostEntry.tokens. */
  readonly tokens: number;
  /** Per-category USD priced per token event's model; absent when this tool type has no attributed events. */
  readonly cost?: TokenCategoryCost;
}

/**
 * Per-skill row aggregating both `Skill` tool invocations and slash-command
 * invocations. A `Skill` tool call (channel `Skill`) receives an even split
 * of its turn's cost; a slash invocation (channel `SlashCommand`) receives the
 * full cost from that prompt to the next. `callCount` counts both channels
 * (one per `Skill` tool call, one per slash invocation); `totalDurationMs`
 * measures only `Skill` calls (slash commands have none). Cost and tokens
 * cover `attributedCallCount` of them.
 */
export interface SkillCostEntry {
  readonly callCount: number;
  readonly attributedCallCount: number;
  readonly totalCost: number;
  readonly avgCost: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly totalDurationMs: number;
  /**
   * Authoritative token total: `inputTokens + outputTokens + cacheReadTokens
   * + cacheCreationTokens` for a live (this-process) entry. `GET
   * /api/cost-per-tool` folds in other today sessions' persisted attribution
   * buckets, which carry only a token total and no per-category split —
   * those merged sessions' tokens land here too, so this field (not the
   * split fields, which stay live-only) is the one to read for a skill's
   * total token usage.
   */
  readonly tokens: number;
  /**
   * Per-category USD priced per token event's model, then even-split across
   * the turn's tools (same split as the token fields). Absent when
   * `attributedCallCount` is 0. Thinking USD is omitted — see
   * {@link TokenCategoryCost}.
   */
  readonly cost?: TokenCategoryCost;
}

export interface TurnToolCall {
  readonly toolUseId: string;
  readonly toolName: string;
  /** Set only for Skill calls that carried a skill name; mirrors the bucket identity. */
  readonly skillName: string | null;
}

/** What recordTokenEvent() hands back once a turn's cost is known. */
export interface ClosedTurn {
  readonly id: string;
  readonly attribution: TurnCostAttribution;
  readonly calls: readonly TurnToolCall[];
  /** `ToolCallRecord.platform` of the turn's first call; undefined when the hook carried no stamp. */
  readonly platform: string | undefined;
}

export interface CostAttributionMetrics {
  readonly turns: TurnCostAttribution[];
  readonly costByToolType: Record<string, ToolTypeCostEntry>;
  readonly costBySkill: Record<string, SkillCostEntry>;
  readonly totalAttributedCost: number;
  readonly attributionRate: number;
  /**
   * Count of token events (or, on overflow/staleness, whole pending turns)
   * that could not be attributed to any tool call. A rising count alongside
   * a low `attributionRate` means turns are being lost — see `recordTokenEvent()`.
   */
  readonly droppedTokenEvents: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Tool calls within this gap of each other are treated as one "turn" (one
// LLM response driving a burst of tool use). Chosen to bridge normal
// back-to-back tool latency without merging genuinely separate turns.
const TURN_GAP_MS = 2_000;
// A token event closes the OLDEST still-open pending turn (see `pendingTurns`
// below) as long as it arrives after that turn ended — no upper bound.
// Token usage is reported asynchronously (transcript polling) and the model
// may spend anywhere from milliseconds to minutes (extended thinking) between
// a tool call ending and the response that consumes its result, so there is
// no fixed delay that is both short enough to avoid false negatives and long
// enough to avoid false positives.
//
// `STALE_PENDING_TURN_MS` exists only to self-heal the queue if a closing
// token event is ever genuinely lost (not merely delayed) — a crashed
// watcher, a rotated/truncated transcript. Without it, one truly-lost event
// would permanently shift every later token event onto the wrong pending
// turn. It is deliberately far longer than any plausible thinking time.
const STALE_PENDING_TURN_MS = 10 * 60 * 1000;
// Safety cap on the queue itself so a sustained failure to emit token events
// (not just one lost event) can't grow this unboundedly.
const MAX_PENDING_TURNS = 20;
// Bounds memory for long sessions; only the most recent turns are needed for
// the cost-by-tool-type breakdown this class serves.
const MAX_TURNS = 200;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface BucketIdentity {
  readonly toolName: string;
  /**
   * Set only for `Skill` tool records that carried a skill name, or for
   * `SlashCommand` records from slash-invoked skills.
   */
  readonly skillName: string | null;
}

/**
 * One row of the attribution table. `callCount` and `totalDurationMs` are
 * measured on every call in recordToolCall(); the rest are written in
 * recordTokenEvent() as an even split of the turn's token event, so they
 * cover `attributedCallCount` of the `callCount` calls.
 */
interface AttributionBucket extends BucketIdentity {
  callCount: number;
  attributedCallCount: number;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  inputUsd: number;
  outputUsd: number;
  cacheReadUsd: number;
  cacheCreationUsd: number;
  totalDurationMs: number;
}

const BUCKET_COUNTERS = [
  'callCount',
  'attributedCallCount',
  'totalCost',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheCreationTokens',
  'inputUsd',
  'outputUsd',
  'cacheReadUsd',
  'cacheCreationUsd',
  'totalDurationMs',
] as const;

interface PendingTurn {
  turnId: string;
  startTime: number;
  endTime: number;
  toolCalls: Array<{
    toolUseId: string;
    toolName: string;
    skillName: string | null;
    bucketKey: string;
  }>;
  platform: string | undefined;
}

// A dedicated bucket for records/events with no sessionId (null/undefined) —
// distinct from any real session id string so it can never collide with one.
const NULL_SESSION_KEY = '__no_session__';
// Mirrors ContextTrackerRegistry's default (src/metrics/context-tracker.ts)
// so a long-running `--local` process watching many concurrent/historical
// sessions doesn't grow this map unboundedly.
const DEFAULT_MAX_SESSIONS = 50;

interface SessionState {
  turns: TurnCostAttribution[];
  /**
   * FIFO queue of tool-call bursts awaiting a closing token event, oldest
   * first. A queue (not a single slot) so a burst of tool calls started
   * before the previous burst's token event has arrived is never silently
   * discarded — see `recordToolCall()`.
   */
  pendingTurns: PendingTurn[];
  buckets: Map<string, AttributionBucket>;
  totalAttributedCost: number;
  totalToolCalls: number;
  attributedToolCalls: number;
  activeSlashSkill: string | null;
  droppedTokenEvents: number;
}

function createSessionState(): SessionState {
  return {
    turns: [],
    pendingTurns: [],
    buckets: new Map(),
    totalAttributedCost: 0,
    totalToolCalls: 0,
    attributedToolCalls: 0,
    activeSlashSkill: null,
    droppedTokenEvents: 0,
  };
}

// ---------------------------------------------------------------------------
// Bucket helpers
// ---------------------------------------------------------------------------

function bucketIdentityOf(record: ToolCallRecord): BucketIdentity {
  const skillName =
    record.toolName === 'Skill' && record.skillName !== undefined && record.skillName !== ''
      ? record.skillName
      : null;
  return { toolName: record.toolName, skillName };
}

/** Lookup key only. It is never parsed; the bucket carries its own identity. */
function bucketKeyOf(id: BucketIdentity): string {
  return id.skillName === null ? id.toolName : `${id.toolName} ${id.skillName}`;
}

function createBucket(id: BucketIdentity): AttributionBucket {
  return {
    toolName: id.toolName,
    skillName: id.skillName,
    callCount: 0,
    attributedCallCount: 0,
    totalCost: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    inputUsd: 0,
    outputUsd: 0,
    cacheReadUsd: 0,
    cacheCreationUsd: 0,
    totalDurationMs: 0,
  };
}

function getOrCreateBucket(
  buckets: Map<string, AttributionBucket>,
  key: string,
  id: BucketIdentity,
): AttributionBucket {
  let bucket = buckets.get(key);
  if (bucket === undefined) {
    bucket = createBucket(id);
    buckets.set(key, bucket);
  }
  return bucket;
}

// ---------------------------------------------------------------------------
// TurnCostAttributor
// ---------------------------------------------------------------------------

/**
 * Per-session partitioned — each session's turns/pending-accumulator/
 * buckets live in their own bucket (keyed by
 * `ToolCallRecord.sessionId`/`TokenEvent.sessionId`), so tool calls from two
 * concurrently-live sessions (`--local` mode's `drainAllSessions`) can never
 * merge into one turn or blend into one session's totals. `getMetrics()`
 * without a `sessionId` returns a real aggregate across every session this
 * process has seen (summed/merged), matching `DecisionTracker.getMetrics()`'s
 * "no-arg = everything" convention — not a "most recently touched session"
 * heuristic, which `nr_observe_get_cost_per_tool` (a process-wide MCP tool
 * with no single session in view) would otherwise silently receive instead
 * of the sum callers actually expect.
 */
export class TurnCostAttributor {
  private readonly sessions = new Map<string, SessionState>();
  private readonly rateMultiplier: number;

  constructor(options?: { rateMultiplier?: number }) {
    this.rateMultiplier = options?.rateMultiplier ?? 1;
  }

  private getOrCreateSession(sessionId: string | null | undefined): SessionState {
    const key = sessionId ?? NULL_SESSION_KEY;
    let state = this.sessions.get(key);
    if (state) {
      // Move to the end so the DEFAULT_MAX_SESSIONS eviction below stays a
      // real LRU (evicts the least-recently-touched session, not just the
      // least-recently-created one).
      this.sessions.delete(key);
      this.sessions.set(key, state);
      return state;
    }
    if (this.sessions.size >= DEFAULT_MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest !== undefined) this.sessions.delete(oldest);
    }
    state = createSessionState();
    this.sessions.set(key, state);
    return state;
  }

  recordToolCall(record: ToolCallRecord, turnId?: string): void {
    const state = this.getOrCreateSession(record.sessionId);
    state.totalToolCalls++;
    const endTime = record.timestamp + (record.durationMs ?? 0);

    const id = bucketIdentityOf(record);
    const key = bucketKeyOf(id);
    const bucket = getOrCreateBucket(state.buckets, key, id);
    bucket.callCount++;
    bucket.totalDurationMs += record.durationMs ?? 0;

    const last = state.pendingTurns[state.pendingTurns.length - 1];
    if (last && record.timestamp - last.endTime <= TURN_GAP_MS) {
      last.endTime = endTime;
      last.toolCalls.push({
        toolUseId: record.toolUseId,
        toolName: record.toolName,
        skillName: id.skillName,
        bucketKey: key,
      });
      return;
    }

    state.pendingTurns.push({
      turnId: turnId ?? randomUUID(),
      startTime: record.timestamp,
      endTime,
      toolCalls: [
        {
          toolUseId: record.toolUseId,
          toolName: record.toolName,
          skillName: id.skillName,
          bucketKey: key,
        },
      ],
      platform: typeof record.platform === 'string' ? record.platform : undefined,
    });

    // A new burst starting while MAX_PENDING_TURNS earlier bursts are still
    // unclosed means token events have stopped arriving entirely (not just
    // been delayed) — evict the oldest rather than grow unboundedly.
    if (state.pendingTurns.length > MAX_PENDING_TURNS) {
      state.pendingTurns.shift();
      state.droppedTokenEvents++;
    }
  }

  recordSlashCommand(sessionId: string | null | undefined, skillName: string | null): void {
    const state = this.getOrCreateSession(sessionId);
    if (skillName) {
      state.activeSlashSkill = skillName;
      const id: BucketIdentity = { toolName: 'SlashCommand', skillName };
      const key = bucketKeyOf(id);
      const bucket = getOrCreateBucket(state.buckets, key, id);
      bucket.callCount++;
    } else {
      state.activeSlashSkill = null;
    }
  }

  recordTokenEvent(event: TokenEvent): ClosedTurn | null {
    const state = this.getOrCreateSession(event.sessionId);

    // Self-heal: a pending turn sitting unclosed for longer than any
    // plausible thinking time means its real closing event was lost, not
    // merely delayed. Evict it so this event can't be misattributed to it —
    // and so every turn queued behind it doesn't inherit the same offset.
    while (
      state.pendingTurns.length > 0 &&
      event.timestamp - state.pendingTurns[0].endTime > STALE_PENDING_TURN_MS
    ) {
      state.pendingTurns.shift();
      state.droppedTokenEvents++;
    }

    const pendingTurn = state.pendingTurns[0];
    if (!pendingTurn) {
      state.droppedTokenEvents++;
      return null;
    }

    // The event must postdate the turn it's closing — one that doesn't can't
    // belong to it (this turn hadn't even finished yet). Silently drop it
    // rather than risk mis-attributing cost to the wrong turn. Dropped
    // events show up as a lower `attributionRate` and a rising
    // `droppedTokenEvents`, not as an error.
    const timeSinceLastTool = event.timestamp - pendingTurn.endTime;
    if (timeSinceLastTool < 0) {
      state.droppedTokenEvents++;
      return null;
    }
    state.pendingTurns.shift();

    const usage: TokenUsage = {
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      thinkingTokens: 0,
      cacheReadTokens: event.cacheReadTokens,
      cacheCreationTokens: event.cacheCreationTokens,
      totalTokens: event.inputTokens + event.outputTokens,
    };

    const priced = scalePricedBreakdown(calculateCost(event.model, usage), this.rateMultiplier);
    const costUsd = priced.totalUsd;
    const toolCount = pendingTurn.toolCalls.length;
    const costPerTool = toolCount > 0 ? costUsd / toolCount : 0;
    const perToolCategory = categoryCostFromBreakdown(priced, toolCount > 0 ? toolCount : 1);

    const attribution: TurnCostAttribution = {
      turnId: pendingTurn.turnId,
      startTime: pendingTurn.startTime,
      endTime: pendingTurn.endTime,
      toolCalls: pendingTurn.toolCalls.map((tc) => tc.toolUseId),
      toolNames: pendingTurn.toolCalls.map((tc) => tc.toolName),
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheReadTokens: event.cacheReadTokens,
      cacheCreationTokens: event.cacheCreationTokens,
      model: event.model,
      estimatedCostUsd: costUsd,
      costPerToolCall: costPerTool,
      sessionId: event.sessionId ?? null,
    };

    state.turns.push(attribution);
    if (state.turns.length > MAX_TURNS) {
      state.turns.shift();
    }

    state.totalAttributedCost += costUsd;
    state.attributedToolCalls += toolCount;

    for (const tc of pendingTurn.toolCalls) {
      const bucket = state.buckets.get(tc.bucketKey);
      if (bucket === undefined) continue;
      bucket.attributedCallCount++;
      bucket.totalCost += costPerTool;
      bucket.inputTokens += event.inputTokens / toolCount;
      bucket.outputTokens += event.outputTokens / toolCount;
      bucket.cacheReadTokens += event.cacheReadTokens / toolCount;
      bucket.cacheCreationTokens += event.cacheCreationTokens / toolCount;
      bucket.inputUsd += perToolCategory.inputUsd;
      bucket.outputUsd += perToolCategory.outputUsd;
      bucket.cacheReadUsd += perToolCategory.cacheReadUsd;
      bucket.cacheCreationUsd += perToolCategory.cacheCreationUsd;
    }

    if (state.activeSlashSkill !== null) {
      const id: BucketIdentity = { toolName: 'SlashCommand', skillName: state.activeSlashSkill };
      const key = bucketKeyOf(id);
      const slashBucket = getOrCreateBucket(state.buckets, key, id);
      slashBucket.attributedCallCount++;
      slashBucket.totalCost += costUsd;
      slashBucket.inputTokens += event.inputTokens;
      slashBucket.outputTokens += event.outputTokens;
      slashBucket.cacheReadTokens += event.cacheReadTokens;
      slashBucket.cacheCreationTokens += event.cacheCreationTokens;
      const slashCategory = categoryCostFromBreakdown(priced, 1);
      slashBucket.inputUsd += slashCategory.inputUsd;
      slashBucket.outputUsd += slashCategory.outputUsd;
      slashBucket.cacheReadUsd += slashCategory.cacheReadUsd;
      slashBucket.cacheCreationUsd += slashCategory.cacheCreationUsd;
    }

    // Minted here rather than reusing `attribution.turnId`: the caller's turn
    // id comes from the process-global TurnTracker and can repeat across two
    // attributor turns, so it cannot group AiTurnCost rows.
    const closedTurn: ClosedTurn = {
      id: randomUUID(),
      attribution,
      calls: pendingTurn.toolCalls.map((tc) => ({
        toolUseId: tc.toolUseId,
        toolName: tc.toolName,
        skillName: tc.skillName,
      })),
      platform: pendingTurn.platform,
    };

    return closedTurn;
  }

  getCostForToolCall(
    toolUseId: string,
  ): { estimatedTurnCostUsd: number; costPerToolCallUsd: number } | null {
    for (const state of this.sessions.values()) {
      for (const turn of state.turns) {
        if (turn.toolCalls.includes(toolUseId)) {
          return {
            estimatedTurnCostUsd: turn.estimatedCostUsd,
            costPerToolCallUsd: turn.costPerToolCall,
          };
        }
      }
    }
    return null;
  }

  /**
   * @param sessionId When provided, scopes every stat to that session's own
   *   bucket. Omit to get a real aggregate across every session in
   *   `this.sessions` — sums (`totalAttributedCost`, `totalToolCalls`,
   *   `attributedToolCalls`), merges (`buckets`), and concatenates
   *   (`turns`, capped back down to `MAX_TURNS` by recency) — matching
   *   `DecisionTracker.getMetrics()`'s "no-arg = everything" convention.
   *   Used by callers with no single session in view, e.g. the
   *   `nr_observe_get_cost_per_tool` MCP tool.
   */
  getMetrics(sessionId?: string): CostAttributionMetrics {
    const empty: CostAttributionMetrics = {
      turns: [],
      costByToolType: {},
      costBySkill: {},
      totalAttributedCost: 0,
      attributionRate: 0,
      droppedTokenEvents: 0,
    };

    if (sessionId !== undefined) {
      const state = this.sessions.get(sessionId);
      if (!state) return empty;
      return TurnCostAttributor.buildMetrics(state);
    }

    if (this.sessions.size === 0) return empty;
    return TurnCostAttributor.buildMetrics(this.aggregateAllSessions());
  }

  /** Sums/merges every session bucket into one `SessionState`-shaped value. */
  private aggregateAllSessions(): SessionState {
    const aggregate = createSessionState();
    for (const state of this.sessions.values()) {
      aggregate.turns.push(...state.turns);
      aggregate.totalAttributedCost += state.totalAttributedCost;
      aggregate.totalToolCalls += state.totalToolCalls;
      aggregate.attributedToolCalls += state.attributedToolCalls;
      aggregate.droppedTokenEvents += state.droppedTokenEvents;
      for (const [key, bucket] of state.buckets) {
        const merged = getOrCreateBucket(aggregate.buckets, key, bucket);
        for (const counter of BUCKET_COUNTERS) merged[counter] += bucket[counter];
      }
    }
    // Same cap as each per-session bucket already enforces on insert — keep
    // only the most recent MAX_TURNS across the merged set, by start time.
    if (aggregate.turns.length > MAX_TURNS) {
      aggregate.turns.sort((a, b) => a.startTime - b.startTime);
      aggregate.turns = aggregate.turns.slice(-MAX_TURNS);
    }
    return aggregate;
  }

  private static buildMetrics(state: SessionState): CostAttributionMetrics {
    const toolTypeAccum = new Map<
      string,
      {
        totalCost: number;
        callCount: number;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
        inputUsd: number;
        outputUsd: number;
        cacheReadUsd: number;
        cacheCreationUsd: number;
      }
    >();
    const skillAccum = new Map<string, Pick<AttributionBucket, (typeof BUCKET_COUNTERS)[number]>>();

    for (const bucket of state.buckets.values()) {
      // costByToolType predates the buckets table and only ever listed tools
      // that received a token event, so the fold keeps that contract. The
      // SlashCommand channel isn't a real tool call — it charges a turn's
      // full, unsplit cost to track skill usage (see recordSlashCommand()),
      // and folding it in here would double-count against whichever real
      // tool(s) that same turn already split its cost across.
      if (bucket.toolName !== 'SlashCommand' && bucket.attributedCallCount > 0) {
        let entry = toolTypeAccum.get(bucket.toolName);
        if (entry === undefined) {
          entry = {
            totalCost: 0,
            callCount: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            inputUsd: 0,
            outputUsd: 0,
            cacheReadUsd: 0,
            cacheCreationUsd: 0,
          };
          toolTypeAccum.set(bucket.toolName, entry);
        }
        entry.totalCost += bucket.totalCost;
        entry.callCount += bucket.attributedCallCount;
        entry.inputTokens += bucket.inputTokens;
        entry.outputTokens += bucket.outputTokens;
        entry.cacheReadTokens += bucket.cacheReadTokens;
        entry.cacheCreationTokens += bucket.cacheCreationTokens;
        entry.inputUsd += bucket.inputUsd;
        entry.outputUsd += bucket.outputUsd;
        entry.cacheReadUsd += bucket.cacheReadUsd;
        entry.cacheCreationUsd += bucket.cacheCreationUsd;
      }

      if (bucket.skillName !== null) {
        let entry = skillAccum.get(bucket.skillName);
        if (entry === undefined) {
          entry = {} as Pick<AttributionBucket, (typeof BUCKET_COUNTERS)[number]>;
          for (const counter of BUCKET_COUNTERS) entry[counter] = 0;
          skillAccum.set(bucket.skillName, entry);
        }
        for (const counter of BUCKET_COUNTERS) entry[counter] += bucket[counter];
      }
    }

    const costBySkill: Record<string, SkillCostEntry> = {};
    for (const [skillName, entry] of skillAccum) {
      costBySkill[skillName] = {
        callCount: entry.callCount,
        attributedCallCount: entry.attributedCallCount,
        totalCost: entry.totalCost,
        avgCost: entry.attributedCallCount > 0 ? entry.totalCost / entry.attributedCallCount : 0,
        inputTokens: Math.round(entry.inputTokens),
        outputTokens: Math.round(entry.outputTokens),
        cacheReadTokens: Math.round(entry.cacheReadTokens),
        cacheCreationTokens: Math.round(entry.cacheCreationTokens),
        totalDurationMs: entry.totalDurationMs,
        tokens:
          Math.round(entry.inputTokens) +
          Math.round(entry.outputTokens) +
          Math.round(entry.cacheReadTokens) +
          Math.round(entry.cacheCreationTokens),
        ...(entry.attributedCallCount > 0
          ? {
              cost: {
                inputUsd: entry.inputUsd,
                outputUsd: entry.outputUsd,
                cacheReadUsd: entry.cacheReadUsd,
                cacheCreationUsd: entry.cacheCreationUsd,
              },
            }
          : {}),
      };
    }

    const costByToolType: Record<string, ToolTypeCostEntry> = {};
    for (const [tool, entry] of toolTypeAccum) {
      const inputTokens = Math.round(entry.inputTokens);
      const outputTokens = Math.round(entry.outputTokens);
      const cacheReadTokens = Math.round(entry.cacheReadTokens);
      const cacheCreationTokens = Math.round(entry.cacheCreationTokens);
      costByToolType[tool] = {
        totalCost: entry.totalCost,
        callCount: entry.callCount,
        avgCost: entry.callCount > 0 ? entry.totalCost / entry.callCount : 0,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        tokens: inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
        cost: {
          inputUsd: entry.inputUsd,
          outputUsd: entry.outputUsd,
          cacheReadUsd: entry.cacheReadUsd,
          cacheCreationUsd: entry.cacheCreationUsd,
        },
      };
    }

    return {
      turns: [...state.turns],
      costByToolType,
      costBySkill,
      totalAttributedCost: state.totalAttributedCost,
      attributionRate:
        state.totalToolCalls > 0 ? state.attributedToolCalls / state.totalToolCalls : 0,
      droppedTokenEvents: state.droppedTokenEvents,
    };
  }

  reset(_sessionId?: string): void {
    this.sessions.clear();
  }
}
