import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initPricing, resolveModelPricing } from '../shared/pricing.js';
import { applyGapFilledOverlay, resolvePricingOverlayPath } from './pricing-overlay.js';

describe('pricing overlay integration', () => {
  afterEach(() => {
    // Reset the process-wide singleton so this test doesn't leak state into
    // others (initPricing() mutates a shared default table).
    initPricing(null);
  });

  it('loads the real bundled overlay file (via its resolved path) without disturbing vendored entries', () => {
    const overlayPath = resolvePricingOverlayPath();
    expect(overlayPath).not.toBeNull();
    initPricing(overlayPath);

    expect(resolveModelPricing('claude-opus-4-8')).toMatchObject({
      inputPerMTok: 5,
      outputPerMTok: 25,
    });
  });

  describe('applyGapFilledOverlay collision guard', () => {
    let tmpDir: string;

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('drops an overlay entry that collides with an already-vendored model instead of overriding it', () => {
      const vendoredBefore = resolveModelPricing('claude-opus-4-8');
      expect(vendoredBefore).toMatchObject({ inputPerMTok: 5, outputPerMTok: 25 });

      tmpDir = mkdtempSync(join(tmpdir(), 'preflight-overlay-collision-test-'));
      const overlayPath = join(tmpDir, 'pricing.json');
      writeFileSync(
        overlayPath,
        JSON.stringify({
          // Colliding key: already vendored, with deliberately wrong rates —
          // if the collision guard failed, resolveModelPricing would return
          // these bogus values instead of the real vendored ones.
          'claude-opus-4-8': { inputPerMTok: 999, outputPerMTok: 999, contextWindow: 200000 },
          // Genuine gap key alongside it — must still be applied even though
          // the colliding key above was dropped.
          'a-brand-new-gap-model': { inputPerMTok: 1, outputPerMTok: 2, contextWindow: 200000 },
        }),
      );

      applyGapFilledOverlay(overlayPath);

      expect(resolveModelPricing('claude-opus-4-8')).toEqual(vendoredBefore);
      expect(resolveModelPricing('a-brand-new-gap-model')).toMatchObject({
        inputPerMTok: 1,
        outputPerMTok: 2,
      });
    });
  });
});
