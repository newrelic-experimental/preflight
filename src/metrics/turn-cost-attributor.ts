import { randomUUID } from 'node:crypto';

import { calculateCost } from '../shared/index.js';
import type { TokenUsage } from '../shared/index.js';
import type { ToolCallRecord, TokenEvent } from '../storage/types.js';

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
}

/** Per-skill row. `callCount` and `totalDurationMs` are measured on every call; cost and tokens cover `attributedCallCount` of them. */
export interface SkillCostEntry {
  readonly callCount: number;
  readonly attributedCallCount: number;
  readonly totalCost: number;
  readonly avgCost: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly totalDurationMs: number;
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
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Tool calls within this gap of each other are treated as one "turn" (one
// LLM response driving a burst of tool use). Chosen to bridge normal
// back-to-back tool latency without merging genuinely separate turns.
const TURN_GAP_MS = 2_000;
// A token event is attributed to the pending turn only if it arrives within
// this window after the turn's last tool call — token usage is reported
// asynchronously, so some slack is needed, but too much risks attributing
// a later turn's tokens to this one.
const TOKEN_MATCH_WINDOW_MS = 5_000;
// Bounds memory for long sessions; only the most recent turns are needed for
// the cost-by-tool-type breakdown this class serves.
const MAX_TURNS = 200;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface BucketIdentity {
  readonly toolName: string;
  /** Set only for `Skill` records that carried a skill name. */
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
  totalDurationMs: number;
}

const BUCKET_COUNTERS = [
  'callCount',
  'attributedCallCount',
  'totalCost',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
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
  pendingTurn: PendingTurn | null;
  buckets: Map<string, AttributionBucket>;
  totalAttributedCost: number;
  totalToolCalls: number;
  attributedToolCalls: number;
}

function createSessionState(): SessionState {
  return {
    turns: [],
    pendingTurn: null,
    buckets: new Map(),
    totalAttributedCost: 0,
    totalToolCalls: 0,
    attributedToolCalls: 0,
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

    if (state.pendingTurn && record.timestamp - state.pendingTurn.endTime <= TURN_GAP_MS) {
      state.pendingTurn.endTime = endTime;
      state.pendingTurn.toolCalls.push({
        toolUseId: record.toolUseId,
        toolName: record.toolName,
        skillName: id.skillName,
        bucketKey: key,
      });
    } else {
      state.pendingTurn = {
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
      };
    }
  }

  recordTokenEvent(event: TokenEvent): ClosedTurn | null {
    const state = this.getOrCreateSession(event.sessionId);
    if (!state.pendingTurn) return null;

    // A token event outside the match window can't be reliably tied to the
    // pending turn — silently drop it rather than risk mis-attributing cost
    // to the wrong turn. Dropped events show up as a lower `attributionRate`
    // in getMetrics(), not as an error.
    const timeSinceLastTool = event.timestamp - state.pendingTurn.endTime;
    if (timeSinceLastTool < 0 || timeSinceLastTool > TOKEN_MATCH_WINDOW_MS) return null;

    const usage: TokenUsage = {
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      thinkingTokens: 0,
      cacheReadTokens: event.cacheReadTokens,
      cacheCreationTokens: event.cacheCreationTokens,
      totalTokens: event.inputTokens + event.outputTokens,
    };

    const breakdown = calculateCost(event.model, usage);
    const costUsd = breakdown.totalUsd * this.rateMultiplier;
    const toolCount = state.pendingTurn.toolCalls.length;
    const costPerTool = toolCount > 0 ? costUsd / toolCount : 0;

    const attribution: TurnCostAttribution = {
      turnId: state.pendingTurn.turnId,
      startTime: state.pendingTurn.startTime,
      endTime: state.pendingTurn.endTime,
      toolCalls: state.pendingTurn.toolCalls.map((tc) => tc.toolUseId),
      toolNames: state.pendingTurn.toolCalls.map((tc) => tc.toolName),
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

    for (const tc of state.pendingTurn.toolCalls) {
      const bucket = state.buckets.get(tc.bucketKey);
      if (bucket === undefined) continue;
      bucket.attributedCallCount++;
      bucket.totalCost += costPerTool;
      bucket.inputTokens += event.inputTokens / toolCount;
      bucket.outputTokens += event.outputTokens / toolCount;
      bucket.cacheReadTokens += event.cacheReadTokens / toolCount;
    }

    // Minted here rather than reusing `attribution.turnId`: the caller's turn
    // id comes from the process-global TurnTracker and can repeat across two
    // attributor turns, so it cannot group AiTurnCost rows.
    const closedTurn: ClosedTurn = {
      id: randomUUID(),
      attribution,
      calls: state.pendingTurn.toolCalls.map((tc) => ({
        toolUseId: tc.toolUseId,
        toolName: tc.toolName,
        skillName: tc.skillName,
      })),
      platform: state.pendingTurn.platform,
    };

    state.pendingTurn = null;
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
    const toolTypeAccum = new Map<string, { totalCost: number; callCount: number }>();
    const costBySkill: Record<string, SkillCostEntry> = {};

    for (const bucket of state.buckets.values()) {
      // costByToolType predates the buckets table and only ever listed tools
      // that received a token event, so the fold keeps that contract.
      if (bucket.attributedCallCount > 0) {
        let entry = toolTypeAccum.get(bucket.toolName);
        if (entry === undefined) {
          entry = { totalCost: 0, callCount: 0 };
          toolTypeAccum.set(bucket.toolName, entry);
        }
        entry.totalCost += bucket.totalCost;
        entry.callCount += bucket.attributedCallCount;
      }

      if (bucket.skillName !== null) {
        costBySkill[bucket.skillName] = {
          callCount: bucket.callCount,
          attributedCallCount: bucket.attributedCallCount,
          totalCost: bucket.totalCost,
          avgCost:
            bucket.attributedCallCount > 0 ? bucket.totalCost / bucket.attributedCallCount : 0,
          inputTokens: Math.round(bucket.inputTokens),
          outputTokens: Math.round(bucket.outputTokens),
          cacheReadTokens: Math.round(bucket.cacheReadTokens),
          totalDurationMs: bucket.totalDurationMs,
        };
      }
    }

    const costByToolType: Record<string, ToolTypeCostEntry> = {};
    for (const [tool, entry] of toolTypeAccum) {
      costByToolType[tool] = {
        totalCost: entry.totalCost,
        callCount: entry.callCount,
        avgCost: entry.callCount > 0 ? entry.totalCost / entry.callCount : 0,
      };
    }

    return {
      turns: [...state.turns],
      costByToolType,
      costBySkill,
      totalAttributedCost: state.totalAttributedCost,
      attributionRate:
        state.totalToolCalls > 0 ? state.attributedToolCalls / state.totalToolCalls : 0,
    };
  }

  reset(_sessionId?: string): void {
    this.sessions.clear();
  }
}
