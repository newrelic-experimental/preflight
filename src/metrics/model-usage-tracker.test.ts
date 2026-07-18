import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ModelUsageTracker } from './model-usage-tracker.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

describe('ModelUsageTracker', () => {
  it('returns empty state for new tracker', () => {
    const t = new ModelUsageTracker();
    const m = t.getMetrics();
    expect(m.totalModelsUsed).toBe(0);
    expect(m.mostUsedModel).toBeNull();
    expect(m.mostEfficientModel).toBeNull();
    expect(m.byModel).toEqual({});
  });

  it('tracks a single model correctly', () => {
    const t = new ModelUsageTracker();
    t.recordUsage('claude-haiku-4', 1000, 500, 0.01);
    const m = t.getMetrics();
    expect(m.totalModelsUsed).toBe(1);
    expect(m.mostUsedModel).toBe('claude-haiku-4');
    expect(m.byModel['claude-haiku-4']?.requestCount).toBe(1);
    expect(m.byModel['claude-haiku-4']?.totalInputTokens).toBe(1000);
    expect(m.byModel['claude-haiku-4']?.totalOutputTokens).toBe(500);
    expect(m.byModel['claude-haiku-4']?.totalCostUsd).toBeCloseTo(0.01);
  });

  it('accumulates multiple calls to the same model', () => {
    const t = new ModelUsageTracker();
    t.recordUsage('claude-haiku-4', 1000, 500, 0.01);
    t.recordUsage('claude-haiku-4', 2000, 800, 0.02);
    const stats = t.getMetrics().byModel['claude-haiku-4'];
    expect(stats?.requestCount).toBe(2);
    expect(stats?.totalInputTokens).toBe(3000);
    expect(stats?.totalOutputTokens).toBe(1300);
    expect(stats?.totalCostUsd).toBeCloseTo(0.03);
  });

  it('computes costPerOutputToken correctly', () => {
    const t = new ModelUsageTracker();
    t.recordUsage('model-a', 0, 1000, 0.01);
    const stats = t.getMetrics().byModel['model-a'];
    expect(stats?.costPerOutputToken).toBeCloseTo(0.00001);
  });

  it('costPerOutputToken is null when output tokens are zero', () => {
    const t = new ModelUsageTracker();
    t.recordUsage('model-a', 100, 0, 0.001);
    expect(t.getMetrics().byModel['model-a']?.costPerOutputToken).toBeNull();
  });

  it('computes costPerMillionTokens correctly', () => {
    const t = new ModelUsageTracker();
    t.recordUsage('model-a', 500_000, 500_000, 1.0);
    const stats = t.getMetrics().byModel['model-a'];
    expect(stats?.costPerMillionTokens).toBeCloseTo(1.0);
  });

  it('costPerMillionTokens is null when no tokens are recorded', () => {
    const t = new ModelUsageTracker();
    t.recordUsage('model-a', 0, 0, 0);
    expect(t.getMetrics().byModel['model-a']?.costPerMillionTokens).toBeNull();
  });

  it('avgOutputTokensPerRequest is correct', () => {
    const t = new ModelUsageTracker();
    t.recordUsage('model-a', 0, 200, 0);
    t.recordUsage('model-a', 0, 400, 0);
    expect(t.getMetrics().byModel['model-a']?.avgOutputTokensPerRequest).toBe(300);
  });

  it('mostUsedModel is the model with the highest requestCount', () => {
    const t = new ModelUsageTracker();
    t.recordUsage('claude-haiku-4', 100, 50, 0.001);
    t.recordUsage('claude-sonnet-4', 100, 50, 0.005);
    t.recordUsage('claude-sonnet-4', 100, 50, 0.005);
    expect(t.getMetrics().mostUsedModel).toBe('claude-sonnet-4');
  });

  it('mostEfficientModel has the lowest costPerOutputToken', () => {
    const t = new ModelUsageTracker();
    t.recordUsage('expensive-model', 0, 100, 1.0);
    t.recordUsage('cheap-model', 0, 100, 0.1);
    expect(t.getMetrics().mostEfficientModel).toBe('cheap-model');
  });

  it('mostEfficientModel breaks a costPerOutputToken tie alphabetically', () => {
    const t = new ModelUsageTracker();
    t.recordUsage('model-b', 0, 100, 0.1);
    t.recordUsage('model-a', 0, 100, 0.1);
    expect(t.getMetrics().mostEfficientModel).toBe('model-a');
  });

  it('totalModelsUsed counts distinct models', () => {
    const t = new ModelUsageTracker();
    t.recordUsage('model-a', 100, 50, 0.01);
    t.recordUsage('model-b', 100, 50, 0.01);
    t.recordUsage('model-a', 100, 50, 0.01);
    expect(t.getMetrics().totalModelsUsed).toBe(2);
  });

  it('reset clears all state', () => {
    const t = new ModelUsageTracker();
    t.recordUsage('claude-haiku-4', 1000, 500, 0.01);
    t.reset('new-session');
    const m = t.getMetrics();
    expect(m.totalModelsUsed).toBe(0);
    expect(m.mostUsedModel).toBeNull();
    expect(m.byModel).toEqual({});
  });
});
