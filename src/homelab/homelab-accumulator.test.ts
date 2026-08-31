import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { HomelabAccumulator } from './homelab-accumulator.js';
import type { ToolCallRecord } from '../storage/types.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;
let tmpDir: string;

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  tmpDir = resolve(tmpdir(), `homelab-acc-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  stderrSpy.mockRestore();
  rmSync(tmpDir, { recursive: true, force: true });
  jest.useRealTimers();
});

function makeRecord(tool = 'Read', ts = Date.now()): ToolCallRecord {
  return {
    id: `id-${ts}`,
    sessionId: 'session-abc',
    toolName: tool,
    toolUseId: `u-${ts}`,
    timestamp: ts,
    durationMs: 10,
    success: true,
  };
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

  it('accepts valid payload and accumulates records', () => {
    const acc = new HomelabAccumulator({ storagePath: tmpDir });
    const result = acc.handleIngest({
      developer: 'alice',
      sessionId: 'session-abc',
      records: [makeRecord('Read'), makeRecord('Edit')],
    });
    expect(result).toBe('ok');
    const sessions = (acc as unknown as { sessions: Map<string, unknown> }).sessions;
    expect(sessions.has('alice:session-abc')).toBe(true);
  });

  it('appends records across multiple batches for the same session', () => {
    const acc = new HomelabAccumulator({ storagePath: tmpDir });
    acc.handleIngest({
      developer: 'alice',
      sessionId: 'session-abc',
      records: [makeRecord('Read')],
    });
    acc.handleIngest({
      developer: 'alice',
      sessionId: 'session-abc',
      records: [makeRecord('Edit')],
    });
    const sessions = (acc as unknown as { sessions: Map<string, { records: ToolCallRecord[] }> })
      .sessions;
    expect(sessions.get('alice:session-abc')?.records).toHaveLength(2);
  });

  it('flushes sessions to disk on stop()', () => {
    const { SessionStore } = jest.requireActual(
      '../storage/session-store.js',
    ) as typeof import('../storage/session-store.js');
    const store = new SessionStore({ storagePath: tmpDir });
    const acc = new HomelabAccumulator({ storagePath: tmpDir });
    acc.handleIngest({
      developer: 'alice',
      sessionId: 'session-flush',
      records: [makeRecord('Read'), makeRecord('Edit')],
    });
    acc.stop();
    const saved = store.loadSession('session-flush');
    expect(saved).not.toBeNull();
    expect(saved?.developer).toBe('alice');
    expect(saved?.toolCallCount).toBeGreaterThanOrEqual(1);
  });
});
