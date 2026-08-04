import type { NrEventData, NrLogEntry, NrMetric, TransportOptions } from '../shared/index.js';
import {
  JP_INGEST_HOSTS,
  JP_NERDGRAPH_URL,
  JP_OTLP_ENDPOINT,
  JP_REGION,
  isJapanLicenseKey,
  isJapanRegion,
  jpSenderOverrides,
  sendEventsJp,
  sendLogsJp,
  sendMetricsJp,
} from './jp-region.js';

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

const baseOptions: TransportOptions = {
  accountId: '12345',
  // The 'jp' keyword arrives here in production; the JP senders must override
  // it with the correct per-API FQDN.
  collectorHost: JP_REGION,
  maxRetries: 3,
  baseDelayMs: 1,
  maxDelayMs: 10,
};

describe('isJapanRegion', () => {
  it('matches the jp keyword case- and whitespace-insensitively', () => {
    expect(isJapanRegion('jp')).toBe(true);
    expect(isJapanRegion('JP')).toBe(true);
    expect(isJapanRegion('  jp  ')).toBe(true);
  });

  it('returns false for other regions, FQDNs, and nullish', () => {
    expect(isJapanRegion('us')).toBe(false);
    expect(isJapanRegion('eu')).toBe(false);
    expect(isJapanRegion('gov')).toBe(false);
    expect(isJapanRegion('insights-collector.jp.nr-data.net')).toBe(false);
    expect(isJapanRegion(null)).toBe(false);
    expect(isJapanRegion(undefined)).toBe(false);
  });
});

describe('isJapanLicenseKey', () => {
  it('detects the jp region prefix', () => {
    expect(isJapanLicenseKey('jp01xxSOMEKEY123456')).toBe(true);
    expect(isJapanLicenseKey('JP01xxSOMEKEY123456')).toBe(true);
  });

  it('returns false for non-JP keys and nullish', () => {
    expect(isJapanLicenseKey('eu01xxSOMEKEY123456')).toBe(false);
    expect(isJapanLicenseKey('us01xxSOMEKEY123456')).toBe(false);
    expect(isJapanLicenseKey('0123456789abcdef')).toBe(false);
    expect(isJapanLicenseKey(undefined)).toBe(false);
  });
});

describe('JP senders route to the correct per-API subdomain', () => {
  it('sendEventsJp targets the JP events host', async () => {
    const events: NrEventData[] = [
      { eventType: 'AiToolCall', timestamp: Date.now() } as unknown as NrEventData,
    ];
    await sendEventsJp(events, 'jp01xxTESTKEY', baseOptions);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe(
      `https://${JP_INGEST_HOSTS.events}/v1/accounts/12345/events`,
    );
  });

  it('sendMetricsJp targets the JP metric host', async () => {
    const metrics: NrMetric[] = [
      { name: 'ai.request.duration', type: 'gauge', value: 1, timestamp: Date.now() },
    ];
    await sendMetricsJp(metrics, 'jp01xxTESTKEY', baseOptions);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe(`https://${JP_INGEST_HOSTS.metric}/metric/v1`);
  });

  it('sendLogsJp targets the JP log host', async () => {
    const logs: NrLogEntry[] = [{ timestamp: Date.now(), message: 'hello' }];
    await sendLogsJp(logs, 'jp01xxTESTKEY', baseOptions);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe(`https://${JP_INGEST_HOSTS.log}/log/v1`);
  });
});

describe('jpSenderOverrides', () => {
  it('returns the three JP senders when the region is jp', () => {
    const overrides = jpSenderOverrides('jp');
    expect(overrides.sendEventsFn).toBe(sendEventsJp);
    expect(overrides.sendMetricsFn).toBe(sendMetricsJp);
    expect(overrides.sendLogsFn).toBe(sendLogsJp);
  });

  it('returns an empty object (shared defaults) for non-JP regions', () => {
    expect(jpSenderOverrides('eu')).toEqual({});
    expect(jpSenderOverrides('gov')).toEqual({});
    expect(jpSenderOverrides(null)).toEqual({});
    expect(jpSenderOverrides(undefined)).toEqual({});
  });
});

describe('JP endpoint constants', () => {
  it('match the New Relic Japan data center hostnames', () => {
    expect(JP_INGEST_HOSTS.events).toBe('insights-collector.jp.nr-data.net');
    expect(JP_INGEST_HOSTS.metric).toBe('metric-api.jp.nr-data.net');
    expect(JP_INGEST_HOSTS.log).toBe('log-api.jp.nr-data.net');
    expect(JP_NERDGRAPH_URL).toBe('https://api.jp.newrelic.com/graphql');
    expect(JP_OTLP_ENDPOINT).toBe('https://otlp.jp.nr-data.net');
  });
});
