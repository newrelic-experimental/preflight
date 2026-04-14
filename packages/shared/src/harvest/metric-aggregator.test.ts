import { MetricAggregator } from './metric-aggregator.js';

// ---------------------------------------------------------------------------
// 1. record() computes correct count, sum, min, max
// ---------------------------------------------------------------------------
describe('MetricAggregator', () => {
  it('correctly computes count, sum, min, max for same metric', () => {
    const agg = new MetricAggregator();

    agg.record('ai.duration', 10, { model: 'claude' });
    agg.record('ai.duration', 20, { model: 'claude' });
    agg.record('ai.duration', 5, { model: 'claude' });

    const metrics = agg.harvest();

    const findMetric = (suffix: string) =>
      metrics.find((m) => m.name === `ai.duration.${suffix}`);

    expect(findMetric('count')!.value).toBe(3);
    expect(findMetric('sum')!.value).toBe(35);
    expect(findMetric('min')!.value).toBe(5);
    expect(findMetric('max')!.value).toBe(20);
  });

  // ---------------------------------------------------------------------------
  // 2. harvest() returns snapshot and resets
  // ---------------------------------------------------------------------------
  it('harvest returns snapshot and resets — second harvest is empty', () => {
    const agg = new MetricAggregator();

    agg.record('ai.tokens', 100);
    agg.record('ai.tokens', 200);

    const first = agg.harvest();
    expect(first.length).toBe(4); // count, sum, min, max

    const second = agg.harvest();
    expect(second).toEqual([]);
    expect(agg.bucketCount).toBe(0);

    // New recordings after reset appear only in next harvest
    agg.record('ai.tokens', 50);
    const third = agg.harvest();
    expect(third.length).toBe(4);

    const count = third.find((m) => m.name === 'ai.tokens.count');
    expect(count!.value).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 3. Different attributes create separate buckets
  // ---------------------------------------------------------------------------
  it('creates separate buckets for different attributes', () => {
    const agg = new MetricAggregator();

    agg.record('ai.duration', 10, { model: 'claude' });
    agg.record('ai.duration', 20, { model: 'gemini' });

    expect(agg.bucketCount).toBe(2);

    const metrics = agg.harvest();
    // 4 metrics per bucket × 2 buckets = 8
    expect(metrics).toHaveLength(8);

    const claudeCount = metrics.find(
      (m) => m.name === 'ai.duration.count' && m.attributes?.model === 'claude',
    );
    const geminiCount = metrics.find(
      (m) => m.name === 'ai.duration.count' && m.attributes?.model === 'gemini',
    );

    expect(claudeCount!.value).toBe(1);
    expect(geminiCount!.value).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 4. Empty harvest returns []
  // ---------------------------------------------------------------------------
  it('harvest on empty aggregator returns empty array', () => {
    const agg = new MetricAggregator();
    expect(agg.harvest()).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // 5. Output metrics have correct type, timestamp, and attributes
  // ---------------------------------------------------------------------------
  it('output metrics have type gauge, valid timestamp, and original attributes', () => {
    const agg = new MetricAggregator();
    const before = Date.now();

    agg.record('ai.cost', 0.05, { provider: 'anthropic', model: 'sonnet' });

    const metrics = agg.harvest();
    const after = Date.now();

    expect(metrics).toHaveLength(4);
    for (const m of metrics) {
      expect(m.type).toBe('gauge');
      expect(m.timestamp).toBeGreaterThanOrEqual(before);
      expect(m.timestamp).toBeLessThanOrEqual(after);
      expect(m.attributes).toEqual({ provider: 'anthropic', model: 'sonnet' });
    }
  });
});
