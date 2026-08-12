/**
 * Resolves the bundled `copilot-pricing/pricing.json` overlay path (see
 * `copilot-pricing/README.md` for what it fixes and why), or `null` when it
 * cannot be located.
 *
 * Reuses `resolveDataDir()` (src/deploy/data-paths.ts) for the actual
 * dev/bundled-layout probing, wrapped here because that function throws when
 * a directory is missing — appropriate for alerts/dashboards, which their own
 * commands cannot run without, but wrong for this overlay: pricing is a soft
 * enhancement, and its absence (e.g. an unusual install layout) must never
 * block MCP server startup.
 */

import { resolve } from 'node:path';
import { resolveDataDir } from '../deploy/data-paths.js';
import { initPricing } from '../shared/pricing.js';

export function resolveCopilotPricingOverlayPath(): string | null {
  try {
    return resolve(resolveDataDir('copilot-pricing'), 'pricing.json');
  } catch {
    return null;
  }
}

/**
 * Applies the bundled Copilot pricing gap-fill overlay to the process-wide
 * pricing singleton at startup, unless the user has configured their own
 * `customPricingFile` (env `NEW_RELIC_AI_CUSTOM_PRICING_FILE`) — that always
 * takes precedence and is applied unchanged.
 *
 * `initPricing()`/`PricingTable.reset()` accept exactly one file path and
 * always rebuild from `DEFAULT_PRICING_TABLE` — repeated calls REPLACE, they
 * do not merge. So a user's own pricing file and this bundled overlay are
 * mutually exclusive today; layering both would require a merge feature this
 * doesn't build (YAGNI unless requested — see copilot-pricing/README.md).
 */
export function applyCopilotPricingOverlay(customPricingFile: string | null): void {
  if (customPricingFile) {
    initPricing(customPricingFile);
    return;
  }
  const overlayPath = resolveCopilotPricingOverlayPath();
  if (overlayPath) {
    initPricing(overlayPath);
  }
}
