import { ApiFailureTracker } from './api-failure-tracker.js';
import type { ThrottleAlert } from './api-failure-tracker.js';

const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
afterEach(() => stderrSpy.mockClear());

describe('ApiFailureTracker', () => {
  it('records failures and groups by error type', () => {
    const tracker = new ApiFailureTracker();
    tracker.recordFailure({ errorType: 'rate_limit', model: 'claude-opus-4', turnNumber: 5, tokensInFlight: 1000 });
    tracker.recordFailure({ errorType: 'timeout', model: 'claude-opus-4', turnNumber: 6, tokensInFlight: 2000 });
    tracker.recordFailure({ errorType: 'rate_limit', model: 'gpt-4o', turnNumber: 7, tokensInFlight: 1500 });

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
    tracker.recordFailure({ errorType: 'rate_limit', model: 'claude-opus-4', turnNumber: 2, tokensInFlight: 1000 });

    const metrics = tracker.getMetrics();
    const scorecard = metrics.byModel['claude-opus-4'];
    expect(scorecard).toBeDefined();
    expect(scorecard.totalRequests).toBe(3);
    expect(scorecard.failureCount).toBe(1);
    expect(scorecard.failureRate).toBeCloseTo(0.333, 2);
  });

  it('tracks tokens lost and estimates cost', () => {
    const tracker = new ApiFailureTracker({ costPerTokenUsd: 0.00001 });
    tracker.recordFailure({ errorType: 'timeout', model: 'claude-opus-4', turnNumber: 3, tokensInFlight: 5000 });
    tracker.recordFailure({ errorType: 'server_error', model: 'claude-opus-4', turnNumber: 4, tokensInFlight: 3000 });

    const metrics = tracker.getMetrics();
    expect(metrics.totalTokensLost).toBe(8000);
    expect(metrics.totalEstimatedCostLostUsd).toBe(0.08);
  });

  it('computes mean time to recovery', () => {
    const tracker = new ApiFailureTracker();
    tracker.recordFailure({ errorType: 'rate_limit', model: 'claude-opus-4', turnNumber: 1, tokensInFlight: 500, recoveryMs: 3000 });
    tracker.recordFailure({ errorType: 'rate_limit', model: 'claude-opus-4', turnNumber: 2, tokensInFlight: 500, recoveryMs: 5000 });

    const metrics = tracker.getMetrics();
    expect(metrics.meanTimeToRecoveryMs).toBe(4000);
  });

  it('classifies session phase correctly', () => {
    const tracker = new ApiFailureTracker();
    tracker.recordFailure({ errorType: 'timeout', model: 'm1', turnNumber: 2, tokensInFlight: 100, totalTurnsInSession: 30 });
    tracker.recordFailure({ errorType: 'timeout', model: 'm1', turnNumber: 15, tokensInFlight: 100, totalTurnsInSession: 30 });
    tracker.recordFailure({ errorType: 'timeout', model: 'm1', turnNumber: 28, tokensInFlight: 100, totalTurnsInSession: 30 });

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

    tracker.recordFailure({ errorType: 'rate_limit', model: 'claude-opus-4', turnNumber: 1, tokensInFlight: 500 });
    tracker.recordFailure({ errorType: 'rate_limit', model: 'claude-opus-4', turnNumber: 2, tokensInFlight: 500 });
    tracker.recordFailure({ errorType: 'rate_limit', model: 'claude-opus-4', turnNumber: 3, tokensInFlight: 500 });

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
      tracker.recordFailure({ errorType: 'rate_limit', model: 'claude-opus-4', turnNumber: i, tokensInFlight: 500 });
    }

    expect(alerts).toHaveLength(1);
  });

  it('does not fire throttle alert for non-rate-limit errors', () => {
    const alerts: ThrottleAlert[] = [];
    const tracker = new ApiFailureTracker({
      throttleAlertThreshold: 3,
      onThrottleAlert: (a) => alerts.push(a),
    });

    tracker.recordFailure({ errorType: 'timeout', model: 'claude-opus-4', turnNumber: 1, tokensInFlight: 500 });
    tracker.recordFailure({ errorType: 'timeout', model: 'claude-opus-4', turnNumber: 2, tokensInFlight: 500 });
    tracker.recordFailure({ errorType: 'timeout', model: 'claude-opus-4', turnNumber: 3, tokensInFlight: 500 });

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
    tracker.recordFailure({ errorType: 'timeout', model: 'claude-opus-4', turnNumber: 50, tokensInFlight: 100 });

    const metrics = tracker.getMetrics();
    const scorecard = metrics.byModel['claude-opus-4'];
    expect(scorecard.p95LatencyMs).toBeGreaterThan(900);
  });

  it('reset clears all state', () => {
    const tracker = new ApiFailureTracker();
    tracker.recordFailure({ errorType: 'timeout', model: 'claude-opus-4', turnNumber: 1, tokensInFlight: 1000 });
    tracker.recordRequest('claude-opus-4', 500);

    tracker.reset('new-session');
    const metrics = tracker.getMetrics();
    expect(metrics.totalFailures).toBe(0);
    expect(metrics.totalTokensLost).toBe(0);
  });
});
