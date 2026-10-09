import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { calculateCost, initPricing, resolveModelPricing } from '../shared/index.js';
import { makeUsage } from '../__test-utils__/token-usage.js';
import {
  clearPricingResolutions,
  estimateFromFamily,
  priceUsage,
  resolvePricing,
} from './model-pricing.js';
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

describe('resolvePricing family fallback', () => {
  // Which sibling is newest changes with every vendored table sync, so these
  // assert the contract and leave sibling selection to estimateFromFamily below.
  it.each(['claude-opus-5-9', 'claude-sonnet-5-9[1m]'])(
    'prices %s at the exact rate of a priced same-family, same-major release',
    (model) => {
      const r = resolvePricing(model);
      if (r.kind !== 'priced' || r.source !== 'estimated')
        throw new Error(`not estimated: ${model}`);
      const family = model.replace(/\[.*$/, '').replace(/-\d+$/, '');
      expect(r.estimatedFrom.startsWith(family)).toBe(true);
      expect(r.pricing).toEqual(resolveModelPricing(r.estimatedFrom));
    },
  );

  it('leaves unknown families and other vendors unpriced', () => {
    expect(resolvePricing('claude-foo-9-9')).toEqual({ kind: 'unpriced' });
    expect(resolvePricing('gpt-9-9')).toEqual({ kind: 'unpriced' });
  });

  it('keeps an exact table hit as a table price', () => {
    expect(resolvePricing('claude-opus-5')).toMatchObject({ kind: 'priced', source: 'table' });
  });
});

describe('estimateFromFamily', () => {
  const same = () => ({ inputPerMTok: 1 });

  it('collapses equally priced dated and undated twins to the undated id', () => {
    expect(
      estimateFromFamily('claude-x-1-9', ['claude-x-1-1-20250101', 'claude-x-1-1'], same),
    ).toBe('claude-x-1-1');
    expect(
      estimateFromFamily('claude-x-1-9', ['claude-x-1-1', 'claude-x-1-1-20250101'], same),
    ).toBe('claude-x-1-1');
  });

  it('returns null and warns when the chosen release holds differently priced ids', () => {
    const priceOf = (id: string) => ({ inputPerMTok: id.endsWith('20250101') ? 2 : 1 });
    expect(
      estimateFromFamily('claude-x-1-9', ['claude-x-1-1', 'claude-x-1-1-20250101'], priceOf),
    ).toBeNull();
    expect(loggedText()).toContain('Ambiguous family pricing fallback; returning null');
  });

  it('picks the highest minor of the same major', () => {
    expect(
      estimateFromFamily('claude-x-5-9', ['claude-x-4-9', 'claude-x-5', 'claude-x-5-1'], same),
    ).toBe('claude-x-5-1');
  });

  it('falls back to the newest release when no sibling shares the major', () => {
    expect(estimateFromFamily('claude-x-6-9', ['claude-x-4-5', 'claude-x-5-1'], same)).toBe(
      'claude-x-5-1',
    );
  });

  it('never crosses families or vendors', () => {
    expect(estimateFromFamily('claude-y-1-9', ['claude-x-1-1'], same)).toBeNull();
    expect(estimateFromFamily('gpt-5', ['claude-x-1-1'], same)).toBeNull();
  });
});

describe('priceUsage', () => {
  it('matches the vendored calculateCost for a priced model', () => {
    const priced = priceUsage('claude-sonnet-5', USAGE);
    expect(priced.resolution.kind).toBe('priced');
    expect(priced.breakdown).toEqual(calculateCost('claude-sonnet-5', USAGE));
  });

  it('prices an estimated model at its sibling rate', () => {
    const priced = priceUsage('claude-opus-5-9', USAGE);
    const r = priced.resolution;
    if (r.kind !== 'priced' || r.source !== 'estimated') throw new Error('not estimated');
    expect(priced.breakdown).toEqual(calculateCost(r.estimatedFrom, USAGE));
    expect(priced.breakdown.totalUsd).toBeGreaterThan(0);
  });

  it('returns a zero breakdown for an unpriced model', () => {
    const priced = priceUsage('claude-foo-9-9', USAGE);
    expect(priced.resolution.kind).toBe('unpriced');
    expect(priced.breakdown.totalUsd).toBe(0);
  });
});
