import type { CostBreakdown, ModelPricing, TokenUsage } from '../shared/index.js';
import { calculateCost, resolveModelPricing } from '../shared/index.js';

export type PricingResolution =
  { readonly kind: 'priced'; readonly pricing: ModelPricing } | { readonly kind: 'unpriced' };

export interface PricedUsage {
  readonly breakdown: CostBreakdown;
  readonly resolution: PricingResolution;
}

// Model ids arrive from transcripts and MCP tool input, so the memo is capped
// rather than trusting the set of ids to stay small.
const MAX_MEMOIZED_MODELS = 512;
const resolutions = new Map<string, PricingResolution>();

/**
 * Memoized per model id so the vendored resolver's "Unknown model" warning
 * fires once per process rather than once per token event.
 */
export function resolvePricing(model: string): PricingResolution {
  const cached = resolutions.get(model);
  if (cached) return cached;
  const pricing = resolveModelPricing(model);
  const resolution: PricingResolution = pricing
    ? { kind: 'priced', pricing }
    : { kind: 'unpriced' };
  if (resolutions.size >= MAX_MEMOIZED_MODELS) resolutions.clear();
  resolutions.set(model, resolution);
  return resolution;
}

export function priceUsage(model: string, usage: TokenUsage): PricedUsage {
  const resolution = resolvePricing(model);
  if (resolution.kind === 'unpriced') {
    return {
      resolution,
      breakdown: {
        inputUsd: 0,
        outputUsd: 0,
        thinkingUsd: 0,
        cacheReadUsd: 0,
        cacheCreationUsd: 0,
        totalUsd: 0,
        savingsFromCacheUsd: 0,
      },
    };
  }
  return { resolution, breakdown: calculateCost(model, usage) };
}

/** Call after anything mutates the vendored pricing singleton. */
export function clearPricingResolutions(): void {
  resolutions.clear();
}
