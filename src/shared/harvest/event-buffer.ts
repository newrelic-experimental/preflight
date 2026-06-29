import type { NrEventData } from '../events/types.js';

export interface EventBufferOptions {
  readonly maxSize?: number;
}

const DEFAULT_MAX_SIZE = 1000;

/**
 * Bounded in-memory event queue with head-drop overflow.
 *
 * When `add()` is called on a full buffer, the OLDEST event is discarded to
 * make room for the new one. This preserves recency, which matters for
 * observability data feeding alerts and dashboards — a user looking at New
 * Relic during a latency spike wants the last 30 seconds, not a uniform random
 * sample of the last hour. It also matches the head-drop policy used by the
 * scheduler's retry buffers, so callers see consistent behavior across
 * the harvest pipeline.
 *
 * Each drop increments `dropCount`. `HarvestScheduler` drains this counter
 * each harvest tick and emits it as the `nr.ai.dropped_events` self-monitoring
 * metric so the loss is visible in the consumer's own NR dashboards.
 */
export class EventBuffer {
  private readonly maxSize: number;
  private buffer: NrEventData[];
  private totalSeen: number;
  private droppedSinceDrain: number;

  constructor(options?: EventBufferOptions) {
    const maxSize = options?.maxSize ?? DEFAULT_MAX_SIZE;
    // Validate maxSize at construction. Pre-fix, values like
    // 0 / negative / NaN turned the buffer into a silent /dev/null because the
    // overflow comparison `buffer.length >= maxSize` is never true (NaN) or
    // immediately true with no event ever stored (0 / negative). All
    // observability would silently disappear with no diagnostic.
    if (!Number.isInteger(maxSize) || maxSize <= 0) {
      throw new RangeError(
        `EventBuffer: maxSize must be a positive integer, got ${String(maxSize)}`,
      );
    }
    this.maxSize = maxSize;
    this.buffer = [];
    this.totalSeen = 0;
    this.droppedSinceDrain = 0;
  }

  /**
   * Append an event to the buffer.
   *
   * Returns `true` when the event was added without evicting another, and
   * `false` when the buffer was already at `maxSize` and the oldest event
   * was head-dropped to make room. Callers ignoring
   * the return value see the same behavior as before; callers that want
   * backpressure feedback can use it to throttle producers.
   */
  add(event: NrEventData): boolean {
    this.totalSeen++;

    let dropped = false;
    if (this.buffer.length >= this.maxSize) {
      this.buffer.shift();
      this.droppedSinceDrain++;
      dropped = true;
    }
    this.buffer.push(event);
    return !dropped;
  }

  flush(): NrEventData[] {
    const snapshot = this.buffer;
    this.buffer = [];
    // totalSeen is NOT reset here — it is a monotonic lifetime counter drained
    // explicitly via drainAddCount() (same pattern as dropCount / drainDropCount).
    return snapshot;
  }

  /**
   * Return the number of events added since the last call, resetting the
   * counter to 0. Mirrors `drainDropCount()` so callers that need per-flush
   * production rate can use both symmetrically.
   */
  drainAddCount(): number {
    const n = this.totalSeen;
    this.totalSeen = 0;
    return n;
  }

  /**
   * Return the number of events dropped due to overflow since the last call,
   * resetting the counter to 0. Intended to be called once per harvest tick so
   * the count can be surfaced as a self-monitoring metric.
   */
  drainDropCount(): number {
    const n = this.droppedSinceDrain;
    this.droppedSinceDrain = 0;
    return n;
  }

  get size(): number {
    return this.buffer.length;
  }

  /**
   * Total events added since the last `drainAddCount()` call (or since
   * construction if `drainAddCount()` has never been called). Peek-only —
   * does NOT reset. Use `drainAddCount()` to consume and reset, matching
   * the `dropCount` / `drainDropCount()` pattern.
   */
  get totalAdded(): number {
    return this.totalSeen;
  }

  get dropCount(): number {
    return this.droppedSinceDrain;
  }
}
