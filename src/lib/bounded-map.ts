export interface BoundedMapOptions {
  /** Hard cap on entries; inserting past it evicts the least-recently-used entry. */
  readonly maxEntries: number;
  /**
   * Optional idle expiry: an entry not set or read (via `get`) for this long is
   * dropped. Omit to bound by size only.
   */
  readonly ttlMs?: number;
  /** Clock override for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

interface Entry<V> {
  readonly value: V;
  readonly touchedAt: number;
}

/**
 * A size-capped LRU map with optional idle expiry, for lookup tables that a
 * long-running process fills for its whole lifetime and would otherwise never
 * shrink. Insertion order of the backing `Map` doubles as recency order
 * (`set`/`get` move the key to the end), so the least-recently-used entry is
 * always first and both eviction and the expiry sweep only ever look at the
 * front.
 */
export class BoundedMap<K, V> {
  private readonly entries = new Map<K, Entry<V>>();
  private readonly maxEntries: number;
  private readonly ttlMs: number | undefined;
  private readonly now: () => number;

  constructor(options: BoundedMapOptions) {
    if (!Number.isInteger(options.maxEntries) || options.maxEntries < 1) {
      throw new RangeError(`maxEntries must be a positive integer, got ${options.maxEntries}`);
    }
    if (options.ttlMs !== undefined && !(options.ttlMs > 0)) {
      throw new RangeError(`ttlMs must be positive, got ${options.ttlMs}`);
    }
    this.maxEntries = options.maxEntries;
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Returns the value and marks the entry as recently used; `undefined` if absent or expired. */
  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    const now = this.now();
    this.entries.delete(key);
    if (this.isExpired(entry, now)) return undefined;
    this.entries.set(key, { value: entry.value, touchedAt: now });
    return entry.value;
  }

  /** Presence check that does not count as a use. */
  has(key: K): boolean {
    const entry = this.entries.get(key);
    return entry !== undefined && !this.isExpired(entry, this.now());
  }

  set(key: K, value: V): this {
    const now = this.now();
    this.entries.delete(key);
    this.sweepExpired(now);
    this.entries.set(key, { value, touchedAt: now });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
    return this;
  }

  delete(key: K): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  private isExpired(entry: Entry<V>, now: number): boolean {
    return this.ttlMs !== undefined && now - entry.touchedAt >= this.ttlMs;
  }

  private sweepExpired(now: number): void {
    if (this.ttlMs === undefined) return;
    for (const [key, entry] of this.entries) {
      if (!this.isExpired(entry, now)) break;
      this.entries.delete(key);
    }
  }
}
