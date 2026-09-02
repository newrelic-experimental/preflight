import { ApiFailureTracker, mapClaudeCodeErrorType } from './api-failure-tracker.js';
import type { ThrottleAlert } from './api-failure-tracker.js';

const stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
afterEach(() => stderrSpy.mockClear());

describe('ApiFailureTracker', () => {
  it('records failures and groups by error type', () => {
    const tracker = new ApiFailureTracker();
    tracker.recordFailure({
      errorType: 'rate_limit',
      model: 'claude-opus-4',
      turnNumber: 5,
      tokensInFlight: 1000,
    });
    tracker.recordFailure({
      errorType: 'timeout',
      model: 'claude-opus-4',
      turnNumber: 6,
      tokensInFlight: 2000,
    });
    tracker.recordFailure({
      errorType: 'rate_limit',
      model: 'gpt-4o',
      turnNumber: 7,
      tokensInFlight: 1500,
    });

    const metrics = tracker.getMetrics();
    expect(metrics.totalFailures).toBe(3);
    expect(metrics.byErrorType.rate_limit).toBe(2);
    expect(metrics.byErrorType.timeout).toBe(1);
  });

  it('computes per-model reliability scorecards', () => {
    const tracker = new ApiFailureTracker();
    tracker.recordRequest('claude-opus-4', 500);
    tracker.recordRequest('claude-opus-4', 600);
    tracker.recordRequest('claude-opus-4', 700);
    tracker.recordFailure({
      errorType: 'rate_limit',
      model: 'claude-opus-4',
      turnNumber: 2,
      tokensInFlight: 1000,
    });

    const metrics = tracker.getMetrics();
    const scorecard = metrics.byModel['claude-opus-4'];
    expect(scorecard).toBeDefined();
    expect(scorecard.totalRequests).toBe(3);
    expect(scorecard.failureCount).toBe(1);
    expect(scorecard.failureRate).toBeCloseTo(0.333, 2);
  });

  it('tracks tokens lost and estimates cost', () => {
    const tracker = new ApiFailureTracker({ costPerTokenUsd: 0.00001 });
    tracker.recordFailure({
      errorType: 'timeout',
      model: 'claude-opus-4',
      turnNumber: 3,
      tokensInFlight: 5000,
    });
    tracker.recordFailure({
      errorType: 'server_error',
      model: 'claude-opus-4',
      turnNumber: 4,
      tokensInFlight: 3000,
    });

    const metrics = tracker.getMetrics();
    expect(metrics.totalTokensLost).toBe(8000);
    expect(metrics.totalEstimatedCostLostUsd).toBe(0.08);
  });

  it('computes mean time to recovery', () => {
    const tracker = new ApiFailureTracker();
    tracker.recordFailure({
      errorType: 'rate_limit',
      model: 'claude-opus-4',
      turnNumber: 1,
      tokensInFlight: 500,
      recoveryMs: 3000,
    });
    tracker.recordFailure({
      errorType: 'rate_limit',
      model: 'claude-opus-4',
      turnNumber: 2,
      tokensInFlight: 500,
      recoveryMs: 5000,
    });

    const metrics = tracker.getMetrics();
    expect(metrics.meanTimeToRecoveryMs).toBe(4000);
  });

  it('classifies session phase correctly', () => {
    const tracker = new ApiFailureTracker();
    tracker.recordFailure({
      errorType: 'timeout',
      model: 'm1',
      turnNumber: 2,
      tokensInFlight: 100,
      totalTurnsInSession: 30,
    });
    tracker.recordFailure({
      errorType: 'timeout',
      model: 'm1',
      turnNumber: 15,
      tokensInFlight: 100,
      totalTurnsInSession: 30,
    });
    tracker.recordFailure({
      errorType: 'timeout',
      model: 'm1',
      turnNumber: 28,
      tokensInFlight: 100,
      totalTurnsInSession: 30,
    });

    const metrics = tracker.getMetrics();
    expect(metrics.bySessionPhase.early).toBe(1);
    expect(metrics.bySessionPhase.middle).toBe(1);
    expect(metrics.bySessionPhase.late).toBe(1);
  });

  it('fires throttle alert when rate limit exceeds threshold', () => {
    const alerts: ThrottleAlert[] = [];
    const tracker = new ApiFailureTracker({
      throttleAlertThreshold: 3,
      throttleAlertWindowMinutes: 10,
      onThrottleAlert: (a) => alerts.push(a),
    });

    tracker.recordFailure({
      errorType: 'rate_limit',
      model: 'claude-opus-4',
      turnNumber: 1,
      tokensInFlight: 500,
    });
    tracker.recordFailure({
      errorType: 'rate_limit',
      model: 'claude-opus-4',
      turnNumber: 2,
      tokensInFlight: 500,
    });
    tracker.recordFailure({
      errorType: 'rate_limit',
      model: 'claude-opus-4',
      turnNumber: 3,
      tokensInFlight: 500,
    });

    expect(alerts).toHaveLength(1);
    expect(alerts[0].model).toBe('claude-opus-4');
    expect(alerts[0].count).toBe(3);
  });

  it('does not duplicate throttle alerts within same window', () => {
    const alerts: ThrottleAlert[] = [];
    const tracker = new ApiFailureTracker({
      throttleAlertThreshold: 3,
      throttleAlertWindowMinutes: 10,
      onThrottleAlert: (a) => alerts.push(a),
    });

    for (let i = 0; i < 6; i++) {
      tracker.recordFailure({
        errorType: 'rate_limit',
        model: 'claude-opus-4',
        turnNumber: i,
        tokensInFlight: 500,
      });
    }

    expect(alerts).toHaveLength(1);
  });

  it('does not fire throttle alert for non-rate-limit errors', () => {
    const alerts: ThrottleAlert[] = [];
    const tracker = new ApiFailureTracker({
      throttleAlertThreshold: 3,
      onThrottleAlert: (a) => alerts.push(a),
    });

    tracker.recordFailure({
      errorType: 'timeout',
      model: 'claude-opus-4',
      turnNumber: 1,
      tokensInFlight: 500,
    });
    tracker.recordFailure({
      errorType: 'timeout',
      model: 'claude-opus-4',
      turnNumber: 2,
      tokensInFlight: 500,
    });
    tracker.recordFailure({
      errorType: 'timeout',
      model: 'claude-opus-4',
      turnNumber: 3,
      tokensInFlight: 500,
    });

    expect(alerts).toHaveLength(0);
  });

  it('tracks retry behavior', () => {
    const tracker = new ApiFailureTracker();
    tracker.recordFailure({
      errorType: 'rate_limit',
      model: 'claude-opus-4',
      turnNumber: 5,
      tokensInFlight: 2000,
      retryCount: 3,
      recoveryMs: 5000,
      recoverySucceeded: true,
    });

    const event = tracker.getMetrics().recentFailures[0];
    expect(event.retryCount).toBe(3);
    expect(event.recoveryMs).toBe(5000);
    expect(event.recoverySucceeded).toBe(true);
  });

  it('computes p95 latency per model', () => {
    const tracker = new ApiFailureTracker();
    for (let i = 0; i < 100; i++) {
      tracker.recordRequest('claude-opus-4', 500 + i * 10);
    }
    tracker.recordFailure({
      errorType: 'timeout',
      model: 'claude-opus-4',
      turnNumber: 50,
      tokensInFlight: 100,
    });

    const metrics = tracker.getMetrics();
    const scorecard = metrics.byModel['claude-opus-4'];
    expect(scorecard.p95LatencyMs).toBeGreaterThan(900);
  });

  it('reset clears all state', () => {
    const tracker = new ApiFailureTracker();
    tracker.recordFailure({
      errorType: 'timeout',
      model: 'claude-opus-4',
      turnNumber: 1,
      tokensInFlight: 1000,
    });
    tracker.recordRequest('claude-opus-4', 500);

    tracker.reset('new-session');
    const metrics = tracker.getMetrics();
    expect(metrics.totalFailures).toBe(0);
    expect(metrics.totalTokensLost).toBe(0);
  });

  it('reports dataAvailable true with a partial-data note explaining what remains unavailable', () => {
    const tracker = new ApiFailureTracker();
    const metrics = tracker.getMetrics();
    expect(metrics.dataAvailable).toBe(true);
    expect(metrics.note).toBe(
      "Failures are captured via Claude Code's StopFailure hook, which fires only once per turn, on a fully-failed turn, after Claude Code's own retries are exhausted — so recoverySucceeded is always false for every recorded event, and recoveryMs/retryCount are always null/0 rather than measured. tokensInFlight is always 0 (this hook carries no token data), so totalTokensLost and totalEstimatedCostLostUsd are not meaningful. Fields derived from totalRequests (failureRate, throttleFrequency, p95LatencyMs) require recordRequest() calls that nothing in this codebase currently makes — model-API request-level latency/throughput has no observable source in stdio or proxy mode — so they stay null/0; real visibility into those would require a future LLM-facing proxy.",
    );

    // Recording real events must not change either field — dataAvailable and
    // the note describe the tracker's fixed capabilities, not a function of
    // whether any failure has been recorded yet.
    tracker.recordFailure({
      errorType: 'rate_limit',
      model: 'claude-opus-4',
      turnNumber: 1,
      tokensInFlight: 100,
    });
    const metricsAfter = tracker.getMetrics();
    expect(metricsAfter.dataAvailable).toBe(true);
    expect(metricsAfter.note).toBe(metrics.note);
  });
});

describe('mapClaudeCodeErrorType', () => {
  it.each([
    ['rate_limit', 'rate_limit'],
    ['overloaded', 'server_error'],
    ['authentication_failed', 'authentication'],
    ['oauth_org_not_allowed', 'authentication'],
    ['billing_error', 'authentication'],
    ['invalid_request', 'unknown'],
    ['model_not_found', 'unknown'],
    ['server_error', 'server_error'],
    ['max_output_tokens', 'context_length_exceeded'],
    ['unknown', 'unknown'],
    ['something_unrecognized', 'unknown'],
  ] as const)('maps raw error %s to %s', (raw, expected) => {
    expect(mapClaudeCodeErrorType(raw)).toBe(expected);
  });

  it('never produces timeout or connection_error', () => {
    const rawValues = [
      'rate_limit',
      'overloaded',
      'authentication_failed',
      'oauth_org_not_allowed',
      'billing_error',
      'invalid_request',
      'model_not_found',
      'server_error',
      'max_output_tokens',
      'unknown',
      'anything_else',
    ];
    for (const raw of rawValues) {
      const mapped = mapClaudeCodeErrorType(raw);
      expect(mapped).not.toBe('timeout');
      expect(mapped).not.toBe('connection_error');
    }
  });
});
