import { describe, it, expect } from '@jest/globals';
import { TierRouter } from './tier-router.js';
import type { ResolvedTier } from './tier-types.js';

function makeTier(overrides?: Partial<ResolvedTier>): ResolvedTier {
  return {
    name: 'default',
    destination: { type: 'nr', licenseKey: 'lk-default', accountId: '12345' },
    eventTypes: ['*'],
    ...overrides,
  };
}

describe('TierRouter.resolveEventType()', () => {
  it('routes every known event type to a wildcard tier', () => {
    const router = new TierRouter([makeTier()]);

    expect(router.resolveEventType('AiToolCall')).toEqual(['default']);
    expect(router.resolveEventType('AiCodingTask')).toEqual(['default']);
    expect(router.resolveEventType('SecurityAlert')).toEqual(['default']);
  });

  it('routes an event type to only the tiers that name it', () => {
    const router = new TierRouter([
      makeTier({ name: 'personal', eventTypes: ['*'] }),
      makeTier({
        name: 'team',
        destination: { type: 'nr', licenseKey: 'lk-team', accountId: '67890' },
        eventTypes: ['AiCodingTask', 'AiSubagentTurn'],
      }),
    ]);

    expect(router.resolveEventType('AiCodingTask')).toEqual(['personal', 'team']);
    expect(router.resolveEventType('AiSubagentTurn')).toEqual(['personal', 'team']);
    expect(router.resolveEventType('AiToolCall')).toEqual(['personal']);
  });

  it('preserves tier declaration order, wildcard tiers included', () => {
    const router = new TierRouter([
      makeTier({
        name: 'team',
        destination: { type: 'nr', licenseKey: 'lk-team', accountId: '67890' },
        eventTypes: ['AiCodingTask'],
      }),
      makeTier({ name: 'personal', eventTypes: ['*'] }),
    ]);

    expect(router.resolveEventType('AiCodingTask')).toEqual(['team', 'personal']);
  });

  it('includes local-destination tiers in the resolved names', () => {
    const router = new TierRouter([
      makeTier({ name: 'personal' }),
      makeTier({
        name: 'org',
        destination: { type: 'local', path: '/shared/nas/preflight-org' },
        eventTypes: ['AiCodingTask'],
      }),
    ]);

    expect(router.resolveEventType('AiCodingTask')).toEqual(['personal', 'org']);
    expect(router.resolveEventType('AiToolCall')).toEqual(['personal']);
  });

  it('routes an event type unknown to KNOWN_EVENT_TYPES to wildcard tiers only', () => {
    // Forward compatibility: a new event type added to nr-ingest.ts before
    // KNOWN_EVENT_TYPES is updated must still reach the default tier rather
    // than being silently dropped.
    const router = new TierRouter([
      makeTier({ name: 'personal', eventTypes: ['*'] }),
      makeTier({
        name: 'team',
        destination: { type: 'nr', licenseKey: 'lk-team', accountId: '67890' },
        eventTypes: ['AiCodingTask'],
      }),
    ]);

    expect(router.resolveEventType('AiBrandNewEvent')).toEqual(['personal']);
  });

  it('returns an empty list when no tier matches', () => {
    const router = new TierRouter([
      makeTier({
        name: 'team',
        destination: { type: 'nr', licenseKey: 'lk-team', accountId: '67890' },
        eventTypes: ['AiCodingTask'],
      }),
    ]);

    expect(router.resolveEventType('AiToolCall')).toEqual([]);
    expect(router.resolveEventType('AiBrandNewEvent')).toEqual([]);
  });

  it('returns an empty list for every event type when built from zero tiers', () => {
    const router = new TierRouter([]);
    expect(router.resolveEventType('AiToolCall')).toEqual([]);
  });

  it('returns a stable result across repeated calls (no mutation)', () => {
    const router = new TierRouter([makeTier()]);
    const first = router.resolveEventType('AiToolCall');
    const second = router.resolveEventType('AiToolCall');
    expect(second).toEqual(first);
    expect(second).toEqual(['default']);
  });
});
