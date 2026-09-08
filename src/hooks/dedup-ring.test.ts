import { describe, expect, it } from '@jest/globals';
import { DedupRingRegistry } from './dedup-ring.js';

describe('DedupRingRegistry', () => {
  it('evicts the least-recently-used scope once maxScopes is exceeded', () => {
    const registry = new DedupRingRegistry(2, 10);

    expect(registry.hasAndAdd('a', 'k1')).toBe(false); // creates scope 'a'
    expect(registry.hasAndAdd('b', 'k1')).toBe(false); // creates scope 'b'
    expect(registry.scopeCount).toBe(2);

    // A third distinct scope exceeds maxScopes (2) — the least-recently-used
    // scope ('a', the oldest, untouched since its first insert) gets evicted.
    expect(registry.hasAndAdd('c', 'k1')).toBe(false);
    expect(registry.scopeCount).toBe(2);

    // 'b' survived the eviction (it's newer than 'a') and still remembers
    // its own key — checking an EXISTING scope never itself triggers
    // eviction, so this assertion doesn't disturb the registry further.
    expect(registry.hasAndAdd('b', 'k1')).toBe(true);
  });

  it('touching an existing scope refreshes its LRU position', () => {
    const registry = new DedupRingRegistry(2, 10);
    registry.hasAndAdd('a', 'k1');
    registry.hasAndAdd('b', 'k1');
    // Touch 'a' again so 'b' becomes the least-recently-used scope instead.
    registry.hasAndAdd('a', 'k2');

    registry.hasAndAdd('c', 'k1'); // exceeds maxScopes — evicts 'b', not 'a'

    expect(registry.hasAndAdd('a', 'k1')).toBe(true); // 'a' survived, key still known
    expect(registry.hasAndAdd('b', 'k1')).toBe(false); // 'b' was evicted, key forgotten
  });
});
