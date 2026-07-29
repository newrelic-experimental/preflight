import {
  DEFAULT_CLIENT_NAME,
  sanitizeClientString,
  buildUserAgent,
  hasOtlpAuthHeader,
  validateOtlpEndpoint,
} from './otlp-shared.js';

describe('hasOtlpAuthHeader', () => {
  // Existing coverage (via OtlpTransport/OtlpEventBridge "no auth header"
  // warning tests) only ever exercises lowercase 'api-key'. This function is
  // shared by both transports, so its other two recognized header names and
  // case-insensitive matching deserve direct tests.
  it('recognizes "authorization" (case-insensitive)', () => {
    expect(hasOtlpAuthHeader({ Authorization: 'Bearer x' })).toBe(true);
    expect(hasOtlpAuthHeader({ AUTHORIZATION: 'Bearer x' })).toBe(true);
  });

  it('recognizes "x-license-key" (case-insensitive)', () => {
    expect(hasOtlpAuthHeader({ 'X-License-Key': 'abc' })).toBe(true);
    expect(hasOtlpAuthHeader({ 'x-license-key': 'abc' })).toBe(true);
  });

  it('recognizes "api-key" case-insensitively (not just lowercase)', () => {
    expect(hasOtlpAuthHeader({ 'API-KEY': 'abc' })).toBe(true);
  });

  it('returns false when no recognized auth header is present', () => {
    expect(hasOtlpAuthHeader({ 'X-Service-Name': 'my-service' })).toBe(false);
    expect(hasOtlpAuthHeader({})).toBe(false);
  });
});

describe('sanitizeClientString', () => {
  it('returns fallback when input is undefined', () => {
    expect(sanitizeClientString(undefined, DEFAULT_CLIENT_NAME)).toBe(DEFAULT_CLIENT_NAME);
  });

  it('returns fallback when input is empty string', () => {
    expect(sanitizeClientString('', DEFAULT_CLIENT_NAME)).toBe(DEFAULT_CLIENT_NAME);
  });

  it('returns fallback when input is control-chars only (strips to empty)', () => {
    expect(sanitizeClientString('\r\n\x00', DEFAULT_CLIENT_NAME)).toBe(DEFAULT_CLIENT_NAME);
  });

  it('returns fallback when input is whitespace only (trims to empty)', () => {
    expect(sanitizeClientString('   ', DEFAULT_CLIENT_NAME)).toBe(DEFAULT_CLIENT_NAME);
  });

  it('strips CRLF and control chars from a valid string', () => {
    expect(sanitizeClientString('pre\r\nflight', DEFAULT_CLIENT_NAME)).toBe('preflight');
  });

  it('trims leading and trailing whitespace', () => {
    expect(sanitizeClientString('  1.2.3  ', '')).toBe('1.2.3');
  });

  it('returns the trimmed value when non-empty after sanitization', () => {
    expect(sanitizeClientString('preflight', DEFAULT_CLIENT_NAME)).toBe('preflight');
  });

  it('uses empty-string fallback for clientVersion path', () => {
    expect(sanitizeClientString(undefined, '')).toBe('');
    expect(sanitizeClientString('', '')).toBe('');
    expect(sanitizeClientString('1.0.0', '')).toBe('1.0.0');
  });
});

describe('buildUserAgent', () => {
  it('returns name/version when version is non-empty', () => {
    expect(buildUserAgent('preflight', '1.0.0')).toBe('preflight/1.0.0');
  });

  it('returns name only when version is empty string', () => {
    expect(buildUserAgent('preflight', '')).toBe('preflight');
  });

  it('falls back to DEFAULT_CLIENT_NAME when name is empty', () => {
    expect(buildUserAgent('', '1.0.0')).toBe(`${DEFAULT_CLIENT_NAME}/1.0.0`);
  });
});

describe('validateOtlpEndpoint', () => {
  it('throws for an invalid URL', () => {
    expect(() => validateOtlpEndpoint('not a url', 'Test')).toThrow('invalid OTLP endpoint URL');
  });

  it('throws for a non-http(s) scheme', () => {
    expect(() => validateOtlpEndpoint('ftp://example.com', 'Test')).toThrow('must use http(s)');
  });

  it('allows https to an ordinary public host', () => {
    expect(() => validateOtlpEndpoint('https://otlp.nr-data.net', 'Test')).not.toThrow();
  });

  it('allows http to loopback', () => {
    expect(() => validateOtlpEndpoint('http://localhost:4318', 'Test')).not.toThrow();
    expect(() => validateOtlpEndpoint('http://127.0.0.1:4318', 'Test')).not.toThrow();
  });

  it('allows https to a private-range address (internal-VPC collector topology)', () => {
    expect(() => validateOtlpEndpoint('https://10.0.0.5:4318', 'Test')).not.toThrow();
    expect(() => validateOtlpEndpoint('https://192.168.1.10:4318', 'Test')).not.toThrow();
  });

  it('blocks plain http to a private-range, non-loopback address', () => {
    expect(() => validateOtlpEndpoint('http://10.0.0.5:4318', 'Test')).toThrow(
      'private-network host',
    );
    expect(() => validateOtlpEndpoint('http://192.168.1.10:4318', 'Test')).toThrow(
      'private-network host',
    );
  });

  it('blocks a cloud metadata host regardless of scheme', () => {
    expect(() => validateOtlpEndpoint('http://metadata.google.internal', 'Test')).toThrow(
      'cloud metadata service',
    );
    expect(() => validateOtlpEndpoint('https://metadata.google.internal', 'Test')).toThrow(
      'cloud metadata service',
    );
    expect(() => validateOtlpEndpoint('http://169.254.169.254', 'Test')).toThrow(
      'cloud metadata service',
    );
    expect(() => validateOtlpEndpoint('https://169.254.169.254', 'Test')).toThrow(
      'cloud metadata service',
    );
  });

  it('still only warns for plain http to an ordinary public non-loopback host', () => {
    const warnSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => validateOtlpEndpoint('http://example.com', 'Test')).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
