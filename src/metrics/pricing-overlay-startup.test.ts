import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calculateCost, initPricing, resolveModelPricing } from '../shared/pricing.js';
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

  it.each([
    ['claude-opus-5-5', 4, 20, 0.2, 5, 'claude-opus-5', 5],
    ['claude-sonnet-5-5', 2, 10, 0.2, 2.5, 'claude-sonnet-5', 2],
  ])(
    'prices %s from the bundled overlay, including the [1m] id Claude Code reports',
    (model, input, output, cacheRead, cacheCreation, predecessor, predecessorInput) => {
      expect(resolveModelPricing(model)).toBeNull();

      applyGapFilledOverlay(resolvePricingOverlayPath() as string);

      const expected = {
        inputPerMTok: input,
        outputPerMTok: output,
        cacheReadPerMTok: cacheRead,
        cacheCreationPerMTok: cacheCreation,
        contextWindow: 1_000_000,
      };
      expect(resolveModelPricing(model)).toMatchObject(expected);
      expect(resolveModelPricing(`${model}[1m]`)).toMatchObject(expected);
      expect(resolveModelPricing(predecessor)).toMatchObject({ inputPerMTok: predecessorInput });
    },
  );

  it.each([
    ['gpt-6-astra', 10, 50, 1, 20 + 75],
    ['gpt-6-sol', 2, 10, 0.2, 4 + 15],
    ['gpt-6-luna', 0.1, 0.5, 0.01, 0.2 + 0.75],
  ])(
    'prices %s from the bundled overlay at base rates and 2x/1.5x above 272K input',
    (model, input, output, cacheRead, longContextTotal) => {
      expect(resolveModelPricing(model)).toBeNull();

      applyGapFilledOverlay(resolvePricingOverlayPath() as string);

      expect(resolveModelPricing(model)).toMatchObject({
        inputPerMTok: input,
        outputPerMTok: output,
        cacheReadPerMTok: cacheRead,
        contextWindow: 1_050_000,
      });
      const usage = (inputTokens: number) => ({
        inputTokens,
        outputTokens: 1_000_000,
        thinkingTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: inputTokens + 1_000_000,
      });
      expect(calculateCost(model, usage(272_000)).totalUsd).toBeCloseTo(input * 0.272 + output, 6);
      expect(calculateCost(model, usage(1_000_000)).totalUsd).toBeCloseTo(longContextTotal, 6);
    },
  );

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
