import { randomUUID } from 'node:crypto';
import type { ToolCallRecord } from '../storage/types.js';
import type { Resettable } from './tracker-contracts.js';

export interface ConversationTurn {
  readonly turnId: string;
  readonly turnNumber: number;
  readonly startTime: number;
  readonly endTime: number;
  readonly durationMs: number;
  readonly toolCalls: Array<{
    readonly toolName: string;
    readonly toolUseId: string;
    readonly success: boolean;
    readonly durationMs: number | null;
  }>;
  readonly toolCount: number;
  readonly parallelism: number;
  readonly uniqueTools: string[];
}

export interface TurnMetrics {
  readonly totalTurns: number;
  readonly avgToolsPerTurn: number;
  readonly maxToolsPerTurn: number;
  readonly avgTurnDurationMs: number;
  readonly avgParallelism: number;
  readonly recentTurns: ConversationTurn[];
  readonly turnsByToolCount: Record<number, number>;
}

// Tool calls within this gap of each other are grouped into the same "turn"
// (one LLM response driving a burst of tool use) rather than starting a new
// one. Chosen to bridge normal back-to-back tool latency.
const DEFAULT_GAP_THRESHOLD_MS = 2000;
// When a call's real duration isn't known yet, assume it occupies this much
// time for the purposes of gap/parallelism computation — an unmeasured call
// shouldn't be treated as if it ended instantly.
const NULL_DURATION_BUFFER_MS = 500;
const MAX_RECENT_TURNS = 20;

interface PendingCall {
  readonly toolName: string;
  readonly toolUseId: string;
  readonly success: boolean;
  readonly durationMs: number | null;
  readonly timestamp: number;
}

export interface TurnTrackerOptions {
  gapThresholdMs?: number;
}

export class TurnTracker implements Resettable {
  private readonly gapThresholdMs: number;
  private turns: ConversationTurn[] = [];
  private turnCounter = 0;

  private currentTurnCalls: PendingCall[] = [];
  private currentTurnEnd = 0;

  constructor(options?: TurnTrackerOptions) {
    this.gapThresholdMs = options?.gapThresholdMs ?? DEFAULT_GAP_THRESHOLD_MS;
  }

  recordToolCall(record: ToolCallRecord): string {
    const call: PendingCall = {
      toolName: record.toolName,
      toolUseId: record.toolUseId,
      success: record.success,
      durationMs: record.durationMs,
      timestamp: record.timestamp,
    };

    const callEnd = this.computeCallEnd(call);

    if (
      this.currentTurnCalls.length > 0 &&
      record.timestamp > this.currentTurnEnd + this.gapThresholdMs
    ) {
      this.finalizeTurn();
    }

    this.currentTurnCalls.push(call);
    if (callEnd > this.currentTurnEnd) {
      this.currentTurnEnd = callEnd;
    }

    return this.getCurrentTurnId();
  }

  getMetrics(): TurnMetrics {
    const allTurns = this.getAllTurns();
    const totalTurns = allTurns.length;

    if (totalTurns === 0) {
      return {
        totalTurns: 0,
        avgToolsPerTurn: 0,
        maxToolsPerTurn: 0,
        avgTurnDurationMs: 0,
        avgParallelism: 0,
        recentTurns: [],
        turnsByToolCount: {},
      };
    }

    let totalTools = 0;
    let maxTools = 0;
    let totalDuration = 0;
    let totalParallelism = 0;
    const histogram: Record<number, number> = {};

    for (const turn of allTurns) {
      totalTools += turn.toolCount;
      totalDuration += turn.durationMs;
      totalParallelism += turn.parallelism;
      if (turn.toolCount > maxTools) maxTools = turn.toolCount;
      histogram[turn.toolCount] = (histogram[turn.toolCount] ?? 0) + 1;
    }

    const recentTurns = allTurns.slice(-MAX_RECENT_TURNS);

    return {
      totalTurns,
      avgToolsPerTurn: totalTools / totalTurns,
      maxToolsPerTurn: maxTools,
      avgTurnDurationMs: totalDuration / totalTurns,
      avgParallelism: totalParallelism / totalTurns,
      recentTurns,
      turnsByToolCount: histogram,
    };
  }

  getCurrentTurnId(): string {
    if (this.currentTurnCalls.length === 0) {
      return '';
    }
    const turnNumber = this.turnCounter + 1;
    const existing = this.turns.find((t) => t.turnNumber === turnNumber);
    if (existing) return existing.turnId;
    return this.buildTurnId();
  }

  getCurrentTurnNumber(): number {
    if (this.currentTurnCalls.length === 0) return 0;
    return this.turnCounter + 1;
  }

  reset(_sessionId: string): void {
    this.turns = [];
    this.turnCounter = 0;
    this.currentTurnCalls = [];
    this.currentTurnEnd = 0;
    this.cachedTurnId = null;
  }

  private cachedTurnId: string | null = null;

  private buildTurnId(): string {
    if (!this.cachedTurnId) {
      this.cachedTurnId = randomUUID();
    }
    return this.cachedTurnId;
  }

  private finalizeTurn(): void {
    if (this.currentTurnCalls.length === 0) return;

    this.turnCounter++;
    const turnId = this.buildTurnId();
    const startTime = this.currentTurnCalls[0]!.timestamp;
    const endTime = this.currentTurnEnd;

    const toolCalls = this.currentTurnCalls.map((c) => ({
      toolName: c.toolName,
      toolUseId: c.toolUseId,
      success: c.success,
      durationMs: c.durationMs,
    }));

    const uniqueToolSet = new Set<string>();
    for (const c of this.currentTurnCalls) {
      uniqueToolSet.add(c.toolName);
    }

    const turn: ConversationTurn = {
      turnId,
      turnNumber: this.turnCounter,
      startTime,
      endTime,
      durationMs: endTime - startTime,
      toolCalls,
      toolCount: toolCalls.length,
      parallelism: this.computeParallelism(this.currentTurnCalls),
      uniqueTools: [...uniqueToolSet],
    };

    this.turns.push(turn);
    this.currentTurnCalls = [];
    this.currentTurnEnd = 0;
    this.cachedTurnId = null;
  }

  private getAllTurns(): ConversationTurn[] {
    if (this.currentTurnCalls.length === 0) return this.turns;

    const startTime = this.currentTurnCalls[0]!.timestamp;
    const endTime = this.currentTurnEnd;

    const toolCalls = this.currentTurnCalls.map((c) => ({
      toolName: c.toolName,
      toolUseId: c.toolUseId,
      success: c.success,
      durationMs: c.durationMs,
    }));

    const uniqueToolSet = new Set<string>();
    for (const c of this.currentTurnCalls) {
      uniqueToolSet.add(c.toolName);
    }

    const inProgress: ConversationTurn = {
      turnId: this.buildTurnId(),
      turnNumber: this.turnCounter + 1,
      startTime,
      endTime,
      durationMs: endTime - startTime,
      toolCalls,
      toolCount: toolCalls.length,
      parallelism: this.computeParallelism(this.currentTurnCalls),
      uniqueTools: [...uniqueToolSet],
    };

    return [...this.turns, inProgress];
  }

  private computeCallEnd(call: PendingCall): number {
    if (call.durationMs !== null && call.durationMs !== undefined) {
      return call.timestamp + call.durationMs;
    }
    return call.timestamp + NULL_DURATION_BUFFER_MS;
  }

  private computeParallelism(calls: PendingCall[]): number {
    if (calls.length <= 1) return calls.length;

    const ranges: Array<{ start: number; end: number }> = calls.map((c) => ({
      start: c.timestamp,
      end: this.computeCallEnd(c),
    }));

    let maxOverlap = 1;
    for (let i = 0; i < ranges.length; i++) {
      let overlap = 1;
      for (let j = 0; j < ranges.length; j++) {
        if (i === j) continue;
        const a = ranges[i]!;
        const b = ranges[j]!;
        if (b.start < a.end && b.end > a.start) {
          overlap++;
        }
      }
      if (overlap > maxOverlap) maxOverlap = overlap;
    }

    return maxOverlap;
  }
}
