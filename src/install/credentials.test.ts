import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

import { resolveInstallCredentials } from './credentials.js';

const posixOnly = process.platform === 'win32' ? it.skip : it;

describe('resolveInstallCredentials', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'preflight-creds-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function keyFile(contents: string, mode = 0o600): string {
    const path = join(dir, 'key');
    writeFileSync(path, contents);
    chmodSync(path, mode);
    return path;
  }

  it('returns nothing when no source is set', () => {
    expect(resolveInstallCredentials({}, {})).toEqual({
      licenseKey: undefined,
      accountId: undefined,
      warnings: [],
    });
  });

  it('reads both values from the environment', () => {
    const result = resolveInstallCredentials(
      {},
      { NEW_RELIC_LICENSE_KEY: 'env-key', NEW_RELIC_ACCOUNT_ID: '999' },
    );
    expect(result).toMatchObject({ licenseKey: 'env-key', accountId: '999' });
  });

  it('prefers the flag over the file over the environment', () => {
    const env = { NEW_RELIC_LICENSE_KEY: 'env-key' };
    const licenseKeyFile = keyFile('file-key\n');
    expect(
      resolveInstallCredentials({ licenseKey: 'flag-key', licenseKeyFile }, env).licenseKey,
    ).toBe('flag-key');
    expect(resolveInstallCredentials({ licenseKeyFile }, env).licenseKey).toBe('file-key');
    expect(resolveInstallCredentials({}, env).licenseKey).toBe('env-key');
  });

  it('prefers the account id flag over the environment', () => {
    const result = resolveInstallCredentials({ accountId: '111' }, { NEW_RELIC_ACCOUNT_ID: '222' });
    expect(result.accountId).toBe('111');
  });

  it('treats blank environment values as unset', () => {
    const result = resolveInstallCredentials(
      {},
      { NEW_RELIC_LICENSE_KEY: '  ', NEW_RELIC_ACCOUNT_ID: '' },
    );
    expect(result).toMatchObject({ licenseKey: undefined, accountId: undefined });
  });

  it('does not read the key file when the flag is set', () => {
    const result = resolveInstallCredentials(
      { licenseKey: 'flag-key', licenseKeyFile: join(dir, 'missing') },
      {},
    );
    expect(result.licenseKey).toBe('flag-key');
  });

  it('trims whitespace and a trailing newline from the key file', () => {
    const result = resolveInstallCredentials({ licenseKeyFile: keyFile('  abc123\r\n') }, {});
    expect(result.licenseKey).toBe('abc123');
  });

  posixOnly('warns without refusing when the key file is group or world readable', () => {
    const path = keyFile('abc123', 0o644);
    const result = resolveInstallCredentials({ licenseKeyFile: path }, {});
    expect(result.licenseKey).toBe('abc123');
    expect(result.warnings).toEqual([
      `${path} is readable by other users (mode 644). Run: chmod 600 ${path}`,
    ]);
  });

  posixOnly('does not warn for an owner-only key file', () => {
    expect(
      resolveInstallCredentials({ licenseKeyFile: keyFile('abc123', 0o400) }, {}).warnings,
    ).toEqual([]);
  });

  it('throws a clear error for a missing key file', () => {
    const path = join(dir, 'missing');
    expect(() => resolveInstallCredentials({ licenseKeyFile: path }, {})).toThrow(
      `Cannot read --license-key-file ${path} (ENOENT).`,
    );
  });

  it('throws a clear error for an empty key file', () => {
    const path = keyFile('  \n');
    expect(() => resolveInstallCredentials({ licenseKeyFile: path }, {})).toThrow(
      `--license-key-file ${path} is empty.`,
    );
  });

  it('never includes the key in an error message', () => {
    const secret = 'NRAK-SECRET-VALUE';
    const path = keyFile(secret, 0o000);
    try {
      resolveInstallCredentials({ licenseKeyFile: path }, {});
    } catch (err) {
      expect((err as Error).message).not.toContain(secret);
    }
  });
});
