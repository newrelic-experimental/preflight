import { jest, describe, it, expect, afterEach } from '@jest/globals';

import * as configMod from '../config.js';
import type { McpServerConfig } from '../config.js';
import { getDashboardAddress, waitForHealthyDashboard } from './dashboard-health.js';

jest.mock('../config.js', () => ({ loadMcpConfig: jest.fn() }));

const mockedLoadMcpConfig = configMod.loadMcpConfig as jest.MockedFunction<
  typeof configMod.loadMcpConfig
>;

describe('getDashboardAddress()', () => {
  afterEach(() => {
    mockedLoadMcpConfig.mockReset();
  });

  it('returns the configured host/port when loadMcpConfig() succeeds', () => {
    mockedLoadMcpConfig.mockReturnValue({
      dashboard: { host: '127.0.0.1', port: 7777, openOnStart: false },
    } as unknown as McpServerConfig);
    expect(getDashboardAddress()).toEqual({ host: '127.0.0.1', port: 7777 });
  });

  it('returns null when loadMcpConfig() throws (e.g. cloud mode missing credentials)', () => {
    mockedLoadMcpConfig.mockImplementation(() => {
      throw new Error('missing credentials');
    });
    expect(getDashboardAddress()).toBeNull();
  });
});

describe('waitForHealthyDashboard()', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('resolves true immediately on a healthy, version-matching response', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, version: '1.6.14' }),
    })) as unknown as typeof fetch;

    const healthy = await waitForHealthyDashboard('127.0.0.1', 7777, '1.6.14', 50, 5);
    expect(healthy).toBe(true);
  });

  it('resolves false once timeoutMs elapses on a persistent version mismatch', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, version: '1.6.13' }),
    })) as unknown as typeof fetch;

    const healthy = await waitForHealthyDashboard('127.0.0.1', 7777, '1.6.14', 50, 5);
    expect(healthy).toBe(false);
  });

  it('treats thrown connection errors as "not yet" and recovers once the server comes up', async () => {
    let calls = 0;
    global.fetch = jest.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error('ECONNREFUSED');
      return { ok: true, json: async () => ({ ok: true, version: '1.6.14' }) };
    }) as unknown as typeof fetch;

    const healthy = await waitForHealthyDashboard('127.0.0.1', 7777, '1.6.14', 500, 5);
    expect(healthy).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('resolves false once timeoutMs elapses when every call throws (connection refused, never recovers)', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const healthy = await waitForHealthyDashboard('127.0.0.1', 7777, '1.6.14', 50, 5);
    expect(healthy).toBe(false);
  });

  it('short-circuits the version check when expectedVersion is null', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, version: '9.9.9' }),
    })) as unknown as typeof fetch;

    const healthy = await waitForHealthyDashboard('127.0.0.1', 7777, null, 50, 5);
    expect(healthy).toBe(true);
  });
});
