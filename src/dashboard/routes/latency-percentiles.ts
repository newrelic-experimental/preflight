import { computePercentile } from '../../metrics/percentile.js';
import type { LatencyPercentiles } from '../../metrics/latency-tracker.js';

export interface LatencySample {
  readonly durationMs: number;
  readonly toolName: string;
}

export interface AggregateLatencyMetrics {
  readonly overall: LatencyPercentiles | null;
  readonly byTool: Readonly<Record<string, LatencyPercentiles | null>>;
}

function computePercentilesFromDurations(durations: readonly number[]): LatencyPercentiles | null {
  if (durations.length === 0) return null;
  const sorted = [...durations].sort((a, b) => a - b);
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

// Computes the same p50/p95/p99/min/max/count shape LatencyTracker produces
// incrementally for one process, but from a flat snapshot of samples
// gathered across every process/session active today — see the aggregate
// route in api-handler.ts, which is the only caller.
export function computeLatencyPercentiles(
  samples: readonly LatencySample[],
): AggregateLatencyMetrics {
  const byToolDurations = new Map<string, number[]>();
  const allDurations: number[] = [];
  for (const sample of samples) {
    allDurations.push(sample.durationMs);
    const arr = byToolDurations.get(sample.toolName);
    if (arr) {
      arr.push(sample.durationMs);
    } else {
      byToolDurations.set(sample.toolName, [sample.durationMs]);
    }
  }

  const byTool: Record<string, LatencyPercentiles | null> = {};
  for (const [toolName, durations] of byToolDurations) {
    byTool[toolName] = computePercentilesFromDurations(durations);
  }

  return {
    overall: computePercentilesFromDurations(allDurations),
    byTool,
  };
}
