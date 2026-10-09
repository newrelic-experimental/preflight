import type { CostBreakdown, ModelPricing, TokenUsage } from '../shared/index.js';
import {
  calculateCost,
  createLogger,
  DEFAULT_PRICING_TABLE,
  resolveModelPricing,
} from '../shared/index.js';

const logger = createLogger('model-pricing');

export type PricingResolution =
  | { readonly kind: 'priced'; readonly source: 'table'; readonly pricing: ModelPricing }
  | {
      readonly kind: 'priced';
      readonly source: 'estimated';
      readonly pricing: ModelPricing;
      readonly estimatedFrom: string;
    }
  | { readonly kind: 'unpriced' };

const CLAUDE_ID_RE = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/;
const CONTEXT_TAG_RE = /(\[[^\]]*\])+$/;

interface ParsedClaudeId {
  readonly family: string;
  readonly major: number;
  readonly minor: number;
}

function parseClaudeId(id: string): ParsedClaudeId | null {
  const match = CLAUDE_ID_RE.exec(id.replace(CONTEXT_TAG_RE, ''));
  if (!match) return null;
  return { family: match[1], major: Number(match[2]), minor: Number(match[3] ?? 0) };
}

const DATED_SUFFIX_RE = /-\d{8}$/;
const TABLE_IDS = Object.keys(DEFAULT_PRICING_TABLE);

/**
 * Picks the table id to price an unlisted point release from: the highest minor
 * of the same family and major, else the newest release of the family. Returns
 * null for non-Claude ids, unknown families, and ties between differently
 * priced ids, because a wrong price is worse than a visible $0.
 */
export function estimateFromFamily(
  model: string,
  candidateIds: readonly string[],
  priceOf: (id: string) => unknown = (id) => resolveModelPricing(id),
): string | null {
  const target = parseClaudeId(model);
  if (!target) return null;

  const siblings: { readonly id: string; readonly major: number; readonly minor: number }[] = [];
  for (const id of candidateIds) {
    const parsed = parseClaudeId(id);
    if (parsed && parsed.family === target.family) siblings.push({ id, ...parsed });
  }
  if (siblings.length === 0) return null;

  const sameMajor = siblings.filter((s) => s.major === target.major);
  const pool = sameMajor.length > 0 ? sameMajor : siblings;
  const best = pool.reduce((a, b) =>
    b.major > a.major || (b.major === a.major && b.minor > a.minor) ? b : a,
  );
  const group = pool.filter((s) => s.major === best.major && s.minor === best.minor);

  const byPrice = new Map<string, string>();
  for (const { id } of group) {
    const key = JSON.stringify(priceOf(id));
    const held = byPrice.get(key);
    if (held === undefined || (DATED_SUFFIX_RE.test(held) && !DATED_SUFFIX_RE.test(id))) {
      byPrice.set(key, id);
    }
  }
  if (byPrice.size > 1) {
    logger.warn('Ambiguous family pricing fallback; returning null', {
      model,
      candidates: group.map((s) => s.id),
    });
    return null;
  }
  return [...byPrice.values()][0];
}

export interface PricedUsage {
  readonly breakdown: CostBreakdown;
  readonly resolution: PricingResolution;
}

// Model ids arrive from transcripts and MCP tool input, so the memo is capped
// rather than trusting the set of ids to stay small.
const MAX_MEMOIZED_MODELS = 512;
const resolutions = new Map<string, PricingResolution>();

function computeResolution(model: string): PricingResolution {
  const pricing = resolveModelPricing(model);
  if (pricing) return { kind: 'priced', source: 'table', pricing };

  const estimatedFrom = estimateFromFamily(model, TABLE_IDS);
  const estimatedPricing = estimatedFrom === null ? null : resolveModelPricing(estimatedFrom);
  if (estimatedFrom === null || estimatedPricing === null) return { kind: 'unpriced' };
  logger.info('Pricing estimated from model family', { model, estimatedFrom });
  return { kind: 'priced', source: 'estimated', pricing: estimatedPricing, estimatedFrom };
}

/**
 * Memoized per model id so the vendored resolver's "Unknown model" warning
 * fires once per process rather than once per token event.
 */
export function resolvePricing(model: string): PricingResolution {
  const cached = resolutions.get(model);
  if (cached) return cached;
  const resolution = computeResolution(model);
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
  const priceId = resolution.source === 'estimated' ? resolution.estimatedFrom : model;
  return { resolution, breakdown: calculateCost(priceId, usage) };
}

/** Call after anything mutates the vendored pricing singleton. */
export function clearPricingResolutions(): void {
  resolutions.clear();
}
