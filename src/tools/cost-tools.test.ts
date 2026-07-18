import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import {
  handleReportTokens,
  REPORT_TOKENS_TOOL,
  handleGetPromptCacheHealth,
  handleGetBudgetStatus,
  handleGetCostForecast,
  handleGetCostBreakdown,
} from './cost-tools.js';
import { CostTracker } from '../metrics/cost-tracker.js';
import { BudgetTracker } from '../metrics/budget-tracker.js';
import { localDateKey } from '../lib/date.js';
import { buildCostForecastFromInputs } from '../metrics/cost-forecast.js';
import type { TokenReport } from './cost-tools.js';
import type { CostMetrics } from '../metrics/cost-tracker.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('REPORT_TOKENS_TOOL', () => {
  it('has expected name and required fields', () => {
    expect(REPORT_TOKENS_TOOL.name).toBe('nr_observe_report_tokens');
    expect(REPORT_TOKENS_TOOL.inputSchema.required).toEqual([
      'input_tokens',
      'output_tokens',
      'model',
    ]);
    expect(REPORT_TOKENS_TOOL.annotations.readOnlyHint).toBe(false);
  });
});

describe('handleReportTokens()', () => {
  it('records token usage and returns cost data', () => {
    const tracker = new CostTracker();
    const args: TokenReport = {
      input_tokens: 10_000,
      output_tokens: 2_000,
      model: 'claude-sonnet-4',
    };

    const result = handleReportTokens(tracker, args);

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');

    const body = JSON.parse(result.content[0].text);
    expect(body.recorded).toBe(true);
    expect(body.model).toBe('claude-sonnet-4');
    // claude-sonnet-4: 10k*3/1M + 2k*15/1M = 0.03+0.03 = 0.06
    expect(body.cost_this_report_usd).toBeCloseTo(0.06, 6);
    expect(body.session_total_cost_usd).toBeCloseTo(0.06, 6);
  });

  it('accumulates across multiple calls', () => {
    const tracker = new CostTracker();

    handleReportTokens(tracker, {
      input_tokens: 10_000,
      output_tokens: 2_000,
      model: 'claude-sonnet-4',
    });

    const result = handleReportTokens(tracker, {
      input_tokens: 5_000,
      output_tokens: 1_000,
      model: 'claude-sonnet-4',
    });

    const body = JSON.parse(result.content[0].text);
    // Second report: 5k*3/1M + 1k*15/1M = 0.015+0.015 = 0.03
    expect(body.cost_this_report_usd).toBeCloseTo(0.03, 6);
    // Session total: 0.06 + 0.03 = 0.09
    expect(body.session_total_cost_usd).toBeCloseTo(0.09, 6);
  });

  it('handles optional thinking and cache tokens', () => {
    const tracker = new CostTracker();
    const args: TokenReport = {
      input_tokens: 1_000,
      output_tokens: 500,
      thinking_tokens: 2_000,
      cache_read_tokens: 3_000,
      cache_creation_tokens: 500,
      model: 'claude-sonnet-4',
    };

    const result = handleReportTokens(tracker, args);
    const body = JSON.parse(result.content[0].text);

    expect(body.recorded).toBe(true);
    expect(body.cost_this_report_usd).toBeGreaterThan(0);

    // Verify tracker state includes all token types
    const metrics = tracker.getMetrics();
    expect(metrics.totalThinkingTokens).toBe(2_000);
    expect(metrics.totalCacheReadTokens).toBe(3_000);
    expect(metrics.totalCacheCreationTokens).toBe(500);
  });

  it('totalTokens excludes cache tokens to match Anthropic dashboard convention', () => {
    const tracker = new CostTracker();
    const args: TokenReport = {
      input_tokens: 1_000,
      output_tokens: 500,
      thinking_tokens: 200,
      cache_read_tokens: 3_000,
      cache_creation_tokens: 400,
      model: 'claude-sonnet-4',
    };

    handleReportTokens(tracker, args);

    const metrics = tracker.getMetrics();
    // totalTokens should be input + output + thinking only (not cache)
    expect(metrics.totalInputTokens + metrics.totalOutputTokens + metrics.totalThinkingTokens).toBe(
      1_700,
    );
    // Cache tokens are still tracked individually for accurate cost calculation
    expect(metrics.totalCacheReadTokens).toBe(3_000);
    expect(metrics.totalCacheCreationTokens).toBe(400);
  });

  it('defaults optional tokens to 0', () => {
    const tracker = new CostTracker();
    const args: TokenReport = {
      input_tokens: 1_000,
      output_tokens: 500,
      model: 'claude-sonnet-4',
    };

    handleReportTokens(tracker, args);

    const metrics = tracker.getMetrics();
    expect(metrics.totalThinkingTokens).toBe(0);
    expect(metrics.totalCacheReadTokens).toBe(0);
    expect(metrics.totalCacheCreationTokens).toBe(0);
  });

  // token clamping and model truncation
  describe('unbounded token validation', () => {
    it('clamps negative token counts to 0', () => {
      const tracker = new CostTracker();
      handleReportTokens(tracker, { input_tokens: -999, output_tokens: -1, model: 'x' });
      const metrics = tracker.getMetrics();
      expect(metrics.totalInputTokens).toBe(0);
      expect(metrics.totalOutputTokens).toBe(0);
    });

    it('clamps token counts above 10_000_000 to 10_000_000', () => {
      const tracker = new CostTracker();
      handleReportTokens(tracker, {
        input_tokens: 999_999_999,
        output_tokens: 500_000_000,
        model: 'x',
      });
      const metrics = tracker.getMetrics();
      expect(metrics.totalInputTokens).toBe(10_000_000);
      expect(metrics.totalOutputTokens).toBe(10_000_000);
    });

    it('floors fractional token counts to integers', () => {
      const tracker = new CostTracker();
      handleReportTokens(tracker, { input_tokens: 1000.9, output_tokens: 500.1, model: 'x' });
      const metrics = tracker.getMetrics();
      expect(metrics.totalInputTokens).toBe(1000);
      expect(metrics.totalOutputTokens).toBe(500);
    });

    it('clamps NaN token counts to 0', () => {
      const tracker = new CostTracker();
      handleReportTokens(tracker, { input_tokens: NaN, output_tokens: NaN, model: 'x' });
      const metrics = tracker.getMetrics();
      expect(metrics.totalInputTokens).toBe(0);
      expect(metrics.totalOutputTokens).toBe(0);
    });

    it('truncates model string longer than 256 chars', () => {
      const tracker = new CostTracker();
      const longModel = 'a'.repeat(300);
      const result = handleReportTokens(tracker, {
        input_tokens: 100,
        output_tokens: 50,
        model: longModel,
      });
      const body = JSON.parse(result.content[0].text);
      expect(body.model.length).toBe(256);
    });
  });
});

// ---------------------------------------------------------------------------
// handleGetCostBreakdown
// ---------------------------------------------------------------------------

describe('handleGetCostBreakdown()', () => {
  it('includes cost_per_million_tokens in the response', () => {
    const tracker = new CostTracker();
    handleReportTokens(tracker, {
      input_tokens: 500_000,
      output_tokens: 500_000,
      model: 'claude-sonnet-4',
    });

    const result = handleGetCostBreakdown(tracker);
    const body = JSON.parse(result.content[0].text);

    expect(body.cost_per_million_tokens).toBeCloseTo(9.0, 2);
  });

  it('returns null cost_per_million_tokens when no tokens reported', () => {
    const tracker = new CostTracker();
    const result = handleGetCostBreakdown(tracker);
    const body = JSON.parse(result.content[0].text);

    expect(body.cost_per_million_tokens).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// handleGetPromptCacheHealth
// ---------------------------------------------------------------------------

describe('handleGetPromptCacheHealth()', () => {
  function makeTracker(overrides?: Partial<CostMetrics>): CostTracker {
    const tracker = new CostTracker();
    // Inject via recordTokenUsage to set real state — but for handler tests
    // we need precise control, so spy on getMetrics instead.
    jest.spyOn(tracker, 'getMetrics').mockReturnValue({
      sessionTotalCostUsd: null,
      costByTask: null,
      costByModel: {},
      costPerLineOfCode: null,
      costPerFileModified: null,
      costPerMillionTokens: null,
      model: null,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalThinkingTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      cacheHitRate: null,
      totalCacheSavingsUsd: 0,
      reportCount: 0,
      estimationCount: 0,
      latestCostBreakdown: null,
      subagentCostUsd: 0,
      parentCostUsd: 0,
      costByWorkflowRunId: {},
      ...overrides,
    } satisfies CostMetrics);
    return tracker;
  }

  it('returns no_cache_activity status when cacheHitRate is null and no cache tokens', () => {
    const tracker = makeTracker({ reportCount: 3 });
    const result = handleGetPromptCacheHealth(tracker);
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe('no_cache_activity');
    expect(body.recommendation).toMatch(/No cache activity detected/);
  });

  it('returns excellent status for hit rate >= 0.6', () => {
    const tracker = makeTracker({
      totalInputTokens: 2_000,
      totalCacheReadTokens: 6_000,
      totalCacheCreationTokens: 2_000,
      cacheHitRate: 0.6,
      totalCacheSavingsUsd: 0.12,
      reportCount: 5,
    });
    const result = handleGetPromptCacheHealth(tracker);
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe('excellent');
    expect(body.cache_hit_rate_pct).toBe(60);
  });

  it('returns needs_attention status for hit rate < 0.3', () => {
    const tracker = makeTracker({
      totalInputTokens: 9_000,
      totalCacheReadTokens: 500,
      totalCacheCreationTokens: 500,
      cacheHitRate: 0.05,
      totalCacheSavingsUsd: 0.001,
      reportCount: 5,
    });
    const result = handleGetPromptCacheHealth(tracker);
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe('needs_attention');
    expect(body.recommendation).toMatch(/restructure/i);
  });

  it('returns can_improve status for hit rate 0.3–0.59', () => {
    const tracker = makeTracker({
      totalInputTokens: 5_000,
      totalCacheReadTokens: 3_000,
      totalCacheCreationTokens: 2_000,
      cacheHitRate: 0.3,
      totalCacheSavingsUsd: 0.05,
      reportCount: 5,
    });
    const result = handleGetPromptCacheHealth(tracker);
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe('can_improve');
  });

  it('includes total_savings_usd and token counts', () => {
    const tracker = makeTracker({
      totalInputTokens: 3_000,
      totalCacheReadTokens: 6_000,
      totalCacheCreationTokens: 1_000,
      cacheHitRate: 0.6,
      totalCacheSavingsUsd: 0.25,
      reportCount: 3,
    });
    const result = handleGetPromptCacheHealth(tracker);
    const body = JSON.parse(result.content[0].text);
    expect(body.total_savings_usd).toBe(0.25);
    expect(body.total_cache_read_tokens).toBe(6_000);
    expect(body.total_cache_creation_tokens).toBe(1_000);
  });
});

// ---------------------------------------------------------------------------
// handleGetBudgetStatus
// ---------------------------------------------------------------------------

describe('handleGetBudgetStatus()', () => {
  it('returns the budget tracker status as JSON, including fired threshold alerts', () => {
    const tracker = new BudgetTracker({
      sessionBudgetUsd: 10,
      dailyBudgetUsd: null,
      weeklyBudgetUsd: null,
    });
    tracker.updateCost(6, 0, 0); // 60% of session budget — crosses the 50% threshold

    const result = handleGetBudgetStatus(tracker);
    const body = JSON.parse(result.content[0].text);

    expect(body).toEqual(tracker.getStatus());
    expect(body.session.pctUsed).toBe(60);
    expect(body.session.exceeded).toBe(false);
    expect(body.alerts).toHaveLength(1);
    expect(body.alerts[0].thresholdPct).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// handleGetCostForecast
// ---------------------------------------------------------------------------

describe('handleGetCostForecast()', () => {
  it('anchors the end-of-day forecast to getCostForDay()/getFirstActivityMsForDay(), not the full session spend', () => {
    const tracker = new CostTracker();

    // Backdated (but within the 48h late-arrival window) so it inflates the
    // session-wide total without landing in today's day-bucket.
    const yesterday = Date.now() - 25 * 60 * 60 * 1000;
    tracker.recordTokenUsage(
      {
        inputTokens: 10_000_000,
        outputTokens: 2_000_000,
        thinkingTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 12_000_000,
      },
      'claude-sonnet-4',
      { timestampMs: yesterday },
    );

    // "Today's" spend — small, and reported with no ctx so it lands in today's bucket.
    tracker.recordTokenUsage(
      {
        inputTokens: 1_000,
        outputTokens: 200,
        thinkingTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 1_200,
      },
      'claude-sonnet-4',
    );

    const sessionStartMs = yesterday;
    const result = handleGetCostForecast(tracker, sessionStartMs);
    const body = JSON.parse(result.content[0].text);

    const todayKey = localDateKey();
    const sessionTotalCostUsd = tracker.getMetrics().sessionTotalCostUsd ?? 0;
    const expected = buildCostForecastFromInputs({
      sessionSpentUsd: sessionTotalCostUsd,
      sessionStartMs,
      dailySpentUsd: tracker.getCostForDay(todayKey),
      dailyFirstActivityMs: tracker.getFirstActivityMsForDay(todayKey),
    });

    // If the handler regressed to anchoring the EoD baseline on the full
    // session spend instead of today's day-bucket, `expected` (computed here
    // from the correct daily-anchored inputs) would diverge sharply from
    // `body` given the huge backdated "yesterday" spend above.
    expect(body.forecastEndOfDayUsd).toBeCloseTo(expected.forecastEndOfDayUsd ?? 0, 2);
    expect(sessionTotalCostUsd).toBeGreaterThan(tracker.getCostForDay(todayKey));
  });
});
