import { calculateCost } from '../shared/index.js';
import type { CostBreakdown, TokenUsage } from '../shared/index.js';
import type { TokenCategoryCost } from '../storage/types.js';

/**
 * Per-category dollar helpers for share-table attribution.
 *
 * Pricing stays on the model dimension until `calculateCost()` has produced a
 * `CostBreakdown` for a single event; only then are category dollars split
 * across tools and summed into a bucket. That keeps cache-read (and every
 * other category) on the event's real per-model rates instead of a blended
 * fake rate across models that later share a skill/subagent/plugin row.
 *
 * Thinking USD is dropped here on purpose: parent-session token events
 * typically omit thinking tokens, so inventing a thinking-dollar figure
 * would over-claim what the data supports (#728 / #730).
 */

export function scalePricedBreakdown(breakdown: CostBreakdown, factor: number): CostBreakdown {
  if (factor === 1) return breakdown;
  return {
    inputUsd: breakdown.inputUsd * factor,
    outputUsd: breakdown.outputUsd * factor,
    thinkingUsd: breakdown.thinkingUsd * factor,
    cacheReadUsd: breakdown.cacheReadUsd * factor,
    cacheCreationUsd: breakdown.cacheCreationUsd * factor,
    totalUsd: breakdown.totalUsd * factor,
    savingsFromCacheUsd: breakdown.savingsFromCacheUsd * factor,
  };
}

/**
 * Lift the four persisted category dollars out of a priced `CostBreakdown`.
 * `splitAcross` is the even-split already used for tokens (one turn's cost
 * shared across the tools in that turn). Price the full event first, then
 * split — splitting tokens before `calculateCost()` would distort tiered
 * rates whose threshold is evaluated on the event's full input count.
 */
export function categoryCostFromBreakdown(
  breakdown: CostBreakdown,
  splitAcross = 1,
): TokenCategoryCost {
  const n = splitAcross > 0 ? splitAcross : 1;
  return {
    inputUsd: breakdown.inputUsd / n,
    outputUsd: breakdown.outputUsd / n,
    cacheReadUsd: breakdown.cacheReadUsd / n,
    cacheCreationUsd: breakdown.cacheCreationUsd / n,
  };
}

/** Price one event's token mix with that event's model, then optionally split. */
export function priceTokenCategories(
  model: string,
  usage: TokenUsage,
  options?: { readonly rateMultiplier?: number; readonly splitAcross?: number },
): TokenCategoryCost {
  const priced = scalePricedBreakdown(calculateCost(model, usage), options?.rateMultiplier ?? 1);
  return categoryCostFromBreakdown(priced, options?.splitAcross ?? 1);
}

export function addCategoryCost(
  a: TokenCategoryCost | undefined,
  b: TokenCategoryCost | undefined,
): TokenCategoryCost | undefined {
  if (!a && !b) return undefined;
  return {
    inputUsd: (a?.inputUsd ?? 0) + (b?.inputUsd ?? 0),
    outputUsd: (a?.outputUsd ?? 0) + (b?.outputUsd ?? 0),
    cacheReadUsd: (a?.cacheReadUsd ?? 0) + (b?.cacheReadUsd ?? 0),
    cacheCreationUsd: (a?.cacheCreationUsd ?? 0) + (b?.cacheCreationUsd ?? 0),
  };
}

/** Field-wise max — same overlapping-writer rule as the token counts. */
export function maxCategoryCost(
  a: TokenCategoryCost | undefined,
  b: TokenCategoryCost | undefined,
): TokenCategoryCost | undefined {
  if (!a && !b) return undefined;
  return {
    inputUsd: Math.max(a?.inputUsd ?? 0, b?.inputUsd ?? 0),
    outputUsd: Math.max(a?.outputUsd ?? 0, b?.outputUsd ?? 0),
    cacheReadUsd: Math.max(a?.cacheReadUsd ?? 0, b?.cacheReadUsd ?? 0),
    cacheCreationUsd: Math.max(a?.cacheCreationUsd ?? 0, b?.cacheCreationUsd ?? 0),
  };
}
