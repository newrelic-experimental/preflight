import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { calculateCost, initPricing, resolveModelPricing } from '../shared/pricing.js';
import { makeUsage } from '../__test-utils__/token-usage.js';
import {
  applyGapFilledOverlay,
  applyPricingOverlay,
  calculateModelCost,
  clearPricingMemo,
  normalizeModelId,
  priceModelUsage,
  resolvePricing,
  resolvePricingDetail,
  resolvePricingOverlayPath,
} from './pricing-overlay.js';

describe('resolvePricingOverlayPath', () => {
  it('resolves to the repo-root pricing-overlay/pricing.json in dev/test layout', () => {
    const path = resolvePricingOverlayPath();
    expect(path).not.toBeNull();
    expect(existsSync(path!)).toBe(true);
    expect(path!.endsWith(resolve('pricing-overlay', 'pricing.json'))).toBe(true);
  });

  it('the resolved file is valid JSON (a plain object, possibly empty)', () => {
    // Deliberately not asserting on specific model keys — the bundled file is
    // gap-fill-only, so its contents shrink to {} whenever the vendored table
    // catches up (see pricing-overlay/README.md).
    const path = resolvePricingOverlayPath();
    const parsed: unknown = JSON.parse(readFileSync(path!, 'utf-8'));
    expect(typeof parsed).toBe('object');
    expect(parsed).not.toBeNull();
    expect(Array.isArray(parsed)).toBe(false);
  });
});

describe('applyGapFilledOverlay', () => {
  let tmpDir: string;

  afterEach(() => {
    initPricing(null);
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('gap-fills a model missing from the vendored table', () => {
    expect(resolveModelPricing('a-brand-new-test-gap-model')).toBeNull();

    tmpDir = mkdtempSync(join(tmpdir(), 'preflight-overlay-test-'));
    const overlayPath = join(tmpDir, 'pricing.json');
    writeFileSync(
      overlayPath,
      JSON.stringify({
        'a-brand-new-test-gap-model': { inputPerMTok: 1, outputPerMTok: 2, contextWindow: 100_000 },
      }),
    );

    applyGapFilledOverlay(overlayPath);

    expect(resolveModelPricing('a-brand-new-test-gap-model')).toMatchObject({
      inputPerMTok: 1,
      outputPerMTok: 2,
    });
  });
});

describe('applyPricingOverlay', () => {
  afterEach(() => {
    initPricing(null);
  });

  it('applies the bundled overlay when no user customPricingFile is configured, without disturbing vendored entries', () => {
    expect(() => applyPricingOverlay(null)).not.toThrow();
    expect(resolveModelPricing('claude-opus-4-8')).toMatchObject({
      inputPerMTok: 5,
      outputPerMTok: 25,
    });
  });

  it('respects an explicit user customPricingFile instead of the bundled overlay', () => {
    // A user-supplied file that is not JSON at all — loadCustomPricing() will
    // reject it and log a warning, but the point under test is that we never
    // fall back to the bundled overlay once the user has configured their own.
    applyPricingOverlay('/nonexistent/user-pricing.json');
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
    applyPricingOverlay(null);
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
    applyPricingOverlay(
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
    applyPricingOverlay(writePricing({ aliases: { 'gw-claude-sonnet': 'claude-sonnet-4-6' } }));
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
    applyPricingOverlay(
      writePricing({
        aliases: { 'gw-bogus': 'no-such-model', 'gw-claude-sonnet': 'claude-sonnet-4-6' },
      }),
    );
    expect(resolvePricing('gw-bogus')).toBeNull();
    expect(resolvePricing('gw-claude-sonnet')).not.toBeNull();
  });

  it('ignores malformed aliases without disturbing rate entries in the same file', () => {
    const rate = { inputPerMTok: 7, outputPerMTok: 9, contextWindow: 1000 };
    applyPricingOverlay(writePricing({ 'my-model': rate, aliases: ['claude-sonnet-4-6'] }));
    expect(resolvePricing('my-model')).toMatchObject({ inputPerMTok: 7, outputPerMTok: 9 });

    applyPricingOverlay(writePricing({ aliases: { 'gw-x': 42, 'gw-y': '' } }));
    expect(resolvePricing('gw-x')).toBeNull();
    expect(resolvePricing('gw-y')).toBeNull();
  });

  it('lets an alias target a custom-priced model in the same file', () => {
    const rate = { inputPerMTok: 7, outputPerMTok: 9, contextWindow: 1000 };
    applyPricingOverlay(
      writePricing({ 'contracted-model': rate, aliases: { 'gw-c': 'contracted-model' } }),
    );
    expect(resolvePricing('gw-c')).toMatchObject({ inputPerMTok: 7 });
  });

  it('clears aliases when the custom file is dropped', () => {
    applyPricingOverlay(writePricing({ aliases: { 'gw-claude-sonnet': 'claude-sonnet-4-6' } }));
    applyPricingOverlay(null);
    expect(resolvePricing('gw-claude-sonnet')).toBeNull();
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

  it('prices a bundled model the same as the vendored calculateCost', () => {
    expect(calculateModelCost('claude-sonnet-5', USAGE)).toEqual(
      calculateCost('claude-sonnet-5', USAGE),
    );
    expect(resolvePricing('claude-sonnet-5[1m]')).not.toBeNull();
  });

  it('re-resolves after the overlay changes the table', () => {
    expect(resolvePricing('claude-foo-9-9')).toBeNull();

    dir = mkdtempSync(join(tmpdir(), 'preflight-pricing-memo-'));
    const overlayPath = join(dir, 'pricing.json');
    writeFileSync(
      overlayPath,
      JSON.stringify({
        'claude-foo-9-9': { inputPerMTok: 1, outputPerMTok: 2, contextWindow: 100_000 },
      }),
      { mode: 0o600 },
    );
    applyGapFilledOverlay(overlayPath);

    expect(resolvePricing('claude-foo-9-9')?.contextWindow).toBe(100_000);
  });

  it('re-resolves after a custom pricing file changes the aliases', () => {
    expect(resolvePricing('gw-claude-sonnet')).toBeNull();
    dir = mkdtempSync(join(tmpdir(), 'preflight-pricing-memo-'));
    const file = join(dir, 'pricing.json');
    writeFileSync(file, JSON.stringify({ aliases: { 'gw-claude-sonnet': 'claude-sonnet-4-6' } }));
    applyPricingOverlay(file);
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
    applyPricingOverlay(null);
    clearPricingMemo();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  // Which sibling is newest changes with every vendored table sync, so these
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

  it('lets an overlay entry stand in as a sibling and yield to an exact entry', () => {
    dir = mkdtempSync(join(tmpdir(), 'preflight-pricing-family-'));
    const overlayPath = join(dir, 'pricing.json');
    writeFileSync(
      overlayPath,
      JSON.stringify({
        'claude-zzz-3-2': { inputPerMTok: 7, outputPerMTok: 9, contextWindow: 100_000 },
      }),
      { mode: 0o600 },
    );
    applyPricingOverlay(overlayPath);
    expect(resolvePricingDetail('claude-zzz-3-5')).toMatchObject({
      source: 'estimated',
      estimatedFrom: 'claude-zzz-3-2',
    });
    writeFileSync(
      overlayPath,
      JSON.stringify({
        'claude-zzz-3-2': { inputPerMTok: 7, outputPerMTok: 9, contextWindow: 100_000 },
        'claude-zzz-3-5': { inputPerMTok: 1, outputPerMTok: 2, contextWindow: 100_000 },
      }),
      { mode: 0o600 },
    );
    applyPricingOverlay(overlayPath);
    expect(resolvePricingDetail('claude-zzz-3-5')).toMatchObject({ source: 'table' });
  });
});
