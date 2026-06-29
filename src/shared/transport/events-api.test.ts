import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { sendEvents } from './events-api.js';
import type { NrEventData } from '../events/types.js';
import type { TransportOptions } from './types.js';

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

const testEvents: NrEventData[] = [
  { eventType: 'AiRequest', model: 'claude-sonnet-4', durationMs: 123 },
  { eventType: 'AiResponse', inputTokens: 100, outputTokens: 50 },
];

const baseOptions: TransportOptions = {
  accountId: '12345',
  maxRetries: 3,
  baseDelayMs: 1,
  maxDelayMs: 10,
};

// ---------------------------------------------------------------------------
// 1. Correct headers and URL
// ---------------------------------------------------------------------------
describe('sendEvents', () => {
  it('sends with correct headers, URL, and gzipped JSON body', async () => {
    const result = await sendEvents(testEvents, 'us01xxTESTKEY', baseOptions);

    expect(result.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://insights-collector.newrelic.com/v1/accounts/12345/events');

    const headers = init!.headers as Record<string, string>;
    expect(headers['Api-Key']).toBe('us01xxTESTKEY');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Content-Encoding']).toBe('gzip');

    // Decompress body and verify it matches events array
    const body = init!.body as Buffer;
    const decompressed = await gunzipAsync(body);
    expect(JSON.parse(decompressed.toString())).toEqual(testEvents);
  });

  // ---------------------------------------------------------------------------
  // 2. 200 → success
  // ---------------------------------------------------------------------------
  it('returns success for 200 response', async () => {
    const result = await sendEvents(testEvents, 'us01xxTESTKEY', baseOptions);

    expect(result).toEqual({
      success: true,
      statusCode: 200,
      retryCount: 0,
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Empty array → no fetch call
  // ---------------------------------------------------------------------------
  it('returns success without calling fetch for empty events', async () => {
    const result = await sendEvents([], 'us01xxTESTKEY', baseOptions);

    expect(result.success).toBe(true);
    expect(result.statusCode).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // 4. EU region detection
  // ---------------------------------------------------------------------------
  it('routes to EU endpoint for EU license key', async () => {
    await sendEvents(testEvents, 'eu01xxEUKEY123', baseOptions);

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://insights-collector.eu01.nr-data.net/v1/accounts/12345/events');
  });

  // collectorHost containing a dot is treated as a literal host override.
  it('uses literal collectorHost as URL host when it contains a dot', async () => {
    await sendEvents(testEvents, 'us01xxUSKEY', {
      ...baseOptions,
      collectorHost: 'collector.eu01.nr-data.net',
    });

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://collector.eu01.nr-data.net/v1/accounts/12345/events');
  });

  it('uses literal collectorHost as URL host when it contains a port', async () => {
    await sendEvents(testEvents, 'us01xxUSKEY', {
      ...baseOptions,
      collectorHost: 'my-proxy.example.com:8443',
    });

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://my-proxy.example.com:8443/v1/accounts/12345/events');
  });
});

// ---------------------------------------------------------------------------
// Integration test — requires env vars
// ---------------------------------------------------------------------------
const HAS_NR_CREDS = process.env.NEW_RELIC_LICENSE_KEY && process.env.NEW_RELIC_ACCOUNT_ID;

(HAS_NR_CREDS ? describe : describe.skip)('integration: Events API', () => {
  beforeEach(() => {
    // Restore real fetch for integration tests
    fetchSpy.mockRestore();
  });

  it('sends a real event to NR Events API', async () => {
    const result = await sendEvents(
      [
        {
          eventType: 'AiObservatoryTest',
          testId: Date.now(),
          source: 'jest-integration',
        },
      ],
      process.env.NEW_RELIC_LICENSE_KEY!,
      { accountId: process.env.NEW_RELIC_ACCOUNT_ID! },
    );
    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(200);
  });
});
