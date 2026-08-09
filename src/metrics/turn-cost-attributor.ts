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

export interface CostAttributionMetrics {
  readonly turns: TurnCostAttribution[];
  readonly costByToolType: Record<string, ToolTypeCostEntry>;
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
// Internal turn accumulator
// ---------------------------------------------------------------------------

interface PendingTurn {
  turnId: string;
  startTime: number;
  endTime: number;
  toolCalls: Array<{ toolUseId: string; toolName: string }>;
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
  costByToolType: Map<string, { totalCost: number; callCount: number }>;
  totalAttributedCost: number;
  totalToolCalls: number;
  attributedToolCalls: number;
}

function createSessionState(): SessionState {
  return {
    turns: [],
    pendingTurn: null,
    costByToolType: new Map(),
    totalAttributedCost: 0,
    totalToolCalls: 0,
    attributedToolCalls: 0,
  };
}

// ---------------------------------------------------------------------------
// TurnCostAttributor
// ---------------------------------------------------------------------------

/**
 * Per-session partitioned — each session's turns/pending-accumulator/
 * cost-by-tool-type live in their own bucket (keyed by
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

    if (state.pendingTurn && record.timestamp - state.pendingTurn.endTime <= TURN_GAP_MS) {
      state.pendingTurn.endTime = endTime;
      state.pendingTurn.toolCalls.push({
        toolUseId: record.toolUseId,
        toolName: record.toolName,
      });
    } else {
      state.pendingTurn = {
        turnId: turnId ?? randomUUID(),
        startTime: record.timestamp,
        endTime,
        toolCalls: [{ toolUseId: record.toolUseId, toolName: record.toolName }],
      };
    }
  }

  recordTokenEvent(event: TokenEvent): void {
    const state = this.getOrCreateSession(event.sessionId);
    if (!state.pendingTurn) return;

    // A token event outside the match window can't be reliably tied to the
    // pending turn — silently drop it rather than risk mis-attributing cost
    // to the wrong turn. Dropped events show up as a lower `attributionRate`
    // in getMetrics(), not as an error.
    const timeSinceLastTool = event.timestamp - state.pendingTurn.endTime;
    if (timeSinceLastTool < 0 || timeSinceLastTool > TOKEN_MATCH_WINDOW_MS) return;

    const usage: TokenUsage = {
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      thinkingTokens: 0,
      cacheReadTokens: event.cacheReadTokens,
      cacheCreationTokens: event.cacheCreationTokens,
      totalTokens: event.inputTokens + event.outputTokens,
    };

    const breakdown = calculateCost(event.model, usage);
    const costUsd = breakdown.totalUsd;
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
      const entry = state.costByToolType.get(tc.toolName) ?? { totalCost: 0, callCount: 0 };
      entry.totalCost += costPerTool;
      entry.callCount += 1;
      state.costByToolType.set(tc.toolName, entry);
    }

    state.pendingTurn = null;
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
   *   `attributedToolCalls`), merges (`costByToolType`), and concatenates
   *   (`turns`, capped back down to `MAX_TURNS` by recency) — matching
   *   `DecisionTracker.getMetrics()`'s "no-arg = everything" convention.
   *   Used by callers with no single session in view, e.g. the
   *   `nr_observe_get_cost_per_tool` MCP tool.
   */
  getMetrics(sessionId?: string): CostAttributionMetrics {
    const empty: CostAttributionMetrics = {
      turns: [],
      costByToolType: {},
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
      for (const [tool, entry] of state.costByToolType) {
        const existing = aggregate.costByToolType.get(tool) ?? { totalCost: 0, callCount: 0 };
        existing.totalCost += entry.totalCost;
        existing.callCount += entry.callCount;
        aggregate.costByToolType.set(tool, existing);
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
    const costByToolType: Record<string, ToolTypeCostEntry> = {};
    for (const [tool, entry] of state.costByToolType) {
      costByToolType[tool] = {
        totalCost: entry.totalCost,
        callCount: entry.callCount,
        avgCost: entry.callCount > 0 ? entry.totalCost / entry.callCount : 0,
      };
    }

    return {
      turns: [...state.turns],
      costByToolType,
      totalAttributedCost: state.totalAttributedCost,
      attributionRate:
        state.totalToolCalls > 0 ? state.attributedToolCalls / state.totalToolCalls : 0,
    };
  }

  reset(_sessionId?: string): void {
    this.sessions.clear();
  }
}
