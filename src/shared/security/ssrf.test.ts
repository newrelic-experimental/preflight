import { isCloudMetadataHost, isPrivateOrLoopbackHost, validateSsrfUrl } from './ssrf.js';

describe('isCloudMetadataHost', () => {
  it('matches known cloud metadata FQDNs, case-insensitively', () => {
    expect(isCloudMetadataHost('metadata.google.internal')).toBe(true);
    expect(isCloudMetadataHost('METADATA.GOOGLE.INTERNAL')).toBe(true);
    expect(isCloudMetadataHost('metadata.azure.com')).toBe(true);
    expect(isCloudMetadataHost('ec2.internal')).toBe(true);
    expect(isCloudMetadataHost('ec2.amazonaws.com')).toBe(true);
  });

  it('matches the known cloud metadata IP', () => {
    expect(isCloudMetadataHost('100.100.100.200')).toBe(true);
    expect(isCloudMetadataHost('169.254.169.254')).toBe(true);
  });

  it('strips a trailing FQDN dot before matching', () => {
    expect(isCloudMetadataHost('metadata.google.internal.')).toBe(true);
  });

  it('does not match ordinary public hosts', () => {
    expect(isCloudMetadataHost('example.com')).toBe(false);
    expect(isCloudMetadataHost('insights-collector.newrelic.com')).toBe(false);
    expect(isCloudMetadataHost('8.8.8.8')).toBe(false);
  });
});

describe('isPrivateOrLoopbackHost', () => {
  it('matches loopback', () => {
    expect(isPrivateOrLoopbackHost('127.0.0.1')).toBe(true);
    expect(isPrivateOrLoopbackHost('127.255.255.255')).toBe(true);
    expect(isPrivateOrLoopbackHost('localhost')).toBe(true);
    expect(isPrivateOrLoopbackHost('::1')).toBe(true);
  });

  it('matches RFC-1918 private ranges', () => {
    expect(isPrivateOrLoopbackHost('10.0.0.1')).toBe(true);
    expect(isPrivateOrLoopbackHost('172.16.0.1')).toBe(true);
    expect(isPrivateOrLoopbackHost('172.31.255.255')).toBe(true);
    expect(isPrivateOrLoopbackHost('192.168.1.1')).toBe(true);
  });

  it('does not match addresses just outside the 172.16/12 range', () => {
    expect(isPrivateOrLoopbackHost('172.15.255.255')).toBe(false);
    expect(isPrivateOrLoopbackHost('172.32.0.1')).toBe(false);
  });

  it('matches link-local, multicast, and 0.0.0.0', () => {
    expect(isPrivateOrLoopbackHost('169.254.169.254')).toBe(true);
    expect(isPrivateOrLoopbackHost('224.0.0.1')).toBe(true);
    expect(isPrivateOrLoopbackHost('239.255.255.255')).toBe(true);
    expect(isPrivateOrLoopbackHost('0.0.0.0')).toBe(true);
  });

  it('matches IPv6 unspecified, ULA, and link-local', () => {
    expect(isPrivateOrLoopbackHost('::')).toBe(true);
    expect(isPrivateOrLoopbackHost('fc00::1')).toBe(true);
    expect(isPrivateOrLoopbackHost('fd12::1')).toBe(true);
    expect(isPrivateOrLoopbackHost('fe80::1')).toBe(true);
  });

  it('matches bracketed IPv6 forms (as returned by URL.hostname)', () => {
    expect(isPrivateOrLoopbackHost('[::1]')).toBe(true);
    expect(isPrivateOrLoopbackHost('[fe80::1]')).toBe(true);
  });

  it('matches hex-normalized IPv4-mapped IPv6 directly via the main pattern', () => {
    expect(isPrivateOrLoopbackHost('::ffff:7f00:1')).toBe(true); // 127.0.0.1
    expect(isPrivateOrLoopbackHost('[::ffff:7f00:1]')).toBe(true);
  });

  it('matches decimal-form IPv4-mapped IPv6 via extractIPv4FromMappedIPv6', () => {
    expect(isPrivateOrLoopbackHost('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateOrLoopbackHost('::ffff:192.168.1.1')).toBe(true);
  });

  it('matches numeric-encoded IPv4 bypass attempts', () => {
    expect(isPrivateOrLoopbackHost('2130706433')).toBe(true); // decimal for 127.0.0.1
    expect(isPrivateOrLoopbackHost('0177.0.0.1')).toBe(true); // octal for 127.0.0.1
    expect(isPrivateOrLoopbackHost('0x7f.0.0.1')).toBe(true); // hex for 127.0.0.1
  });

  it('does not match ordinary public hosts or IPs', () => {
    expect(isPrivateOrLoopbackHost('example.com')).toBe(false);
    expect(isPrivateOrLoopbackHost('insights-collector.newrelic.com')).toBe(false);
    expect(isPrivateOrLoopbackHost('8.8.8.8')).toBe(false);
  });
});

describe('validateSsrfUrl', () => {
  it('throws for a cloud metadata host', () => {
    expect(() => validateSsrfUrl('test', new URL('http://metadata.google.internal/'))).toThrow(
      /cloud metadata service endpoint/,
    );
  });

  it('throws for a private/loopback host', () => {
    expect(() => validateSsrfUrl('test', new URL('http://127.0.0.1/'))).toThrow(
      /private or loopback address/,
    );
    expect(() => validateSsrfUrl('test', new URL('https://10.0.0.1/'))).toThrow(
      /private or loopback address/,
    );
  });

  it('includes the label in the thrown message', () => {
    expect(() => validateSsrfUrl('sendWithRetry', new URL('http://127.0.0.1/'))).toThrow(
      /^sendWithRetry:/,
    );
  });

  it('does not throw for an ordinary public host', () => {
    expect(() =>
      validateSsrfUrl(
        'test',
        new URL('https://insights-collector.newrelic.com/v1/accounts/1/events'),
      ),
    ).not.toThrow();
  });
});
