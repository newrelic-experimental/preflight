/**
 * Fixed-capacity FIFO dedup set for one session/agent's own event stream.
 * Extracted out of a single global ring (see DedupRingRegistry) so one
 * scope's dedup keys can never evict another's.
 */
class DedupRing {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];

  constructor(private readonly capacity: number) {}

  /** Returns true if `key` was already seen (and does nothing further); otherwise records it and returns false. */
  hasAndAdd(key: string): boolean {
    if (this.seen.has(key)) return true;
    this.seen.add(key);
    this.order.push(key);
    if (this.order.length > this.capacity) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.seen.delete(evicted);
    }
    return false;
  }
}

/**
 * LRU-bounded registry of per-scope DedupRings, keyed by session/agent id —
 * mirrors ContextTrackerRegistry's eviction pattern (src/metrics/context-tracker.ts).
 * A scope that goes quiet for a while eventually gets evicted entirely, so a
 * burst of short-lived scopes can't grow this registry without bound while a
 * long-lived scope's own ring keeps its full per-scope capacity regardless of
 * how many OTHER scopes are active.
 *
 * Exported (unlike DedupRing) so tests can exercise the maxScopes eviction
 * path directly with a small value — mirroring how ContextTrackerRegistry's
 * own `{ maxSessions }` option is tested — rather than only through
 * HookEventProcessor's fixed production values.
 */
export class DedupRingRegistry {
  private readonly rings = new Map<string, DedupRing>();

  constructor(
    private readonly maxScopes: number,
    private readonly perScopeCapacity: number,
  ) {}

  /** Returns true if `dedupKey` was already seen within `scopeKey`'s own ring. */
  hasAndAdd(scopeKey: string, dedupKey: string): boolean {
    let ring = this.rings.get(scopeKey);
    if (ring) {
      // Move to end for LRU ordering.
      this.rings.delete(scopeKey);
      this.rings.set(scopeKey, ring);
    } else {
      if (this.rings.size >= this.maxScopes) {
        const oldest = this.rings.keys().next().value;
        if (oldest !== undefined) this.rings.delete(oldest);
      }
      ring = new DedupRing(this.perScopeCapacity);
      this.rings.set(scopeKey, ring);
    }
    return ring.hasAndAdd(dedupKey);
  }

  /** Number of scopes currently tracked — test seam for eviction assertions. */
  get scopeCount(): number {
    return this.rings.size;
  }
}
