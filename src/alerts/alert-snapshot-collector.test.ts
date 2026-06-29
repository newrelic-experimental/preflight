import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  AlertSnapshotCollector,
  type AlertSnapshotCollectorDeps,
  type SnapshotWindowSpec,
} from './alert-snapshot-collector.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

const NOW = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// Empty / default behaviour
// ---------------------------------------------------------------------------

describe('AlertSnapshotCollector — empty deps', () => {
  it('builds a mostly-null snapshot when no deps provided', () => {
    const collector = new AlertSnapshotCollector();
    const snap = collector.snapshot(NOW, []);
    expect(snap.timestamp).toBe(NOW);
    expect(snap.cost).toEqual({ sessionUsd: 0, todayUsd: 0, weekUsd: 0 });
    expect(snap.efficiency).toEqual({ score: null });
    expect(snap.antiPatterns).toEqual([]);
    expect(snap.latency).toEqual([]);
    expect(snap.toolFailures).toEqual([]);
  });

  it('returns no antiPattern entries when no windows requested', () => {
    const collector = new AlertSnapshotCollector();
    collector.recordAntiPattern({ type: 'stuck_loop', ts: NOW });
    expect(collector.snapshot(NOW, []).antiPatterns).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Buffer behaviour
// ---------------------------------------------------------------------------

describe('AlertSnapshotCollector — buffers', () => {
  it('recordToolCall pushes into the buffer', () => {
    const collector = new AlertSnapshotCollector();
    collector.recordToolCall({ toolName: 'Read', success: true, ts: NOW });
    collector.recordToolCall({ toolName: 'Edit', success: false, ts: NOW + 1 });
    expect(collector.bufferSizes()).toEqual({ toolCalls: 2, antiPatterns: 0 });
  });

  it('recordAntiPattern pushes into the buffer', () => {
    const collector = new AlertSnapshotCollector();
    collector.recordAntiPattern({ type: 'stuck_loop', ts: NOW });
    collector.recordAntiPattern({ type: 're_reading', ts: NOW });
    expect(collector.bufferSizes()).toEqual({ toolCalls: 0, antiPatterns: 2 });
  });

  it('caps each buffer at 5000 entries (drops oldest)', () => {
    const collector = new AlertSnapshotCollector();
    for (let i = 0; i < 5500; i++) {
      collector.recordToolCall({ toolName: 'Read', success: true, ts: NOW + i });
    }
    expect(collector.bufferSizes().toolCalls).toBe(5000);
  });

  it('prunes entries older than 30 minutes when no window specs provided', () => {
    const collector = new AlertSnapshotCollector();
    const veryOld = NOW - 31 * 60 * 1000;
    const fresh = NOW - 60 * 1000;
    collector.recordToolCall({ toolName: 'Read', success: true, ts: veryOld });
    collector.recordToolCall({ toolName: 'Read', success: true, ts: fresh });
    collector.snapshot(NOW, []);
    expect(collector.bufferSizes().toolCalls).toBe(1);
  });

  it('extends prune horizon to the largest requested window', () => {
    const collector = new AlertSnapshotCollector();
    // 45-minute-old entry — would be pruned at default 30 min, but a
    // 60-minute window keeps it.
    collector.recordAntiPattern({ type: 'thrashing', ts: NOW - 45 * 60 * 1000 });
    const windows: SnapshotWindowSpec[] = [
      { kind: 'antipattern', key: 'thrashing', windowMs: 60 * 60 * 1000 },
    ];
    const snap = collector.snapshot(NOW, windows);
    expect(snap.antiPatterns).toHaveLength(1);
    expect(snap.antiPatterns[0]).toEqual({
      type: 'thrashing',
      count: 1,
      windowMs: 60 * 60 * 1000,
    });
  });
});

// ---------------------------------------------------------------------------
// Snapshot windowing
// ---------------------------------------------------------------------------

describe('AlertSnapshotCollector — snapshot windowing', () => {
  it('counts antiPatterns by exact (type, windowMs)', () => {
    const collector = new AlertSnapshotCollector();
    // 4 stuck loops in last 5 minutes, 1 read-reading in last minute
    collector.recordAntiPattern({ type: 'stuck_loop', ts: NOW - 4 * 60 * 1000 });
    collector.recordAntiPattern({ type: 'stuck_loop', ts: NOW - 3 * 60 * 1000 });
    collector.recordAntiPattern({ type: 'stuck_loop', ts: NOW - 2 * 60 * 1000 });
    collector.recordAntiPattern({ type: 'stuck_loop', ts: NOW - 1 * 60 * 1000 });
    collector.recordAntiPattern({ type: 're_reading', ts: NOW - 30 * 1000 });

    const windows: SnapshotWindowSpec[] = [
      { kind: 'antipattern', key: 'stuck_loop', windowMs: 5 * 60 * 1000 },
      { kind: 'antipattern', key: 're_reading', windowMs: 60 * 1000 },
      { kind: 'antipattern', key: '*', windowMs: 5 * 60 * 1000 },
    ];
    const snap = collector.snapshot(NOW, windows);
    const stuck = snap.antiPatterns.find(
      (e) => e.type === 'stuck_loop' && e.windowMs === 5 * 60 * 1000,
    );
    const reReading = snap.antiPatterns.find(
      (e) => e.type === 're_reading' && e.windowMs === 60 * 1000,
    );
    const any = snap.antiPatterns.find((e) => e.type === '*' && e.windowMs === 5 * 60 * 1000);
    expect(stuck?.count).toBe(4);
    expect(reReading?.count).toBe(1);
    expect(any?.count).toBe(5);
  });

  it('computes per-tool failure percentages', () => {
    const collector = new AlertSnapshotCollector();
    // 3 successes, 1 failure for `Bash` in last 5 min => 25%
    collector.recordToolCall({ toolName: 'Bash', success: true, ts: NOW - 4 * 60 * 1000 });
    collector.recordToolCall({ toolName: 'Bash', success: true, ts: NOW - 3 * 60 * 1000 });
    collector.recordToolCall({ toolName: 'Bash', success: true, ts: NOW - 2 * 60 * 1000 });
    collector.recordToolCall({ toolName: 'Bash', success: false, ts: NOW - 1 * 60 * 1000 });

    const windows: SnapshotWindowSpec[] = [
      { kind: 'tool-failure', key: 'Bash', windowMs: 5 * 60 * 1000 },
    ];
    const snap = collector.snapshot(NOW, windows);
    expect(snap.toolFailures).toHaveLength(1);
    expect(snap.toolFailures[0]!.tool).toBe('Bash');
    expect(snap.toolFailures[0]!.windowMs).toBe(5 * 60 * 1000);
    expect(snap.toolFailures[0]!.failurePct).toBeCloseTo(25);
  });

  it('returns 0% failurePct when no calls in window', () => {
    const collector = new AlertSnapshotCollector();
    const windows: SnapshotWindowSpec[] = [
      { kind: 'tool-failure', key: 'Bash', windowMs: 5 * 60 * 1000 },
    ];
    const snap = collector.snapshot(NOW, windows);
    expect(snap.toolFailures[0]!.failurePct).toBe(0);
  });

  it('deduplicates repeated window specs', () => {
    const collector = new AlertSnapshotCollector();
    collector.recordAntiPattern({ type: 'stuck_loop', ts: NOW - 30_000 });
    const windows: SnapshotWindowSpec[] = [
      { kind: 'antipattern', key: 'stuck_loop', windowMs: 60 * 1000 },
      { kind: 'antipattern', key: 'stuck_loop', windowMs: 60 * 1000 },
    ];
    const snap = collector.snapshot(NOW, windows);
    expect(snap.antiPatterns).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tracker reads
// ---------------------------------------------------------------------------

describe('AlertSnapshotCollector — tracker reads', () => {
  it('reads sessionUsd from costTracker', () => {
    const deps: AlertSnapshotCollectorDeps = {
      costTracker: {
        getMetrics: () => ({ sessionTotalCostUsd: 1.42 }),
      },
    };
    const collector = new AlertSnapshotCollector(deps);
    const snap = collector.snapshot(NOW, []);
    expect(snap.cost.sessionUsd).toBeCloseTo(1.42);
  });

  it('handles costTracker returning null sessionTotalCostUsd', () => {
    const deps: AlertSnapshotCollectorDeps = {
      costTracker: {
        getMetrics: () => ({ sessionTotalCostUsd: null }),
      },
    };
    const collector = new AlertSnapshotCollector(deps);
    expect(collector.snapshot(NOW, []).cost.sessionUsd).toBe(0);
  });

  it('reads efficiency score via the efficiencyScorer adapter', () => {
    const deps: AlertSnapshotCollectorDeps = {
      efficiencyScorer: { getCurrentScore: () => 0.42 },
    };
    const collector = new AlertSnapshotCollector(deps);
    expect(collector.snapshot(NOW, []).efficiency.score).toBe(0.42);
  });

  it('returns null efficiency score when adapter returns null', () => {
    const deps: AlertSnapshotCollectorDeps = {
      efficiencyScorer: { getCurrentScore: () => null },
    };
    const collector = new AlertSnapshotCollector(deps);
    expect(collector.snapshot(NOW, []).efficiency.score).toBeNull();
  });

  it('flattens p95 latency per tool from latencyTracker', () => {
    const deps: AlertSnapshotCollectorDeps = {
      latencyTracker: {
        getMetrics: () => ({
          byTool: {
            Read: { p50: 60, p95: 120, p99: 150 },
            Edit: { p50: 200, p95: 350, p99: 400 },
            Bash: null,
          },
        }),
      },
    };
    const collector = new AlertSnapshotCollector(deps);
    const snap = collector.snapshot(NOW, []);
    const sorted = [...snap.latency].sort((a, b) => a.tool.localeCompare(b.tool));
    expect(sorted).toEqual([
      { tool: 'Edit', p50Ms: 200, p95Ms: 350, p99Ms: 400 },
      { tool: 'Read', p50Ms: 60, p95Ms: 120, p99Ms: 150 },
    ]);
  });

  // Regression guard: when the tracker has only p50 (no p95/p99 because
  // sample count is too low), the snapshot must still emit the tool with the
  // p50 value populated and p95/p99 as 0. Previously the entry was dropped
  // entirely because the gate required `typeof p95 === 'number'`.
  it('emits a latency entry when only p50 is available', () => {
    const deps: AlertSnapshotCollectorDeps = {
      latencyTracker: {
        getMetrics: () => ({
          byTool: {
            Read: { p50: 100 } as { p50?: number; p95?: number; p99?: number },
          },
        }),
      },
    };
    const collector = new AlertSnapshotCollector(deps);
    const snap = collector.snapshot(NOW, []);
    expect(snap.latency).toEqual([{ tool: 'Read', p50Ms: 100, p95Ms: 0, p99Ms: 0 }]);
  });

  // Regression guard: a `latency.percentile` rule asking for p99 must
  // see the p99 value even when p95 is missing.
  it('emits a latency entry when only p99 is available', () => {
    const deps: AlertSnapshotCollectorDeps = {
      latencyTracker: {
        getMetrics: () => ({
          byTool: {
            Bash: { p99: 5000 } as { p50?: number; p95?: number; p99?: number },
          },
        }),
      },
    };
    const collector = new AlertSnapshotCollector(deps);
    const snap = collector.snapshot(NOW, []);
    expect(snap.latency).toEqual([{ tool: 'Bash', p50Ms: 0, p95Ms: 0, p99Ms: 5000 }]);
  });

  it('does not emit a latency entry when no percentiles are available', () => {
    const deps: AlertSnapshotCollectorDeps = {
      latencyTracker: {
        getMetrics: () => ({
          byTool: {
            Read: {} as { p50?: number; p95?: number; p99?: number },
          },
        }),
      },
    };
    const collector = new AlertSnapshotCollector(deps);
    const snap = collector.snapshot(NOW, []);
    expect(snap.latency).toEqual([]);
  });

  it('swallows errors from costTracker and falls back to zeros', () => {
    const deps: AlertSnapshotCollectorDeps = {
      costTracker: {
        getMetrics: () => {
          throw new Error('boom');
        },
      },
    };
    const collector = new AlertSnapshotCollector(deps);
    expect(collector.snapshot(NOW, []).cost.sessionUsd).toBe(0);
  });
});
