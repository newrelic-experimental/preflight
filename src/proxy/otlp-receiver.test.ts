import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// `jest.spyOn(dns, 'lookup')` cannot redefine `node:dns`'s export under this
// ESM/ts-jest setup (the module namespace object is non-configurable), so — as in
// src/security/ssrf.test.ts — the module must be replaced wholesale via jest.mock()
// before anything else imports it. The default implementation delegates to the real
// dns.lookup so every pre-existing test is unaffected (the `describe('forward', ...)`
// tests mock globalThis.fetch directly, so undici's Agent — and its connect.lookup —
// is never reached there); only the DNS-rebinding test below overrides it per-call.
jest.mock('node:dns', () => {
  const actual = jest.requireActual<typeof import('node:dns')>('node:dns');
  return { lookup: jest.fn(actual.lookup) };
});

import { request as nodeRequest } from 'node:http';
import type { Server } from 'node:http';
import { createConnection, type AddressInfo } from 'node:net';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { OtlpReceiver } from './otlp-receiver.js';
import type { OtlpReceiverOptions } from './otlp-receiver.js';
import { decodeOtlpRequest, encodeOtlpRequest } from './otlp-protobuf.js';

// Captured once at module load, before any test mocks globalThis.fetch, so any
// describe block can restore the real implementation instead of leaving it
// undefined for whichever block runs next.
const realFetch = globalThis.fetch;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

function makeReceiver(overrides: Partial<OtlpReceiverOptions> = {}): OtlpReceiver {
  return new OtlpReceiver({
    port: 0,
    forwardEndpoint: null,
    forwardHeaders: {},
    enrichmentAttributes: { 'ai.session.id': 'test-session' },
    ...overrides,
  });
}

function getBoundPort(receiver: OtlpReceiver): number {
  const internals = receiver as unknown as { server: Server | null };
  const addr = internals.server?.address() as AddressInfo | null;
  if (!addr) throw new Error('Receiver not started');
  return addr.port;
}

function httpRequest(
  port: number,
  method: string,
  path: string,
  body?: string | Buffer,
  headers?: Record<string, string>,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = nodeRequest({ hostname: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
      );
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// enrichPayload
// ---------------------------------------------------------------------------

describe('enrichPayload', () => {
  it('injects attributes into resourceSpans[0].resource.attributes', () => {
    const receiver = makeReceiver({ enrichmentAttributes: { 'ai.session.id': 'sess-123' } });
    const input = { resourceSpans: [{ resource: { attributes: [] } }] };
    const result = JSON.parse(
      receiver.enrichPayload(Buffer.from(JSON.stringify(input))).toString('utf-8'),
    ) as typeof input;
    expect(result.resourceSpans[0].resource.attributes).toContainEqual({
      key: 'ai.session.id',
      value: { stringValue: 'sess-123' },
    });
  });

  it('injects attributes into resourceMetrics', () => {
    const receiver = makeReceiver({ enrichmentAttributes: { 'ai.session.id': 'sess-123' } });
    const input = { resourceMetrics: [{ resource: { attributes: [] } }] };
    const result = JSON.parse(
      receiver.enrichPayload(Buffer.from(JSON.stringify(input))).toString('utf-8'),
    ) as typeof input;
    expect(result.resourceMetrics[0].resource.attributes).toContainEqual({
      key: 'ai.session.id',
      value: { stringValue: 'sess-123' },
    });
  });

  it('injects attributes into resourceLogs', () => {
    const receiver = makeReceiver({ enrichmentAttributes: { 'ai.session.id': 'sess-123' } });
    const input = { resourceLogs: [{ resource: { attributes: [] } }] };
    const result = JSON.parse(
      receiver.enrichPayload(Buffer.from(JSON.stringify(input))).toString('utf-8'),
    ) as typeof input;
    expect(result.resourceLogs[0].resource.attributes).toContainEqual({
      key: 'ai.session.id',
      value: { stringValue: 'sess-123' },
    });
  });

  it('creates missing resource and attributes when not present', () => {
    const receiver = makeReceiver({ enrichmentAttributes: { 'ai.session.id': 'sess-123' } });
    const input = { resourceSpans: [{}] };
    const result = JSON.parse(
      receiver.enrichPayload(Buffer.from(JSON.stringify(input))).toString('utf-8'),
    ) as { resourceSpans: [{ resource: { attributes: unknown[] } }] };
    expect(result.resourceSpans[0].resource.attributes).toContainEqual({
      key: 'ai.session.id',
      value: { stringValue: 'sess-123' },
    });
  });

  it('passes non-JSON bytes through unchanged', () => {
    const receiver = makeReceiver();
    const binary = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]);
    const result = receiver.enrichPayload(binary);
    expect(result).toBe(binary);
  });

  it('does not duplicate an enrichment key already present in the payload', () => {
    const receiver = makeReceiver({ enrichmentAttributes: { 'ai.session.id': 'new-value' } });
    const input = {
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: 'ai.session.id', value: { stringValue: 'existing-value' } }],
          },
        },
      ],
    };
    const result = JSON.parse(
      receiver.enrichPayload(Buffer.from(JSON.stringify(input))).toString('utf-8'),
    ) as typeof input;

    const sessionIdEntries = result.resourceSpans[0].resource.attributes.filter(
      (a) => a.key === 'ai.session.id',
    );
    expect(sessionIdEntries).toHaveLength(1);
    expect(sessionIdEntries[0]?.value.stringValue).toBe('existing-value');
  });
});

// ---------------------------------------------------------------------------
// handleRequest (via live HTTP)
// ---------------------------------------------------------------------------

describe('handleRequest', () => {
  let receiver: OtlpReceiver;

  beforeEach(async () => {
    receiver = makeReceiver();
    await receiver.start();
  });

  afterEach(async () => {
    await receiver.stop();
  });

  it('returns 404 for non-POST requests', async () => {
    const port = getBoundPort(receiver);
    const { statusCode } = await httpRequest(port, 'GET', '/v1/traces');
    expect(statusCode).toBe(404);
  });

  it('returns 404 for paths that do not start with /v1/', async () => {
    const port = getBoundPort(receiver);
    const { statusCode } = await httpRequest(port, 'POST', '/health', '{}');
    expect(statusCode).toBe(404);
  });

  it('returns 200 with {} when forwardEndpoint is null', async () => {
    const port = getBoundPort(receiver);
    const { statusCode, body } = await httpRequest(
      port,
      'POST',
      '/v1/traces',
      JSON.stringify({ resourceSpans: [] }),
    );
    expect(statusCode).toBe(200);
    expect(body).toBe('{}');
  });
});

// ---------------------------------------------------------------------------
// forward (mock fetch)
// ---------------------------------------------------------------------------

describe('forward', () => {
  const mockFetch = jest
    .fn<(url: string, init?: RequestInit) => Promise<Response>>()
    .mockResolvedValue({
      status: 200,
      text: async () => '{}',
    } as Response);

  beforeEach(() => {
    mockFetch.mockClear();
    (globalThis as { fetch?: unknown }).fetch = mockFetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('calls fetch with the forward URL and api-key header', async () => {
    const receiver = makeReceiver({
      forwardEndpoint: 'https://otlp.nr-data.net',
      forwardHeaders: { 'api-key': 'test-key' },
    });
    await receiver.start();
    try {
      const port = getBoundPort(receiver);
      await httpRequest(port, 'POST', '/v1/traces', JSON.stringify({ resourceSpans: [] }));
      expect(mockFetch).toHaveBeenCalledWith(
        'https://otlp.nr-data.net/v1/traces',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'api-key': 'test-key' }),
        }),
      );
    } finally {
      await receiver.stop();
    }
  });

  it('preserves Content-Type: application/x-protobuf for protobuf payloads', async () => {
    const receiver = makeReceiver({
      forwardEndpoint: 'https://otlp.nr-data.net',
      forwardHeaders: {},
    });
    await receiver.start();
    try {
      const port = getBoundPort(receiver);
      const binaryBody = Buffer.from([0x00, 0x01, 0x02, 0x03]);
      await httpRequest(port, 'POST', '/v1/traces', binaryBody, {
        'content-type': 'application/x-protobuf',
      });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://otlp.nr-data.net/v1/traces',
        expect.objectContaining({
          headers: expect.objectContaining({ 'Content-Type': 'application/x-protobuf' }),
        }),
      );
    } finally {
      await receiver.stop();
    }
  });

  it('does NOT propagate client headers to upstream (security: prevent header injection)', async () => {
    const receiver = makeReceiver({
      forwardEndpoint: 'https://otlp.nr-data.net',
      forwardHeaders: { 'api-key': 'test-key' },
    });
    await receiver.start();
    try {
      const port = getBoundPort(receiver);
      await httpRequest(port, 'POST', '/v1/traces', JSON.stringify({ resourceSpans: [] }), {
        'x-custom-header': 'should-not-leak',
        authorization: 'Bearer attacker-token',
      });
      const call = mockFetch.mock.calls[0];
      expect(call).toBeDefined();
      const headers = (call?.[1] as RequestInit)?.headers as Record<string, string>;
      expect(headers).not.toHaveProperty('x-custom-header');
      expect(headers).not.toHaveProperty('authorization');
      // Verify only forwardHeaders and Content-Type are present
      expect(headers).toHaveProperty('api-key', 'test-key');
      expect(headers).toHaveProperty('Content-Type', 'application/json');
    } finally {
      await receiver.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Protobuf payload builders
//
// Byte fields use high-bit bytes and 64-bit nanosecond timestamps exceed
// Number.MAX_SAFE_INTEGER (2^53), so any lossy step in decode → enrich →
// re-encode shows up as a concrete assertion failure, not a rounding no-op.
// ---------------------------------------------------------------------------

const TRACE_ID = Buffer.from('0af7651916cd43dd8448eb211c80319c', 'hex');
const SPAN_ID = Buffer.from('b7ad6b7169203331', 'hex');
const BIG_NANOS = '1758304182000000123'; // > 2^53
const BIG_INT64 = '9007199254740993'; // 2^53 + 1, off by one if it ever becomes a JS number

function makeProtoTraceRequest() {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: 'service.name', value: { stringValue: 'app-under-test' } }],
        },
        scopeSpans: [
          {
            scope: { name: 'test-lib', version: '1.2.3' },
            spans: [
              {
                traceId: TRACE_ID,
                spanId: SPAN_ID,
                name: 'GET /users',
                kind: 2,
                startTimeUnixNano: BIG_NANOS,
                endTimeUnixNano: '1758304182000000987',
              },
            ],
          },
        ],
      },
    ],
  };
}

function makeProtoMetricsRequest() {
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [{ key: 'service.name', value: { stringValue: 'app-under-test' } }],
        },
        scopeMetrics: [
          {
            scope: { name: 'test-lib' },
            metrics: [
              {
                name: 'http.requests',
                unit: '1',
                gauge: { dataPoints: [{ timeUnixNano: BIG_NANOS, asInt: BIG_INT64 }] },
              },
            ],
          },
        ],
      },
    ],
  };
}

function makeProtoLogsRequest() {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [{ key: 'service.name', value: { stringValue: 'app-under-test' } }],
        },
        scopeLogs: [
          {
            scope: { name: 'test-lib' },
            logRecords: [
              {
                timeUnixNano: BIG_NANOS,
                severityNumber: 9,
                severityText: 'INFO',
                body: { stringValue: 'user logged in' },
                traceId: TRACE_ID,
                spanId: SPAN_ID,
              },
            ],
          },
        ],
      },
    ],
  };
}

type ProtoResourceEntry = {
  resource?: { attributes?: Array<{ key: string; value: { stringValue?: string } }> };
};

function resourceAttributes(decoded: Record<string, unknown> | null, key: string): unknown[] {
  expect(decoded).not.toBeNull();
  const entries = (decoded as Record<string, unknown>)[key] as ProtoResourceEntry[];
  return entries[0]?.resource?.attributes ?? [];
}

// ---------------------------------------------------------------------------
// Protobuf enrichment over HTTP
// ---------------------------------------------------------------------------

describe('protobuf enrichment over HTTP', () => {
  const mockFetch = jest
    .fn<(url: string, init?: RequestInit) => Promise<Response>>()
    .mockResolvedValue({
      status: 200,
      text: async () => '{}',
    } as Response);

  beforeEach(() => {
    mockFetch.mockClear();
    (globalThis as { fetch?: unknown }).fetch = mockFetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function forwardedRequest(): { body: Buffer; headers: Record<string, string> } {
    const init = mockFetch.mock.calls[0]?.[1];
    expect(init).toBeDefined();
    return {
      body: Buffer.from(init?.body as Uint8Array),
      headers: init?.headers as Record<string, string>,
    };
  }

  async function postProtobuf(receiver: OtlpReceiver, path: string, body: Buffer): Promise<void> {
    await receiver.start();
    try {
      const port = getBoundPort(receiver);
      await httpRequest(port, 'POST', path, body, { 'content-type': 'application/x-protobuf' });
    } finally {
      await receiver.stop();
    }
  }

  it('enriches a protobuf traces payload and preserves untouched fields', async () => {
    const receiver = makeReceiver({ forwardEndpoint: 'https://otlp.nr-data.net' });
    await postProtobuf(
      receiver,
      '/v1/traces',
      encodeOtlpRequest('/v1/traces', makeProtoTraceRequest()),
    );

    const { body, headers } = forwardedRequest();
    expect(headers['Content-Type']).toBe('application/x-protobuf');

    const decoded = decodeOtlpRequest('/v1/traces', body);
    expect(resourceAttributes(decoded, 'resourceSpans')).toContainEqual({
      key: 'ai.session.id',
      value: { stringValue: 'test-session' },
    });
    expect(resourceAttributes(decoded, 'resourceSpans')).toContainEqual({
      key: 'service.name',
      value: { stringValue: 'app-under-test' },
    });

    const span = (decoded as ReturnType<typeof makeProtoTraceRequest>).resourceSpans[0]
      ?.scopeSpans[0]?.spans[0];
    expect(span?.traceId.equals(TRACE_ID)).toBe(true);
    expect(span?.spanId.equals(SPAN_ID)).toBe(true);
    expect(span?.startTimeUnixNano).toBe(BIG_NANOS);
    expect(span?.name).toBe('GET /users');
  });

  it('enriches a protobuf metrics payload and preserves 64-bit values', async () => {
    const receiver = makeReceiver({ forwardEndpoint: 'https://otlp.nr-data.net' });
    await postProtobuf(
      receiver,
      '/v1/metrics',
      encodeOtlpRequest('/v1/metrics', makeProtoMetricsRequest()),
    );

    const decoded = decodeOtlpRequest('/v1/metrics', forwardedRequest().body);
    expect(resourceAttributes(decoded, 'resourceMetrics')).toContainEqual({
      key: 'ai.session.id',
      value: { stringValue: 'test-session' },
    });

    const point = (decoded as ReturnType<typeof makeProtoMetricsRequest>).resourceMetrics[0]
      ?.scopeMetrics[0]?.metrics[0]?.gauge.dataPoints[0];
    expect(point?.timeUnixNano).toBe(BIG_NANOS);
    expect(point?.asInt).toBe(BIG_INT64);
  });

  it('enriches a protobuf logs payload and preserves the record', async () => {
    const receiver = makeReceiver({ forwardEndpoint: 'https://otlp.nr-data.net' });
    await postProtobuf(receiver, '/v1/logs', encodeOtlpRequest('/v1/logs', makeProtoLogsRequest()));

    const decoded = decodeOtlpRequest('/v1/logs', forwardedRequest().body);
    expect(resourceAttributes(decoded, 'resourceLogs')).toContainEqual({
      key: 'ai.session.id',
      value: { stringValue: 'test-session' },
    });

    const record = (decoded as ReturnType<typeof makeProtoLogsRequest>).resourceLogs[0]
      ?.scopeLogs[0]?.logRecords[0];
    expect(record?.timeUnixNano).toBe(BIG_NANOS);
    expect(record?.body.stringValue).toBe('user logged in');
    expect(record?.traceId.equals(TRACE_ID)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// enrichPayload (protobuf)
// ---------------------------------------------------------------------------

describe('enrichPayload (protobuf)', () => {
  const PROTOBUF = 'application/x-protobuf';

  it('re-encodes byte-for-byte when every enrichment key is already present', () => {
    const receiver = makeReceiver({ enrichmentAttributes: { 'ai.session.id': 'test-session' } });
    const payload = makeProtoTraceRequest();
    payload.resourceSpans[0]?.resource.attributes.push({
      key: 'ai.session.id',
      value: { stringValue: 'test-session' },
    });
    const input = encodeOtlpRequest('/v1/traces', payload);

    const output = receiver.enrichPayload(input, '/v1/traces', PROTOBUF);

    // Nothing was injected, so a lossless decode → toObject → fromObject →
    // encode pipeline must reproduce the input bytes exactly.
    expect(output.equals(input)).toBe(true);
  });

  it('enriches a fixture produced by an independent encoder (otlp-transformer)', async () => {
    const { ProtobufLogsSerializer } = await import('@opentelemetry/otlp-transformer');
    const { resourceFromAttributes } = await import('@opentelemetry/resources');
    const { SeverityNumber } = await import('@opentelemetry/api-logs');
    const record: import('@opentelemetry/sdk-logs').ReadableLogRecord = {
      hrTime: [1758304182, 123], // 1758304182000000123 ns, exceeds 2^53
      hrTimeObserved: [1758304182, 456],
      severityNumber: SeverityNumber.INFO,
      severityText: 'INFO',
      body: 'independent encoder record',
      spanContext: {
        traceId: TRACE_ID.toString('hex'),
        spanId: SPAN_ID.toString('hex'),
        traceFlags: 1,
      },
      resource: resourceFromAttributes({ 'service.name': 'independent-app' }),
      instrumentationScope: { name: 'independent-lib', version: '9.9.9' },
      attributes: { 'log.source': 'jest' },
      droppedAttributesCount: 0,
    };
    const serialized = ProtobufLogsSerializer.serializeRequest([record]);
    expect(serialized).toBeDefined();
    const fixture = Buffer.from(serialized as Uint8Array);

    const receiver = makeReceiver({ enrichmentAttributes: { 'ai.session.id': 'sess-xv' } });
    const decoded = decodeOtlpRequest(
      '/v1/logs',
      receiver.enrichPayload(fixture, '/v1/logs', PROTOBUF),
    );

    expect(resourceAttributes(decoded, 'resourceLogs')).toContainEqual({
      key: 'ai.session.id',
      value: { stringValue: 'sess-xv' },
    });
    expect(resourceAttributes(decoded, 'resourceLogs')).toContainEqual({
      key: 'service.name',
      value: { stringValue: 'independent-app' },
    });
    const log = (decoded as ReturnType<typeof makeProtoLogsRequest>).resourceLogs[0]?.scopeLogs[0]
      ?.logRecords[0];
    expect(log?.timeUnixNano).toBe(BIG_NANOS);
    expect(log?.body.stringValue).toBe('independent encoder record');
    expect(log?.severityNumber).toBe(9);
    expect(log?.traceId.equals(TRACE_ID)).toBe(true);
    expect(log?.spanId.equals(SPAN_ID)).toBe(true);
  });

  it('creates the resource envelope when a protobuf payload has none', () => {
    const receiver = makeReceiver({ enrichmentAttributes: { 'ai.session.id': 'sess-123' } });
    const input = encodeOtlpRequest('/v1/traces', {
      resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: TRACE_ID, name: 'orphan' }] }] }],
    });

    const decoded = decodeOtlpRequest(
      '/v1/traces',
      receiver.enrichPayload(input, '/v1/traces', PROTOBUF),
    );

    expect(resourceAttributes(decoded, 'resourceSpans')).toContainEqual({
      key: 'ai.session.id',
      value: { stringValue: 'sess-123' },
    });
  });

  it('forwards malformed protobuf bytes unmodified', () => {
    const receiver = makeReceiver();
    const malformed = Buffer.from([0x08]); // field 1 varint tag with no value
    expect(receiver.enrichPayload(malformed, '/v1/traces', PROTOBUF)).toBe(malformed);
  });

  it('forwards protobuf on an unknown /v1/ path unmodified', () => {
    const receiver = makeReceiver();
    const body = encodeOtlpRequest('/v1/traces', makeProtoTraceRequest());
    expect(receiver.enrichPayload(body, '/v1/profiles', PROTOBUF)).toBe(body);
  });
});

describe('forward — DNS rebinding protection', () => {
  // This describe block is a sibling of describe('forward', ...), not nested inside
  // it, so that block's own beforeEach (which mocks globalThis.fetch) never runs here.
  // Explicitly restore the real fetch anyway so this test's Agent/connect.lookup path
  // always runs through a genuine, unmocked fetch, independent of file-level ordering.
  beforeEach(() => {
    globalThis.fetch = realFetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('rejects the forward when the forwardEndpoint hostname resolves to a private address', async () => {
    const dnsMod = await import('node:dns');
    const mockedLookup = dnsMod.lookup as unknown as jest.Mock<(...args: unknown[]) => void>;
    mockedLookup.mockImplementationOnce((..._args: unknown[]) => {
      const cb = _args[_args.length - 1] as (
        err: NodeJS.ErrnoException | null,
        addresses: { address: string; family: number }[],
      ) => void;
      cb(null, [{ address: '169.254.169.254', family: 4 }]);
    });

    const receiver = makeReceiver({
      forwardEndpoint: 'https://looks-public-but-rebinds.example',
    });
    await receiver.start();
    try {
      const port = getBoundPort(receiver);
      const res = await httpRequest(
        port,
        'POST',
        '/v1/traces',
        JSON.stringify({ resourceSpans: [] }),
      );
      // Without a dispatcher wired in, fetch never consults the mocked dns.lookup at
      // all — it fails via its own resolver (real ENOTFOUND for this nonexistent
      // domain), which the generic error handler also maps to 500. That coincidence
      // would let this test pass even with no SSRF protection wired up. Asserting the
      // mock was actually invoked proves the rejection came from the resolved-address
      // check, not from an unrelated real DNS failure.
      expect(mockedLookup).toHaveBeenCalled();
      expect(res.statusCode).toBe(500);
    } finally {
      await receiver.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// start / stop lifecycle
// ---------------------------------------------------------------------------

describe('start / stop lifecycle', () => {
  it('starts an HTTP server and stop() closes it', async () => {
    const receiver = makeReceiver();
    await receiver.start();
    const port = getBoundPort(receiver);
    await expect(httpRequest(port, 'GET', '/v1/traces')).resolves.toBeDefined();
    await receiver.stop();
    await expect(httpRequest(port, 'GET', '/v1/traces')).rejects.toThrow();
  });

  it('stop() resolves immediately when not yet started', async () => {
    const receiver = makeReceiver();
    await expect(receiver.stop()).resolves.toBeUndefined();
  });

  it('stop() closes the forwardDispatcher Agent when forwarding is configured', async () => {
    const { Agent } = await import('undici');
    const closeSpy = jest.spyOn(Agent.prototype, 'close').mockResolvedValue(undefined);
    try {
      const receiver = makeReceiver({ forwardEndpoint: 'https://otlp.nr-data.net' });
      await receiver.start();
      await receiver.stop();
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      closeSpy.mockRestore();
    }
  });

  it('stop() does not throw when forwarding is not configured (no dispatcher to close)', async () => {
    const receiver = makeReceiver();
    await receiver.start();
    await expect(receiver.stop()).resolves.toBeUndefined();
  });

  it('stop() closes the forwardDispatcher even if the receiver was never started', async () => {
    const { Agent } = await import('undici');
    const closeSpy = jest.spyOn(Agent.prototype, 'close').mockResolvedValue(undefined);
    try {
      const receiver = makeReceiver({ forwardEndpoint: 'https://otlp.nr-data.net' });
      await receiver.stop();
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      closeSpy.mockRestore();
    }
  });

  it('stop() still resolves even if the forwardDispatcher rejects on close()', async () => {
    const { Agent } = await import('undici');
    const closeSpy = jest
      .spyOn(Agent.prototype, 'close')
      .mockRejectedValue(new Error('already destroyed'));
    try {
      const receiver = makeReceiver({ forwardEndpoint: 'https://otlp.nr-data.net' });
      await receiver.start();
      await expect(receiver.stop()).resolves.toBeUndefined();
    } finally {
      closeSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// constructor SSRF guard
// ---------------------------------------------------------------------------

describe('constructor SSRF guard', () => {
  it('throws for a private RFC-1918 forwardEndpoint', () => {
    expect(
      () =>
        new OtlpReceiver({
          port: 0,
          forwardEndpoint: 'http://192.168.1.1/endpoint',
          forwardHeaders: {},
          enrichmentAttributes: {},
        }),
    ).toThrow();
  });

  it('throws for a loopback forwardEndpoint', () => {
    expect(
      () =>
        new OtlpReceiver({
          port: 0,
          forwardEndpoint: 'http://127.0.0.1:4317',
          forwardHeaders: {},
          enrichmentAttributes: {},
        }),
    ).toThrow();
  });

  it('accepts a public forwardEndpoint', () => {
    expect(
      () =>
        new OtlpReceiver({
          port: 0,
          forwardEndpoint: 'https://otlp.nr-data.net',
          forwardHeaders: {},
          enrichmentAttributes: {},
        }),
    ).not.toThrow();
  });

  it('accepts null forwardEndpoint without validation', () => {
    expect(
      () =>
        new OtlpReceiver({
          port: 0,
          forwardEndpoint: null,
          forwardHeaders: {},
          enrichmentAttributes: {},
        }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Body size limit (413)
// ---------------------------------------------------------------------------

describe('body size limit', () => {
  let receiver: OtlpReceiver;

  beforeEach(async () => {
    receiver = makeReceiver({ maxBodyBytes: 50 });
    await receiver.start();
  });

  afterEach(async () => {
    await receiver.stop();
  });

  it('returns 413 when body exceeds maxBodyBytes', async () => {
    const port = getBoundPort(receiver);
    const largeBody = JSON.stringify({ data: 'x'.repeat(100) });
    const { statusCode } = await httpRequest(port, 'POST', '/v1/traces', largeBody);
    expect(statusCode).toBe(413);
  });

  it('returns 200 for body within maxBodyBytes', async () => {
    const port = getBoundPort(receiver);
    const { statusCode } = await httpRequest(port, 'POST', '/v1/traces', '{}');
    expect(statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Slow-loris timeout (408)
// ---------------------------------------------------------------------------

describe('slow-loris timeout', () => {
  it('returns 408 when body delivery stalls past bodyTimeoutMs', async () => {
    const receiver = makeReceiver({ bodyTimeoutMs: 200 });
    await receiver.start();
    try {
      const port = getBoundPort(receiver);
      const statusCode = await new Promise<number>((resolve) => {
        const req = nodeRequest(
          {
            hostname: '127.0.0.1',
            port,
            method: 'POST',
            path: '/v1/traces',
            headers: { 'content-type': 'application/json', 'content-length': '1000' },
          },
          (res) => {
            resolve(res.statusCode ?? 0);
            res.resume();
          },
        );
        req.on('error', () => resolve(408)); // socket may be destroyed before response arrives
        req.flushHeaders(); // Send headers; deliberately never send the body
      });
      expect(statusCode).toBe(408);
    } finally {
      await receiver.stop();
    }
  }, 5000);
});

// ---------------------------------------------------------------------------
// Content-Encoding decompression
// ---------------------------------------------------------------------------

describe('Content-Encoding decompression', () => {
  let receiver: OtlpReceiver;

  beforeEach(async () => {
    receiver = makeReceiver();
    await receiver.start();
  });

  afterEach(async () => {
    await receiver.stop();
  });

  it('decompresses gzip-encoded body and returns 200', async () => {
    const port = getBoundPort(receiver);
    const payload = JSON.stringify({ resourceSpans: [] });
    const compressed = gzipSync(Buffer.from(payload));
    const { statusCode } = await httpRequest(port, 'POST', '/v1/traces', compressed, {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
    });
    expect(statusCode).toBe(200);
  });

  it('decompresses deflate-encoded body and returns 200', async () => {
    const port = getBoundPort(receiver);
    const payload = JSON.stringify({ resourceSpans: [] });
    const compressed = deflateSync(Buffer.from(payload));
    const { statusCode } = await httpRequest(port, 'POST', '/v1/traces', compressed, {
      'content-type': 'application/json',
      'content-encoding': 'deflate',
    });
    expect(statusCode).toBe(200);
  });

  it('decompresses brotli-encoded body and returns 200', async () => {
    const port = getBoundPort(receiver);
    const payload = JSON.stringify({ resourceSpans: [] });
    const compressed = brotliCompressSync(Buffer.from(payload));
    const { statusCode } = await httpRequest(port, 'POST', '/v1/traces', compressed, {
      'content-type': 'application/json',
      'content-encoding': 'br',
    });
    expect(statusCode).toBe(200);
  });

  it('returns 415 for unsupported Content-Encoding', async () => {
    const port = getBoundPort(receiver);
    const { statusCode } = await httpRequest(port, 'POST', '/v1/traces', '{}', {
      'content-type': 'application/json',
      'content-encoding': 'zstd',
    });
    expect(statusCode).toBe(415);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting (429)
// ---------------------------------------------------------------------------

describe('rate limiting', () => {
  it('returns 429 after exceeding rateLimitPerMinute requests', async () => {
    const receiver = makeReceiver({ rateLimitPerMinute: 2 });
    await receiver.start();
    try {
      const port = getBoundPort(receiver);
      const r1 = await httpRequest(port, 'POST', '/v1/traces', '{}');
      const r2 = await httpRequest(port, 'POST', '/v1/traces', '{}');
      const r3 = await httpRequest(port, 'POST', '/v1/traces', '{}');
      expect(r1.statusCode).toBe(200);
      expect(r2.statusCode).toBe(200);
      expect(r3.statusCode).toBe(429);
    } finally {
      await receiver.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Rate limiter memory cleanup
// ---------------------------------------------------------------------------

describe('rate limiter memory cleanup', () => {
  it('deletes the Map entry once an IP has no remaining unexpired timestamps', () => {
    // rateLimitPerMinute: 0 means every request is rejected — the prune step
    // still runs (dropping the aged timestamp), but the "record this request"
    // push never happens, so the array is left genuinely and observably empty.
    const receiver = makeReceiver({ rateLimitPerMinute: 0 });
    const internals = receiver as unknown as {
      rateLimiter: Map<string, number[]>;
      checkRateLimit: (req: { socket: { remoteAddress?: string } }) => void;
    };
    internals.rateLimiter.set('10.0.0.7', [Date.now() - 61_000]); // already outside the 60s window

    expect(() => internals.checkRateLimit({ socket: { remoteAddress: '10.0.0.7' } })).toThrow();

    // Before the fix: the pruned-to-empty array stays in the Map forever.
    // After the fix: the empty entry is deleted.
    expect(internals.rateLimiter.has('10.0.0.7')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// API key authentication (401)
// ---------------------------------------------------------------------------

describe('API key authentication', () => {
  let receiver: OtlpReceiver;

  beforeEach(async () => {
    receiver = makeReceiver({ apiKey: 'test-secret' });
    await receiver.start();
  });

  afterEach(async () => {
    await receiver.stop();
  });

  it('returns 401 when Authorization header is absent', async () => {
    const port = getBoundPort(receiver);
    const { statusCode } = await httpRequest(port, 'POST', '/v1/traces', '{}');
    expect(statusCode).toBe(401);
  });

  it('returns 401 when Bearer token is wrong', async () => {
    const port = getBoundPort(receiver);
    const { statusCode } = await httpRequest(port, 'POST', '/v1/traces', '{}', {
      authorization: 'Bearer wrong-token',
    });
    expect(statusCode).toBe(401);
  });

  it('returns 200 with correct Bearer token', async () => {
    const port = getBoundPort(receiver);
    const { statusCode } = await httpRequest(port, 'POST', '/v1/traces', '{}', {
      authorization: 'Bearer test-secret',
    });
    expect(statusCode).toBe(200);
  });

  it('allows unauthenticated requests when no apiKey is configured', async () => {
    const openReceiver = makeReceiver();
    await openReceiver.start();
    try {
      const port = getBoundPort(openReceiver);
      const { statusCode } = await httpRequest(port, 'POST', '/v1/traces', '{}');
      expect(statusCode).toBe(200);
    } finally {
      await openReceiver.stop();
    }
  });

  it('rejects a same-length wrong Bearer token (regression: no length short-circuit)', async () => {
    const port = getBoundPort(receiver);
    // Same length as 'Bearer test-secret' (18 chars), wrong content.
    const wrongSameLength = 'Bearer wrong-secre';
    expect(wrongSameLength.length).toBe('Bearer test-secret'.length);
    const { statusCode } = await httpRequest(port, 'POST', '/v1/traces', '{}', {
      authorization: wrongSameLength,
    });
    expect(statusCode).toBe(401);
  });

  it('rejects a token that starts with the correct value plus extra characters (regression: no truncation)', async () => {
    const port = getBoundPort(receiver);
    const { statusCode } = await httpRequest(port, 'POST', '/v1/traces', '{}', {
      authorization: 'Bearer test-secretXXXX',
    });
    expect(statusCode).toBe(401);
  });

  it('rejects a strict prefix of the correct token (shorter than expected)', async () => {
    const port = getBoundPort(receiver);
    const { statusCode } = await httpRequest(port, 'POST', '/v1/traces', '{}', {
      authorization: 'Bearer test-secre',
    });
    expect(statusCode).toBe(401);
  });

  it('rejects an empty Authorization header value', async () => {
    const port = getBoundPort(receiver);
    const { statusCode } = await httpRequest(port, 'POST', '/v1/traces', '{}', {
      authorization: '',
    });
    expect(statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Content-Type validation (415)
// ---------------------------------------------------------------------------

describe('Content-Type validation', () => {
  let receiver: OtlpReceiver;

  beforeEach(async () => {
    receiver = makeReceiver();
    await receiver.start();
  });

  afterEach(async () => {
    await receiver.stop();
  });

  it('returns 415 for text/plain Content-Type', async () => {
    const port = getBoundPort(receiver);
    const { statusCode } = await httpRequest(port, 'POST', '/v1/traces', '{}', {
      'content-type': 'text/plain',
    });
    expect(statusCode).toBe(415);
  });

  it('returns 200 for application/json', async () => {
    const port = getBoundPort(receiver);
    const { statusCode } = await httpRequest(port, 'POST', '/v1/traces', '{}', {
      'content-type': 'application/json',
    });
    expect(statusCode).toBe(200);
  });

  it('returns 200 for application/x-protobuf', async () => {
    const port = getBoundPort(receiver);
    const { statusCode } = await httpRequest(
      port,
      'POST',
      '/v1/traces',
      Buffer.from([0x00, 0x01]),
      { 'content-type': 'application/x-protobuf' },
    );
    expect(statusCode).toBe(200);
  });

  it('returns 200 for application/json with charset parameter', async () => {
    const port = getBoundPort(receiver);
    const { statusCode } = await httpRequest(port, 'POST', '/v1/traces', '{}', {
      'content-type': 'application/json; charset=utf-8',
    });
    expect(statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Incomplete body (400)
// ---------------------------------------------------------------------------

describe('incomplete body', () => {
  it('returns 400 when received bytes are less than Content-Length', async () => {
    const receiver = makeReceiver();
    await receiver.start();
    try {
      const port = getBoundPort(receiver);
      const statusCode = await new Promise<number>((resolve, reject) => {
        const conn = createConnection({ host: '127.0.0.1', port }, () => {
          // Claim 100 bytes in Content-Length but only send 2 bytes then close
          const raw = [
            'POST /v1/traces HTTP/1.1',
            'Host: 127.0.0.1',
            'Content-Type: application/json',
            'Content-Length: 100',
            'Connection: close',
            '',
            '{}',
          ].join('\r\n');
          conn.write(raw);
          conn.end();
        });
        let response = '';
        conn.on('data', (chunk: Buffer) => {
          response += chunk.toString();
        });
        conn.on('end', () => {
          const match = /^HTTP\/1\.1 (\d{3})/.exec(response);
          resolve(match ? parseInt(match[1], 10) : 0);
        });
        conn.on('error', reject);
      });
      expect(statusCode).toBe(400);
    } finally {
      await receiver.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Error message sanitization
// ---------------------------------------------------------------------------

describe('error message sanitization', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('logs only err.message without stack frames on forward error', async () => {
    const errorMessage = 'Upstream OTLP connection refused';
    const upstreamError = new Error(errorMessage);
    const stackFrames = (upstreamError.stack ?? '')
      .split('\n')
      .filter((l) => l.trim().startsWith('at '));

    (globalThis as { fetch?: unknown }).fetch = () => Promise.reject(upstreamError);

    const receiver = makeReceiver({
      forwardEndpoint: 'https://otlp.nr-data.net',
      forwardHeaders: {},
    });
    await receiver.start();
    try {
      const port = getBoundPort(receiver);
      const { statusCode } = await httpRequest(
        port,
        'POST',
        '/v1/traces',
        JSON.stringify({ resourceSpans: [] }),
      );
      expect(statusCode).toBe(500);

      const logged = (stderrSpy.mock.calls as Array<[string]>).map(([arg]) => String(arg)).join('');

      expect(logged).toContain(errorMessage);
      for (const frame of stackFrames) {
        expect(logged).not.toContain(frame.trim());
      }
    } finally {
      await receiver.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Expect: 100-continue
// ---------------------------------------------------------------------------

describe('Expect: 100-continue', () => {
  it('sends 100 Continue and completes the request successfully', async () => {
    const receiver = makeReceiver();
    await receiver.start();
    try {
      const port = getBoundPort(receiver);
      const body = JSON.stringify({ resourceSpans: [] });
      const statusCode = await new Promise<number>((resolve, reject) => {
        const req = nodeRequest(
          {
            hostname: '127.0.0.1',
            port,
            method: 'POST',
            path: '/v1/traces',
            headers: {
              'content-type': 'application/json',
              'content-length': String(Buffer.byteLength(body)),
              expect: '100-continue',
            },
          },
          (res) => {
            resolve(res.statusCode ?? 0);
            res.resume();
          },
        );
        req.on('continue', () => {
          req.write(body);
          req.end();
        });
        req.on('error', reject);
        req.flushHeaders();
      });
      expect(statusCode).toBe(200);
    } finally {
      await receiver.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Remaining size-limit / encoding / Content-Type edge cases
// ---------------------------------------------------------------------------

describe('Content-Type edge cases', () => {
  let receiver: OtlpReceiver;

  beforeEach(async () => {
    receiver = makeReceiver();
    await receiver.start();
  });

  afterEach(async () => {
    await receiver.stop();
  });

  it('returns 415 for text/html Content-Type', async () => {
    const port = getBoundPort(receiver);
    const { statusCode } = await httpRequest(port, 'POST', '/v1/traces', '{}', {
      'content-type': 'text/html',
    });
    expect(statusCode).toBe(415);
  });

  it('returns 415 for application/xml Content-Type', async () => {
    const port = getBoundPort(receiver);
    const { statusCode } = await httpRequest(port, 'POST', '/v1/traces', '<root/>', {
      'content-type': 'application/xml',
    });
    expect(statusCode).toBe(415);
  });

  it('returns 200 for application/octet-stream (binary OTLP, allowed content type)', async () => {
    const port = getBoundPort(receiver);
    const { statusCode } = await httpRequest(
      port,
      'POST',
      '/v1/traces',
      Buffer.from([0x0a, 0x00]),
      { 'content-type': 'application/octet-stream' },
    );
    expect(statusCode).toBe(200);
  });

  it('returns 200 for Content-Type absent — defaults to application/json', async () => {
    const port = getBoundPort(receiver);
    // httpRequest sends no content-type header when headers arg is omitted
    const { statusCode } = await httpRequest(port, 'POST', '/v1/traces', '{}');
    expect(statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// abort mid-stream
// ---------------------------------------------------------------------------

describe('abort mid-stream', () => {
  it('returns 400 when client half-closes with an incomplete body', async () => {
    const receiver = makeReceiver();
    await receiver.start();
    try {
      const port = getBoundPort(receiver);
      const statusCode = await new Promise<number>((resolve, reject) => {
        const socket = createConnection({ host: '127.0.0.1', port }, () => {
          // Declare Content-Length: 100 but only send 10 bytes, then half-close.
          // socket.end() sends FIN but keeps the read side open so we can receive
          // the server's 400 response triggered by the "Incomplete body" check.
          socket.write(
            'POST /v1/traces HTTP/1.1\r\n' +
              'Host: 127.0.0.1\r\n' +
              'Content-Type: application/json\r\n' +
              'Content-Length: 100\r\n' +
              '\r\n' +
              '{"partial":',
          );
          socket.end();
        });

        let response = '';
        socket.on('data', (chunk: Buffer) => {
          response += chunk.toString();
          const match = /^HTTP\/1\.[01] (\d+)/.exec(response);
          if (match) {
            resolve(Number(match[1]));
            socket.destroy();
          }
        });
        socket.on('error', reject);
        socket.on('close', () => {
          const match = /^HTTP\/1\.[01] (\d+)/.exec(response);
          if (match) resolve(Number(match[1]));
          else reject(new Error('Connection closed without HTTP response'));
        });
      });
      expect(statusCode).toBe(400);
    } finally {
      await receiver.stop();
    }
  }, 5000);
});
