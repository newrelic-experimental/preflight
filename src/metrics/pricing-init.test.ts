import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.mock('./pricing-overlay.js', () => ({
  applyPricingOverlay: jest.fn(),
}));
jest.mock('./pricing-refresh.js', () => ({
  startPricingRefresh: jest.fn(async () => undefined),
}));

import { initModelPricing } from './pricing-init.js';
import { applyPricingOverlay } from './pricing-overlay.js';
import { startPricingRefresh } from './pricing-refresh.js';

const mockedApply = applyPricingOverlay as jest.MockedFunction<typeof applyPricingOverlay>;
const mockedRefresh = startPricingRefresh as jest.MockedFunction<typeof startPricingRefresh>;

const makeConfig = (
  overrides: Partial<Parameters<typeof initModelPricing>[0]> = {},
): Parameters<typeof initModelPricing>[0] => ({
  customPricingFile: '/test-home/pricing.json',
  pricingRefresh: true,
  storagePath: '/test-home/.newrelic-preflight',
  ...overrides,
});

describe('initModelPricing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('applies the custom pricing file and starts the refresh against the storage cache', () => {
    initModelPricing(makeConfig());
    expect(mockedApply).toHaveBeenCalledWith('/test-home/pricing.json');
    expect(mockedRefresh).toHaveBeenCalledWith({
      enabled: true,
      cachePath: '/test-home/.newrelic-preflight/pricing-cache.json',
    });
  });

  it('applies the pricing file but skips the refresh when refresh is false', () => {
    initModelPricing(makeConfig({ customPricingFile: null }), { refresh: false });
    expect(mockedApply).toHaveBeenCalledWith(null);
    expect(mockedRefresh).not.toHaveBeenCalled();
  });
});
