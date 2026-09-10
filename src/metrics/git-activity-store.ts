/** Minimum shape any record needs to be stored: a stable dedup id, a
 *  timestamp, and which "workspace" (an opaque grouping key defined by the
 *  caller — this store doesn't know or care what it means) it belongs to. */
export interface KeyedRecord {
  readonly recordId: string;
  readonly timestamp: number;
  readonly workspaceKey: string;
}

export interface ActivityQuery {
  readonly since: number; // epoch ms, inclusive
  readonly until: number; // epoch ms, exclusive
  /** Omit or pass an empty array to match every known key. */
  readonly keys?: readonly string[];
}

/**
 * Generic in-memory activity store, keyed by an opaque workspaceKey.
 *
 * Concurrency note: two different workspaceKeys' records never interact —
 * each key's records live in their own bucket, so nothing about inserting
 * for key A can corrupt or reorder key B's bucket, regardless of call order.
 * This matters because a caller may be feeding records from several
 * concurrent sources (e.g. several git worktrees producing activity "at the
 * same time") — per-key isolation is what makes that safe without a lock.
 */
export class ActivityStore<T extends KeyedRecord> {
  private buckets: Map<string, T[]> = new Map();
  private dedup: Map<string, Set<string>> = new Map();

  /**
   * Insert-or-ignore, keyed on `record.recordId` WITHIN that record's own
   * workspaceKey bucket (the same recordId string appearing under two
   * different workspaceKeys is not a duplicate — that would be a caller
   * bug, but this store doesn't need to detect it, just not misbehave: treat
   * each (workspaceKey, recordId) pair as the true dedup key). Ingesting a
   * record whose (workspaceKey, recordId) pair has already been seen is a
   * silent no-op — same call twice, e.g. from replaying the same session
   * summary at startup twice, or a retried write, must not double-count.
   */
  ingest(record: T): void {
    const key = record.workspaceKey;
    const recordId = record.recordId;

    let dedupSet = this.dedup.get(key);
    if (!dedupSet) {
      dedupSet = new Set();
      this.dedup.set(key, dedupSet);
    }

    if (dedupSet.has(recordId)) {
      return;
    }

    dedupSet.add(recordId);

    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = [];
      this.buckets.set(key, bucket);
    }

    bucket.push(record);
  }

  /**
   * Every stored record whose timestamp falls in [since, until), across the
   * given keys (or every known key if `keys` is omitted/empty), returned
   * SORTED ASCENDING by timestamp regardless of insertion order (insertion
   * order across different workspaceKeys is never meaningful — each key's
   * own records happen to already be insertion-ordered since ingest is
   * append-only per key, but don't rely on that; sort explicitly so this
   * stays correct even if that internal detail ever changes).
   */
  query(opts: ActivityQuery): readonly T[] {
    const { since, until, keys } = opts;
    const keysToQuery = !keys || keys.length === 0 ? Array.from(this.buckets.keys()) : keys;

    const results: T[] = [];

    for (const key of keysToQuery) {
      const bucket = this.buckets.get(key);
      if (!bucket) {
        continue;
      }

      for (const record of bucket) {
        if (record.timestamp >= since && record.timestamp < until) {
          results.push(record);
        }
      }
    }

    results.sort((a, b) => a.timestamp - b.timestamp);
    return results;
  }

  /** Every workspaceKey with at least one record whose timestamp is >= since. */
  knownKeys(since: number): readonly string[] {
    const result: string[] = [];

    for (const [key, bucket] of this.buckets) {
      for (const record of bucket) {
        if (record.timestamp >= since) {
          result.push(key);
          break;
        }
      }
    }

    return result;
  }

  /**
   * Housekeeping only — bounds memory for a long-lived process. Deletes
   * every record with timestamp < cutoffMs, across every key. This is NOT a
   * correctness dependency for any caller: nothing about `query()`'s
   * correctness for an in-range window relies on this having been called at
   * any particular time, unlike a "reset" that a caller might depend on for
   * a number to be right. If a key's bucket becomes empty as a result,
   * remove the empty bucket too (so `knownKeys()` doesn't report a key with
   * zero records).
   */
  evictBefore(cutoffMs: number): void {
    const keysToRemove: string[] = [];

    for (const [key, bucket] of this.buckets) {
      const filteredBucket = bucket.filter((record) => record.timestamp >= cutoffMs);

      if (filteredBucket.length === 0) {
        keysToRemove.push(key);
        continue;
      }

      this.buckets.set(key, filteredBucket);
      // A partial eviction still needs to drop the evicted records' ids from
      // the dedup set — otherwise they leak forever, and evictBefore stops
      // bounding memory for exactly the callers that use it as intended
      // (continuous rolling eviction rather than one final cleanup).
      const survivingIds = new Set(filteredBucket.map((record) => record.recordId));
      this.dedup.set(key, survivingIds);
    }

    for (const key of keysToRemove) {
      this.buckets.delete(key);
      this.dedup.delete(key);
    }
  }
}
