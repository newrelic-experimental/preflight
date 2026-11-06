import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_PRICING_TABLE, initPricing } from '../shared/index.js';
import { makeUsage } from '../__test-utils__/token-usage.js';
import {
  clearPricingMemo,
  priceModelUsage,
  resolvePricingDetail,
  setRefreshedPricing,
} from './pricing-overlay.js';
import {
  fetchLiteLlmPrices,
  LITELLM_PRICES_URL,
  parseLiteLlmPrices,
  schedulePricingRecheck,
  startPricingRefresh,
  stopPricingRecheck,
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
  clearPricingMemo();
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
    const result = parseLiteLlmPrices({ 'claude-opus-8-5': OPUS });
    expect(result['claude-opus-8-5']).toEqual({
      inputPerMTok: 4,
      outputPerMTok: 20,
      cacheReadPerMTok: 0.2,
      cacheCreationPerMTok: 5,
      contextWindow: 1_000_000,
    });
  });

  it('keeps the 1-hour cache write rate and prices 1h writes at it', async () => {
    const entry = {
      ...OPUS,
      cache_creation_input_token_cost: 3.75e-6,
      cache_creation_input_token_cost_above_1hr: 6e-6,
    };
    expect(parseLiteLlmPrices({ 'claude-opus-8-5': entry })['claude-opus-8-5']).toMatchObject({
      cacheCreationPerMTok: 3.75,
      cacheCreation1hPerMTok: 6,
    });

    await startPricingRefresh({
      enabled: true,
      cachePath: join(tmpDir, 'pricing-cache.json'),
      fetchImpl: fakeFetch({ 'claude-opus-8-5': entry }),
    });
    const usage = makeUsage({
      cacheCreationTokens: 1_000_000,
      cacheCreation1hTokens: 1_000_000,
      totalTokens: 1_000_000,
    });
    expect(priceModelUsage('claude-opus-8-5', usage).breakdown.totalUsd).toBeCloseTo(6, 10);
  });

  it('skips an entry whose 1-hour cache write rate exceeds the cap', () => {
    const result = parseLiteLlmPrices({
      'claude-opus-8-5': { ...OPUS, cache_creation_input_token_cost_above_1hr: 1 },
    });
    expect(result).toEqual({});
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
    const fetchImpl = fakeFetch({ 'claude-sonnet-8-5': SONNET_5_5 });
    const result = await fetchLiteLlmPrices({ fetchImpl });
    expect(result?.['claude-sonnet-8-5'].inputPerMTok).toBe(2);
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
  const body = { 'claude-sonnet-8-5': SONNET_5_5, 'claude-opus-8-5': OPUS };

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
    expect(resolvePricingDetail('fake-model-9')).toEqual({ kind: 'unpriced' });

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

    const resolution = resolvePricingDetail('claude-sonnet-8-5[1m]');
    expect(resolution).toMatchObject({ kind: 'priced', source: 'refreshed' });
    if (resolution.kind === 'priced') expect(resolution.pricing.inputPerMTok).toBe(2);

    const usage = makeUsage({ inputTokens: 1_000_000, totalTokens: 1_000_000 });
    expect(priceModelUsage('claude-sonnet-8-5[1m]', usage).breakdown.totalUsd).toBeCloseTo(2, 10);
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
    expect(resolvePricingDetail('claude-sonnet-8-5')).toMatchObject({ source: 'refreshed' });
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
    expect(resolvePricingDetail('claude-opus-8-5')).toMatchObject({ source: 'refreshed' });
  });

  it('a stale cache plus a failed fetch is not refetched on the next start', async () => {
    await startPricingRefresh({
      enabled: true,
      cachePath: cachePath(),
      fetchImpl: fakeFetch(body),
    });
    const old = new Date(Date.now() - 2 * DAY_MS);
    utimesSync(cachePath(), old, old);
    await startPricingRefresh({
      enabled: true,
      cachePath: cachePath(),
      fetchImpl: fakeFetch({}, { status: 500 }),
    });
    const retry = fakeFetch(body);
    await startPricingRefresh({ enabled: true, cachePath: cachePath(), fetchImpl: retry });
    expect(retry).not.toHaveBeenCalled();
  });

  it('a failed fetch is retried once the backoff hour has passed', async () => {
    await startPricingRefresh({
      enabled: true,
      cachePath: cachePath(),
      fetchImpl: fakeFetch(body),
    });
    const old = new Date(Date.now() - 2 * DAY_MS);
    utimesSync(cachePath(), old, old);
    await startPricingRefresh({
      enabled: true,
      cachePath: cachePath(),
      fetchImpl: fakeFetch({}, { status: 500 }),
    });
    const retry = fakeFetch(body);
    await startPricingRefresh({
      enabled: true,
      cachePath: cachePath(),
      fetchImpl: retry,
      nowMs: () => Date.now() + 2 * 60 * 60 * 1000,
    });
    expect(retry).toHaveBeenCalledTimes(1);
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
      const before = resolvePricingDetail('claude-sonnet-5');
      expect(before).toMatchObject({ source: 'table' });
      const fetchImpl = fakeFetch({
        'claude-sonnet-5': { ...SONNET_5_5, input_cost_per_token: 999e-6 },
      });
      await startPricingRefresh({ enabled: true, cachePath: cachePath(), fetchImpl });
      const after = resolvePricingDetail('claude-sonnet-5');
      expect(after).toEqual(before);
      if (after.kind === 'priced') expect(after.pricing.inputPerMTok).not.toBe(999);
    });

    it('a refreshed key extending a bundled key retargets nothing', async () => {
      const keys = Object.keys(DEFAULT_PRICING_TABLE);
      const probes = [...keys, 'claude-sonnet'];
      const before = probes.map((k) => resolvePricingDetail(k));
      const fetchImpl = fakeFetch({
        'claude-sonnet-5-9': { ...SONNET_5_5, input_cost_per_token: 999e-6 },
      });
      await startPricingRefresh({ enabled: true, cachePath: cachePath(), fetchImpl });
      expect(resolvePricingDetail('claude-sonnet-5-9')).toMatchObject({ source: 'refreshed' });
      probes.forEach((k, i) => expect(resolvePricingDetail(k)).toEqual(before[i]));
    });

    it.each([
      ['a top-level array', '[1,2,3]'],
      ['a __proto__ key', `{"__proto__": ${JSON.stringify(SONNET_5_5)}}`],
      ['1e300 rates', JSON.stringify({ boom: { ...SONNET_5_5, input_cost_per_token: 1e300 } })],
    ])('hostile JSON (%s) registers nothing', async (_name, raw) => {
      const fetchImpl = fakeFetch(raw);
      await startPricingRefresh({ enabled: true, cachePath: cachePath(), fetchImpl });
      expect(existsSync(cachePath())).toBe(false);
      expect(resolvePricingDetail('boom')).toEqual({ kind: 'unpriced' });
      expect(({} as Record<string, unknown>).inputPerMTok).toBeUndefined();
    });
  });
});

describe('schedulePricingRecheck', () => {
  let cachePath: string;

  beforeEach(() => {
    jest.useFakeTimers();
    cachePath = join(tmpDir, 'pricing-cache.json');
  });

  afterEach(() => {
    stopPricingRecheck();
    jest.useRealTimers();
  });

  it('prices a model released after startup once the cache is a day old', async () => {
    const opts = {
      enabled: true,
      cachePath,
      fetchImpl: jest
        .fn<typeof fetch>()
        .mockImplementationOnce(async () => jsonResponse({ 'claude-opus-8-5': OPUS }))
        .mockImplementation(async () =>
          jsonResponse({ 'claude-opus-8-5': OPUS, 'acme-chat-1': SONNET_5_5 }),
        ),
    };
    await startPricingRefresh(opts);
    // The file's real mtime can sit a few ms behind the fake clock, which would age the
    // cache past a day one tick early and fetch twice.
    const startedAt = new Date(Date.now());
    utimesSync(cachePath, startedAt, startedAt);
    schedulePricingRecheck(opts);
    expect(resolvePricingDetail('acme-chat-1').kind).toBe('unpriced');

    await jest.advanceTimersByTimeAsync(DAY_MS);

    expect(resolvePricingDetail('acme-chat-1')).toMatchObject({
      kind: 'priced',
      source: 'refreshed',
    });
    expect(opts.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('refetches nothing while the cache is fresh', async () => {
    const fetchImpl = fakeFetch({ 'claude-opus-8-5': OPUS });
    const opts = { enabled: true, cachePath, fetchImpl };
    await startPricingRefresh(opts);
    schedulePricingRecheck(opts);

    await jest.advanceTimersByTimeAsync(12 * 60 * 60 * 1000);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('leaves the pricing memo alone while the cache is unchanged and fresh', async () => {
    const opts = { enabled: true, cachePath, fetchImpl: fakeFetch({ 'claude-opus-8-5': OPUS }) };
    await startPricingRefresh(opts);
    schedulePricingRecheck(opts);
    const memoProbe = resolvePricingDetail('claude-opus-8-5');
    const logsBefore = consoleError.mock.calls.length;

    await jest.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);

    expect(resolvePricingDetail('claude-opus-8-5')).toBe(memoProbe);
    expect(consoleError.mock.calls.length).toBe(logsBefore);
  });

  it('schedules nothing when disabled', async () => {
    const fetchImpl = fakeFetch({ 'claude-opus-8-5': OPUS });
    schedulePricingRecheck({ enabled: false, cachePath, fetchImpl });

    await jest.advanceTimersByTimeAsync(3 * DAY_MS);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(existsSync(cachePath)).toBe(false);
  });
});
