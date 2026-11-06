import { afterEach, describe, expect, it } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolateEnv, removeStaleHomes, restoreEnv } from './isolated-home.global-setup.js';

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

  it('keeps credential-only variables but still clears path and mode variables', () => {
    const env: TestEnv = { ...base(), NEW_RELIC_LICENSE_KEY: 'k', NEW_RELIC_ACCOUNT_ID: '1' };
    const saved = isolateEnv(env, '/tmp/h');
    expect(env.NEW_RELIC_LICENSE_KEY).toBe('k');
    expect(env.NEW_RELIC_ACCOUNT_ID).toBe('1');
    expect(env.NEW_RELIC_AI_MCP_STORAGE_PATH).toBeUndefined();
    expect(saved).not.toHaveProperty('NEW_RELIC_LICENSE_KEY');
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

describe('removeStaleHomes', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });
  const makeRoot = (): string => {
    const r = mkdtempSync(join(tmpdir(), 'stale-root-'));
    roots.push(r);
    return r;
  };

  it('stops after the removal cap', () => {
    const root = makeRoot();
    const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    for (let n = 0; n < 60; n++) {
      const d = join(root, `preflight-jest-home-${n}`);
      mkdirSync(d);
      utimesSync(d, longAgo, longAgo);
    }
    removeStaleHomes(root);
    expect(readdirSync(root)).toHaveLength(10);
  });

  it('removes only old preflight-jest-home-* dirs', () => {
    const root = makeRoot();
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
    expect(() => removeStaleHomes(join(tmpdir(), 'no-such-root-xyz'))).not.toThrow();
  });
});
