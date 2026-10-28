import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { spawnSync } from 'node:child_process';

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

import { lookupUser, runInstallAsUser, stripValueOptions, type TargetUser } from './target-user.js';

describe('lookupUser', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'preflight-home-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('parses a getent passwd line on linux', () => {
    const user = lookupUser('dev', 'linux', (file, args) => {
      expect([file, ...args]).toEqual(['getent', 'passwd', 'dev']);
      return `dev:x:1001:1002:Dev User:${home}:/bin/zsh\n`;
    });
    expect(user).toEqual({ name: 'dev', uid: 1001, gid: 1002, home });
  });

  it('parses dscl output on darwin', () => {
    const user = lookupUser('dev', 'darwin', (file, args) => {
      expect(file).toBe('dscl');
      expect(args).toContain('/Users/dev');
      return `NFSHomeDirectory: ${home}\nPrimaryGroupID: 20\nUniqueID: 501\n`;
    });
    expect(user).toEqual({ name: 'dev', uid: 501, gid: 20, home });
  });

  it('reports an unknown user', () => {
    expect(() =>
      lookupUser('ghost', 'linux', () => {
        throw new Error('exit 2');
      }),
    ).toThrow('User not found: ghost');
  });

  it('reports a home directory that does not exist', () => {
    expect(() =>
      lookupUser('dev', 'linux', () => 'dev:x:1001:1002::/nonexistent/dev-home:/bin/sh'),
    ).toThrow('Home directory of dev does not exist: /nonexistent/dev-home');
  });

  it.each(['', '-rf', 'a/b', 'a b', '../root'])('rejects the user name %p', (name) => {
    expect(() => lookupUser(name, 'linux', () => '')).toThrow('Invalid --target-user name');
  });

  it('rejects unsupported platforms', () => {
    expect(() => lookupUser('dev', 'win32', () => '')).toThrow('macOS and Linux only');
  });
});

describe('stripValueOptions', () => {
  it('removes spaced and equals forms and keeps everything else', () => {
    expect(
      stripValueOptions(
        [
          'index.js',
          'install',
          '--target-user',
          'dev',
          '--license-key=NRLIC-x',
          '--mode',
          'cloud',
          '--account-id',
          '1',
          '--license-key-file',
          '/k',
        ],
        ['--target-user', '--license-key', '--license-key-file', '--account-id'],
      ),
    ).toEqual(['index.js', 'install', '--mode', 'cloud']);
  });
});

describe('runInstallAsUser', () => {
  const user: TargetUser = { name: 'dev', uid: 501, gid: 20, home: '/Users/dev' };

  function fakeSpawn(status: number | null, error?: Error) {
    const calls: { file: string; args: readonly string[]; options: Record<string, unknown> }[] = [];
    const spawn = ((file: string, args: readonly string[], options: Record<string, unknown>) => {
      calls.push({ file, args, options });
      return { status, error };
    }) as unknown as typeof spawnSync;
    return { spawn, calls };
  }

  it('re-runs the CLI as the user with their HOME and credentials in env, not argv', () => {
    const { spawn, calls } = fakeSpawn(0);
    const status = runInstallAsUser(
      user,
      [
        'index.js',
        'install',
        '--target-user',
        'dev',
        '--license-key',
        'NRLIC-secret',
        '--mode',
        'cloud',
      ],
      { licenseKey: 'NRLIC-secret', accountId: '42' },
      spawn,
    );

    expect(status).toBe(0);
    expect(calls).toHaveLength(1);
    const call = calls[0] as (typeof calls)[number];
    expect(call.file).toBe(process.execPath);
    expect(call.args).toEqual(['index.js', 'install', '--mode', 'cloud']);
    expect(call.options).toMatchObject({ uid: 501, gid: 20, cwd: '/Users/dev', stdio: 'inherit' });
    expect(call.options.env).toMatchObject({
      HOME: '/Users/dev',
      USER: 'dev',
      LOGNAME: 'dev',
      NEW_RELIC_LICENSE_KEY: 'NRLIC-secret',
      NEW_RELIC_ACCOUNT_ID: '42',
    });
  });

  it('returns the child exit status, and 1 when it was killed by a signal', () => {
    expect(runInstallAsUser(user, ['x'], {}, fakeSpawn(3).spawn)).toBe(3);
    expect(runInstallAsUser(user, ['x'], {}, fakeSpawn(null).spawn)).toBe(1);
  });

  it('throws when the child cannot be spawned', () => {
    expect(() =>
      runInstallAsUser(user, ['x'], {}, fakeSpawn(null, new Error('spawn EPERM')).spawn),
    ).toThrow('spawn EPERM');
  });
});
