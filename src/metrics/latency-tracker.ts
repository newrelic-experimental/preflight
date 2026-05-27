import type { ToolCallRecord } from '../storage/types.js';
import { computePercentile } from './percentile.js';

export interface LatencyPercentiles {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly min: number;
  readonly max: number;
  readonly count: number;
}

export interface LatencyMetrics {
  readonly overall: LatencyPercentiles | null;
  readonly byTool: Readonly<Record<string, LatencyPercentiles>>;
  readonly slowestCalls: ReadonlyArray<{
    toolName: string;
    durationMs: number;
    timestamp: number;
    filePath?: string;
  }>;
}

// Per-tool percentiles use only the first MAX_SAMPLES_PER_TOOL observations
// (not reservoir-sampled), so p95/p99 may reflect early-session behaviour
// in long sessions. Overall percentiles use a larger independent cap.
const MAX_SAMPLES_PER_TOOL = 500;
const MAX_OVERALL_SAMPLES = 5000;
const MAX_SLOWEST = 10;

export class LatencyTracker {
  private allDurations: number[] = [];
  private byTool = new Map<string, number[]>();
  private slowestCalls: Array<{
    toolName: string;
    durationMs: number;
    timestamp: number;
    filePath?: string;
  }> = [];

  recordToolCall(record: ToolCallRecord): void {
    if (record.durationMs === null || record.durationMs === undefined) return;
    const d = record.durationMs;

    // Overall
    if (this.allDurations.length < MAX_OVERALL_SAMPLES) this.allDurations.push(d);

    // Per tool
    const key = record.toolName ?? 'Unknown';
    let arr = this.byTool.get(key);
    if (!arr) {
      arr = [];
      this.byTool.set(key, arr);
    }
    if (arr.length < MAX_SAMPLES_PER_TOOL) arr.push(d);

    // Slowest calls
    const filePath = record.filePath as string | undefined;
    const slowCall = {
      toolName: key,
      durationMs: d,
      timestamp: record.timestamp ?? Date.now(),
      ...(filePath !== undefined ? { filePath } : {}),
    };
    this.slowestCalls.push(slowCall);
    this.slowestCalls.sort((a, b) => b.durationMs - a.durationMs);
    if (this.slowestCalls.length > MAX_SLOWEST) {
      this.slowestCalls.length = MAX_SLOWEST;
    }
  }

  private computePercentiles(sorted: number[]): LatencyPercentiles {
    const count = sorted.length;
    return {
      p50: computePercentile(sorted, 0.5) ?? 0,
      p95: computePercentile(sorted, 0.95) ?? 0,
      p99: computePercentile(sorted, 0.99) ?? 0,
      min: sorted[0] ?? 0,
      max: sorted[count - 1] ?? 0,
      count,
    };
  }

  getMetrics(): LatencyMetrics {
    const sortedAll = [...this.allDurations].sort((a, b) => a - b);
    const overall = sortedAll.length > 0 ? this.computePercentiles(sortedAll) : null;

    const byTool: Record<string, LatencyPercentiles> = {};
    for (const [tool, durations] of this.byTool) {
      const sorted = [...durations].sort((a, b) => a - b);
      byTool[tool] = this.computePercentiles(sorted);
    }

    return {
      overall,
      byTool,
      slowestCalls: [...this.slowestCalls],
    };
  }

  reset(_sessionId: string): void {
    this.allDurations = [];
    this.byTool.clear();
    this.slowestCalls = [];
  }
}
