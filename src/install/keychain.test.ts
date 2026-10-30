import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('node:child_process', () => ({ spawnSync: jest.fn() }));

import * as childProcess from 'node:child_process';

import { keychainAccount, keychainReadCommand, storeInKeychain } from './keychain.js';
import type { KeychainDeps } from './keychain.js';

function makeDeps(overrides: Partial<KeychainDeps> = {}): KeychainDeps {
  return { add: jest.fn(), read: jest.fn(() => 'the-secret'), ...overrides };
}

describe('keychainReadCommand', () => {
  it('reads the item back with an absolute security path and no shell', () => {
    expect(keychainReadCommand('licenseKey', 'alice')).toEqual([
      '/usr/bin/security',
      'find-generic-password',
      '-s',
      'preflight-license-key',
      '-a',
      'alice',
      '-w',
    ]);
  });

  it('uses a separate service for the API key', () => {
    expect(keychainReadCommand('nrApiKey', 'alice')).toContain('preflight-nr-api-key');
  });
});

describe('storeInKeychain', () => {
  it('adds the item and returns the argv that reads it back', () => {
    const deps = makeDeps();

    const argv = storeInKeychain('licenseKey', 'the-secret', deps);

    expect(deps.add).toHaveBeenCalledWith('preflight-license-key', keychainAccount(), 'the-secret');
    expect(argv).toEqual(keychainReadCommand('licenseKey'));
    expect(deps.read).toHaveBeenCalledWith('licenseKey', argv);
  });

  it('throws without the secret when the read-back differs', () => {
    const deps = makeDeps({ read: jest.fn(() => 'something-else') });

    expect(() => storeInKeychain('nrApiKey', 'the-secret', deps)).toThrow(
      'the Keychain returned a different value than was stored',
    );
    expect(() => storeInKeychain('nrApiKey', 'the-secret', deps)).not.toThrow(/the-secret/);
  });

  it('propagates a failed add', () => {
    const deps = makeDeps({
      add: jest.fn(() => {
        throw new Error('security add-generic-password failed');
      }),
    });

    expect(() => storeInKeychain('licenseKey', 'the-secret', deps)).toThrow(
      'security add-generic-password failed',
    );
    expect(deps.read).not.toHaveBeenCalled();
  });
});

describe('storeInKeychain with the default deps', () => {
  const mockedSpawn = childProcess.spawnSync as unknown as jest.Mock;
  const ok = (stdout: string) => ({ status: 0, signal: null, stdout, stderr: '' });

  beforeEach(() => {
    mockedSpawn.mockReset();
  });

  it('pipes an escaped add command to `security -i` on stdin', () => {
    mockedSpawn.mockReturnValueOnce(ok('')).mockReturnValueOnce(ok('a"b\\c\n'));

    const argv = storeInKeychain('licenseKey', 'a"b\\c');

    const [bin, args, opts] = mockedSpawn.mock.calls[0] as [string, string[], { input: string }];
    expect(bin).toBe('/usr/bin/security');
    expect(args).toEqual(['-i']);
    expect(opts.input).toBe(
      `add-generic-password -U -s "preflight-license-key" -a "${keychainAccount()}" -w "a\\"b\\\\c"\n`,
    );
    expect(mockedSpawn.mock.calls[1][1]).toEqual(argv.slice(1));
  });

  it('strips dangerous env keys from the add subprocess', () => {
    const saved = process.env.DYLD_INSERT_LIBRARIES;
    process.env.DYLD_INSERT_LIBRARIES = '/tmp/evil.dylib';
    mockedSpawn.mockReturnValueOnce(ok('')).mockReturnValueOnce(ok('s\n'));
    try {
      storeInKeychain('licenseKey', 's');
    } finally {
      if (saved === undefined) delete process.env.DYLD_INSERT_LIBRARIES;
      else process.env.DYLD_INSERT_LIBRARIES = saved;
    }

    const opts = mockedSpawn.mock.calls[0][2] as { env: Record<string, string> };
    expect(opts.env).not.toHaveProperty('DYLD_INSERT_LIBRARIES');
  });

  it('rejects a secret containing a line break without spawning', () => {
    expect(() => storeInKeychain('licenseKey', 'a\nb')).toThrow('the secret contains a line break');
    expect(mockedSpawn).not.toHaveBeenCalled();
  });
});
