import { resolve } from 'node:path';

import type { McpServerConfig } from '../config.js';
import { applyPricingOverlay } from './pricing-overlay.js';
import { startPricingRefresh } from './pricing-refresh.js';

export interface InitModelPricingOptions {
  /** `false` skips the LiteLLM refresh, for short-lived commands like `doctor`. */
  readonly refresh?: boolean;
}

/**
 * Loads the pricing configuration into the process-wide pricing state that every
 * cost lookup in `pricing-overlay.ts` reads. Every process entry point that prices
 * tokens calls this once at startup, before its first lookup. Lives apart from
 * `pricing-overlay.ts` because `pricing-refresh.ts` already imports that module.
 */
export function initModelPricing(
  config: Pick<McpServerConfig, 'customPricingFile' | 'pricingRefresh' | 'storagePath'>,
  options: InitModelPricingOptions = {},
): void {
  applyPricingOverlay(config.customPricingFile);
  if (options.refresh === false) return;
  void startPricingRefresh({
    enabled: config.pricingRefresh,
    cachePath: resolve(config.storagePath, 'pricing-cache.json'),
  });
}
