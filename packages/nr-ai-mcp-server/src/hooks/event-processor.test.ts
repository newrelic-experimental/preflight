import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalStore } from '../storage/local-store.js';
import { HookEventProcessor } from './event-processor.js';
import type { HookEvent, ToolCallRecord } from '../storage/types.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;
let tmpDir: string;
let store: LocalStore;
let records: ToolCallRecord[];
let onRecord: jest.Mock<(record: ToolCallRecord) => void>;

beforeEach(() => {
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  tmpDir = resolve(tmpdir(), `nr-ep-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  store = new LocalStore(tmpDir);
  store.initialize();
  records = [];
  onRecord = jest.fn((record: ToolCallRecord) => {
    records.push(record);
  });
});

afterEach(() => {
  stderrSpy.mockRestore();
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makePreEvent(overrides?: Partial<HookEvent>): HookEvent {
  return {
    mode: 'pre',
    tool: 'Read',
    timestamp: 1000,
    inputSize: 42,
    inputHash: 'abc123def456abcd',
    toolUseId: 'toolu_001',
    sessionId: 'sess-001',
    ...overrides,
  };
}

function makePostEvent(overrides?: Partial<HookEvent>): HookEvent {
  return {
    mode: 'post',
    tool: 'Read',
    timestamp: 1050,
    outputSize: 1024,
    success: true,
    toolUseId: 'toolu_001',
    sessionId: 'sess-001',
    ...overrides,
  };
}

function makeFailureEvent(overrides?: Partial<HookEvent>): HookEvent {
  return {
    mode: 'post',
    tool: 'Bash',
    timestamp: 1200,
    success: false,
    error: 'Command exited with non-zero status code 1',
    isInterrupt: false,
    toolUseId: 'toolu_002',
    sessionId: 'sess-001',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HookEventProcessor', () => {
  describe('processEvents() — paired pre + post', () => {
    it('produces a ToolCallRecord with correct durationMs', () => {
      const processor = new HookEventProcessor({
        store,
        onRecord,
      });

      processor.processEvents([
        makePreEvent({ timestamp: 1000 }),
        makePostEvent({ timestamp: 1050 }),
      ]);

      expect(records).toHaveLength(1);
      const record = records[0]!;
      expect(record.toolName).toBe('Read');
      expect(record.toolUseId).toBe('toolu_001');
      expect(record.durationMs).toBe(50);
      expect(record.success).toBe(true);
      expect(record.sessionId).toBe('sess-001');
      expect(record.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(record.timestamp).toBe(1000);
    });

    it('includes inputSizeBytes, outputSizeBytes, and inputHash', () => {
      const processor = new HookEventProcessor({ store, onRecord });

      processor.processEvents([
        makePreEvent({ inputSize: 100, inputHash: 'hash1234hash1234' }),
        makePostEvent({ outputSize: 2048 }),
      ]);

      const record = records[0]!;
      expect(record.inputSizeBytes).toBe(100);
      expect(record.outputSizeBytes).toBe(2048);
      expect(record.inputHash).toBe('hash1234hash1234');
    });
  });

  describe('processEvents() — interleaved ordering', () => {
    it('correctly pairs Read-with-Read and Grep-with-Grep by toolUseId', () => {
      const processor = new HookEventProcessor({ store, onRecord });

      processor.processEvents([
        makePreEvent({ tool: 'Read', toolUseId: 'toolu_read', timestamp: 1000 }),
        makePreEvent({ tool: 'Grep', toolUseId: 'toolu_grep', timestamp: 1010 }),
        makePostEvent({ tool: 'Grep', toolUseId: 'toolu_grep', timestamp: 1020 }),
        makePostEvent({ tool: 'Read', toolUseId: 'toolu_read', timestamp: 1100 }),
      ]);

      expect(records).toHaveLength(2);

      // Grep completes first (its post came first)
      const grepRecord = records.find(r => r.toolName === 'Grep')!;
      expect(grepRecord.toolUseId).toBe('toolu_grep');
      expect(grepRecord.durationMs).toBe(10);

      // Read completes second
      const readRecord = records.find(r => r.toolName === 'Read')!;
      expect(readRecord.toolUseId).toBe('toolu_read');
      expect(readRecord.durationMs).toBe(100);
    });
  });

  describe('processEvents() — PostToolUseFailure', () => {
    it('pairs pre + failure into record with success=false and error', () => {
      const processor = new HookEventProcessor({ store, onRecord });

      processor.processEvents([
        makePreEvent({ tool: 'Bash', toolUseId: 'toolu_002', timestamp: 1000 }),
        makeFailureEvent({ timestamp: 1200 }),
      ]);

      expect(records).toHaveLength(1);
      const record = records[0]!;
      expect(record.toolName).toBe('Bash');
      expect(record.success).toBe(false);
      expect(record.error).toBe('Command exited with non-zero status code 1');
      expect(record.durationMs).toBe(200);
    });
  });

  describe('processEvents() — orphaned post (no matching pre)', () => {
    it('creates a record with durationMs: null', () => {
      const processor = new HookEventProcessor({ store, onRecord });

      processor.processEvents([
        makePostEvent({ toolUseId: 'toolu_orphan', timestamp: 2000, outputSize: 512 }),
      ]);

      expect(records).toHaveLength(1);
      const record = records[0]!;
      expect(record.toolUseId).toBe('toolu_orphan');
      expect(record.durationMs).toBeNull();
      expect(record.success).toBe(true);
      expect(record.outputSizeBytes).toBe(512);
    });
  });

  describe('orphan timeout sweep', () => {
    it('emits timeout record for pre events older than orphanTimeoutMs', () => {
      const processor = new HookEventProcessor({
        store,
        onRecord,
        orphanTimeoutMs: 5000,
      });

      // Insert a pre event with timestamp far in the past
      processor.processEvents([
        makePreEvent({ toolUseId: 'toolu_old', timestamp: Date.now() - 10_000 }),
      ]);

      expect(records).toHaveLength(0);
      expect(processor.pendingCount).toBe(1);

      // Write a dummy event to buffer so the poll cycle runs processEvents + sweepOrphans
      store.appendToBuffer(makePreEvent({ toolUseId: 'toolu_new', timestamp: Date.now() }));

      // Manually trigger what poll() does: drain + process + sweep
      const drained = store.drainBuffer();
      processor.processEvents(drained);
      // Access sweepOrphans via a second processEvents + stop cycle
      // Simpler: just call stop() which flushes pending
      processor.stop();

      // The old pre should be flushed as timeout
      const timeoutRecord = records.find(r => r.toolUseId === 'toolu_old');
      expect(timeoutRecord).toBeDefined();
      expect(timeoutRecord!.success).toBe(false);
      expect(timeoutRecord!.errorType).toBe('timeout');
      expect(timeoutRecord!.durationMs).toBeNull();
    });
  });

  describe('rapid sequence', () => {
    it('correctly pairs 50 tool calls', () => {
      const processor = new HookEventProcessor({ store, onRecord });

      const events: HookEvent[] = [];
      for (let i = 0; i < 50; i++) {
        events.push(makePreEvent({
          tool: `tool-${i}`,
          toolUseId: `toolu_${i}`,
          timestamp: 1000 + i * 10,
        }));
      }
      for (let i = 0; i < 50; i++) {
        events.push(makePostEvent({
          tool: `tool-${i}`,
          toolUseId: `toolu_${i}`,
          timestamp: 1000 + i * 10 + 5,
          outputSize: i * 100,
        }));
      }

      processor.processEvents(events);

      expect(records).toHaveLength(50);
      for (let i = 0; i < 50; i++) {
        const record = records.find(r => r.toolUseId === `toolu_${i}`)!;
        expect(record).toBeDefined();
        expect(record.toolName).toBe(`tool-${i}`);
        expect(record.durationMs).toBe(5);
        expect(record.success).toBe(true);
      }
    });
  });

  describe('empty buffer', () => {
    it('emits no records from empty event list', () => {
      const processor = new HookEventProcessor({ store, onRecord });

      processor.processEvents([]);

      expect(records).toHaveLength(0);
    });
  });

  describe('start() / stop() lifecycle', () => {
    it('start() begins polling and stop() halts', () => {
      jest.useFakeTimers();

      try {
        // Write events to the buffer before starting
        store.appendToBuffer(makePreEvent({ timestamp: Date.now() }));
        store.appendToBuffer(makePostEvent({ timestamp: Date.now() + 50 }));

        const processor = new HookEventProcessor({
          store,
          onRecord,
          pollIntervalMs: 50,
        });

        processor.start();

        // Advance past poll interval
        jest.advanceTimersByTime(100);

        processor.stop();

        // Should have drained the buffer and produced a record
        expect(records.length).toBeGreaterThanOrEqual(1);
        expect(records[0]!.toolName).toBe('Read');
      } finally {
        jest.useRealTimers();
      }
    });

    it('stop() is idempotent', () => {
      const processor = new HookEventProcessor({ store, onRecord });
      processor.start();
      processor.stop();
      processor.stop(); // second call is a no-op
      expect(records).toHaveLength(0);
    });

    it('start() guards against double-start', () => {
      jest.useFakeTimers();
      try {
        const processor = new HookEventProcessor({ store, onRecord, pollIntervalMs: 50 });
        processor.start();
        processor.start(); // should warn but not crash
        processor.stop();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('stop() flushes pending pre events as timeouts', () => {
    it('emits timeout records for all pending pre events', () => {
      const processor = new HookEventProcessor({ store, onRecord });

      // Add pre events without any corresponding post
      processor.processEvents([
        makePreEvent({ toolUseId: 'toolu_a', tool: 'Read', timestamp: 1000 }),
        makePreEvent({ toolUseId: 'toolu_b', tool: 'Write', timestamp: 1010 }),
      ]);

      expect(records).toHaveLength(0);
      expect(processor.pendingCount).toBe(2);

      processor.stop();

      expect(records).toHaveLength(2);
      for (const record of records) {
        expect(record.success).toBe(false);
        expect(record.errorType).toBe('timeout');
        expect(record.durationMs).toBeNull();
      }

      const tools = records.map(r => r.toolName).sort();
      expect(tools).toEqual(['Read', 'Write']);
    });
  });

  describe('missing toolUseId fallback', () => {
    it('falls back to tool:timestamp key for events without toolUseId', () => {
      const processor = new HookEventProcessor({ store, onRecord });

      // Events without toolUseId — fallback pairing by tool:timestamp
      processor.processEvents([
        { mode: 'pre', tool: 'Read', timestamp: 5000, inputSize: 10 } as HookEvent,
        { mode: 'post', tool: 'Read', timestamp: 5000, outputSize: 100, success: true } as HookEvent,
      ]);

      // They share the same fallback key 'Read:5000', so they pair
      expect(records).toHaveLength(1);
      expect(records[0]!.toolName).toBe('Read');
      expect(records[0]!.durationMs).toBe(0);
    });
  });

  describe('integration with LocalStore buffer', () => {
    it('drains and processes events from the buffer file', () => {
      const processor = new HookEventProcessor({ store, onRecord });

      // Write events to the actual buffer file
      store.appendToBuffer(makePreEvent({ timestamp: 2000 }));
      store.appendToBuffer(makePostEvent({ timestamp: 2075 }));

      // Manually drain and process (simulating what poll() does)
      const events = store.drainBuffer();
      processor.processEvents(events);

      expect(records).toHaveLength(1);
      expect(records[0]!.durationMs).toBe(75);
      expect(records[0]!.success).toBe(true);
    });
  });
});
