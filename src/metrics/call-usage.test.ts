import { describe, it, expect } from '@jest/globals';
import { mergeCallUsageMax, mergeCallUsageSum } from './call-usage.js';

describe('mergeCallUsageSum', () => {
  const a = { m: { calls: 2, tokens: 20, estimatedFrom: 'old' }, onlyA: { calls: 1, tokens: 1 } };
  const b = { m: { calls: 3, tokens: 30, estimatedFrom: 'new' }, onlyB: { calls: 4, tokens: 4 } };

  it('adds per model and takes extra fields from the second record', () => {
    expect(
      mergeCallUsageSum<{ calls: number; tokens: number; estimatedFrom?: string }>(a, b),
    ).toEqual({
      m: { calls: 5, tokens: 50, estimatedFrom: 'new' },
      onlyA: { calls: 1, tokens: 1 },
      onlyB: { calls: 4, tokens: 4 },
    });
    expect(
      mergeCallUsageMax<{ calls: number; tokens: number; estimatedFrom?: string }>(a, b)?.m,
    ).toEqual({ calls: 3, tokens: 30, estimatedFrom: 'new' });
  });

  it.each([
    ['both absent', undefined, undefined, undefined],
    ['first absent', undefined, { m: { calls: 1, tokens: 2 } }, { m: { calls: 1, tokens: 2 } }],
    ['second absent', { m: { calls: 1, tokens: 2 } }, undefined, { m: { calls: 1, tokens: 2 } }],
  ])('keeps absence apart from empty: %s', (_, x, y, expected) => {
    expect(mergeCallUsageSum(x, y)).toEqual(expected);
  });
});
