import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AlertLog } from './alert-log.js';
import type { AlertEvent } from '../dashboard/live-event-bus.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;
let tmpDir: string;

beforeEach(() => {
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  tmpDir = mkdtempSync(join(tmpdir(), 'alert-log-'));
});

afterEach(() => {
  stderrSpy.mockRestore();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeEvent(overrides: Partial<AlertEvent> = {}): AlertEvent {
  return {
    id: 'rule-a',
    state: 'firing',
    severity: 'warning',
    title: 'Test alert',
    description: 'Test description',
    value: 80,
    threshold: 80,
    firedAt: 1700000000000,
    ...overrides,
  };
}

describe('AlertLog — append + read', () => {
  it('does not touch the filesystem in the constructor', () => {
    const path = join(tmpDir, 'subdir-not-created', 'log.jsonl');
    new AlertLog({ path });
    expect(existsSync(join(tmpDir, 'subdir-not-created'))).toBe(false);
  });

  it('appends a JSON line per event and reads them back most-recent-first', async () => {
    const path = join(tmpDir, 'log.jsonl');
    const log = new AlertLog({ path });
    await log.append(makeEvent({ id: 'a', firedAt: 1 }));
    await log.append(makeEvent({ id: 'b', firedAt: 2 }));
    await log.append(makeEvent({ id: 'c', firedAt: 3 }));
    const recent = await log.readRecent(10);
    expect(recent.map((e) => e.id)).toEqual(['c', 'b', 'a']);
  });

  it('returns at most `limit` entries', async () => {
    const path = join(tmpDir, 'log.jsonl');
    const log = new AlertLog({ path });
    for (let i = 0; i < 5; i++) {
      await log.append(makeEvent({ id: `r${i}`, firedAt: i }));
    }
    const recent = await log.readRecent(2);
    expect(recent.map((e) => e.id)).toEqual(['r4', 'r3']);
  });

  it('returns [] when the log file does not exist', async () => {
    const path = join(tmpDir, 'never-written.jsonl');
    const log = new AlertLog({ path });
    expect(await log.readRecent(10)).toEqual([]);
  });

  it('skips lines that are not valid JSON', async () => {
    const path = join(tmpDir, 'log.jsonl');
    const log = new AlertLog({ path });
    await log.append(makeEvent({ id: 'good-1', firedAt: 1 }));
    // Sneak a malformed line in directly.
    const { appendFileSync } = await import('node:fs');
    appendFileSync(path, 'not-json{{{\n');
    await log.append(makeEvent({ id: 'good-2', firedAt: 2 }));
    const recent = await log.readRecent(10);
    expect(recent.map((e) => e.id)).toEqual(['good-2', 'good-1']);
  });

  it('skips entries with the wrong shape (e.g. corrupted/hand-edited file)', async () => {
    const path = join(tmpDir, 'log.jsonl');
    const log = new AlertLog({ path });
    await log.append(makeEvent({ id: 'good', firedAt: 1 }));
    const { appendFileSync } = await import('node:fs');
    // Wrong-typed value field (string instead of number).
    appendFileSync(
      path,
      JSON.stringify({
        id: 'bad',
        state: 'firing',
        severity: 'warning',
        title: 't',
        description: 'd',
        value: 'oops',
        threshold: 1,
        firedAt: 2,
      }) + '\n',
    );
    // Missing required fields.
    appendFileSync(path, JSON.stringify({ id: 'incomplete' }) + '\n');
    // Unexpected severity.
    appendFileSync(
      path,
      JSON.stringify({
        id: 'wrong-sev',
        state: 'firing',
        severity: 'fatal',
        title: 't',
        description: 'd',
        value: 1,
        threshold: 1,
        firedAt: 3,
      }) + '\n',
    );
    const recent = await log.readRecent(10);
    expect(recent.map((e) => e.id)).toEqual(['good']);
  });
});

describe('AlertLog — rotation', () => {
  it('rotates to .1 when size threshold is crossed and starts a fresh file', async () => {
    const path = join(tmpDir, 'log.jsonl');
    // Each event line is small; pick a tiny threshold so we trip rotation.
    const log = new AlertLog({ path, maxBytes: 200 });

    await log.append(makeEvent({ id: 'a', firedAt: 1 }));
    await log.append(makeEvent({ id: 'b', firedAt: 2 }));
    // Force size > maxBytes
    for (let i = 0; i < 10; i++) {
      await log.append(makeEvent({ id: `pad-${i}`, firedAt: 10 + i }));
    }

    expect(existsSync(`${path}.1`)).toBe(true);
    // After rotation, the active file should be small again. Continue
    // appending to confirm new writes go to the new file.
    await log.append(makeEvent({ id: 'after-rotation', firedAt: 9999 }));
    const recent = await log.readRecent(10);
    expect(recent[0]!.id).toBe('after-rotation');
  });

  it('keeps only ONE rotation — second rotation replaces .1', async () => {
    const path = join(tmpDir, 'log.jsonl');
    const log = new AlertLog({ path, maxBytes: 100 });
    // First batch — should rotate.
    for (let i = 0; i < 6; i++) {
      await log.append(makeEvent({ id: `first-${i}`, firedAt: i }));
    }
    expect(existsSync(`${path}.1`)).toBe(true);
    // Second batch — should rotate again, replacing the previous .1.
    for (let i = 0; i < 6; i++) {
      await log.append(makeEvent({ id: `second-${i}`, firedAt: 100 + i }));
    }
    // No .2 file should exist.
    expect(existsSync(`${path}.2`)).toBe(false);
  });
});

describe('AlertLog — file permissions', () => {
  it('creates the file with mode 0o600', async () => {
    const path = join(tmpDir, 'log.jsonl');
    const log = new AlertLog({ path });
    await log.append(makeEvent());
    const st = statSync(path);
    // Skip mode assertion on platforms (e.g. Windows) where chmod is a no-op.
    if (process.platform !== 'win32') {
      expect(st.mode & 0o777).toBe(0o600);
    }
  });

  it('creates the parent directory with mode 0o700', async () => {
    const subdir = join(tmpDir, 'nested');
    const path = join(subdir, 'log.jsonl');
    const log = new AlertLog({ path });
    await log.append(makeEvent());
    const st = statSync(subdir);
    if (process.platform !== 'win32') {
      expect(st.mode & 0o777).toBe(0o700);
    }
  });
});
