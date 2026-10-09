import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_PRICING_TABLE, initPricing } from '../shared/index.js';
import { makeUsage } from '../__test-utils__/token-usage.js';
import {
  clearPricingResolutions,
  priceUsage,
  resolvePricing,
  setRefreshedPricing,
} from './model-pricing.js';
import {
  fetchLiteLlmPrices,
  LITELLM_PRICES_URL,
  parseLiteLlmPrices,
  startPricingRefresh,
} from './pricing-refresh.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const OPUS = {
  mode: 'chat',
  input_cost_per_token: 4e-6,
  output_cost_per_token: 2e-5,
  cache_read_input_token_cost: 2e-7,
  cache_creation_input_token_cost: 5e-6,
  max_input_tokens: 1_000_000,
};
const SONNET_5_5 = {
  mode: 'chat',
  input_cost_per_token: 2e-6,
  output_cost_per_token: 1e-5,
  max_input_tokens: 1_000_000,
};

let consoleError: jest.SpiedFunction<typeof console.error>;
let tmpDir: string;

beforeEach(() => {
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  tmpDir = mkdtempSync(join(tmpdir(), 'preflight-pricing-refresh-'));
});

afterEach(() => {
  consoleError.mockRestore();
  setRefreshedPricing(null, new Set());
  initPricing(null);
  clearPricingResolutions();
  rmSync(tmpDir, { recursive: true, force: true });
});

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), init);
}

function fakeFetch(body: unknown, init?: ResponseInit): jest.Mock<typeof fetch> {
  return jest.fn<typeof fetch>(async () => jsonResponse(body, init));
}

describe('parseLiteLlmPrices', () => {
  it('maps a per-token entry to per-MTok pricing exactly', () => {
    const result = parseLiteLlmPrices({ 'claude-opus-5-5': OPUS });
    expect(result['claude-opus-5-5']).toEqual({
      inputPerMTok: 4,
      outputPerMTok: 20,
      cacheReadPerMTok: 0.2,
      cacheCreationPerMTok: 5,
      contextWindow: 1_000_000,
    });
  });

  it('converts 3e-6 to exactly 3', () => {
    const result = parseLiteLlmPrices({
      m: { ...SONNET_5_5, input_cost_per_token: 3e-6 },
    });
    expect(result.m.inputPerMTok).toBe(3);
  });

  it('skips entries that are not safe flat chat prices', () => {
    const raw = JSON.parse(`{
      "sample_spec": ${JSON.stringify(SONNET_5_5)},
      "openai/gpt-x": ${JSON.stringify(SONNET_5_5)},
      "embed": ${JSON.stringify({ ...SONNET_5_5, mode: 'embedding' })},
      "neg": ${JSON.stringify({ ...SONNET_5_5, input_cost_per_token: -1 })},
      "nan": {"mode":"chat","input_cost_per_token":null,"output_cost_per_token":1e-6,"max_input_tokens":10},
      "str": ${JSON.stringify({ ...SONNET_5_5, input_cost_per_token: '2e-6' })},
      "nowindow": {"mode":"chat","input_cost_per_token":1e-6,"output_cost_per_token":1e-6},
      "huge": ${JSON.stringify({ ...SONNET_5_5, input_cost_per_token: 1 })},
      "vastwindow": ${JSON.stringify({ ...SONNET_5_5, max_input_tokens: 1e15 })},
      "__proto__": ${JSON.stringify(SONNET_5_5)},
      "ok": ${JSON.stringify(SONNET_5_5)}
    }`) as unknown;
    const result = parseLiteLlmPrices(raw);
    expect(Object.keys(result)).toEqual(['ok']);
    expect(Object.getPrototypeOf(result)).toBeNull();
  });

  it('maps the above-200K input and output rates to a long-context tier', () => {
    const result = parseLiteLlmPrices({
      tiered: {
        ...SONNET_5_5,
        input_cost_per_token_above_200k_tokens: 6e-6,
        output_cost_per_token_above_200k_tokens: 2.25e-5,
      },
      halfTier: { ...SONNET_5_5, input_cost_per_token_above_200k_tokens: 6e-6 },
    });
    expect(result.tiered).toMatchObject({
      tierThreshold: 200_000,
      tierInputPerMTok: 6,
      tierOutputPerMTok: 22.5,
    });
    expect(result.halfTier).not.toHaveProperty('tierThreshold');
  });

  it('returns {} for non-object input', () => {
    expect(parseLiteLlmPrices(null)).toEqual({});
    expect(parseLiteLlmPrices([SONNET_5_5])).toEqual({});
    expect(parseLiteLlmPrices('x')).toEqual({});
  });
});

describe('fetchLiteLlmPrices', () => {
  it('returns parsed entries and calls the fixed URL without following redirects', async () => {
    const fetchImpl = fakeFetch({ 'claude-sonnet-5-5': SONNET_5_5 });
    const result = await fetchLiteLlmPrices({ fetchImpl });
    expect(result?.['claude-sonnet-5-5'].inputPerMTok).toBe(2);
    expect(fetchImpl).toHaveBeenCalledWith(
      LITELLM_PRICES_URL,
      expect.objectContaining({ redirect: 'error' }),
    );
  });

  it('returns null on a non-2xx status', async () => {
    expect(await fetchLiteLlmPrices({ fetchImpl: fakeFetch({}, { status: 404 }) })).toBeNull();
  });

  it('returns null when content-length exceeds the cap', async () => {
    const fetchImpl = fakeFetch({}, { headers: { 'content-length': '9000' } });
    expect(await fetchLiteLlmPrices({ fetchImpl, maxBytes: 1000 })).toBeNull();
  });

  it('returns null when a streamed body exceeds the cap without content-length', async () => {
    const fetchImpl = jest.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new TextEncoder().encode('x'.repeat(600)));
            },
          }),
        ),
    );
    expect(await fetchLiteLlmPrices({ fetchImpl, maxBytes: 1000 })).toBeNull();
  });

  it('returns null on invalid JSON', async () => {
    expect(await fetchLiteLlmPrices({ fetchImpl: fakeFetch('{nope') })).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    const fetchImpl = jest.fn<typeof fetch>(async () => {
      throw new Error('offline');
    });
    expect(await fetchLiteLlmPrices({ fetchImpl })).toBeNull();
  });
});

describe('startPricingRefresh', () => {
  const body = { 'refresh-only-sonnet': SONNET_5_5, 'refresh-only-opus': OPUS };

  function cachePath(): string {
    return join(tmpDir, 'sub', 'pricing-cache.json');
  }

  it('does nothing when disabled: no fetch, no cache, pre-written cache ignored', async () => {
    const p = join(tmpDir, 'pricing-cache.json');
    writeFileSync(
      p,
      JSON.stringify({
        'fake-model-9': { inputPerMTok: 1, outputPerMTok: 2, contextWindow: 1000 },
      }),
    );
    const fetchImpl = fakeFetch(body);
    await startPricingRefresh({ enabled: false, cachePath: p, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(resolvePricing('fake-model-9')).toEqual({ kind: 'unpriced' });

    const absent = join(tmpDir, 'absent', 'pricing-cache.json');
    await startPricingRefresh({ enabled: false, cachePath: absent, fetchImpl });
    expect(existsSync(absent)).toBe(false);
  });

  it('cold cache fetches, writes a 0o600 cache, and prices refreshed ids', async () => {
    const fetchImpl = fakeFetch(body);
    await startPricingRefresh({ enabled: true, cachePath: cachePath(), fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(statSync(cachePath()).mode & 0o777).toBe(0o600);
    expect(existsSync(`${cachePath()}.tmp`)).toBe(false);

    const resolution = resolvePricing('refresh-only-sonnet[1m]');
    expect(resolution).toMatchObject({ kind: 'priced', source: 'refreshed' });
    if (resolution.kind === 'priced') expect(resolution.pricing.inputPerMTok).toBe(2);

    const usage = makeUsage({ inputTokens: 1_000_000, totalTokens: 1_000_000 });
    expect(priceUsage('refresh-only-sonnet[1m]', usage).breakdown.totalUsd).toBeCloseTo(2, 10);
  });

  it('a fresh cache is used without fetching', async () => {
    await startPricingRefresh({
      enabled: true,
      cachePath: cachePath(),
      fetchImpl: fakeFetch(body),
    });
    setRefreshedPricing(null, new Set());
    const fetchImpl = fakeFetch(body);
    await startPricingRefresh({ enabled: true, cachePath: cachePath(), fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(resolvePricing('refresh-only-sonnet')).toMatchObject({ source: 'refreshed' });
  });

  it('a stale cache triggers a fetch', async () => {
    await startPricingRefresh({
      enabled: true,
      cachePath: cachePath(),
      fetchImpl: fakeFetch(body),
    });
    const old = new Date(Date.now() - 2 * DAY_MS);
    utimesSync(cachePath(), old, old);
    const fetchImpl = fakeFetch(body);
    await startPricingRefresh({ enabled: true, cachePath: cachePath(), fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a stale cache plus a failed fetch keeps using the stale entries', async () => {
    await startPricingRefresh({
      enabled: true,
      cachePath: cachePath(),
      fetchImpl: fakeFetch(body),
    });
    const old = new Date(Date.now() - 2 * DAY_MS);
    utimesSync(cachePath(), old, old);
    setRefreshedPricing(null, new Set());
    const fetchImpl = fakeFetch({}, { status: 500 });
    await startPricingRefresh({ enabled: true, cachePath: cachePath(), fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(resolvePricing('refresh-only-opus')).toMatchObject({ source: 'refreshed' });
  });

  it('never rejects when fetch throws', async () => {
    const fetchImpl = jest.fn<typeof fetch>(async () => {
      throw new Error('boom');
    });
    await expect(
      startPricingRefresh({ enabled: true, cachePath: cachePath(), fetchImpl }),
    ).resolves.toBeUndefined();
  });

  describe('safety', () => {
    it('a refreshed entry never changes a model the bundled table prices', async () => {
      const before = resolvePricing('claude-sonnet-5');
      expect(before).toMatchObject({ source: 'table' });
      const fetchImpl = fakeFetch({
        'claude-sonnet-5': { ...SONNET_5_5, input_cost_per_token: 999e-6 },
      });
      await startPricingRefresh({ enabled: true, cachePath: cachePath(), fetchImpl });
      const after = resolvePricing('claude-sonnet-5');
      expect(after).toEqual(before);
      if (after.kind === 'priced') expect(after.pricing.inputPerMTok).not.toBe(999);
    });

    it('a refreshed key extending a bundled key retargets nothing', async () => {
      const keys = Object.keys(DEFAULT_PRICING_TABLE);
      const probes = [...keys, 'claude-sonnet'];
      const before = probes.map((k) => resolvePricing(k));
      const fetchImpl = fakeFetch({
        'claude-sonnet-5-9': { ...SONNET_5_5, input_cost_per_token: 999e-6 },
      });
      await startPricingRefresh({ enabled: true, cachePath: cachePath(), fetchImpl });
      expect(resolvePricing('claude-sonnet-5-9')).toMatchObject({ source: 'refreshed' });
      probes.forEach((k, i) => expect(resolvePricing(k)).toEqual(before[i]));
    });

    it.each([
      ['a top-level array', '[1,2,3]'],
      ['a __proto__ key', `{"__proto__": ${JSON.stringify(SONNET_5_5)}}`],
      ['1e300 rates', JSON.stringify({ boom: { ...SONNET_5_5, input_cost_per_token: 1e300 } })],
    ])('hostile JSON (%s) registers nothing', async (_name, raw) => {
      const fetchImpl = fakeFetch(raw);
      await startPricingRefresh({ enabled: true, cachePath: cachePath(), fetchImpl });
      expect(existsSync(cachePath())).toBe(false);
      expect(resolvePricing('boom')).toEqual({ kind: 'unpriced' });
      expect(({} as Record<string, unknown>).inputPerMTok).toBeUndefined();
    });
  });
});
