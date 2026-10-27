import { describe, it, expect, jest } from '@jest/globals';

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
