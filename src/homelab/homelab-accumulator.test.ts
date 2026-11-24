import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { HomelabAccumulator } from './homelab-accumulator.js';
import { SessionStore } from '../storage/session-store.js';
import type { FullSessionSummary } from '../storage/session-store.js';
import type { ToolCallRecord } from '../storage/types.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;
let tmpDir: string;

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  tmpDir = mkdtempSync(resolve(tmpdir(), 'homelab-acc-test-'));
});

afterEach(() => {
  stderrSpy.mockRestore();
  rmSync(tmpDir, { recursive: true, force: true });
  jest.useRealTimers();
});

function makeRecord(n: number, tool = 'Read'): ToolCallRecord {
  return {
    id: `id-${n}`,
    sessionId: 'session-abc',
    toolName: tool,
    toolUseId: `u-${n}`,
    timestamp: 1_700_000_000_000 + n * 1000,
    durationMs: 10,
    success: true,
  };
}

function records(from: number, count: number, tool = 'Read'): ToolCallRecord[] {
  return Array.from({ length: count }, (_, i) => makeRecord(from + i, tool));
}

function runServer(...batches: ToolCallRecord[][]): void {
  const acc = new HomelabAccumulator({ storagePath: tmpDir });
  for (const batch of batches) {
    expect(acc.handleIngest({ developer: 'alice', sessionId: 'session-abc', records: batch })).toBe(
      'ok',
    );
  }
  acc.stop();
}

function saved(): FullSessionSummary | null {
  return new SessionStore({ storagePath: tmpDir }).loadSession('session-abc');
}

describe('HomelabAccumulator', () => {
  it('returns invalid for missing developer', () => {
    const acc = new HomelabAccumulator({ storagePath: tmpDir });
    const result = acc.handleIngest({ developer: '', sessionId: 'abc123', records: [] });
    expect(result).toBe('invalid');
  });

  it('returns invalid for invalid sessionId', () => {
    const acc = new HomelabAccumulator({ storagePath: tmpDir });
    const result = acc.handleIngest({
      developer: 'alice',
      sessionId: '../etc/passwd',
      records: [],
    });
    expect(result).toBe('invalid');
  });

  it('saves the calls of every batch of a session', () => {
    runServer(records(0, 3), records(3, 4, 'Edit'));
    expect(saved()?.developer).toBe('alice');
    expect(saved()?.toolCallCount).toBe(7);
    expect(saved()?.toolBreakdown).toEqual({ Read: 3, Edit: 4 });
  });

  it('adds a later batch to the calls the session already saved', () => {
    runServer(records(0, 12));
    expect(saved()?.toolCallCount).toBe(12);
    runServer([...records(12, 2), ...records(14, 1, 'Edit')]);
    expect(saved()?.toolCallCount).toBe(15);
    expect(saved()?.toolBreakdown).toEqual({ Read: 14, Edit: 1 });
  });

  it('adds a batch to a session saved without a timeline by an older build', () => {
    runServer(records(0, 12));
    const dir = new SessionStore({ storagePath: tmpDir }).getSessionsDir();
    const [file] = readdirSync(dir).map((name) => resolve(dir, name));
    const { timeline: _dropped, ...legacy } = JSON.parse(readFileSync(file, 'utf8')) as Record<
      string,
      unknown
    >;
    writeFileSync(file, JSON.stringify(legacy));
    runServer(records(12, 3));
    expect(saved()?.toolCallCount).toBe(15);
  });

  it('saves a session once it goes three minutes without a batch', () => {
    jest.useFakeTimers({ now: 1_700_000_000_000 });
    const acc = new HomelabAccumulator({ storagePath: tmpDir });
    acc.start();
    acc.handleIngest({ developer: 'alice', sessionId: 'session-abc', records: records(0, 1) });
    jest.advanceTimersByTime(120_000);
    acc.handleIngest({ developer: 'alice', sessionId: 'session-abc', records: records(1, 1) });
    jest.advanceTimersByTime(120_000);
    expect(saved()).toBeNull();
    jest.advanceTimersByTime(120_000);
    expect(saved()?.toolCallCount).toBe(2);
    acc.stop();
  });

  it('counts a resent batch once, before and after the session is saved', () => {
    const batch = records(0, 3);
    runServer(batch, batch);
    expect(saved()?.toolCallCount).toBe(3);
    runServer(batch, records(3, 1));
    expect(saved()?.toolCallCount).toBe(4);
  });
});
