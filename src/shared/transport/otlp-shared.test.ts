import { DEFAULT_CLIENT_NAME, sanitizeClientString, buildUserAgent } from './otlp-shared.js';

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
