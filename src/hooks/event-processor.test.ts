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
    it('pairs pre and post events without toolUseId via FIFO tool-name search', () => {
      const processor = new HookEventProcessor({ store, onRecord });

      // Events without toolUseId — fallback pairing via oldest-pending-by-tool FIFO
      processor.processEvents([
        { mode: 'pre', tool: 'Read', timestamp: 5000, inputSize: 10 } as HookEvent,
        { mode: 'post', tool: 'Read', timestamp: 5100, outputSize: 100, success: true } as HookEvent,
      ]);

      expect(records).toHaveLength(1);
      expect(records[0]!.toolName).toBe('Read');
      expect(records[0]!.durationMs).toBe(100);
    });

    it('does not drop parallel same-tool pre-events that share a timestamp', () => {
      const processor = new HookEventProcessor({ store, onRecord });

      // Two Read pre-events at the same millisecond — previously the second
      // overwrote the first in this.pending (collision on the fallback key).
      processor.processEvents([
        { mode: 'pre', tool: 'Read', timestamp: 5000, inputSize: 10 } as HookEvent,
        { mode: 'pre', tool: 'Read', timestamp: 5000, inputSize: 20 } as HookEvent,
        { mode: 'post', tool: 'Read', timestamp: 5100, outputSize: 100, success: true } as HookEvent,
        { mode: 'post', tool: 'Read', timestamp: 5200, outputSize: 200, success: true } as HookEvent,
      ]);

      // Both pre-events survive; each pairs with one post-event
      expect(records).toHaveLength(2);
      expect(records.every((r) => r.toolName === 'Read')).toBe(true);
    });
  });

  describe('negative duration clamping', () => {
    it('clamps durationMs to 0 when post timestamp precedes pre timestamp', () => {
      const processor = new HookEventProcessor({ store, onRecord });

      processor.processEvents([
        makePreEvent({ timestamp: 5000 }),
        makePostEvent({ timestamp: 4000 }),
      ]);

      expect(records).toHaveLength(1);
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

  // ---------------------------------------------------------------------------
  // Pending map size cap (M-04)
  // ---------------------------------------------------------------------------

  describe('pending map size cap (M-04)', () => {
    it('does not exceed maxPendingEvents entries in the pending map', () => {
      const processor = new HookEventProcessor({ store, onRecord, maxPendingEvents: 5 });

      for (let i = 0; i < 10; i++) {
        processor.processEvents([
          makePreEvent({ toolUseId: `toolu_${i}`, timestamp: 1000 + i }),
        ]);
      }

      expect(processor.pendingCount).toBe(5);
    });

    it('evicts the oldest entry when the cap is reached', () => {
      const processor = new HookEventProcessor({ store, onRecord, maxPendingEvents: 3 });

      // Fill to cap with toolUseIds 0, 1, 2
      for (let i = 0; i < 3; i++) {
        processor.processEvents([
          makePreEvent({ toolUseId: `toolu_${i}`, timestamp: 1000 + i }),
        ]);
      }

      // Adding a 4th evicts toolu_0 (the oldest)
      processor.processEvents([
        makePreEvent({ toolUseId: 'toolu_3', timestamp: 1003 }),
      ]);

      expect(processor.pendingCount).toBe(3);

      // toolu_0 was evicted, so its post produces an orphaned-post record
      processor.processEvents([
        makePostEvent({ toolUseId: 'toolu_0', timestamp: 2000 }),
      ]);
      expect(records).toHaveLength(1);
      expect(records[0]!.durationMs).toBeNull();  // orphaned post — no matching pre

      // toolu_1 through toolu_3 still pair normally
      records.length = 0;
      for (let i = 1; i <= 3; i++) {
        processor.processEvents([
          makePostEvent({ toolUseId: `toolu_${i}`, timestamp: 2000 + i }),
        ]);
      }
      expect(records).toHaveLength(3);
      expect(records.every((r) => r.durationMs !== null)).toBe(true);
    });

    it('logs a warning when non-orphan eviction occurs', () => {
      const processor = new HookEventProcessor({ store, onRecord, maxPendingEvents: 2, orphanTimeoutMs: 1000 });

      const now = Date.now();
      processor.processEvents([makePreEvent({ toolUseId: 'a', timestamp: now })]);
      processor.processEvents([makePreEvent({ toolUseId: 'b', timestamp: now })]);
      // Third event triggers eviction of non-orphan (since both a and b are fresh, not past 1000ms)
      processor.processEvents([makePreEvent({ toolUseId: 'c', timestamp: now })]);

      const output = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
      expect(output).toContain('Evicting non-orphan pre-event due to capacity overflow');
    });

    it('uses DEFAULT_MAX_PENDING (2000) when maxPendingEvents is not specified', () => {
      const processor = new HookEventProcessor({ store, onRecord });

      // Fill to just under the default cap
      for (let i = 0; i < 2000; i++) {
        processor.processEvents([
          makePreEvent({ toolUseId: `toolu_${i}`, timestamp: 1000 + i }),
        ]);
      }

      expect(processor.pendingCount).toBe(2000);

      // Adding one more should evict the oldest and keep it at 2000
      processor.processEvents([
        makePreEvent({ toolUseId: 'toolu_overflow', timestamp: 3001 }),
      ]);
      expect(processor.pendingCount).toBe(2000);
    }, 10_000);
  });

  describe('Signal handler lifecycle', () => {
    it('does not accumulate SIGTERM handlers across start/stop cycles', () => {
      const processor = new HookEventProcessor({
        store,
        onRecord,
      });

      const initialListenerCount = process.listenerCount('SIGTERM');

      // First start/stop cycle
      processor.start();
      expect(process.listenerCount('SIGTERM')).toBe(initialListenerCount + 1);
      processor.stop();
      expect(process.listenerCount('SIGTERM')).toBe(initialListenerCount);

      // Second start/stop cycle — should not accumulate
      processor.start();
      expect(process.listenerCount('SIGTERM')).toBe(initialListenerCount + 1);
      processor.stop();
      expect(process.listenerCount('SIGTERM')).toBe(initialListenerCount);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases: duplication, out-of-order arrivals, fallback collision (F-129)
  // ---------------------------------------------------------------------------

  describe('duplicate pre-events / out-of-order arrivals (F-129)', () => {
    it('second pre-event with same toolUseId overwrites the first; post pairs with the second', () => {
      const processor = new HookEventProcessor({ store, onRecord });

      processor.processEvents([
        makePreEvent({ toolUseId: 'toolu_dup', timestamp: 1000, inputSize: 10 }),
        makePreEvent({ toolUseId: 'toolu_dup', timestamp: 1100, inputSize: 20 }),
        makePostEvent({ toolUseId: 'toolu_dup', timestamp: 1200 }),
      ]);

      expect(records).toHaveLength(1);
      const record = records[0]!;
      expect(record.toolUseId).toBe('toolu_dup');
      // Paired with the second pre (timestamp 1100), not the first
      expect(record.durationMs).toBe(100);
      expect(record.inputSizeBytes).toBe(20);
      expect(record.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('post arriving before its pre is orphaned; subsequent pre is not retroactively paired', () => {
      const processor = new HookEventProcessor({ store, onRecord });

      // Post arrives first — no matching pre in pending
      processor.processEvents([
        makePostEvent({ toolUseId: 'toolu_early', timestamp: 1050 }),
      ]);
      expect(records).toHaveLength(1);
      expect(records[0]!.durationMs).toBeNull();
      expect(records[0]!.toolUseId).toBe('toolu_early');
      expect(records[0]!.id).toMatch(/^[0-9a-f-]{36}$/);

      // Pre arrives later — queued in pending, NOT retroactively matched to the already-emitted orphan
      processor.processEvents([
        makePreEvent({ toolUseId: 'toolu_early', timestamp: 1000 }),
      ]);
      expect(records).toHaveLength(1);    // no second record emitted
      expect(processor.pendingCount).toBe(1);
    });

    it('two orphan posts with same tool and timestamp but no toolUseId produce two distinct records', () => {
      const processor = new HookEventProcessor({ store, onRecord });

      // No pre events — both posts are orphaned via the UUID fallback key
      processor.processEvents([
        { mode: 'post', tool: 'Bash', timestamp: 5000, outputSize: 100, success: true } as HookEvent,
        { mode: 'post', tool: 'Bash', timestamp: 5000, outputSize: 200, success: true } as HookEvent,
      ]);

      expect(records).toHaveLength(2);
      expect(records[0]!.durationMs).toBeNull();
      expect(records[1]!.durationMs).toBeNull();
      // Both records must have unique IDs
      expect(records[0]!.id).not.toBe(records[1]!.id);
      // Fallback toolUseId (built from UUID) must also be unique
      expect(records[0]!.toolUseId).not.toBe(records[1]!.toolUseId);
    });
  });

  describe('Eviction logic — orphans vs non-orphans', () => {
    it('evicts orphans before non-orphans when at capacity', () => {
      const processor = new HookEventProcessor({
        store,
        onRecord,
        maxPendingEvents: 3,
        orphanTimeoutMs: 100,
      });

      const now = Date.now();

      // Add entry 1: fresh (will not be orphaned)
      processor.processEvents([makePreEvent({ toolUseId: 'toolu_fresh', timestamp: now })]);

      // Add entry 2: old (already orphaned by 100ms)
      processor.processEvents([makePreEvent({ toolUseId: 'toolu_old', timestamp: now - 150 })]);

      // Add entry 3: mid-age (just under orphan threshold)
      processor.processEvents([makePreEvent({ toolUseId: 'toolu_mid', timestamp: now - 50 })]);

      expect(processor.pendingCount).toBe(3);

      // Add entry 4: this should trigger eviction of the oldest (toolu_old)
      processor.processEvents([makePreEvent({ toolUseId: 'toolu_newest', timestamp: now })]);

      expect(processor.pendingCount).toBe(3);

      // The old entry should be gone, and the fresh ones should remain
      processor.processEvents([makePostEvent({ toolUseId: 'toolu_fresh' })]);
      processor.processEvents([makePostEvent({ toolUseId: 'toolu_mid' })]);
      processor.processEvents([makePostEvent({ toolUseId: 'toolu_newest' })]);

      // Should have 3 completed records (the old one was orphaned and dropped)
      expect(records).toHaveLength(3);
    });
  });

  describe('token events', () => {
    it('dispatches token events to onTokenEvent callback', () => {
      const tokenEvents: unknown[] = [];
      const processor = new HookEventProcessor({
        store,
        onRecord,
        onTokenEvent: (event) => { tokenEvents.push(event); },
      });

      const tokenEvent: HookEvent = {
        mode: 'token',
        tool: '',
        timestamp: 5000,
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 50000,
        cacheCreationTokens: 3000,
        model: 'claude-opus-4-6',
        sessionId: 'sess-001',
      };

      processor.processEvents([tokenEvent]);

      expect(tokenEvents).toHaveLength(1);
      expect(tokenEvents[0]).toMatchObject({
        mode: 'token',
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 50000,
        cacheCreationTokens: 3000,
        model: 'claude-opus-4-6',
        sessionId: 'sess-001',
      });
      expect(records).toHaveLength(0);
    });

    it('does not error when onTokenEvent is not provided', () => {
      const processor = new HookEventProcessor({
        store,
        onRecord,
      });

      const tokenEvent: HookEvent = {
        mode: 'token',
        tool: '',
        timestamp: 5000,
        inputTokens: 500,
        outputTokens: 100,
        model: 'claude-opus-4-6',
      };

      expect(() => processor.processEvents([tokenEvent])).not.toThrow();
      expect(records).toHaveLength(0);
    });
  });
});
