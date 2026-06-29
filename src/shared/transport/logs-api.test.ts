import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { sendLogs } from './logs-api.js';
import type { NrLogEntry } from './logs-api.js';
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

const testLogs: NrLogEntry[] = [
  {
    timestamp: 1_700_000_000_000,
    message: 'Tool call: Read /src/index.ts',
    attributes: { tool: 'Read', 'audit.action': 'FileRead', developer: 'alice' },
  },
  {
    timestamp: 1_700_000_001_000,
    message: 'Tool call: Bash command="npm test"',
    attributes: { tool: 'Bash', 'audit.action': 'BashCommand', developer: 'alice' },
  },
];

const baseOptions: TransportOptions = {
  accountId: '12345',
  maxRetries: 3,
  baseDelayMs: 1,
  maxDelayMs: 10,
};

// ---------------------------------------------------------------------------
// sendLogs
// ---------------------------------------------------------------------------

describe('sendLogs', () => {
  it('sends with correct headers, URL, and gzipped Logs API envelope', async () => {
    const result = await sendLogs(testLogs, 'us01xxTESTKEY', baseOptions);

    expect(result.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://log-api.newrelic.com/log/v1');

    const headers = init!.headers as Record<string, string>;
    expect(headers['Api-Key']).toBe('us01xxTESTKEY');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Content-Encoding']).toBe('gzip');

    // Decompress body and verify the Logs API envelope format
    const body = init!.body as Buffer;
    const decompressed = await gunzipAsync(body);
    const payload = JSON.parse(decompressed.toString());
    expect(payload).toEqual([{ logs: testLogs }]);
  });

  it('returns success for 200 response', async () => {
    const result = await sendLogs(testLogs, 'us01xxTESTKEY', baseOptions);

    expect(result).toEqual({
      success: true,
      statusCode: 200,
      retryCount: 0,
    });
  });

  it('returns success without calling fetch for empty logs', async () => {
    const result = await sendLogs([], 'us01xxTESTKEY', baseOptions);

    expect(result.success).toBe(true);
    expect(result.statusCode).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('routes to EU endpoint for EU license key', async () => {
    await sendLogs(testLogs, 'eu01xxEUKEY123', baseOptions);

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://log-api.eu.newrelic.com/log/v1');
  });

  // collectorHost containing a dot is treated as a literal host override
  // and used verbatim in the URL — the path is per-API but the host is whatever
  // the caller provided. This lets users route through proxies or to non-NR
  // collectors without us second-guessing their hostname.
  it('uses literal collectorHost as URL host when it contains a dot', async () => {
    await sendLogs(testLogs, 'us01xxUSKEY', {
      ...baseOptions,
      collectorHost: 'collector.eu01.nr-data.net',
    });

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://collector.eu01.nr-data.net/log/v1');
  });

  it('uses literal collectorHost as URL host when it contains a port', async () => {
    await sendLogs(testLogs, 'us01xxUSKEY', {
      ...baseOptions,
      collectorHost: 'my-proxy.example.com:8443',
    });

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://my-proxy.example.com:8443/log/v1');
  });
});

// ---------------------------------------------------------------------------
// Integration test — requires env vars
// ---------------------------------------------------------------------------

const HAS_NR_CREDS = process.env.NEW_RELIC_LICENSE_KEY && process.env.NEW_RELIC_ACCOUNT_ID;

(HAS_NR_CREDS ? describe : describe.skip)('integration: Logs API', () => {
  beforeEach(() => {
    fetchSpy.mockRestore();
  });

  it('sends a real log entry to NR Logs API', async () => {
    const result = await sendLogs(
      [
        {
          timestamp: Date.now(),
          message: 'Integration test log entry from jest',
          attributes: {
            source: 'jest-integration',
            testId: Date.now(),
          },
        },
      ],
      process.env.NEW_RELIC_LICENSE_KEY!,
      { accountId: process.env.NEW_RELIC_ACCOUNT_ID! },
    );
    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(200);
  });
});
