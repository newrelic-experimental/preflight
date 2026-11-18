import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

jest.mock('node:fs', () => {
  const real = jest.requireActual<typeof import('node:fs')>('node:fs');
  return { ...real, writeFileSync: jest.fn(real.writeFileSync) };
});

import * as nodeFs from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { appendToHookBuffer } from './hook-buffer.js';
import { LocalStore, hasLiveOwningEngine } from './local-store.js';

const realFs = jest.requireActual<typeof import('node:fs')>('node:fs');
const writeFileSync = jest.mocked(nodeFs.writeFileSync);
const sessionId = 'heartbeat-race-session';
let storagePath: string;

/**
 * Runs `between` once, at the point where a real writeFileSync has opened
 * (and so created or truncated) its target but not yet written to it.
 */
function interleaveWithNextWrite(between: () => void): void {
  writeFileSync.mockImplementationOnce((path, data, options) => {
    realFs.writeFileSync(path, '', options);
    between();
    realFs.writeFileSync(path, data, options);
  });
}

beforeEach(() => {
  storagePath = realFs.mkdtempSync(resolve(tmpdir(), 'nr-heartbeat-race-'));
});

afterEach(() => {
  realFs.rmSync(storagePath, { recursive: true, force: true });
});

describe('an engine writing its heartbeat while another engine runs maintenance', () => {
  it('keeps its buffer and its heartbeat', () => {
    const owner = new LocalStore(storagePath, sessionId);
    owner.initialize();
    const bufferPath = resolve(storagePath, `buffer-${sessionId}.jsonl`);
    appendToHookBuffer(bufferPath, JSON.stringify({ mode: 'pre', sessionId }) + '\n');
    const sibling = new LocalStore(storagePath, 'sibling-session');
    sibling.initialize();

    interleaveWithNextWrite(() => sibling.gcOrphanBuffers(new Set()));
    owner.writeHeartbeat(process.pid);

    expect(realFs.existsSync(bufferPath)).toBe(true);
    expect(hasLiveOwningEngine(storagePath, sessionId)).toBe(true);
    expect(owner.drainBuffer()).toHaveLength(1);
  });
});
