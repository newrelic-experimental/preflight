import { exactTotalsOf, type FullSessionSummary } from '../storage/session-store.js';
import type { CostTrackerSeed } from './cost-tracker.js';
import { localDateKey, todayPortionOfSessionCost, todayPortionRatio } from '../lib/date.js';

// Builds the seed a freshly-started process's CostTracker needs to recover a
// resumed session's pre-restart totals — see CostTracker.seedFromPersisted()
// for why this exists (ParentTranscriptWatcher's read cursor durably survives
// a restart; CostTracker's totals do not, without this).
//
// dayCostUsd/daySubagentCostUsd use todayPortion*() rather than booking the
// whole persisted total to `dayKey` so a persisted session whose own prior
// activity already spanned a midnight doesn't over-attribute to today.
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

export function buildCostTrackerSeed(persisted: FullSessionSummary): CostTrackerSeed {
  const totalCostUsd = persisted.estimatedCostUsd ?? 0;
  const costByModel: Record<string, number> = {};
  for (const [model, entry] of Object.entries(persisted.modelBreakdown)) {
    costByModel[model] = entry.totalCostUsd;
  }
  const dayKey = localDateKey();
  const todayRatio = todayPortionRatio(persisted);
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
    dayCostUsd: todayPortionOfSessionCost(persisted),
    daySubagentCostUsd: persisted.subagentCostUsd * todayRatio,
    ...(persisted.unpricedByModel && { unpricedByModel: persisted.unpricedByModel }),
    ...(persisted.estimatedByModel && { estimatedByModel: persisted.estimatedByModel }),
    ...(persisted.byteEstimates && { byteEstimates: persisted.byteEstimates }),
    ...(!hadExactReport(persisted) && { hadExactReport: false }),
  };
}
