import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { CostTracker } from './cost-tracker.js';
import type { TokenRecordContext } from './cost-tracker.js';
import { localDateKey } from '../lib/date.js';
import { SessionTracker } from './session-tracker.js';
import { MetricAggregator } from '../shared/index.js';
import type { TokenUsage } from '../shared/index.js';
import type { ToolCallRecord } from '../storage/types.js';

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

    it('tracks per-model cost breakdown across multiple models', () => {
      const tracker = new CostTracker();

      // Sonnet: 10k input ($0.03) + 2k output ($0.03) = $0.06
      tracker.recordTokenUsage(
        makeUsage({ inputTokens: 10_000, outputTokens: 2_000, totalTokens: 12_000 }),
        'claude-sonnet-4',
      );

      // Opus: 10k input ($0.05) + 2k output ($0.05) = $0.10
      // claude-opus-4 → claude-opus-4-7: input=$5/MTok, output=$25/MTok
      tracker.recordTokenUsage(
        makeUsage({ inputTokens: 10_000, outputTokens: 2_000, totalTokens: 12_000 }),
        'claude-opus-4',
      );

      // Another Sonnet report: same as first = $0.06
      tracker.recordTokenUsage(
        makeUsage({ inputTokens: 10_000, outputTokens: 2_000, totalTokens: 12_000 }),
        'claude-sonnet-4',
      );

      const metrics = tracker.getMetrics();

      expect(Object.keys(metrics.costByModel)).toHaveLength(2);
      expect(metrics.costByModel['claude-sonnet-4']).toBeCloseTo(0.12, 4);
      expect(metrics.costByModel['claude-opus-4']).toBeCloseTo(0.1, 4);
      // Total should equal sum of models
      expect(metrics.sessionTotalCostUsd).toBeCloseTo(0.22, 4);
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
      expect(breakdown.thinkingUsd).toBeCloseTo((2_000 * 15) / 1_000_000, 6);
      expect(breakdown.cacheReadUsd).toBeCloseTo((3_000 * 0.3) / 1_000_000, 6);
      expect(breakdown.cacheCreationUsd).toBeCloseTo((500 * 3.75) / 1_000_000, 6);

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
      expect(metrics.latestCostBreakdown!.inputUsd).toBeCloseTo((1_000 * 3) / 1_000_000, 6);
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
      expect(metrics.reportCount).toBe(0);
    });

    it('estimates both input and output characters', () => {
      const tracker = new CostTracker();

      tracker.recordEstimatedTokens(2_000, 800, 'claude-sonnet-4');

      const metrics = tracker.getMetrics();
      // 2000/4 = 500 input, 800/4 = 200 output
      expect(metrics.totalInputTokens).toBe(500);
      expect(metrics.totalOutputTokens).toBe(200);
    });

    it('accumulated input+output tokens equal their sum (no double-rounding drift)', () => {
      const tracker = new CostTracker();

      // inputChars=1, outputChars=1: each rounds to 0 independently (0+0=0).
      // A naive re-round of the combined chars would give Math.round(2/4)=1,
      // producing a totalTokens that exceeds the sum of its components.
      // The fix pre-rounds into named variables so totalTokens = inputTokens + outputTokens.
      tracker.recordEstimatedTokens(1, 1, 'claude-sonnet-4');

      const metrics = tracker.getMetrics();
      // Both components round to 0; total must also be 0, not 1
      expect(metrics.totalInputTokens).toBe(0);
      expect(metrics.totalOutputTokens).toBe(0);
      expect(metrics.totalInputTokens + metrics.totalOutputTokens).toBe(0);
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

  describe('getSubagentCostForDay', () => {
    it('buckets only subagent-attributed cost per local day', () => {
      const tracker = new CostTracker();
      const now = Date.now();
      const dayKey = localDateKey(now);
      // Parent event (no agentId) — must NOT land in the subagent day bucket.
      tracker.recordTokenUsage(
        makeUsage({ inputTokens: 100_000, totalTokens: 100_000 }),
        'claude-sonnet-4',
        { timestampMs: now } satisfies TokenRecordContext,
      );
      // Subagent event (agentId set) — SHOULD land in the subagent day bucket.
      tracker.recordTokenUsage(
        makeUsage({ inputTokens: 200_000, outputTokens: 100_000, totalTokens: 300_000 }),
        'claude-sonnet-4',
        { agentId: 'agent-1', timestampMs: now } satisfies TokenRecordContext,
      );

      const subToday = tracker.getSubagentCostForDay(dayKey);
      const allToday = tracker.getCostForDay(dayKey);
      // Subagent-day spend is positive but strictly less than the all-in day
      // total (which also includes the parent event).
      expect(subToday).toBeGreaterThan(0);
      expect(subToday).toBeLessThan(allToday);
      // With a single day, the subagent-day bucket equals the cumulative
      // subagent total — and the all-in day total is NOT double-counted.
      expect(subToday).toBeCloseTo(tracker.getSubagentMetrics().subagentUsd, 6);
    });

    it('returns 0 for a day with no subagent activity', () => {
      const tracker = new CostTracker();
      tracker.recordTokenUsage(
        makeUsage({ inputTokens: 1_000, totalTokens: 1_000 }),
        'claude-sonnet-4',
      );
      expect(tracker.getSubagentCostForDay(localDateKey(Date.now()))).toBe(0);
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
      expect(metrics.costPerFileModified).toBeCloseTo(0.5, 2);
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

  describe('costPerMillionTokens', () => {
    it('computes the blended session rate across input/output tokens', () => {
      const tracker = new CostTracker();

      // claude-sonnet-4: 500k*3/1M + 500k*15/1M = 1.5 + 7.5 = 9.0 for 1M tokens
      tracker.recordTokenUsage(
        makeUsage({ inputTokens: 500_000, outputTokens: 500_000, totalTokens: 1_000_000 }),
        'claude-sonnet-4',
      );

      expect(tracker.getMetrics().costPerMillionTokens).toBeCloseTo(9.0, 2);
    });

    it('returns null when no tokens have been reported', () => {
      const tracker = new CostTracker();
      expect(tracker.getMetrics().costPerMillionTokens).toBeNull();
    });
  });

  describe('null fields when no data', () => {
    it('returns null for cost fields when no tokens reported', () => {
      const tracker = new CostTracker();
      const metrics = tracker.getMetrics();

      expect(metrics.sessionTotalCostUsd).toBeNull();
      expect(metrics.costPerLineOfCode).toBeNull();
      expect(metrics.costPerFileModified).toBeNull();
      expect(metrics.costPerMillionTokens).toBeNull();
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

  // -------------------------------------------------------------------------
  // cost calculation edge cases
  // -------------------------------------------------------------------------

  describe('cost calculation edge cases', () => {
    it('unknown model name returns all-zero cost breakdown without crashing', () => {
      const tracker = new CostTracker();
      const breakdown = tracker.recordTokenUsage(
        makeUsage({ inputTokens: 10_000, outputTokens: 2_000, totalTokens: 12_000 }),
        'fictional-model-9000',
      );
      // Unknown model → ZERO_COST fallback; no NaN, no throw
      expect(breakdown.totalUsd).toBe(0);
      expect(breakdown.inputUsd).toBe(0);
      expect(breakdown.outputUsd).toBe(0);
      expect(Number.isNaN(breakdown.totalUsd)).toBe(false);
      // reportCount incremented → sessionTotalCostUsd is 0 (not null)
      const metrics = tracker.getMetrics();
      expect(metrics.sessionTotalCostUsd).toBe(0);
      expect(metrics.model).toBe('fictional-model-9000');
    });

    it('cache-read tokens are charged at 10% of the input rate (claude-sonnet-4)', () => {
      const tracker = new CostTracker();
      // 1M input ($3.00/MTok → $3.00) + 1M cache-read ($0.30/MTok → $0.30)
      const breakdown = tracker.recordTokenUsage(
        makeUsage({ inputTokens: 1_000_000, cacheReadTokens: 1_000_000, totalTokens: 1_000_000 }),
        'claude-sonnet-4',
      );
      expect(breakdown.inputUsd).toBeCloseTo(3.0, 6);
      expect(breakdown.cacheReadUsd).toBeCloseTo(0.3, 6);
      // Ratio: cache-read is exactly 10% of input for the same token count
      expect(breakdown.cacheReadUsd).toBeCloseTo(breakdown.inputUsd * 0.1, 6);
    });

    it('cache-creation tokens are charged at 125% of the input rate (claude-sonnet-4: $3.75 vs $3.00/MTok)', () => {
      const tracker = new CostTracker();
      // 1M input ($3.00/MTok → $3.00) + 1M cache-creation ($3.75/MTok → $3.75)
      const breakdown = tracker.recordTokenUsage(
        makeUsage({
          inputTokens: 1_000_000,
          cacheCreationTokens: 1_000_000,
          totalTokens: 1_000_000,
        }),
        'claude-sonnet-4',
      );
      expect(breakdown.inputUsd).toBeCloseTo(3.0, 6);
      expect(breakdown.cacheCreationUsd).toBeCloseTo(3.75, 6);
      // Ratio: cache-creation is 1.25× the input rate
      expect(breakdown.cacheCreationUsd).toBeCloseTo(breakdown.inputUsd * 1.25, 6);
    });

    it('three-model session produces correct per-model costByModel and session total', () => {
      const tracker = new CostTracker();

      // claude-sonnet-4: 10k input ($0.03) + 2k output ($0.03) = $0.06
      tracker.recordTokenUsage(
        makeUsage({ inputTokens: 10_000, outputTokens: 2_000, totalTokens: 12_000 }),
        'claude-sonnet-4',
      );
      // claude-opus-4 → claude-opus-4-7: 10k input ($0.05) + 2k output ($0.05) = $0.10
      tracker.recordTokenUsage(
        makeUsage({ inputTokens: 10_000, outputTokens: 2_000, totalTokens: 12_000 }),
        'claude-opus-4',
      );
      // claude-haiku-4-5: 10k input ($0.01) + 2k output ($0.01) = $0.02
      tracker.recordTokenUsage(
        makeUsage({ inputTokens: 10_000, outputTokens: 2_000, totalTokens: 12_000 }),
        'claude-haiku-4-5',
      );

      const metrics = tracker.getMetrics();
      expect(Object.keys(metrics.costByModel)).toHaveLength(3);
      expect(metrics.costByModel['claude-sonnet-4']).toBeCloseTo(0.06, 4);
      expect(metrics.costByModel['claude-opus-4']).toBeCloseTo(0.1, 4);
      expect(metrics.costByModel['claude-haiku-4-5']).toBeCloseTo(0.02, 4);
      // Session total equals the sum of per-model costs
      const modelSum = Object.values(metrics.costByModel).reduce((a, b) => a + b, 0);
      expect(metrics.sessionTotalCostUsd).toBeCloseTo(modelSum, 6);
    });

    it('char-based estimation path populates sessionTotalCostUsd when no self-reported tokens exist', () => {
      const tracker = new CostTracker();
      // Only estimation, no reportTokenUsage call
      tracker.recordEstimatedTokens(4_000, 1_000, 'claude-sonnet-4');

      const metrics = tracker.getMetrics();
      expect(metrics.reportCount).toBe(0);
      expect(metrics.estimationCount).toBe(1);
      // Estimation counts as hasData → sessionTotalCostUsd must be non-null
      expect(metrics.sessionTotalCostUsd).not.toBeNull();
      expect(metrics.sessionTotalCostUsd).toBeGreaterThan(0);
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

      const metrics = aggregator.harvest(60_000);
      const names = metrics.map((m) => m.name);

      expect(names).toContain('ai.cost.session_total_usd');
      expect(names).toContain('ai.cost.tokens_input');
      expect(names).toContain('ai.cost.tokens_output');
      expect(names).toContain('ai.cost.tokens_thinking');
      expect(names).toContain('ai.cost.tokens_cache_read');
      expect(names).toContain('ai.cost.cost_per_line_of_code');
      expect(names).toContain('ai.cost.report_count');
      expect(names).toContain('ai.cost.estimation_count');
      expect(names).toContain('ai.cost.per_million_tokens');
    });

    it('omits per_million_tokens when no tokens have been reported', () => {
      const tracker = new CostTracker();

      const aggregator = new MetricAggregator();
      tracker.emitMetrics(aggregator);

      const names = aggregator.harvest(60_000).map((m) => m.name);
      expect(names).not.toContain('ai.cost.per_million_tokens');
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

      const names = aggregator.harvest(60_000).map((m) => m.name);
      expect(names).toContain('ai.cost.cost_per_file_modified');
    });

    it('includes model attribute on metrics', () => {
      const tracker = new CostTracker();

      tracker.recordTokenUsage(
        makeUsage({ inputTokens: 1_000, totalTokens: 1_000 }),
        'claude-sonnet-4',
      );

      const aggregator = new MetricAggregator();
      tracker.emitMetrics(aggregator);

      const metrics = aggregator.harvest(60_000);
      // All metrics should have the model attribute
      const costMetric = metrics.find((m) => m.name === 'ai.cost.session_total_usd');
      expect(costMetric?.attributes).toEqual(expect.objectContaining({ model: 'claude-sonnet-4' }));
    });
  });

  describe('cache health fields', () => {
    it('cacheHitRate is null when no token data', () => {
      const tracker = new CostTracker();
      expect(tracker.getMetrics().cacheHitRate).toBeNull();
      expect(tracker.getMetrics().totalCacheSavingsUsd).toBe(0);
    });

    it('cacheHitRate is null when only input/output tokens (no cache activity)', () => {
      const tracker = new CostTracker();
      tracker.recordTokenUsage(
        makeUsage({ inputTokens: 10_000, outputTokens: 2_000, totalTokens: 12_000 }),
        'claude-sonnet-4-6',
      );
      expect(tracker.getMetrics().cacheHitRate).toBeNull();
    });

    it('computes cacheHitRate correctly with cache reads', () => {
      const tracker = new CostTracker();
      tracker.recordTokenUsage(
        makeUsage({
          inputTokens: 3_000,
          outputTokens: 1_000,
          cacheReadTokens: 6_000,
          cacheCreationTokens: 1_000,
          totalTokens: 4_000,
        }),
        'claude-sonnet-4-6',
      );
      const metrics = tracker.getMetrics();
      // cacheHitRate = 6000 / (3000 + 6000 + 1000) = 0.6
      expect(metrics.cacheHitRate).toBeCloseTo(0.6, 5);
    });

    it('accumulates totalCacheSavingsUsd across multiple reports', () => {
      const tracker = new CostTracker();
      // Two identical reports with cache reads
      const usage = makeUsage({
        inputTokens: 1_000,
        outputTokens: 500,
        cacheReadTokens: 5_000,
        cacheCreationTokens: 0,
        totalTokens: 1_500,
      });
      tracker.recordTokenUsage(usage, 'claude-sonnet-4-6');
      tracker.recordTokenUsage(usage, 'claude-sonnet-4-6');
      // savingsFromCacheUsd should be > 0 and double that of a single report
      const after1 = new CostTracker();
      after1.recordTokenUsage(usage, 'claude-sonnet-4-6');
      const single = after1.getMetrics().totalCacheSavingsUsd;
      expect(tracker.getMetrics().totalCacheSavingsUsd).toBeCloseTo(single * 2, 8);
      expect(tracker.getMetrics().totalCacheSavingsUsd).toBeGreaterThan(0);
    });

    it('reset() clears cache savings and hit rate', () => {
      const tracker = new CostTracker();
      tracker.recordTokenUsage(
        makeUsage({ inputTokens: 1_000, cacheReadTokens: 2_000, totalTokens: 1_000 }),
        'claude-sonnet-4-6',
      );
      tracker.reset();
      expect(tracker.getMetrics().cacheHitRate).toBeNull();
      expect(tracker.getMetrics().totalCacheSavingsUsd).toBe(0);
    });
  });

  describe('per-day cost attribution', () => {
    // Each token event is bucketed by the *local* day at the moment it was
    // recorded. Without this bucket the dashboard's "Today Spend" credits
    // pre-midnight tokens to today when a session crosses midnight.
    it('attributes a token event to the local day at time of record', () => {
      const tracker = new CostTracker();
      const noonToday = new Date();
      noonToday.setHours(12, 0, 0, 0);
      jest.useFakeTimers().setSystemTime(noonToday);
      try {
        tracker.recordTokenUsage(
          makeUsage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500 }),
          'claude-sonnet-4',
        );
        const dayKey = `${noonToday.getFullYear()}-${String(noonToday.getMonth() + 1).padStart(2, '0')}-${String(noonToday.getDate()).padStart(2, '0')}`;
        expect(tracker.getCostForDay(dayKey)).toBeGreaterThan(0);
      } finally {
        jest.useRealTimers();
      }
    });

    it('keeps yesterday and today buckets separate when a session crosses midnight', () => {
      const tracker = new CostTracker();
      const yesterday11pm = new Date();
      yesterday11pm.setDate(yesterday11pm.getDate() - 1);
      yesterday11pm.setHours(23, 0, 0, 0);
      const today1am = new Date(yesterday11pm.getTime() + 2 * 3_600_000);
      const yKey = `${yesterday11pm.getFullYear()}-${String(yesterday11pm.getMonth() + 1).padStart(2, '0')}-${String(yesterday11pm.getDate()).padStart(2, '0')}`;
      const tKey = `${today1am.getFullYear()}-${String(today1am.getMonth() + 1).padStart(2, '0')}-${String(today1am.getDate()).padStart(2, '0')}`;

      jest.useFakeTimers();
      try {
        jest.setSystemTime(yesterday11pm);
        tracker.recordTokenUsage(
          makeUsage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500 }),
          'claude-sonnet-4',
        );
        const yesterdayCost = tracker.getCostForDay(yKey);
        expect(yesterdayCost).toBeGreaterThan(0);

        jest.setSystemTime(today1am);
        tracker.recordTokenUsage(
          makeUsage({ inputTokens: 2000, outputTokens: 1000, totalTokens: 3000 }),
          'claude-sonnet-4',
        );
        const todayCost = tracker.getCostForDay(tKey);
        expect(todayCost).toBeGreaterThan(0);

        // Today cost is roughly 2x yesterday (same model, 2x tokens). Crucial
        // assertion: yesterday's bucket did NOT grow when today's tokens landed.
        expect(tracker.getCostForDay(yKey)).toBe(yesterdayCost);
        expect(todayCost).toBeGreaterThan(yesterdayCost);
        expect(yesterdayCost + todayCost).toBeCloseTo(
          tracker.getMetrics().sessionTotalCostUsd ?? 0,
          10,
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('records first-activity-of-day so forecast can compute today-only burn rate', () => {
      const tracker = new CostTracker();
      const morning = new Date();
      morning.setHours(9, 0, 0, 0);
      const afternoon = new Date(morning.getTime() + 4 * 3_600_000);
      const dayKey = `${morning.getFullYear()}-${String(morning.getMonth() + 1).padStart(2, '0')}-${String(morning.getDate()).padStart(2, '0')}`;

      jest.useFakeTimers();
      try {
        jest.setSystemTime(morning);
        tracker.recordTokenUsage(
          makeUsage({ inputTokens: 100, outputTokens: 50, totalTokens: 150 }),
          'claude-sonnet-4',
        );
        const firstAt = tracker.getFirstActivityMsForDay(dayKey);
        expect(firstAt).toBe(morning.getTime());

        // A second event later the same day must NOT move first-activity
        // (otherwise the forecast denominator shrinks and rate spikes).
        jest.setSystemTime(afternoon);
        tracker.recordTokenUsage(
          makeUsage({ inputTokens: 100, outputTokens: 50, totalTokens: 150 }),
          'claude-sonnet-4',
        );
        expect(tracker.getFirstActivityMsForDay(dayKey)).toBe(morning.getTime());
      } finally {
        jest.useRealTimers();
      }
    });

    it('returns 0 for days with no recorded activity', () => {
      const tracker = new CostTracker();
      expect(tracker.getCostForDay('2026-01-01')).toBe(0);
      expect(tracker.getFirstActivityMsForDay('2026-01-01')).toBeNull();
    });

    it('clears day buckets on reset', () => {
      const tracker = new CostTracker();
      tracker.recordTokenUsage(
        makeUsage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500 }),
        'claude-sonnet-4',
      );
      const today = new Date();
      const dayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      expect(tracker.getCostForDay(dayKey)).toBeGreaterThan(0);

      tracker.reset();

      expect(tracker.getCostForDay(dayKey)).toBe(0);
      expect(tracker.getFirstActivityMsForDay(dayKey)).toBeNull();
    });
  });

  describe('PRD ctx — timestampMs override + per-run attribution', () => {
    it('honors ctx.timestampMs for day bucketing instead of Date.now()', () => {
      const tracker = new CostTracker();
      // Pick a timestamp from 2025-01-15 in local-day terms.
      const earlyTs = new Date(2025, 0, 15, 12, 0, 0).getTime();
      tracker.recordTokenUsage(
        makeUsage({ inputTokens: 10_000, outputTokens: 2_000, totalTokens: 12_000 }),
        'claude-sonnet-4',
        { timestampMs: earlyTs },
      );
      // Late-arrival window: a >48h backdated ts should NOT inflate today's bucket.
      const today = new Date();
      const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      // The 2025-01-15 ts is more than 48h ago, so it gets dropped from buckets.
      expect(tracker.getCostForDay('2025-01-15')).toBe(0);
      expect(tracker.getCostForDay(todayKey)).toBe(0);
      // …but session totals still update.
      expect(tracker.getMetrics().sessionTotalCostUsd).toBeGreaterThan(0);
    });

    it('attributes per-day spend to a backdated-but-recent timestamp', () => {
      const tracker = new CostTracker();
      // Use a timestamp 2h ago (within 48h window).
      const ts = Date.now() - 2 * 60 * 60 * 1000;
      tracker.recordTokenUsage(
        makeUsage({ inputTokens: 10_000, outputTokens: 2_000, totalTokens: 12_000 }),
        'claude-sonnet-4',
        { timestampMs: ts },
      );
      const dayKey = (() => {
        const d = new Date(ts);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      })();
      expect(tracker.getCostForDay(dayKey)).toBeGreaterThan(0);
      expect(tracker.getFirstActivityMsForDay(dayKey)).toBe(ts);
    });

    it('keeps the EARLIEST timestamp per day across multiple records', () => {
      const tracker = new CostTracker();
      const t1 = Date.now() - 2 * 60 * 60 * 1000;
      const t0 = t1 - 60 * 1000; // t0 is earlier
      tracker.recordTokenUsage(
        makeUsage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500 }),
        'claude-sonnet-4',
        { timestampMs: t1 },
      );
      tracker.recordTokenUsage(
        makeUsage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500 }),
        'claude-sonnet-4',
        { timestampMs: t0 },
      );
      const dayKey = (() => {
        const d = new Date(t0);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      })();
      expect(tracker.getFirstActivityMsForDay(dayKey)).toBe(t0);
    });

    it('records per-workflow-run cost when ctx.workflowRunId is present', () => {
      const tracker = new CostTracker();
      tracker.recordTokenUsage(
        makeUsage({ inputTokens: 10_000, outputTokens: 2_000, totalTokens: 12_000 }),
        'claude-sonnet-4',
        { workflowRunId: 'wf_abc' },
      );
      tracker.recordTokenUsage(
        makeUsage({ inputTokens: 5_000, outputTokens: 1_000, totalTokens: 6_000 }),
        'claude-sonnet-4',
        { workflowRunId: 'wf_abc' },
      );
      const cost = tracker.getCostForWorkflowRun('wf_abc');
      expect(cost).toBeGreaterThan(0);
      expect(tracker.getCostForWorkflowRun('wf_other')).toBe(0);
    });

    it('tracks subagentCostUsd and parentCostUsd via agentId split', () => {
      const tracker = new CostTracker();
      // No tokens recorded yet — both should be 0.
      expect(tracker.getSubagentMetrics().subagentUsd).toBe(0);
      expect(tracker.getSubagentMetrics().parentUsd).toBe(0);

      // agentId present → subagent bucket
      tracker.recordTokenUsage(
        makeUsage({ inputTokens: 10_000, outputTokens: 2_000, totalTokens: 12_000 }),
        'claude-sonnet-4',
        { workflowRunId: 'wf_a', agentId: 'agent-1' },
      );
      expect(tracker.getSubagentMetrics().subagentUsd).toBeGreaterThan(0);
      expect(tracker.getSubagentMetrics().parentUsd).toBe(0);

      // agentId absent → parent bucket
      tracker.recordTokenUsage(
        makeUsage({ inputTokens: 5_000, outputTokens: 1_000, totalTokens: 6_000 }),
        'claude-sonnet-4',
        { workflowRunId: 'wf_a' },
      );
      expect(tracker.getSubagentMetrics().parentUsd).toBeGreaterThan(0);
      // subagentSharePct should be between 0 and 100
      const pct = tracker.getSubagentMetrics().subagentSharePct;
      expect(pct).toBeGreaterThan(0);
      expect(pct).toBeLessThan(100);
      // reconciliationDeltaPct is null (not yet computed)
      expect(tracker.getSubagentMetrics().reconciliationDeltaPct).toBeNull();
    });

    it('reset() clears workflow-run cost and subagent totals', () => {
      const tracker = new CostTracker();
      tracker.recordTokenUsage(
        makeUsage({ inputTokens: 10_000, outputTokens: 2_000, totalTokens: 12_000 }),
        'claude-sonnet-4',
        { workflowRunId: 'wf_a' },
      );
      tracker.reset();
      expect(tracker.getCostForWorkflowRun('wf_a')).toBe(0);
      expect(tracker.getSubagentMetrics().subagentUsd).toBe(0);
      expect(tracker.getSubagentMetrics().parentUsd).toBe(0);
    });

    it('records last-mutation ms per day for cache invalidation', () => {
      const tracker = new CostTracker();
      const ts = Date.now() - 60 * 1000;
      tracker.recordTokenUsage(
        makeUsage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500 }),
        'claude-sonnet-4',
        { timestampMs: ts },
      );
      const dayKey = (() => {
        const d = new Date(ts);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      })();
      const last = tracker.getLastMutationMsForDay(dayKey);
      expect(last).not.toBeNull();
      expect(last!).toBeGreaterThanOrEqual(ts);
    });
  });
});

// ---------------------------------------------------------------------------
// Subagent token support
// ---------------------------------------------------------------------------

/** Helper: produce a YYYY-MM-DD key from any epoch-ms value. */
function dayKeyFromMs(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

describe('subagent token support', () => {
  it('ctx.timestampMs attributes cost to the correct dayKey (not Date.now())', () => {
    const tracker = new CostTracker();
    // Use a timestamp 6 hours ago — within the 48h window so it is not dropped.
    const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
    const ctx: TokenRecordContext = { timestampMs: sixHoursAgo };

    tracker.recordTokenUsage(
      makeUsage({ inputTokens: 1_000, outputTokens: 500, totalTokens: 1_500 }),
      'claude-sonnet-4',
      ctx,
    );

    const expectedDayKey = dayKeyFromMs(sixHoursAgo);
    expect(tracker.getCostForDay(expectedDayKey)).toBeGreaterThan(0);
    expect(tracker.getFirstActivityMsForDay(expectedDayKey)).toBe(sixHoursAgo);
  });

  it('cross-midnight: entries from yesterday go to yesterday bucket, today to today bucket', () => {
    const tracker = new CostTracker();

    // Build two timestamps around midnight using fake timers so the test is
    // date-independent: yesterday at 23:00 and today at 01:00.
    const yesterday11pm = new Date();
    yesterday11pm.setDate(yesterday11pm.getDate() - 1);
    yesterday11pm.setHours(23, 0, 0, 0);
    const today1am = new Date(yesterday11pm.getTime() + 2 * 3_600_000);

    const yKey = dayKeyFromMs(yesterday11pm.getTime());
    const tKey = dayKeyFromMs(today1am.getTime());

    jest.useFakeTimers();
    try {
      // Record a token event attributed to yesterday (fake wall clock at yesterday).
      jest.setSystemTime(yesterday11pm);
      tracker.recordTokenUsage(
        makeUsage({ inputTokens: 1_000, outputTokens: 500, totalTokens: 1_500 }),
        'claude-sonnet-4',
        { timestampMs: yesterday11pm.getTime() },
      );
      const yesterdayCost = tracker.getCostForDay(yKey);
      expect(yesterdayCost).toBeGreaterThan(0);

      // Record a token event attributed to today.
      jest.setSystemTime(today1am);
      tracker.recordTokenUsage(
        makeUsage({ inputTokens: 2_000, outputTokens: 1_000, totalTokens: 3_000 }),
        'claude-sonnet-4',
        { timestampMs: today1am.getTime() },
      );
      const todayCost = tracker.getCostForDay(tKey);
      expect(todayCost).toBeGreaterThan(0);

      // Yesterday's bucket must not have grown when today's tokens landed.
      expect(tracker.getCostForDay(yKey)).toBe(yesterdayCost);
      expect(todayCost).toBeGreaterThan(yesterdayCost);
    } finally {
      jest.useRealTimers();
    }
  });

  it('late arrival (>48h): day bucket skipped, session total still accumulates', () => {
    const tracker = new CostTracker();
    const oldTs = Date.now() - 49 * 60 * 60 * 1000; // 49h ago
    const ctx: TokenRecordContext = { timestampMs: oldTs };

    const breakdown = tracker.recordTokenUsage(
      makeUsage({ inputTokens: 10_000, outputTokens: 2_000, totalTokens: 12_000 }),
      'claude-sonnet-4',
      ctx,
    );

    // The CostBreakdown return value must be valid (not zeroed — cost is real).
    expect(breakdown.totalUsd).toBeGreaterThan(0);

    // Day bucket for the backdated key must remain 0 (rejected).
    const oldDayKey = dayKeyFromMs(oldTs);
    expect(tracker.getCostForDay(oldDayKey)).toBe(0);

    // Session-level total still captures the cost.
    expect(tracker.getMetrics().sessionTotalCostUsd).toBeGreaterThan(0);
    expect(tracker.getMetrics().reportCount).toBe(1);
  });

  it('late arrival (>48h): totalCacheSavingsUsd still accumulates like every other session total', () => {
    const tracker = new CostTracker();
    const oldTs = Date.now() - 49 * 60 * 60 * 1000; // 49h ago
    const ctx: TokenRecordContext = { timestampMs: oldTs };

    // A cache-heavy usage shape guarantees savingsFromCacheUsd > 0 for a
    // real model (mirrors the 'accumulates totalCacheSavingsUsd' test above).
    tracker.recordTokenUsage(
      makeUsage({
        inputTokens: 1_000,
        outputTokens: 500,
        cacheReadTokens: 5_000,
        cacheCreationTokens: 0,
        totalTokens: 1_500,
      }),
      'claude-sonnet-4-6',
      ctx,
    );

    // Every other session-level total accumulates on the late-arrival path
    // (asserted by the sibling test above); totalCacheSavingsUsd must too.
    expect(tracker.getMetrics().totalCacheSavingsUsd).toBeGreaterThan(0);
  });

  it('ctx.agentId set → cost attributed to subagentCostUsd in getMetrics()', () => {
    const tracker = new CostTracker();
    tracker.recordTokenUsage(
      makeUsage({ inputTokens: 10_000, outputTokens: 2_000, totalTokens: 12_000 }),
      'claude-sonnet-4',
      { agentId: 'agent-abc' },
    );

    const metrics = tracker.getMetrics();
    expect(metrics.subagentCostUsd).toBeGreaterThan(0);
    expect(metrics.parentCostUsd).toBe(0);
  });

  it('ctx.agentId absent → cost attributed to parentCostUsd in getMetrics()', () => {
    const tracker = new CostTracker();
    tracker.recordTokenUsage(
      makeUsage({ inputTokens: 10_000, outputTokens: 2_000, totalTokens: 12_000 }),
      'claude-sonnet-4',
      { workflowRunId: 'wf_x' }, // workflowRunId present but no agentId
    );

    const metrics = tracker.getMetrics();
    expect(metrics.parentCostUsd).toBeGreaterThan(0);
    expect(metrics.subagentCostUsd).toBe(0);
  });

  it('ctx.workflowRunId set → cost appears in costByWorkflowRunId[runId][dayKey]', () => {
    const tracker = new CostTracker();
    const ts = Date.now() - 30 * 60 * 1000; // 30 min ago
    const expectedDayKey = dayKeyFromMs(ts);

    tracker.recordTokenUsage(
      makeUsage({ inputTokens: 5_000, outputTokens: 1_000, totalTokens: 6_000 }),
      'claude-sonnet-4',
      { workflowRunId: 'wf_test_run', timestampMs: ts },
    );

    const metrics = tracker.getMetrics();
    expect(metrics.costByWorkflowRunId).toHaveProperty('wf_test_run');
    const runDays = metrics.costByWorkflowRunId['wf_test_run'];
    expect(runDays).toHaveProperty(expectedDayKey);
    expect(runDays![expectedDayKey]).toBeGreaterThan(0);
  });

  it('getSubagentMetrics() returns correct subagent/parent split and share percentage', () => {
    const tracker = new CostTracker();

    // Subagent call: 10k input ($0.03) + 2k output ($0.03) = $0.06 on sonnet
    tracker.recordTokenUsage(
      makeUsage({ inputTokens: 10_000, outputTokens: 2_000, totalTokens: 12_000 }),
      'claude-sonnet-4',
      { agentId: 'sub-1' },
    );
    // Parent call: 5k input ($0.015) + 1k output ($0.015) = $0.03
    tracker.recordTokenUsage(
      makeUsage({ inputTokens: 5_000, outputTokens: 1_000, totalTokens: 6_000 }),
      'claude-sonnet-4',
    );

    const sub = tracker.getSubagentMetrics();
    expect(sub.subagentUsd).toBeCloseTo(0.06, 4);
    expect(sub.parentUsd).toBeCloseTo(0.03, 4);
    // 0.06 / (0.06 + 0.03) * 100 ≈ 66.7%
    expect(sub.subagentSharePct).toBeCloseTo(66.67, 1);
    expect(sub.reconciliationDeltaPct).toBeNull();
  });
});
