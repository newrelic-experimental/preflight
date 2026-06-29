import { readFileSync, statSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import type { TokenUsage } from './tokens.js';
import { DEFAULT_PRICING_TABLE, MODEL_ALIASES } from './pricing-data.js';
import { createLogger } from './logger.js';

const logger = createLogger('pricing');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModelPricing {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  readonly thinkingPerMTok?: number;
  readonly cacheReadPerMTok?: number;
  readonly cacheCreationPerMTok?: number;
  readonly contextWindow: number;
  /** Input-token count above which tier rates apply. */
  readonly tierThreshold?: number;
  readonly tierInputPerMTok?: number;
  readonly tierOutputPerMTok?: number;
  readonly tierThinkingPerMTok?: number;
  /**
   * How tier rates are applied once `inputTokens > tierThreshold`. Defaults to
   * `'flat'` (current behavior, matches Gemini 1.5/2.5 Pro semantics).
   *
   * - `'flat'`: the **entire request** (input, output, thinking) is billed at
   *   the tier rates. This is what every provider we currently price uses.
   * - `'marginal'`: only the **input tokens above the threshold** are billed
   *   at `tierInputPerMTok`; tokens up to the threshold use `inputPerMTok`.
   *   Output and thinking always use their base rates in this mode — the
   *   `tierOutputPerMTok` / `tierThinkingPerMTok` fields are ignored. This
   *   models providers that charge a higher rate purely for excess context.
   *
   * No currently wrapped provider needs `'marginal'`; the mode exists for
   * forward compatibility.
   */
  readonly tierMode?: 'flat' | 'marginal';
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

// Strip a trailing dated suffix (-YYYYMMDD) to get the model family base name.
const DATED_SUFFIX_RE = /-\d{8}$/;

// ---------------------------------------------------------------------------
// Custom pricing file
// ---------------------------------------------------------------------------

// Sanity ceiling for per-MTok rates. The most expensive frontier model rates
// at the time of writing are well under $100/MTok; a value above $10,000/MTok
// almost certainly reflects a typo (e.g. forgetting that the unit is per
// million tokens, or pricing in cents instead of dollars). Reject these
// outright — silently accepting them produces wildly inflated cost telemetry.
const MAX_REASONABLE_RATE_PER_MTOK = 10_000;

// Maximum allowed size of a custom pricing JSON file.
// A pricing table is a small dictionary; even with hundreds of model entries
// the file is well under 100 KB. The 1 MB cap is a defensive ceiling that
// prevents `readFileSync` from happily slurping a multi-gigabyte file the
// caller mis-pointed us at, which would then OOM `JSON.parse`.
const MAX_PRICING_FILE_BYTES = 1_000_000;

function isFiniteNonNegative(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

function isWithinRateCeiling(v: number): boolean {
  return v <= MAX_REASONABLE_RATE_PER_MTOK;
}

function validatePricingEntry(model: string, entry: unknown): ModelPricing | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    logger.warn('Custom pricing entry is not an object — skipped', { model });
    return null;
  }
  const e = entry as Record<string, unknown>;

  if (!isFiniteNonNegative(e.inputPerMTok)) {
    logger.warn('Custom pricing entry has invalid inputPerMTok — skipped', {
      model,
      value: e.inputPerMTok,
    });
    return null;
  }
  if (!isWithinRateCeiling(e.inputPerMTok)) {
    logger.warn('Custom pricing entry has implausibly large inputPerMTok — skipped', {
      model,
      value: e.inputPerMTok,
      ceiling: MAX_REASONABLE_RATE_PER_MTOK,
    });
    return null;
  }
  if (!isFiniteNonNegative(e.outputPerMTok)) {
    logger.warn('Custom pricing entry has invalid outputPerMTok — skipped', {
      model,
      value: e.outputPerMTok,
    });
    return null;
  }
  if (!isWithinRateCeiling(e.outputPerMTok)) {
    logger.warn('Custom pricing entry has implausibly large outputPerMTok — skipped', {
      model,
      value: e.outputPerMTok,
      ceiling: MAX_REASONABLE_RATE_PER_MTOK,
    });
    return null;
  }
  if (
    typeof e.contextWindow !== 'number' ||
    !Number.isFinite(e.contextWindow) ||
    e.contextWindow <= 0 ||
    !Number.isInteger(e.contextWindow)
  ) {
    logger.warn(
      'Custom pricing entry has invalid contextWindow (must be a positive integer) — skipped',
      { model, value: e.contextWindow },
    );
    return null;
  }

  const optionalRateFields = [
    'thinkingPerMTok',
    'cacheReadPerMTok',
    'cacheCreationPerMTok',
    'tierInputPerMTok',
    'tierOutputPerMTok',
    'tierThinkingPerMTok',
  ] as const;
  for (const field of optionalRateFields) {
    const value = e[field];
    if (value === undefined) continue;
    if (!isFiniteNonNegative(value)) {
      logger.warn(`Custom pricing entry has invalid ${field} — skipped`, { model, value });
      return null;
    }
    if (!isWithinRateCeiling(value)) {
      logger.warn(`Custom pricing entry has implausibly large ${field} — skipped`, {
        model,
        value,
        ceiling: MAX_REASONABLE_RATE_PER_MTOK,
      });
      return null;
    }
  }
  if (
    e.tierThreshold !== undefined &&
    (typeof e.tierThreshold !== 'number' ||
      !Number.isFinite(e.tierThreshold) ||
      e.tierThreshold <= 0 ||
      !Number.isInteger(e.tierThreshold))
  ) {
    logger.warn(
      'Custom pricing entry has invalid tierThreshold (must be a positive integer) — skipped',
      { model, value: e.tierThreshold },
    );
    return null;
  }
  if (e.tierMode !== undefined && e.tierMode !== 'flat' && e.tierMode !== 'marginal') {
    logger.warn(
      'Custom pricing entry has invalid tierMode (must be "flat" or "marginal") — skipped',
      {
        model,
        value: e.tierMode,
      },
    );
    return null;
  }

  // Relational sanity checks — accept the entry but warn on configurations
  // that almost always indicate a misconfiguration. These are warnings, not
  // rejections: unusual but legitimate price structures (e.g. an experimental
  // discount where cache reads cost more than fresh input) should still be
  // representable without forcing the user to fork the validator.
  const inputRate = e.inputPerMTok as number;
  if (e.cacheReadPerMTok !== undefined && (e.cacheReadPerMTok as number) > inputRate) {
    logger.warn(
      'Custom pricing entry has cacheReadPerMTok above inputPerMTok — accepted but unusual',
      {
        model,
        cacheReadPerMTok: e.cacheReadPerMTok,
        inputPerMTok: inputRate,
      },
    );
  }
  if (e.tierInputPerMTok !== undefined && (e.tierInputPerMTok as number) < inputRate) {
    logger.warn(
      'Custom pricing entry has tierInputPerMTok below inputPerMTok — accepted but unusual (tier rates are typically higher)',
      {
        model,
        tierInputPerMTok: e.tierInputPerMTok,
        inputPerMTok: inputRate,
      },
    );
  }

  // Construct a fresh `ModelPricing` object that contains ONLY recognized
  // fields. Returning `e` directly leaks any typo'd or
  // future / unknown keys from the user's JSON into the merged table, where
  // they would surface in serialization (`Object.entries(...)`) and risk
  // future code mistaking them for valid pricing fields. Built as a single
  // literal to satisfy the readonly interface.
  return {
    inputPerMTok: e.inputPerMTok as number,
    outputPerMTok: e.outputPerMTok as number,
    contextWindow: e.contextWindow as number,
    ...(typeof e.thinkingPerMTok === 'number' && { thinkingPerMTok: e.thinkingPerMTok }),
    ...(typeof e.cacheReadPerMTok === 'number' && { cacheReadPerMTok: e.cacheReadPerMTok }),
    ...(typeof e.cacheCreationPerMTok === 'number' && {
      cacheCreationPerMTok: e.cacheCreationPerMTok,
    }),
    ...(typeof e.tierThreshold === 'number' && { tierThreshold: e.tierThreshold }),
    ...(typeof e.tierInputPerMTok === 'number' && { tierInputPerMTok: e.tierInputPerMTok }),
    ...(typeof e.tierOutputPerMTok === 'number' && { tierOutputPerMTok: e.tierOutputPerMTok }),
    ...(typeof e.tierThinkingPerMTok === 'number' && {
      tierThinkingPerMTok: e.tierThinkingPerMTok,
    }),
    ...((e.tierMode === 'flat' || e.tierMode === 'marginal') && { tierMode: e.tierMode }),
  };
}

/**
 * Load a custom pricing override file from disk.
 *
 * **This function is synchronous (`readFileSync` / `statSync`) and is intended
 * for startup-time use only**. Calling it from a hot path
 * — for example, a SIGHUP-triggered reload while the process is also serving
 * inference traffic — will block the event loop for the duration of the read
 * and parse. If you need reload-on-signal, schedule it from a worker thread
 * or wrap it in `setImmediate` so the surrounding tick can complete first.
 *
 * Files larger than {@link MAX_PRICING_FILE_BYTES} are rejected without being
 * read — a pricing table is a small dictionary, and a
 * mis-pointed multi-GB file would OOM `JSON.parse`.
 *
 * Returns the parsed override map on success, or `null` when the file is
 * missing, the wrong shape, too large, or contains no valid entries.
 *
 * **Note:** `null` is returned for both "file not found" and "all entries
 * invalid" — callers cannot distinguish the two cases from the return value
 * alone. Both emit a `logger.warn` with a distinguishing message so the
 * difference is visible in stderr. A future improvement would be to return a
 * discriminated union `{ status: 'ok' | 'not-found' | 'all-invalid', ... }`.
 */
export function loadCustomPricing(filePath: string): Record<string, ModelPricing> | null {
  const resolvedPath = resolve(filePath);

  if (extname(resolvedPath).toLowerCase() !== '.json') {
    logger.warn('Custom pricing file must have a .json extension', { filePath: resolvedPath });
    return null;
  }

  try {
    // Reject oversized files before reading — `readFileSync` will happily
    // slurp gigabytes into memory and `JSON.parse` will then OOM.
    const stat = statSync(resolvedPath);
    if (stat.size > MAX_PRICING_FILE_BYTES) {
      logger.warn('Custom pricing file exceeds size limit — skipped', {
        filePath: resolvedPath,
        sizeBytes: stat.size,
        maxBytes: MAX_PRICING_FILE_BYTES,
      });
      return null;
    }

    const raw = readFileSync(resolvedPath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      logger.warn('Custom pricing file is not a JSON object', { filePath: resolvedPath });
      return null;
    }

    // Null-prototype object prevents __proto__ assignment from polluting
    // Object.prototype even if a reserved key slips through.
    const result: Record<string, ModelPricing> = Object.create(null) as Record<
      string,
      ModelPricing
    >;
    const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
    for (const [model, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (RESERVED.has(model)) {
        logger.warn('Custom pricing entry uses a reserved key — skipped', { model });
        continue;
      }
      const validated = validatePricingEntry(model, entry);
      if (validated !== null) {
        result[model] = validated;
      }
    }
    // Return null when no valid entries were found so callers can distinguish
    // "applied custom pricing" (truthy) from "file present but all invalid".
    if (Object.keys(result).length === 0) {
      logger.warn('Custom pricing file contained no valid entries', { filePath: resolvedPath });
      return null;
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
 * Deep-clone a pricing table.
 *
 * `{ ...DEFAULT_PRICING_TABLE }` is a shallow copy — the inner `ModelPricing`
 * objects share references. With the default-singleton pattern, that means a
 * caller doing
 *
 * ```ts
 * import { DEFAULT_PRICING_TABLE } from '@newrelic/ai-telemetry';
 * DEFAULT_PRICING_TABLE['claude-opus-4-7'].outputPerMTok = 99999;
 * ```
 *
 * would mutate the live pricing data backing every active `PricingTable`
 * instance — including the process-wide default — until the next `reset()`.
 * Deep-cloning at construction breaks the shared-reference path so consumer
 * code can't accidentally rewrite the canonical rates.
 *
 * `structuredClone` (Node 17+) is preferred over `JSON.parse(JSON.stringify())`
 * because it preserves the value-type fidelity of `ModelPricing` (numeric
 * fields stay numbers; an undefined optional field stays undefined rather
 * than being silently dropped). The pricing table contains only plain
 * objects with primitive fields, so neither path's edge cases (cycles,
 * functions, Date) apply here, but `structuredClone` is also faster on
 * modern V8.
 */
function clonePricingTable(
  source: Readonly<Record<string, ModelPricing>>,
): Record<string, ModelPricing> {
  return structuredClone(source) as Record<string, ModelPricing>;
}

// ---------------------------------------------------------------------------
// PricingTable — instance-based pricing
// ---------------------------------------------------------------------------

/**
 * Encapsulated pricing table for a single agent / tenant.
 *
 * Each `PricingTable` instance owns its own merged table and resolution state.
 * Construct one per agent when a single Node process needs to serve multiple
 * tenants with different custom pricing overrides; otherwise the module-level
 * functions (`resolveModelPricing`, `calculateCost`, `initPricing`) operate on
 * a process-wide default singleton and are sufficient for the common case.
 *
 * Multi-tenant example:
 * ```ts
 * const tenantA = new PricingTable('/etc/agent-a/pricing.json');
 * const tenantB = new PricingTable('/etc/agent-b/pricing.json');
 * tenantA.resolve('claude-opus-4-7'); // sees agent-a overrides
 * tenantB.resolve('claude-opus-4-7'); // sees agent-b overrides
 * ```
 */
export class PricingTable {
  private table: Record<string, ModelPricing>;

  constructor(customFilePath?: string | null) {
    // Null-prototype base: Object.assign to a null-prototype target does not
    // invoke the __proto__ setter, so prototype pollution is defused even if
    // loadCustomPricing returns a result containing that key.
    this.table = Object.assign(
      Object.create(null) as Record<string, ModelPricing>,
      clonePricingTable(DEFAULT_PRICING_TABLE),
    );
    if (customFilePath) {
      const custom = loadCustomPricing(customFilePath);
      if (custom) {
        Object.assign(this.table, custom);
      }
    }
  }

  /**
   * Reset the table to built-in defaults, optionally re-overlaying a custom
   * pricing file. Equivalent to `new PricingTable(customFilePath)` but reuses
   * the existing instance.
   */
  reset(customFilePath?: string | null): void {
    this.table = Object.assign(
      Object.create(null) as Record<string, ModelPricing>,
      clonePricingTable(DEFAULT_PRICING_TABLE),
    );
    if (customFilePath) {
      const custom = loadCustomPricing(customFilePath);
      if (custom) {
        Object.assign(this.table, custom);
      }
    }
  }

  /**
   * Resolve a model name to its pricing entry. See module-level
   * `resolveModelPricing` for the resolution algorithm.
   */
  resolve(modelName: string): ModelPricing | null {
    // Returns shallow copies so caller mutation cannot corrupt the instance
    // table — resolved entries are values, not live references.
    // 1. Exact match — Object.hasOwn guards against inherited prototype values
    // for non-null-prototype tables and makes intent explicit.
    if (Object.hasOwn(this.table, modelName)) {
      return { ...this.table[modelName] };
    }

    // 2. Family-name alias
    const aliasTarget = MODEL_ALIASES[modelName];
    if (aliasTarget && Object.hasOwn(this.table, aliasTarget)) {
      return { ...this.table[aliasTarget] };
    }

    // Forward prefix: find table keys that start with the given name followed
    // by a digit-led suffix. Longest key wins on tie — but two same-length
    // candidates would be non-deterministic. Log a warning in that case
    // so future table additions that create ambiguity are visible.
    let bestKey: string | null = null;
    let ambiguous = false;
    for (const key of Object.keys(this.table)) {
      const suffix = key.slice(modelName.length);
      if (key.startsWith(modelName) && /^-\d/.test(suffix)) {
        if (bestKey === null || key.length > bestKey.length) {
          bestKey = key;
          ambiguous = false;
        } else if (key.length === bestKey.length) {
          ambiguous = true;
        }
      }
    }
    if (ambiguous && bestKey !== null) {
      // Returning a non-deterministic result is worse than returning null,
      // because the caller cannot distinguish "pricing found" from "pricing guessed".
      // Returning null forces the table maintainer to add an explicit alias entry
      // rather than silently accepting iteration-order-dependent pricing.
      logger.warn(
        'Ambiguous forward-prefix match — two same-length candidates; returning null. ' +
          'Add an explicit MODEL_ALIASES entry to resolve.',
        {
          model: modelName,
        },
      );
      return null;
    }

    if (bestKey && Object.hasOwn(this.table, bestKey)) {
      return { ...this.table[bestKey] };
    }

    // Reverse prefix: strip date suffix from table keys and check if modelName
    // starts with the resulting base. When the matched base has an alias,
    // route through the alias to the *current-generation* entry rather than
    // the legacy dated key.
    let bestBase: string | null = null;
    let bestBaseKey: string | null = null;
    for (const key of Object.keys(this.table)) {
      const base = key.replace(DATED_SUFFIX_RE, '');
      if (base !== key && modelName.startsWith(base)) {
        if (bestBase === null || base.length > bestBase.length) {
          bestBase = base;
          bestBaseKey = key;
        }
      }
    }

    if (bestBase && bestBaseKey) {
      const aliasedTarget = MODEL_ALIASES[bestBase];
      if (aliasedTarget && Object.hasOwn(this.table, aliasedTarget)) {
        return { ...this.table[aliasedTarget] };
      }
      return Object.hasOwn(this.table, bestBaseKey) ? { ...this.table[bestBaseKey] } : null;
    }

    logger.warn('Unknown model, pricing not available', { model: modelName });
    return null;
  }

  /**
   * Calculate a cost breakdown for the given model and token usage. See
   * module-level `calculateCost` for tiered-pricing semantics.
   */
  calculateCost(model: string, usage: TokenUsage): CostBreakdown {
    const pricing = this.resolve(model);
    if (!pricing) {
      return { ...ZERO_COST };
    }
    return computeCost(pricing, usage);
  }
}

// ---------------------------------------------------------------------------
// Process-wide default singleton + back-compat module API
// ---------------------------------------------------------------------------

const defaultTable = new PricingTable();

/**
 * (Re-)initialize the **default singleton** pricing table. Call with a custom
 * file path to overlay user-provided prices on top of the built-in table.
 * Call with `null`/`undefined` to reset to the built-in defaults.
 *
 * **Synchronous I/O — startup-only.** Reads the custom file with `readFileSync`;
 * calling this on a hot path (e.g. a SIGHUP-triggered
 * reload while the process is serving inference traffic) blocks the event
 * loop. Schedule reloads from a worker thread or wrap in `setImmediate`.
 *
 * **Note:** This mutates a process-wide singleton. If your process serves
 * multiple agents with distinct pricing files, instantiate a `PricingTable`
 * per agent instead — calling `initPricing` again will overwrite the
 * previously-loaded prices and the first agent will silently see the second's.
 */
export function initPricing(customFilePath?: string | null): void {
  defaultTable.reset(customFilePath);
}

/**
 * Resolve a model name against the default singleton pricing table.
 *
 * 1. Exact match (e.g. `claude-sonnet-4-20250514`)
 * 2. Family-name alias (e.g. `claude-opus-4` → `claude-opus-4-7`) — see
 *    MODEL_ALIASES in pricing-data.ts. Aliases are the *primary* mechanism
 *    for routing family names to current-generation pricing.
 * 3. Forward prefix — table key starts with modelName
 *    (e.g. an unaliased `gemini-2.5-flash` would match itself; only used for
 *    coverage of new keys not yet in the alias map)
 * 4. Reverse prefix — modelName starts with table key's base (date stripped)
 *    (e.g. `claude-opus-4-99` matches base `claude-opus-4` from a dated key)
 * 5. Return `null` and log a warning if nothing matches.
 */
export function resolveModelPricing(modelName: string): ModelPricing | null {
  return defaultTable.resolve(modelName);
}

// ---------------------------------------------------------------------------
// Cost calculation helpers
// ---------------------------------------------------------------------------

function tokensToUsd(tokens: number, ratePerMTok: number): number {
  return (tokens * ratePerMTok) / 1_000_000;
}

function computeCost(pricing: ModelPricing, usage: TokenUsage): CostBreakdown {
  const tierMode = pricing.tierMode ?? 'flat';
  const useTier = pricing.tierThreshold !== undefined && usage.inputTokens > pricing.tierThreshold;

  // Output / thinking rates: only flat mode uses the tier overrides; in
  // marginal mode they always use the base rates.
  const outputRate =
    useTier && tierMode === 'flat' && pricing.tierOutputPerMTok !== undefined
      ? pricing.tierOutputPerMTok
      : pricing.outputPerMTok;

  const thinkingRate =
    useTier && tierMode === 'flat' && pricing.tierThinkingPerMTok !== undefined
      ? pricing.tierThinkingPerMTok
      : (pricing.thinkingPerMTok ?? 0);

  const cacheReadRate = pricing.cacheReadPerMTok ?? 0;
  const cacheCreationRate = pricing.cacheCreationPerMTok ?? 0;

  // Resolve the "billing rate" for input. In flat mode this single rate
  // covers all input tokens; in marginal mode the rate that would have been
  // applied if no caching had happened — used for the savings comparison.
  const inputRate =
    useTier && tierMode === 'flat' && pricing.tierInputPerMTok !== undefined
      ? pricing.tierInputPerMTok
      : pricing.inputPerMTok;

  // Input cost: marginal mode splits at the threshold; flat mode uses inputRate.
  let inputUsd: number;
  if (useTier && tierMode === 'marginal' && pricing.tierInputPerMTok !== undefined) {
    const threshold = pricing.tierThreshold!;
    const baseTokens = Math.min(usage.inputTokens, threshold);
    const excessTokens = usage.inputTokens - baseTokens;
    inputUsd =
      tokensToUsd(baseTokens, pricing.inputPerMTok) +
      tokensToUsd(excessTokens, pricing.tierInputPerMTok);
  } else {
    inputUsd = tokensToUsd(usage.inputTokens, inputRate);
  }

  const outputUsd = tokensToUsd(usage.outputTokens, outputRate);
  const thinkingUsd = tokensToUsd(usage.thinkingTokens, thinkingRate);
  const cacheReadUsd = tokensToUsd(usage.cacheReadTokens, cacheReadRate);
  const cacheCreationUsd = tokensToUsd(usage.cacheCreationTokens, cacheCreationRate);

  const totalUsd = inputUsd + outputUsd + thinkingUsd + cacheReadUsd + cacheCreationUsd;

  // Savings: what the cache-read tokens would have cost at the full input rate.
  // In marginal mode, the savings rate depends on whether the fresh input
  // exceeded the tier threshold — above-threshold tokens save at the tier rate,
  // not the base rate.
  const savingsInputRate =
    useTier &&
    tierMode === 'marginal' &&
    pricing.tierInputPerMTok !== undefined &&
    usage.inputTokens > (pricing.tierThreshold ?? Infinity)
      ? pricing.tierInputPerMTok
      : inputRate;
  // Clamp to >= 0 — a misconfigured custom pricing entry where cacheReadRate
  // exceeds inputRate would otherwise produce a negative "savings" number that
  // gets reported as a positive cost benefit downstream.
  const savingsFromCacheUsd = Math.max(
    0,
    tokensToUsd(usage.cacheReadTokens, savingsInputRate - cacheReadRate),
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

/**
 * Calculate a cost breakdown for the given model and token usage against the
 * default singleton pricing table.
 *
 * If the model is unknown, returns an all-zero breakdown and logs a warning.
 *
 * Tiered pricing semantics (when `inputTokens > tierThreshold`):
 *
 * - `tierMode: 'flat'` (default) — the entire request (input, output, thinking)
 *   is billed at the configured tier rates. Matches Gemini 1.5/2.5 Pro.
 * - `tierMode: 'marginal'` — only the input tokens above the threshold are
 *   billed at `tierInputPerMTok`; tokens up to the threshold use `inputPerMTok`.
 *   Output and thinking always use their base rates (the `tierOutput*` /
 *   `tierThinking*` fields are ignored in this mode).
 */
export function calculateCost(model: string, usage: TokenUsage): CostBreakdown {
  return defaultTable.calculateCost(model, usage);
}
