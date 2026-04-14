import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import {
  resolveRegion,
  compressPayload,
  sendWithRetry,
} from './http-client.js';
import type { HttpSendOptions } from './types.js';

const gunzipAsync = promisify(gunzip);

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
  jest.restoreAllMocks();
});

function baseOptions(overrides: Partial<HttpSendOptions> = {}): HttpSendOptions {
  return {
    url: 'https://insights-collector.newrelic.com/v1/accounts/12345/events',
    body: [{ eventType: 'Test', value: 1 }],
    licenseKey: 'us01xxTESTKEY',
    maxRetries: 3,
    baseDelayMs: 1,   // fast for tests
    maxDelayMs: 10,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. resolveRegion — EU license key
// ---------------------------------------------------------------------------
describe('resolveRegion', () => {
  it('returns eu for EU license key and us for US key', () => {
    expect(resolveRegion('eu01xxSOMEKEY123456', null)).toBe('eu');
    expect(resolveRegion('EU01xxSOMEKEY123456', null)).toBe('eu');
    expect(resolveRegion('us01xxSOMEKEY123456', null)).toBe('us');
    expect(resolveRegion('abc123NRAL', null)).toBe('us');
  });

  // ---------------------------------------------------------------------------
  // 2. resolveRegion — collectorHost override
  // ---------------------------------------------------------------------------
  it('returns eu when collectorHost contains eu', () => {
    expect(resolveRegion('us01xxSOMEKEY', 'collector.eu01.nr-data.net')).toBe('eu');
    expect(resolveRegion('us01xxSOMEKEY', 'insights-collector.EU01.nr-data.net')).toBe('eu');
    // collectorHost without eu falls through to license key check
    expect(resolveRegion('us01xxSOMEKEY', 'collector.newrelic.com')).toBe('us');
  });
});

// ---------------------------------------------------------------------------
// 3. compressPayload — roundtrip
// ---------------------------------------------------------------------------
describe('compressPayload', () => {
  it('produces valid gzip that roundtrips to the original JSON', async () => {
    const data = [{ eventType: 'TestEvent', count: 42, label: 'hello' }];
    const compressed = await compressPayload(data);

    expect(Buffer.isBuffer(compressed)).toBe(true);
    expect(compressed.length).toBeGreaterThan(0);

    const decompressed = await gunzipAsync(compressed);
    expect(JSON.parse(decompressed.toString())).toEqual(data);
  });
});

// ---------------------------------------------------------------------------
// 4-9. sendWithRetry
// ---------------------------------------------------------------------------
describe('sendWithRetry', () => {
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // 4. Verifies gzip headers
  it('sends gzip-compressed body with correct headers', async () => {
    fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }));

    await sendWithRetry(baseOptions());

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://insights-collector.newrelic.com/v1/accounts/12345/events');
    const headers = init!.headers as Record<string, string>;
    expect(headers['Api-Key']).toBe('us01xxTESTKEY');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Content-Encoding']).toBe('gzip');

    // Body should be a Buffer (gzip output)
    const body = init!.body as Buffer;
    expect(Buffer.isBuffer(body)).toBe(true);

    // Decompress to verify contents
    const decompressed = await gunzipAsync(body);
    expect(JSON.parse(decompressed.toString())).toEqual([{ eventType: 'Test', value: 1 }]);
  });

  // 5. 200 response — success
  it('returns success for 200 response', async () => {
    fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }));

    const result = await sendWithRetry(baseOptions());

    expect(result).toEqual({
      success: true,
      statusCode: 200,
      retryCount: 0,
    });
  });

  // 6. 403 response — no retry
  it('returns failure for 403 and does not retry', async () => {
    fetchSpy.mockResolvedValue(new Response('Forbidden', { status: 403 }));

    const result = await sendWithRetry(baseOptions());

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(403);
    expect(result.error).toContain('forbidden');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  // 7. 429 response — retries
  it('retries on 429 and respects maxRetries', async () => {
    fetchSpy.mockResolvedValue(new Response('Rate limited', { status: 429 }));

    const result = await sendWithRetry(baseOptions({ maxRetries: 2 }));

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(429);
    expect(result.error).toContain('max retries exhausted');
    // 1 initial + 2 retries = 3 calls
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  // 8. Network error — retries
  it('retries on network error', async () => {
    fetchSpy
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValue(new Response('{}', { status: 200 }));

    const result = await sendWithRetry(baseOptions());

    expect(result.success).toBe(true);
    expect(result.retryCount).toBe(2);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  // 9. Max retries exhausted — failure
  it('returns failure after exhausting max retries on network errors', async () => {
    fetchSpy.mockRejectedValue(new TypeError('fetch failed'));

    const result = await sendWithRetry(baseOptions({ maxRetries: 2 }));

    expect(result.success).toBe(false);
    expect(result.statusCode).toBeNull();
    expect(result.error).toContain('network error');
    // 1 initial + 2 retries = 3 calls
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});
