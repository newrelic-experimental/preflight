import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  validateLicenseKey,
  validateApiKey,
  getEventsApiUrl,
  getNerdgraphUrl,
} from './key-validator.js';

// ---------------------------------------------------------------------------
// URL helper tests
// ---------------------------------------------------------------------------

describe('getEventsApiUrl', () => {
  it('returns US endpoint by default', () => {
    expect(getEventsApiUrl('12345', null)).toBe(
      'https://insights-collector.newrelic.com/v1/accounts/12345/events',
    );
  });

  it('returns US endpoint for us collectorHost', () => {
    expect(getEventsApiUrl('12345', 'us')).toBe(
      'https://insights-collector.newrelic.com/v1/accounts/12345/events',
    );
  });

  it('returns EU endpoint', () => {
    expect(getEventsApiUrl('12345', 'eu')).toBe(
      'https://insights-collector.eu01.nr-data.net/v1/accounts/12345/events',
    );
  });

  it('returns gov endpoint', () => {
    expect(getEventsApiUrl('12345', 'gov')).toBe(
      'https://gov-insights-collector.newrelic.com/v1/accounts/12345/events',
    );
  });

  it('falls back to US for unknown collectorHost', () => {
    expect(getEventsApiUrl('12345', 'unknown-region')).toBe(
      'https://insights-collector.newrelic.com/v1/accounts/12345/events',
    );
  });
});

describe('getNerdgraphUrl', () => {
  it('returns US endpoint by default', () => {
    expect(getNerdgraphUrl(null)).toBe('https://api.newrelic.com/graphql');
  });

  it('returns EU endpoint', () => {
    expect(getNerdgraphUrl('eu')).toBe('https://api.eu.newrelic.com/graphql');
  });

  it('returns US endpoint for gov (no distinct gov NerdGraph URL)', () => {
    expect(getNerdgraphUrl('gov')).toBe('https://api.newrelic.com/graphql');
  });
});

// ---------------------------------------------------------------------------
// validateLicenseKey tests
// ---------------------------------------------------------------------------

describe('validateLicenseKey', () => {
  let fetchSpy: jest.MockedFunction<typeof globalThis.fetch>;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch') as jest.MockedFunction<typeof globalThis.fetch>;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns valid:true on HTTP 200', async () => {
    fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }));
    const result = await validateLicenseKey({
      licenseKey: 'TEST-KEY',
      accountId: '12345',
      collectorHost: null,
    });
    expect(result.valid).toBe(true);
  });

  it('returns unauthorized on HTTP 403', async () => {
    fetchSpy.mockResolvedValue(new Response('Forbidden', { status: 403 }));
    const result = await validateLicenseKey({
      licenseKey: 'BAD-KEY',
      accountId: '12345',
      collectorHost: null,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('unauthorized');
    expect(result.detail).toContain('403');
  });

  it('returns unauthorized on HTTP 401', async () => {
    fetchSpy.mockResolvedValue(new Response('Unauthorized', { status: 401 }));
    const result = await validateLicenseKey({
      licenseKey: 'BAD-KEY',
      accountId: '12345',
      collectorHost: null,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('unauthorized');
  });

  it('returns server-error on other non-200 status', async () => {
    fetchSpy.mockResolvedValue(new Response('Error', { status: 500 }));
    const result = await validateLicenseKey({
      licenseKey: 'TEST-KEY',
      accountId: '12345',
      collectorHost: null,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('server-error');
    expect(result.detail).toContain('500');
  });

  it('returns timeout on AbortError', async () => {
    // undici (Node.js native fetch) throws a plain Error with name 'AbortError', not DOMException
    const abortError = Object.assign(new Error('The operation was aborted.'), {
      name: 'AbortError',
    });
    fetchSpy.mockRejectedValue(abortError);
    const result = await validateLicenseKey({
      licenseKey: 'TEST-KEY',
      accountId: '12345',
      collectorHost: null,
      timeoutMs: 100,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('timeout');
  });

  it('returns network on general fetch error', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await validateLicenseKey({
      licenseKey: 'TEST-KEY',
      accountId: '12345',
      collectorHost: null,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('network');
    expect(result.detail).toContain('ECONNREFUSED');
  });

  it('uses EU ingest URL when collectorHost is eu', async () => {
    fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }));
    await validateLicenseKey({ licenseKey: 'EU01-KEY', accountId: '12345', collectorHost: 'eu' });
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('eu01.nr-data.net'),
      expect.any(Object),
    );
  });

  it('sends X-Insert-Key header', async () => {
    fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }));
    await validateLicenseKey({ licenseKey: 'MY-KEY', accountId: '12345', collectorHost: null });
    const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((options.headers as Record<string, string>)['X-Insert-Key']).toBe('MY-KEY');
  });
});

// ---------------------------------------------------------------------------
// validateApiKey tests
// ---------------------------------------------------------------------------

describe('validateApiKey', () => {
  let fetchSpy: jest.MockedFunction<typeof globalThis.fetch>;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch') as jest.MockedFunction<typeof globalThis.fetch>;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns valid:true and email on success', async () => {
    const body = JSON.stringify({ data: { actor: { user: { email: 'dev@example.com' } } } });
    fetchSpy.mockResolvedValue(new Response(body, { status: 200 }));
    const result = await validateApiKey({ nrApiKey: 'NRAK-TEST', collectorHost: null });
    expect(result.valid).toBe(true);
    expect(result.detail).toBe('dev@example.com');
  });

  it('returns valid:true without email when email missing', async () => {
    const body = JSON.stringify({ data: { actor: { user: {} } } });
    fetchSpy.mockResolvedValue(new Response(body, { status: 200 }));
    const result = await validateApiKey({ nrApiKey: 'NRAK-TEST', collectorHost: null });
    expect(result.valid).toBe(true);
    expect(result.detail).toBeUndefined();
  });

  it('returns unauthorized on HTTP 401', async () => {
    fetchSpy.mockResolvedValue(new Response('Unauthorized', { status: 401 }));
    const result = await validateApiKey({ nrApiKey: 'BAD-KEY', collectorHost: null });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('unauthorized');
  });

  it('returns unauthorized on HTTP 403', async () => {
    fetchSpy.mockResolvedValue(new Response('Forbidden', { status: 403 }));
    const result = await validateApiKey({ nrApiKey: 'BAD-KEY', collectorHost: null });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('unauthorized');
  });

  it('returns unauthorized when GraphQL errors contain an auth error code', async () => {
    const body = JSON.stringify({
      errors: [{ message: 'Unauthorized', extensions: { code: 'AUTHENTICATION_ERROR' } }],
    });
    fetchSpy.mockResolvedValue(new Response(body, { status: 200 }));
    const result = await validateApiKey({ nrApiKey: 'NRAK-BAD', collectorHost: null });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('unauthorized');
  });

  it('returns server-error when GraphQL errors contain a non-auth error', async () => {
    const body = JSON.stringify({
      errors: [{ message: 'Internal Server Error', extensions: { code: 'INTERNAL_SERVER_ERROR' } }],
    });
    fetchSpy.mockResolvedValue(new Response(body, { status: 200 }));
    const result = await validateApiKey({ nrApiKey: 'NRAK-TEST', collectorHost: null });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('server-error');
  });

  it('returns server-error on non-200 non-401/403 status', async () => {
    fetchSpy.mockResolvedValue(new Response('Error', { status: 502 }));
    const result = await validateApiKey({ nrApiKey: 'NRAK-TEST', collectorHost: null });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('server-error');
  });

  it('returns timeout on AbortError', async () => {
    const abortError = Object.assign(new Error('The operation was aborted.'), {
      name: 'AbortError',
    });
    fetchSpy.mockRejectedValue(abortError);
    const result = await validateApiKey({
      nrApiKey: 'NRAK-TEST',
      collectorHost: null,
      timeoutMs: 100,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('timeout');
  });

  it('returns network on general fetch error', async () => {
    fetchSpy.mockRejectedValue(new Error('Network failure'));
    const result = await validateApiKey({ nrApiKey: 'NRAK-TEST', collectorHost: null });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('network');
    expect(result.detail).toContain('Network failure');
  });

  it('uses EU NerdGraph URL when collectorHost is eu', async () => {
    const body = JSON.stringify({ data: { actor: { user: { email: 'x@y.com' } } } });
    fetchSpy.mockResolvedValue(new Response(body, { status: 200 }));
    await validateApiKey({ nrApiKey: 'NRAK-TEST', collectorHost: 'eu' });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.eu.newrelic.com/graphql',
      expect.any(Object),
    );
  });

  it('sends Api-Key header', async () => {
    const body = JSON.stringify({ data: { actor: { user: { email: 'x@y.com' } } } });
    fetchSpy.mockResolvedValue(new Response(body, { status: 200 }));
    await validateApiKey({ nrApiKey: 'NRAK-MY-KEY', collectorHost: null });
    const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((options.headers as Record<string, string>)['Api-Key']).toBe('NRAK-MY-KEY');
  });
});
