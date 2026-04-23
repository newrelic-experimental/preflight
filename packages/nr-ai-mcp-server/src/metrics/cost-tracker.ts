/**
 * Cost Tracking — maintains running token counts and cost calculations.
 *
 * Two paths feed into the tracker:
 *   1. Self-reporting via the `nr_observe_report_tokens` MCP tool (primary)
 *   2. Estimation from hook input/output byte sizes (fallback)
 *
 * Cost calculation delegates to `calculateCost()` from the shared package.
 */

import type { TokenUsage, CostBreakdown, MetricAggregator } from '@nr-ai-observatory/shared';
import { calculateCost } from '@nr-ai-observatory/shared';
import type { SessionTracker } from './session-tracker.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CostMetrics {
  sessionTotalCostUsd: number | null;
  costByTask: null; // stub — task boundary detection is Phase 2.3
  costByModel: Record<string, number>;
  costPerLineOfCode: number | null;
  costPerFileModified: number | null;
  model: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalThinkingTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  reportCount: number;
  estimationCount: number;
  latestCostBreakdown: CostBreakdown | null;
}

// ---------------------------------------------------------------------------
// CostTracker
// ---------------------------------------------------------------------------

export class CostTracker {
  private sessionTracker: SessionTracker | null;

  private totalCostUsd = 0;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalThinkingTokens = 0;
  private totalCacheReadTokens = 0;
  private totalCacheCreationTokens = 0;
  private currentModel: string | null = null;
  private reportCount = 0;
  private estimationCount = 0;
  private latestCostBreakdown: CostBreakdown | null = null;
  private costByModel = new Map<string, number>();
  private totalLinesChanged = 0;

  constructor(sessionTracker?: SessionTracker) {
    this.sessionTracker = sessionTracker ?? null;
  }

  /**
   * Primary path: record exact token usage from self-reporting.
   */
  recordTokenUsage(usage: TokenUsage, model: string): CostBreakdown {
    this.reportCount++;
    return this.accumulateTokens(usage, model);
  }

  /**
   * Fallback path: estimate tokens from character counts.
   * Uses the heuristic: tokens ≈ characters / 4.
   */
  recordEstimatedTokens(inputChars: number, outputChars: number, model: string): CostBreakdown {
    const inputTokens = Math.round(inputChars / 4);
    const outputTokens = Math.round(outputChars / 4);
    const usage: TokenUsage = {
      inputTokens,
      outputTokens,
      thinkingTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: inputTokens + outputTokens,
    };

    this.estimationCount++;
    return this.accumulateTokens(usage, model);
  }

  private accumulateTokens(usage: TokenUsage, model: string): CostBreakdown {
    const breakdown = calculateCost(model, usage);

    this.totalCostUsd += breakdown.totalUsd;
    this.totalInputTokens += usage.inputTokens;
    this.totalOutputTokens += usage.outputTokens;
    this.totalThinkingTokens += usage.thinkingTokens;
    this.totalCacheReadTokens += usage.cacheReadTokens;
    this.totalCacheCreationTokens += usage.cacheCreationTokens;
    this.currentModel = model;
    this.latestCostBreakdown = breakdown;
    this.costByModel.set(model, (this.costByModel.get(model) ?? 0) + breakdown.totalUsd);

    return breakdown;
  }

  /**
   * Record lines of code changed (from Edit/Write tool data).
   */
  recordLinesChanged(lines: number): void {
    this.totalLinesChanged += lines;
  }

  getMetrics(): CostMetrics {
    const hasData = this.reportCount > 0 || this.estimationCount > 0;

    const uniqueFilesWritten = this.sessionTracker
      ? this.sessionTracker.getMetrics().uniqueFilesWritten
      : 0;

    return {
      sessionTotalCostUsd: hasData ? this.totalCostUsd : null,
      costByTask: null,
      costByModel: Object.fromEntries(this.costByModel),
      costPerLineOfCode:
        hasData && this.totalLinesChanged > 0
          ? this.totalCostUsd / this.totalLinesChanged
          : null,
      costPerFileModified:
        hasData && uniqueFilesWritten > 0
          ? this.totalCostUsd / uniqueFilesWritten
          : null,
      model: this.currentModel,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      totalThinkingTokens: this.totalThinkingTokens,
      totalCacheReadTokens: this.totalCacheReadTokens,
      totalCacheCreationTokens: this.totalCacheCreationTokens,
      reportCount: this.reportCount,
      estimationCount: this.estimationCount,
      latestCostBreakdown: this.latestCostBreakdown,
    };
  }

  emitMetrics(aggregator: MetricAggregator): void {
    const attrs: Record<string, string | number> = {};
    if (this.currentModel) {
      attrs.model = this.currentModel;
    }

    aggregator.record('ai.cost.session_total_usd', this.totalCostUsd, attrs);
    aggregator.record('ai.cost.tokens_input', this.totalInputTokens, attrs);
    aggregator.record('ai.cost.tokens_output', this.totalOutputTokens, attrs);
    aggregator.record('ai.cost.tokens_thinking', this.totalThinkingTokens, attrs);
    aggregator.record('ai.cost.tokens_cache_read', this.totalCacheReadTokens, attrs);

    if (this.totalLinesChanged > 0) {
      aggregator.record(
        'ai.cost.cost_per_line_of_code',
        this.totalCostUsd / this.totalLinesChanged,
        attrs,
      );
    }

    if (this.sessionTracker) {
      const uniqueFilesWritten = this.sessionTracker.getMetrics().uniqueFilesWritten;
      if (uniqueFilesWritten > 0) {
        aggregator.record(
          'ai.cost.cost_per_file_modified',
          this.totalCostUsd / uniqueFilesWritten,
          attrs,
        );
      }
    }

    aggregator.record('ai.cost.report_count', this.reportCount, attrs);
    aggregator.record('ai.cost.estimation_count', this.estimationCount, attrs);
  }

  reset(): void {
    this.totalCostUsd = 0;
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.totalThinkingTokens = 0;
    this.totalCacheReadTokens = 0;
    this.totalCacheCreationTokens = 0;
    this.currentModel = null;
    this.reportCount = 0;
    this.estimationCount = 0;
    this.latestCostBreakdown = null;
    this.costByModel = new Map();
    this.totalLinesChanged = 0;
  }
}
