import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { SessionTracker, computeP95 } from './session-tracker.js';
import type { ToolCallRecord } from '../storage/types.js';
import { MetricAggregator } from '../shared/index.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
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
      for (let i = 0; i < 6; i++)
        tracker.recordToolCall(makeRecord({ toolName: 'Read', success: true }));
      for (let i = 0; i < 2; i++)
        tracker.recordToolCall(makeRecord({ toolName: 'Read', success: false }));

      // 2 successful Bash
      for (let i = 0; i < 2; i++)
        tracker.recordToolCall(makeRecord({ toolName: 'Bash', success: true }));

      const metrics = tracker.getMetrics();

      // Overall: 8 success / 10 total = 0.8
      expect(metrics.toolSuccessRate).toBe(0.8);
      expect(metrics.toolErrorCount).toBe(2);

      // Per-tool: Read = 6/8 = 0.75, Bash = 2/2 = 1.0
      expect(metrics.toolSuccessRateByTool['Read']).toBe(0.75);
      expect(metrics.toolSuccessRateByTool['Bash']).toBe(1.0);
    });

    it('returns null toolSuccessRate when no tool calls recorded', () => {
      const tracker = new SessionTracker('empty-session');
      const metrics = tracker.getMetrics();
      expect(metrics.toolCallCount).toBe(0);
      expect(metrics.toolSuccessRate).toBeNull();
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

    it('accumulates bashCallsByCategory across multiple Bash calls', () => {
      const tracker = new SessionTracker('test-session');

      tracker.recordToolCall(makeRecord({ toolName: 'Bash', bashCategory: 'git' }));
      tracker.recordToolCall(makeRecord({ toolName: 'Bash', bashCategory: 'git' }));
      tracker.recordToolCall(makeRecord({ toolName: 'Bash', bashCategory: 'test-runner' }));
      tracker.recordToolCall(makeRecord({ toolName: 'Bash', bashCategory: 'build' }));
      // Non-Bash with stray bashCategory should NOT contribute.
      tracker.recordToolCall(makeRecord({ toolName: 'Read', bashCategory: 'git' }));
      // Bash without a category should NOT crash and should NOT add to map.
      tracker.recordToolCall(makeRecord({ toolName: 'Bash' }));

      const metrics = tracker.getMetrics();
      expect(metrics.bashCallsByCategory).toEqual({
        git: 2,
        'test-runner': 1,
        build: 1,
      });
    });

    it('clears bashCallsByCategory on reset', () => {
      const tracker = new SessionTracker('test-session');
      tracker.recordToolCall(makeRecord({ toolName: 'Bash', bashCategory: 'git' }));
      expect(tracker.getMetrics().bashCallsByCategory).toEqual({ git: 1 });

      tracker.reset('new-session');
      expect(tracker.getMetrics().bashCallsByCategory).toEqual({});
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
      expect(metrics.sessionStartTime).toBeGreaterThan(0);
      expect(metrics.sessionStartTime).toBeLessThan(Date.now() + 1000);
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

  describe('sessionName', () => {
    it('is null when no tool calls have a cwd', () => {
      const tracker = new SessionTracker('test-session');
      tracker.recordToolCall(makeRecord());
      expect(tracker.getMetrics().sessionName).toBeNull();
    });

    it('derives from basename of the first cwd seen', () => {
      const tracker = new SessionTracker('test-session');
      tracker.recordToolCall(makeRecord({ cwd: '/Users/dev/projects/my-app' }));
      expect(tracker.getMetrics().sessionName).toBe('my-app');
    });

    it('does not change after the first cwd is captured', () => {
      const tracker = new SessionTracker('test-session');
      tracker.recordToolCall(makeRecord({ cwd: '/home/user/first-project' }));
      tracker.recordToolCall(makeRecord({ cwd: '/home/user/second-project' }));
      expect(tracker.getMetrics().sessionName).toBe('first-project');
    });

    it('is cleared on reset()', () => {
      const tracker = new SessionTracker('test-session');
      tracker.recordToolCall(makeRecord({ cwd: '/home/user/my-project' }));
      expect(tracker.getMetrics().sessionName).toBe('my-project');

      tracker.reset('new-session');
      expect(tracker.getMetrics().sessionName).toBeNull();
    });
  });

  describe('adoptSessionId()', () => {
    it('updates the sessionId in place without clearing accumulated metrics', () => {
      const tracker = new SessionTracker('provisional-id');
      tracker.recordToolCall(makeRecord({ toolName: 'Read', durationMs: 50 }));
      tracker.recordToolCall(makeRecord({ toolName: 'Edit', durationMs: 80 }));

      // Adopt a real session ID.
      tracker.adoptSessionId('real-session-id');

      const metrics = tracker.getMetrics();
      // Session ID must be updated.
      expect(metrics.sessionId).toBe('real-session-id');
      // Previously accumulated tool calls must be preserved.
      expect(metrics.toolCallCount).toBe(2);
      expect(metrics.toolCallCountByTool['Read']).toBe(1);
      expect(metrics.toolCallCountByTool['Edit']).toBe(1);
    });

    it('throws when called with an empty string', () => {
      const tracker = new SessionTracker('valid-session');
      expect(() => tracker.adoptSessionId('')).toThrow(/requires a non-empty sessionId/);
    });
  });

  describe('reset()', () => {
    it('clears all counters back to initial state', () => {
      const tracker = new SessionTracker('old-session');

      tracker.recordToolCall(makeRecord({ toolName: 'Read', filePath: '/a.ts' }));
      tracker.recordToolCall(
        makeRecord({ toolName: 'Bash', success: false, errorType: 'timeout' }),
      );

      tracker.reset('new-session');

      const metrics = tracker.getMetrics();
      expect(metrics.sessionId).toBe('new-session');
      expect(metrics.toolCallCount).toBe(0);
      expect(metrics.toolCallCountByTool).toEqual({});
      expect(metrics.toolDurationMsByTool).toEqual({});
      expect(metrics.toolSuccessRate).toBeNull();
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

    it('throws when reset is called without a sessionId', () => {
      const tracker = new SessionTracker('old-session');
      // Cast through unknown to force the bad-call shape; runtime guard must throw.
      expect(() => (tracker as unknown as { reset: () => void }).reset()).toThrow(
        /requires a non-empty sessionId/,
      );
    });

    it('throws when constructed without a sessionId', () => {
      expect(() => new (SessionTracker as unknown as new () => SessionTracker)()).toThrow(
        /requires a non-empty sessionId/,
      );
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

      const metrics = aggregator.harvest(60_000);

      // Should have per-tool call_count, duration_ms, success_rate + session metrics
      const names = metrics.map((m) => m.name);

      // Check that per-tool metrics were emitted
      expect(names).toContain('ai.tool.call_count');
      expect(names).toContain('ai.tool.duration_ms');
      expect(names).toContain('ai.tool.success_rate');

      // Check that session metrics were emitted
      expect(names).toContain('ai.session.duration_ms');
      expect(names).toContain('ai.session.unique_files_read');
      expect(names).toContain('ai.session.unique_files_written');
    });

    it('emits individual durations so aggregator count/sum/min/max reflect the real distribution', () => {
      const tracker = new SessionTracker('test-session');

      // 3 Read calls: 10ms, 90ms, 200ms
      tracker.recordToolCall(makeRecord({ toolName: 'Read', durationMs: 10 }));
      tracker.recordToolCall(makeRecord({ toolName: 'Read', durationMs: 90 }));
      tracker.recordToolCall(makeRecord({ toolName: 'Read', durationMs: 200 }));

      const aggregator = new MetricAggregator();
      tracker.emitMetrics(aggregator);
      const metrics = aggregator.harvest(60_000);

      const durationMetric = metrics.find(
        (m) => m.name === 'ai.tool.duration_ms' && m.attributes?.tool === 'Read',
      );
      // harvest() now emits a single summary metric with { count, sum, min, max }
      const v = durationMetric?.value as { count: number; sum: number; min: number; max: number };
      // count = 3 (one record() call per duration, not one call with the mean)
      expect(v.count).toBe(3);
      // sum = 300 (actual total, not mean * 1)
      expect(v.sum).toBe(300);
      // min and max reflect the actual distribution
      expect(v.min).toBe(10);
      expect(v.max).toBe(200);
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
