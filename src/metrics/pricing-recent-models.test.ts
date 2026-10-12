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

  it('counts cache reads toward the 272K tier of a GPT-6 request', () => {
    // 100K uncached + 200K cache read is a 300K prompt, past the 272K tier even
    // though fresh input alone is not.
    const usage = (cacheReadTokens: number) => ({
      inputTokens: 100_000,
      outputTokens: 0,
      thinkingTokens: 0,
      cacheReadTokens,
      cacheCreationTokens: 0,
      totalTokens: 100_000 + cacheReadTokens,
    });
    // gpt-6-sol: input $2 / cache read $0.20; tier 2x input, 2x cache read.
    expect(calculateCost('gpt-6-sol', usage(100_000)).totalUsd).toBeCloseTo(0.1 * 2 + 0.1 * 0.2, 6);
    expect(calculateCost('gpt-6-sol', usage(200_000)).totalUsd).toBeCloseTo(0.1 * 4 + 0.2 * 0.4, 6);
  });

  it('bills a cache-heavy claude-haiku-5-5 request over 100K at the long-context rates', () => {
    const usage = (cacheReadTokens: number) => ({
      inputTokens: 10_000,
      outputTokens: 1_000_000,
      thinkingTokens: 0,
      cacheReadTokens,
      cacheCreationTokens: 0,
      totalTokens: 10_000 + 1_000_000 + cacheReadTokens,
    });
    // 90K prompt: base rates. 110K prompt: 5x tier rates.
    expect(calculateCost('claude-haiku-5-5', usage(80_000)).totalUsd).toBeCloseTo(
      0.01 * 0.1 + 0.5 + 0.08 * 0.01,
      6,
    );
    expect(calculateCost('claude-haiku-5-5', usage(100_000)).totalUsd).toBeCloseTo(
      0.01 * 0.5 + 2.5 + 0.1 * 0.05,
      6,
    );
  });
});
