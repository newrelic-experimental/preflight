import { describe, expect, it } from '@jest/globals';
import {
  deriveSessionStatus,
  SESSION_STATUSES,
  SESSION_STATUS_LABEL,
  type SessionStatusInput,
} from './session-status.js';

function makeInput(overrides: Partial<SessionStatusInput> = {}): SessionStatusInput {
  return {
    live: false,
    lastToolName: null,
    openPrCount: 0,
    ...overrides,
  };
}

describe('deriveSessionStatus', () => {
  it('returns needs_input for a live session whose last tool call was AskUserQuestion', () => {
    const input = makeInput({ live: true, lastToolName: 'AskUserQuestion' });
    expect(deriveSessionStatus(input)).toBe('needs_input');
  });

  it('does not return needs_input for a non-live session waiting on AskUserQuestion', () => {
    const input = makeInput({ live: false, lastToolName: 'AskUserQuestion' });
    expect(deriveSessionStatus(input)).not.toBe('needs_input');
  });

  it('returns ready_for_review for an unmerged PR, outranking working', () => {
    const input = makeInput({ live: true, lastToolName: 'Bash', openPrCount: 1 });
    expect(deriveSessionStatus(input)).toBe('ready_for_review');
  });

  it('returns ready_for_review for a completed session with an open PR', () => {
    const input = makeInput({ live: false, openPrCount: 1 });
    expect(deriveSessionStatus(input)).toBe('ready_for_review');
  });

  it('needs_input outranks an open PR', () => {
    const input = makeInput({ live: true, lastToolName: 'AskUserQuestion', openPrCount: 1 });
    expect(deriveSessionStatus(input)).toBe('needs_input');
  });

  it('returns working for a live session with no open PR and ordinary last tool call', () => {
    const input = makeInput({ live: true, lastToolName: 'Read', openPrCount: 0 });
    expect(deriveSessionStatus(input)).toBe('working');
  });

  it('returns completed for a non-live session with no open PR', () => {
    const input = makeInput({ live: false, openPrCount: 0 });
    expect(deriveSessionStatus(input)).toBe('completed');
  });

  it('returns completed when lastToolName is null and the session is not live', () => {
    const input = makeInput({ live: false, lastToolName: null, openPrCount: 0 });
    expect(deriveSessionStatus(input)).toBe('completed');
  });
});

describe('SESSION_STATUSES', () => {
  it('lists every status in display order', () => {
    expect(SESSION_STATUSES).toEqual(['needs_input', 'ready_for_review', 'working', 'completed']);
  });
});

describe('SESSION_STATUS_LABEL', () => {
  it('has a label for every status', () => {
    for (const status of SESSION_STATUSES) {
      expect(typeof SESSION_STATUS_LABEL[status]).toBe('string');
      expect(SESSION_STATUS_LABEL[status].length).toBeGreaterThan(0);
    }
  });
});
