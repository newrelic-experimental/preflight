import { createLogger } from '../shared/index.js';
import type { MetricAggregator } from '../shared/index.js';
import { computePercentile } from './percentile.js';

const logger = createLogger('api-failure-tracker');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ApiErrorType =
  | 'rate_limit'
  | 'timeout'
  | 'connection_error'
  | 'server_error'
  | 'context_length_exceeded'
  | 'authentication'
  | 'unknown';

export type SessionPhase = 'early' | 'middle' | 'late';

export interface ApiFailureEvent {
  readonly errorType: ApiErrorType;
  readonly model: string;
  readonly timestamp: number;
  readonly turnNumber: number;
  readonly tokensInFlight: number;
  readonly recoveryMs: number | null;
  readonly retryCount: number;
  readonly recoverySucceeded: boolean | null;
  readonly sessionPhase: SessionPhase;
  readonly duringToolExecution: boolean;
}

export interface ModelReliabilityScorecard {
  readonly model: string;
  readonly totalRequests: number;
  readonly failureCount: number;
  readonly failureRate: number;
  readonly throttleCount: number;
  readonly throttleFrequency: number;
  readonly meanRecoveryMs: number | null;
  readonly p95LatencyMs: number | null;
  readonly tokensLost: number;
  readonly estimatedCostLostUsd: number;
}

export interface ThrottleAlert {
  readonly model: string;
  readonly count: number;
  readonly windowMinutes: number;
  readonly timestamp: number;
}

export interface ApiFailureMetrics {
  readonly totalFailures: number;
  readonly byErrorType: Readonly<Record<ApiErrorType, number>>;
  readonly byModel: Readonly<Record<string, ModelReliabilityScorecard>>;
  readonly bySessionPhase: Readonly<Record<SessionPhase, number>>;
  readonly totalTokensLost: number;
  readonly totalEstimatedCostLostUsd: number;
  readonly meanTimeToRecoveryMs: number | null;
  readonly throttleAlerts: readonly ThrottleAlert[];
  readonly recentFailures: readonly ApiFailureEvent[];
}

export interface ApiFailureTrackerOptions {
  readonly throttleAlertThreshold?: number;
  readonly throttleAlertWindowMinutes?: number;
  readonly maxEvents?: number;
  readonly costPerTokenUsd?: number;
  readonly onThrottleAlert?: (alert: ThrottleAlert) => void;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_THROTTLE_THRESHOLD = 3;
const DEFAULT_THROTTLE_WINDOW_MINUTES = 10;
const DEFAULT_MAX_EVENTS = 500;
const DEFAULT_COST_PER_TOKEN_USD = 0.000003;

// ---------------------------------------------------------------------------
// ApiFailureTracker
// ---------------------------------------------------------------------------

export class ApiFailureTracker {
  private readonly throttleThreshold: number;
  private readonly throttleWindowMinutes: number;
  private readonly maxEvents: number;
  private readonly costPerTokenUsd: number;
  private readonly onThrottleAlert: ((alert: ThrottleAlert) => void) | null;

  private readonly events: ApiFailureEvent[] = [];
  private readonly throttleAlerts: ThrottleAlert[] = [];
  private totalRequests = 0;
  private readonly latenciesByModel = new Map<string, number[]>();

  constructor(options?: ApiFailureTrackerOptions) {
    this.throttleThreshold = options?.throttleAlertThreshold ?? DEFAULT_THROTTLE_THRESHOLD;
    this.throttleWindowMinutes = options?.throttleAlertWindowMinutes ?? DEFAULT_THROTTLE_WINDOW_MINUTES;
    this.maxEvents = options?.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.costPerTokenUsd = options?.costPerTokenUsd ?? DEFAULT_COST_PER_TOKEN_USD;
    this.onThrottleAlert = options?.onThrottleAlert ?? null;
  }

  recordRequest(model: string, latencyMs: number): void {
    this.totalRequests++;
    const arr = this.latenciesByModel.get(model) ?? [];
    arr.push(latencyMs);
    if (arr.length > this.maxEvents) {
      arr.shift();
    }
    this.latenciesByModel.set(model, arr);
  }

  recordFailure(event: {
    errorType: ApiErrorType;
    model: string;
    turnNumber: number;
    tokensInFlight: number;
    recoveryMs?: number | null;
    retryCount?: number;
    recoverySucceeded?: boolean | null;
    totalTurnsInSession?: number;
    duringToolExecution?: boolean;
  }): ApiFailureEvent {
    const totalTurns = event.totalTurnsInSession ?? 30;
    const phase = this.computePhase(event.turnNumber, totalTurns);

    const failure: ApiFailureEvent = {
      errorType: event.errorType,
      model: event.model,
      timestamp: Date.now(),
      turnNumber: event.turnNumber,
      tokensInFlight: event.tokensInFlight,
      recoveryMs: event.recoveryMs ?? null,
      retryCount: event.retryCount ?? 0,
      recoverySucceeded: event.recoverySucceeded ?? null,
      sessionPhase: phase,
      duringToolExecution: event.duringToolExecution ?? false,
    };

    this.events.push(failure);
    if (this.events.length > this.maxEvents) {
      this.events.shift();
    }

    this.checkThrottleRate(event.model);

    return failure;
  }

  getMetrics(): ApiFailureMetrics {
    const byErrorType: Record<ApiErrorType, number> = {
      rate_limit: 0,
      timeout: 0,
      connection_error: 0,
      server_error: 0,
      context_length_exceeded: 0,
      authentication: 0,
      unknown: 0,
    };

    const byPhase: Record<SessionPhase, number> = { early: 0, middle: 0, late: 0 };
    let totalTokensLost = 0;
    const recoveryTimes: number[] = [];

    for (const event of this.events) {
      byErrorType[event.errorType]++;
      byPhase[event.sessionPhase]++;
      totalTokensLost += event.tokensInFlight;
      if (event.recoveryMs !== null) {
        recoveryTimes.push(event.recoveryMs);
      }
    }

    const meanRecovery = recoveryTimes.length > 0
      ? Math.round(recoveryTimes.reduce((a, b) => a + b, 0) / recoveryTimes.length)
      : null;

    return {
      totalFailures: this.events.length,
      byErrorType,
      byModel: this.computeModelScorecards(),
      bySessionPhase: byPhase,
      totalTokensLost,
      totalEstimatedCostLostUsd: Math.round(totalTokensLost * this.costPerTokenUsd * 10000) / 10000,
      meanTimeToRecoveryMs: meanRecovery,
      throttleAlerts: this.throttleAlerts,
      recentFailures: this.events.slice(-20),
    };
  }

  emitMetrics(aggregator: MetricAggregator): void {
    const metrics = this.getMetrics();
    aggregator.record('ai.api.failures_total', metrics.totalFailures);
    aggregator.record('ai.api.tokens_lost', metrics.totalTokensLost);

    for (const [type, count] of Object.entries(metrics.byErrorType)) {
      if (count > 0) {
        aggregator.record('ai.api.failure_by_type', count, { error_type: type });
      }
    }

    for (const [model, scorecard] of Object.entries(metrics.byModel)) {
      aggregator.record('ai.api.model_failure_rate', scorecard.failureRate, { model });
      if (scorecard.meanRecoveryMs !== null) {
        aggregator.record('ai.api.model_mean_recovery_ms', scorecard.meanRecoveryMs, { model });
      }
    }
  }

  reset(_sessionId: string): void {
    this.events.length = 0;
    this.throttleAlerts.length = 0;
    this.totalRequests = 0;
    this.latenciesByModel.clear();
  }

  private computePhase(turnNumber: number, totalTurns: number): SessionPhase {
    const ratio = turnNumber / totalTurns;
    if (ratio <= 0.33) return 'early';
    if (ratio <= 0.67) return 'middle';
    return 'late';
  }

  private checkThrottleRate(model: string): void {
    const windowMs = this.throttleWindowMinutes * 60 * 1000;
    const now = Date.now();

    const recentThrottles = this.events.filter(
      (e) =>
        e.model === model &&
        e.errorType === 'rate_limit' &&
        now - e.timestamp <= windowMs,
    );

    if (recentThrottles.length >= this.throttleThreshold) {
      // Dedupe: don't fire if we already alerted for this model in this window
      const alreadyAlerted = this.throttleAlerts.some(
        (a) => a.model === model && now - a.timestamp <= windowMs,
      );
      if (alreadyAlerted) return;

      const alert: ThrottleAlert = {
        model,
        count: recentThrottles.length,
        windowMinutes: this.throttleWindowMinutes,
        timestamp: now,
      };

      this.throttleAlerts.push(alert);
      logger.warn('Throttle rate exceeded', {
        model,
        count: alert.count,
        windowMinutes: alert.windowMinutes,
      });

      if (this.onThrottleAlert) {
        this.onThrottleAlert(alert);
      }
    }
  }

  private computeModelScorecards(): Record<string, ModelReliabilityScorecard> {
    const scorecards: Record<string, ModelReliabilityScorecard> = {};

    // Group events by model
    const eventsByModel = new Map<string, ApiFailureEvent[]>();
    for (const event of this.events) {
      const arr = eventsByModel.get(event.model) ?? [];
      arr.push(event);
      eventsByModel.set(event.model, arr);
    }

    for (const [model, modelEvents] of eventsByModel) {
      const latencies = this.latenciesByModel.get(model) ?? [];
      const sortedLatencies = [...latencies].sort((a, b) => a - b);
      const totalModelRequests = latencies.length || modelEvents.length;

      const throttles = modelEvents.filter((e) => e.errorType === 'rate_limit');
      const recoveryTimes = modelEvents
        .map((e) => e.recoveryMs)
        .filter((r): r is number => r !== null);
      const tokensLost = modelEvents.reduce((sum, e) => sum + e.tokensInFlight, 0);

      scorecards[model] = {
        model,
        totalRequests: totalModelRequests,
        failureCount: modelEvents.length,
        failureRate: totalModelRequests > 0
          ? Math.round((modelEvents.length / totalModelRequests) * 1000) / 1000
          : 0,
        throttleCount: throttles.length,
        throttleFrequency: totalModelRequests > 0
          ? Math.round((throttles.length / totalModelRequests) * 1000) / 1000
          : 0,
        meanRecoveryMs: recoveryTimes.length > 0
          ? Math.round(recoveryTimes.reduce((a, b) => a + b, 0) / recoveryTimes.length)
          : null,
        p95LatencyMs: sortedLatencies.length > 0
          ? (computePercentile(sortedLatencies, 0.95) ?? null)
          : null,
        tokensLost,
        estimatedCostLostUsd: Math.round(tokensLost * this.costPerTokenUsd * 10000) / 10000,
      };
    }

    return scorecards;
  }
}
