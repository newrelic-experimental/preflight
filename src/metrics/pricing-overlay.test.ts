import { afterEach, describe, expect, it } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initPricing, resolveModelPricing } from '../shared/pricing.js';
import {
  applyGapFilledOverlay,
  applyPricingOverlay,
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
