import { shouldApplyCostEstimate } from './cost-estimate-gate.js';

describe('shouldApplyCostEstimate', () => {
  test('fires for a scoped session with no real report yet and no other owner', () => {
    const result = shouldApplyCostEstimate({
      estimateBytes: 500,
      reportCount: 0,
      isUnscopedSession: false,
      sessionId: 'session-a',
      liveOwnedSessionIds: new Set(),
    });
    expect(result).toBe(true);
  });

  test('does not fire when there are no bytes to estimate from', () => {
    const result = shouldApplyCostEstimate({
      estimateBytes: 0,
      reportCount: 0,
      isUnscopedSession: false,
      sessionId: 'session-a',
      liveOwnedSessionIds: new Set(),
    });
    expect(result).toBe(false);
  });

  test('does not fire once a real token report has already been received', () => {
    const result = shouldApplyCostEstimate({
      estimateBytes: 500,
      reportCount: 1,
      isUnscopedSession: false,
      sessionId: 'session-a',
      liveOwnedSessionIds: new Set(),
    });
    expect(result).toBe(false);
  });

  test('fires in unscoped (--local) mode for a session with no live --stdio owner', () => {
    const result = shouldApplyCostEstimate({
      estimateBytes: 500,
      reportCount: 0,
      isUnscopedSession: true,
      sessionId: 'session-a',
      liveOwnedSessionIds: new Set(['session-b']),
    });
    expect(result).toBe(true);
  });

  test('does not fire in unscoped (--local) mode for a session with a live --stdio owner', () => {
    const result = shouldApplyCostEstimate({
      estimateBytes: 500,
      reportCount: 0,
      isUnscopedSession: true,
      sessionId: 'session-a',
      liveOwnedSessionIds: new Set(['session-a']),
    });
    expect(result).toBe(false);
  });

  test('fires for a scoped session even if its own id happens to be in the live-owner set', () => {
    const result = shouldApplyCostEstimate({
      estimateBytes: 500,
      reportCount: 0,
      isUnscopedSession: false,
      sessionId: 'session-a',
      liveOwnedSessionIds: new Set(['session-a']),
    });
    expect(result).toBe(true);
  });
});
