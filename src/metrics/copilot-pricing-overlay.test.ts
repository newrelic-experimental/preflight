import { afterEach, describe, expect, it } from '@jest/globals';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initPricing, resolveModelPricing } from '../shared/pricing.js';
import {
  applyCopilotPricingOverlay,
  resolveCopilotPricingOverlayPath,
} from './copilot-pricing-overlay.js';

describe('resolveCopilotPricingOverlayPath', () => {
  it('resolves to the repo-root copilot-pricing/pricing.json in dev/test layout', () => {
    const path = resolveCopilotPricingOverlayPath();
    expect(path).not.toBeNull();
    expect(existsSync(path!)).toBe(true);
    expect(path!.endsWith(resolve('copilot-pricing', 'pricing.json'))).toBe(true);
  });

  it('the resolved file is valid JSON with the expected gap-fill models', () => {
    const path = resolveCopilotPricingOverlayPath();
    const parsed = JSON.parse(readFileSync(path!, 'utf-8')) as Record<string, unknown>;
    expect(parsed['raptor-mini']).toMatchObject({
      inputPerMTok: 0.25,
      outputPerMTok: 2,
      cacheReadPerMTok: 0.025,
    });
    expect(Object.keys(parsed)).toContain('kimi-k3');
  });
});

describe('applyCopilotPricingOverlay', () => {
  afterEach(() => {
    initPricing(null);
  });

  it('applies the bundled overlay when no user customPricingFile is configured', () => {
    expect(resolveModelPricing('raptor-mini')).toBeNull();
    applyCopilotPricingOverlay(null);
    expect(resolveModelPricing('raptor-mini')).toMatchObject({ inputPerMTok: 0.25 });
  });

  it('respects an explicit user customPricingFile instead of the bundled overlay', () => {
    // A user-supplied file that is not JSON at all — loadCustomPricing() will
    // reject it and log a warning, but the point under test is that we never
    // fall back to the bundled overlay once the user has configured their own.
    applyCopilotPricingOverlay('/nonexistent/user-pricing.json');
    expect(resolveModelPricing('raptor-mini')).toBeNull();
  });
});
