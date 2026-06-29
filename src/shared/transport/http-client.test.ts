import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import {
  resolveRegion,
  getEventsApiUrl,
  getMetricApiUrl,
  getLogsApiUrl,
  compressPayload,
  sendWithRetry,
} from './http-client.js';
import type { HttpSendOptions } from './types.js';

const gunzipAsync = promisify(gunzip);

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
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
    baseDelayMs: 1, // fast for tests
    maxDelayMs: 10,
    requestTimeoutMs: 30_000,
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
  });

  // gov01 prefix maps to FedRAMP region
  it('returns gov for FedRAMP license key (gov01 prefix)', () => {
    expect(resolveRegion('gov01xxSOMEKEY123456', null)).toBe('gov');
    expect(resolveRegion('GOV01xxSOMEKEY123456', null)).toBe('gov');
  });

  // legacy keys without a region-prefix shape default to US
  it('returns us for legacy keys without a region prefix', () => {
    // Real NR legacy license keys are 40-char hex strings — they don't start
    // with a 2-4-letter prefix followed by 2 digits, so they bypass the strict
    // prefix check entirely.
    expect(resolveRegion('1234567890abcdef1234567890abcdef12345678', null)).toBe('us');
    // Even an all-letter key with no digits in the prefix shape is legacy.
    expect(resolveRegion('abcdefNRAL', null)).toBe('us');
  });

  // throw on unrecognized region-shaped prefixes rather than silently
  // misrouting data. This catches typos and future regions we don't yet support.
  it('throws on unrecognized region-shaped license-key prefix', () => {
    expect(() => resolveRegion('apac01xxSOMEKEY', null)).toThrow(/Unrecognized.*region prefix/);
    expect(() => resolveRegion('xx99xxSOMEKEY', null)).toThrow(/xx99/);
  });

  it('throw message names the supported prefixes', () => {
    try {
      resolveRegion('apac01xxSOMEKEY', null);
      fail('expected throw');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('us01');
      expect(msg).toContain('eu01');
      expect(msg).toContain('gov01');
    }
  });

  it('does not throw when collectorHost is provided to override detection', () => {
    // Bare keyword form short-circuits the license-key check entirely.
    expect(resolveRegion('apac01xxSOMEKEY', 'eu')).toBe('eu');
  });

  // ---------------------------------------------------------------------------
  // 2. resolveRegion — collectorHost override (keyword-only form)
  // ---------------------------------------------------------------------------
  it('bare keyword collectorHost values are recognized (eu, gov, us)', () => {
    expect(resolveRegion('us01xxSOMEKEY', 'eu')).toBe('eu');
    expect(resolveRegion('us01xxSOMEKEY', 'gov')).toBe('gov');
    expect(resolveRegion('eu01xxSOMEKEY', 'us')).toBe('us');
  });

  it('FQDN collectorHost falls through to license-key prefix detection', () => {
    // Previously, FQDNs were substring-matched ('eu' in 'collector.eu01.nr-data.net').
    // Now only bare keywords are matched; FQDNs fall through to the license key.
    expect(resolveRegion('us01xxSOMEKEY', 'collector.eu01.nr-data.net')).toBe('us'); // license key is us
    expect(resolveRegion('eu01xxSOMEKEY', 'collector.eu01.nr-data.net')).toBe('eu'); // license key is eu
    expect(resolveRegion('us01xxSOMEKEY', 'collector.newrelic.com')).toBe('us');
  });

  it('FQDN containing eu/gov substring does not false-positive', () => {
    // 'bureau-collector.local' contains 'eu', 'eucalyptus.test' likewise.
    expect(resolveRegion('us01xxSOMEKEY', 'bureau-collector.local')).toBe('us');
    expect(resolveRegion('us01xxSOMEKEY', 'eucalyptus.test')).toBe('us');
  });

  // gov collectorHost override (bare keyword only)
  it('returns gov when collectorHost is the bare keyword gov', () => {
    expect(resolveRegion('us01xxSOMEKEY', 'gov')).toBe('gov');
    // FQDN form no longer matches — license key prefix wins instead
    expect(resolveRegion('gov01xxSOMEKEY', 'gov-insights-collector.newrelic.com')).toBe('gov'); // license key
  });
});

// ---------------------------------------------------------------------------
// URL builders
// ---------------------------------------------------------------------------
describe('getEventsApiUrl', () => {
  it('returns US endpoint for us region', () => {
    expect(getEventsApiUrl('12345', 'us')).toBe(
      'https://insights-collector.newrelic.com/v1/accounts/12345/events',
    );
  });

  it('returns EU endpoint for eu region', () => {
    expect(getEventsApiUrl('12345', 'eu')).toBe(
      'https://insights-collector.eu01.nr-data.net/v1/accounts/12345/events',
    );
  });

  it('returns FedRAMP endpoint for gov region', () => {
    expect(getEventsApiUrl('12345', 'gov')).toBe(
      'https://gov-insights-collector.newrelic.com/v1/accounts/12345/events',
    );
  });

  // literal-hostname override
  it('uses collectorHost as literal URL host when it contains a dot', () => {
    expect(getEventsApiUrl('12345', 'us', 'collector.example.com')).toBe(
      'https://collector.example.com/v1/accounts/12345/events',
    );
  });

  it('uses collectorHost as literal URL host when it contains a port', () => {
    expect(getEventsApiUrl('12345', 'us', 'proxy.local:9000')).toBe(
      'https://proxy.local:9000/v1/accounts/12345/events',
    );
  });

  // Defensive guard against an empty / null / undefined
  // accountId that bypassed loadConfig's fail-fast (JS callers, non-null
  // assertion casts, custom config paths). Without the guard, the URL becomes
  // `.../accounts/null/events` and NR returns 404 silently.
  it('throws when accountId is empty string', () => {
    expect(() => getEventsApiUrl('', 'us')).toThrow('accountId is required');
  });

  it('throws when accountId is the string "null" (e.g. from `String(null)` in JS)', () => {
    expect(() => getEventsApiUrl('null', 'us')).toThrow('accountId is required');
  });

  it('throws when accountId is the string "undefined"', () => {
    expect(() => getEventsApiUrl('undefined', 'us')).toThrow('accountId is required');
  });

  it('error message points the operator at NEW_RELIC_ACCOUNT_ID', () => {
    expect(() => getEventsApiUrl('', 'us')).toThrow('NEW_RELIC_ACCOUNT_ID');
  });
});

describe('getMetricApiUrl', () => {
  it('returns FedRAMP endpoint for gov region', () => {
    expect(getMetricApiUrl('gov')).toBe('https://gov-metric-api.newrelic.com/metric/v1');
  });

  it('uses collectorHost as literal URL host when it contains a dot', () => {
    expect(getMetricApiUrl('us', 'collector.example.com')).toBe(
      'https://collector.example.com/metric/v1',
    );
  });
});

describe('getLogsApiUrl', () => {
  it('returns FedRAMP endpoint for gov region', () => {
    expect(getLogsApiUrl('gov')).toBe('https://gov-log-api.newrelic.com/log/v1');
  });

  it('uses collectorHost as literal URL host when it contains a dot', () => {
    expect(getLogsApiUrl('us', 'collector.example.com')).toBe(
      'https://collector.example.com/log/v1',
    );
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
    // User-Agent identifies the consuming client on NR's
    // collector access logs. Without clientVersion the format is just the name.
    expect(headers['User-Agent']).toBe('ai-telemetry');
  });

  // 4b. Verifies User-Agent includes version when clientVersion is set
  it('sends name/version User-Agent when clientVersion is provided', async () => {
    fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }));

    await sendWithRetry(baseOptions({ clientName: 'preflight', clientVersion: '1.2.3' }));

    const [, init] = fetchSpy.mock.calls[0];
    const headers = init!.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe('preflight/1.2.3');

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

  // 5b. 202 response — success (NR APIs return 202 Accepted)
  it('returns success for 202 response', async () => {
    fetchSpy.mockResolvedValue(new Response('{}', { status: 202 }));

    const result = await sendWithRetry(baseOptions());

    expect(result).toEqual({
      success: true,
      statusCode: 202,
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

  // surface the 403 response body in result.error
  it('propagates the 403 response body into result.error', async () => {
    fetchSpy.mockResolvedValue(
      new Response('License key invalid for account 123456', { status: 403 }),
    );
    const result = await sendWithRetry(baseOptions());
    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(403);
    expect(result.error).toContain('License key invalid for account 123456');
  });

  it('falls back to "forbidden" when the 403 response body is empty', async () => {
    fetchSpy.mockResolvedValue(new Response('', { status: 403 }));
    const result = await sendWithRetry(baseOptions());
    expect(result.error).toBe('forbidden');
  });

  // surface the 400 response body in result.error
  it('returns failure for 400 and surfaces the response body in result.error', async () => {
    fetchSpy.mockResolvedValue(
      new Response('Reserved attribute name "accountId"', { status: 400 }),
    );
    const result = await sendWithRetry(baseOptions());
    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(400);
    expect(result.error).toContain('Reserved attribute name');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to "bad request" when the 400 response body is empty', async () => {
    fetchSpy.mockResolvedValue(new Response('', { status: 400 }));
    const result = await sendWithRetry(baseOptions());
    expect(result.error).toBe('bad request');
  });

  it('truncates very long 400 response bodies to 1024 chars', async () => {
    const huge = 'x'.repeat(5000);
    fetchSpy.mockResolvedValue(new Response(huge, { status: 400 }));
    const result = await sendWithRetry(baseOptions());
    expect(result.success).toBe(false);
    // Truncation cap is 1024 chars; surrounding "bad request: " prefix adds bytes.
    expect((result.error ?? '').length).toBeLessThanOrEqual(1024 + 'bad request: '.length);
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

  // 7b. Honor Retry-After header on 429.
  // Removed the flaky lower-bound (≥40ms) assertion. The lower bound's
  // intent was to prove the delay fired, but on a loaded CI runner a 50ms
  // setTimeout can drift to 100–200ms and make the lower bound trivially true.
  // The regression guard is the upper bound (< 900ms): if Math.min cap were
  // dropped the implementation would wait 1000ms and fail the upper bound.
  it('honors Retry-After header (delta-seconds) on 429 within maxDelayMs cap', async () => {
    // First attempt: 429 with Retry-After: 1 (1s = 1000ms, cap to 50ms below).
    // Second attempt: 200.
    fetchSpy
      .mockResolvedValueOnce(
        new Response('Rate limited', {
          status: 429,
          headers: { 'Retry-After': '1' },
        }),
      )
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const start = Date.now();
    const result = await sendWithRetry(
      baseOptions({ maxRetries: 2, baseDelayMs: 1, maxDelayMs: 50 }),
    );
    const elapsed = Date.now() - start;

    expect(result.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // Upper-bound regression guard: if Math.min cap were dropped, delay = 1000ms.
    expect(elapsed).toBeLessThan(900);
  });

  // 7c. HTTP-date form of Retry-After is parsed too.
  it('honors Retry-After header (HTTP-date) on 503', async () => {
    const futureDate = new Date(Date.now() + 1_000).toUTCString();
    fetchSpy
      .mockResolvedValueOnce(
        new Response('Service unavailable', {
          status: 503,
          headers: { 'Retry-After': futureDate },
        }),
      )
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const start = Date.now();
    const result = await sendWithRetry(
      baseOptions({ maxRetries: 2, baseDelayMs: 1, maxDelayMs: 50 }),
    );
    const elapsed = Date.now() - start;

    expect(result.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // upper-bound only — no flaky lower bound.
    expect(elapsed).toBeLessThan(900);
  });

  // 7d. Malformed Retry-After falls back to exponential backoff
  // (i.e. it must not throw, and must not stall forever).
  it('falls back to exponential backoff when Retry-After is malformed', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response('Rate limited', {
          status: 429,
          headers: { 'Retry-After': 'not-a-number-or-date' },
        }),
      )
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await sendWithRetry(
      baseOptions({ maxRetries: 2, baseDelayMs: 1, maxDelayMs: 10 }),
    );

    expect(result.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  // 7e. Verify decorrelated-jitter backoff widens
  // each retry's window. Pin Math.random so the sample is deterministic, then
  // capture setTimeout calls to assert the requested delay sequence.
  it('decorrelated-jitter backoff: each retry samples a wider [base, prev*3] band', async () => {
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    // With Math.random=0.5: sample = base + (upper - base) * 0.5 = (base + upper) / 2
    //   attempt 0: prev=100, upper=min(10000, 300)=300 → (100+300)/2 = 200
    //   attempt 1: prev=200, upper=min(10000, 600)=600 → (100+600)/2 = 350
    //   attempt 2: prev=350, upper=min(10000, 1050)=1050 → (100+1050)/2 = 575
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);

    fetchSpy
      .mockResolvedValueOnce(new Response('Server error', { status: 500 }))
      .mockResolvedValueOnce(new Response('Server error', { status: 500 }))
      .mockResolvedValueOnce(new Response('Server error', { status: 500 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const start = Date.now();
    const result = await sendWithRetry(
      baseOptions({ maxRetries: 3, baseDelayMs: 100, maxDelayMs: 10_000 }),
    );
    const elapsed = Date.now() - start;

    expect(result.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(4);

    // Filter to only backoff-path setTimeouts (≥ 50ms threshold ignores the
    // 0-ms internal timers that node-fetch / Response plumbing may schedule).
    const backoffDelays = setTimeoutSpy.mock.calls
      .map((call) => call[1] as number | undefined)
      .filter((ms): ms is number => typeof ms === 'number' && ms >= 50);

    expect(backoffDelays).toEqual([200, 350, 575]);

    // Regression guard: total elapsed time matches the sum of scheduled delays.
    expect(elapsed).toBeGreaterThanOrEqual(200 + 350 + 575 - 50); // -50ms slack

    randomSpy.mockRestore();
    setTimeoutSpy.mockRestore();
  });

  // 7f. Verify maxDelayMs caps the decorrelated-jitter backoff.
  it('decorrelated-jitter backoff caps at maxDelayMs', async () => {
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);

    fetchSpy
      .mockResolvedValueOnce(new Response('Server error', { status: 500 }))
      .mockResolvedValueOnce(new Response('Server error', { status: 500 }))
      .mockResolvedValueOnce(new Response('Server error', { status: 500 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await sendWithRetry(
      // baseDelayMs=100 / maxDelayMs=200 → upper saturates at 200 immediately.
      baseOptions({ maxRetries: 3, baseDelayMs: 100, maxDelayMs: 200 }),
    );

    expect(result.success).toBe(true);

    const backoffDelays = setTimeoutSpy.mock.calls
      .map((call) => call[1] as number | undefined)
      .filter((ms): ms is number => typeof ms === 'number' && ms >= 50);

    // With Math.random=0.5 and maxDelayMs=200:
    //   attempt 0: prev=100, upper=min(200, 300)=200 → (100+200)/2 = 150
    //   attempt 1: prev=150, upper=min(200, 450)=200 → (100+200)/2 = 150
    //   attempt 2: prev=150, upper=min(200, 450)=200 → (100+200)/2 = 150
    expect(backoffDelays).toEqual([150, 150, 150]);

    randomSpy.mockRestore();
    setTimeoutSpy.mockRestore();
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

  // 10. `AbortSignal.timeout` aborts a hung fetch
  //
  // `signal: AbortSignal.timeout(requestTimeoutMs)` means: mock fetch to never
  // resolve and verify sendWithRetry rejects within timeout + retry budget.
  // We simulate a hung
  // connection by having fetch return a promise that rejects only when the
  // abort signal fires (which AbortSignal.timeout will trigger after
  // requestTimeoutMs). Without the timeout, this test would hang past the
  // Jest timeout.
  it('aborts a hung fetch via AbortSignal.timeout', async () => {
    // Hang until the per-request abort signal fires; reject with the abort
    // reason (a DOMException 'TimeoutError' from AbortSignal.timeout).
    fetchSpy.mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        const signal = (init as RequestInit).signal as AbortSignal;
        signal.addEventListener('abort', () => reject(signal.reason));
      });
    });

    const start = Date.now();
    const result = await sendWithRetry(
      // maxRetries: 0 → exactly one attempt; isolates the per-request timeout.
      baseOptions({ maxRetries: 0, requestTimeoutMs: 50 }),
    );
    const elapsed = Date.now() - start;

    expect(result.success).toBe(false);
    expect(result.statusCode).toBeNull();
    expect(result.error).toContain('network error');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // The fetch must have been aborted around the timeout (50ms), well before
    // any Jest default test timeout. Generous upper bound to absorb CI jitter.
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(2000);
  });

  // 10b. Per-attempt timeout applies on every retry; total wall-clock
  // is bounded by (timeout + backoff) × (maxRetries + 1).
  it('per-attempt timeout fires on each retry within the retry budget', async () => {
    fetchSpy.mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        const signal = (init as RequestInit).signal as AbortSignal;
        signal.addEventListener('abort', () => reject(signal.reason));
      });
    });

    const start = Date.now();
    const result = await sendWithRetry(
      baseOptions({
        maxRetries: 2,
        requestTimeoutMs: 50,
        baseDelayMs: 1,
        maxDelayMs: 5,
      }),
    );
    const elapsed = Date.now() - start;

    expect(result.success).toBe(false);
    expect(result.statusCode).toBeNull();
    expect(result.error).toContain('network error');
    // 1 initial + 2 retries = 3 attempts, each timing out at ~50ms.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    // 3 × 50ms timeout + 2 × ≤5ms backoff = ~160ms; bound at 2s for CI slack.
    expect(elapsed).toBeGreaterThanOrEqual(120);
    expect(elapsed).toBeLessThan(2000);
  });
});
