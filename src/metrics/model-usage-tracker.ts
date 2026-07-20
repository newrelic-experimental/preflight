export interface ModelStats {
  readonly requestCount: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCostUsd: number;
  readonly costPerOutputToken: number | null;
  /**
   * Per-model rate: totalCostUsd / (totalInputTokens + totalOutputTokens) * 1M.
   * Narrower than CostTracker's session-blended `costPerMillionTokens`, which
   * also folds in thinking/cache-read/cache-creation tokens — the two are not
   * directly comparable.
   */
  readonly costPerMillionTokens: number | null;
  readonly avgOutputTokensPerRequest: number | null;
}

export interface ModelUsageMetrics {
  readonly byModel: Readonly<Record<string, ModelStats>>;
  readonly mostUsedModel: string | null;
  readonly mostEfficientModel: string | null;
  readonly totalModelsUsed: number;
}

interface MutableModelStats {
  requestCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
}

import type { Resettable } from './tracker-contracts.js';

export class ModelUsageTracker implements Resettable {
  private byModel = new Map<string, MutableModelStats>();

  recordUsage(model: string, inputTokens: number, outputTokens: number, costUsd: number): void {
    let stats = this.byModel.get(model);
    if (!stats) {
      stats = { requestCount: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0 };
      this.byModel.set(model, stats);
    }
    stats.requestCount++;
    stats.totalInputTokens += inputTokens;
    stats.totalOutputTokens += outputTokens;
    stats.totalCostUsd += costUsd;
  }

  getMetrics(): ModelUsageMetrics {
    const byModel: Record<string, ModelStats> = {};
    let mostUsedModel: string | null = null;
    let maxRequests = 0;
    let mostEfficientModel: string | null = null;
    let lowestCostPerOutputToken = Infinity;

    for (const [model, stats] of this.byModel) {
      const costPerOutputToken =
        stats.totalOutputTokens > 0 ? stats.totalCostUsd / stats.totalOutputTokens : null;
      const totalTokens = stats.totalInputTokens + stats.totalOutputTokens;
      const costPerMillionTokens =
        totalTokens > 0 ? (stats.totalCostUsd / totalTokens) * 1_000_000 : null;
      const avgOutputTokensPerRequest =
        stats.requestCount > 0 ? stats.totalOutputTokens / stats.requestCount : null;

      byModel[model] = {
        requestCount: stats.requestCount,
        totalInputTokens: stats.totalInputTokens,
        totalOutputTokens: stats.totalOutputTokens,
        totalCostUsd: stats.totalCostUsd,
        costPerOutputToken,
        costPerMillionTokens,
        avgOutputTokensPerRequest,
      };

      if (stats.requestCount > maxRequests) {
        maxRequests = stats.requestCount;
        mostUsedModel = model;
      }

      // On an exact tie, prefer the alphabetically-first model name for a
      // deterministic result regardless of Map iteration order. '￿' (U+FFFF)
      // sorts after every realistic model name, so `mostEfficientModel ?? '￿'`
      // always loses the very first comparison and lets the first real
      // candidate win.
      if (
        costPerOutputToken !== null &&
        (costPerOutputToken < lowestCostPerOutputToken ||
          (costPerOutputToken === lowestCostPerOutputToken && model < (mostEfficientModel ?? '￿')))
      ) {
        lowestCostPerOutputToken = costPerOutputToken;
        mostEfficientModel = model;
      }
    }

    return {
      byModel,
      mostUsedModel,
      mostEfficientModel,
      totalModelsUsed: this.byModel.size,
    };
  }

  reset(_sessionId: string): void {
    this.byModel.clear();
  }
}
