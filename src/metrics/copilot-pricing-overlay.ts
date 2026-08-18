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

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createLogger } from '../shared/index.js';
import { initPricing, loadCustomPricing, resolveModelPricing } from '../shared/pricing.js';
import type { ModelPricing } from '../shared/pricing.js';
import { resolveDataDir } from '../deploy/data-paths.js';

const logger = createLogger('copilot-pricing-overlay');

export function resolveCopilotPricingOverlayPath(): string | null {
  try {
    return resolve(resolveDataDir('copilot-pricing'), 'pricing.json');
  } catch {
    return null;
  }
}

/**
 * Loads an overlay file and applies only the entries that don't already
 * resolve against the vendored/default pricing table — enforcing the
 * gap-fill-only contract at the code level instead of by convention alone.
 * Without this, `initPricing()`'s `Object.assign`-based merge would happily
 * let an overlay entry silently override a vendored price. This already
 * happened once: an upstream shared-code sync started vendoring 4 models
 * this overlay also covered, with different (stale) tier semantics — caught
 * only by a human noticing during a later merge, not by any test or runtime
 * check.
 *
 * Exported for direct testing of the collision guard without needing to
 * fake `resolveCopilotPricingOverlayPath()`'s resolution logic.
 */
export function applyGapFilledOverlay(overlayPath: string): void {
  const overlay = loadCustomPricing(overlayPath);
  if (!overlay) return;

  const gaps: Record<string, ModelPricing> = {};
  for (const [modelId, pricing] of Object.entries(overlay)) {
    if (resolveModelPricing(modelId)) {
      logger.warn(
        'copilot-pricing overlay entry already resolves against the vendored pricing table — dropped to avoid overriding it',
        { modelId },
      );
      continue;
    }
    gaps[modelId] = pricing;
  }
  if (Object.keys(gaps).length === 0) return;

  // initPricing() only accepts a file path, so the gap-filtered subset is
  // written to a throwaway temp file rather than the original overlay path.
  let tmpDir: string | null = null;
  try {
    tmpDir = mkdtempSync(join(tmpdir(), 'preflight-copilot-pricing-'));
    const filteredPath = join(tmpDir, 'pricing.json');
    writeFileSync(filteredPath, JSON.stringify(gaps), { mode: 0o600 });
    initPricing(filteredPath);
  } catch (err) {
    logger.warn('Failed to apply gap-filtered copilot-pricing overlay', {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Applies the bundled Copilot pricing gap-fill overlay to the process-wide
 * pricing singleton at startup, unless the user has configured their own
 * `customPricingFile` (env or config `customPricingFile`, see
 * `src/config.ts`'s `McpServerConfig`) — that always takes precedence and is applied
 * unchanged. See copilot-pricing/README.md for why: `initPricing()`/
 * `PricingTable.reset()` accept exactly one file path and always rebuild
 * from `DEFAULT_PRICING_TABLE` — repeated calls REPLACE, they do not merge —
 * so a user's own pricing file and this bundled overlay are mutually
 * exclusive today; layering both would require a merge feature this doesn't
 * build (YAGNI unless requested).
 */
export function applyCopilotPricingOverlay(customPricingFile: string | null): void {
  if (customPricingFile) {
    initPricing(customPricingFile);
    return;
  }
  const overlayPath = resolveCopilotPricingOverlayPath();
  if (overlayPath) {
    applyGapFilledOverlay(overlayPath);
  }
}
