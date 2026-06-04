import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { createLogger } from '../logger.js';
import type { NrMetric, NrGaugeMetric, NrCountMetric, NrSummaryMetric } from './types.js';
import { validateOtlpEndpoint, hasOtlpAuthHeader } from './otlp-shared.js';
import { VERSION } from '../version.js';

const gzipAsync = promisify(gzip);

/** CODE_REVIEW §10.7 — identify this library on the OTLP collector side. */
const USER_AGENT = `nr-ai-observatory-shared/${VERSION}`;

const logger = createLogger('otlp-transport');

export interface OtlpTransportOptions {
  endpoint: string;
  headers?: Record<string, string>;
  appName: string;
  /** Override the default 30-second request timeout for exportMetrics (§TR7). */
  requestTimeoutMs?: number;
}

export class OtlpTransport {
  private readonly traceExporter: OTLPTraceExporter;
  private readonly metricExporter: OTLPMetricExporter;
  private readonly tracerProvider: BasicTracerProvider;
  private readonly meterProvider: MeterProvider;
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  private readonly requestTimeoutMs: number;
  private hasWarnedNoAuth = false;
  /**
   * Resource attributes shared by both the SDK-driven path (tracer/meter
   * providers) and the manual `exportMetrics` payload (CODE_REVIEW §5.22).
   * Keeping a single resolved attribute map prevents `service.name` from
   * drifting between the two paths — previously `this.appName` was stored
   * separately and re-encoded into the OTLP envelope, which would silently
   * diverge if anyone added a second resource attribute.
   */
  private readonly resourceAttributes: Readonly<Record<string, string>>;

  constructor(options: OtlpTransportOptions) {
    validateOtlpEndpoint(options.endpoint, 'OtlpTransport');

    this.resourceAttributes = Object.freeze({ 'service.name': options.appName });
    const resource = resourceFromAttributes({ ...this.resourceAttributes });

    this.endpoint = options.endpoint;
    this.headers = options.headers ?? {};
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;

    this.traceExporter = new OTLPTraceExporter({
      url: `${options.endpoint}/v1/traces`,
      headers: options.headers ?? {},
    });

    this.metricExporter = new OTLPMetricExporter({
      url: `${options.endpoint}/v1/metrics`,
      headers: options.headers ?? {},
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
    await this.tracerProvider.forceFlush();
    await this.meterProvider.forceFlush();
  }

  async shutdown(): Promise<void> {
    await this.tracerProvider.shutdown();
    await this.meterProvider.shutdown();
  }

  /**
   * Return an OTel `Tracer` for the given instrumentation name. The returned
   * value is the `Tracer` interface from `@opentelemetry/api`
   * (CODE_REVIEW §8.6); consumers that bind to the type explicitly should
   * `import type { Tracer } from '@opentelemetry/api'`. `@opentelemetry/api`
   * is already a regular dependency of this package, so no extra install is
   * required. The type is intentionally NOT re-exported from this package's
   * public surface — keeping the public API minimal so consumers that never
   * use OTel tracing don't see an OTel-shaped type graph leaking through
   * unrelated imports.
   */
  getTracer(name: string) {
    return this.tracerProvider.getTracer(name);
  }

  /**
   * Return an OTel `Meter` for the given instrumentation name. See
   * {@link getTracer} for the dependency story; same rules apply
   * (`import type { Meter } from '@opentelemetry/api'`).
   */
  getMeter(name: string) {
    return this.meterProvider.getMeter(name);
  }

  async exportMetrics(metrics: NrMetric[]): Promise<void> {
    if (metrics.length === 0) return;

    // Warn ONCE when no auth header is present — emitting on every call would
    // flood stderr with identical lines in long-running agents (§TR1).
    if (!hasOtlpAuthHeader(this.headers) && !this.hasWarnedNoAuth) {
      this.hasWarnedNoAuth = true;
      logger.warn('OTLP metric export attempted with no auth header — collector may reject', {
        endpoint: this.endpoint,
      });
    }

    const otlpAttributes = (attrs: NrMetric['attributes']) =>
      Object.entries(attrs ?? {}).map(([key, value]) => ({
        key,
        value:
          typeof value === 'number'
            ? { doubleValue: value }
            : typeof value === 'boolean'
              ? { boolValue: value }
              : { stringValue: String(value) },
      }));

    const numericDataPoint = (m: NrGaugeMetric | NrCountMetric) => ({
      // For count (delta Sum) metrics, include startTimeUnixNano per the OTLP
      // spec (§TR2). Gauge data points do not require it but it is harmless.
      // Clamp to 0: if timestamp < intervalMs (misconfigured metric), a negative
      // startTimeUnixNano would be rejected by strict OTLP collectors (§TR7).
      startTimeUnixNano:
        m.type === 'count' ? Math.max(0, m.timestamp - m.intervalMs) * 1_000_000 : undefined,
      timeUnixNano: m.timestamp * 1_000_000,
      asDouble: m.value,
      attributes: otlpAttributes(m.attributes),
    });

    // CODE_REVIEW §4.9 — summary is now a first-class type with a structured
    // value `{ count, sum, min, max }`. OTLP doesn't have a single
    // "Summary"-shaped metric kind; the closest faithful mapping is OTLP
    // Histogram with explicit `count` and `sum` fields plus per-data-point
    // `min` / `max`. Bucket boundaries are intentionally omitted: NR doesn't
    // need them for summary aggregation, and emitting empty `bucketCounts`
    // alongside `min`/`max` is the documented OTLP shape for unbucketed
    // summaries (`explicitBounds: []`, `bucketCounts: [<count>]`).
    const summaryDataPoint = (m: NrSummaryMetric) => ({
      // OTLP Histogram with DELTA temporality requires startTimeUnixNano (§TR2).
      startTimeUnixNano: Math.max(0, m.timestamp - m.intervalMs) * 1_000_000,
      timeUnixNano: m.timestamp * 1_000_000,
      attributes: otlpAttributes(m.attributes),
      count: m.value.count,
      sum: m.value.sum,
      min: m.value.min,
      max: m.value.max,
      bucketCounts: [m.value.count],
      explicitBounds: [],
    });

    // Map NrMetric.type → OTLP metric kind:
    //   - `gauge`   → OTLP Gauge (point-in-time numeric value)
    //   - `count`   → OTLP Sum (monotonic, DELTA aggregation temporality = 1).
    //     NrCountMetric carries intervalMs — it represents a bounded-interval
    //     delta, not a cumulative running total. Using CUMULATIVE (2) would
    //     cause downstream collectors to treat each harvest as a monotonically-
    //     increasing total, producing incorrect rate calculations (§TR1).
    //   - `summary` → OTLP Histogram (with explicit min/max/sum/count fields,
    //     no buckets) — see §4.9 note above on why histogram is the closest
    //     faithful mapping.
    const otlpMetric = (m: NrMetric) => {
      if (m.type === 'count') {
        return {
          name: m.name,
          sum: {
            dataPoints: [numericDataPoint(m)],
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
            dataPoints: [summaryDataPoint(m)],
            // Aggregation temporality 1 = DELTA (the count/sum/min/max
            // describe the harvest interval, not a cumulative total).
            aggregationTemporality: 1,
          },
        };
      }
      return { name: m.name, gauge: { dataPoints: [numericDataPoint(m)] } };
    };

    const payload = {
      resourceMetrics: [
        {
          resource: {
            attributes: Object.entries(this.resourceAttributes).map(([key, value]) => ({
              key,
              value: { stringValue: value },
            })),
          },
          scopeMetrics: [
            {
              scope: { name: 'nr-ai-observatory' },
              metrics: metrics.map(otlpMetric),
            },
          ],
        },
      ],
    };

    // CODE_REVIEW §4.17 — exportMetrics MUST surface failures so
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
    // Gzip-compress the payload to match sendWithRetry (§TR3). The NR OTLP
    // endpoint accepts gzip; for large metric batches this is a 5-10× size win.
    const compressed = await (gzipAsync(JSON.stringify(payload)) as Promise<Buffer>);
    const response = await fetch(`${this.endpoint}/v1/metrics`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
        'User-Agent': USER_AGENT,
        ...this.headers,
      },
      body: compressed as unknown as BodyInit,
      signal: AbortSignal.timeout(this.requestTimeoutMs),
      // §5.20 — see http-client.ts for rationale.
      keepalive: true,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const msg = `OTLP metric export failed: HTTP ${response.status}${body ? ` — ${body.slice(0, 256)}` : ''}`;
      // 400 means the payload itself is malformed — retrying the same payload
      // will always fail, so surface this as a distinct non-retryable error (§TR9).
      if (response.status === 400) {
        throw Object.assign(new Error(msg), { code: 'OTLP_BAD_REQUEST' });
      }
      throw new Error(msg);
    }
    // Drain on success so undici returns the socket to the keep-alive pool (§HC1).
    await response.body?.cancel().catch(() => {});
  }
}
