import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { handleReportTokens, REPORT_TOKENS_TOOL } from './cost-tools.js';
import { CostTracker } from '../metrics/cost-tracker.js';
import type { TokenReport } from './cost-tools.js';

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

  it('totalTokens excludes cache tokens to match Anthropic dashboard convention (B-03)', () => {
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
