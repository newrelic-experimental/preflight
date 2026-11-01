import { describe, expect, it } from '@jest/globals';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { loadMcpConfig } from '../src/config.js';
import { getBufferPath } from '../src/hooks/collector-script.js';
import { ISOLATED_HOME_ENV, isolateEnv, restoreEnv } from './support/isolated-home.global-setup.js';

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
  const base = () => ({
    HOME: '/real',
    USERPROFILE: '/real',
    NEW_RELIC_AI_MCP_STORAGE_PATH: '/real/store',
    CLAUDE_JOB_DIR: '/job',
    PATH: '/bin',
  });

  it('sets USERPROFILE only on win32', () => {
    const posix: Record<string, string | undefined> = base();
    isolateEnv(posix, '/tmp/h', 'linux');
    expect(posix.USERPROFILE).toBe('/real');
    const win: Record<string, string | undefined> = base();
    isolateEnv(win, '/tmp/h', 'win32');
    expect(win.USERPROFILE).toBe('/tmp/h');
  });

  it('restores every overridden and cleared variable and leaves unrelated ones alone', () => {
    const env: Record<string, string | undefined> = base();
    const saved = isolateEnv(env, '/tmp/h', 'linux');
    expect(env.HOME).toBe('/tmp/h');
    expect(env.NEW_RELIC_AI_MCP_STORAGE_PATH).toBeUndefined();
    expect(env.PATH).toBe('/bin');
    restoreEnv(env, saved);
    expect(env).toEqual(base());
  });
});
