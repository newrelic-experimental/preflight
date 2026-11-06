import { afterEach, describe, expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { loadMcpConfig } from '../src/config.js';
import { getBufferPath } from '../src/hooks/collector-script.js';
import { ISOLATED_HOME_ENV } from './support/isolated-home.global-setup.js';

const isolated = process.env[ISOLATED_HOME_ENV] as string;

function isUnder(root: string, candidate: string): boolean {
  const rel = relative(root, resolve(candidate));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
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

describe('dotenv under the isolated environment', () => {
  it('has DOTENV_CONFIG_PATH pointing at a missing file', () => {
    const path = process.env.DOTENV_CONFIG_PATH as string;
    expect(path).toBeTruthy();
    expect(existsSync(path)).toBe(false);
  });

  const cwds: string[] = [];
  afterEach(() => {
    for (const c of cwds.splice(0)) rmSync(c, { recursive: true, force: true });
  });

  it('keeps a .env in the working directory from reintroducing a scrubbed variable', () => {
    const cwd = mkdtempSync(join(isolated, 'dotenv-cwd-'));
    cwds.push(cwd);
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
