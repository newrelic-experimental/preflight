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

    const flushed = buffer.flush();
    expect(flushed).toHaveLength(5);
    expect(flushed.map((e) => e.index)).toEqual([0, 1, 2, 3, 4]);
  });

  // ---------------------------------------------------------------------------
  // 2. Reservoir sampling — 2000 events into buffer of 1000
  // ---------------------------------------------------------------------------
  it('reservoir samples uniformly when buffer overflows', () => {
    const buffer = new EventBuffer({ maxSize: 1000 });

    for (let i = 0; i < 2000; i++) {
      buffer.add(makeEvent(i));
    }

    expect(buffer.size).toBe(1000);
    expect(buffer.totalAdded).toBe(2000);

    const flushed = buffer.flush();
    expect(flushed).toHaveLength(1000);

    // Check rough uniformity: partition source indices into 4 quartiles
    // Each quartile should have ~250 events (tolerance: 150–350)
    const quartiles = [0, 0, 0, 0];
    for (const event of flushed) {
      const idx = event.index as number;
      if (idx < 500) quartiles[0]++;
      else if (idx < 1000) quartiles[1]++;
      else if (idx < 1500) quartiles[2]++;
      else quartiles[3]++;
    }

    for (let q = 0; q < 4; q++) {
      expect(quartiles[q]).toBeGreaterThanOrEqual(150);
      expect(quartiles[q]).toBeLessThanOrEqual(350);
    }
  });

  // ---------------------------------------------------------------------------
  // 3. flush() returns snapshot and resets
  // ---------------------------------------------------------------------------
  it('flush returns snapshot and resets buffer', () => {
    const buffer = new EventBuffer({ maxSize: 100 });

    buffer.add(makeEvent(1));
    buffer.add(makeEvent(2));
    buffer.add(makeEvent(3));

    const first = buffer.flush();
    expect(first).toHaveLength(3);
    expect(buffer.size).toBe(0);
    expect(buffer.totalAdded).toBe(0);

    buffer.add(makeEvent(10));
    buffer.add(makeEvent(11));

    const second = buffer.flush();
    expect(second).toHaveLength(2);
    expect(second.map((e) => e.index)).toEqual([10, 11]);
  });

  // ---------------------------------------------------------------------------
  // 4. Empty flush returns []
  // ---------------------------------------------------------------------------
  it('flush on empty buffer returns empty array', () => {
    const buffer = new EventBuffer();
    const result = buffer.flush();
    expect(result).toEqual([]);
    expect(buffer.size).toBe(0);
  });
});
