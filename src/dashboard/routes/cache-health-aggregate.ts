export interface CacheHealthTotals {
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly inputTokens: number;
  readonly savingsUsd: number;
}

export type CacheHealthStatus =
  'no_cache_activity' | 'needs_attention' | 'can_improve' | 'excellent';

export interface AggregateCacheHealth {
  readonly status: CacheHealthStatus;
  readonly cacheHitRatePct: number | null;
  readonly totalCacheReadTokens: number;
  readonly totalCacheCreationTokens: number;
  readonly totalSavingsUsd: number;
}

// Turns raw token/dollar totals accumulated across every process/session
// active today (see the aggregate route in api-handler.ts, the only caller)
// into the hit-rate percentage and status band the Cache Health panel
// renders. Mirrors CostTracker.computeCacheHitRate's null-handling rule
// exactly: no percentage at all (not 0%) when there's no cache activity to
// report, and the same >=60 / >=30 banding thresholds /api/cache-health
// already uses.
export function computeCacheHealth(totals: CacheHealthTotals): AggregateCacheHealth {
  const denominator = totals.inputTokens + totals.cacheReadTokens + totals.cacheCreationTokens;
  let cacheHitRatePct: number | null = null;
  if (denominator > 0 && (totals.cacheReadTokens > 0 || totals.cacheCreationTokens > 0)) {
    cacheHitRatePct = Math.round((totals.cacheReadTokens / denominator) * 100);
  }

  let status: CacheHealthStatus;
  if (cacheHitRatePct === null) {
    status = 'no_cache_activity';
  } else if (cacheHitRatePct >= 60) {
    status = 'excellent';
  } else if (cacheHitRatePct >= 30) {
    status = 'can_improve';
  } else {
    status = 'needs_attention';
  }

  return {
    status,
    cacheHitRatePct,
    totalCacheReadTokens: totals.cacheReadTokens,
    totalCacheCreationTokens: totals.cacheCreationTokens,
    totalSavingsUsd: totals.savingsUsd,
  };
}
