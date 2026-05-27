import { describe, it, expect } from '@jest/globals';
import { computePercentile } from './percentile.js';

describe('computePercentile', () => {
  it('returns null for empty array', () => {
    expect(computePercentile([], 0.5)).toBeNull();
    expect(computePercentile([], 0.95)).toBeNull();
    expect(computePercentile([], 0.99)).toBeNull();
  });

  it('returns the only element for a single-element array', () => {
    const arr = [42];
    expect(computePercentile(arr, 0.5)).toBe(42);
    expect(computePercentile(arr, 0.95)).toBe(42);
    expect(computePercentile(arr, 0.99)).toBe(42);
  });

  it('returns correct p50/p95/p99 for 100 sorted elements', () => {
    const arr = Array.from({ length: 100 }, (_, i) => i + 1);

    // p50: index = floor((100-1) * 0.5) = floor(49.5) = 49 → arr[49] = 50
    expect(computePercentile(arr, 0.5)).toBe(50);

    // p95: index = floor((100-1) * 0.95) = floor(94.05) = 94 → arr[94] = 95
    expect(computePercentile(arr, 0.95)).toBe(95);

    // p99: index = floor((100-1) * 0.99) = floor(98.01) = 98 → arr[98] = 99
    expect(computePercentile(arr, 0.99)).toBe(99);
  });

  it('returns correct p50 for 99 sorted elements', () => {
    const arr = Array.from({ length: 99 }, (_, i) => i + 1);

    // p50: index = floor((99-1) * 0.5) = floor(49) = 49 → arr[49] = 50
    expect(computePercentile(arr, 0.5)).toBe(50);

    // p95: index = floor((99-1) * 0.95) = floor(93.1) = 93 → arr[93] = 94
    expect(computePercentile(arr, 0.95)).toBe(94);
  });

  it('returns first element when percentile is 0', () => {
    const arr = [10, 20, 30, 40, 50];
    expect(computePercentile(arr, 0)).toBe(10);
  });

  it('returns last element when percentile is 1', () => {
    const arr = [10, 20, 30, 40, 50];
    // index = floor((5-1) * 1) = 4 → arr[4] = 50
    expect(computePercentile(arr, 1)).toBe(50);
  });

  it('handles two-element array correctly', () => {
    const arr = [10, 20];
    // p50: index = floor((2-1) * 0.5) = floor(0.5) = 0 → arr[0] = 10
    expect(computePercentile(arr, 0.5)).toBe(10);

    // p95: index = floor((2-1) * 0.95) = floor(0.95) = 0 → arr[0] = 10
    expect(computePercentile(arr, 0.95)).toBe(10);

    // p99: index = floor((2-1) * 0.99) = floor(0.99) = 0 → arr[0] = 10
    expect(computePercentile(arr, 0.99)).toBe(10);
  });
});
