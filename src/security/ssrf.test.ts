import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.mock('node:dns', () => ({ lookup: jest.fn() }));

import * as dns from 'node:dns';
import { createSsrfSafeLookup, validateSsrfUrl } from './ssrf.js';

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

describe('validateSsrfUrl', () => {
  it('allows a safe public https URL', () => {
    expect(() => validateSsrfUrl('test', new URL('https://example.com/path'))).not.toThrow();
  });

  it('rejects a decimal-integer-encoded loopback host (e.g. http://2130706433/)', () => {
    expect(() => validateSsrfUrl('test', new URL('http://2130706433/'))).toThrow(
      /private or loopback/,
    );
  });

  it('rejects an octal-leading-zero-encoded loopback host (e.g. http://0177.0.0.1/)', () => {
    expect(() => validateSsrfUrl('test', new URL('http://0177.0.0.1/'))).toThrow(
      /private or loopback/,
    );
  });

  it('rejects a hex-encoded loopback host (e.g. http://0x7f.0.0.1/)', () => {
    expect(() => validateSsrfUrl('test', new URL('http://0x7f.0.0.1/'))).toThrow(
      /private or loopback/,
    );
  });

  it('rejects the metadata.google.internal cloud-metadata FQDN', () => {
    expect(() => validateSsrfUrl('test', new URL('http://metadata.google.internal/'))).toThrow(
      /cloud metadata service endpoint/,
    );
  });

  it('rejects the 169.254.169.254 metadata IP (caught by the link-local block)', () => {
    expect(() => validateSsrfUrl('test', new URL('http://169.254.169.254/'))).toThrow(
      /private or loopback/,
    );
  });

  it('rejects the 100.100.100.200 metadata IP (explicit metadata-IP blocklist)', () => {
    expect(() => validateSsrfUrl('test', new URL('http://100.100.100.200/'))).toThrow(
      /cloud metadata service endpoint/,
    );
  });

  it('rejects an IPv4-mapped-IPv6 loopback host (::ffff:127.0.0.1)', () => {
    expect(() => validateSsrfUrl('test', new URL('http://[::ffff:127.0.0.1]/'))).toThrow(
      /private or loopback/,
    );
  });

  it('rejects an IPv4-mapped-IPv6 multicast host not covered by the hardcoded hex-prefix regex (::ffff:224.0.0.1)', () => {
    // Node normalizes this to the hex form ::ffff:e000:1. Its "e0" prefix isn't one of the
    // loopback/RFC-1918/link-local prefixes BLOCKED_HOST_RE's mapped-IPv6 branch hardcodes, so
    // this specifically exercises extractIPv4FromMappedIPv6's decode-then-recheck fallback,
    // rather than the plain regex match that the other mapped-IPv6 case above hits directly.
    expect(() => validateSsrfUrl('test', new URL('http://[::ffff:224.0.0.1]/'))).toThrow(
      /private or loopback/,
    );
  });

  it('rejects a disallowed scheme (ftp:)', () => {
    expect(() => validateSsrfUrl('test', new URL('ftp://127.0.0.1/'))).toThrow(
      /scheme "ftp:" is not allowed/,
    );
  });
});
