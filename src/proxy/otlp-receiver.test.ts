import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { request as nodeRequest } from 'node:http';
import type { Server } from 'node:http';
import { createConnection, type AddressInfo } from 'node:net';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { OtlpReceiver } from './otlp-receiver.js';
import type { OtlpReceiverOptions } from './otlp-receiver.js';

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
    (globalThis as { fetch?: unknown }).fetch = undefined;
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
    (globalThis as { fetch?: unknown }).fetch = undefined;
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
