import { readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import type { TokenUsage } from './tokens.js';
import { DEFAULT_PRICING_TABLE } from './pricing-data.js';
import { createLogger } from './logger.js';

const logger = createLogger('pricing');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  thinkingPerMTok?: number;
  cacheReadPerMTok?: number;
  cacheCreationPerMTok?: number;
  contextWindow: number;
  /** Token count above which tier rates apply (entire request billed at tier rate). */
  tierThreshold?: number;
  tierInputPerMTok?: number;
  tierOutputPerMTok?: number;
  tierThinkingPerMTok?: number;
}

export interface CostBreakdown {
  inputUsd: number;
  outputUsd: number;
  thinkingUsd: number;
  cacheReadUsd: number;
  cacheCreationUsd: number;
  totalUsd: number;
  savingsFromCacheUsd: number;
}

const ZERO_COST: CostBreakdown = Object.freeze({
  inputUsd: 0,
  outputUsd: 0,
  thinkingUsd: 0,
  cacheReadUsd: 0,
  cacheCreationUsd: 0,
  totalUsd: 0,
  savingsFromCacheUsd: 0,
});

// ---------------------------------------------------------------------------
// Merged table (built-in + custom overrides)
// ---------------------------------------------------------------------------

let mergedTable: Record<string, ModelPricing> = { ...DEFAULT_PRICING_TABLE };

// ---------------------------------------------------------------------------
// Custom pricing file
// ---------------------------------------------------------------------------

function isFiniteNonNegative(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

function validatePricingEntry(model: string, entry: unknown): ModelPricing | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    logger.warn('Custom pricing entry is not an object — skipped', { model });
    return null;
  }
  const e = entry as Record<string, unknown>;

  if (!isFiniteNonNegative(e.inputPerMTok)) {
    logger.warn('Custom pricing entry has invalid inputPerMTok — skipped', { model, value: e.inputPerMTok });
    return null;
  }
  if (!isFiniteNonNegative(e.outputPerMTok)) {
    logger.warn('Custom pricing entry has invalid outputPerMTok — skipped', { model, value: e.outputPerMTok });
    return null;
  }
  if (typeof e.contextWindow !== 'number' || !Number.isFinite(e.contextWindow) || e.contextWindow <= 0) {
    logger.warn('Custom pricing entry has invalid contextWindow — skipped', { model, value: e.contextWindow });
    return null;
  }

  const optionalRateFields = [
    'thinkingPerMTok', 'cacheReadPerMTok', 'cacheCreationPerMTok',
    'tierInputPerMTok', 'tierOutputPerMTok', 'tierThinkingPerMTok',
  ] as const;
  for (const field of optionalRateFields) {
    if (e[field] !== undefined && !isFiniteNonNegative(e[field])) {
      logger.warn(`Custom pricing entry has invalid ${field} — skipped`, { model, value: e[field] });
      return null;
    }
  }
  if (e.tierThreshold !== undefined && (typeof e.tierThreshold !== 'number' || !Number.isFinite(e.tierThreshold) || e.tierThreshold <= 0)) {
    logger.warn('Custom pricing entry has invalid tierThreshold — skipped', { model, value: e.tierThreshold });
    return null;
  }

  return e as unknown as ModelPricing;
}

export function loadCustomPricing(filePath: string): Record<string, ModelPricing> | null {
  const resolvedPath = resolve(filePath);

  if (extname(resolvedPath).toLowerCase() !== '.json') {
    logger.warn('Custom pricing file must have a .json extension', { filePath: resolvedPath });
    return null;
  }

  try {
    const raw = readFileSync(resolvedPath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      logger.warn('Custom pricing file is not a JSON object', { filePath: resolvedPath });
      return null;
    }

    const result: Record<string, ModelPricing> = {};
    for (const [model, entry] of Object.entries(parsed as Record<string, unknown>)) {
      const validated = validatePricingEntry(model, entry);
      if (validated !== null) {
        result[model] = validated;
      }
    }
    return result;
  } catch (err) {
    logger.warn('Failed to load custom pricing file', {
      filePath: resolvedPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * (Re-)initialize the merged pricing table. Call with a custom file path to
 * overlay user-provided prices on top of the built-in table. Call with
 * `null`/`undefined` to reset to the built-in defaults.
 */
export function initPricing(customFilePath?: string | null): void {
  mergedTable = { ...DEFAULT_PRICING_TABLE };

  if (customFilePath) {
    const custom = loadCustomPricing(customFilePath);
    if (custom) {
      Object.assign(mergedTable, custom);
    }
  }
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

// Strip a trailing dated suffix (-YYYYMMDD) to get the model family base name.
const DATED_SUFFIX_RE = /-\d{8}$/;

/**
 * Resolve a model name to its pricing entry.
 *
 * 1. Exact match (e.g. `claude-sonnet-4-20250514`)
 * 2. Forward prefix — table key starts with modelName
 *    (e.g. `claude-sonnet-4` matches `claude-sonnet-4-20250514`)
 * 3. Reverse prefix — modelName starts with table key's base (date stripped)
 *    (e.g. `claude-opus-4-7` matches base `claude-opus-4` from `claude-opus-4-20250514`)
 * 4. Return `null` and log a warning if nothing matches.
 */
export function resolveModelPricing(modelName: string): ModelPricing | null {
  // Exact match
  if (mergedTable[modelName]) {
    return mergedTable[modelName];
  }

  // Forward prefix: find table keys that start with the given name
  let bestKey: string | null = null;
  for (const key of Object.keys(mergedTable)) {
    if (key.startsWith(modelName) && (bestKey === null || key.length > bestKey.length)) {
      bestKey = key;
    }
  }

  if (bestKey) {
    return mergedTable[bestKey];
  }

  // Reverse prefix: strip date suffix from table keys and check if modelName
  // starts with the resulting base. Handles versioned names like "claude-opus-4-7"
  // matching the base "claude-opus-4" from key "claude-opus-4-20250514".
  let bestBase: string | null = null;
  let bestBaseKey: string | null = null;
  for (const key of Object.keys(mergedTable)) {
    const base = key.replace(DATED_SUFFIX_RE, '');
    if (base !== key && modelName.startsWith(base)) {
      if (bestBase === null || base.length > bestBase.length) {
        bestBase = base;
        bestBaseKey = key;
      }
    }
  }

  if (bestBaseKey) {
    return mergedTable[bestBaseKey];
  }

  logger.warn('Unknown model, pricing not available', { model: modelName });
  return null;
}

// ---------------------------------------------------------------------------
// Cost calculation
// ---------------------------------------------------------------------------

function tokensToUsd(tokens: number, ratePerMTok: number): number {
  return (tokens * ratePerMTok) / 1_000_000;
}

/**
 * Calculate a cost breakdown for the given model and token usage.
 *
 * If the model is unknown, returns an all-zero breakdown and logs a warning.
 * When tiered pricing applies (input tokens exceed the tier threshold),
 * the entire request is billed at the tier rate.
 */
export function calculateCost(model: string, usage: TokenUsage): CostBreakdown {
  const pricing = resolveModelPricing(model);
  if (!pricing) {
    return { ...ZERO_COST };
  }

  // Determine whether tiered pricing applies
  const useTier =
    pricing.tierThreshold !== undefined && usage.inputTokens > pricing.tierThreshold;

  const inputRate = useTier && pricing.tierInputPerMTok !== undefined
    ? pricing.tierInputPerMTok
    : pricing.inputPerMTok;

  const outputRate = useTier && pricing.tierOutputPerMTok !== undefined
    ? pricing.tierOutputPerMTok
    : pricing.outputPerMTok;

  const thinkingRate = useTier && pricing.tierThinkingPerMTok !== undefined
    ? pricing.tierThinkingPerMTok
    : (pricing.thinkingPerMTok ?? 0);

  const cacheReadRate = pricing.cacheReadPerMTok ?? 0;
  const cacheCreationRate = pricing.cacheCreationPerMTok ?? 0;

  const inputUsd = tokensToUsd(usage.inputTokens, inputRate);
  const outputUsd = tokensToUsd(usage.outputTokens, outputRate);
  const thinkingUsd = tokensToUsd(usage.thinkingTokens, thinkingRate);
  const cacheReadUsd = tokensToUsd(usage.cacheReadTokens, cacheReadRate);
  const cacheCreationUsd = tokensToUsd(usage.cacheCreationTokens, cacheCreationRate);

  const totalUsd = inputUsd + outputUsd + thinkingUsd + cacheReadUsd + cacheCreationUsd;

  // Savings: what those cache-read tokens would have cost at the full input rate
  const savingsFromCacheUsd = tokensToUsd(
    usage.cacheReadTokens,
    inputRate - cacheReadRate,
  );

  return {
    inputUsd,
    outputUsd,
    thinkingUsd,
    cacheReadUsd,
    cacheCreationUsd,
    totalUsd,
    savingsFromCacheUsd,
  };
}
