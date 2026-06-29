import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { sendMetrics } from './metric-api.js';
import type { NrMetric, TransportOptions } from './types.js';

const gunzipAsync = promisify(gunzip);

let fetchSpy: jest.SpiedFunction<typeof fetch>;
let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
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
    intervalMs: 60_000,
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

    // Decompress and verify payload structure. The
    // wire payload renames `intervalMs` to `'interval.ms'` per NR Metric
    // API contract; verify both shape and that the rename took effect.
    const body = init!.body as Buffer;
    const decompressed = await gunzipAsync(body);
    const payload = JSON.parse(decompressed.toString());
    expect(payload).toHaveLength(1);
    expect(payload[0].metrics).toHaveLength(2);
    expect(payload[0].metrics[0]).toMatchObject({
      name: 'ai.request.duration',
      type: 'gauge',
      value: 1234,
    });
    expect(payload[0].metrics[1]).toMatchObject({
      name: 'ai.request.tokens',
      type: 'count',
      value: 500,
      'interval.ms': 60_000,
      attributes: { model: 'claude-sonnet-4', provider: 'anthropic' },
    });
    // The camelCase TS field should NOT appear on the wire.
    expect(payload[0].metrics[1]).not.toHaveProperty('intervalMs');
  });

  // summary metric round-trips with structured value
  it('serializes a summary metric with structured value and interval.ms', async () => {
    const summaryMetric: NrMetric = {
      name: 'ai.duration',
      type: 'summary',
      timestamp: Date.now(),
      intervalMs: 5_000,
      value: { count: 3, sum: 35, min: 5, max: 20 },
      attributes: { model: 'claude' },
    };

    await sendMetrics([summaryMetric], 'us01xxTESTKEY', baseOptions);

    const [, init] = fetchSpy.mock.calls[0];
    const decompressed = await gunzipAsync(init!.body as Buffer);
    const payload = JSON.parse(decompressed.toString());
    const m = payload[0].metrics[0];
    expect(m.type).toBe('summary');
    expect(m.value).toEqual({ count: 3, sum: 35, min: 5, max: 20 });
    expect(m['interval.ms']).toBe(5_000);
    expect(m).not.toHaveProperty('intervalMs');
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
