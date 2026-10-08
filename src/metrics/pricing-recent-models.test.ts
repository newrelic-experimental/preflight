import { describe, expect, it } from '@jest/globals';
import { calculateCost, resolveModelPricing } from '../shared/pricing.js';

// Regression guard for sessions that reported $0 cost and a 200K context window
// because the pricing table had no entry for these models (#797, #803).
describe('recent model pricing', () => {
  it.each([
    ['claude-opus-5-5', 4, 20, 0.2, 5, 'claude-opus-5', 5],
    ['claude-sonnet-5-5', 2, 10, 0.2, 2.5, 'claude-sonnet-5', 2],
  ])(
    'prices %s, including the [1m] id Claude Code reports',
    (model, input, output, cacheRead, cacheCreation, predecessor, predecessorInput) => {
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
    'prices %s at base rates and 2x/1.5x above 272K input',
    (model, input, output, cacheRead, longContextTotal) => {
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
});
