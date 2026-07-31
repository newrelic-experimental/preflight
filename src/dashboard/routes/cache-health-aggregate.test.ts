import { computeCacheHealth } from './cache-health-aggregate.js';

describe('computeCacheHealth', () => {
  it('returns no_cache_activity with a null pct when there are no tokens at all', () => {
    const result = computeCacheHealth({
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      inputTokens: 0,
      savingsUsd: 0,
    });
    expect(result).toEqual({
      status: 'no_cache_activity',
      cacheHitRatePct: null,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      totalSavingsUsd: 0,
    });
  });

  it('returns no_cache_activity when there are input tokens but no cache activity at all', () => {
    // Denominator > 0 but both cache counters are 0 — mirrors
    // CostTracker.computeCacheHitRate's same null-guard.
    const result = computeCacheHealth({
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      inputTokens: 1000,
      savingsUsd: 0,
    });
    expect(result.status).toBe('no_cache_activity');
    expect(result.cacheHitRatePct).toBeNull();
  });

  it('computes hit rate as cacheRead / (input + cacheRead + cacheCreation)', () => {
    const result = computeCacheHealth({
      cacheReadTokens: 700,
      cacheCreationTokens: 100,
      inputTokens: 200,
      savingsUsd: 0.05,
    });
    // 700 / (200 + 700 + 100) = 0.7 -> 70%
    expect(result.cacheHitRatePct).toBe(70);
    expect(result.totalCacheReadTokens).toBe(700);
    expect(result.totalCacheCreationTokens).toBe(100);
    expect(result.totalSavingsUsd).toBe(0.05);
  });

  it('bands >=60% as excellent', () => {
    const result = computeCacheHealth({
      cacheReadTokens: 60,
      cacheCreationTokens: 0,
      inputTokens: 40,
      savingsUsd: 0,
    });
    expect(result.cacheHitRatePct).toBe(60);
    expect(result.status).toBe('excellent');
  });

  it('bands 30%-59% as can_improve', () => {
    const result = computeCacheHealth({
      cacheReadTokens: 30,
      cacheCreationTokens: 0,
      inputTokens: 70,
      savingsUsd: 0,
    });
    expect(result.cacheHitRatePct).toBe(30);
    expect(result.status).toBe('can_improve');
  });

  it('bands below 30% as needs_attention', () => {
    const result = computeCacheHealth({
      cacheReadTokens: 29,
      cacheCreationTokens: 0,
      inputTokens: 71,
      savingsUsd: 0,
    });
    expect(result.cacheHitRatePct).toBe(29);
    expect(result.status).toBe('needs_attention');
  });
});
