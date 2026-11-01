import { describe, expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { loadMcpConfig } from '../src/config.js';
import { getBufferPath } from '../src/hooks/collector-script.js';
import {
  ISOLATED_HOME_ENV,
  isolateEnv,
  removeStaleHomes,
  restoreEnv,
} from './support/isolated-home.global-setup.js';

const isolated = process.env[ISOLATED_HOME_ENV] as string;

function isUnder(root: string, candidate: string): boolean {
  const rel = relative(root, resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep));
}

describe('test home isolation', () => {
  it('runs every test file with the isolated home as os.homedir()', () => {
    expect(isolated).toBeTruthy();
    expect(homedir()).toBe(isolated);
  });

  it('clears storage and buffer overrides inherited from the developer shell', () => {
    expect(process.env.NEW_RELIC_AI_MCP_STORAGE_PATH).toBeUndefined();
    expect(process.env.NEW_RELIC_AI_MCP_BUFFER_PATH).toBeUndefined();
  });

  it('resolves loadMcpConfig().storagePath and the collector buffer under the isolated home', () => {
    const config = loadMcpConfig({ config: join(isolated, 'no-such-config.json') });
    expect(isUnder(isolated, config.storagePath)).toBe(true);
    expect(isUnder(isolated, getBufferPath('sess-001'))).toBe(true);
  });

  it('clears inherited Claude job and Preflight settings', () => {
    expect(process.env.CLAUDE_JOB_DIR).toBeUndefined();
    expect(Object.keys(process.env).filter((k) => /^(NR_AI_|OTEL_|MCP_CLIENT)/.test(k))).toEqual(
      [],
    );
  });

  it('points every per-user data root at the isolated home', () => {
    for (const key of ['APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) {
      expect(isUnder(isolated, process.env[key] as string)).toBe(true);
    }
    expect(isUnder(isolated, process.env.NEW_RELIC_AI_COPILOT_DIR as string)).toBe(true);
  });
});

describe('isolateEnv / restoreEnv', () => {
  type TestEnv = Record<string, string | undefined>;
  const base = (): TestEnv => ({
    HOME: '/real',
    USERPROFILE: '/real',
    HOMEDRIVE: 'C:',
    HOMEPATH: '\\Users\\real',
    NEW_RELIC_AI_MCP_STORAGE_PATH: '/real/store',
    CLAUDE_JOB_DIR: '/job',
    NR_AI_MODE: 'cloud',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel',
    MCP_CLIENT: 'x',
    PATH: '/bin',
  });

  it('clears every inherited Preflight, New Relic, OTel and Claude Code family', () => {
    const env = base();
    isolateEnv(env, '/tmp/h');
    for (const key of [
      'NEW_RELIC_AI_MCP_STORAGE_PATH',
      'CLAUDE_JOB_DIR',
      'NR_AI_MODE',
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'MCP_CLIENT',
    ]) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.PATH).toBe('/bin');
  });

  it('points the home variables of every platform, WSL fallbacks included, at the temp home', () => {
    const env = base();
    isolateEnv(env, '/tmp/h');
    expect(env.HOME).toBe('/tmp/h');
    expect(env.USERPROFILE).toBe('/tmp/h');
    expect(`${env.HOMEDRIVE}${env.HOMEPATH}`).toBe('/tmp/h');
  });

  it('points dotenv at a file that does not exist', () => {
    const env = base();
    isolateEnv(env, '/tmp/h');
    expect(env.DOTENV_CONFIG_PATH).toBe(join('/tmp/h', '.env'));
  });

  it('restores every overridden and cleared variable and leaves unrelated ones alone', () => {
    const env = base();
    const saved = isolateEnv(env, '/tmp/h');
    restoreEnv(env, saved);
    expect(env).toEqual(base());
  });
});

describe('dotenv under the isolated environment', () => {
  it('has DOTENV_CONFIG_PATH pointing at a missing file', () => {
    const path = process.env.DOTENV_CONFIG_PATH as string;
    expect(path).toBeTruthy();
    expect(existsSync(path)).toBe(false);
  });

  it('keeps a .env in the working directory from reintroducing a scrubbed variable', () => {
    const cwd = mkdtempSync(join(isolated, 'dotenv-cwd-'));
    writeFileSync(join(cwd, '.env'), 'NEW_RELIC_AI_MCP_STORAGE_PATH=/leaked\n');
    const out = execFileSync(
      process.execPath,
      [
        '-e',
        `require(${JSON.stringify(resolve('node_modules/dotenv/config'))});process.stdout.write(String(process.env.NEW_RELIC_AI_MCP_STORAGE_PATH))`,
      ],
      { cwd, env: { ...process.env }, encoding: 'utf8' },
    );
    expect(out).toBe('undefined');
  });
});

describe('removeStaleHomes', () => {
  it('removes only old preflight-jest-home-* dirs', () => {
    const root = mkdtempSync(join(isolated, 'stale-root-'));
    const old = join(root, 'preflight-jest-home-old');
    const fresh = join(root, 'preflight-jest-home-fresh');
    const other = join(root, 'unrelated-old');
    for (const d of [old, fresh, other]) mkdirSync(d);
    const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    utimesSync(old, longAgo, longAgo);
    utimesSync(other, longAgo, longAgo);
    removeStaleHomes(root);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });

  it('does not throw when the root is missing', () => {
    expect(() => removeStaleHomes(join(isolated, 'no-such-root'))).not.toThrow();
  });
});
