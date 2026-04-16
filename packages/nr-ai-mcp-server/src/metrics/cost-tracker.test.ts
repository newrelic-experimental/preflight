import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { CostTracker } from './cost-tracker.js';
import { SessionTracker } from './session-tracker.js';
import { MetricAggregator } from '@nr-ai-observatory/shared';
import type { TokenUsage } from '@nr-ai-observatory/shared';
import type { ToolCallRecord } from '../storage/types.js';

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

function makeUsage(overrides?: Partial<TokenUsage>): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    ...overrides,
  };
}

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

describe('CostTracker', () => {
  describe('recordTokenUsage()', () => {
    it('calculates cost for 10k input + 2k output on claude-sonnet-4', () => {
      const tracker = new CostTracker();

      const usage = makeUsage({
        inputTokens: 10_000,
        outputTokens: 2_000,
        totalTokens: 12_000,
      });

      const breakdown = tracker.recordTokenUsage(usage, 'claude-sonnet-4');

      // claude-sonnet-4-20250514: input=$3/MTok, output=$15/MTok
      // input:  10000 * 3 / 1_000_000 = 0.03
      // output: 2000 * 15 / 1_000_000 = 0.03
      expect(breakdown.inputUsd).toBeCloseTo(0.03, 6);
      expect(breakdown.outputUsd).toBeCloseTo(0.03, 6);
      expect(breakdown.totalUsd).toBeCloseTo(0.06, 6);
    });

    it('accumulates cost across multiple reports', () => {
      const tracker = new CostTracker();

      const usage1 = makeUsage({ inputTokens: 10_000, outputTokens: 2_000, totalTokens: 12_000 });
      const usage2 = makeUsage({ inputTokens: 5_000, outputTokens: 1_000, totalTokens: 6_000 });

      tracker.recordTokenUsage(usage1, 'claude-sonnet-4');
      tracker.recordTokenUsage(usage2, 'claude-sonnet-4');

      const metrics = tracker.getMetrics();

      // First: 0.03 + 0.03 = 0.06
      // Second: 5000*3/1M + 1000*15/1M = 0.015 + 0.015 = 0.03
      // Total: 0.09
      expect(metrics.sessionTotalCostUsd).toBeCloseTo(0.09, 6);
      expect(metrics.totalInputTokens).toBe(15_000);
      expect(metrics.totalOutputTokens).toBe(3_000);
      expect(metrics.reportCount).toBe(2);
    });

    it('tracks thinking and cache tokens', () => {
      const tracker = new CostTracker();

      const usage = makeUsage({
        inputTokens: 1_000,
        outputTokens: 500,
        thinkingTokens: 2_000,
        cacheReadTokens: 3_000,
        cacheCreationTokens: 500,
        totalTokens: 7_000,
      });

      const breakdown = tracker.recordTokenUsage(usage, 'claude-sonnet-4');

      // claude-sonnet-4: thinking=$15/MTok, cacheRead=$0.3/MTok, cacheCreation=$3.75/MTok
      expect(breakdown.thinkingUsd).toBeCloseTo(2_000 * 15 / 1_000_000, 6);
      expect(breakdown.cacheReadUsd).toBeCloseTo(3_000 * 0.3 / 1_000_000, 6);
      expect(breakdown.cacheCreationUsd).toBeCloseTo(500 * 3.75 / 1_000_000, 6);

      const metrics = tracker.getMetrics();
      expect(metrics.totalThinkingTokens).toBe(2_000);
      expect(metrics.totalCacheReadTokens).toBe(3_000);
      expect(metrics.totalCacheCreationTokens).toBe(500);
    });

    it('sets model on metrics', () => {
      const tracker = new CostTracker();

      tracker.recordTokenUsage(makeUsage({ inputTokens: 100, totalTokens: 100 }), 'claude-opus-4');

      expect(tracker.getMetrics().model).toBe('claude-opus-4');
    });

    it('stores latest cost breakdown', () => {
      const tracker = new CostTracker();

      tracker.recordTokenUsage(
        makeUsage({ inputTokens: 1_000, totalTokens: 1_000 }),
        'claude-sonnet-4',
      );

      const metrics = tracker.getMetrics();
      expect(metrics.latestCostBreakdown).not.toBeNull();
      expect(metrics.latestCostBreakdown!.inputUsd).toBeCloseTo(1_000 * 3 / 1_000_000, 6);
    });
  });

  describe('recordEstimatedTokens()', () => {
    it('estimates ~1000 tokens from 4000 characters', () => {
      const tracker = new CostTracker();

      const breakdown = tracker.recordEstimatedTokens(4_000, 0, 'claude-sonnet-4');

      // 4000 / 4 = 1000 input tokens
      // cost: 1000 * 3 / 1_000_000 = 0.003
      expect(breakdown.inputUsd).toBeCloseTo(0.003, 6);
      expect(breakdown.outputUsd).toBe(0);

      const metrics = tracker.getMetrics();
      expect(metrics.totalInputTokens).toBe(1_000);
      expect(metrics.estimationCount).toBe(1);
      expect(metrics.reportCount).toBe(1); // estimation calls recordTokenUsage internally
    });

    it('estimates both input and output characters', () => {
      const tracker = new CostTracker();

      tracker.recordEstimatedTokens(2_000, 800, 'claude-sonnet-4');

      const metrics = tracker.getMetrics();
      // 2000/4 = 500 input, 800/4 = 200 output
      expect(metrics.totalInputTokens).toBe(500);
      expect(metrics.totalOutputTokens).toBe(200);
    });
  });

  describe('costPerLineOfCode', () => {
    it('computes $0.02/line for $2.00 cost and 100 lines', () => {
      const tracker = new CostTracker();

      // Generate $2.00 of cost
      // claude-sonnet-4: to get $2.00 total we need input cost + output cost = 2.00
      // Use: 400_000 input tokens at $3/MTok = $1.20, 53_333 output at $15/MTok ≈ $0.80
      // Simpler: just record multiple times to reach ~$2.00
      // 10k input + 2k output = $0.06 per report. 33.33 reports ≈ $2.00
      // Or use exact: 200_000 input at $3/MTok = $0.60, 93_333 output at $15/MTok = $1.40 ≈ $2.00
      // Cleanest: use a fixed known amount and scale
      const usage = makeUsage({
        inputTokens: 200_000,
        outputTokens: 93_334, // 93334 * 15/1M = 1.400010 → total ≈ 2.00001
        totalTokens: 293_334,
      });
      tracker.recordTokenUsage(usage, 'claude-sonnet-4');

      tracker.recordLinesChanged(100);

      const metrics = tracker.getMetrics();
      // Total cost ≈ $2.00, 100 lines → $0.02/line
      expect(metrics.costPerLineOfCode).toBeCloseTo(0.02, 2);
    });

    it('returns null when no lines changed', () => {
      const tracker = new CostTracker();

      tracker.recordTokenUsage(
        makeUsage({ inputTokens: 1_000, totalTokens: 1_000 }),
        'claude-sonnet-4',
      );

      expect(tracker.getMetrics().costPerLineOfCode).toBeNull();
    });
  });

  describe('costPerFileModified', () => {
    it('computes $0.50/file for $2.00 cost and 4 files', () => {
      const sessionTracker = new SessionTracker('test-session');
      const tracker = new CostTracker(sessionTracker);

      // Record 4 unique file writes in SessionTracker
      sessionTracker.recordToolCall(makeRecord({ toolName: 'Write', filePath: '/a.ts' }));
      sessionTracker.recordToolCall(makeRecord({ toolName: 'Write', filePath: '/b.ts' }));
      sessionTracker.recordToolCall(makeRecord({ toolName: 'Edit', filePath: '/c.ts' }));
      sessionTracker.recordToolCall(makeRecord({ toolName: 'Edit', filePath: '/d.ts' }));

      // Generate ~$2.00 of cost
      const usage = makeUsage({
        inputTokens: 200_000,
        outputTokens: 93_334,
        totalTokens: 293_334,
      });
      tracker.recordTokenUsage(usage, 'claude-sonnet-4');

      const metrics = tracker.getMetrics();
      expect(metrics.costPerFileModified).toBeCloseTo(0.50, 2);
    });

    it('returns null when no files written', () => {
      const sessionTracker = new SessionTracker('test-session');
      const tracker = new CostTracker(sessionTracker);

      tracker.recordTokenUsage(
        makeUsage({ inputTokens: 1_000, totalTokens: 1_000 }),
        'claude-sonnet-4',
      );

      expect(tracker.getMetrics().costPerFileModified).toBeNull();
    });

    it('returns null when no session tracker provided and cost exists', () => {
      const tracker = new CostTracker();

      tracker.recordTokenUsage(
        makeUsage({ inputTokens: 1_000, totalTokens: 1_000 }),
        'claude-sonnet-4',
      );

      expect(tracker.getMetrics().costPerFileModified).toBeNull();
    });
  });

  describe('null fields when no data', () => {
    it('returns null for cost fields when no tokens reported', () => {
      const tracker = new CostTracker();
      const metrics = tracker.getMetrics();

      expect(metrics.sessionTotalCostUsd).toBeNull();
      expect(metrics.costPerLineOfCode).toBeNull();
      expect(metrics.costPerFileModified).toBeNull();
      expect(metrics.costByTask).toBeNull();
      expect(metrics.model).toBeNull();
      expect(metrics.latestCostBreakdown).toBeNull();
      expect(metrics.reportCount).toBe(0);
      expect(metrics.estimationCount).toBe(0);
    });
  });

  describe('reset()', () => {
    it('clears all counters back to initial state', () => {
      const tracker = new CostTracker();

      tracker.recordTokenUsage(
        makeUsage({ inputTokens: 10_000, outputTokens: 2_000, totalTokens: 12_000 }),
        'claude-sonnet-4',
      );
      tracker.recordLinesChanged(50);

      tracker.reset();

      const metrics = tracker.getMetrics();
      expect(metrics.sessionTotalCostUsd).toBeNull();
      expect(metrics.totalInputTokens).toBe(0);
      expect(metrics.totalOutputTokens).toBe(0);
      expect(metrics.totalThinkingTokens).toBe(0);
      expect(metrics.totalCacheReadTokens).toBe(0);
      expect(metrics.totalCacheCreationTokens).toBe(0);
      expect(metrics.model).toBeNull();
      expect(metrics.reportCount).toBe(0);
      expect(metrics.estimationCount).toBe(0);
      expect(metrics.latestCostBreakdown).toBeNull();
      expect(metrics.costPerLineOfCode).toBeNull();
    });
  });

  describe('emitMetrics()', () => {
    it('records expected metric names to aggregator', () => {
      const tracker = new CostTracker();

      tracker.recordTokenUsage(
        makeUsage({ inputTokens: 10_000, outputTokens: 2_000, totalTokens: 12_000 }),
        'claude-sonnet-4',
      );
      tracker.recordLinesChanged(10);

      const aggregator = new MetricAggregator();
      tracker.emitMetrics(aggregator);

      const metrics = aggregator.harvest();
      const names = metrics.map((m) => m.name);

      expect(names).toContain('ai.cost.session_total_usd.count');
      expect(names).toContain('ai.cost.tokens_input.count');
      expect(names).toContain('ai.cost.tokens_output.count');
      expect(names).toContain('ai.cost.tokens_thinking.count');
      expect(names).toContain('ai.cost.tokens_cache_read.count');
      expect(names).toContain('ai.cost.cost_per_line_of_code.count');
      expect(names).toContain('ai.cost.report_count.count');
      expect(names).toContain('ai.cost.estimation_count.count');
    });

    it('emits cost_per_file_modified when session tracker has file data', () => {
      const sessionTracker = new SessionTracker('test-session');
      const tracker = new CostTracker(sessionTracker);

      sessionTracker.recordToolCall(makeRecord({ toolName: 'Write', filePath: '/a.ts' }));
      tracker.recordTokenUsage(
        makeUsage({ inputTokens: 1_000, totalTokens: 1_000 }),
        'claude-sonnet-4',
      );

      const aggregator = new MetricAggregator();
      tracker.emitMetrics(aggregator);

      const names = aggregator.harvest().map((m) => m.name);
      expect(names).toContain('ai.cost.cost_per_file_modified.count');
    });

    it('includes model attribute on metrics', () => {
      const tracker = new CostTracker();

      tracker.recordTokenUsage(
        makeUsage({ inputTokens: 1_000, totalTokens: 1_000 }),
        'claude-sonnet-4',
      );

      const aggregator = new MetricAggregator();
      tracker.emitMetrics(aggregator);

      const metrics = aggregator.harvest();
      // All metrics should have the model attribute
      const costMetric = metrics.find((m) => m.name === 'ai.cost.session_total_usd.count');
      expect(costMetric?.attributes).toEqual(expect.objectContaining({ model: 'claude-sonnet-4' }));
    });
  });
});
