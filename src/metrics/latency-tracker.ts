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
  readonly byTool: Readonly<Record<string, LatencyPercentiles | null>>;
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

  private cachedSortedAll: number[] | null = null;
  private cachedSortedByTool = new Map<string, number[]>();
  private lastSortedAllCount = -1;
  private lastSortedToolCounts = new Map<string, number>();

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

  private computePercentiles(sorted: number[]): LatencyPercentiles | null {
    if (sorted.length === 0) return null;

    const count = sorted.length;
    return {
      p50: computePercentile(sorted, 0.5) ?? 0,
      p95: computePercentile(sorted, 0.95) ?? 0,
      p99: computePercentile(sorted, 0.99) ?? 0,
      min: sorted[0]!,
      max: sorted[count - 1]!,
      count,
    };
  }

  getMetrics(): LatencyMetrics {
    // Re-sort overall only if new samples have been added
    if (this.allDurations.length !== this.lastSortedAllCount) {
      this.cachedSortedAll = [...this.allDurations].sort((a, b) => a - b);
      this.lastSortedAllCount = this.allDurations.length;
    }
    const overall = this.computePercentiles(this.cachedSortedAll ?? []);

    // Re-sort per-tool only if new samples have been added to that tool
    const byTool: Record<string, LatencyPercentiles | null> = {};
    for (const [tool, durations] of this.byTool) {
      const prevCount = this.lastSortedToolCounts.get(tool) ?? -1;
      if (durations.length !== prevCount) {
        this.cachedSortedByTool.set(tool, [...durations].sort((a, b) => a - b));
        this.lastSortedToolCounts.set(tool, durations.length);
      }
      const sorted = this.cachedSortedByTool.get(tool) ?? [];
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
    this.cachedSortedAll = null;
    this.cachedSortedByTool.clear();
    this.lastSortedAllCount = -1;
    this.lastSortedToolCounts.clear();
  }
}
