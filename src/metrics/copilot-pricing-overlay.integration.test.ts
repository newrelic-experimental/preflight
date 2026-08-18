import { afterEach, describe, expect, it } from '@jest/globals';
import { initPricing, resolveModelPricing } from '../shared/pricing.js';
import { resolveCopilotPricingOverlayPath } from './copilot-pricing-overlay.js';

describe('copilot pricing overlay integration', () => {
  afterEach(() => {
    // Reset the process-wide singleton so this test doesn't leak state into
    // others (initPricing() mutates a shared default table).
    initPricing(null);
  });

  it('resolves previously-unresolvable Copilot model ids once the overlay is applied', () => {
    expect(resolveModelPricing('raptor-mini')).toBeNull();

    const overlayPath = resolveCopilotPricingOverlayPath();
    expect(overlayPath).not.toBeNull();
    initPricing(overlayPath);

    expect(resolveModelPricing('raptor-mini')).toMatchObject({
      inputPerMTok: 0.25,
      outputPerMTok: 2,
      cacheReadPerMTok: 0.025,
    });
  });

  it('does not disturb existing vendored entries', () => {
    initPricing(resolveCopilotPricingOverlayPath());
    expect(resolveModelPricing('claude-opus-4-8')).toMatchObject({
      inputPerMTok: 5,
      outputPerMTok: 25,
    });
  });
});
