import {
  isOwnSessionRecord,
  isTokenEventForThisProcess,
  shouldApplyCostEstimate,
} from './cost-estimate-gate.js';

function makeParams(
  overrides: Partial<Parameters<typeof shouldApplyCostEstimate>[0]> = {},
): Parameters<typeof shouldApplyCostEstimate>[0] {
  return {
    estimateBytes: 400,
    reportCount: 0,
    recordSessionId: 'session-own',
    ownSessionId: 'session-own',
    ...overrides,
  };
}

describe('shouldApplyCostEstimate', () => {
  it('applies to a record from the process own session before any token report', () => {
    expect(shouldApplyCostEstimate(makeParams())).toBe(true);
  });

  it('applies when the record carries no session id', () => {
    expect(shouldApplyCostEstimate(makeParams({ recordSessionId: null }))).toBe(true);
  });

  it('skips a record from another session (--local daemon drains every session)', () => {
    expect(
      shouldApplyCostEstimate(
        makeParams({ recordSessionId: 'session-other', ownSessionId: 'local-1700000000000' }),
      ),
    ).toBe(false);
  });

  it('skips every real-session record while the id is still provisional', () => {
    expect(
      shouldApplyCostEstimate(
        makeParams({ recordSessionId: 'session-orphan', ownSessionId: 'pending-1700000000000' }),
      ),
    ).toBe(false);
  });

  it('skips once an exact token report has been received', () => {
    expect(shouldApplyCostEstimate(makeParams({ reportCount: 1 }))).toBe(false);
  });

  it('skips a record with no payload bytes', () => {
    expect(shouldApplyCostEstimate(makeParams({ estimateBytes: 0 }))).toBe(false);
  });
});

describe('isOwnSessionRecord', () => {
  it('accepts a record with no session id', () => {
    expect(isOwnSessionRecord(null, 'session-own')).toBe(true);
  });

  it('accepts a record for the live session', () => {
    expect(isOwnSessionRecord('session-own', 'session-own')).toBe(true);
  });

  it('rejects a record from another session', () => {
    expect(isOwnSessionRecord('session-crashed', 'session-own')).toBe(false);
  });

  it('rejects every real-session record while the id is still provisional', () => {
    expect(isOwnSessionRecord('session-crashed', 'pending-1700000000000')).toBe(false);
  });
});

describe('isTokenEventForThisProcess', () => {
  it('keeps every event in --local, which owns no single session', () => {
    expect(
      isTokenEventForThisProcess({
        stdio: false,
        eventSessionId: 'session-other',
        ownSessionId: 'session-own',
      }),
    ).toBe(true);
  });

  it('keeps a --stdio engine its own session events', () => {
    expect(
      isTokenEventForThisProcess({
        stdio: true,
        eventSessionId: 'session-own',
        ownSessionId: 'session-own',
      }),
    ).toBe(true);
  });

  it('keeps an event that names no session', () => {
    expect(
      isTokenEventForThisProcess({
        stdio: true,
        eventSessionId: null,
        ownSessionId: 'session-own',
      }),
    ).toBe(true);
  });

  it('treats another session as foreign to a --stdio engine', () => {
    expect(
      isTokenEventForThisProcess({
        stdio: true,
        eventSessionId: 'session-other',
        ownSessionId: 'session-own',
      }),
    ).toBe(false);
  });

  it('treats every named session as foreign while the engine id is still provisional', () => {
    expect(
      isTokenEventForThisProcess({
        stdio: true,
        eventSessionId: 'session-own',
        ownSessionId: 'pending-1700000000000',
      }),
    ).toBe(false);
  });
});
