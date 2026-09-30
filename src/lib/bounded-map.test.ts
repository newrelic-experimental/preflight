import { describe, it, expect } from '@jest/globals';
import { BoundedMap } from './bounded-map.js';

function makeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('BoundedMap', () => {
  it('stores and returns values like a Map', () => {
    const map = new BoundedMap<string, string>({ maxEntries: 10 });
    map.set('a', '1');
    expect(map.get('a')).toBe('1');
    expect(map.has('a')).toBe(true);
    expect(map.get('missing')).toBeUndefined();
    expect(map.size).toBe(1);
  });

  it('evicts the least-recently-used entry once maxEntries is exceeded', () => {
    const map = new BoundedMap<string, number>({ maxEntries: 3 });
    map.set('a', 1);
    map.set('b', 2);
    map.set('c', 3);
    map.set('d', 4);

    expect(map.size).toBe(3);
    expect(map.has('a')).toBe(false);
    expect(map.get('d')).toBe(4);
  });

  it('treats get() as a use, so a recently-read entry survives eviction', () => {
    const map = new BoundedMap<string, number>({ maxEntries: 3 });
    map.set('a', 1);
    map.set('b', 2);
    map.set('c', 3);
    map.get('a');
    map.set('d', 4);

    expect(map.has('a')).toBe(true);
    expect(map.has('b')).toBe(false);
  });

  it('overwriting an existing key does not grow the map or evict another entry', () => {
    const map = new BoundedMap<string, number>({ maxEntries: 2 });
    map.set('a', 1);
    map.set('b', 2);
    map.set('a', 10);

    expect(map.size).toBe(2);
    expect(map.get('a')).toBe(10);
    expect(map.get('b')).toBe(2);
  });

  it('never grows past maxEntries across many inserts', () => {
    const map = new BoundedMap<string, number>({ maxEntries: 100 });
    for (let i = 0; i < 10_000; i++) map.set(`k${i}`, i);
    expect(map.size).toBe(100);
    expect(map.get('k9999')).toBe(9999);
    expect(map.get('k0')).toBeUndefined();
  });

  it('expires an entry once ttlMs has elapsed since it was last used', () => {
    const clock = makeClock();
    const map = new BoundedMap<string, number>({ maxEntries: 10, ttlMs: 1000, now: clock.now });
    map.set('a', 1);
    clock.advance(999);
    expect(map.get('a')).toBe(1);
    // get() refreshed the entry, so it lives another full ttl from here.
    clock.advance(999);
    expect(map.get('a')).toBe(1);
    clock.advance(1000);
    expect(map.get('a')).toBeUndefined();
    expect(map.has('a')).toBe(false);
    expect(map.size).toBe(0);
  });

  it('sweeps expired entries on set() so idle keys do not linger until read', () => {
    const clock = makeClock();
    const map = new BoundedMap<string, number>({ maxEntries: 10, ttlMs: 1000, now: clock.now });
    map.set('a', 1);
    map.set('b', 2);
    clock.advance(1500);
    map.set('c', 3);

    expect(map.size).toBe(1);
    expect(map.get('c')).toBe(3);
  });

  it('has() does not refresh an entry', () => {
    const clock = makeClock();
    const map = new BoundedMap<string, number>({ maxEntries: 10, ttlMs: 1000, now: clock.now });
    map.set('a', 1);
    clock.advance(900);
    expect(map.has('a')).toBe(true);
    clock.advance(200);
    expect(map.has('a')).toBe(false);
  });

  it('does not expire entries when ttlMs is omitted', () => {
    const clock = makeClock();
    const map = new BoundedMap<string, number>({ maxEntries: 10, now: clock.now });
    map.set('a', 1);
    clock.advance(Number.MAX_SAFE_INTEGER / 2);
    expect(map.get('a')).toBe(1);
  });

  it('delete() and clear() remove entries', () => {
    const map = new BoundedMap<string, number>({ maxEntries: 10 });
    map.set('a', 1);
    map.set('b', 2);
    expect(map.delete('a')).toBe(true);
    expect(map.delete('a')).toBe(false);
    map.clear();
    expect(map.size).toBe(0);
  });

  it('rejects a non-positive or non-integer maxEntries and a non-positive ttlMs', () => {
    expect(() => new BoundedMap({ maxEntries: 0 })).toThrow(RangeError);
    expect(() => new BoundedMap({ maxEntries: 1.5 })).toThrow(RangeError);
    expect(() => new BoundedMap({ maxEntries: 1, ttlMs: 0 })).toThrow(RangeError);
  });
});
