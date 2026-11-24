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

    expect(store.loadAllSessions().map((s) => s.toolCallCount)).toEqual([41]);
    expect(store.loadSession(id)?.toolCallCount).toBe(41);
    expect(warnings('cannot be found')).toHaveLength(0);
  });

  it('keeps a split file another process rewrote after the save read it, and combines it next', () => {
    const dayTwo = new Date('2026-03-02T10:00:00Z').getTime();
    const entry = (timestamp: number) => ({
      timestamp,
      toolName: 'Read',
      durationMs: 5,
      success: true,
    });
    const sibling = join(tmpDir, 'sessions', `2026-03-02_${id}.json`);
    const split = (toolCallCount: number, timestamps: number[]) =>
      JSON.stringify({
        ...summary(toolCallCount),
        startTime: dayTwo,
        timeline: timestamps.map(entry),
      });
    realFs.writeFileSync(
      target,
      JSON.stringify({ ...summary(2), timeline: [entry(startTime + 1), entry(startTime + 2)] }),
    );
    realFs.writeFileSync(sibling, split(1, [dayTwo + 1]));
    const store = new SessionStore({ storagePath: tmpDir });

    let reads = 0;
    readFileSync.mockImplementation((...args: unknown[]) => {
      const contents = (realFs.readFileSync as (...a: unknown[]) => unknown)(...args);
      if (args[0] === sibling && ++reads === 1) {
        realFs.writeFileSync(sibling, split(2, [dayTwo + 1, dayTwo + 2]));
      }
      return contents;
    });
    store.saveSession(summary(3));
    readFileSync.mockImplementation(realFs.readFileSync as (...args: unknown[]) => unknown);

    expect(sessionFiles()).toEqual([basename(target), basename(sibling)]);
    expect(store.loadAllSessions().map((s) => s.toolCallCount)).toEqual([3]);
    expect(store.loadSession(id)?.timeline).toHaveLength(4);
  });

  describe('when another process sets a split file aside during a read', () => {
    const dayTwo = new Date('2026-03-02T10:00:00Z').getTime();
    const split = (start: number, toolCallCount: number, timestamps: number[]) =>
      JSON.stringify({
        ...summary(toolCallCount),
        startTime: start,
        timeline: timestamps.map((timestamp) => ({ timestamp, toolName: 'Read' })),
      });
    const siblingPath = () => join(tmpDir, 'sessions', `2026-03-02_${id}.json`);
    const seedSplitFiles = () => {
      realFs.writeFileSync(target, split(startTime, 10, [startTime + 1]));
      realFs.writeFileSync(siblingPath(), split(dayTwo, 20, [dayTwo + 1]));
    };
    /** The other process finishes its whole save right after this one read the first file. */
    const otherProcessSavesAfterFirstRead = () => {
      let done = false;
      readFileSync.mockImplementation((...args: unknown[]) => {
        const contents = (realFs.readFileSync as (...a: unknown[]) => unknown)(...args);
        if (args[0] === target && !done) {
          done = true;
          realFs.writeFileSync(target, split(startTime, 30, [startTime + 1, dayTwo + 1]));
          realFs.renameSync(siblingPath(), `${siblingPath()}.1.merged`);
        }
        return contents;
      });
    };
    const store = () => new SessionStore({ storagePath: tmpDir });

    it("a save keeps the other process's combined record and reports it as previous", () => {
      seedSplitFiles();
      otherProcessSavesAfterFirstRead();
      const saved = store().saveSession(summary(2));
      expect(saved?.previous?.toolCallCount).toBe(30);
      expect(savedToolCalls()).toBe(30);
    });

    it('loadSession returns the combined record, not the piece it read first', () => {
      seedSplitFiles();
      otherProcessSavesAfterFirstRead();
      expect(store().loadSession(id)?.toolCallCount).toBe(30);
    });

    it('loadAllSessions returns the combined record, not the piece it read first', () => {
      seedSplitFiles();
      otherProcessSavesAfterFirstRead();
      expect(
        store()
          .loadAllSessions()
          .map((s) => s.toolCallCount),
      ).toEqual([30]);
    });

    it("a relist leaves another session's files out of this record", () => {
      seedSplitFiles();
      const another = join(tmpDir, 'sessions', '2026-03-03_another-session.json');
      realFs.writeFileSync(another, split(dayTwo, 7, [dayTwo + 5]).replaceAll(id, 'another'));
      otherProcessSavesAfterFirstRead();
      expect(store().saveSession(summary(2))?.previous?.toolCallCount).toBe(30);
      expect(realFs.existsSync(another)).toBe(true);
    });

    it('a window load relists within its window', () => {
      seedSplitFiles();
      const since = new Date(dayTwo);
      realFs.writeFileSync(
        join(tmpDir, 'sessions', '2026-03-03_another-session.json'),
        JSON.stringify({ ...summary(1), sessionId: 'another-session', startTime: dayTwo }),
      );
      realFs.writeFileSync(
        join(tmpDir, 'sessions', `2026-03-03_${id}.json`),
        split(dayTwo + 86_400_000, 5, [dayTwo + 86_400_000]),
      );
      readFileSync.mockImplementation((...args: unknown[]) => {
        if (args[0] === siblingPath()) {
          realFs.renameSync(siblingPath(), `${siblingPath()}.1.merged`);
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        return (realFs.readFileSync as (...a: unknown[]) => unknown)(...args);
      });
      const loaded = store().loadAllSessions({ since });
      expect(loaded.map((s) => [s.sessionId, s.toolCallCount])).toEqual([
        ['another-session', 1],
        [id, 5],
      ]);
    });

    it('rereads when a fresh listing has the same length but other files', () => {
      seedSplitFiles();
      const earlier = join(tmpDir, 'sessions', `2026-02-28_${id}.json`);
      readFileSync.mockImplementation((...args: unknown[]) => {
        if (args[0] === siblingPath() && realFs.existsSync(siblingPath())) {
          realFs.writeFileSync(
            earlier,
            split(startTime - 86_400_000, 30, [startTime + 1, dayTwo + 1]),
          );
          realFs.renameSync(siblingPath(), `${siblingPath()}.1.merged`);
        }
        return (realFs.readFileSync as (...a: unknown[]) => unknown)(...args);
      });
      expect(store().loadSession(id)?.toolCallCount).toBe(30);
    });

    it('a save still succeeds when it cannot set a superseded file aside', () => {
      seedSplitFiles();
      renameSync.mockImplementation((from, to) => {
        if (String(to).endsWith('.merged')) heldByAnotherProcess();
        realFs.renameSync(from, to);
      });
      const saved = store().saveSession(summary(31));
      expect(saved?.previous?.toolCallCount).toBe(30);
      expect(warnings('Failed to set aside')).not.toHaveLength(0);
      expect(sessionFiles()).toEqual([basename(target), basename(siblingPath())]);
    });

    it('skips a listed file that can never be read, and the save still lands', () => {
      realFs.writeFileSync(target, split(startTime, 10, [startTime + 1]));
      realFs.symlinkSync(join(tmpDir, 'missing'), siblingPath());
      const saved = store().saveSession(summary(12));
      expect(saved?.previous?.toolCallCount).toBe(10);
      expect(savedToolCalls()).toBe(12);
      expect(warnings('cannot be found')).not.toHaveLength(0);
    });
  });
});
