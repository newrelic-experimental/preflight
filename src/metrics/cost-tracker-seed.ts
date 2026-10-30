import { exactTotalsOf, hasAttributableActivity } from '../storage/session-store.js';
import type { FullSessionSummary } from '../storage/session-store.js';
import type { CostTrackerSeed } from './cost-tracker.js';
import { localDateKey, todayPortionRatio } from '../lib/date.js';

export interface TodayCostSource {
  readonly startTime: number;
  readonly endTime: number;
  readonly estimatedCostUsd: number | null;
  readonly subagentCostUsd?: number;
  readonly costByDayUsd?: Readonly<Record<string, number>>;
  readonly subagentCostByDayUsd?: Readonly<Record<string, number>>;
  readonly toolCallCount?: number;
  readonly timeline?: ReadonlyArray<{ readonly timestamp: number }>;
}

// Today's cost of one persisted summary, shared by the CostTracker seed and
// the dashboard's persisted-session sum so the two can never disagree.
//
// The exact per-day bucket wins: each token event was bucketed by its real
// transcript timestamp. Only a summary with no buckets falls back to pro-rating
// its lifetime totals by the timeline, and a summary with no attributable
// activity (see hasAttributableActivity) contributes 0 there: its lifetime
// total may be a resumed transcript re-read in one pass, which the pro-rate
// would dump entirely onto today. Subagent cost is clamped to the total so a
// pro-rated subagent share can never exceed an exact total.
export function todayCostOfSummary(
  persisted: TodayCostSource,
  dayKey: string,
  refTs?: number,
): { readonly costUsd: number; readonly subagentCostUsd: number } {
  const { costByDayUsd, subagentCostByDayUsd } = persisted;
  const proRated = (lifetimeUsd: number): number =>
    hasAttributableActivity(persisted) ? lifetimeUsd * todayPortionRatio(persisted, refTs) : 0;
  const costUsd =
    costByDayUsd !== undefined
      ? (costByDayUsd[dayKey] ?? 0)
      : proRated(Math.max(0, persisted.estimatedCostUsd ?? 0));
  const subagentUsd =
    subagentCostByDayUsd !== undefined
      ? (subagentCostByDayUsd[dayKey] ?? 0)
      : proRated(persisted.subagentCostUsd ?? 0);
  return { costUsd, subagentCostUsd: Math.min(subagentUsd, costUsd) };
}

// Only a summary that carries a byte-estimate ledger can be estimate-only. One
// without it predates the exact/estimate split and counts as reported.
function hadExactReport(persisted: FullSessionSummary): boolean {
  if (persisted.byteEstimates === undefined) return true;
  const exact = exactTotalsOf(persisted);
  return (
    exact.costUsd > 1e-9 ||
    exact.inputTokens > 0 ||
    exact.outputTokens > 0 ||
    persisted.tokensThinking > 0 ||
    persisted.tokensCacheRead > 0 ||
    persisted.tokensCacheCreation > 0
  );
}

// Builds the seed a freshly-started process's CostTracker needs to recover a
// resumed session's pre-restart totals — see CostTracker.seedFromPersisted()
// for why this exists (ParentTranscriptWatcher's read cursor durably survives
// a restart; CostTracker's totals do not, without this).
//
// dayCostUsd/daySubagentCostUsd come from todayCostOfSummary, so Spend Today
// is unchanged by a restart.
export function buildCostTrackerSeed(persisted: FullSessionSummary): CostTrackerSeed {
  const totalCostUsd = persisted.estimatedCostUsd ?? 0;
  const costByModel: Record<string, number> = {};
  for (const [model, entry] of Object.entries(persisted.modelBreakdown)) {
    costByModel[model] = entry.totalCostUsd;
  }
  const dayKey = localDateKey();
  const { costUsd: dayCostUsd, subagentCostUsd: daySubagentCostUsd } = todayCostOfSummary(
    persisted,
    dayKey,
  );
  return {
    totalCostUsd,
    subagentCostUsd: persisted.subagentCostUsd,
    parentCostUsd: totalCostUsd - persisted.subagentCostUsd,
    totalInputTokens: persisted.tokensInput,
    totalOutputTokens: persisted.tokensOutput,
    totalThinkingTokens: persisted.tokensThinking,
    totalCacheReadTokens: persisted.tokensCacheRead,
    totalCacheCreationTokens: persisted.tokensCacheCreation,
    totalCacheSavingsUsd: persisted.cacheSavingsUsd,
    costByModel,
    costByWorkflowRunId: persisted.costByWorkflowRunId,
    dayKey,
    dayCostUsd,
    daySubagentCostUsd,
    ...(persisted.unpricedByModel && { unpricedByModel: persisted.unpricedByModel }),
    ...(persisted.estimatedByModel && { estimatedByModel: persisted.estimatedByModel }),
    ...(persisted.byteEstimates && { byteEstimates: persisted.byteEstimates }),
    ...(!hadExactReport(persisted) && { hadExactReport: false }),
  };
}
