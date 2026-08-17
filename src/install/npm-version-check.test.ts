import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { isNewerVersion, fetchLatestNpmVersion } from './npm-version-check.js';

describe('isNewerVersion()', () => {
  it('detects a newer major version', () => {
    expect(isNewerVersion('2.0.0', '1.15.1')).toBe(true);
    expect(isNewerVersion('1.15.1', '2.0.0')).toBe(false);
  });

  it('detects a newer minor version', () => {
    expect(isNewerVersion('1.16.0', '1.15.1')).toBe(true);
    expect(isNewerVersion('1.15.1', '1.16.0')).toBe(false);
  });

  it('detects a newer patch version', () => {
    expect(isNewerVersion('1.15.2', '1.15.1')).toBe(true);
    expect(isNewerVersion('1.15.1', '1.15.2')).toBe(false);
  });

  it('returns false for equal versions', () => {
    expect(isNewerVersion('1.15.1', '1.15.1')).toBe(false);
  });

  it('tolerates a leading "v" and a pre-release suffix', () => {
    expect(isNewerVersion('v1.15.2', '1.15.1')).toBe(true);
    expect(isNewerVersion('1.15.2-beta.1', '1.15.1')).toBe(true);
  });
});

describe('fetchLatestNpmVersion()', () => {
  const mockFetch = jest.fn<typeof fetch>();

  beforeEach(() => {
    mockFetch.mockReset();
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  it('returns the version string on a successful response', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: '9.9.9' }),
    } as unknown as Response);
    expect(await fetchLatestNpmVersion()).toBe('9.9.9');
  });

  it('returns null on a non-ok response', async () => {
    mockFetch.mockResolvedValue({ ok: false } as Response);
    expect(await fetchLatestNpmVersion()).toBeNull();
  });

  it('returns null when the response body has no string version field', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: 12345 }),
    } as unknown as Response);
    expect(await fetchLatestNpmVersion()).toBeNull();
  });

  it('returns null on a network error', async () => {
    mockFetch.mockRejectedValue(new Error('network error'));
    expect(await fetchLatestNpmVersion()).toBeNull();
  });
});
