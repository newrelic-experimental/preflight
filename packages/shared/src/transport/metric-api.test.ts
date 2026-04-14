import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { sendMetrics } from './metric-api.js';
import type { NrMetric, TransportOptions } from './types.js';

const gunzipAsync = promisify(gunzip);

let fetchSpy: jest.SpiedFunction<typeof fetch>;
let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  fetchSpy.mockRestore();
  stderrSpy.mockRestore();
});

const testMetrics: NrMetric[] = [
  { name: 'ai.request.duration', type: 'gauge', value: 1234, timestamp: Date.now() },
  {
    name: 'ai.request.tokens',
    type: 'count',
    value: 500,
    timestamp: Date.now(),
    attributes: { model: 'claude-sonnet-4', provider: 'anthropic' },
  },
];

const baseOptions: TransportOptions = {
  accountId: '12345',
  maxRetries: 3,
  baseDelayMs: 1,
  maxDelayMs: 10,
};

describe('sendMetrics', () => {
  // ---------------------------------------------------------------------------
  // 1. Payload format matches NR Metric API structure
  // ---------------------------------------------------------------------------
  it('wraps metrics in [{ metrics: [...] }] structure', async () => {
    await sendMetrics(testMetrics, 'us01xxTESTKEY', baseOptions);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://metric-api.newrelic.com/metric/v1');

    // Decompress and verify payload structure
    const body = init!.body as Buffer;
    const decompressed = await gunzipAsync(body);
    const payload = JSON.parse(decompressed.toString());
    expect(payload).toEqual([{ metrics: testMetrics }]);
  });

  // ---------------------------------------------------------------------------
  // 2. EU region routes to EU metric endpoint
  // ---------------------------------------------------------------------------
  it('routes to EU endpoint for EU license key', async () => {
    await sendMetrics(testMetrics, 'eu01xxEUKEY123', baseOptions);

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://metric-api.eu.newrelic.com/metric/v1');
  });

  // ---------------------------------------------------------------------------
  // 3. Empty array — no fetch
  // ---------------------------------------------------------------------------
  it('returns success without calling fetch for empty metrics', async () => {
    const result = await sendMetrics([], 'us01xxTESTKEY', baseOptions);

    expect(result.success).toBe(true);
    expect(result.statusCode).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
