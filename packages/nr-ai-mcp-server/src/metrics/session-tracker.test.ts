import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { SessionTracker, computeP95 } from './session-tracker.js';
import type { ToolCallRecord } from '../storage/types.js';
import { MetricAggregator } from '@nr-ai-observatory/shared';

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeRecord(overrides?: Partial<ToolCallRecord>): ToolCallRecord {
  return {
    id: 'rec-001',
    sessionId: 'sess-001',
    toolName: 'Read',
    toolUseId: 'toolu_001',
    timestamp: Date.now(),
    durationMs: 50,
    success: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionTracker', () => {
  describe('recordToolCall() — tool counts', () => {
    it('tracks correct toolCallCountByTool for mixed tools', () => {
      const tracker = new SessionTracker('test-session');

      for (let i = 0; i < 5; i++) tracker.recordToolCall(makeRecord({ toolName: 'Read' }));
      for (let i = 0; i < 3; i++) tracker.recordToolCall(makeRecord({ toolName: 'Edit' }));
      for (let i = 0; i < 2; i++) tracker.recordToolCall(makeRecord({ toolName: 'Bash' }));

      const metrics = tracker.getMetrics();
      expect(metrics.toolCallCount).toBe(10);
      expect(metrics.toolCallCountByTool).toEqual({
        Read: 5,
        Edit: 3,
        Bash: 2,
      });
    });
  });

  describe('duration stats', () => {
    it('computes min, max, sum, count, and p95 correctly', () => {
      const tracker = new SessionTracker('test-session');
      const durations = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

      for (const d of durations) {
        tracker.recordToolCall(makeRecord({ toolName: 'Read', durationMs: d }));
      }

      const metrics = tracker.getMetrics();
      const stats = metrics.toolDurationMsByTool['Read']!;

      expect(stats.count).toBe(10);
      expect(stats.sum).toBe(550);
      expect(stats.min).toBe(10);
      expect(stats.max).toBe(100);
      // p95 of [10,20,30,40,50,60,70,80,90,100]: index = floor(9*0.95) = floor(8.55) = 8 → 90
      expect(stats.p95).toBe(90);
    });

    it('handles records with null durationMs gracefully', () => {
      const tracker = new SessionTracker('test-session');

      tracker.recordToolCall(makeRecord({ durationMs: 50 }));
      tracker.recordToolCall(makeRecord({ durationMs: null }));
      tracker.recordToolCall(makeRecord({ durationMs: 100 }));

      const metrics = tracker.getMetrics();
      const stats = metrics.toolDurationMsByTool['Read']!;

      expect(stats.count).toBe(2);
      expect(stats.sum).toBe(150);
    });

    it('returns zero stats for tools with no durations', () => {
      const tracker = new SessionTracker('test-session');

      tracker.recordToolCall(makeRecord({ toolName: 'Read', durationMs: null }));

      const metrics = tracker.getMetrics();
      expect(metrics.toolDurationMsByTool['Read']).toBeUndefined();
    });
  });

  describe('success rates', () => {
    it('computes overall and per-tool success rates', () => {
      const tracker = new SessionTracker('test-session');

      // 6 successful Reads, 2 failed Reads
      for (let i = 0; i < 6; i++) tracker.recordToolCall(makeRecord({ toolName: 'Read', success: true }));
      for (let i = 0; i < 2; i++) tracker.recordToolCall(makeRecord({ toolName: 'Read', success: false }));

      // 2 successful Bash
      for (let i = 0; i < 2; i++) tracker.recordToolCall(makeRecord({ toolName: 'Bash', success: true }));

      const metrics = tracker.getMetrics();

      // Overall: 8 success / 10 total = 0.8
      expect(metrics.toolSuccessRate).toBe(0.8);
      expect(metrics.toolErrorCount).toBe(2);

      // Per-tool: Read = 6/8 = 0.75, Bash = 2/2 = 1.0
      expect(metrics.toolSuccessRateByTool['Read']).toBe(0.75);
      expect(metrics.toolSuccessRateByTool['Bash']).toBe(1.0);
    });

    it('tracks errors by type', () => {
      const tracker = new SessionTracker('test-session');

      tracker.recordToolCall(makeRecord({ success: false, errorType: 'timeout' }));
      tracker.recordToolCall(makeRecord({ success: false, errorType: 'timeout' }));
      tracker.recordToolCall(makeRecord({ success: false, errorType: 'permission_denied' }));

      const metrics = tracker.getMetrics();
      expect(metrics.toolErrorsByType).toEqual({
        timeout: 2,
        permission_denied: 1,
      });
    });
  });

  describe('file tracking', () => {
    it('tracks unique files read (deduplicates)', () => {
      const tracker = new SessionTracker('test-session');

      tracker.recordToolCall(makeRecord({ toolName: 'Read', filePath: '/src/a.ts' }));
      tracker.recordToolCall(makeRecord({ toolName: 'Read', filePath: '/src/b.ts' }));
      tracker.recordToolCall(makeRecord({ toolName: 'Read', filePath: '/src/a.ts' }));

      const metrics = tracker.getMetrics();
      expect(metrics.uniqueFilesRead).toBe(2);
    });

    it('tracks unique files written via Write and Edit', () => {
      const tracker = new SessionTracker('test-session');

      tracker.recordToolCall(makeRecord({ toolName: 'Write', filePath: '/src/a.ts' }));
      tracker.recordToolCall(makeRecord({ toolName: 'Edit', filePath: '/src/b.ts' }));
      tracker.recordToolCall(makeRecord({ toolName: 'Write', filePath: '/src/a.ts' }));

      const metrics = tracker.getMetrics();
      expect(metrics.uniqueFilesWritten).toBe(2);
    });

    it('does not count Bash filePaths as file reads/writes', () => {
      const tracker = new SessionTracker('test-session');

      tracker.recordToolCall(makeRecord({ toolName: 'Bash', filePath: '/src/a.ts' }));

      const metrics = tracker.getMetrics();
      expect(metrics.uniqueFilesRead).toBe(0);
      expect(metrics.uniqueFilesWritten).toBe(0);
    });
  });

  describe('bash tracking', () => {
    it('counts bash commands', () => {
      const tracker = new SessionTracker('test-session');

      tracker.recordToolCall(makeRecord({ toolName: 'Bash' }));
      tracker.recordToolCall(makeRecord({ toolName: 'Bash' }));
      tracker.recordToolCall(makeRecord({ toolName: 'Read' }));

      const metrics = tracker.getMetrics();
      expect(metrics.bashCommandsRun).toBe(2);
    });

    it('populates bashExitCodes for Bash commands with exit codes', () => {
      const tracker = new SessionTracker('test-session');

      tracker.recordToolCall(makeRecord({ toolName: 'Bash', exitCode: 0 }));
      tracker.recordToolCall(makeRecord({ toolName: 'Bash', exitCode: 0 }));
      tracker.recordToolCall(makeRecord({ toolName: 'Bash', exitCode: 1 }));
      tracker.recordToolCall(makeRecord({ toolName: 'Bash', exitCode: 127 }));

      const metrics = tracker.getMetrics();
      expect(metrics.bashExitCodes).toEqual({ 0: 2, 1: 1, 127: 1 });
    });

    it('ignores exitCode on non-Bash tools', () => {
      const tracker = new SessionTracker('test-session');

      tracker.recordToolCall(makeRecord({ toolName: 'Edit', exitCode: 0 }));

      const metrics = tracker.getMetrics();
      expect(metrics.bashExitCodes).toEqual({});
    });

    it('handles Bash commands without exitCode field', () => {
      const tracker = new SessionTracker('test-session');

      tracker.recordToolCall(makeRecord({ toolName: 'Bash' }));

      const metrics = tracker.getMetrics();
      expect(metrics.bashCommandsRun).toBe(1);
      expect(metrics.bashExitCodes).toEqual({});
    });
  });

  describe('search tracking', () => {
    it('counts Grep and Glob as search queries', () => {
      const tracker = new SessionTracker('test-session');

      tracker.recordToolCall(makeRecord({ toolName: 'Grep' }));
      tracker.recordToolCall(makeRecord({ toolName: 'Glob' }));
      tracker.recordToolCall(makeRecord({ toolName: 'Grep' }));
      tracker.recordToolCall(makeRecord({ toolName: 'Read' }));

      const metrics = tracker.getMetrics();
      expect(metrics.searchQueries).toBe(3);
    });
  });

  describe('getMetrics()', () => {
    it('returns a complete snapshot with all fields', () => {
      const tracker = new SessionTracker('snapshot-session');

      tracker.recordToolCall(makeRecord({ toolName: 'Read', durationMs: 50, filePath: '/a.ts' }));
      tracker.recordToolCall(makeRecord({ toolName: 'Bash', durationMs: 200 }));

      const metrics = tracker.getMetrics();

      expect(metrics.sessionId).toBe('snapshot-session');
      expect(metrics.sessionStartTime).toEqual(expect.any(Number));
      expect(metrics.sessionDurationMs).toBeGreaterThanOrEqual(0);
      expect(metrics.toolCallCount).toBe(2);
      expect(metrics.toolCallCountByTool).toEqual({ Read: 1, Bash: 1 });
      expect(metrics.toolDurationMsByTool['Read']).toBeDefined();
      expect(metrics.toolDurationMsByTool['Bash']).toBeDefined();
      expect(metrics.toolSuccessRate).toBe(1);
      expect(metrics.toolSuccessRateByTool).toEqual({ Read: 1, Bash: 1 });
      expect(metrics.toolErrorCount).toBe(0);
      expect(metrics.toolErrorsByType).toEqual({});
      expect(metrics.uniqueFilesRead).toBe(1);
      expect(metrics.uniqueFilesWritten).toBe(0);
      expect(metrics.bashCommandsRun).toBe(1);
      expect(metrics.bashExitCodes).toEqual({});
      expect(metrics.searchQueries).toBe(0);
      expect(metrics.toolCallTimeline).toHaveLength(2);
    });
  });

  describe('timeline', () => {
    it('records entries in chronological order', () => {
      const tracker = new SessionTracker('test-session');

      tracker.recordToolCall(makeRecord({ toolName: 'Read', timestamp: 1000, durationMs: 10 }));
      tracker.recordToolCall(makeRecord({ toolName: 'Write', timestamp: 2000, durationMs: 20 }));
      tracker.recordToolCall(makeRecord({ toolName: 'Bash', timestamp: 3000, durationMs: 30 }));

      const metrics = tracker.getMetrics();
      expect(metrics.toolCallTimeline).toEqual([
        { timestamp: 1000, toolName: 'Read', durationMs: 10, success: true },
        { timestamp: 2000, toolName: 'Write', durationMs: 20, success: true },
        { timestamp: 3000, toolName: 'Bash', durationMs: 30, success: true },
      ]);
    });

    it('caps at 10,000 entries', () => {
      const tracker = new SessionTracker('test-session');

      for (let i = 0; i < 10_050; i++) {
        tracker.recordToolCall(makeRecord({ timestamp: i }));
      }

      const metrics = tracker.getMetrics();
      expect(metrics.toolCallTimeline).toHaveLength(10_000);
    });
  });

  describe('reset()', () => {
    it('clears all counters back to initial state', () => {
      const tracker = new SessionTracker('old-session');

      tracker.recordToolCall(makeRecord({ toolName: 'Read', filePath: '/a.ts' }));
      tracker.recordToolCall(makeRecord({ toolName: 'Bash', success: false, errorType: 'timeout' }));

      tracker.reset('new-session');

      const metrics = tracker.getMetrics();
      expect(metrics.sessionId).toBe('new-session');
      expect(metrics.toolCallCount).toBe(0);
      expect(metrics.toolCallCountByTool).toEqual({});
      expect(metrics.toolDurationMsByTool).toEqual({});
      expect(metrics.toolSuccessRate).toBe(1);
      expect(metrics.toolSuccessRateByTool).toEqual({});
      expect(metrics.toolErrorCount).toBe(0);
      expect(metrics.toolErrorsByType).toEqual({});
      expect(metrics.uniqueFilesRead).toBe(0);
      expect(metrics.uniqueFilesWritten).toBe(0);
      expect(metrics.bashCommandsRun).toBe(0);
      expect(metrics.bashExitCodes).toEqual({});
      expect(metrics.searchQueries).toBe(0);
      expect(metrics.toolCallTimeline).toHaveLength(0);
    });

    it('generates new sessionId when none provided', () => {
      const tracker = new SessionTracker('old-session');
      tracker.reset();

      const metrics = tracker.getMetrics();
      expect(metrics.sessionId).not.toBe('old-session');
      expect(metrics.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe('emitMetrics()', () => {
    it('records per-tool and session metrics to aggregator', () => {
      const tracker = new SessionTracker('test-session');

      tracker.recordToolCall(makeRecord({ toolName: 'Read', durationMs: 50 }));
      tracker.recordToolCall(makeRecord({ toolName: 'Read', durationMs: 100 }));
      tracker.recordToolCall(makeRecord({ toolName: 'Bash', durationMs: 200 }));
      tracker.recordToolCall(makeRecord({ toolName: 'Read', filePath: '/a.ts' }));
      tracker.recordToolCall(makeRecord({ toolName: 'Write', filePath: '/b.ts' }));

      const aggregator = new MetricAggregator();
      tracker.emitMetrics(aggregator);

      const metrics = aggregator.harvest();

      // Should have per-tool call_count, duration_ms, success_rate + session metrics
      const names = metrics.map(m => m.name);

      // Check that per-tool metrics were emitted
      expect(names).toContain('ai.tool.call_count.count');
      expect(names).toContain('ai.tool.duration_ms.count');
      expect(names).toContain('ai.tool.success_rate.count');

      // Check that session metrics were emitted
      expect(names).toContain('ai.session.duration_ms.count');
      expect(names).toContain('ai.session.unique_files_read.count');
      expect(names).toContain('ai.session.unique_files_written.count');
    });

    it('emits individual durations so aggregator count/sum/min/max reflect the real distribution', () => {
      const tracker = new SessionTracker('test-session');

      // 3 Read calls: 10ms, 90ms, 200ms
      tracker.recordToolCall(makeRecord({ toolName: 'Read', durationMs: 10 }));
      tracker.recordToolCall(makeRecord({ toolName: 'Read', durationMs: 90 }));
      tracker.recordToolCall(makeRecord({ toolName: 'Read', durationMs: 200 }));

      const aggregator = new MetricAggregator();
      tracker.emitMetrics(aggregator);
      const metrics = aggregator.harvest();

      const durationMetrics = metrics.filter(m => m.name.startsWith('ai.tool.duration_ms') && m.attributes?.tool === 'Read');
      const byName = Object.fromEntries(durationMetrics.map(m => [m.name, m.value]));

      // count = 3 (one record() call per duration, not one call with the mean)
      expect(byName['ai.tool.duration_ms.count']).toBe(3);
      // sum = 300 (actual total, not mean * 1)
      expect(byName['ai.tool.duration_ms.sum']).toBe(300);
      // min and max reflect the actual distribution
      expect(byName['ai.tool.duration_ms.min']).toBe(10);
      expect(byName['ai.tool.duration_ms.max']).toBe(200);
    });
  });
});

// ---------------------------------------------------------------------------
// computeP95 — nearest-rank formula
// ---------------------------------------------------------------------------

describe('computeP95()', () => {
  it('returns 0 for an empty array', () => {
    expect(computeP95([])).toBe(0);
  });

  it('returns the single value for a one-element array', () => {
    expect(computeP95([42])).toBe(42);
  });

  it('n=10: returns index 8 (value 90), not index 9 (max 100)', () => {
    // [10,20,30,40,50,60,70,80,90,100]
    // floor((10-1) * 0.95) = floor(8.55) = 8 → sorted[8] = 90
    const values = [100, 10, 50, 30, 80, 20, 70, 60, 40, 90];
    expect(computeP95(values)).toBe(90);
  });

  it('n=20: returns index 18, not index 19 (max)', () => {
    // Values 1..20; floor((20-1)*0.95) = floor(18.05) = 18 → sorted[18] = 19
    const values = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(computeP95(values)).toBe(19);
  });

  it('n=100: returns index 94 (p95 nearest-rank), not index 95', () => {
    // Values 1..100; floor((100-1)*0.95) = floor(94.05) = 94 → sorted[94] = 95
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(computeP95(values)).toBe(95);
  });
});
