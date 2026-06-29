/**
 * Selects which downstream transport(s) the harvest scheduler ships to.
 * Single source of truth for the literal union — both
 * `AgentConfig.transport` and `HarvestSchedulerOptions.transport` consume
 * this type so a future addition (e.g. a Datadog transport) only needs to
 * widen the union here.
 *
 * **This is a TypeScript-only type alias, not a runtime value.** Consumers
 * import it with `import type { TransportMode } from '@newrelic/ai-telemetry'`
 * and pass the bare string literals at runtime — `transport: 'otlp'` rather
 * than `transport: TransportMode.OTLP`. There is no enum-like object to
 * dot-access; a runtime membership check should compare against the
 * literal strings directly (see `envTransport()` in `src/config.ts` for
 * the canonical narrowing pattern).
 *
 * - `'nr-events-api'` — stream NR events through the dedicated Events API
 *   and metrics through the Metric API. Default. Lowest-latency path for
 *   `AiRequest` / `AiResponse` style events.
 * - `'otlp'`           — stream the same data over OTLP/HTTP, both spans
 *   (events bridged via `OtlpEventBridge`) and metrics. Pick this when the
 *   collector is an OTel-native one or when the consumer wants spans
 *   instead of NR custom events.
 * - `'both'`           — fan out to NR Events API AND OTLP. Each transport
 *   keeps its own retry buffer; a NR-side failure does not double-send to
 *   OTLP.
 */
export type TransportMode = 'nr-events-api' | 'otlp' | 'both';

/**
 * Wire-format value for an `NrMetric` of type `'summary'`.
 * Mirrors the NR Metric API summary shape exactly.
 */
export interface NrMetricSummaryValue {
  readonly count: number;
  readonly sum: number;
  readonly min: number;
  readonly max: number;
}

/**
 * Common fields on every NR metric type.
 *
 * NB: when serialized to the wire, `intervalMs` becomes the JSON key
 * `'interval.ms'` per NR's Metric API contract — see `sendMetrics` in
 * `metric-api.ts` for the per-metric rename. The TypeScript identifier
 * is camelCased to keep call sites idiomatic.
 */
export interface NrMetricBase {
  readonly name: string;
  readonly timestamp: number;
  readonly attributes?: Record<string, string | number | boolean>;
  /**
   * Interval (ms) over which the count or summary was sampled. Required for
   * `count` and `summary` metric types per NR's Metric API; ignored for
   * `gauge` (point-in-time) metrics. Renamed to `interval.ms` on the wire.
   */
  readonly intervalMs?: number;
}

/** Point-in-time gauge metric. */
export interface NrGaugeMetric extends NrMetricBase {
  readonly type: 'gauge';
  readonly value: number;
}

/**
 * Delta-count metric over the interval window. NR treats `count` as the
 * number of events observed during `intervalMs`.
 */
export interface NrCountMetric extends NrMetricBase {
  readonly type: 'count';
  readonly value: number;
  readonly intervalMs: number;
}

/**
 * Pre-aggregated summary metric — `count`, `sum`, `min`, `max` over the
 * interval window. One summary metric replaces what would otherwise be four
 * separate `.count` / `.sum` / `.min` / `.max` data points,
 * halving payload cardinality and matching NR's NRQL ergonomics.
 */
export interface NrSummaryMetric extends NrMetricBase {
  readonly type: 'summary';
  readonly value: NrMetricSummaryValue;
  readonly intervalMs: number;
}

export type NrMetric = NrGaugeMetric | NrCountMetric | NrSummaryMetric;

export interface TransportOptions {
  /** NR account ID — required for Events API URL path. */
  readonly accountId: string;
  /** Override collector host; used for EU region routing or custom endpoints. */
  readonly collectorHost?: string | null;
  /** Max retry attempts for retryable errors. Default: 3. */
  readonly maxRetries?: number;
  /** Base delay in ms for exponential backoff. Default: 1000. */
  readonly baseDelayMs?: number;
  /** Maximum delay in ms for backoff cap. Default: 30000. */
  readonly maxDelayMs?: number;
  /**
   * Per-request timeout in ms — aborts the in-flight fetch and lets the
   * retry/backoff machinery handle it. Default: 30000.
   *
   * Without this, a hung TCP connection stalls the entire harvest loop
   * indefinitely with no recovery.
   */
  readonly requestTimeoutMs?: number;
  /**
   * Identifies the consuming client in the `User-Agent` header sent to NR
   * ingest endpoints (e.g. `'preflight'`, `'nr-ai-agent'`). Defaults to
   * `'ai-telemetry'` when not provided.
   */
  readonly clientName?: string;
  /** Version of the consuming client for the `User-Agent` header. */
  readonly clientVersion?: string;
}

export interface TransportResult {
  readonly success: boolean;
  readonly statusCode: number | null;
  readonly retryCount: number;
  readonly error?: string;
}

export interface HttpSendOptions {
  readonly url: string;
  readonly body: unknown;
  readonly licenseKey: string;
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly requestTimeoutMs: number;
  /**
   * Identifies the consuming client in the `User-Agent` header. Defaults to
   * `'ai-telemetry'` when not provided.
   */
  readonly clientName?: string;
  /** Version of the consuming client for the `User-Agent` header. */
  readonly clientVersion?: string;
}
