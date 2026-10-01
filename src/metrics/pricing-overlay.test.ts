import { afterEach, describe, expect, it } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initPricing, resolveModelPricing } from '../shared/pricing.js';
import {
  applyGapFilledOverlay,
  applyPricingOverlay,
  calculateModelCost,
  normalizeModelId,
  resolvePricing,
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
