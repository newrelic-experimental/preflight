import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { calculateCost } from '../shared/index.js';
import { makeUsage } from '../__test-utils__/token-usage.js';
import {
  addCategoryCost,
  categoryCostFromBreakdown,
  maxCategoryCost,
  priceTokenCategories,
  scalePricedBreakdown,
} from './category-cost.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

const MIXED_USAGE = makeUsage({
  inputTokens: 1_000,
  outputTokens: 400,
  thinkingTokens: 10_000,
  cacheReadTokens: 20_000,
  cacheCreationTokens: 2_000,
  totalTokens: 1_400,
});

describe('priceTokenCategories()', () => {
  it('prices each category with the event model, not a blended rate across models', () => {
    const sonnet = priceTokenCategories('claude-sonnet-4', MIXED_USAGE);
    const haiku = priceTokenCategories('claude-haiku-4', MIXED_USAGE);
    const summed = addCategoryCost(sonnet, haiku)!;

    expect(sonnet.inputUsd).toBeGreaterThan(haiku.inputUsd);
    expect(sonnet.outputUsd).toBeGreaterThan(haiku.outputUsd);
    expect(sonnet.cacheReadUsd).toBeGreaterThan(haiku.cacheReadUsd);
    expect(sonnet.cacheCreationUsd).toBeGreaterThan(haiku.cacheCreationUsd);

    // Doubling tokens on the expensive model is what a fake blended (or
    // "just use the bucket's last model") reconstruction would do. The
    // correct bucket total is the sum of each event's own priced dollars.
    const fakeBlend = priceTokenCategories(
      'claude-sonnet-4',
      makeUsage({
        inputTokens: MIXED_USAGE.inputTokens * 2,
        outputTokens: MIXED_USAGE.outputTokens * 2,
        cacheReadTokens: MIXED_USAGE.cacheReadTokens * 2,
        cacheCreationTokens: MIXED_USAGE.cacheCreationTokens * 2,
        totalTokens: MIXED_USAGE.totalTokens * 2,
      }),
    );
    expect(summed.inputUsd).toBeCloseTo(sonnet.inputUsd + haiku.inputUsd, 12);
    expect(summed.inputUsd).not.toBeCloseTo(fakeBlend.inputUsd, 8);
    expect(summed.cacheReadUsd).not.toBeCloseTo(fakeBlend.cacheReadUsd, 8);
  });

  it('prices cache-read far below input at the same token count', () => {
    const usage = makeUsage({
      inputTokens: 10_000,
      cacheReadTokens: 10_000,
      totalTokens: 10_000,
    });
    const cost = priceTokenCategories('claude-sonnet-4', usage);
    // sonnet-4-6: $3/MTok input, $0.30/MTok cache-read — 10× cheaper.
    expect(cost.cacheReadUsd).toBeCloseTo(cost.inputUsd * 0.1, 12);
    expect(cost.cacheReadUsd).toBeLessThan(cost.inputUsd);
  });

  it('splits priced dollars after calculateCost, not before', () => {
    const full = priceTokenCategories('claude-sonnet-4', MIXED_USAGE);
    const half = priceTokenCategories('claude-sonnet-4', MIXED_USAGE, { splitAcross: 2 });
    expect(half.inputUsd).toBeCloseTo(full.inputUsd / 2, 12);
    expect(half.outputUsd).toBeCloseTo(full.outputUsd / 2, 12);
    expect(half.cacheReadUsd).toBeCloseTo(full.cacheReadUsd / 2, 12);
    expect(half.cacheCreationUsd).toBeCloseTo(full.cacheCreationUsd / 2, 12);
  });

  it('applies rateMultiplier to every persisted category', () => {
    const list = priceTokenCategories('claude-sonnet-4', MIXED_USAGE);
    const contracted = priceTokenCategories('claude-sonnet-4', MIXED_USAGE, {
      rateMultiplier: 0.85,
    });
    expect(contracted.inputUsd).toBeCloseTo(list.inputUsd * 0.85, 12);
    expect(contracted.cacheReadUsd).toBeCloseTo(list.cacheReadUsd * 0.85, 12);
  });

  it('omits thinking dollars even when calculateCost priced them', () => {
    const thinkingOnly = makeUsage({ thinkingTokens: 8_000, totalTokens: 8_000 });
    const priced = calculateCost('claude-sonnet-4', thinkingOnly);
    expect(priced.thinkingUsd).toBeGreaterThan(0);
    expect(priced.totalUsd).toBe(priced.thinkingUsd);

    const categories = priceTokenCategories('claude-sonnet-4', thinkingOnly);
    expect(categories).toEqual({
      inputUsd: 0,
      outputUsd: 0,
      cacheReadUsd: 0,
      cacheCreationUsd: 0,
    });
    expect(Object.keys(categories)).not.toContain('thinkingUsd');
  });

  it('returns zeros for an unknown model rather than inventing a rate', () => {
    expect(priceTokenCategories('not-a-real-model', MIXED_USAGE)).toEqual({
      inputUsd: 0,
      outputUsd: 0,
      cacheReadUsd: 0,
      cacheCreationUsd: 0,
    });
  });
});

describe('categoryCostFromBreakdown()', () => {
  it('treats a non-positive split as 1', () => {
    const breakdown = calculateCost('claude-sonnet-4', MIXED_USAGE);
    expect(categoryCostFromBreakdown(breakdown, 0)).toEqual(
      categoryCostFromBreakdown(breakdown, 1),
    );
    expect(categoryCostFromBreakdown(breakdown, -2)).toEqual(
      categoryCostFromBreakdown(breakdown, 1),
    );
  });
});

describe('addCategoryCost() / maxCategoryCost()', () => {
  const a = { inputUsd: 1, outputUsd: 2, cacheReadUsd: 3, cacheCreationUsd: 4 };
  const b = { inputUsd: 10, outputUsd: 0.5, cacheReadUsd: 1, cacheCreationUsd: 8 };

  it('add sums matching fields and treats a missing side as zero', () => {
    expect(addCategoryCost(undefined, undefined)).toBeUndefined();
    expect(addCategoryCost(a, undefined)).toEqual(a);
    expect(addCategoryCost(a, b)).toEqual({
      inputUsd: 11,
      outputUsd: 2.5,
      cacheReadUsd: 4,
      cacheCreationUsd: 12,
    });
  });

  it('max takes a field-wise max and keeps a one-sided cost', () => {
    expect(maxCategoryCost(undefined, undefined)).toBeUndefined();
    expect(maxCategoryCost(undefined, b)).toEqual(b);
    expect(maxCategoryCost(a, b)).toEqual({
      inputUsd: 10,
      outputUsd: 2,
      cacheReadUsd: 3,
      cacheCreationUsd: 8,
    });
  });
});

describe('scalePricedBreakdown()', () => {
  it('returns the same object when the factor is 1', () => {
    const breakdown = calculateCost('claude-sonnet-4', MIXED_USAGE);
    expect(scalePricedBreakdown(breakdown, 1)).toBe(breakdown);
  });
});
