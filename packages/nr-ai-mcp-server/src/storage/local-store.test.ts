import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalStore } from './local-store.js';
import type { HookEvent, SessionSummary, AuditEntry } from './types.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;
let tmpDir: string;

beforeEach(() => {
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  tmpDir = resolve(tmpdir(), `nr-localstore-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
});

afterEach(() => {
  stderrSpy.mockRestore();
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function makeEvent(overrides?: Partial<HookEvent>): HookEvent {
  return {
    mode: 'post',
    tool: 'Read',
    timestamp: Date.now(),
    inputSize: 42,
    outputSize: 100,
    success: true,
    ...overrides,
  };
}

function makeSession(overrides?: Partial<SessionSummary>): SessionSummary {
  const now = Date.now();
  return {
    sessionId: `sess-${now}`,
    startTime: now - 60_000,
    endTime: now,
    durationMs: 60_000,
    toolCallCount: 5,
    developer: 'test-user',
    ...overrides,
  };
}

function makeAudit(overrides?: Partial<AuditEntry>): AuditEntry {
  return {
    timestamp: Date.now(),
    action: 'tool_call',
    tool: 'Read',
    detail: 'test audit entry',
    ...overrides,
  };
}

describe('LocalStore', () => {
  describe('initialize()', () => {
    it('creates the expected directory structure', () => {
      const store = new LocalStore(tmpDir);
      store.initialize();

      expect(existsSync(tmpDir)).toBe(true);
      expect(existsSync(resolve(tmpDir, 'sessions'))).toBe(true);
      expect(existsSync(resolve(tmpDir, 'weekly_summaries'))).toBe(true);
      expect(existsSync(resolve(tmpDir, 'audit'))).toBe(true);
    });

    it('is idempotent — calling twice does not throw', () => {
      const store = new LocalStore(tmpDir);
      store.initialize();
      store.initialize();

      expect(existsSync(tmpDir)).toBe(true);
    });
  });

  describe('appendToBuffer() + drainBuffer()', () => {
    it('round-trips a single event', () => {
      const store = new LocalStore(tmpDir);
      mkdirSync(tmpDir, { recursive: true });

      const event = makeEvent({ tool: 'Write' });
      store.appendToBuffer(event);

      const drained = store.drainBuffer();
      expect(drained).toHaveLength(1);
      expect(drained[0]).toEqual(event);
    });

    it('round-trips multiple events in order', () => {
      const store = new LocalStore(tmpDir);
      mkdirSync(tmpDir, { recursive: true });

      const events = [
        makeEvent({ tool: 'Read', timestamp: 1 }),
        makeEvent({ tool: 'Write', timestamp: 2 }),
        makeEvent({ tool: 'Bash', timestamp: 3 }),
      ];

      for (const e of events) {
        store.appendToBuffer(e);
      }

      const drained = store.drainBuffer();
      expect(drained).toEqual(events);
    });

    it('drain clears the buffer — second drain returns empty', () => {
      const store = new LocalStore(tmpDir);
      mkdirSync(tmpDir, { recursive: true });

      store.appendToBuffer(makeEvent());
      expect(store.drainBuffer()).toHaveLength(1);
      expect(store.drainBuffer()).toHaveLength(0);
    });

    it('handles 100 rapid appends without corruption', () => {
      const store = new LocalStore(tmpDir);
      mkdirSync(tmpDir, { recursive: true });

      const events: HookEvent[] = [];
      for (let i = 0; i < 100; i++) {
        const e = makeEvent({ tool: `tool-${i}`, timestamp: i });
        events.push(e);
        store.appendToBuffer(e);
      }

      const drained = store.drainBuffer();
      expect(drained).toHaveLength(100);
      expect(drained).toEqual(events);
    });
  });

  describe('drainBuffer() edge cases', () => {
    it('returns empty array when buffer file does not exist', () => {
      const store = new LocalStore(tmpDir);
      mkdirSync(tmpDir, { recursive: true });

      expect(store.drainBuffer()).toEqual([]);
    });

    it('returns empty array when buffer file is empty', () => {
      const store = new LocalStore(tmpDir);
      mkdirSync(tmpDir, { recursive: true });

      const bufferPath = resolve(tmpDir, 'buffer.jsonl');
      writeFileSync(bufferPath, '');

      expect(store.drainBuffer()).toEqual([]);
    });

    it('skips malformed lines and returns valid ones', () => {
      const store = new LocalStore(tmpDir);
      mkdirSync(tmpDir, { recursive: true });

      const validEvent = makeEvent({ tool: 'Read' });
      const bufferPath = resolve(tmpDir, 'buffer.jsonl');
      writeFileSync(
        bufferPath,
        JSON.stringify(validEvent) + '\n' +
        'NOT VALID JSON\n' +
        JSON.stringify(makeEvent({ tool: 'Write' })) + '\n',
      );

      const drained = store.drainBuffer();
      expect(drained).toHaveLength(2);
      expect(drained[0]!.tool).toBe('Read');
      expect(drained[1]!.tool).toBe('Write');
    });

    it('recovers orphaned .drain file when buffer does not exist', () => {
      const store = new LocalStore(tmpDir);
      mkdirSync(tmpDir, { recursive: true });

      const drainPath = resolve(tmpDir, 'buffer.jsonl.drain');
      const event = makeEvent({ tool: 'Orphaned' });
      writeFileSync(drainPath, JSON.stringify(event) + '\n');

      const drained = store.drainBuffer();
      expect(drained).toHaveLength(1);
      expect(drained[0]!.tool).toBe('Orphaned');
      expect(existsSync(drainPath)).toBe(false);
    });

    it('merges .drain and buffer when both exist', () => {
      const store = new LocalStore(tmpDir);
      mkdirSync(tmpDir, { recursive: true });

      const bufferPath = resolve(tmpDir, 'buffer.jsonl');
      const drainPath = resolve(tmpDir, 'buffer.jsonl.drain');

      const olderEvent = makeEvent({ tool: 'FromDrain', timestamp: 1 });
      const newerEvent = makeEvent({ tool: 'FromBuffer', timestamp: 2 });

      writeFileSync(drainPath, JSON.stringify(olderEvent) + '\n');
      writeFileSync(bufferPath, JSON.stringify(newerEvent) + '\n');

      const drained = store.drainBuffer();
      expect(drained).toHaveLength(2);
      expect(drained[0]!.tool).toBe('FromDrain');
      expect(drained[1]!.tool).toBe('FromBuffer');
      expect(existsSync(drainPath)).toBe(false);
    });

    it('handles corrupt .drain file gracefully', () => {
      const store = new LocalStore(tmpDir);
      mkdirSync(tmpDir, { recursive: true });

      const drainPath = resolve(tmpDir, 'buffer.jsonl.drain');
      const validEvent = makeEvent({ tool: 'Valid' });
      writeFileSync(drainPath, 'CORRUPT DATA\n' + JSON.stringify(validEvent) + '\n');

      const drained = store.drainBuffer();
      expect(drained).toHaveLength(1);
      expect(drained[0]!.tool).toBe('Valid');
    });
  });

  describe('saveSession() + loadRecentSessions()', () => {
    it('saves a session and loads it back', () => {
      const store = new LocalStore(tmpDir);
      store.initialize();

      const session = makeSession();
      store.saveSession(session);

      const loaded = store.loadRecentSessions(7);
      expect(loaded).toHaveLength(1);
      expect(loaded[0]).toEqual(session);
    });

    it('filters out sessions older than the cutoff', () => {
      const store = new LocalStore(tmpDir);
      store.initialize();

      const now = Date.now();
      const recent = makeSession({ sessionId: 'recent', startTime: now - 1000, endTime: now });
      const old = makeSession({ sessionId: 'old', startTime: now - 30 * 86_400_000, endTime: now - 30 * 86_400_000 + 1000 });

      store.saveSession(recent);
      store.saveSession(old);

      // Touch the old file to make its mtime old
      const oldPath = resolve(tmpDir, 'sessions', 'old.json');
      const pastDate = new Date(now - 30 * 86_400_000);
      utimesSync(oldPath, pastDate, pastDate);

      const loaded = store.loadRecentSessions(7);
      expect(loaded).toHaveLength(1);
      expect(loaded[0]!.sessionId).toBe('recent');
    });

    it('returns empty array when sessions directory does not exist', () => {
      const store = new LocalStore(tmpDir);
      // Do NOT call initialize()
      expect(store.loadRecentSessions(7)).toEqual([]);
    });

    it('sorts sessions by startTime', () => {
      const store = new LocalStore(tmpDir);
      store.initialize();

      const now = Date.now();
      const s1 = makeSession({ sessionId: 's1', startTime: now - 3000 });
      const s2 = makeSession({ sessionId: 's2', startTime: now - 1000 });
      const s3 = makeSession({ sessionId: 's3', startTime: now - 2000 });

      store.saveSession(s2);
      store.saveSession(s3);
      store.saveSession(s1);

      const loaded = store.loadRecentSessions(7);
      expect(loaded.map(s => s.sessionId)).toEqual(['s1', 's3', 's2']);
    });
  });

  describe('appendAuditLog()', () => {
    it('creates a date-stamped file and writes an entry', () => {
      const store = new LocalStore(tmpDir);
      store.initialize();

      const entry = makeAudit({ timestamp: Date.now() });
      store.appendAuditLog(entry);

      const dateStr = new Date(entry.timestamp).toISOString().slice(0, 10);
      const filepath = resolve(tmpDir, 'audit', `${dateStr}.jsonl`);
      expect(existsSync(filepath)).toBe(true);

      const raw = readFileSync(filepath, 'utf-8').trim();
      expect(JSON.parse(raw)).toEqual(entry);
    });

    it('appends multiple entries to the same date file', () => {
      const store = new LocalStore(tmpDir);
      store.initialize();

      const ts = Date.now();
      const entry1 = makeAudit({ timestamp: ts, action: 'first' });
      const entry2 = makeAudit({ timestamp: ts + 100, action: 'second' });

      store.appendAuditLog(entry1);
      store.appendAuditLog(entry2);

      const dateStr = new Date(ts).toISOString().slice(0, 10);
      const filepath = resolve(tmpDir, 'audit', `${dateStr}.jsonl`);
      const lines = readFileSync(filepath, 'utf-8').trim().split('\n');

      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!)).toEqual(entry1);
      expect(JSON.parse(lines[1]!)).toEqual(entry2);
    });

    it('uses separate files for different dates', () => {
      const store = new LocalStore(tmpDir);
      store.initialize();

      const day1 = new Date('2025-06-15T12:00:00Z').getTime();
      const day2 = new Date('2025-06-16T12:00:00Z').getTime();

      store.appendAuditLog(makeAudit({ timestamp: day1 }));
      store.appendAuditLog(makeAudit({ timestamp: day2 }));

      expect(existsSync(resolve(tmpDir, 'audit', '2025-06-15.jsonl'))).toBe(true);
      expect(existsSync(resolve(tmpDir, 'audit', '2025-06-16.jsonl'))).toBe(true);
    });
  });
});
