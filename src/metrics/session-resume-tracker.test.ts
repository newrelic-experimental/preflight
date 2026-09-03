import { describe, it, expect } from '@jest/globals';
import { SessionResumeTracker } from './session-resume-tracker.js';

describe('SessionResumeTracker', () => {
  it('reports empty state for a new tracker', () => {
    const t = new SessionResumeTracker();
    const m = t.getMetrics();
    expect(m.resumeCount).toBe(0);
    expect(m.totalEstimatedCacheWriteUsd).toBe(0);
    expect(m.lastResume).toBeNull();
  });

  it('records a resume with all fields', () => {
    const t = new SessionResumeTracker();
    t.recordResume({
      secondsSinceLastResponse: 5400,
      contextTokens: 182340,
      promptCacheLikelyExpired: true,
      estimatedCacheWriteUsd: 1.1396,
      timestampMs: 1700000000000,
    });

    const m = t.getMetrics();
    expect(m.resumeCount).toBe(1);
    expect(m.totalEstimatedCacheWriteUsd).toBeCloseTo(1.1396);
    expect(m.lastResume).toEqual({
      timestamp: 1700000000000,
      secondsSinceLastResponse: 5400,
      contextTokens: 182340,
      promptCacheLikelyExpired: true,
      estimatedCacheWriteUsd: 1.1396,
    });
  });

  it('sums estimatedCacheWriteUsd across multiple resumes', () => {
    const t = new SessionResumeTracker();
    t.recordResume({
      secondsSinceLastResponse: 100,
      contextTokens: 1000,
      promptCacheLikelyExpired: false,
      estimatedCacheWriteUsd: 0.05,
    });
    t.recordResume({
      secondsSinceLastResponse: 9000,
      contextTokens: 50000,
      promptCacheLikelyExpired: true,
      estimatedCacheWriteUsd: 0.3,
    });

    const m = t.getMetrics();
    expect(m.resumeCount).toBe(2);
    expect(m.totalEstimatedCacheWriteUsd).toBeCloseTo(0.35);
  });

  it('lastResume reflects only the most recent resume, not an accumulation', () => {
    const t = new SessionResumeTracker();
    t.recordResume({
      secondsSinceLastResponse: 100,
      contextTokens: 1000,
      promptCacheLikelyExpired: false,
      estimatedCacheWriteUsd: 0.05,
    });
    t.recordResume({
      secondsSinceLastResponse: 9000,
      contextTokens: 50000,
      promptCacheLikelyExpired: true,
      estimatedCacheWriteUsd: 0.3,
    });

    const m = t.getMetrics();
    expect(m.lastResume?.secondsSinceLastResponse).toBe(9000);
    expect(m.lastResume?.estimatedCacheWriteUsd).toBe(0.3);
  });

  it('defaults timestamp to Date.now() when timestampMs is omitted', () => {
    const before = Date.now();
    const t = new SessionResumeTracker();
    t.recordResume({
      secondsSinceLastResponse: 100,
      contextTokens: 1000,
      promptCacheLikelyExpired: false,
      estimatedCacheWriteUsd: 0.05,
    });
    const after = Date.now();

    const timestamp = t.getMetrics().lastResume?.timestamp ?? 0;
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });

  it('reset() clears all state', () => {
    const t = new SessionResumeTracker();
    t.recordResume({
      secondsSinceLastResponse: 100,
      contextTokens: 1000,
      promptCacheLikelyExpired: false,
      estimatedCacheWriteUsd: 0.05,
    });
    t.reset('sess-1');

    const m = t.getMetrics();
    expect(m.resumeCount).toBe(0);
    expect(m.totalEstimatedCacheWriteUsd).toBe(0);
    expect(m.lastResume).toBeNull();
  });
});
