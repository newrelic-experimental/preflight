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
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly model: string;
  readonly estimatedCostUsd: number;
  readonly costPerToolCall: number;
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

// ---------------------------------------------------------------------------
// TurnCostAttributor
// ---------------------------------------------------------------------------

export class TurnCostAttributor {
  private turns: TurnCostAttribution[] = [];
  private pendingTurn: PendingTurn | null = null;
  private costByToolType = new Map<string, { totalCost: number; callCount: number }>();
  private totalAttributedCost = 0;
  private totalToolCalls = 0;
  private attributedToolCalls = 0;

  recordToolCall(record: ToolCallRecord, turnId?: string): void {
    this.totalToolCalls++;
    const endTime = record.timestamp + (record.durationMs ?? 0);

    if (this.pendingTurn && record.timestamp - this.pendingTurn.endTime <= TURN_GAP_MS) {
      this.pendingTurn.endTime = endTime;
      this.pendingTurn.toolCalls.push({
        toolUseId: record.toolUseId,
        toolName: record.toolName,
      });
    } else {
      this.pendingTurn = {
        turnId: turnId ?? randomUUID(),
        startTime: record.timestamp,
        endTime,
        toolCalls: [{ toolUseId: record.toolUseId, toolName: record.toolName }],
      };
    }
  }

  recordTokenEvent(event: TokenEvent): void {
    if (!this.pendingTurn) return;

    // A token event outside the match window can't be reliably tied to the
    // pending turn — silently drop it rather than risk mis-attributing cost
    // to the wrong turn. Dropped events show up as a lower `attributionRate`
    // in getMetrics(), not as an error.
    const timeSinceLastTool = event.timestamp - this.pendingTurn.endTime;
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
    const toolCount = this.pendingTurn.toolCalls.length;
    const costPerTool = toolCount > 0 ? costUsd / toolCount : 0;

    const attribution: TurnCostAttribution = {
      turnId: this.pendingTurn.turnId,
      startTime: this.pendingTurn.startTime,
      endTime: this.pendingTurn.endTime,
      toolCalls: this.pendingTurn.toolCalls.map((tc) => tc.toolUseId),
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheReadTokens: event.cacheReadTokens,
      model: event.model,
      estimatedCostUsd: costUsd,
      costPerToolCall: costPerTool,
    };

    this.turns.push(attribution);
    if (this.turns.length > MAX_TURNS) {
      this.turns.shift();
    }

    this.totalAttributedCost += costUsd;
    this.attributedToolCalls += toolCount;

    for (const tc of this.pendingTurn.toolCalls) {
      const entry = this.costByToolType.get(tc.toolName) ?? { totalCost: 0, callCount: 0 };
      entry.totalCost += costPerTool;
      entry.callCount += 1;
      this.costByToolType.set(tc.toolName, entry);
    }

    this.pendingTurn = null;
  }

  getCostForToolCall(
    toolUseId: string,
  ): { estimatedTurnCostUsd: number; costPerToolCallUsd: number } | null {
    for (const turn of this.turns) {
      if (turn.toolCalls.includes(toolUseId)) {
        return {
          estimatedTurnCostUsd: turn.estimatedCostUsd,
          costPerToolCallUsd: turn.costPerToolCall,
        };
      }
    }
    return null;
  }

  getMetrics(): CostAttributionMetrics {
    const costByToolType: Record<string, ToolTypeCostEntry> = {};
    for (const [tool, entry] of this.costByToolType) {
      costByToolType[tool] = {
        totalCost: entry.totalCost,
        callCount: entry.callCount,
        avgCost: entry.callCount > 0 ? entry.totalCost / entry.callCount : 0,
      };
    }

    return {
      turns: [...this.turns],
      costByToolType,
      totalAttributedCost: this.totalAttributedCost,
      attributionRate: this.totalToolCalls > 0 ? this.attributedToolCalls / this.totalToolCalls : 0,
    };
  }

  reset(_sessionId?: string): void {
    this.turns = [];
    this.pendingTurn = null;
    this.costByToolType = new Map();
    this.totalAttributedCost = 0;
    this.totalToolCalls = 0;
    this.attributedToolCalls = 0;
  }
}
