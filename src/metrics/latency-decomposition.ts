import type { MetricAggregator } from '../shared/index.js';
import { computePercentile } from './percentile.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LatencyComponent = 'llm_api' | 'tool_execution' | 'overhead';

export interface TurnLatency {
  readonly turnNumber: number;
  readonly timestamp: number;
  readonly wallClockMs: number;
  readonly llmApiMs: number;
  readonly toolExecutionMs: number;
  readonly overheadMs: number;
}

export interface ComponentPercentiles {
  readonly p50: number;
  readonly p95: number;
  readonly count: number;
}

export interface LatencyDecompositionMetrics {
  readonly turnCount: number;
  readonly llmApi: ComponentPercentiles | null;
  readonly toolExecution: ComponentPercentiles | null;
  readonly overhead: ComponentPercentiles | null;
  readonly recentTurns: readonly TurnLatency[];
  readonly avgComposition: Readonly<Record<LatencyComponent, number>> | null;
}

export interface LatencyDecompositionOptions {
  readonly maxHistorySize?: number;
  readonly recentTurnCount?: number;
}

export interface TurnTimingReport {
  readonly turnStartMs: number;
  readonly turnEndMs: number;
  readonly llmApiMs: number;
  readonly toolExecutionMs: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_HISTORY = 1000;
const DEFAULT_RECENT_COUNT = 20;

// ---------------------------------------------------------------------------
// LatencyDecompositionTracker
// ---------------------------------------------------------------------------

export class LatencyDecompositionTracker {
  private readonly maxHistorySize: number;
  private readonly recentTurnCount: number;

  private turnCount = 0;
  private readonly llmSamples: number[] = [];
  private readonly toolSamples: number[] = [];
  private readonly overheadSamples: number[] = [];
  private readonly turns: TurnLatency[] = [];

  constructor(options?: LatencyDecompositionOptions) {
    this.maxHistorySize = options?.maxHistorySize ?? DEFAULT_MAX_HISTORY;
    this.recentTurnCount = options?.recentTurnCount ?? DEFAULT_RECENT_COUNT;
  }

  recordTurn(report: TurnTimingReport): TurnLatency {
    this.turnCount++;

    const wallClockMs = report.turnEndMs - report.turnStartMs;
    const llmApiMs = report.llmApiMs;
    const toolExecutionMs = report.toolExecutionMs;
    const overheadMs = Math.max(0, wallClockMs - llmApiMs - toolExecutionMs);

    this.llmSamples.push(llmApiMs);
    if (this.llmSamples.length > this.maxHistorySize) {
      this.llmSamples.shift();
    }
    this.toolSamples.push(toolExecutionMs);
    if (this.toolSamples.length > this.maxHistorySize) {
      this.toolSamples.shift();
    }
    this.overheadSamples.push(overheadMs);
    if (this.overheadSamples.length > this.maxHistorySize) {
      this.overheadSamples.shift();
    }

    const turn: TurnLatency = {
      turnNumber: this.turnCount,
      timestamp: report.turnEndMs,
      wallClockMs,
      llmApiMs,
      toolExecutionMs,
      overheadMs,
    };

    this.turns.push(turn);
    if (this.turns.length > this.recentTurnCount) {
      this.turns.shift();
    }

    return turn;
  }

  getMetrics(): LatencyDecompositionMetrics {
    return {
      turnCount: this.turnCount,
      llmApi: this.computePercentiles(this.llmSamples),
      toolExecution: this.computePercentiles(this.toolSamples),
      overhead: this.computePercentiles(this.overheadSamples),
      recentTurns: [...this.turns],
      avgComposition: this.computeAvgComposition(),
    };
  }

  emitMetrics(aggregator: MetricAggregator): void {
    const metrics = this.getMetrics();
    if (metrics.llmApi) {
      aggregator.record('ai.latency.llm_api.p50', metrics.llmApi.p50);
      aggregator.record('ai.latency.llm_api.p95', metrics.llmApi.p95);
    }
    if (metrics.toolExecution) {
      aggregator.record('ai.latency.tool_execution.p50', metrics.toolExecution.p50);
      aggregator.record('ai.latency.tool_execution.p95', metrics.toolExecution.p95);
    }
    if (metrics.overhead) {
      aggregator.record('ai.latency.overhead.p50', metrics.overhead.p50);
      aggregator.record('ai.latency.overhead.p95', metrics.overhead.p95);
    }
  }

  reset(_sessionId: string): void {
    this.turnCount = 0;
    this.llmSamples.length = 0;
    this.toolSamples.length = 0;
    this.overheadSamples.length = 0;
    this.turns.length = 0;
  }

  private computePercentiles(samples: number[]): ComponentPercentiles | null {
    if (samples.length === 0) return null;
    const sorted = [...samples].sort((a, b) => a - b);
    return {
      p50: computePercentile(sorted, 0.50) ?? 0,
      p95: computePercentile(sorted, 0.95) ?? 0,
      count: sorted.length,
    };
  }

  private computeAvgComposition(): Readonly<Record<LatencyComponent, number>> | null {
    if (this.turnCount === 0) return null;

    const totalLlm = this.llmSamples.reduce((s, v) => s + v, 0);
    const totalTool = this.toolSamples.reduce((s, v) => s + v, 0);
    const totalOverhead = this.overheadSamples.reduce((s, v) => s + v, 0);
    const grandTotal = totalLlm + totalTool + totalOverhead;

    if (grandTotal === 0) return { llm_api: 0, tool_execution: 0, overhead: 0 };

    return {
      llm_api: Math.round((totalLlm / grandTotal) * 10000) / 100,
      tool_execution: Math.round((totalTool / grandTotal) * 10000) / 100,
      overhead: Math.round((totalOverhead / grandTotal) * 10000) / 100,
    };
  }
}
