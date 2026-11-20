/**
 * The pricing facade: every Preflight cost lookup goes through this module.
 * Rate data lives in `src/core/pricing-data.ts`; this file layers model id
 * normalization, aliases, custom pricing files, and the LiteLLM refresh on top.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';

import { createLogger, DEFAULT_PRICING_TABLE } from '../core/index.js';
import { calculateCost, initPricing, resolveModelPricing } from '../core/pricing.js';
import type { CostBreakdown, ModelPricing, PricingTable } from '../core/pricing.js';
import type { TokenUsage } from '../core/index.js';
import { estimateFromFamily, stripTrailingTag, type PricingResolution } from './model-pricing.js';

const logger = createLogger('pricing-overlay');

const BEDROCK_SYSTEM_ARN_RE =
  /^arn:aws[a-z-]*:bedrock:[a-z0-9-]+:\d*:(?:inference-profile|foundation-model)\/(.+)$/;
// Mirrors the private limit in src/core/pricing.ts so an oversized file falls
// through to the shared loader, which logs the rejection. Keep the two equal.
const MAX_PRICING_FILE_BYTES = 1_000_000;
// Deliberately strips any one leading `<segment>/`, not a fixed provider list, so
// gateway prefixes we have never seen (`bedrock/`, `anthropic/`, `vertex/`) resolve too.
const PROVIDER_PREFIX_RE = /^[a-z0-9_-]+\//;

/**
 * Reduces the model strings gateways and Bedrock emit to the bare id the
 * built-in table knows. Application inference profile ARNs and gateway
 * aliases are opaque and pass through unchanged; `pricingAliases` maps them.
 */
export function normalizeModelId(raw: string): string {
  const id = raw.trim();
  const arn = BEDROCK_SYSTEM_ARN_RE.exec(id);
  if (arn) return arn[1];
  return id.replace(PROVIDER_PREFIX_RE, '');
}

const ZERO_COST: CostBreakdown = {
  inputUsd: 0,
  outputUsd: 0,
  thinkingUsd: 0,
  cacheReadUsd: 0,
  cacheCreationUsd: 0,
  totalUsd: 0,
  savingsFromCacheUsd: 0,
};

let pricingAliases: ReadonlyMap<string, string> = new Map();

function lookupAlias(id: string): string | undefined {
  return pricingAliases.get(id) ?? pricingAliases.get(stripTrailingTag(id));
}

function canonicalModelId(raw: string): string {
  const normalized = normalizeModelId(raw);
  return lookupAlias(raw.trim()) ?? lookupAlias(normalized) ?? normalized;
}

// Model ids arrive from transcripts and MCP tool input, so the memo is capped
// rather than trusting the set of ids to stay small.
const MAX_MEMOIZED_MODELS = 512;
const pricingMemo = new Map<string, PricingResolution>();

// Ids added by a custom pricing file. The pricing singleton keeps its merged
// table private, so they are tracked here to let them stand in as family
// siblings next to the built-in table.
let extraPricingIds: readonly string[] = [];

// Refreshed prices stay out of the built-in singleton: its prefix matching would
// let a refreshed key retarget ids the bundled table already resolves. They are
// consulted only on an exact id match, after the bundled table has missed.
let refreshedTable: PricingTable | null = null;
let refreshedIds: ReadonlySet<string> = new Set();

export function setRefreshedPricing(table: PricingTable | null, ids: ReadonlySet<string>): void {
  refreshedTable = table;
  refreshedIds = ids;
  pricingMemo.clear();
}

/** Drops memoized lookups; call after anything changes the pricing table or aliases. */
export function clearPricingMemo(): void {
  pricingMemo.clear();
}

function computeResolution(model: string): PricingResolution {
  const id = canonicalModelId(model);
  const pricing = resolveModelPricing(id);
  if (pricing) return { kind: 'priced', source: 'table', pricing };

  if (refreshedTable !== null) {
    const bare = stripTrailingTag(id);
    const refreshed = refreshedIds.has(bare) ? refreshedTable.resolve(bare) : null;
    if (refreshed) {
      logger.info('Pricing from the LiteLLM refresh', { model });
      return { kind: 'priced', source: 'refreshed', pricing: refreshed };
    }
  }

  const estimatedFrom = estimateFromFamily(
    id,
    [...Object.keys(DEFAULT_PRICING_TABLE), ...extraPricingIds],
    resolveModelPricing,
  );
  const estimatedPricing = estimatedFrom === null ? null : resolveModelPricing(estimatedFrom);
  if (estimatedFrom === null || estimatedPricing === null) return { kind: 'unpriced' };
  logger.info('Pricing estimated from model family', { model, estimatedFrom });
  return { kind: 'priced', source: 'estimated', pricing: estimatedPricing, estimatedFrom };
}

/**
 * Every Preflight-side pricing lookup goes through here, never `resolveModelPricing` directly.
 * Memoized per model id so the built-in resolver's "Unknown model" warning fires once per
 * process rather than once per token event. A model the table misses is priced from the newest
 * release of its family when one is unambiguous, and flagged `estimated`.
 */
export function resolvePricingDetail(model: string): PricingResolution {
  const cached = pricingMemo.get(model);
  if (cached !== undefined) return cached;
  const resolution = computeResolution(model);
  if (pricingMemo.size >= MAX_MEMOIZED_MODELS) {
    const oldest = pricingMemo.keys().next();
    if (!oldest.done) pricingMemo.delete(oldest.value);
  }
  pricingMemo.set(model, resolution);
  return resolution;
}

/** The rates for `model`, estimated ones included; `null` = unpriced. */
export function resolvePricing(model: string): ModelPricing | null {
  const resolution = resolvePricingDetail(model);
  return resolution.kind === 'priced' ? resolution.pricing : null;
}

export interface PricedUsage {
  readonly breakdown: CostBreakdown;
  readonly resolution: PricingResolution;
}

export function priceModelUsage(model: string, usage: TokenUsage): PricedUsage {
  const resolution = resolvePricingDetail(model);
  if (resolution.kind === 'unpriced') return { resolution, breakdown: { ...ZERO_COST } };
  if (resolution.source === 'refreshed' && refreshedTable !== null) {
    return {
      resolution,
      breakdown: refreshedTable.calculateCost(stripTrailingTag(canonicalModelId(model)), usage),
    };
  }
  const priceId =
    resolution.source === 'estimated' ? resolution.estimatedFrom : canonicalModelId(model);
  return { resolution, breakdown: calculateCost(priceId, usage) };
}

export function calculateModelCost(model: string, usage: TokenUsage): CostBreakdown {
  return priceModelUsage(model, usage).breakdown;
}

function initPricingFromEntries(entries: Record<string, unknown>): void {
  // initPricing() only accepts a file path, so the entries are written to a
  // throwaway temp file rather than the original path.
  let tmpDir: string | null = null;
  try {
    tmpDir = mkdtempSync(join(tmpdir(), 'preflight-pricing-overlay-'));
    const filteredPath = join(tmpDir, 'pricing.json');
    writeFileSync(filteredPath, JSON.stringify(entries), { mode: 0o600 });
    initPricing(filteredPath);
    extraPricingIds = Object.keys(entries);
  } catch (err) {
    logger.warn('Failed to apply pricing entries', {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  }
}

function parseAliases(raw: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (raw === undefined) return out;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    logger.warn('Custom pricing "aliases" must be an object of name to model id — ignored');
    return out;
  }
  for (const [name, target] of Object.entries(raw)) {
    if (typeof target !== 'string' || target.trim() === '') {
      logger.warn('Custom pricing alias target must be a model id string — ignored', { name });
      continue;
    }
    out.set(name, normalizeModelId(target));
  }
  return out;
}

function validateAliasTargets(aliases: Map<string, string>): void {
  for (const [name, target] of aliases) {
    if (!resolveModelPricing(target)) {
      logger.warn('Custom pricing alias points at an unknown model — ignored', { name, target });
      aliases.delete(name);
    }
  }
}

/**
 * Applies a user's custom pricing file. Its reserved `aliases` key maps an
 * opaque model name to a known model id; the remaining entries are rate
 * objects handed to the shared loader, which would otherwise warn on the
 * `aliases` key and reject an alias-only file as having no valid entries.
 * An alias-only file sets no rates, so the built-in table stays in effect,
 * and alias targets are validated against it.
 */
function applyCustomPricingFile(path: string): void {
  let parsed: Record<string, unknown>;
  try {
    if (extname(path).toLowerCase() !== '.json' || statSync(path).size > MAX_PRICING_FILE_BYTES) {
      throw new Error();
    }
    const json = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new Error();
    parsed = json as Record<string, unknown>;
  } catch {
    initPricing(path);
    return;
  }
  const { aliases: rawAliases, ...rates } = parsed;
  if (Object.keys(rates).length > 0) {
    initPricingFromEntries(rates);
  } else {
    initPricing(null);
  }
  const aliases = parseAliases(rawAliases);
  validateAliasTargets(aliases);
  pricingAliases = aliases;
}

/**
 * Sets the process-wide pricing state from the user's `customPricingFile`
 * (env or config, see `src/config.ts`'s `McpServerConfig`). With no file, it
 * resets to the built-in table (`initPricing(null)`) and clears aliases and
 * extra ids. With a file, its rate entries replace the built-in table and its
 * `aliases` map opaque model names to known model ids.
 *
 * `initPricing()` accepts one file and always rebuilds from
 * `DEFAULT_PRICING_TABLE`, so repeated calls replace rather than merge.
 */
export function applyCustomPricing(customPricingFile: string | null): void {
  try {
    applyCustomPricingUncached(customPricingFile);
  } finally {
    clearPricingMemo();
  }
}

function applyCustomPricingUncached(customPricingFile: string | null): void {
  pricingAliases = new Map();
  extraPricingIds = [];
  if (customPricingFile) {
    applyCustomPricingFile(customPricingFile);
    return;
  }
  initPricing(null);
}
