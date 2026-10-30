import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';

import { stripDangerousEnv } from '../lib/child-env.js';
import { resolveSecretCommand } from '../secret-command.js';
import type { SecretField } from '../secret-command.js';

export const SECURITY_BIN = '/usr/bin/security';

export type KeychainField = Extract<SecretField, 'licenseKey' | 'nrApiKey'>;

const SERVICES: Readonly<Record<KeychainField, string>> = {
  licenseKey: 'preflight-license-key',
  nrApiKey: 'preflight-nr-api-key',
};

export interface KeychainDeps {
  readonly add: (service: string, account: string, secret: string) => void;
  readonly read: (field: KeychainField, argv: readonly string[]) => string;
}

export function isKeychainSupported(): boolean {
  return process.platform === 'darwin' && existsSync(SECURITY_BIN);
}

export function keychainAccount(): string {
  return userInfo().username;
}

/** The argv for the `*Command` config field that reads the secret back. */
export function keychainReadCommand(field: KeychainField, account = keychainAccount()): string[] {
  return [SECURITY_BIN, 'find-generic-password', '-s', SERVICES[field], '-a', account, '-w'];
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// The secret goes to `security -i` on stdin so it never appears in `ps` argv.
function addViaSecurityStdin(service: string, account: string, secret: string): void {
  if (/[\r\n\0]/.test(secret)) throw new Error('the secret contains a line break');
  const command = `add-generic-password -U -s ${quote(service)} -a ${quote(account)} -w ${quote(secret)}\n`;
  const result = spawnSync(SECURITY_BIN, ['-i'], {
    input: command,
    encoding: 'utf8',
    shell: false,
    env: stripDangerousEnv(process.env).env,
    timeout: 20_000,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  if (result.error) throw new Error('could not run /usr/bin/security');
  if (result.status !== 0) throw new Error('security add-generic-password failed');
}

const DEFAULT_DEPS: KeychainDeps = {
  add: addViaSecurityStdin,
  read: (field, argv) => resolveSecretCommand(field, argv),
};

/**
 * Stores `secret` in the login Keychain and reads it back through the same
 * argv the config will use, so the returned command is known to work.
 * Throws without the secret in the message.
 */
export function storeInKeychain(
  field: KeychainField,
  secret: string,
  deps: KeychainDeps = DEFAULT_DEPS,
): string[] {
  const account = keychainAccount();
  const argv = keychainReadCommand(field, account);
  deps.add(SERVICES[field], account, secret);
  if (deps.read(field, argv) !== secret) {
    throw new Error('the Keychain returned a different value than was stored');
  }
  return argv;
}
