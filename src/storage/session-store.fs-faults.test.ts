import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

jest.mock('node:fs', () => {
  const real = jest.requireActual<typeof import('node:fs')>('node:fs');
  return {
    ...real,
    readFileSync: jest.fn(real.readFileSync),
    renameSync: jest.fn(real.renameSync),
    writeFileSync: jest.fn(real.writeFileSync),
  };
});

import * as nodeFs from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore, deserializeFullSessionSummary } from './session-store.js';

const realFs = jest.requireActual<typeof import('node:fs')>('node:fs');
const readFileSync = nodeFs.readFileSync as unknown as jest.Mock<(...args: unknown[]) => unknown>;
const renameSync = jest.mocked(nodeFs.renameSync);
const writeFileSync = jest.mocked(nodeFs.writeFileSync);

const id = 'fs-fault-session';
const startTime = new Date('2026-03-01T10:00:00Z').getTime();
let stderrSpy: ReturnType<typeof jest.spyOn>;
let tmpDir: string;
let target: string;

function summary(toolCallCount: number) {
  return deserializeFullSessionSummary({
    sessionId: id,
    startTime,
    endTime: startTime + 60_000,
    toolCallCount,
  });
}

function savedToolCalls(): number {
  return (JSON.parse(realFs.readFileSync(target, 'utf-8')) as { toolCallCount: number })
    .toolCallCount;
}

function sessionFiles(): string[] {
  return realFs.readdirSync(join(tmpDir, 'sessions')).sort();
}

function warnings(text: string): unknown[] {
  return stderrSpy.mock.calls.filter((call: unknown[]) => String(call[0]).includes(text));
}

function heldByAnotherProcess(): never {
  throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
}

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  tmpDir = resolve(tmpdir(), `nr-session-fs-faults-${Date.now()}-${Math.random()}`);
  realFs.mkdirSync(join(tmpDir, 'sessions'), { recursive: true });
  target = join(tmpDir, 'sessions', `2026-03-01_${id}.json`);
  readFileSync.mockImplementation(realFs.readFileSync as (...args: unknown[]) => unknown);
  renameSync.mockImplementation(realFs.renameSync);
  writeFileSync.mockImplementation(realFs.writeFileSync);
});

afterEach(() => {
  stderrSpy.mockRestore();
  realFs.rmSync(tmpDir, { recursive: true, force: true });
});

function onPlatform(platform: NodeJS.Platform): () => void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: platform });
  return () => Object.defineProperty(process, 'platform', original);
}

describe('SessionStore saves under filesystem faults', () => {
  it('leaves the saved file intact when a save crashes mid-write', () => {
    const store = new SessionStore({ storagePath: tmpDir });
    store.saveSession(summary(3));
    writeFileSync.mockImplementationOnce((path, data, options) => {
      const text = String(data);
      realFs.writeFileSync(path, text.slice(0, text.length / 2), options);
      throw new Error('crashed mid-write');
    });

    store.saveSession(summary(8));

    expect(savedToolCalls()).toBe(3);
    expect(sessionFiles()).toEqual([basename(target)]);
  });

  it('retries a rename refused while another process holds the file', () => {
    const restore = onPlatform('win32');
    const store = new SessionStore({ storagePath: tmpDir });
    store.saveSession(summary(3));
    renameSync.mockClear();
    renameSync
      .mockImplementationOnce(heldByAnotherProcess)
      .mockImplementationOnce(heldByAnotherProcess);

    store.saveSession(summary(8));
    restore();

    expect(renameSync).toHaveBeenCalledTimes(3);
    expect(savedToolCalls()).toBe(8);
    expect(sessionFiles()).toEqual([basename(target)]);
    expect(warnings('directly')).toHaveLength(0);
  });

  it('writes the file directly when the rename keeps failing, and warns once', () => {
    const store = new SessionStore({ storagePath: tmpDir });
    renameSync.mockImplementation(heldByAnotherProcess);

    store.saveSession(summary(3));
    store.saveSession(summary(8));

    expect(savedToolCalls()).toBe(8);
    expect(sessionFiles()).toEqual([basename(target)]);
    expect(warnings('wrote it directly')).toHaveLength(1);
  });

  it('does not replace or set aside a file another process rewrote after the save read it', () => {
    const store = new SessionStore({ storagePath: tmpDir });
    realFs.writeFileSync(target, '{ "sessionId": ');
    let rewritten = false;
    readFileSync.mockImplementation((...args: unknown[]) => {
      const contents = (realFs.readFileSync as (...a: unknown[]) => unknown)(...args);
      if (!rewritten && args[0] === target) {
        rewritten = true;
        realFs.writeFileSync(`${target}.other-process.tmp`, JSON.stringify(summary(9)));
        realFs.renameSync(`${target}.other-process.tmp`, target);
      }
      return contents;
    });

    store.saveSession(summary(5));

    expect(savedToolCalls()).toBe(9);
    expect(sessionFiles()).toEqual([basename(target)]);

    store.saveSession(summary(5));

    expect(savedToolCalls()).toBe(9);
  });

  it('retries a refused rename on win32 only', () => {
    const attempts: Record<string, number> = {};
    for (const platform of ['win32', 'linux'] as const) {
      const restore = onPlatform(platform);
      try {
        renameSync.mockClear();
        renameSync.mockImplementation(heldByAnotherProcess);
        new SessionStore({ storagePath: tmpDir }).saveSession(summary(3));
        attempts[platform] = renameSync.mock.calls.length;
      } finally {
        restore();
      }
    }

    expect(attempts).toEqual({ win32: 5, linux: 1 });
  });

  it('reports the failure when the direct write fails too, never a write that did not happen', () => {
    renameSync.mockImplementation(heldByAnotherProcess);
    writeFileSync.mockImplementation((path, data, options) => {
      if (path === target) throw Object.assign(new Error('EPERM: locked'), { code: 'EPERM' });
      realFs.writeFileSync(path, data, options);
    });

    new SessionStore({ storagePath: tmpDir }).saveSession(summary(3));

    expect(warnings('wrote it directly')).toHaveLength(0);
    const failed = warnings('direct write failed');
    expect(failed).toHaveLength(1);
    expect(String((failed[0] as unknown[])[0])).toContain('EPERM: locked');
  });

  it('copies the same unparsed bytes aside once however many saves fail over them', () => {
    realFs.writeFileSync(target, '{ "sessionId": ');
    renameSync.mockImplementation(heldByAnotherProcess);
    writeFileSync.mockImplementation((path, data, options) => {
      if (path === target) throw Object.assign(new Error('EPERM: locked'), { code: 'EPERM' });
      realFs.writeFileSync(path, data, options);
    });
    const store = new SessionStore({ storagePath: tmpDir });

    store.saveSession(summary(3));
    store.saveSession(summary(4));
    store.saveSession(summary(5));

    expect(sessionFiles().filter((f) => f.endsWith('.corrupt'))).toHaveLength(1);
  });

  it('does not add a recovered file back beside a sibling that was briefly unreadable', () => {
    const dayTwo = new Date('2026-03-02T10:00:00Z').getTime();
    const recovered = join(tmpDir, 'sessions', `2026-03-01_${id}.json`);
    const sibling = join(tmpDir, 'sessions', `2026-03-02_${id}.json`);
    realFs.writeFileSync(
      recovered,
      `${JSON.stringify({ ...summary(7), startTime, developer: 'alice' })}{"tail":`,
    );
    realFs.writeFileSync(
      sibling,
      JSON.stringify({ ...summary(40), startTime: dayTwo, developer: 'alice' }),
    );
    const store = new SessionStore({ storagePath: tmpDir });
    expect(store.loadAllSessions().map((s) => s.toolCallCount)).toEqual([40]);

    readFileSync.mockImplementation((...args: unknown[]) => {
      if (args[0] === sibling) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return (realFs.readFileSync as (...a: unknown[]) => unknown)(...args);
    });
    store.saveSession({ ...summary(41), startTime: dayTwo, developer: 'alice' });
    readFileSync.mockImplementation(realFs.readFileSync as (...args: unknown[]) => unknown);

    const counts = store.loadAllSessions().map((s) => s.toolCallCount);
    expect(counts).toEqual([41]);
    expect(store.listSessions({ developer: 'alice' }).length).toBe(counts.length);
  });
});
