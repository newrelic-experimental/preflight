import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';

import { createLogger } from '../logger.js';
import type { NrMetric, NrGaugeMetric, NrCountMetric, NrSummaryMetric } from './types.js';
import {
  validateOtlpEndpoint,
  hasOtlpAuthHeader,
  DEFAULT_CLIENT_NAME,
  buildUserAgent,
  sanitizeClientString,
} from './otlp-shared.js';

const gzipAsync = promisify(gzip);

const logger = createLogger('otlp-transport');

export interface OtlpTransportOptions {
  readonly endpoint: string;
  readonly headers?: Record<string, string>;
  readonly appName: string;
  /** Override the default 30-second request timeout for exportMetrics. */
  readonly requestTimeoutMs?: number;
  /**
   * Identifies the consuming client in the `User-Agent` header and as the
   * OTel instrumentation scope name. Defaults to
   * `'ai-telemetry'` when not provided. Pass `'preflight'`, `'nr-ai-agent'`,
   * etc. so telemetry from different consumers is distinguishable.
   */
  readonly clientName?: string;
  /** Version of the consuming client, stamped as the OTel instrumentation scope version. */
  readonly clientVersion?: string;
}

export class OtlpTransport {
  private readonly traceExporter: OTLPTraceExporter;
  private readonly metricExporter: OTLPMetricExporter;
  private readonly tracerProvider: BasicTracerProvider;
  private readonly meterProvider: MeterProvider;
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  private readonly requestTimeoutMs: number;
  private readonly clientVersion: string;
  private readonly userAgent: string;
  private readonly hasAuth: boolean;
  private hasWarnedNoAuth = false;
  private readonly otlpResource: ReadonlyArray<{ key: string; value: { stringValue: string } }>;
  private readonly otlpScope: { readonly name: string; readonly version?: string };
  private readonly metricsHeaders: Readonly<Record<string, string>>;

  constructor(options: OtlpTransportOptions) {
    validateOtlpEndpoint(options.endpoint, 'OtlpTransport');

    const clientName = sanitizeClientString(options.clientName, DEFAULT_CLIENT_NAME);
    this.clientVersion = sanitizeClientString(options.clientVersion, '');
    this.userAgent = buildUserAgent(clientName, this.clientVersion);
    const resourceAttributes = Object.freeze({ 'service.name': options.appName });
    this.otlpResource = Object.entries(resourceAttributes).map(([key, value]) => ({
      key,
      value: { stringValue: value },
    }));
    this.otlpScope = this.clientVersion
      ? { name: clientName, version: this.clientVersion }
      : { name: clientName };
    const resource = resourceFromAttributes({ ...resourceAttributes });

    this.endpoint = options.endpoint;
    this.headers = { ...(options.headers ?? {}) };
    this.hasAuth = hasOtlpAuthHeader(this.headers);
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.metricsHeaders = Object.freeze({
      ...this.headers,
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
      'User-Agent': this.userAgent,
    });

    const sdkHeaders = { ...this.headers, 'User-Agent': this.userAgent };

    this.traceExporter = new OTLPTraceExporter({
      url: `${options.endpoint}/v1/traces`,
      headers: sdkHeaders,
    });

    this.metricExporter = new OTLPMetricExporter({
      url: `${options.endpoint}/v1/metrics`,
      headers: sdkHeaders,
    });

    this.tracerProvider = new BasicTracerProvider({
      resource,
      spanProcessors: [new BatchSpanProcessor(this.traceExporter)],
    });

    this.meterProvider = new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter: this.metricExporter,
          exportIntervalMillis: 60_000,
        }),
      ],
    });
  }

  async flush(): Promise<void> {
    await this.settledOrThrow(
      [this.tracerProvider.forceFlush(), this.meterProvider.forceFlush()],
      'OTLP flush failed on multiple providers',
    );
  }

  async shutdown(): Promise<void> {
    await this.settledOrThrow(
      [this.tracerProvider.shutdown(), this.meterProvider.shutdown()],
      'OTLP shutdown failed on multiple providers',
    );
  }

  private async settledOrThrow(ops: Promise<void>[], message: string): Promise<void> {
    const results = await Promise.allSettled(ops);
    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => (r.reason instanceof Error ? r.reason : new Error(String(r.reason))));
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, message);
  }

  /**
   * Return an OTel `Tracer` for the given instrumentation name. The returned
   * value is the `Tracer` interface from `@opentelemetry/api`;
   * consumers that bind to the type explicitly should
   * `import type { Tracer } from '@opentelemetry/api'`. `@opentelemetry/api`
   * is already a regular dependency of this package, so no extra install is
   * required. The type is intentionally NOT re-exported from this package's
   * public surface — keeping the public API minimal so consumers that never
   * use OTel tracing don't see an OTel-shaped type graph leaking through
   * unrelated imports.
   */
  getTracer(name: string) {
    return this.tracerProvider.getTracer(name, this.clientVersion || undefined);
  }

  /**
   * Return an OTel `Meter` for the given instrumentation name. See
   * {@link getTracer} for the dependency story; same rules apply
   * (`import type { Meter } from '@opentelemetry/api'`).
   */
  getMeter(name: string) {
    return this.meterProvider.getMeter(name, this.clientVersion || undefined);
  }

  async exportMetrics(metrics: NrMetric[]): Promise<void> {
    if (metrics.length === 0) return;

    // Warn ONCE when no auth header is present — emitting on every call would
    // flood stderr with identical lines in long-running agents.
    if (!this.hasAuth && !this.hasWarnedNoAuth) {
      this.hasWarnedNoAuth = true;
      logger.warn('OTLP metric export attempted with no auth header — collector may reject', {
        endpoint: this.endpoint,
      });
    }

    const payload = {
      resourceMetrics: [
        {
          resource: { attributes: this.otlpResource },
          scopeMetrics: [
            {
              scope: this.otlpScope,
              metrics: metrics.map((m) => this.otlpMetric(m)),
            },
          ],
        },
      ],
    };

    // exportMetrics MUST surface failures so
    // HarvestScheduler.sendMetricsToOtlp can catch and requeue into
    // retryOtlpMetricBatch. Previously this method swallowed errors with
    // a logger.warn and resolved successfully, which silently dropped
    // every OTLP metric failure and made the scheduler's per-OTLP retry
    // buffer dead code. Note this is asymmetric with OTLP *events*: the
    // event path goes through OtlpEventBridge → BatchLogRecordProcessor,
    // which retries internally inside the OTel SDK, so the scheduler-
    // level retry queue is rarely engaged for events. For metrics, we
    // intentionally rely on the scheduler's retry queue instead — there
    // is no PeriodicExportingMetricReader in this code path.
    // Gzip-compress the payload to match sendWithRetry. The NR OTLP
    // endpoint accepts gzip; for large metric batches this is a 5-10× size win.
    const compressed = await (gzipAsync(JSON.stringify(payload)) as Promise<Buffer>);
    const response = await fetch(`${this.endpoint}/v1/metrics`, {
      method: 'POST',
      headers: this.metricsHeaders,
      body: compressed as unknown as BodyInit,
      signal: AbortSignal.timeout(this.requestTimeoutMs),
      // see http-client.ts for rationale.
      keepalive: true,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const msg = `OTLP metric export failed: HTTP ${response.status}${body ? ` — ${body.slice(0, 256)}` : ''}`;
      // 400 means the payload itself is malformed — retrying the same payload
      // will always fail, so surface this as a distinct non-retryable error.
      if (response.status === 400) {
        throw Object.assign(new Error(msg), { code: 'OTLP_BAD_REQUEST' });
      }
      throw new Error(msg);
    }
    // Drain on success so undici returns the socket to the keep-alive pool.
    await response.body?.cancel().catch(() => {});
  }

  private otlpAttributes(attrs: NrMetric['attributes']) {
    return Object.entries(attrs ?? {}).map(([key, value]) => ({
      key,
      value:
        typeof value === 'number'
          ? { doubleValue: value }
          : typeof value === 'boolean'
            ? { boolValue: value }
            : { stringValue: String(value) },
    }));
  }

  private numericDataPoint(m: NrGaugeMetric | NrCountMetric) {
    return {
      // For count (delta Sum) metrics, include startTimeUnixNano per the OTLP
      // spec. Gauge data points do not require it but it is harmless.
      // Clamp to 0: if timestamp < intervalMs (misconfigured metric), a negative
      // startTimeUnixNano would be rejected by strict OTLP collectors.
      startTimeUnixNano:
        m.type === 'count' ? Math.max(0, m.timestamp - m.intervalMs) * 1_000_000 : undefined,
      timeUnixNano: m.timestamp * 1_000_000,
      asDouble: m.value,
      attributes: this.otlpAttributes(m.attributes),
    };
  }

  // summary is now a first-class type with a structured
  // value `{ count, sum, min, max }`. OTLP doesn't have a single
  // "Summary"-shaped metric kind; the closest faithful mapping is OTLP
  // Histogram with explicit `count` and `sum` fields plus per-data-point
  // `min` / `max`. Bucket boundaries are intentionally omitted: NR doesn't
  // need them for summary aggregation, and emitting empty `bucketCounts`
  // alongside `min`/`max` is the documented OTLP shape for unbucketed
  // summaries (`explicitBounds: []`, `bucketCounts: [<count>]`).
  private summaryDataPoint(m: NrSummaryMetric) {
    return {
      // OTLP Histogram with DELTA temporality requires startTimeUnixNano.
      startTimeUnixNano: Math.max(0, m.timestamp - m.intervalMs) * 1_000_000,
      timeUnixNano: m.timestamp * 1_000_000,
      attributes: this.otlpAttributes(m.attributes),
      count: m.value.count,
      sum: m.value.sum,
      min: m.value.min,
      max: m.value.max,
      bucketCounts: [m.value.count],
      explicitBounds: [],
    };
  }

  // Map NrMetric.type → OTLP metric kind:
  //   - `gauge`   → OTLP Gauge (point-in-time numeric value)
  //   - `count`   → OTLP Sum (monotonic, DELTA aggregation temporality = 1).
  //     NrCountMetric carries intervalMs — it represents a bounded-interval
  //     delta, not a cumulative running total. Using CUMULATIVE (2) would
  //     cause downstream collectors to treat each harvest as a monotonically-
  //     increasing total, producing incorrect rate calculations.
  //   - `summary` → OTLP Histogram (with explicit min/max/sum/count fields,
  //     no buckets) — see note above on why histogram is the closest
  //     faithful mapping.
  private otlpMetric(m: NrMetric) {
    if (m.type === 'count') {
      return {
        name: m.name,
        sum: {
          dataPoints: [this.numericDataPoint(m)],
          // 1 = DELTA — the value represents the count within intervalMs,
          // not a cumulative total from a fixed epoch.
          aggregationTemporality: 1,
          isMonotonic: true,
        },
      };
    }
    if (m.type === 'summary') {
      return {
        name: m.name,
        histogram: {
          dataPoints: [this.summaryDataPoint(m)],
          // Aggregation temporality 1 = DELTA (the count/sum/min/max
          // describe the harvest interval, not a cumulative total).
          aggregationTemporality: 1,
        },
      };
    }
    return { name: m.name, gauge: { dataPoints: [this.numericDataPoint(m)] } };
  }
}
