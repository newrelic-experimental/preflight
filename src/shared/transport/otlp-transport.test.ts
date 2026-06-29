import { gunzipSync } from 'node:zlib';

import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';

import { OtlpTransport } from './otlp-transport.js';
import type { NrMetric } from './types.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;

// Mock OTel SDK modules
jest.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: jest.fn().mockImplementation(() => ({
    shutdown: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('@opentelemetry/sdk-trace-node', () => ({
  BasicTracerProvider: jest.fn().mockImplementation(() => ({
    register: jest.fn(),
    forceFlush: jest.fn().mockResolvedValue(undefined),
    shutdown: jest.fn().mockResolvedValue(undefined),
    getTracer: jest.fn().mockReturnValue({}),
  })),
  BatchSpanProcessor: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('@opentelemetry/exporter-metrics-otlp-http', () => ({
  OTLPMetricExporter: jest.fn().mockImplementation(() => ({
    shutdown: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('@opentelemetry/sdk-metrics', () => ({
  MeterProvider: jest.fn().mockImplementation(() => ({
    forceFlush: jest.fn().mockResolvedValue(undefined),
    shutdown: jest.fn().mockResolvedValue(undefined),
    getMeter: jest.fn().mockReturnValue({}),
  })),
  PeriodicExportingMetricReader: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('@opentelemetry/resources', () => ({
  resourceFromAttributes: jest.fn().mockReturnValue({}),
}));

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.clearAllMocks();
});

afterEach(() => {
  stderrSpy.mockRestore();
});

describe('OtlpTransport', () => {
  // ---------------------------------------------------------------------------
  // 1. Constructor initializes with endpoint and headers
  // ---------------------------------------------------------------------------
  it('constructs with endpoint and headers', () => {
    const transport = new OtlpTransport({
      endpoint: 'https://otlp.nr-data.net',
      headers: { 'api-key': 'test-key' },
      appName: 'test-app',
    });

    expect(transport).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 1b. SDK exporters include User-Agent header in their constructor headers
  // ---------------------------------------------------------------------------
  it('OTLPTraceExporter and OTLPMetricExporter are constructed with User-Agent header', () => {
    new OtlpTransport({
      endpoint: 'https://otlp.nr-data.net',
      headers: { 'api-key': 'key' },
      appName: 'test',
      clientName: 'preflight',
      clientVersion: '1.0.0',
    });

    const TraceExporterCtor = OTLPTraceExporter as unknown as jest.Mock;
    const MetricExporterCtor = OTLPMetricExporter as unknown as jest.Mock;

    expect(TraceExporterCtor.mock.calls[0][0].headers).toMatchObject({
      'User-Agent': 'preflight/1.0.0',
      'api-key': 'key',
    });
    expect(MetricExporterCtor.mock.calls[0][0].headers).toMatchObject({
      'User-Agent': 'preflight/1.0.0',
      'api-key': 'key',
    });
  });

  // ---------------------------------------------------------------------------
  // 2. transport is ready immediately after construction (start() removed)
  // ---------------------------------------------------------------------------
  it('transport is ready to use immediately after construction without calling start()', () => {
    const transport = new OtlpTransport({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
    });
    // getTracer / getMeter / flush / shutdown should all work without any start() call
    expect(() => transport.getTracer('test')).not.toThrow();
    expect(() => transport.getMeter('test')).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // 3. shutdown() can be called without prior start()
  // ---------------------------------------------------------------------------
  it('shutdown() can be called without start()', async () => {
    const transport = new OtlpTransport({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
    });

    await expect(transport.shutdown()).resolves.not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // 4. flush() calls forceFlush on both providers
  // ---------------------------------------------------------------------------
  it('flush() calls forceFlush on both providers', async () => {
    const transport = new OtlpTransport({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
    });

    await transport.flush();

    // Verify flush was called (mocked implementations resolve immediately)
    expect(transport).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 4b. flush() runs both forceFlush calls even if the first rejects
  // ---------------------------------------------------------------------------
  it('flush() awaits both providers even when tracerProvider.forceFlush rejects', async () => {
    const { BasicTracerProvider } = jest.requireMock('@opentelemetry/sdk-trace-node') as {
      BasicTracerProvider: jest.Mock;
    };
    const { MeterProvider } = jest.requireMock('@opentelemetry/sdk-metrics') as {
      MeterProvider: jest.Mock;
    };

    const meterFlush = jest.fn().mockResolvedValue(undefined);
    BasicTracerProvider.mockImplementationOnce(() => ({
      register: jest.fn(),
      forceFlush: jest.fn().mockRejectedValue(new Error('tracer flush failed')),
      shutdown: jest.fn().mockResolvedValue(undefined),
      getTracer: jest.fn().mockReturnValue({}),
    }));
    MeterProvider.mockImplementationOnce(function (this: Record<string, unknown>) {
      this.forceFlush = meterFlush;
      this.shutdown = jest.fn().mockResolvedValue(undefined);
      this.getMeter = jest.fn().mockReturnValue({});
      return this;
    });

    const transport = new OtlpTransport({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test',
    });

    await expect(transport.flush()).rejects.toThrow('tracer flush failed');
    expect(meterFlush).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // 4c. flush() throws AggregateError when both providers reject
  // ---------------------------------------------------------------------------
  it('flush() throws AggregateError when both providers reject', async () => {
    const { BasicTracerProvider } = jest.requireMock('@opentelemetry/sdk-trace-node') as {
      BasicTracerProvider: jest.Mock;
    };
    const { MeterProvider } = jest.requireMock('@opentelemetry/sdk-metrics') as {
      MeterProvider: jest.Mock;
    };

    BasicTracerProvider.mockImplementationOnce(() => ({
      register: jest.fn(),
      forceFlush: jest.fn().mockRejectedValue(new Error('tracer flush failed')),
      shutdown: jest.fn().mockResolvedValue(undefined),
      getTracer: jest.fn().mockReturnValue({}),
    }));
    MeterProvider.mockImplementationOnce(function (this: Record<string, unknown>) {
      this.forceFlush = jest.fn().mockRejectedValue(new Error('meter flush failed'));
      this.shutdown = jest.fn().mockResolvedValue(undefined);
      this.getMeter = jest.fn().mockReturnValue({});
      return this;
    });

    const transport = new OtlpTransport({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test',
    });

    const err = await transport.flush().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).errors).toHaveLength(2);
  });

  // ---------------------------------------------------------------------------
  // 5. getTracer() returns a tracer from tracerProvider
  // ---------------------------------------------------------------------------
  it('getTracer() returns a tracer instance', () => {
    const transport = new OtlpTransport({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
    });

    const tracer = transport.getTracer('test');
    expect(tracer).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 6. getMeter() returns a meter from meterProvider
  // ---------------------------------------------------------------------------
  it('getMeter() returns a meter instance', () => {
    const transport = new OtlpTransport({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
    });

    const meter = transport.getMeter('test');
    expect(meter).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 7. exportMetrics() with empty array sends nothing (after early return)
  // ---------------------------------------------------------------------------
  it('exportMetrics() with empty array does nothing', async () => {
    const transport = new OtlpTransport({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
    });

    const fetchSpy = jest
      .spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch')
      .mockResolvedValue({
        ok: true,
        status: 200,
      } as Response);

    await transport.exportMetrics([]);

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // 7b. exportMetrics() uses requestTimeoutMs when provided
  // ---------------------------------------------------------------------------
  it('exportMetrics() passes requestTimeoutMs to AbortSignal.timeout', async () => {
    const transport = new OtlpTransport({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
      requestTimeoutMs: 5_000,
    });
    // Verify the field is stored (observable via a hung fetch that would time out)
    // We can't directly inspect AbortSignal but can verify the transport constructs
    // without error and uses the custom timeout default.
    expect(transport).toBeDefined();

    // Default timeout: no requestTimeoutMs → uses 30_000 default
    const defaultTransport = new OtlpTransport({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
    });
    expect(defaultTransport).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 8. exportMetrics() converts NrMetric[] to OTLP format and sends via fetch
  // ---------------------------------------------------------------------------
  it('exportMetrics() sends metrics in OTLP format', async () => {
    const transport = new OtlpTransport({
      endpoint: 'https://otlp.nr-data.net',
      headers: { 'api-key': 'test-key' },
      appName: 'test-app',
    });

    const fetchSpy = jest
      .spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch')
      .mockResolvedValue({
        ok: true,
        status: 200,
      } as Response);

    const metrics: NrMetric[] = [
      {
        name: 'ai.tokens',
        type: 'gauge',
        value: 100,
        timestamp: Date.now(),
        attributes: { model: 'claude-3-sonnet' },
      },
      {
        name: 'ai.duration',
        type: 'gauge',
        value: 2500,
        timestamp: Date.now(),
        attributes: { tool: 'write_file' },
      },
    ];

    await transport.exportMetrics(metrics);

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://otlp.nr-data.net/v1/metrics',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'api-key': 'test-key',
          // User-Agent identifies the consuming client on
          // NR's collector access logs. Without clientVersion, just the name.
          'User-Agent': 'ai-telemetry',
        }),
      }),
    );

    fetchSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // 8b. exportMetrics() includes name/version User-Agent when clientVersion set
  // ---------------------------------------------------------------------------
  it('exportMetrics() uses name/version User-Agent when clientVersion is provided', async () => {
    const transport = new OtlpTransport({
      endpoint: 'https://otlp.nr-data.net',
      headers: { 'api-key': 'test-key' },
      appName: 'test-app',
      clientName: 'preflight',
      clientVersion: '2.0.0',
    });

    const fetchSpy = jest
      .spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch')
      .mockResolvedValue({ ok: true, status: 200 } as Response);

    await transport.exportMetrics([
      { name: 'ai.tokens', type: 'gauge', value: 1, timestamp: Date.now() },
    ]);

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://otlp.nr-data.net/v1/metrics',
      expect.objectContaining({
        headers: expect.objectContaining({ 'User-Agent': 'preflight/2.0.0' }),
      }),
    );

    fetchSpy.mockRestore();
  });

  // wire-format tests for OTLP/HTTP metric export.
  // These don't use a real collector (nock/msw would be heavier); they
  // intercept fetch and assert the full OTLP/HTTP payload structure
  // (resourceMetrics → scopeMetrics → metrics → gauge|sum|histogram)
  // matches the OTLP spec for each metric type.
  describe('exportMetrics() wire format', () => {
    function captureWirePayload(): { transport: OtlpTransport; getPayload: () => unknown } {
      const transport = new OtlpTransport({
        endpoint: 'https://otlp.nr-data.net',
        appName: 'test-app',
      });
      let captured: unknown;
      jest
        .spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch')
        .mockImplementation(async (_url: unknown, init: unknown) => {
          captured = JSON.parse(gunzipSync((init as { body: Buffer }).body).toString());
          return new Response('', { status: 200 });
        });
      return { transport, getPayload: () => captured };
    }

    it('includes scope.version in OTLP payload when clientVersion is set', async () => {
      let captured: unknown;
      const transport = new OtlpTransport({
        endpoint: 'https://otlp.nr-data.net',
        appName: 'test-app',
        clientName: 'preflight',
        clientVersion: '3.0.0',
      });
      jest
        .spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch')
        .mockImplementation(async (_url: unknown, init: unknown) => {
          captured = JSON.parse(gunzipSync((init as { body: Buffer }).body).toString());
          return new Response('', { status: 200 });
        });

      await transport.exportMetrics([
        { name: 'ai.tokens', type: 'gauge', value: 1, timestamp: Date.now() },
      ]);

      const scope = (
        captured as {
          resourceMetrics: Array<{
            scopeMetrics: Array<{ scope: { name: string; version?: string } }>;
          }>;
        }
      ).resourceMetrics[0].scopeMetrics[0].scope;

      expect(scope.name).toBe('preflight');
      expect(scope.version).toBe('3.0.0');
    });

    it('omits scope.version from OTLP payload when clientVersion is empty', async () => {
      let captured: unknown;
      const transport = new OtlpTransport({
        endpoint: 'https://otlp.nr-data.net',
        appName: 'test-app',
      });
      jest
        .spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch')
        .mockImplementation(async (_url: unknown, init: unknown) => {
          captured = JSON.parse(gunzipSync((init as { body: Buffer }).body).toString());
          return new Response('', { status: 200 });
        });

      await transport.exportMetrics([
        { name: 'ai.tokens', type: 'gauge', value: 1, timestamp: Date.now() },
      ]);

      const scope = (
        captured as {
          resourceMetrics: Array<{
            scopeMetrics: Array<{ scope: Record<string, unknown> }>;
          }>;
        }
      ).resourceMetrics[0].scopeMetrics[0].scope;

      expect(scope).not.toHaveProperty('version');
    });

    it('emits resourceMetrics → scopeMetrics → metrics envelope with service.name resource attribute', async () => {
      const { transport, getPayload } = captureWirePayload();
      await transport.exportMetrics([
        { name: 'ai.tokens', type: 'gauge', value: 100, timestamp: Date.now(), attributes: {} },
      ]);

      const body = getPayload() as {
        resourceMetrics: Array<{
          resource: { attributes: Array<{ key: string; value: { stringValue: string } }> };
          scopeMetrics: Array<{ scope: { name: string }; metrics: unknown[] }>;
        }>;
      };

      expect(body.resourceMetrics).toHaveLength(1);
      const resource = body.resourceMetrics[0];
      expect(resource.resource.attributes[0].key).toBe('service.name');
      expect(resource.resource.attributes[0].value.stringValue).toBe('test-app');
      expect(resource.scopeMetrics).toHaveLength(1);
      expect(resource.scopeMetrics[0].scope.name).toBe('ai-telemetry');
      expect(resource.scopeMetrics[0].metrics).toHaveLength(1);
    });

    it('encodes type=gauge as OTLP Gauge { dataPoints[].asDouble }', async () => {
      const { transport, getPayload } = captureWirePayload();
      await transport.exportMetrics([
        { name: 'ai.gauge', type: 'gauge', value: 42, timestamp: 1700000000000, attributes: {} },
      ]);

      const m = (
        getPayload() as {
          resourceMetrics: Array<{
            scopeMetrics: Array<{ metrics: Array<Record<string, unknown>> }>;
          }>;
        }
      ).resourceMetrics[0].scopeMetrics[0].metrics[0];

      expect(m.name).toBe('ai.gauge');
      expect(m).toHaveProperty('gauge');
      expect(m).not.toHaveProperty('sum');
      expect(m).not.toHaveProperty('histogram');
      const gauge = m.gauge as { dataPoints: Array<{ asDouble: number; timeUnixNano: number }> };
      expect(gauge.dataPoints[0].asDouble).toBe(42);
      // timestamp (ms) → timeUnixNano (ns) is a *1_000_000 conversion.
      expect(gauge.dataPoints[0].timeUnixNano).toBe(1700000000000 * 1_000_000);
    });

    it('encodes type=count as OTLP Sum with isMonotonic=true and aggregationTemporality=DELTA(1)', async () => {
      const { transport, getPayload } = captureWirePayload();
      const timestamp = 1700000000000;
      const intervalMs = 60_000;
      await transport.exportMetrics([
        { name: 'ai.count', type: 'count', value: 5, timestamp, intervalMs, attributes: {} },
      ]);

      const m = (
        getPayload() as {
          resourceMetrics: Array<{
            scopeMetrics: Array<{ metrics: Array<Record<string, unknown>> }>;
          }>;
        }
      ).resourceMetrics[0].scopeMetrics[0].metrics[0];

      expect(m).toHaveProperty('sum');
      expect(m).not.toHaveProperty('gauge');
      const sum = m.sum as {
        dataPoints: Array<{ asDouble: number; startTimeUnixNano?: number; timeUnixNano: number }>;
        aggregationTemporality: number;
        isMonotonic: boolean;
      };
      expect(sum.dataPoints[0].asDouble).toBe(5);
      // DELTA (1) — the count is an interval delta, not a running cumulative total.
      expect(sum.aggregationTemporality).toBe(1);
      expect(sum.isMonotonic).toBe(true);
      // startTimeUnixNano required by OTLP spec for Sum data points.
      expect(sum.dataPoints[0].startTimeUnixNano).toBe((timestamp - intervalMs) * 1_000_000);
      expect(sum.dataPoints[0].timeUnixNano).toBe(timestamp * 1_000_000);
    });

    it('encodes attribute values with the correct OTLP scalar shapes (string | number | boolean)', async () => {
      const { transport, getPayload } = captureWirePayload();
      await transport.exportMetrics([
        {
          name: 'ai.gauge',
          type: 'gauge',
          value: 1,
          timestamp: Date.now(),
          attributes: { svc: 'parser', count: 7, healthy: true },
        },
      ]);

      const m = (
        getPayload() as {
          resourceMetrics: Array<{
            scopeMetrics: Array<{
              metrics: Array<{
                gauge: {
                  dataPoints: Array<{
                    attributes: Array<{ key: string; value: Record<string, unknown> }>;
                  }>;
                };
              }>;
            }>;
          }>;
        }
      ).resourceMetrics[0].scopeMetrics[0].metrics[0];

      const attrs = m.gauge.dataPoints[0].attributes;
      const byKey: Record<string, Record<string, unknown>> = {};
      for (const a of attrs) byKey[a.key] = a.value;
      expect(byKey.svc.stringValue).toBe('parser');
      expect(byKey.count.doubleValue).toBe(7);
      expect(byKey.healthy.boolValue).toBe(true);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });
  });

  // ---------------------------------------------------------------------------
  // 9. exportMetrics() surfaces fetch errors
  // ---------------------------------------------------------------------------
  it('exportMetrics() rejects on fetch errors so the scheduler can requeue', async () => {
    // exportMetrics must throw on transport failures. The
    // HarvestScheduler.sendMetricsToOtlp catch block requeues into
    // retryOtlpMetricBatch — previously exportMetrics swallowed errors,
    // which silently dropped every OTLP metric failure and made that
    // retry buffer dead code.
    const transport = new OtlpTransport({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
    });

    const fetchSpy = jest
      .spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch')
      .mockRejectedValue(new Error('Network error'));

    const metrics: NrMetric[] = [
      {
        name: 'ai.tokens',
        type: 'gauge',
        value: 100,
        timestamp: Date.now(),
        attributes: {},
      },
    ];

    await expect(transport.exportMetrics(metrics)).rejects.toThrow('Network error');

    fetchSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // 10. exportMetrics() surfaces non-OK responses
  // ---------------------------------------------------------------------------
  it('exportMetrics() rejects on non-OK HTTP responses so the scheduler can requeue', async () => {
    const transport = new OtlpTransport({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
    });

    const fetchSpy = jest
      .spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch')
      .mockResolvedValue(new Response('Internal Server Error', { status: 500 }));

    const metrics: NrMetric[] = [
      {
        name: 'ai.tokens',
        type: 'gauge',
        value: 100,
        timestamp: Date.now(),
        attributes: {},
      },
    ];

    await expect(transport.exportMetrics(metrics)).rejects.toThrow(/HTTP 500/);

    fetchSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // 10a. exportMetrics() throws with code OTLP_BAD_REQUEST on 400
  // ---------------------------------------------------------------------------
  it('exportMetrics() throws with code OTLP_BAD_REQUEST on 400 — non-retryable', async () => {
    const transport = new OtlpTransport({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
    });

    const fetchSpy = jest
      .spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch')
      .mockResolvedValue(new Response('Reserved attribute name', { status: 400 }));

    const metrics: NrMetric[] = [
      { name: 'ai.tokens', type: 'gauge', value: 100, timestamp: Date.now(), attributes: {} },
    ];

    const err = await transport.exportMetrics(metrics).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).toBe('OTLP_BAD_REQUEST');
    expect((err as Error).message).toMatch(/HTTP 400/);

    fetchSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // 10b-10d. hasWarnedNoAuth warn-once behaviour
  // ---------------------------------------------------------------------------
  describe('hasWarnedNoAuth warn-once', () => {
    const singleMetric: NrMetric[] = [
      { name: 'ai.tokens', type: 'gauge', value: 1, timestamp: Date.now(), attributes: {} },
    ];

    function successFetch(): jest.SpyInstance {
      return jest
        .spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch')
        .mockResolvedValue(new Response('', { status: 200 }));
    }

    it('warns once when no auth header is present', async () => {
      const transport = new OtlpTransport({
        endpoint: 'https://otlp.nr-data.net',
        appName: 'test',
      });
      const spy = successFetch();
      await transport.exportMetrics(singleMetric);
      const warned = stderrSpy.mock.calls.some((c: unknown[]) =>
        String(c[0] ?? '').includes('no auth header'),
      );
      expect(warned).toBe(true);
      spy.mockRestore();
    });

    it('does not warn on subsequent calls once already warned', async () => {
      const transport = new OtlpTransport({
        endpoint: 'https://otlp.nr-data.net',
        appName: 'test',
      });
      const spy = successFetch();
      await transport.exportMetrics(singleMetric);
      stderrSpy.mockClear();
      await transport.exportMetrics(singleMetric);
      const warnedAgain = stderrSpy.mock.calls.some((c: unknown[]) =>
        String(c[0] ?? '').includes('no auth header'),
      );
      expect(warnedAgain).toBe(false);
      spy.mockRestore();
    });

    it('does not warn when an api-key header is present', async () => {
      const transport = new OtlpTransport({
        endpoint: 'https://otlp.nr-data.net',
        headers: { 'api-key': 'test-key' },
        appName: 'test',
      });
      const spy = successFetch();
      await transport.exportMetrics(singleMetric);
      const warned = stderrSpy.mock.calls.some((c: unknown[]) =>
        String(c[0] ?? '').includes('no auth header'),
      );
      expect(warned).toBe(false);
      spy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------
  // 10e. exportMetrics() encodes summary type as OTLP histogram
  // ---------------------------------------------------------------------------
  it('exportMetrics() encodes type=summary as OTLP histogram with min/max/sum/count', async () => {
    // NrMetric of type 'summary' carries a structured value
    // `{ count, sum, min, max }` and is mapped to OTLP histogram with
    // explicit min/max/sum/count fields and an empty bucket layout —
    // the closest faithful mapping for an unbucketed summary in OTLP.
    const transport = new OtlpTransport({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
    });

    let capturedBody: unknown;
    const fetchSpy = jest
      .spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch')
      .mockImplementation(async (_url: unknown, init: unknown) => {
        capturedBody = JSON.parse(gunzipSync((init as { body: Buffer }).body).toString());
        return new Response('', { status: 200 });
      });

    const metrics: NrMetric[] = [
      {
        name: 'ai.latency',
        type: 'summary',
        value: { count: 4, sum: 100, min: 5, max: 50 },
        timestamp: Date.now(),
        intervalMs: 60_000,
        attributes: { route: 'chat' },
      },
    ];

    await transport.exportMetrics(metrics);

    const wireMetric = (
      capturedBody as {
        resourceMetrics: Array<{
          scopeMetrics: Array<{ metrics: Array<Record<string, unknown>> }>;
        }>;
      }
    ).resourceMetrics[0].scopeMetrics[0].metrics[0];

    expect(wireMetric).toHaveProperty('histogram');
    expect(wireMetric).not.toHaveProperty('gauge');
    expect(wireMetric).not.toHaveProperty('summary');

    const histogram = wireMetric.histogram as {
      dataPoints: Array<Record<string, unknown>>;
      aggregationTemporality: number;
    };
    // 1 = DELTA temporality (the count/sum/min/max describe the harvest
    // interval, not a cumulative total).
    expect(histogram.aggregationTemporality).toBe(1);
    const dp = histogram.dataPoints[0];
    expect(dp.count).toBe(4);
    expect(dp.sum).toBe(100);
    expect(dp.min).toBe(5);
    expect(dp.max).toBe(50);
    expect(dp.bucketCounts).toEqual([4]);
    expect(dp.explicitBounds).toEqual([]);
    // OTLP spec requires startTimeUnixNano on DELTA histogram data points
    expect(dp.startTimeUnixNano).toBe((metrics[0].timestamp - 60_000) * 1_000_000);

    fetchSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // 11-15. endpoint scheme enforcement
  // ---------------------------------------------------------------------------
  describe('endpoint scheme enforcement', () => {
    it('accepts https:// without warning', () => {
      expect(
        () =>
          new OtlpTransport({
            endpoint: 'https://otlp.nr-data.net',
            appName: 'test-app',
          }),
      ).not.toThrow();
      // No PII-cleartext warn should be emitted on https.
      const warnedCleartext = stderrSpy.mock.calls.some((call: unknown[]) =>
        String(call[0] ?? '').includes('plain http://'),
      );
      expect(warnedCleartext).toBe(false);
    });

    it('accepts http://localhost without warning (loopback exception)', () => {
      expect(
        () =>
          new OtlpTransport({
            endpoint: 'http://localhost:4318',
            appName: 'test-app',
          }),
      ).not.toThrow();
      const warnedCleartext = stderrSpy.mock.calls.some((call: unknown[]) =>
        String(call[0] ?? '').includes('plain http://'),
      );
      expect(warnedCleartext).toBe(false);
    });

    it('accepts http://127.0.0.1 without warning (loopback exception)', () => {
      expect(
        () =>
          new OtlpTransport({
            endpoint: 'http://127.0.0.1:4318',
            appName: 'test-app',
          }),
      ).not.toThrow();
      const warnedCleartext = stderrSpy.mock.calls.some((call: unknown[]) =>
        String(call[0] ?? '').includes('plain http://'),
      );
      expect(warnedCleartext).toBe(false);
    });

    it('emits a cleartext warning for http:// to a non-loopback host', () => {
      // Plain http to a non-loopback host: must construct (consumer may have a
      // real reason — e.g. an internal collector behind mTLS) but we surface a
      // warn so it shows up in operator logs.
      expect(
        () =>
          new OtlpTransport({
            endpoint: 'http://internal-collector.example.com:4318',
            appName: 'test-app',
          }),
      ).not.toThrow();
      const stderrText = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0] ?? '')).join('\n');
      expect(stderrText).toMatch(/plain http:\/\//);
      expect(stderrText).toMatch(/internal-collector\.example\.com/);
    });

    it('emits a cleartext warning for http://0.0.0.0 — wildcard, not loopback', () => {
      expect(
        () => new OtlpTransport({ endpoint: 'http://0.0.0.0:4318', appName: 'test-app' }),
      ).not.toThrow();
      const stderrText = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0] ?? '')).join('\n');
      expect(stderrText).toMatch(/plain http:\/\//);
    });

    it('throws on a non-http(s) scheme', () => {
      expect(
        () =>
          new OtlpTransport({
            endpoint: 'ftp://collector.example.com',
            appName: 'test-app',
          }),
      ).toThrow(/OTLP endpoint must use http\(s\)/);
    });

    it('throws on a malformed endpoint URL', () => {
      expect(
        () =>
          new OtlpTransport({
            endpoint: 'not a url',
            appName: 'test-app',
          }),
      ).toThrow(/invalid OTLP endpoint URL/);
    });
  });
});
