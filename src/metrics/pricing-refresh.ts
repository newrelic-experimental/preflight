import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { createLogger, PricingTable } from '../shared/index.js';
import type { ModelPricing } from '../shared/index.js';
import { loadCustomPricing } from '../shared/pricing.js';
import { setRefreshedPricing } from './model-pricing.js';

const logger = createLogger('pricing-refresh');

export const LITELLM_PRICES_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 8_000_000;
const MAX_ENTRIES = 2_000;
const MAX_KEY_LENGTH = 256;
const MAX_RATE_PER_MTOK = 10_000;
const MAX_CONTEXT_WINDOW = 10_000_000;
const LONG_CONTEXT_THRESHOLD = 200_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'sample_spec']);

function isNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function perMTok(perToken: number): number {
  return Number((perToken * 1e6).toPrecision(12));
}

/**
 * Maps LiteLLM's price file to ModelPricing. Keeps the standard rates and the
 * above-200K input/output tier, which Anthropic bills for the whole request like
 * the vendored 'flat' tier mode. Batch, flex and priority rates do not apply to
 * interactive coding sessions; tiered cache rates have no ModelPricing field.
 * Never throws.
 */
export function parseLiteLlmPrices(raw: unknown): Record<string, ModelPricing> {
  const result = Object.create(null) as Record<string, ModelPricing>;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return result;

  let count = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= MAX_ENTRIES) break;
    if (RESERVED_KEYS.has(key) || key.includes('/') || key.length > MAX_KEY_LENGTH) continue;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const e = value as Record<string, unknown>;
    if (e.mode !== 'chat') continue;
    if (!isNonNegative(e.input_cost_per_token) || !isNonNegative(e.output_cost_per_token)) continue;
    const window = e.max_input_tokens;
    if (typeof window !== 'number' || !Number.isInteger(window) || window <= 0) continue;
    if (window > MAX_CONTEXT_WINDOW) continue;

    const inputPerMTok = perMTok(e.input_cost_per_token);
    const outputPerMTok = perMTok(e.output_cost_per_token);
    const cacheReadPerMTok = isNonNegative(e.cache_read_input_token_cost)
      ? perMTok(e.cache_read_input_token_cost)
      : undefined;
    const cacheCreationPerMTok = isNonNegative(e.cache_creation_input_token_cost)
      ? perMTok(e.cache_creation_input_token_cost)
      : undefined;
    const hasTier =
      isNonNegative(e.input_cost_per_token_above_200k_tokens) &&
      isNonNegative(e.output_cost_per_token_above_200k_tokens);
    const tierInputPerMTok = hasTier
      ? perMTok(e.input_cost_per_token_above_200k_tokens as number)
      : undefined;
    const tierOutputPerMTok = hasTier
      ? perMTok(e.output_cost_per_token_above_200k_tokens as number)
      : undefined;
    const rates = [
      inputPerMTok,
      outputPerMTok,
      cacheReadPerMTok,
      cacheCreationPerMTok,
      tierInputPerMTok,
      tierOutputPerMTok,
    ];
    if (rates.some((r) => r !== undefined && r > MAX_RATE_PER_MTOK)) continue;

    result[key] = {
      inputPerMTok,
      outputPerMTok,
      ...(cacheReadPerMTok !== undefined && { cacheReadPerMTok }),
      ...(cacheCreationPerMTok !== undefined && { cacheCreationPerMTok }),
      ...(hasTier && {
        tierThreshold: LONG_CONTEXT_THRESHOLD,
        tierInputPerMTok,
        tierOutputPerMTok,
      }),
      contextWindow: window,
    };
    count++;
  }
  return result;
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function fetchLiteLlmPrices(
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; maxBytes?: number } = {},
): Promise<Record<string, ModelPricing> | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  try {
    const response = await fetchImpl(LITELLM_PRICES_URL, {
      redirect: 'error',
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.warn('LiteLLM price fetch failed', { status: response.status });
      return null;
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      logger.warn('LiteLLM price fetch failed', { reason: 'too large' });
      return null;
    }
    const bytes = await readCapped(response, maxBytes);
    if (bytes === null) {
      logger.warn('LiteLLM price fetch failed', { reason: 'too large' });
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      logger.warn('LiteLLM price fetch failed', { reason: 'invalid json' });
      return null;
    }
    return parseLiteLlmPrices(parsed);
  } catch (err) {
    logger.warn('LiteLLM price fetch failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function loadAndRegister(cachePath: string): void {
  const entries = loadCustomPricing(cachePath);
  if (entries) setRefreshedPricing(new PricingTable(cachePath), new Set(Object.keys(entries)));
}

function writeCache(cachePath: string, entries: Record<string, ModelPricing>): void {
  mkdirSync(dirname(cachePath), { recursive: true, mode: 0o700 });
  // Every Claude Code session runs its own server, so several can refresh at
  // once; a per-writer temp file keeps their writes from interleaving.
  const tmpPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(entries), { mode: 0o600 });
    renameSync(tmpPath, cachePath);
  } finally {
    rmSync(tmpPath, { force: true });
  }
}

/** Never rejects. With `enabled: false` it touches neither network nor disk. */
export async function startPricingRefresh(opts: {
  readonly enabled: boolean;
  readonly cachePath: string;
  readonly nowMs?: () => number;
  readonly fetchImpl?: typeof fetch;
}): Promise<void> {
  if (!opts.enabled) return;
  try {
    const now = (opts.nowMs ?? Date.now)();
    const cached = existsSync(opts.cachePath);
    if (cached) loadAndRegister(opts.cachePath);
    if (cached && now - statSync(opts.cachePath).mtimeMs < CACHE_TTL_MS) return;

    const entries = await fetchLiteLlmPrices({ fetchImpl: opts.fetchImpl });
    if (entries === null || Object.keys(entries).length === 0) return;
    writeCache(opts.cachePath, entries);
    loadAndRegister(opts.cachePath);
  } catch (err) {
    logger.warn('Pricing refresh failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
