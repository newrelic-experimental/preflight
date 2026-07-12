import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.mock('node:dns', () => ({ lookup: jest.fn() }));

import * as dns from 'node:dns';
import { createSsrfSafeLookup } from './ssrf.js';

// `dns.lookup` is a 5-overload union with no single callable type, so it can't
// flow into `jest.Mock`'s generic directly. Naming the one overload shape this
// suite's `mockImplementation` calls actually use (a 3-arg callback-style lookup)
// keeps `mockedLookup` concretely typed instead of falling back to jest's
// default `UnknownFunction`, which would reject the typed `(_hostname: string, ...)`
// implementations below.
type LookupCallback = (
  hostname: string,
  options: unknown,
  callback: (...args: unknown[]) => void,
) => void;
const mockedLookup = dns.lookup as unknown as jest.Mock<LookupCallback>;

// Mirrors the callback shape node:http and undici's Agent actually use when
// invoking a custom `lookup` option — both pass { all: true } in practice.
function callLookup(
  fn: ReturnType<typeof createSsrfSafeLookup>,
  hostname: string,
  all: boolean,
): Promise<{ err: NodeJS.ErrnoException | null; address: unknown; family?: number }> {
  return new Promise((resolve) => {
    fn(hostname, { all }, (err, address, family) => resolve({ err, address, family }));
  });
}

describe('createSsrfSafeLookup', () => {
  beforeEach(() => {
    mockedLookup.mockReset();
  });

  it('resolves and returns the array of addresses when the caller asked for all:true, given a safe hostname', async () => {
    mockedLookup.mockImplementation(
      (_hostname: string, _opts: unknown, cb: (...args: unknown[]) => void) => {
        cb(null, [{ address: '93.184.216.34', family: 4 }]);
      },
    );

    const lookup = createSsrfSafeLookup('test');
    const result = await callLookup(lookup, 'example.com', true);

    expect(result.err).toBeNull();
    expect(result.address).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('returns a single address+family when the caller asked for all:false, given a safe hostname', async () => {
    mockedLookup.mockImplementation(
      (_hostname: string, _opts: unknown, cb: (...args: unknown[]) => void) => {
        cb(null, [{ address: '93.184.216.34', family: 4 }]);
      },
    );

    const lookup = createSsrfSafeLookup('test');
    const result = await callLookup(lookup, 'example.com', false);

    expect(result.err).toBeNull();
    expect(result.address).toBe('93.184.216.34');
    expect(result.family).toBe(4);
  });

  it('rejects when DNS resolves the hostname to a loopback address (the rebind scenario)', async () => {
    mockedLookup.mockImplementation(
      (_hostname: string, _opts: unknown, cb: (...args: unknown[]) => void) => {
        cb(null, [{ address: '127.0.0.1', family: 4 }]);
      },
    );

    const lookup = createSsrfSafeLookup('test');
    const result = await callLookup(lookup, 'attacker-controlled.example', true);

    expect(result.err).not.toBeNull();
    expect(result.err?.message).toContain('private or loopback');
  });

  it('rejects when ANY resolved address is blocked, even if another is safe', async () => {
    mockedLookup.mockImplementation(
      (_hostname: string, _opts: unknown, cb: (...args: unknown[]) => void) => {
        cb(null, [
          { address: '93.184.216.34', family: 4 },
          { address: '169.254.169.254', family: 4 },
        ]);
      },
    );

    const lookup = createSsrfSafeLookup('test');
    const result = await callLookup(lookup, 'mixed-resolution.example', true);

    expect(result.err).not.toBeNull();
  });

  it('propagates a real DNS failure (e.g. ENOTFOUND) as-is', async () => {
    const dnsError = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    mockedLookup.mockImplementation(
      (_hostname: string, _opts: unknown, cb: (...args: unknown[]) => void) => {
        cb(dnsError);
      },
    );

    const lookup = createSsrfSafeLookup('test');
    const result = await callLookup(lookup, 'nonexistent.example', true);

    expect(result.err).toBe(dnsError);
  });
});
