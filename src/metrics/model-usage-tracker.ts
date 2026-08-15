export interface ModelBreakdownEntry {
  readonly requestCount: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCostUsd: number;
}

export interface ModelStats extends ModelBreakdownEntry {
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

// Pure derivation: raw per-model counters -> the full ModelStats shape (raw +
// derived ratios) plus the mostUsed/mostEfficient picks. Shared by getMetrics()
// (this tracker's own live counters) and combineBreakdowns() (counters summed
// across multiple sessions/processes) so a ratio is always computed exactly
// once, from a fully-summed numerator/denominator — never averaged across
// sources, which would silently misweight sources with different token
// volumes.
function deriveModelUsageMetrics(
  byModelRaw: Readonly<Record<string, ModelBreakdownEntry>>,
): ModelUsageMetrics {
  const byModel: Record<string, ModelStats> = {};
  let mostUsedModel: string | null = null;
  let maxRequests = 0;
  let mostEfficientModel: string | null = null;
  let lowestCostPerOutputToken = Infinity;

  for (const [model, stats] of Object.entries(byModelRaw)) {
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
    // deterministic result regardless of iteration order. '￿' (U+FFFF) sorts
    // after every realistic model name, so `mostEfficientModel ?? '￿'` always
    // loses the very first comparison and lets the first real candidate win.
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
    totalModelsUsed: Object.keys(byModelRaw).length,
  };
}

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

  /**
   * Seeds cumulative per-model counters from a previous process's last
   * checkpoint for this same session — mirrors
   * `CostTracker.seedFromPersisted()`, which this tracker has the identical
   * in-memory-only, resets-on-restart problem alongside (see that method's
   * doc comment for why): a process restart mid-session (sleep, closing a
   * terminal, `claude --resume`, a crash) otherwise silently discards every
   * request/token/dollar a now-dead prior process already attributed to a
   * model, even after CostTracker's own totals are correctly restored —
   * leaving this tracker's per-model breakdown inconsistent with (short of)
   * the session total.
   *
   * Adds to current per-model state rather than overwriting, so callers must
   * invoke this at most once per (re)adopted session id, before any real
   * activity for that id has reached this tracker.
   */
  seedFromPersisted(breakdown: Readonly<Record<string, ModelBreakdownEntry>>): void {
    for (const [model, entry] of Object.entries(breakdown)) {
      let stats = this.byModel.get(model);
      if (!stats) {
        stats = { requestCount: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0 };
        this.byModel.set(model, stats);
      }
      stats.requestCount += entry.requestCount;
      stats.totalInputTokens += entry.totalInputTokens;
      stats.totalOutputTokens += entry.totalOutputTokens;
      stats.totalCostUsd += entry.totalCostUsd;
    }
  }

  // Raw per-model counters only — no derived ratios. This is the shape
  // persisted onto FullSessionSummary.modelBreakdown (session-store.ts) so a
  // session file never stores a stale derived ratio; ratios are always
  // recomputed at read time via getMetrics()/combineBreakdowns().
  getRawBreakdown(): Readonly<Record<string, ModelBreakdownEntry>> {
    const out: Record<string, ModelBreakdownEntry> = {};
    for (const [model, stats] of this.byModel) {
      out[model] = { ...stats };
    }
    return out;
  }

  getMetrics(): ModelUsageMetrics {
    return deriveModelUsageMetrics(this.getRawBreakdown());
  }

  // Combines raw per-model counters from multiple sources (e.g. this
  // process's own live counters plus every other today session's persisted
  // snapshot) by summing matching model keys, then derives ratios exactly
  // once from the summed totals — see deriveModelUsageMetrics's doc comment
  // for why this must never average each source's own ratio.
  combineBreakdowns(
    breakdowns: ReadonlyArray<Readonly<Record<string, ModelBreakdownEntry>>>,
  ): ModelUsageMetrics {
    const summed: Record<string, MutableModelStats> = {};
    for (const breakdown of breakdowns) {
      for (const [model, entry] of Object.entries(breakdown)) {
        const existing = summed[model] ?? {
          requestCount: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCostUsd: 0,
        };
        existing.requestCount += entry.requestCount;
        existing.totalInputTokens += entry.totalInputTokens;
        existing.totalOutputTokens += entry.totalOutputTokens;
        existing.totalCostUsd += entry.totalCostUsd;
        summed[model] = existing;
      }
    }
    return deriveModelUsageMetrics(summed);
  }

  reset(_sessionId: string): void {
    this.byModel.clear();
  }
}
