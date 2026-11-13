import { EventBuffer } from './event-buffer.js';
import type { NrEventData } from '../events/types.js';

function makeEvent(index: number): NrEventData {
  return { eventType: 'Test', index };
}

// ---------------------------------------------------------------------------
// 1. Stores events up to maxSize
// ---------------------------------------------------------------------------
describe('EventBuffer', () => {
  it('stores events up to maxSize', () => {
    const buffer = new EventBuffer({ maxSize: 5 });

    for (let i = 0; i < 5; i++) {
      buffer.add(makeEvent(i));
    }

    expect(buffer.size).toBe(5);
    expect(buffer.totalAdded).toBe(5);
    expect(buffer.dropCount).toBe(0);

    const flushed = buffer.flush();
    expect(flushed).toHaveLength(5);
    expect(flushed.map((e) => e.index)).toEqual([0, 1, 2, 3, 4]);
  });

  // ---------------------------------------------------------------------------
  // 2. Head-drop FIFO — oldest events drop, newest are preserved
  // ---------------------------------------------------------------------------
  it('drops oldest events on overflow (head-drop FIFO)', () => {
    const buffer = new EventBuffer({ maxSize: 3 });

    for (let i = 0; i < 5; i++) {
      buffer.add(makeEvent(i));
    }

    expect(buffer.size).toBe(3);
    expect(buffer.totalAdded).toBe(5);

    const flushed = buffer.flush();
    // Newest 3 are kept; events 0 and 1 were dropped from the head.
    expect(flushed.map((e) => e.index)).toEqual([2, 3, 4]);
  });

  // ---------------------------------------------------------------------------
  // 3. Head-drop preserves order across many overflows
  // ---------------------------------------------------------------------------
  it('preserves recency under sustained overflow', () => {
    const buffer = new EventBuffer({ maxSize: 1000 });

    for (let i = 0; i < 2000; i++) {
      buffer.add(makeEvent(i));
    }

    expect(buffer.size).toBe(1000);
    expect(buffer.totalAdded).toBe(2000);

    const flushed = buffer.flush();
    expect(flushed).toHaveLength(1000);

    // After 2000 inserts into a 1000-slot buffer, we keep events 1000..1999
    // in insertion order. No randomness — this is deterministic.
    expect(flushed.map((e) => e.index)).toEqual(Array.from({ length: 1000 }, (_, i) => i + 1000));
  });

  // ---------------------------------------------------------------------------
  // 4. dropCount tracks overflow drops; drainDropCount resets
  // ---------------------------------------------------------------------------
  it('tracks dropCount and resets on drainDropCount', () => {
    const buffer = new EventBuffer({ maxSize: 2 });

    buffer.add(makeEvent(1));
    buffer.add(makeEvent(2));
    expect(buffer.dropCount).toBe(0);

    // Each add past maxSize drops one event.
    buffer.add(makeEvent(3));
    buffer.add(makeEvent(4));
    buffer.add(makeEvent(5));
    expect(buffer.dropCount).toBe(3);

    const drained = buffer.drainDropCount();
    expect(drained).toBe(3);
    expect(buffer.dropCount).toBe(0);

    // Subsequent overflows accumulate again.
    buffer.add(makeEvent(6));
    expect(buffer.dropCount).toBe(1);
    expect(buffer.drainDropCount()).toBe(1);
    expect(buffer.drainDropCount()).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 5. flush() returns snapshot and resets (does NOT touch dropCount)
  // ---------------------------------------------------------------------------
  it('flush returns snapshot and resets buffer without affecting dropCount', () => {
    const buffer = new EventBuffer({ maxSize: 2 });

    buffer.add(makeEvent(1));
    buffer.add(makeEvent(2));
    buffer.add(makeEvent(3)); // drops event 1
    expect(buffer.dropCount).toBe(1);

    const first = buffer.flush();
    expect(first.map((e) => e.index)).toEqual([2, 3]);
    expect(buffer.size).toBe(0);
    // flush() does NOT reset totalAdded — only drainAddCount() does.
    expect(buffer.totalAdded).toBe(3); // all 3 adds still counted (including drop)
    expect(buffer.dropCount).toBe(1);

    buffer.add(makeEvent(10));
    buffer.add(makeEvent(11));

    const second = buffer.flush();
    expect(second.map((e) => e.index)).toEqual([10, 11]);
  });

  it('drainAddCount() returns and resets totalAdded (mirrors drainDropCount)', () => {
    const buffer = new EventBuffer({ maxSize: 10 });
    buffer.add(makeEvent(1));
    buffer.add(makeEvent(2));
    buffer.add(makeEvent(3));

    expect(buffer.totalAdded).toBe(3); // peek — no reset
    expect(buffer.drainAddCount()).toBe(3); // consume and reset
    expect(buffer.totalAdded).toBe(0); // now zero

    buffer.add(makeEvent(4));
    buffer.flush(); // flush does NOT reset totalAdded
    expect(buffer.totalAdded).toBe(1); // still 1 since last drain
  });

  // ---------------------------------------------------------------------------
  // 6. Empty flush returns []
  // ---------------------------------------------------------------------------
  it('second flush() immediately after first always returns []', () => {
    const buffer = new EventBuffer({ maxSize: 10 });
    buffer.add(makeEvent(1));
    buffer.add(makeEvent(2));
    const first = buffer.flush();
    expect(first).toHaveLength(2);
    const second = buffer.flush(); // buffer is already empty
    expect(second).toEqual([]);
  });

  it('flush on empty buffer returns empty array', () => {
    const buffer = new EventBuffer();
    const result = buffer.flush();
    expect(result).toEqual([]);
    expect(buffer.size).toBe(0);
    expect(buffer.dropCount).toBe(0);
  });

  // Constructor validates maxSize
  describe('constructor maxSize validation', () => {
    it('throws on maxSize: 0 (would silently /dev/null all adds)', () => {
      expect(() => new EventBuffer({ maxSize: 0 })).toThrow(RangeError);
      expect(() => new EventBuffer({ maxSize: 0 })).toThrow(/positive integer/);
    });

    it('throws on negative maxSize', () => {
      expect(() => new EventBuffer({ maxSize: -1 })).toThrow(RangeError);
      expect(() => new EventBuffer({ maxSize: -1000 })).toThrow(RangeError);
    });

    it('throws on NaN maxSize', () => {
      expect(() => new EventBuffer({ maxSize: NaN })).toThrow(RangeError);
    });

    it('throws on Infinity maxSize', () => {
      // Infinity is not a finite integer; reject so callers can't accidentally
      // set up an unbounded buffer through the public options surface.
      expect(() => new EventBuffer({ maxSize: Infinity })).toThrow(RangeError);
    });

    it('throws on fractional maxSize (e.g. 10.5)', () => {
      expect(() => new EventBuffer({ maxSize: 10.5 })).toThrow(RangeError);
    });

    it('accepts maxSize: 1 (smallest valid value)', () => {
      const buffer = new EventBuffer({ maxSize: 1 });
      buffer.add(makeEvent(1));
      buffer.add(makeEvent(2)); // drops event 1
      const flushed = buffer.flush();
      expect(flushed).toHaveLength(1);
      expect(flushed[0].index).toBe(2);
    });

    it('uses default maxSize when options omitted (regression guard)', () => {
      const buffer = new EventBuffer();
      // Default DEFAULT_MAX_SIZE = 1000; no throw means the default branch survived.
      buffer.add(makeEvent(1));
      expect(buffer.size).toBe(1);
    });
  });

  // add() returns boolean for backpressure
  describe('add() return value', () => {
    it('returns true when the event was added without evicting another', () => {
      const buffer = new EventBuffer({ maxSize: 5 });
      expect(buffer.add(makeEvent(1))).toBe(true);
      expect(buffer.add(makeEvent(2))).toBe(true);
      expect(buffer.add(makeEvent(3))).toBe(true);
    });

    it('returns false when an oldest event was head-dropped to make room', () => {
      const buffer = new EventBuffer({ maxSize: 2 });
      expect(buffer.add(makeEvent(1))).toBe(true);
      expect(buffer.add(makeEvent(2))).toBe(true);
      expect(buffer.add(makeEvent(3))).toBe(false); // event 1 evicted
      expect(buffer.add(makeEvent(4))).toBe(false); // event 2 evicted
    });
  });
});
