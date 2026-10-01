/**
 * Resolves the bundled `pricing-overlay/pricing.json` overlay path (see
 * `pricing-overlay/README.md` for what it fixes and why), or `null` when it
 * cannot be located.
 *
 * Reuses `resolveDataDir()` (src/deploy/data-paths.ts) for the actual
 * dev/bundled-layout probing, wrapped here because that function throws when
 * a directory is missing — appropriate for alerts/dashboards, which their own
 * commands cannot run without, but wrong for this overlay: pricing is a soft
 * enhancement, and its absence (e.g. an unusual install layout) must never
 * block MCP server startup.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';

import { createLogger } from '../shared/index.js';
import {
  calculateCost,
  initPricing,
  loadCustomPricing,
  resolveModelPricing,
} from '../shared/pricing.js';
import type { CostBreakdown, ModelPricing } from '../shared/pricing.js';
import type { TokenUsage } from '../shared/index.js';
import { resolveDataDir } from '../deploy/data-paths.js';

const logger = createLogger('pricing-overlay');

const BEDROCK_SYSTEM_ARN_RE =
  /^arn:aws[a-z-]*:bedrock:[a-z0-9-]+:\d*:(?:inference-profile|foundation-model)\/(.+)$/;
const MAX_PRICING_FILE_BYTES = 1_000_000;
const PROVIDER_PREFIX_RE = /^[a-z0-9_-]+\//;
const VARIANT_TAG_RE = /\[[^\]]*\]$/;

/**
 * Reduces the model strings gateways and Bedrock emit to the bare id the
 * vendored table knows. Application inference profile ARNs and gateway
 * aliases are opaque and pass through unchanged; `pricingAliases` maps them.
 */
export function normalizeModelId(raw: string): string {
  const id = raw.trim();
  const arn = BEDROCK_SYSTEM_ARN_RE.exec(id);
  if (arn) return arn[1];
  return id.replace(PROVIDER_PREFIX_RE, '');
}

let pricingAliases: ReadonlyMap<string, string> = new Map();

function lookupAlias(id: string): string | undefined {
  return pricingAliases.get(id) ?? pricingAliases.get(id.replace(VARIANT_TAG_RE, ''));
}

function canonicalModelId(raw: string): string {
  const normalized = normalizeModelId(raw);
  return lookupAlias(raw.trim()) ?? lookupAlias(normalized) ?? normalized;
}

/** Every Preflight-side pricing lookup goes through here, never `resolveModelPricing` directly. */
export function resolvePricing(model: string): ModelPricing | null {
  return resolveModelPricing(canonicalModelId(model));
}

export function calculateModelCost(model: string, usage: TokenUsage): CostBreakdown {
  return calculateCost(canonicalModelId(model), usage);
}

export function resolvePricingOverlayPath(): string | null {
  try {
    return resolve(resolveDataDir('pricing-overlay'), 'pricing.json');
  } catch {
    return null;
  }
}

/**
 * Loads an overlay file and applies only the entries that don't already
 * resolve against the vendored/default pricing table — enforcing the
 * gap-fill-only contract at the code level instead of by convention alone.
 * Without this, `initPricing()`'s `Object.assign`-based merge would happily
 * let an overlay entry silently override a vendored price. This already
 * happened once: an upstream shared-code sync started vendoring 4 models
 * this overlay also covered, with different (stale) tier semantics — caught
 * only by a human noticing during a later merge, not by any test or runtime
 * check.
 *
 * Exported for direct testing of the collision guard without needing to
 * fake `resolvePricingOverlayPath()`'s resolution logic.
 */
export function applyGapFilledOverlay(overlayPath: string): void {
  const overlay = loadCustomPricing(overlayPath);
  if (!overlay) return;

  const gaps: Record<string, ModelPricing> = {};
  for (const [modelId, pricing] of Object.entries(overlay)) {
    if (resolveModelPricing(modelId)) {
      logger.warn(
        'pricing overlay entry already resolves against the vendored pricing table — dropped to avoid overriding it',
        { modelId },
      );
      continue;
    }
    gaps[modelId] = pricing;
  }
  if (Object.keys(gaps).length === 0) return;

  initPricingFromEntries(gaps);
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
 * An alias-only file sets no rates, so the bundled gap-fill overlay still
 * applies, and alias targets are validated after it.
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
    applyBundledOverlay();
  }
  const aliases = parseAliases(rawAliases);
  validateAliasTargets(aliases);
  pricingAliases = aliases;
}

/**
 * Applies the bundled pricing gap-fill overlay to the process-wide pricing
 * singleton at startup, unless the user has configured their own
 * `customPricingFile` (env or config `customPricingFile`, see
 * `src/config.ts`'s `McpServerConfig`) — that always takes precedence and is applied
 * unchanged. See pricing-overlay/README.md for why: `initPricing()`/
 * `PricingTable.reset()` accept exactly one file path and always rebuild
 * from `DEFAULT_PRICING_TABLE` — repeated calls REPLACE, they do not merge —
 * so a user's own pricing file and this bundled overlay are mutually
 * exclusive today; layering both would require a merge feature this doesn't
 * build (YAGNI unless requested).
 */
export function applyPricingOverlay(customPricingFile: string | null): void {
  pricingAliases = new Map();
  if (customPricingFile) {
    applyCustomPricingFile(customPricingFile);
    return;
  }
  applyBundledOverlay();
}

function applyBundledOverlay(): void {
  const overlayPath = resolvePricingOverlayPath();
  if (overlayPath) {
    applyGapFilledOverlay(overlayPath);
  }
}
