import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calculateCost, initPricing, PricingTable, resolveModelPricing } from '../core/pricing.js';
import { makeUsage } from '../__test-utils__/token-usage.js';
import {
  applyCustomPricing,
  calculateModelCost,
  clearPricingMemo,
  normalizeModelId,
  priceModelUsage,
  resolvePricing,
  resolvePricingDetail,
  setRefreshedPricing,
} from './pricing-overlay.js';

describe('applyCustomPricing', () => {
  afterEach(() => {
    initPricing(null);
  });

  it('keeps the built-in table when no user customPricingFile is configured', () => {
    expect(() => applyCustomPricing(null)).not.toThrow();
    expect(resolveModelPricing('claude-opus-4-8')).toMatchObject({
      inputPerMTok: 5,
      outputPerMTok: 25,
    });
  });

  it('respects an explicit user customPricingFile', () => {
    // A user-supplied file that is not JSON at all — loadCustomPricing() will
    // reject it and log a warning, but the point under test is that the
    // rejected file leaves no model priced beyond the built-in table.
    applyCustomPricing('/nonexistent/user-pricing.json');
    expect(resolveModelPricing('definitely-not-a-real-model')).toBeNull();
  });
});

describe('normalizeModelId', () => {
  const APP_ARN = 'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123xyz';

  it.each([
    ['claude-sonnet-4-6', 'claude-sonnet-4-6'],
    ['us.anthropic.claude-sonnet-4-6', 'us.anthropic.claude-sonnet-4-6'],
    [
      'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-6',
      'us.anthropic.claude-sonnet-4-6',
    ],
    [
      'arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-4-6',
      'anthropic.claude-sonnet-4-6',
    ],
    [
      'arn:aws-us-gov:bedrock:us-gov-west-1:123456789012:inference-profile/us-gov.anthropic.claude-sonnet-4-6',
      'us-gov.anthropic.claude-sonnet-4-6',
    ],
    ['bedrock/claude-sonnet-4-6', 'claude-sonnet-4-6'],
    ['anthropic/claude-sonnet-4-6', 'claude-sonnet-4-6'],
    ['claude-sonnet-4-6[1m]', 'claude-sonnet-4-6[1m]'],
    [APP_ARN, APP_ARN],
    ['gw-claude-sonnet', 'gw-claude-sonnet'],
    ['', ''],
  ])('%s -> %s', (raw, expected) => {
    expect(normalizeModelId(raw)).toBe(expected);
  });
});

describe('model pricing through the boundary', () => {
  let dir: string | null = null;
  const APP_ARN = 'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123xyz';
  const writePricing = (body: unknown): string => {
    dir = mkdtempSync(join(tmpdir(), 'pricing-alias-test-'));
    const file = join(dir, 'pricing.json');
    writeFileSync(file, JSON.stringify(body));
    return file;
  };

  afterEach(() => {
    applyCustomPricing(null);
    initPricing(null);
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it.each([
    'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-6',
    'bedrock/claude-sonnet-4-6',
    'bedrock/us.anthropic.claude-sonnet-4-6',
  ])('prices %s like the bare model', (raw) => {
    const bare = raw.includes('us.anthropic')
      ? resolveModelPricing('us.anthropic.claude-sonnet-4-6')
      : resolveModelPricing('claude-sonnet-4-6');
    expect(bare).not.toBeNull();
    expect(resolvePricing(raw)).toEqual(bare);
  });

  it('leaves an opaque name unpriced without an alias', () => {
    expect(resolvePricing('gw-claude-sonnet')).toBeNull();
    expect(resolvePricing(APP_ARN)).toBeNull();
  });

  it('maps aliases, including application-inference-profile ARNs, to a known model', () => {
    applyCustomPricing(
      writePricing({
        aliases: {
          'gw-claude-sonnet': 'claude-sonnet-4-6',
          [APP_ARN]: 'bedrock/claude-sonnet-4-6',
        },
      }),
    );
    const sonnet = resolveModelPricing('claude-sonnet-4-6');
    expect(sonnet).not.toBeNull();
    expect(resolvePricing('gw-claude-sonnet')).toEqual(sonnet);
    expect(resolvePricing('gw-claude-sonnet[1m]')).toEqual(sonnet);
    expect(resolvePricing('bedrock/gw-claude-sonnet')).toEqual(sonnet);
    expect(resolvePricing(APP_ARN)).toEqual(sonnet);
  });

  it('prices usage for an aliased model', () => {
    applyCustomPricing(writePricing({ aliases: { 'gw-claude-sonnet': 'claude-sonnet-4-6' } }));
    const usage = {
      totalTokens: 1_000_000,
      inputTokens: 1_000_000,
      outputTokens: 0,
      thinkingTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    expect(calculateModelCost('gw-claude-sonnet', usage).totalUsd).toBeGreaterThan(0);
    expect(calculateModelCost('gw-claude-sonnet', usage)).toEqual(
      calculateModelCost('claude-sonnet-4-6', usage),
    );
  });

  it('ignores an alias to an unknown model and keeps the valid ones', () => {
    applyCustomPricing(
      writePricing({
        aliases: { 'gw-bogus': 'no-such-model', 'gw-claude-sonnet': 'claude-sonnet-4-6' },
      }),
    );
    expect(resolvePricing('gw-bogus')).toBeNull();
    expect(resolvePricing('gw-claude-sonnet')).not.toBeNull();
  });

  it('ignores malformed aliases without disturbing rate entries in the same file', () => {
    const rate = { inputPerMTok: 7, outputPerMTok: 9, contextWindow: 1000 };
    applyCustomPricing(writePricing({ 'my-model': rate, aliases: ['claude-sonnet-4-6'] }));
    expect(resolvePricing('my-model')).toMatchObject({ inputPerMTok: 7, outputPerMTok: 9 });

    applyCustomPricing(writePricing({ aliases: { 'gw-x': 42, 'gw-y': '' } }));
    expect(resolvePricing('gw-x')).toBeNull();
    expect(resolvePricing('gw-y')).toBeNull();
  });

  it('lets an alias target a custom-priced model in the same file', () => {
    const rate = { inputPerMTok: 7, outputPerMTok: 9, contextWindow: 1000 };
    applyCustomPricing(
      writePricing({ 'contracted-model': rate, aliases: { 'gw-c': 'contracted-model' } }),
    );
    expect(resolvePricing('gw-c')).toMatchObject({ inputPerMTok: 7 });
  });

  it('clears aliases when the custom file is dropped', () => {
    applyCustomPricing(writePricing({ aliases: { 'gw-claude-sonnet': 'claude-sonnet-4-6' } }));
    applyCustomPricing(null);
    expect(resolvePricing('gw-claude-sonnet')).toBeNull();
  });

  it('restores built-in rates when the custom file is dropped', () => {
    const opus = resolveModelPricing('claude-opus-4-8');
    applyCustomPricing(
      writePricing({
        'claude-opus-4-8': { inputPerMTok: 99, outputPerMTok: 99, contextWindow: 1000 },
      }),
    );
    expect(resolveModelPricing('claude-opus-4-8')).toMatchObject({ inputPerMTok: 99 });
    applyCustomPricing(null);
    expect(resolveModelPricing('claude-opus-4-8')).toEqual(opus);
  });

  it('restores built-in rates when a rate file is replaced by an alias-only file', () => {
    const opus = resolveModelPricing('claude-opus-4-8');
    applyCustomPricing(
      writePricing({
        'claude-opus-4-8': { inputPerMTok: 99, outputPerMTok: 99, contextWindow: 1000 },
      }),
    );
    applyCustomPricing(writePricing({ aliases: { 'gw-claude-sonnet': 'claude-sonnet-4-6' } }));
    expect(resolveModelPricing('claude-opus-4-8')).toEqual(opus);
  });

  it('keeps the built-in table for an alias-only file', () => {
    const opus = resolveModelPricing('claude-opus-4-8');
    applyCustomPricing(writePricing({ aliases: { 'gw-claude-sonnet': 'claude-sonnet-4-6' } }));
    expect(resolveModelPricing('claude-opus-4-8')).toEqual(opus);
    expect(resolvePricing('gw-claude-sonnet')).toEqual(resolveModelPricing('claude-sonnet-4-6'));
  });
});

describe('pricing memo', () => {
  const USAGE = makeUsage({ inputTokens: 10_000, outputTokens: 2_000, totalTokens: 12_000 });
  let consoleError: jest.SpiedFunction<typeof console.error>;
  let dir: string | null = null;

  const loggedText = (): string => consoleError.mock.calls.map((c) => String(c[0])).join('\n');
  const unknownWarnings = (): number =>
    loggedText().split('Unknown model, pricing not available').length - 1;

  beforeEach(() => {
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
    initPricing(null);
    clearPricingMemo();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('warns about an unknown model once, however often it is looked up or priced', () => {
    for (let i = 0; i < 5; i++) {
      resolvePricing('claude-foo-9-9');
      calculateModelCost('claude-foo-9-9', USAGE);
    }
    expect(unknownWarnings()).toBe(1);
  });

  it('prices an unknown model at zero', () => {
    expect(calculateModelCost('claude-foo-9-9', USAGE).totalUsd).toBe(0);
  });

  it('prices a bundled model the same as the built-in calculateCost', () => {
    expect(calculateModelCost('claude-sonnet-5', USAGE)).toEqual(
      calculateCost('claude-sonnet-5', USAGE),
    );
    expect(resolvePricing('claude-sonnet-5[1m]')).not.toBeNull();
  });

  it('re-resolves after a custom pricing file adds a model', () => {
    expect(resolvePricing('claude-foo-9-9')).toBeNull();

    dir = mkdtempSync(join(tmpdir(), 'preflight-pricing-memo-'));
    const customPath = join(dir, 'pricing.json');
    writeFileSync(
      customPath,
      JSON.stringify({
        'claude-foo-9-9': { inputPerMTok: 1, outputPerMTok: 2, contextWindow: 100_000 },
      }),
      { mode: 0o600 },
    );
    applyCustomPricing(customPath);

    expect(resolvePricing('claude-foo-9-9')?.contextWindow).toBe(100_000);
  });

  it('re-resolves after a custom pricing file changes the aliases', () => {
    expect(resolvePricing('gw-claude-sonnet')).toBeNull();
    dir = mkdtempSync(join(tmpdir(), 'preflight-pricing-memo-'));
    const file = join(dir, 'pricing.json');
    writeFileSync(file, JSON.stringify({ aliases: { 'gw-claude-sonnet': 'claude-sonnet-4-6' } }));
    applyCustomPricing(file);
    expect(resolvePricing('gw-claude-sonnet')).not.toBeNull();
  });

  it('evicts the oldest entry at the cap instead of dropping the whole memo', () => {
    resolvePricing('claude-sonnet-5');
    resolveModelPricing('claude-sonnet-5');
    for (let i = 0; i < 511; i++) resolvePricing(`claude-unknown-${i}`);
    consoleError.mockClear();

    // Cap is 512: this evicts claude-sonnet-5 (oldest) only, so an earlier
    // unknown id is still memoized and does not warn again.
    resolvePricing('claude-unknown-new');
    consoleError.mockClear();
    resolvePricing('claude-unknown-5');
    expect(unknownWarnings()).toBe(0);
  });
});

describe('family fallback', () => {
  const USAGE = makeUsage({ inputTokens: 10_000, outputTokens: 2_000, totalTokens: 12_000 });
  let consoleError: jest.SpiedFunction<typeof console.error>;
  let dir: string | null = null;

  beforeEach(() => {
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
    applyCustomPricing(null);
    clearPricingMemo();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  // Which sibling is newest changes with every built-in table sync, so these
  // assert the contract and leave sibling selection to estimateFromFamily.
  it.each(['claude-opus-5-9', 'claude-sonnet-5-9[1m]'])(
    'prices %s at the exact rate of a priced same-family, same-major release',
    (model) => {
      const r = resolvePricingDetail(model);
      if (r.kind !== 'priced' || r.source !== 'estimated')
        throw new Error(`not estimated: ${model}`);
      const family = model.replace(/\[.*$/, '').replace(/-\d+$/, '');
      expect(r.estimatedFrom.startsWith(family)).toBe(true);
      expect(r.pricing).toEqual(resolveModelPricing(r.estimatedFrom));
      expect(resolvePricing(model)).toEqual(r.pricing);
    },
  );

  it('prices an estimated model at its sibling rate', () => {
    const priced = priceModelUsage('claude-opus-5-9', USAGE);
    const r = priced.resolution;
    if (r.kind !== 'priced' || r.source !== 'estimated') throw new Error('not estimated');
    expect(priced.breakdown).toEqual(calculateCost(r.estimatedFrom, USAGE));
    expect(priced.breakdown.totalUsd).toBeGreaterThan(0);
  });

  it.each([
    'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-5-9-v1:0',
    'anthropic.claude-opus-5-9',
    'bedrock/claude-opus-5-9',
  ])('estimates the gateway or Bedrock spelling %s', (id) => {
    expect(resolvePricingDetail(id)).toMatchObject({ kind: 'priced', source: 'estimated' });
  });

  it('leaves unknown families and other vendors unpriced', () => {
    expect(resolvePricingDetail('claude-foo-9-9')).toEqual({ kind: 'unpriced' });
    expect(resolvePricingDetail('gpt-9-9')).toEqual({ kind: 'unpriced' });
    expect(priceModelUsage('claude-foo-9-9', USAGE).breakdown.totalUsd).toBe(0);
  });

  it('keeps an exact table hit as a table price', () => {
    expect(resolvePricingDetail('claude-opus-5')).toMatchObject({
      kind: 'priced',
      source: 'table',
    });
  });

  it('lets a custom pricing entry stand in as a sibling and yield to an exact entry', () => {
    dir = mkdtempSync(join(tmpdir(), 'preflight-pricing-family-'));
    const customPath = join(dir, 'pricing.json');
    writeFileSync(
      customPath,
      JSON.stringify({
        'claude-zzz-3-2': { inputPerMTok: 7, outputPerMTok: 9, contextWindow: 100_000 },
      }),
      { mode: 0o600 },
    );
    applyCustomPricing(customPath);
    expect(resolvePricingDetail('claude-zzz-3-5')).toMatchObject({
      source: 'estimated',
      estimatedFrom: 'claude-zzz-3-2',
    });
    writeFileSync(
      customPath,
      JSON.stringify({
        'claude-zzz-3-2': { inputPerMTok: 7, outputPerMTok: 9, contextWindow: 100_000 },
        'claude-zzz-3-5': { inputPerMTok: 1, outputPerMTok: 2, contextWindow: 100_000 },
      }),
      { mode: 0o600 },
    );
    applyCustomPricing(customPath);
    expect(resolvePricingDetail('claude-zzz-3-5')).toMatchObject({ source: 'table' });
  });
});

describe('refreshed pricing', () => {
  const entry = { inputPerMTok: 7, outputPerMTok: 9, contextWindow: 1000 };
  let dir: string | null = null;

  function register(ids: Record<string, typeof entry>): void {
    dir = mkdtempSync(join(tmpdir(), 'preflight-refreshed-'));
    const p = join(dir, 'pricing-cache.json');
    writeFileSync(p, JSON.stringify(ids));
    setRefreshedPricing(new PricingTable(p), new Set(Object.keys(ids)));
  }

  afterEach(() => {
    setRefreshedPricing(null, new Set());
    clearPricingMemo();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('prices an exact refreshed id and strips the context tag', () => {
    register({ 'zz-model-1': entry });
    expect(resolvePricingDetail('zz-model-1[1m]')).toMatchObject({
      kind: 'priced',
      source: 'refreshed',
    });
    const usage = makeUsage({ inputTokens: 1_000_000, totalTokens: 1_000_000 });
    expect(priceModelUsage('zz-model-1[1m]', usage).breakdown.inputUsd).toBe(7);
  });

  it('falls through to the family estimate, then unpriced, on a refreshed miss', () => {
    register({ 'zz-model-1': entry });
    expect(resolvePricingDetail('claude-sonnet-9-9')).toMatchObject({ source: 'estimated' });
    expect(resolvePricingDetail('zz-model-2')).toEqual({ kind: 'unpriced' });
  });

  it('clears the memo when refreshed pricing is set', () => {
    expect(resolvePricingDetail('zz-model-1')).toEqual({ kind: 'unpriced' });
    register({ 'zz-model-1': entry });
    expect(resolvePricingDetail('zz-model-1')).toMatchObject({ source: 'refreshed' });
    setRefreshedPricing(null, new Set());
    expect(resolvePricingDetail('zz-model-1')).toEqual({ kind: 'unpriced' });
  });
});
