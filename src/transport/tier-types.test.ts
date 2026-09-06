import { describe, it, expect } from '@jest/globals';
import {
  KNOWN_EVENT_TYPES,
  EVENT_TYPE_SENSITIVITY,
  SAFE_SHARED_EVENT_TYPES,
  PERSONAL_ONLY_EVENT_TYPES,
  DEFAULT_TIER_NAME,
  WILDCARD_EVENT_TYPE,
} from './tier-types.js';

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
