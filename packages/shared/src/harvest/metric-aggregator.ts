import type { NrMetric } from '../transport/types.js';

export interface MetricAccumulator {
  count: number;
  sum: number;
  min: number;
  max: number;
}

interface Bucket extends MetricAccumulator {
  name: string;
  attributes: Record<string, string | number>;
}

function makeKey(name: string, attributes: Record<string, string | number>): string {
  const sorted = Object.entries(attributes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return name + '|' + sorted.map(([k, v]) => `${k}=${v}`).join('&');
}

export class MetricAggregator {
  private buckets: Map<string, Bucket>;

  constructor() {
    this.buckets = new Map();
  }

  record(name: string, value: number, attributes: Record<string, string | number> = {}): void {
    const key = makeKey(name, attributes);
    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = {
        name,
        attributes,
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
  }

  harvest(): NrMetric[] {
    const snapshot = this.buckets;
    this.buckets = new Map();

    const metrics: NrMetric[] = [];
    const timestamp = Date.now();

    for (const bucket of snapshot.values()) {
      const baseAttrs = { timestamp, attributes: bucket.attributes };

      metrics.push({ ...baseAttrs, type: 'count', name: `${bucket.name}.count`, value: bucket.count });
      metrics.push({ ...baseAttrs, type: 'gauge', name: `${bucket.name}.sum`, value: bucket.sum });
      metrics.push({ ...baseAttrs, type: 'gauge', name: `${bucket.name}.min`, value: bucket.min });
      metrics.push({ ...baseAttrs, type: 'gauge', name: `${bucket.name}.max`, value: bucket.max });
    }

    return metrics;
  }

  get bucketCount(): number {
    return this.buckets.size;
  }
}
