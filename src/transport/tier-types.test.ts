import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
  KNOWN_EVENT_TYPES,
  EVENT_TYPE_SENSITIVITY,
  SAFE_SHARED_EVENT_TYPES,
  PERSONAL_ONLY_EVENT_TYPES,
  DEFAULT_TIER_NAME,
  WILDCARD_EVENT_TYPE,
  validateTiers,
} from './tier-types.js';
import { resolve } from 'node:path';

describe('KNOWN_EVENT_TYPES', () => {
  it('enumerates exactly the 14 event types NrIngestManager emits', () => {
    expect([...KNOWN_EVENT_TYPES].sort()).toEqual(
      [
        'AiAntiPattern',
        'AiAuditEvent',
        'AiBudgetWarning',
        'AiCodingTask',
        'AiContextSnapshot',
        'AiMcpToolCall',
        'AiObservabilityHealth',
        'AiProxyRequest',
        'AiRetryAlert',
        'AiSubagentTurn',
        'AiToolCall',
        'AiTurnCost',
        'AiWorkflowRun',
        'SecurityAlert',
      ].sort(),
    );
  });

  it('has no duplicate entries', () => {
    expect(new Set(KNOWN_EVENT_TYPES).size).toBe(KNOWN_EVENT_TYPES.length);
  });
});

describe('EVENT_TYPE_SENSITIVITY', () => {
  it('classifies every known event type', () => {
    for (const eventType of KNOWN_EVENT_TYPES) {
      expect(EVENT_TYPE_SENSITIVITY[eventType]).toMatch(/^(safe-shared|personal-only)$/);
    }
    expect(Object.keys(EVENT_TYPE_SENSITIVITY)).toHaveLength(KNOWN_EVENT_TYPES.length);
  });

  it('marks aggregate-only event types safe-shared (spec categorization table)', () => {
    expect([...SAFE_SHARED_EVENT_TYPES].sort()).toEqual(
      [
        'AiProxyRequest',
        'AiCodingTask',
        'AiSubagentTurn',
        'AiRetryAlert',
        'AiTurnCost',
        'AiContextSnapshot',
        'AiBudgetWarning',
        'AiObservabilityHealth',
      ].sort(),
    );
  });

  it('marks raw-detail-bearing event types personal-only (spec categorization table)', () => {
    expect([...PERSONAL_ONLY_EVENT_TYPES].sort()).toEqual(
      [
        'AiToolCall',
        'AiMcpToolCall',
        'AiWorkflowRun',
        'AiAntiPattern',
        'AiAuditEvent',
        'SecurityAlert',
      ].sort(),
    );
  });

  it('partitions the inventory with no overlap and no gaps', () => {
    expect(SAFE_SHARED_EVENT_TYPES.length + PERSONAL_ONLY_EVENT_TYPES.length).toBe(
      KNOWN_EVENT_TYPES.length,
    );
    for (const eventType of SAFE_SHARED_EVENT_TYPES) {
      expect(PERSONAL_ONLY_EVENT_TYPES).not.toContain(eventType);
    }
  });
});

describe('tier constants', () => {
  it('names the implicit default tier "default"', () => {
    expect(DEFAULT_TIER_NAME).toBe('default');
  });

  it('uses "*" as the route-everything wildcard', () => {
    expect(WILDCARD_EVENT_TYPE).toBe('*');
  });
});

describe('validateTiers()', () => {
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  function makeNrTier(overrides?: Record<string, unknown>): Record<string, unknown> {
    return {
      name: 'personal',
      destination: { type: 'nr', licenseKey: 'lk-personal', accountId: '12345' },
      eventTypes: ['*'],
      ...overrides,
    };
  }

  function makeLocalTier(overrides?: Record<string, unknown>): Record<string, unknown> {
    return {
      name: 'org',
      destination: { type: 'local', path: '/shared/nas/preflight-org' },
      eventTypes: ['AiCodingTask'],
      ...overrides,
    };
  }

  it('resolves a valid multi-tier array in declaration order', () => {
    const resolved = validateTiers([
      makeNrTier(),
      makeNrTier({
        name: 'team',
        destination: { type: 'nr', licenseKey: 'lk-team', accountId: '67890' },
        eventTypes: ['AiCodingTask', 'AiSubagentTurn'],
      }),
      makeLocalTier(),
    ]);

    expect(resolved.map((t: (typeof resolved)[0]) => t.name)).toEqual(['personal', 'team', 'org']);
    expect(resolved[0].destination).toEqual({
      type: 'nr',
      licenseKey: 'lk-personal',
      accountId: '12345',
    });
    expect(resolved[1].eventTypes).toEqual(['AiCodingTask', 'AiSubagentTurn']);
    expect(resolved[2].destination).toEqual({
      type: 'local',
      path: resolve('/shared/nas/preflight-org'),
    });
  });

  it('de-duplicates repeated event types within one tier', () => {
    const resolved = validateTiers([
      makeNrTier({ eventTypes: ['AiCodingTask', 'AiCodingTask', 'AiTurnCost'] }),
    ]);
    expect(resolved[0].eventTypes).toEqual(['AiCodingTask', 'AiTurnCost']);
  });

  it('throws on an empty tiers array', () => {
    expect(() => validateTiers([])).toThrow(/must contain at least one tier/);
  });

  it('throws on a duplicate tier name', () => {
    expect(() => validateTiers([makeNrTier(), makeNrTier()])).toThrow(
      /Duplicate tier name "personal"/,
    );
  });

  it('throws on a missing or blank tier name', () => {
    expect(() => validateTiers([makeNrTier({ name: '  ' })])).toThrow(
      /tiers\[0\]\.name must be a non-empty string/,
    );
  });

  it('throws when a tier entry is not an object', () => {
    expect(() => validateTiers(['personal'])).toThrow(/tiers\[0\] must be an object/);
  });

  it('throws on an unknown event type', () => {
    expect(() => validateTiers([makeNrTier({ eventTypes: ['AiNotARealEvent'] })])).toThrow(
      /lists unknown event type "AiNotARealEvent"/,
    );
  });

  it('throws on an empty eventTypes array', () => {
    expect(() => validateTiers([makeNrTier({ eventTypes: [] })])).toThrow(
      /requires a non-empty eventTypes array/,
    );
  });

  it('throws when an nr tier is missing licenseKey', () => {
    expect(() =>
      validateTiers([makeNrTier({ destination: { type: 'nr', accountId: '12345' } })]),
    ).toThrow(/requires a non-empty licenseKey/);
  });

  it('throws when an nr tier accountId is not 1-12 digits', () => {
    expect(() =>
      validateTiers([
        makeNrTier({ destination: { type: 'nr', licenseKey: 'lk', accountId: 'abc' } }),
      ]),
    ).toThrow(/destination\.accountId must be 1–12 decimal digits/);
  });

  it('throws when a local tier is missing path', () => {
    expect(() =>
      validateTiers([makeNrTier(), makeLocalTier({ destination: { type: 'local' } })]),
    ).toThrow(/requires a non-empty path/);
  });

  it('throws on an unknown destination type', () => {
    expect(() => validateTiers([makeNrTier({ destination: { type: 's3' } })])).toThrow(
      /destination\.type must be 'nr' or 'local'/,
    );
  });

  it('throws when no tier has an nr destination', () => {
    expect(() => validateTiers([makeLocalTier()])).toThrow(
      /At least one tier must have destination\.type='nr'/,
    );
  });

  it('never includes the licenseKey value in a thrown message', () => {
    expect(() =>
      validateTiers([
        makeNrTier({ destination: { type: 'nr', licenseKey: 'super-secret-key', accountId: 'x' } }),
      ]),
    ).toThrow(/^(?!.*super-secret-key).*$/s);
  });

  it('warns (does not throw) when a personal-only type is routed to a non-default tier', () => {
    const resolved = validateTiers([
      makeNrTier(),
      makeNrTier({
        name: 'team',
        destination: { type: 'nr', licenseKey: 'lk-team', accountId: '67890' },
        eventTypes: ['AiToolCall'],
      }),
    ]);

    expect(resolved).toHaveLength(2);
    const calls = stderrSpy.mock.calls.map((call: unknown[]) => JSON.stringify(call[0]));
    expect(calls.join('\n')).toContain('personal-only');
    expect(calls.join('\n')).toContain('AiToolCall');
  });

  it('warns when a non-default tier uses the wildcard', () => {
    validateTiers([makeNrTier({ name: 'team' })]);
    const calls = stderrSpy.mock.calls.map((call: unknown[]) => JSON.stringify(call[0]));
    expect(calls.join('\n')).toContain('ALL event types');
  });

  it('does not warn when personal-only types stay on the default tier', () => {
    validateTiers([makeNrTier({ name: 'default', eventTypes: ['AiToolCall'] })]);
    const calls = stderrSpy.mock.calls.map((call: unknown[]) => JSON.stringify(call[0]));
    expect(calls.join('\n')).not.toContain('personal-only');
  });

  it('honors an explicit knownEventTypes override', () => {
    expect(() =>
      validateTiers([makeNrTier({ eventTypes: ['AiToolCall'] })], ['AiCodingTask']),
    ).toThrow(/lists unknown event type "AiToolCall"/);
  });
});
