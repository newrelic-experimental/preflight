import { CostEstimateGate, type CostEstimateParams } from './cost-estimate-gate.js';

function makeParams(overrides: Partial<CostEstimateParams> = {}): CostEstimateParams {
  return {
    estimateBytes: 500,
    reportCount: 0,
    sessionId: 'session-a',
    liveOwnedSessionIds: () => new Set(),
    ...overrides,
  };
}

describe('CostEstimateGate', () => {
  test('fires for a scoped session with no real report yet and no other owner', () => {
    expect(new CostEstimateGate(false).shouldApply(makeParams())).toBe(true);
  });

  test('does not fire when there are no bytes to estimate from', () => {
    expect(new CostEstimateGate(false).shouldApply(makeParams({ estimateBytes: 0 }))).toBe(false);
  });

  test('does not fire once a real token report has already been received', () => {
    expect(new CostEstimateGate(false).shouldApply(makeParams({ reportCount: 1 }))).toBe(false);
  });

  test('fires in unscoped (--local) mode for a session with no live --stdio owner', () => {
    const gate = new CostEstimateGate(true);
    const params = makeParams({ liveOwnedSessionIds: () => new Set(['session-b']) });
    expect(gate.shouldApply(params)).toBe(true);
  });

  test('does not fire in unscoped (--local) mode for a session with a live --stdio owner', () => {
    const gate = new CostEstimateGate(true);
    const params = makeParams({ liveOwnedSessionIds: () => new Set(['session-a']) });
    expect(gate.shouldApply(params)).toBe(false);
  });

  test('fires for a scoped session even if its own id happens to be in the live-owner set', () => {
    const gate = new CostEstimateGate(false);
    const params = makeParams({ liveOwnedSessionIds: () => new Set(['session-a']) });
    expect(gate.shouldApply(params)).toBe(true);
  });

  test('fires for an unscoped record with no session id', () => {
    const gate = new CostEstimateGate(true);
    expect(gate.shouldApply(makeParams({ sessionId: null }))).toBe(true);
  });

  test('a provisional process stops being gated once markScoped() is called', () => {
    // The process's own heartbeat is in the live-owner set once its id resolves.
    const gate = new CostEstimateGate(true);
    const params = makeParams({ liveOwnedSessionIds: () => new Set(['session-a']) });
    expect(gate.shouldApply(params)).toBe(false);

    gate.markScoped();

    expect(gate.shouldApply(params)).toBe(true);
  });

  test('does not read the live-owner set unless the answer depends on it', () => {
    const lookup = jest.fn(() => new Set<string>());
    new CostEstimateGate(true).shouldApply(
      makeParams({ estimateBytes: 0, liveOwnedSessionIds: lookup }),
    );
    new CostEstimateGate(true).shouldApply(
      makeParams({ reportCount: 2, liveOwnedSessionIds: lookup }),
    );
    new CostEstimateGate(false).shouldApply(makeParams({ liveOwnedSessionIds: lookup }));
    expect(lookup).not.toHaveBeenCalled();
  });
});
