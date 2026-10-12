import { shouldApplyCostEstimate } from './cost-estimate-gate.js';

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
