/**
 * Multi-tier telemetry routing — the one decision the feature turns on:
 * `eventType` → the names of the tiers that should receive it.
 *
 * Deliberately a separate class from `NrIngestManager`: routing controls where
 * potentially sensitive data flows, so it must be independently testable and
 * auditable in one place instead of scattered across ~15 `ingestX()` methods.
 * No I/O, no mutable state after construction.
 */

import { KNOWN_EVENT_TYPES, WILDCARD_EVENT_TYPE } from './tier-types.js';
import type { ResolvedTier } from './tier-types.js';

export class TierRouter {
  /**
   * Fully precomputed at construction for every member of
   * `KNOWN_EVENT_TYPES`, preserving tier declaration order (the outer loop is
   * over tiers, not event types). Avoids re-scanning the tier list on the
   * per-event hot path.
   */
  private readonly byEventType: ReadonlyMap<string, readonly string[]>;

  /**
   * Names of the tiers whose `eventTypes` is `['*']`. Used as the fallback for
   * an `eventType` absent from `KNOWN_EVENT_TYPES`, so a newly-added event
   * type still reaches the default tier instead of being dropped.
   */
  private readonly wildcardTierNames: readonly string[];

  constructor(tiers: readonly ResolvedTier[]) {
    const wildcard: string[] = [];
    const byEventType = new Map<string, string[]>();

    for (const tier of tiers) {
      const isWildcard = tier.eventTypes.includes(WILDCARD_EVENT_TYPE);
      if (isWildcard) wildcard.push(tier.name);

      for (const eventType of KNOWN_EVENT_TYPES) {
        if (!isWildcard && !tier.eventTypes.includes(eventType)) continue;
        const names = byEventType.get(eventType);
        if (names) {
          names.push(tier.name);
        } else {
          byEventType.set(eventType, [tier.name]);
        }
      }
    }

    this.byEventType = byEventType;
    this.wildcardTierNames = wildcard;
  }

  /** Tier names that should receive an event of this type, in tier order. */
  resolveEventType(eventType: string): readonly string[] {
    return this.byEventType.get(eventType) ?? this.wildcardTierNames;
  }
}
