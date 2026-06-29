import { jest, beforeEach, afterEach } from '@jest/globals';
import { MetricAggregator, snapshotsToNrMetrics } from './metric-aggregator.js';
import type { MetricSnapshot } from './metric-aggregator.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;
beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  stderrSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// 1. record() computes correct count, sum, min, max
// Wire format is now ONE summary metric per bucket
// (with `value: { count, sum, min, max }`) instead of four separate metrics.
// ---------------------------------------------------------------------------
const TEST_INTERVAL_MS = 60_000;

describe('MetricAggregator', () => {
  it('correctly computes count, sum, min, max for same metric', () => {
    const agg = new MetricAggregator();

    agg.record('ai.duration', 10, { model: 'claude' });
    agg.record('ai.duration', 20, { model: 'claude' });
    agg.record('ai.duration', 5, { model: 'claude' });

    const metrics = agg.harvest(TEST_INTERVAL_MS);

    expect(metrics).toHaveLength(1);
    expect(metrics[0].name).toBe('ai.duration');
    expect(metrics[0].type).toBe('summary');
    if (metrics[0].type !== 'summary') throw new Error('type guard');
    expect(metrics[0].value.count).toBe(3);
    expect(metrics[0].value.sum).toBe(35);
    expect(metrics[0].value.min).toBe(5);
    expect(metrics[0].value.max).toBe(20);
  });

  // ---------------------------------------------------------------------------
  // 2. harvest() returns snapshot and resets
  // ---------------------------------------------------------------------------
  it('harvest returns snapshot and resets — second harvest is empty', () => {
    const agg = new MetricAggregator();

    agg.record('ai.tokens', 100);
    agg.record('ai.tokens', 200);

    const first = agg.harvest(TEST_INTERVAL_MS);
    expect(first.length).toBe(1); // ONE summary per bucket

    const second = agg.harvest(TEST_INTERVAL_MS);
    expect(second).toEqual([]);
    expect(agg.bucketCount).toBe(0);

    // New recordings after reset appear only in next harvest
    agg.record('ai.tokens', 50);
    const third = agg.harvest(TEST_INTERVAL_MS);
    expect(third.length).toBe(1);
    if (third[0].type !== 'summary') throw new Error('type guard');
    expect(third[0].value.count).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 3. Different attributes create separate buckets
  // ---------------------------------------------------------------------------
  it('creates separate buckets for different attributes', () => {
    const agg = new MetricAggregator();

    agg.record('ai.duration', 10, { model: 'claude' });
    agg.record('ai.duration', 20, { model: 'gemini' });

    expect(agg.bucketCount).toBe(2);

    const metrics = agg.harvest(TEST_INTERVAL_MS);
    // ONE summary per bucket × 2 buckets = 2 wire metrics
    expect(metrics).toHaveLength(2);

    const claude = metrics.find((m) => m.attributes?.model === 'claude');
    const gemini = metrics.find((m) => m.attributes?.model === 'gemini');
    if (!claude || claude.type !== 'summary') throw new Error('claude bucket missing');
    if (!gemini || gemini.type !== 'summary') throw new Error('gemini bucket missing');

    expect(claude.value.count).toBe(1);
    expect(gemini.value.count).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 4. Empty harvest returns []
  // ---------------------------------------------------------------------------
  it('harvest on empty aggregator returns empty array', () => {
    const agg = new MetricAggregator();
    expect(agg.harvest(TEST_INTERVAL_MS)).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // S-04: non-finite values are rejected
  // ---------------------------------------------------------------------------
  it.each([NaN, Infinity, -Infinity])(
    'ignores non-finite value %p and leaves bucket clean',
    (badValue) => {
      const agg = new MetricAggregator();
      agg.record('ai.duration', 10);
      agg.record('ai.duration', badValue);
      agg.record('ai.duration', 20);

      const metrics = agg.harvest(TEST_INTERVAL_MS);
      expect(metrics).toHaveLength(1);
      if (metrics[0].type !== 'summary') throw new Error('type guard');
      expect(metrics[0].value.sum).toBe(30);
      expect(metrics[0].value.count).toBe(2);
    },
  );

  it('does not create a bucket for a non-finite-only metric', () => {
    const agg = new MetricAggregator();
    agg.record('ai.cost', NaN);
    agg.record('ai.cost', Infinity);
    expect(agg.bucketCount).toBe(0);
    expect(agg.harvest(TEST_INTERVAL_MS)).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // 5. Output metrics carry the harvest interval, valid timestamp, original attrs
  // ---------------------------------------------------------------------------
  it('output summary carries intervalMs, valid timestamp, and original attributes', () => {
    const agg = new MetricAggregator();
    const before = Date.now();

    agg.record('ai.cost', 0.05, { provider: 'anthropic', model: 'sonnet' });

    const metrics = agg.harvest(TEST_INTERVAL_MS);
    const after = Date.now();

    expect(metrics).toHaveLength(1);
    const m = metrics[0];
    expect(m.type).toBe('summary');
    expect(m.name).toBe('ai.cost');
    expect(m.timestamp).toBeGreaterThanOrEqual(before);
    expect(m.timestamp).toBeLessThanOrEqual(after);
    expect(m.attributes).toEqual({ provider: 'anthropic', model: 'sonnet' });
    if (m.type !== 'summary') throw new Error('type guard');
    expect(m.intervalMs).toBe(TEST_INTERVAL_MS);
    expect(m.value).toEqual({ count: 1, sum: 0.05, min: 0.05, max: 0.05 });
  });

  // ---------------------------------------------------------------------------
  // harvestSnapshots() returns pre-explosion bucket form and resets
  // ---------------------------------------------------------------------------
  it('harvestSnapshots() returns one snapshot per (name, attrs) bucket and drains the aggregator', () => {
    const agg = new MetricAggregator();
    agg.record('ai.duration', 10, { model: 'claude' });
    agg.record('ai.duration', 20, { model: 'claude' });
    agg.record('ai.duration', 5, { model: 'gemini' });

    const snapshots = agg.harvestSnapshots();
    expect(snapshots).toHaveLength(2);

    const claude = snapshots.find((s) => s.attributes.model === 'claude')!;
    expect(claude.name).toBe('ai.duration');
    expect(claude.count).toBe(2);
    expect(claude.sum).toBe(30);
    expect(claude.min).toBe(10);
    expect(claude.max).toBe(20);

    const gemini = snapshots.find((s) => s.attributes.model === 'gemini')!;
    expect(gemini.count).toBe(1);
    expect(gemini.sum).toBe(5);

    // Aggregator is drained
    expect(agg.bucketCount).toBe(0);
    expect(agg.harvestSnapshots()).toEqual([]);
  });

  it('caller mutation of attributes after record() does not affect bucket state', () => {
    const agg = new MetricAggregator();
    const tags: Record<string, string> = { region: 'us-east' };
    agg.record('latency', 100, tags);
    tags.region = 'changed'; // mutate after record

    const snapshots = agg.harvestSnapshots();
    expect(snapshots[0].attributes.region).toBe('us-east'); // bucket was cloned
  });

  it('harvestSnapshots() returns snapshots isolated from bucket state', () => {
    const agg = new MetricAggregator();
    agg.record('m', 1, { k: 'v' });
    const snapshots = agg.harvestSnapshots();
    // Mutating snapshot attributes should not affect any future record/merge
    (snapshots[0].attributes as Record<string, string>).k = 'mutated';
    agg.record('m', 2, { k: 'v' }); // same bucket key
    const snapshots2 = agg.harvestSnapshots();
    expect(snapshots2[0].attributes.k).toBe('v');
  });

  // ---------------------------------------------------------------------------
  // merge() folds snapshots back, accumulating same-key buckets
  // ---------------------------------------------------------------------------
  it('merge() accumulates same-key snapshots into a single rolled-up bucket', () => {
    // The retry path: a previous harvest's snapshots are merged back into a
    // fresh aggregator alongside the next interval's data. Same name+attrs
    // entries must collapse into one bucket with summed count/sum and
    // min/max combined — not two parallel data points.
    const agg = new MetricAggregator();
    agg.record('ai.tokens', 100, { model: 'claude' });
    agg.record('ai.tokens', 200, { model: 'claude' });
    const previous = agg.harvestSnapshots();

    // Next interval — record fresh values for the same bucket
    agg.record('ai.tokens', 50, { model: 'claude' });
    agg.record('ai.tokens', 300, { model: 'claude' });

    // Fold the previous failed-send snapshots back in
    agg.merge(previous);

    const rolled = agg.harvestSnapshots();
    expect(rolled).toHaveLength(1);
    const bucket = rolled[0];
    expect(bucket.count).toBe(4);
    expect(bucket.sum).toBe(650);
    expect(bucket.min).toBe(50);
    expect(bucket.max).toBe(300);
  });

  it('merge() inserts a new bucket when the key is not present', () => {
    const agg = new MetricAggregator();
    agg.record('ai.duration', 10, { model: 'claude' });
    const fresh = agg.harvestSnapshots();
    expect(fresh).toHaveLength(1);

    // Second aggregator has no buckets — merge should insert
    const agg2 = new MetricAggregator();
    agg2.merge(fresh);
    expect(agg2.bucketCount).toBe(1);

    const out = agg2.harvestSnapshots();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      name: 'ai.duration',
      count: 1,
      sum: 10,
      min: 10,
      max: 10,
    });
  });

  it('round-trip: harvestSnapshots -> merge into new aggregator -> harvest produces one rolled-up summary', () => {
    // End-to-end contract: a failed-send snapshot list re-merged with
    // the next harvest's data must produce ONE summary per name+attrs — not
    // two timestamped pairs and not four separate metrics.
    const agg = new MetricAggregator();
    agg.record('ai.duration', 10, { model: 'claude' });
    agg.record('ai.duration', 20, { model: 'claude' });
    const failed = agg.harvestSnapshots();

    // Simulate next harvest
    agg.record('ai.duration', 5, { model: 'claude' });
    agg.merge(failed);

    const wire = agg.harvest(TEST_INTERVAL_MS);
    // Exactly one summary metric — one rolled-up bucket
    expect(wire).toHaveLength(1);
    const m = wire[0];
    expect(m.type).toBe('summary');
    expect(m.name).toBe('ai.duration');
    if (m.type !== 'summary') throw new Error('type guard');
    expect(m.value).toEqual({ count: 3, sum: 35, min: 5, max: 20 });
  });

  // ---------------------------------------------------------------------------
  // snapshotsToNrMetrics() emits one summary per snapshot
  // ---------------------------------------------------------------------------
  it('snapshotsToNrMetrics() emits one summary per snapshot with shared timestamp + intervalMs', () => {
    const ts = 1_700_000_000_000;
    const snapshots: MetricSnapshot[] = [
      {
        name: 'ai.duration',
        attributes: { model: 'claude' },
        count: 2,
        sum: 30,
        min: 10,
        max: 20,
      },
    ];

    const wire = snapshotsToNrMetrics(snapshots, TEST_INTERVAL_MS, ts);
    expect(wire).toHaveLength(1);
    const m = wire[0];
    expect(m.timestamp).toBe(ts);
    expect(m.attributes).toEqual({ model: 'claude' });
    expect(m.name).toBe('ai.duration');
    expect(m.type).toBe('summary');
    if (m.type !== 'summary') throw new Error('type guard');
    expect(m.intervalMs).toBe(TEST_INTERVAL_MS);
    expect(m.value).toEqual({ count: 2, sum: 30, min: 10, max: 20 });
  });

  // ---------------------------------------------------------------------------
  // Strict attribute typing: type sigils prevent key collisions, and
  // invalid runtime values are rejected (sample dropped) rather than coerced.
  // ---------------------------------------------------------------------------
  describe('strict attribute validation', () => {
    it('treats number 5 and string "5" as distinct buckets', () => {
      const agg = new MetricAggregator();
      agg.record('ai.duration', 10, { tier: 5 });
      agg.record('ai.duration', 20, { tier: '5' });
      expect(agg.bucketCount).toBe(2);

      const snapshots = agg.harvestSnapshots();
      expect(snapshots).toHaveLength(2);
      const numericTier = snapshots.find((s) => s.attributes.tier === 5)!;
      const stringTier = snapshots.find((s) => s.attributes.tier === '5')!;
      expect(numericTier.sum).toBe(10);
      expect(stringTier.sum).toBe(20);
    });

    it('treats boolean true and string "true" as distinct buckets', () => {
      const agg = new MetricAggregator();
      agg.record('ai.flag', 1, { ok: true });
      agg.record('ai.flag', 2, { ok: 'true' });
      expect(agg.bucketCount).toBe(2);

      const snapshots = agg.harvestSnapshots();
      const boolBucket = snapshots.find((s) => s.attributes.ok === true)!;
      const strBucket = snapshots.find((s) => s.attributes.ok === 'true')!;
      expect(boolBucket.sum).toBe(1);
      expect(strBucket.sum).toBe(2);
    });

    it('accepts boolean attribute values', () => {
      const agg = new MetricAggregator();
      agg.record('ai.duration', 10, { cached: true });
      agg.record('ai.duration', 20, { cached: false });
      expect(agg.bucketCount).toBe(2);

      const snapshots = agg.harvestSnapshots();
      const cached = snapshots.find((s) => s.attributes.cached === true)!;
      const uncached = snapshots.find((s) => s.attributes.cached === false)!;
      expect(cached.sum).toBe(10);
      expect(uncached.sum).toBe(20);
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
      ['object', { nested: 'thing' }],
      ['array', [1, 2, 3]],
      ['function', () => 1],
      ['symbol', Symbol('x')],
      ['NaN', Number.NaN],
      ['Infinity', Infinity],
    ])('drops the entire sample when an attribute value is %s', (_label, badValue) => {
      const agg = new MetricAggregator();
      // Cast through unknown to bypass the compile-time guard — we're
      // simulating a JS caller that sidesteps the type signature.
      agg.record('ai.duration', 100, { weird: badValue as unknown as string });
      expect(agg.bucketCount).toBe(0);
      expect(agg.harvest(TEST_INTERVAL_MS)).toEqual([]);
    });

    it('drops only the offending sample, not subsequent valid ones', () => {
      const agg = new MetricAggregator();
      agg.record('ai.duration', 10, { model: 'claude' });
      agg.record('ai.duration', 999, {
        model: null as unknown as string,
      });
      agg.record('ai.duration', 20, { model: 'claude' });

      const snapshots = agg.harvestSnapshots();
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].sum).toBe(30);
      expect(snapshots[0].count).toBe(2);
    });
  });

  // record() returns boolean for backpressure / validation
  describe('record() return value', () => {
    it('returns true when the sample is accepted', () => {
      const agg = new MetricAggregator();
      expect(agg.record('ai.duration', 10)).toBe(true);
      expect(agg.record('ai.duration', 20, { model: 'claude' })).toBe(true);
      expect(agg.record('ai.flag', 1, { ok: true })).toBe(true);
    });

    it('returns false when the value is non-finite', () => {
      const agg = new MetricAggregator();
      expect(agg.record('ai.duration', NaN)).toBe(false);
      expect(agg.record('ai.duration', Infinity)).toBe(false);
      expect(agg.record('ai.duration', -Infinity)).toBe(false);
    });

    it('returns false when an attribute value is invalid', () => {
      const agg = new MetricAggregator();
      expect(agg.record('ai.duration', 10, { x: null as unknown as string })).toBe(false);
      expect(agg.record('ai.duration', 10, { x: { nested: 1 } as unknown as string })).toBe(false);
      expect(agg.record('ai.duration', 10, { x: [] as unknown as string })).toBe(false);
    });
  });

  // Drop counter mirrors EventBuffer.dropCount
  describe('dropCount', () => {
    it('starts at zero and increments on non-finite values', () => {
      const agg = new MetricAggregator();
      expect(agg.dropCount).toBe(0);

      agg.record('ai.duration', NaN);
      agg.record('ai.duration', Infinity);
      agg.record('ai.duration', -Infinity);

      expect(agg.dropCount).toBe(3);
    });

    it('increments on invalid attribute types', () => {
      const agg = new MetricAggregator();

      agg.record('ai.duration', 10, { x: null as unknown as string });
      agg.record('ai.duration', 10, { x: { nested: 1 } as unknown as string });

      expect(agg.dropCount).toBe(2);
    });

    it('does not increment on accepted samples', () => {
      const agg = new MetricAggregator();

      agg.record('ai.duration', 10);
      agg.record('ai.duration', 20, { model: 'claude' });

      expect(agg.dropCount).toBe(0);
    });

    it('drainDropCount returns current value and resets to zero', () => {
      const agg = new MetricAggregator();
      agg.record('ai.duration', NaN);
      agg.record('ai.duration', NaN);

      expect(agg.drainDropCount()).toBe(2);
      expect(agg.dropCount).toBe(0);
      expect(agg.drainDropCount()).toBe(0);
    });

    it('does not reset across harvest() calls (decoupled from harvest cycle)', () => {
      const agg = new MetricAggregator();
      agg.record('ai.duration', NaN);
      agg.harvest(TEST_INTERVAL_MS);

      // dropCount survives a harvest — only drainDropCount() clears it.
      expect(agg.dropCount).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // merge() validation guard
  // ---------------------------------------------------------------------------
  describe('merge() validation guard', () => {
    it('skips snapshot with negative count', () => {
      const agg = new MetricAggregator();
      agg.merge([{ name: 'x', attributes: {}, count: -1, sum: 10, min: 1, max: 10 }]);
      expect(agg.bucketCount).toBe(0);
    });

    it('skips snapshot with NaN sum', () => {
      const agg = new MetricAggregator();
      agg.merge([{ name: 'x', attributes: {}, count: 1, sum: NaN, min: 1, max: 1 }]);
      expect(agg.bucketCount).toBe(0);
    });

    it('skips snapshot with Infinity min', () => {
      const agg = new MetricAggregator();
      agg.merge([{ name: 'x', attributes: {}, count: 1, sum: 5, min: -Infinity, max: 5 }]);
      expect(agg.bucketCount).toBe(0);
    });

    it('accepts valid snapshot with count: 0 and finite values', () => {
      const agg = new MetricAggregator();
      agg.merge([{ name: 'x', attributes: {}, count: 0, sum: 0, min: 0, max: 0 }]);
      expect(agg.bucketCount).toBe(1);
    });
  });

  // makeKey separator escaping prevents bucket collision
  describe('makeKey separator escaping', () => {
    it('treats metric name containing "|" as distinct from a shorter name with matching attribute', () => {
      // Without escaping: name="a|b" (no attrs) → key "a|b|"
      //                   name="a"  attr {b:1}  → key "a|b=n:1"
      // These are distinct already due to trailing "|", but ensure both land in separate buckets.
      // The real collision risk: name="a" attr {"b=n:1": x} → key "a|b=n:1=s:x"
      //                 vs.     name="a" attr {"b": 1}     → key "a|b=n:1"
      // With escaping, "b=n:1" key becomes "b%3Dn%3A1" so no collision.
      const agg = new MetricAggregator();
      agg.record('a', 10, { 'b=n:1': 'x' }); // adversarial attr key
      agg.record('a', 20, { b: 1 }); // normal numeric attr
      expect(agg.bucketCount).toBe(2); // two separate buckets, not merged
    });

    it('treats metric name containing "|" as a separate bucket from split name+attr', () => {
      const agg = new MetricAggregator();
      agg.record('a|b', 10, {}); // name contains pipe
      agg.record('a', 20, { b: 'x' }); // name "a" + attr "b"
      expect(agg.bucketCount).toBe(2);
    });

    it('still merges genuinely identical (name, attrs) pairs into the same bucket', () => {
      const agg = new MetricAggregator();
      agg.record('my|metric', 5, { 'key=val': 'data&more' });
      agg.record('my|metric', 7, { 'key=val': 'data&more' });
      expect(agg.bucketCount).toBe(1);
      const [snap] = agg.harvestSnapshots();
      expect(snap.count).toBe(2);
      expect(snap.sum).toBe(12);
    });
  });
});
