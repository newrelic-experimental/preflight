import type { NrMetric } from '../transport/types.js';
import { createLogger } from '../logger.js';

const logger = createLogger('metric-aggregator');

export interface MetricAccumulator {
  readonly count: number;
  readonly sum: number;
  readonly min: number;
  readonly max: number;
}

/**
 * Allowed attribute value types. Restricted at compile time to the three
 * primitives NR ingest can faithfully round-trip; runtime validation in
 * {@link MetricAggregator.record} enforces the same shape against JS callers
 * that bypass the type system.
 */
export type MetricAttributeValue = string | number | boolean;

/**
 * Snapshot of a single bucket — the full identity (name + attributes) plus
 * the four aggregator values. Returned by {@link MetricAggregator.harvestSnapshots}
 * and accepted by {@link MetricAggregator.merge}, allowing the harvest
 * scheduler to retain pre-explosion form across failed-send retries
 * so that the next harvest's `record()` calls fold into
 * the same bucket instead of producing a second set of data points.
 */
export interface MetricSnapshot extends MetricAccumulator {
  readonly name: string;
  readonly attributes: Record<string, MetricAttributeValue>;
}

// Internal mutable bucket — NOT readonly so the aggregator can accumulate values.
// MetricSnapshot (the exported public shape) is readonly.
interface Bucket {
  name: string;
  attributes: Record<string, MetricAttributeValue>;
  count: number;
  sum: number;
  min: number;
  max: number;
}

function isValidAttributeValue(v: unknown): v is MetricAttributeValue {
  const t = typeof v;
  if (t === 'string' || t === 'boolean') return true;
  if (t === 'number') return Number.isFinite(v);
  return false;
}

/**
 * Encode an attribute value into the bucket key with a one-character type
 * sigil so `5` (number) and `"5"` (string), or `true` (boolean) and `"true"`
 * (string), produce distinct keys instead of silently sharing a bucket.
 */
function encodeAttributeValue(v: MetricAttributeValue): string {
  switch (typeof v) {
    case 'string':
      return `s:${v}`;
    case 'number':
      return `n:${v}`;
    case 'boolean':
      return `b:${v}`;
  }
}

// Escape the separator characters used by makeKey so that a metric
// name containing '|' (or an attribute key containing '=' or '&') cannot
// produce a key string that collides with a different (name, attributes) pair.
// The type-sigil prefix on values ('s:', 'n:', 'b:') already prevents
// value-side collisions, so only name and attribute keys need escaping.
function escapeKeyPart(s: string): string {
  return s.replace(/[|=&]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function makeKey(name: string, attributes: Record<string, MetricAttributeValue>): string {
  const sorted = Object.entries(attributes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return (
    escapeKeyPart(name) +
    '|' +
    sorted.map(([k, v]) => `${escapeKeyPart(k)}=${encodeAttributeValue(v)}`).join('&')
  );
}

export class MetricAggregator {
  private buckets: Map<string, Bucket>;
  /**
   * Number of `record()` calls rejected since the last `drainDropCount()`.
   * Incremented on non-finite values and invalid attribute types.
   * Mirrors the pattern in `EventBuffer.dropCount` so
   * `HarvestScheduler` can emit a `nr.ai.dropped_metrics` self-monitoring
   * gauge each harvest tick — operators currently see only `logger.warn`
   * spam, with no aggregate count of "we silently dropped N samples".
   */
  private droppedCount = 0;

  constructor() {
    this.buckets = new Map();
  }

  /**
   * Record a single sample.
   *
   * Returns `true` when the sample was accepted into a bucket, and `false`
   * when it was rejected (non-finite value or invalid attribute type) per
   * the strict validation contract. The boolean return surface
   * exposes the rejection signal so callers can implement backpressure or
   * surface invalid-input metrics. Existing callers
   * that ignore the return value see unchanged behavior.
   */
  record(
    name: string,
    value: number,
    attributes: Record<string, MetricAttributeValue> = {},
  ): boolean {
    if (!Number.isFinite(value)) {
      logger.warn('MetricAggregator.record: non-finite value ignored', { name, value });
      this.droppedCount++;
      return false;
    }

    // Defense-in-depth: the type signature constrains attributes to
    // string | number | boolean, but JS callers bypass that. Drop the
    // entire sample when any attribute fails validation — silently
    // coercing `null` → `"null"` or `{}` → `"[object Object]"` would
    // produce ambiguous keys that collide with legitimate string values.
    for (const [k, v] of Object.entries(attributes)) {
      if (!isValidAttributeValue(v)) {
        logger.warn('MetricAggregator.record: invalid attribute value — sample dropped', {
          name,
          attribute: k,
          type: typeof v,
        });
        this.droppedCount++;
        return false;
      }
    }

    const key = makeKey(name, attributes);
    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = {
        name,
        // Shallow-clone so caller mutations after record() don't alias bucket state.
        attributes: { ...attributes },
        count: 0,
        sum: 0,
        min: Infinity,
        max: -Infinity,
      };
      this.buckets.set(key, bucket);
    }

    bucket.count++;
    bucket.sum += value;
    bucket.min = Math.min(bucket.min, value);
    bucket.max = Math.max(bucket.max, value);
    return true;
  }

  /**
   * Drain all buckets and return their accumulator snapshots. The aggregator
   * is reset to empty afterwards. Use {@link snapshotsToNrMetrics} to convert
   * to wire form, or {@link merge} on a fresh harvest cycle to fold the
   * snapshots back in if a send failed.
   *
   * Retaining snapshot form across the failed-send
   * boundary is what lets the next harvest produce a single rolled-up
   * data point per name+attrs combination instead of two separate ones
   * with different timestamps.
   */
  harvestSnapshots(): MetricSnapshot[] {
    const drained = this.buckets;
    this.buckets = new Map();
    const snapshots: MetricSnapshot[] = [];
    for (const bucket of drained.values()) {
      snapshots.push({
        name: bucket.name,
        attributes: { ...bucket.attributes }, // snapshot is a value, not a window
        count: bucket.count,
        sum: bucket.sum,
        min: bucket.min,
        max: bucket.max,
      });
    }
    return snapshots;
  }

  /**
   * Fold pre-rolled snapshots back into the aggregator, accumulating into
   * existing buckets when the (name, attributes) key matches. Used on the
   * retry path to merge a failed-send batch with the next harvest interval's
   * data so the result is a single rolled-up data point.
   */
  merge(snapshots: readonly MetricSnapshot[]): void {
    for (const s of snapshots) {
      // Guard against corrupt snapshots (e.g. built manually — the type is
      // exported). A negative count or non-finite sum would permanently corrupt
      // the bucket's accumulators.
      if (
        !Number.isFinite(s.sum) ||
        !Number.isFinite(s.min) ||
        !Number.isFinite(s.max) ||
        !Number.isFinite(s.count) ||
        s.count < 0
      ) {
        continue;
      }
      const key = makeKey(s.name, s.attributes);
      const existing = this.buckets.get(key);
      if (existing) {
        existing.count += s.count;
        existing.sum += s.sum;
        existing.min = Math.min(existing.min, s.min);
        existing.max = Math.max(existing.max, s.max);
      } else {
        this.buckets.set(key, {
          name: s.name,
          attributes: { ...s.attributes }, // defensive clone
          count: s.count,
          sum: s.sum,
          min: s.min,
          max: s.max,
        });
      }
    }
  }

  harvest(intervalMs: number): NrMetric[] {
    return snapshotsToNrMetrics(this.harvestSnapshots(), intervalMs);
  }

  /**
   * Total number of `record()` calls rejected since the last
   * `drainDropCount()` (or aggregator construction). Includes both
   * non-finite-value rejections and invalid-attribute-type rejections.
   * Read-only — call `drainDropCount()` to read and
   * reset atomically.
   */
  get dropCount(): number {
    return this.droppedCount;
  }

  /**
   * Read the current `dropCount` and reset it to zero. Mirrors
   * `EventBuffer.drainDropCount()` so `HarvestScheduler` can emit one
   * `nr.ai.dropped_metrics` gauge per harvest tick without double-counting
   * across cycles. Returns the value before the reset.
   */
  drainDropCount(): number {
    const dropped = this.droppedCount;
    this.droppedCount = 0;
    return dropped;
  }

  /**
   * Number of distinct (name, attributes) buckets currently held in memory.
   *
   * Public so consumers can build self-monitoring metrics on top of the
   * aggregator (e.g. emit `harvest.metric_aggregator.bucket_count` to NR
   * each tick to detect cardinality explosions). Used internally by
   * `metric-aggregator.test.ts` to verify post-`harvest()` state.
   *
   * Not used by `HarvestScheduler` today; surfacing it (rather than dropping
   * the accessor) keeps the surface stable for the
   * self-monitoring work.
   */
  get bucketCount(): number {
    return this.buckets.size;
  }
}

/**
 * Convert each {@link MetricSnapshot} to a single wire-format `NrMetric` of
 * type `'summary'`.
 *
 * Previously this function emitted four separate metrics per snapshot
 * (`{name}.count`, `.sum`, `.min`, `.max`) — three of them as `gauge` (which
 * is semantically wrong for a delta-aggregated value) and one as `count`
 * (without the required `interval.ms` field). The summary type collapses
 * those four into one record carrying `{ count, sum, min, max }` plus the
 * harvest interval, halving payload cardinality and producing correct
 * NR-side aggregate stats.
 *
 * @param intervalMs Harvest interval in ms — appears on the wire as
 *                   `interval.ms` per NR's Metric API contract.
 */
export function snapshotsToNrMetrics(
  snapshots: readonly MetricSnapshot[],
  intervalMs: number,
  timestamp: number = Date.now(),
): NrMetric[] {
  const metrics: NrMetric[] = [];
  for (const s of snapshots) {
    metrics.push({
      type: 'summary',
      name: s.name,
      timestamp,
      intervalMs,
      attributes: s.attributes,
      value: {
        count: s.count,
        sum: s.sum,
        min: s.min,
        max: s.max,
      },
    });
  }
  return metrics;
}
