import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { takeClaimText } from '../storage/hook-buffer.js';

const EXTENSION = resolve(process.cwd(), 'copilot-sdk-extension/extension.mjs');
const SESSION_ID = 'sess-1';
const USAGE = {
  model: 'gpt-5',
  apiCallId: 'call-1',
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 10,
  cacheWriteTokens: 5,
};

const SDK_STUB = `
export async function joinSession() {
  if (process.env.STUB_FAIL) throw new Error('incompatible host');
  const handlers = [];
  setImmediate(() => {
    for (const handler of handlers) handler({ data: JSON.parse(process.env.STUB_DATA) });
  });
  return { sessionId: process.env.STUB_SESSION_ID, on: (_name, handler) => handlers.push(handler) };
}
`;

// Runs a full drain (rename into a claim, seal, read, unlink) the moment the buffer is opened for
// writing, so the drain lands between the writer's open and its write.
const DRAIN_ON_OPEN = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const drainedFile = process.env.DRAINED_FILE;
const realOpen = fs.openSync;
let drained = false;

fs.openSync = (path, ...rest) => {
  const fd = realOpen(path, ...rest);
  if (!drained && String(path).endsWith('buffer-${SESSION_ID}.jsonl')) {
    drained = true;
    const claim = path + '.claim';
    fs.renameSync(path, claim);
    const text = fs.readFileSync(claim, 'utf-8').split('\\0')[0];
    fs.appendFileSync(drainedFile, text);
    fs.unlinkSync(claim);
  }
  return fd;
};
fs.appendFileSync = (path, data, options) => {
  const fd = fs.openSync(path, 'a', options?.mode);
  try {
    fs.writeSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
};
syncBuiltinESMExports();
`;

function tokenLines(text: string): string[] {
  return text.split('\n').filter((line) => line.includes('"mode":"token"'));
}

describe('Copilot SDK extension bundle', () => {
  let dir: string;
  let storage: string;
  let drainedFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pf-copilot-ext-'));
    storage = join(dir, 'storage');
    drainedFile = join(dir, 'drained.txt');
    const sdk = join(dir, 'node_modules/@github/copilot-sdk');
    mkdirSync(sdk, { recursive: true });
    writeFileSync(
      join(sdk, 'package.json'),
      JSON.stringify({
        name: '@github/copilot-sdk',
        type: 'module',
        exports: { './extension': './extension.js' },
      }),
    );
    writeFileSync(join(sdk, 'extension.js'), SDK_STUB);
    writeFileSync(join(dir, 'preload.mjs'), DRAIN_ON_OPEN);
    writeFileSync(drainedFile, '');
    copyFileSync(EXTENSION, join(dir, 'extension.mjs'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function runExtension(
    withDrainRace: boolean,
    stub: { sessionId?: string; data?: unknown; fail?: boolean } = {},
  ) {
    const args = withDrainRace ? ['--import', join(dir, 'preload.mjs')] : [];
    return spawnSync(process.execPath, [...args, join(dir, 'extension.mjs')], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        NEW_RELIC_AI_MCP_STORAGE_PATH: storage,
        DRAINED_FILE: drainedFile,
        STUB_SESSION_ID: stub.sessionId ?? SESSION_ID,
        STUB_DATA: JSON.stringify(stub.data ?? USAGE),
        ...(stub.fail ? { STUB_FAIL: '1' } : {}),
      },
      timeout: 10_000,
    });
  }

  function lineCountAfterFinalDrain(): number {
    const live = join(storage, `buffer-${SESSION_ID}.jsonl`);
    const rest = existsSync(live) ? takeClaimText(live) : '';
    return tokenLines(readFileSync(drainedFile, 'utf-8') + rest).length;
  }

  it('writes the token line to the session buffer', () => {
    const result = runExtension(false);

    expect(result.stderr).toBe('');
    const live = readFileSync(join(storage, `buffer-${SESSION_ID}.jsonl`), 'utf-8');
    expect(JSON.parse(live.trim())).toEqual({
      mode: 'token',
      tool: 'copilot-sdk-usage',
      timestamp: expect.any(Number),
      sessionId: SESSION_ID,
      messageId: 'call-1',
      model: 'gpt-5',
      inputTokens: 85,
      outputTokens: 20,
      cacheReadTokens: 10,
      cacheCreationTokens: 5,
    });
    expect(readdirSync(storage)).toEqual([`buffer-${SESSION_ID}.jsonl`]);
  });

  it('creates the buffer with owner-only permissions', () => {
    runExtension(false);

    const mode = statSync(join(storage, `buffer-${SESSION_ID}.jsonl`)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('drains a token line exactly once when a drain lands between open and write', () => {
    const result = runExtension(true);

    expect(result.stderr).toBe('');
    expect(lineCountAfterFinalDrain()).toBe(1);
  });

  it('writes nothing for a usage event without a model', () => {
    const result = runExtension(false, { data: { ...USAGE, model: '' } });

    expect(result.stderr).toBe('');
    expect(existsSync(storage)).toBe(false);
  });

  it('writes nothing for a session id that is not a safe file name', () => {
    const result = runExtension(false, { sessionId: '../escape' });

    expect(result.stderr).toBe('');
    expect(existsSync(storage)).toBe(false);
    expect(existsSync(join(dir, 'escape'))).toBe(false);
  });

  it('reports a missing session id on stderr and exits cleanly', () => {
    const result = runExtension(false, { sessionId: '' });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('joinSession() returned no sessionId');
  });

  it('reports a failed joinSession on stderr and exits cleanly', () => {
    const result = runExtension(false, { fail: true });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('joinSession() failed: Error: incompatible host');
  });
});
