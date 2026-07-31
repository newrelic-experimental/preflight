import { computeLatencyPercentiles } from './latency-percentiles.js';
import type { LatencySample } from './latency-percentiles.js';

describe('computeLatencyPercentiles', () => {
  it('returns null overall and an empty byTool map for an empty samples array', () => {
    const result = computeLatencyPercentiles([]);
    expect(result).toEqual({ overall: null, byTool: {} });
  });

  it('computes overall and per-tool percentiles across mixed-tool samples', () => {
    const samples: LatencySample[] = [
      { durationMs: 100, toolName: 'Read' },
      { durationMs: 200, toolName: 'Edit' },
      { durationMs: 300, toolName: 'Read' },
      { durationMs: 400, toolName: 'Edit' },
      { durationMs: 500, toolName: 'Read' },
    ];

    const result = computeLatencyPercentiles(samples);

    // Overall sorted: [100, 200, 300, 400, 500], n=5
    expect(result.overall).toEqual({ p50: 300, p95: 400, p99: 400, min: 100, max: 500, count: 5 });
    // Read sorted: [100, 300, 500], n=3
    expect(result.byTool.Read).toEqual({
      p50: 300,
      p95: 300,
      p99: 300,
      min: 100,
      max: 500,
      count: 3,
    });
    // Edit sorted: [200, 400], n=2
    expect(result.byTool.Edit).toEqual({
      p50: 200,
      p95: 200,
      p99: 200,
      min: 200,
      max: 400,
      count: 2,
    });
  });
});
