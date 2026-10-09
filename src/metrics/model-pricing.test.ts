import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { calculateCost, initPricing } from '../shared/index.js';
import { makeUsage } from '../__test-utils__/token-usage.js';
import { clearPricingResolutions, priceUsage, resolvePricing } from './model-pricing.js';
import { applyGapFilledOverlay } from './pricing-overlay.js';

let consoleError: jest.SpiedFunction<typeof console.error>;
let tmpDir: string | null = null;

const USAGE = makeUsage({ inputTokens: 10_000, outputTokens: 2_000, totalTokens: 12_000 });

function loggedText(): string {
  return consoleError.mock.calls.map((c) => String(c[0])).join('\n');
}

beforeEach(() => {
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  consoleError.mockRestore();
  initPricing(null);
  clearPricingResolutions();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

describe('resolvePricing', () => {
  it('prices a bundled model from the table', () => {
    const resolution = resolvePricing('claude-sonnet-5');
    expect(resolution).toMatchObject({ kind: 'priced' });
    expect(resolution.kind === 'priced' && resolution.pricing.inputPerMTok).toBe(2);
  });

  it('strips a bracketed context tag', () => {
    expect(resolvePricing('claude-sonnet-5[1m]').kind).toBe('priced');
  });

  it('reports an unknown model as unpriced', () => {
    expect(resolvePricing('claude-foo-9-9')).toEqual({ kind: 'unpriced' });
  });

  it('warns about an unknown model once, however often it is priced', () => {
    for (let i = 0; i < 5; i++) priceUsage('claude-foo-9-9', USAGE);
    expect(loggedText().split('Unknown model, pricing not available').length - 1).toBe(1);
  });

  it('re-resolves after the overlay changes the table', () => {
    expect(resolvePricing('claude-foo-9-9').kind).toBe('unpriced');

    tmpDir = mkdtempSync(join(tmpdir(), 'preflight-model-pricing-'));
    const overlayPath = join(tmpDir, 'pricing.json');
    writeFileSync(
      overlayPath,
      JSON.stringify({
        'claude-foo-9-9': { inputPerMTok: 1, outputPerMTok: 2, contextWindow: 100_000 },
      }),
      { mode: 0o600 },
    );
    applyGapFilledOverlay(overlayPath);

    const resolution = resolvePricing('claude-foo-9-9');
    expect(resolution.kind === 'priced' && resolution.pricing.contextWindow).toBe(100_000);
  });
});

describe('priceUsage', () => {
  it('matches the vendored calculateCost for a priced model', () => {
    const priced = priceUsage('claude-sonnet-5', USAGE);
    expect(priced.resolution.kind).toBe('priced');
    expect(priced.breakdown).toEqual(calculateCost('claude-sonnet-5', USAGE));
  });

  it('returns a zero breakdown for an unpriced model', () => {
    const priced = priceUsage('claude-foo-9-9', USAGE);
    expect(priced.resolution.kind).toBe('unpriced');
    expect(priced.breakdown.totalUsd).toBe(0);
  });
});
