import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { makeUsage } from '../__test-utils__/token-usage.js';
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
    expect(m.byModel).toEqual({});
  });

  it('tracks a single model correctly', () => {
    const t = new ModelUsageTracker();
    t.recordUsage('claude-haiku-4', makeUsage({ inputTokens: 1000, outputTokens: 500 }), 0.01);
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
    t.recordUsage('claude-haiku-4', makeUsage({ inputTokens: 1000, outputTokens: 500 }), 0.01);
    t.recordUsage('claude-haiku-4', makeUsage({ inputTokens: 2000, outputTokens: 800 }), 0.02);
    const stats = t.getMetrics().byModel['claude-haiku-4'];
    expect(stats?.requestCount).toBe(2);
    expect(stats?.totalInputTokens).toBe(3000);
    expect(stats?.totalOutputTokens).toBe(1300);
    expect(stats?.totalCostUsd).toBeCloseTo(0.03);
  });

  it('computes costPerMillionTokens correctly', () => {
    const t = new ModelUsageTracker();
    t.recordUsage('model-a', makeUsage({ inputTokens: 500_000, outputTokens: 500_000 }), 1.0);
    const stats = t.getMetrics().byModel['model-a'];
    expect(stats?.costPerMillionTokens).toBeCloseTo(1.0);
  });

  it('costPerMillionTokens is null when no tokens are recorded', () => {
    const t = new ModelUsageTracker();
    t.recordUsage('model-a', makeUsage(), 0);
    expect(t.getMetrics().byModel['model-a']?.costPerMillionTokens).toBeNull();
  });

  it('costPerMillionTokens includes cache tokens in the denominator', () => {
    const t = new ModelUsageTracker();
    t.recordUsage(
      'model-a',
      makeUsage({
        inputTokens: 100,
        outputTokens: 100,
        cacheReadTokens: 800,
        cacheCreationTokens: 0,
      }),
      1.0,
    );
    const stats = t.getMetrics().byModel['model-a'];
    expect(stats?.costPerMillionTokens).toBeCloseTo(1000);
  });

  it('avgOutputTokensPerRequest is correct', () => {
    const t = new ModelUsageTracker();
    t.recordUsage('model-a', makeUsage({ outputTokens: 200 }), 0);
    t.recordUsage('model-a', makeUsage({ outputTokens: 400 }), 0);
    expect(t.getMetrics().byModel['model-a']?.avgOutputTokensPerRequest).toBe(300);
  });

  it('mostUsedModel is the model with the highest requestCount', () => {
    const t = new ModelUsageTracker();
    t.recordUsage('claude-haiku-4', makeUsage({ inputTokens: 100, outputTokens: 50 }), 0.001);
    t.recordUsage('claude-sonnet-4', makeUsage({ inputTokens: 100, outputTokens: 50 }), 0.005);
    t.recordUsage('claude-sonnet-4', makeUsage({ inputTokens: 100, outputTokens: 50 }), 0.005);
    expect(t.getMetrics().mostUsedModel).toBe('claude-sonnet-4');
  });

  it('totalModelsUsed counts distinct models', () => {
    const t = new ModelUsageTracker();
    t.recordUsage('model-a', makeUsage({ inputTokens: 100, outputTokens: 50 }), 0.01);
    t.recordUsage('model-b', makeUsage({ inputTokens: 100, outputTokens: 50 }), 0.01);
    t.recordUsage('model-a', makeUsage({ inputTokens: 100, outputTokens: 50 }), 0.01);
    expect(t.getMetrics().totalModelsUsed).toBe(2);
  });

  it('reset clears all state', () => {
    const t = new ModelUsageTracker();
    t.recordUsage('claude-haiku-4', makeUsage({ inputTokens: 1000, outputTokens: 500 }), 0.01);
    t.reset('new-session');
    const m = t.getMetrics();
    expect(m.totalModelsUsed).toBe(0);
    expect(m.mostUsedModel).toBeNull();
    expect(m.byModel).toEqual({});
  });
});

describe('ModelUsageTracker.recordModelSwitch', () => {
  it('reports zero switches for a new tracker', () => {
    const t = new ModelUsageTracker();
    const m = t.getMetrics();
    expect(m.switchCount).toBe(0);
    expect(m.automaticSwitchCount).toBe(0);
    expect(m.recentSwitches).toEqual([]);
  });

  it('records a deliberate switch with all fields', () => {
    const t = new ModelUsageTracker();
    t.recordModelSwitch({
      fromModel: 'claude-sonnet-5',
      toModel: 'claude-opus-5',
      source: 'command',
      requestedModel: 'opus',
      timestampMs: 1700000000000,
    });

    const m = t.getMetrics();
    expect(m.switchCount).toBe(1);
    expect(m.automaticSwitchCount).toBe(0);
    expect(m.recentSwitches).toEqual([
      {
        timestamp: 1700000000000,
        fromModel: 'claude-sonnet-5',
        toModel: 'claude-opus-5',
        source: 'command',
        requestedModel: 'opus',
      },
    ]);
  });

  it('counts source: "auto" switches separately as automaticSwitchCount', () => {
    const t = new ModelUsageTracker();
    t.recordModelSwitch({ fromModel: 'a', toModel: 'b', source: 'command' });
    t.recordModelSwitch({ fromModel: 'b', toModel: 'a', source: 'auto' });
    t.recordModelSwitch({ fromModel: 'a', toModel: 'c', source: 'resume' });

    const m = t.getMetrics();
    expect(m.switchCount).toBe(3);
    expect(m.automaticSwitchCount).toBe(1);
  });

  it('defaults source to "unknown" and requestedModel to null when absent', () => {
    const t = new ModelUsageTracker();
    t.recordModelSwitch({ fromModel: 'claude-sonnet-5', toModel: 'claude-opus-5' });

    const [event] = t.getMetrics().recentSwitches;
    expect(event?.source).toBe('unknown');
    expect(event?.requestedModel).toBeNull();
  });

  it('bounds recentSwitches to the most recent 100, dropping the oldest', () => {
    const t = new ModelUsageTracker();
    for (let i = 0; i < 105; i++) {
      t.recordModelSwitch({ fromModel: `model-${i}`, toModel: `model-${i + 1}` });
    }

    const m = t.getMetrics();
    expect(m.switchCount).toBe(100);
    expect(m.recentSwitches).toHaveLength(100);
    expect(m.recentSwitches[0]?.fromModel).toBe('model-5');
    expect(m.recentSwitches[99]?.fromModel).toBe('model-104');
  });

  it('reset() clears switch history', () => {
    const t = new ModelUsageTracker();
    t.recordModelSwitch({ fromModel: 'a', toModel: 'b' });
    t.reset('sess-1');

    const m = t.getMetrics();
    expect(m.switchCount).toBe(0);
    expect(m.recentSwitches).toEqual([]);
  });
});

describe('ModelUsageTracker.getRawBreakdown', () => {
  it('returns raw counters with no derived fields for a new tracker', () => {
    const t = new ModelUsageTracker();
    expect(t.getRawBreakdown()).toEqual({});
  });

  it('returns raw counters matching what was recorded, without derived ratios', () => {
    const t = new ModelUsageTracker();
    t.recordUsage('model-a', makeUsage({ inputTokens: 1000, outputTokens: 500 }), 0.01);
    expect(t.getRawBreakdown()).toEqual({
      'model-a': {
        requestCount: 1,
        totalInputTokens: 1000,
        totalOutputTokens: 500,
        totalCostUsd: 0.01,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        totalThinkingTokens: 0,
      },
    });
  });

  it('accumulates across multiple recordUsage calls for the same model', () => {
    const t = new ModelUsageTracker();
    t.recordUsage('model-a', makeUsage({ inputTokens: 1000, outputTokens: 500 }), 0.01);
    t.recordUsage('model-a', makeUsage({ inputTokens: 2000, outputTokens: 800 }), 0.02);
    expect(t.getRawBreakdown()['model-a']).toEqual({
      requestCount: 2,
      totalInputTokens: 3000,
      totalOutputTokens: 1300,
      totalCostUsd: 0.03,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      totalThinkingTokens: 0,
    });
  });
});

describe('ModelUsageTracker.combineBreakdowns', () => {
  it('returns empty metrics for an empty array', () => {
    const t = new ModelUsageTracker();
    const combined = t.combineBreakdowns([]);
    expect(combined).toEqual({
      byModel: {},
      mostUsedModel: null,
      totalModelsUsed: 0,
      switchCount: 0,
      automaticSwitchCount: 0,
      recentSwitches: [],
    });
  });

  it('sums raw counters across breakdowns before deriving ratios, rather than averaging per-source ratios', () => {
    const t = new ModelUsageTracker();
    // Source A alone: $1 / 100 output tokens = $0.01/token.
    const sourceA = {
      'model-a': {
        requestCount: 1,
        totalInputTokens: 0,
        totalOutputTokens: 100,
        totalCostUsd: 1,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        totalThinkingTokens: 0,
      },
    };
    // Source B alone: $1 / 900 output tokens ≈ $0.00111/token.
    const sourceB = {
      'model-a': {
        requestCount: 9,
        totalInputTokens: 0,
        totalOutputTokens: 900,
        totalCostUsd: 1,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        totalThinkingTokens: 0,
      },
    };
    const combined = t.combineBreakdowns([sourceA, sourceB]);
    // Correct: sum first ($2 / 1000 tokens = $0.002/token). A naive average of
    // the two per-source ratios ($0.01 and ~$0.00111) would give ~$0.0056/token,
    // which is wrong — it treats both sources as equally weighted regardless
    // of how much volume each actually contributed.
    expect(combined.byModel['model-a']?.requestCount).toBe(10);
    expect(combined.byModel['model-a']?.totalOutputTokens).toBe(1000);
    expect(combined.byModel['model-a']?.totalCostUsd).toBeCloseTo(2);
    expect(combined.byModel['model-a']?.costPerMillionTokens).toBeCloseTo(2000);
  });

  it('sums distinct models independently', () => {
    const t = new ModelUsageTracker();
    const a = {
      'model-a': {
        requestCount: 1,
        totalInputTokens: 10,
        totalOutputTokens: 10,
        totalCostUsd: 0.1,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        totalThinkingTokens: 0,
      },
    };
    const b = {
      'model-b': {
        requestCount: 2,
        totalInputTokens: 20,
        totalOutputTokens: 20,
        totalCostUsd: 0.2,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        totalThinkingTokens: 0,
      },
    };
    const combined = t.combineBreakdowns([a, b]);
    expect(combined.totalModelsUsed).toBe(2);
    expect(combined.byModel['model-a']?.requestCount).toBe(1);
    expect(combined.byModel['model-b']?.requestCount).toBe(2);
  });

  it('recomputes mostUsedModel from the combined totals', () => {
    const t = new ModelUsageTracker();
    const a = {
      cheap: {
        requestCount: 1,
        totalInputTokens: 0,
        totalOutputTokens: 100,
        totalCostUsd: 0.05,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        totalThinkingTokens: 0,
      },
    };
    const b = {
      cheap: {
        requestCount: 5,
        totalInputTokens: 0,
        totalOutputTokens: 500,
        totalCostUsd: 0.25,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        totalThinkingTokens: 0,
      },
    };
    const c = {
      pricey: {
        requestCount: 1,
        totalInputTokens: 0,
        totalOutputTokens: 100,
        totalCostUsd: 1,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        totalThinkingTokens: 0,
      },
    };
    const combined = t.combineBreakdowns([a, b, c]);
    expect(combined.mostUsedModel).toBe('cheap');
  });

  it('is consistent with getMetrics() when combining a single source equal to this tracker own raw breakdown', () => {
    const t = new ModelUsageTracker();
    t.recordUsage('model-a', makeUsage({ inputTokens: 1000, outputTokens: 500 }), 0.01);
    t.recordUsage('model-b', makeUsage({ inputTokens: 2000, outputTokens: 800 }), 0.02);
    expect(t.combineBreakdowns([t.getRawBreakdown()])).toEqual(t.getMetrics());
  });
});

describe('ModelUsageTracker.seedFromPersisted', () => {
  it('adds a persisted breakdown into an empty tracker', () => {
    const t = new ModelUsageTracker();
    t.seedFromPersisted({
      'claude-sonnet-5': {
        requestCount: 12,
        totalInputTokens: 502,
        totalOutputTokens: 6642,
        totalCostUsd: 3.0984488,
        totalCacheReadTokens: 100,
        totalCacheCreationTokens: 50,
        totalThinkingTokens: 0,
      },
    });

    const raw = t.getRawBreakdown();
    expect(raw['claude-sonnet-5']).toEqual({
      requestCount: 12,
      totalInputTokens: 502,
      totalOutputTokens: 6642,
      totalCostUsd: 3.0984488,
      totalCacheReadTokens: 100,
      totalCacheCreationTokens: 50,
      totalThinkingTokens: 0,
    });
  });

  it('adds on top of usage already recorded by this process, rather than overwriting', () => {
    const t = new ModelUsageTracker();
    t.recordUsage('claude-sonnet-5', makeUsage({ inputTokens: 100, outputTokens: 50 }), 0.01);

    t.seedFromPersisted({
      'claude-sonnet-5': {
        requestCount: 12,
        totalInputTokens: 502,
        totalOutputTokens: 6642,
        totalCostUsd: 3.0984488,
        totalCacheReadTokens: 100,
        totalCacheCreationTokens: 50,
        totalThinkingTokens: 0,
      },
    });

    const raw = t.getRawBreakdown();
    expect(raw['claude-sonnet-5']?.requestCount).toBe(13);
    expect(raw['claude-sonnet-5']?.totalInputTokens).toBe(602);
    expect(raw['claude-sonnet-5']?.totalOutputTokens).toBe(6692);
    expect(raw['claude-sonnet-5']?.totalCostUsd).toBeCloseTo(3.1084488, 6);
  });

  it('merges a model already partially recorded and adds a new model not yet seen', () => {
    const t = new ModelUsageTracker();
    t.recordUsage('claude-sonnet-5', makeUsage({ inputTokens: 100, outputTokens: 50 }), 0.01);

    t.seedFromPersisted({
      'claude-sonnet-5': {
        requestCount: 1,
        totalInputTokens: 200,
        totalOutputTokens: 100,
        totalCostUsd: 0.02,
        totalCacheReadTokens: 10,
        totalCacheCreationTokens: 5,
        totalThinkingTokens: 0,
      },
      'claude-opus-5': {
        requestCount: 5,
        totalInputTokens: 1000,
        totalOutputTokens: 500,
        totalCostUsd: 0.5,
        totalCacheReadTokens: 50,
        totalCacheCreationTokens: 20,
        totalThinkingTokens: 0,
      },
    });

    const raw = t.getRawBreakdown();
    expect(raw['claude-sonnet-5']).toEqual({
      requestCount: 2,
      totalInputTokens: 300,
      totalOutputTokens: 150,
      totalCostUsd: 0.03,
      totalCacheReadTokens: 10,
      totalCacheCreationTokens: 5,
      totalThinkingTokens: 0,
    });
    expect(raw['claude-opus-5']).toEqual({
      requestCount: 5,
      totalInputTokens: 1000,
      totalOutputTokens: 500,
      totalCostUsd: 0.5,
      totalCacheReadTokens: 50,
      totalCacheCreationTokens: 20,
      totalThinkingTokens: 0,
    });
  });

  it('is a no-op for an empty breakdown (no persisted session found)', () => {
    const t = new ModelUsageTracker();
    t.seedFromPersisted({});
    expect(t.getRawBreakdown()).toEqual({});
  });
});
