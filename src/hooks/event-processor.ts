/**
 * Hook Event Processor — pairs raw pre/post HookEvents into ToolCallRecords.
 *
 * Polls the JSONL buffer via LocalStore.drainBuffer(), matches PreToolUse
 * events with their corresponding PostToolUse/PostToolUseFailure by toolUseId,
 * computes duration, and emits completed ToolCallRecords via a callback.
 *
 * Handles orphans:
 *   - Pre events without a post within orphanTimeoutMs → timeout record
 *   - Post events without a matching pre → record with durationMs: null
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '../shared/index.js';
import type { LocalStore } from '../storage/local-store.js';
import type { HookEvent, ToolCallRecord } from '../storage/types.js';
import { parseToolSpecificFields } from './tool-parsers.js';

const logger = createLogger('event-processor');

export interface HookEventProcessorOptions {
  store: LocalStore;
  pollIntervalMs?: number;
  orphanTimeoutMs?: number;
  /** Maximum pre-events held in memory awaiting a post. Defaults to 2000. */
  maxPendingEvents?: number;
  onRecord: (record: ToolCallRecord) => void;
}

const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_ORPHAN_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_PENDING = 2_000;

export class HookEventProcessor {
  private readonly store: LocalStore;
  private readonly pollIntervalMs: number;
  private readonly orphanTimeoutMs: number;
  private readonly onRecord: (record: ToolCallRecord) => void;

  private readonly pending: Map<string, HookEvent> = new Map();
  private readonly maxPendingEvents: number;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;

  private readonly boundBeforeExit: () => void;
  private readonly boundSigterm: () => void;

  constructor(options: HookEventProcessorOptions) {
    this.store = options.store;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.orphanTimeoutMs = options.orphanTimeoutMs ?? DEFAULT_ORPHAN_TIMEOUT_MS;
    this.maxPendingEvents = options.maxPendingEvents ?? DEFAULT_MAX_PENDING;
    this.onRecord = options.onRecord;

    this.boundBeforeExit = () => {
      this.stop();
    };
    this.boundSigterm = () => {
      this.stop();
    };
  }

  start(): void {
    if (this.running) {
      logger.warn('HookEventProcessor already running');
      return;
    }

    this.running = true;

    this.intervalId = setInterval(() => {
      this.poll();
    }, this.pollIntervalMs);
    this.intervalId.unref();

    process.once('beforeExit', this.boundBeforeExit);
    process.once('SIGTERM', this.boundSigterm);

    logger.info('Event processor started', {
      pollIntervalMs: this.pollIntervalMs,
      orphanTimeoutMs: this.orphanTimeoutMs,
    });
  }

  stop(): void {
    if (this.running) {
      this.running = false;

      if (this.intervalId !== null) {
        clearInterval(this.intervalId);
        this.intervalId = null;
      }

      process.removeListener('beforeExit', this.boundBeforeExit);
      process.removeListener('SIGTERM', this.boundSigterm);

      // Final drain
      try {
        const events = this.store.drainBuffer();
        if (events.length > 0) {
          this.processEvents(events);
        }
      } catch {
        logger.warn('Failed to drain buffer during shutdown');
      }

      logger.info('Event processor stopped');
    }

    // Always flush pending — even if processEvents() was called without start()
    this.flushPending();
  }

  /**
   * Process a batch of hook events, pairing pre/post by toolUseId.
   * Exported for direct testing — in production, called by poll().
   */
  processEvents(events: HookEvent[]): void {
    for (const event of events) {
      try {
        if (event.mode === 'pre') {
          this.handlePreEvent(event);
        } else if (event.mode === 'post') {
          this.handlePostEvent(event);
        }
      } catch (err) {
        logger.warn('Error processing hook event', {
          tool: event.tool,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** Number of pre events awaiting a matching post. */
  get pendingCount(): number {
    return this.pending.size;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private poll(): void {
    try {
      const events = this.store.drainBuffer();
      if (events.length > 0) {
        this.processEvents(events);
      }
      this.sweepOrphans();
    } catch (err) {
      logger.warn('Poll cycle failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private handlePreEvent(event: HookEvent): void {
    if (this.pending.size >= this.maxPendingEvents) {
      // Prefer evicting events that are already past the orphan timeout
      const now = Date.now();
      let evictedKey: string | undefined;
      for (const [key, pendingEvent] of this.pending) {
        if (now - pendingEvent.timestamp >= this.orphanTimeoutMs) {
          evictedKey = key;
          break;
        }
      }
      if (evictedKey === undefined) {
        evictedKey = this.pending.keys().next().value as string;
        logger.warn('Evicting non-orphan pre-event due to capacity overflow', { evictedKey });
      }
      if (evictedKey) {
        this.pending.delete(evictedKey);
      }
    }
    this.pending.set(this.pairingKey(event), event);
  }

  private handlePostEvent(event: HookEvent): void {
    const toolUseId = event.toolUseId as string | undefined;
    // When toolUseId is present use it directly; otherwise find the oldest pending
    // pre-event with the same tool name (FIFO) so parallel same-tool calls don't
    // collide — the counter in pairingKey() gives each pre-event a unique key.
    const key = toolUseId ?? this.findOldestPendingKey(event.tool) ?? `${event.tool}:${event.timestamp}:${randomUUID()}`;
    const preEvent = this.pending.get(key);
    this.pending.delete(key);

    if (preEvent) {
      // Matched pair
      const toolFields = parseToolSpecificFields(
        preEvent.tool,
        preEvent.toolInput,
        event.toolOutput,
      );
      const record: ToolCallRecord = {
        id: randomUUID(),
        sessionId: (preEvent.sessionId as string) ?? (event.sessionId as string) ?? null,
        toolName: preEvent.tool,
        toolUseId: (preEvent.toolUseId as string) ?? key,
        timestamp: preEvent.timestamp,
        durationMs: Math.max(0, event.timestamp - preEvent.timestamp),
        success: event.success ?? true,
        ...(event.error !== undefined && { error: event.error as string }),
        ...(preEvent.inputSize !== undefined && { inputSizeBytes: preEvent.inputSize }),
        ...(event.outputSize !== undefined && { outputSizeBytes: event.outputSize }),
        ...(preEvent.inputHash !== undefined && { inputHash: preEvent.inputHash }),
        ...toolFields,
      };
      this.emitRecord(record);
    } else {
      // Orphaned post — no matching pre; use post-event's toolInput if present
      logger.debug('Orphaned post event — no matching pre', { tool: event.tool, key });
      const toolFields = parseToolSpecificFields(
        event.tool,
        event.toolInput,
        event.toolOutput,
      );
      const record: ToolCallRecord = {
        id: randomUUID(),
        sessionId: (event.sessionId as string) ?? null,
        toolName: event.tool,
        toolUseId: (event.toolUseId as string) ?? key,
        timestamp: event.timestamp,
        durationMs: null,
        success: event.success ?? true,
        ...(event.error !== undefined && { error: event.error as string }),
        ...(event.outputSize !== undefined && { outputSizeBytes: event.outputSize }),
        ...toolFields,
      };
      this.emitRecord(record);
    }
  }

  private sweepOrphans(): void {
    const now = Date.now();
    const expired: string[] = [];

    for (const [key, event] of this.pending) {
      if (now - event.timestamp >= this.orphanTimeoutMs) {
        expired.push(key);
      }
    }

    for (const key of expired) {
      const event = this.pending.get(key)!;
      this.pending.delete(key);

      const toolFields = parseToolSpecificFields(event.tool, event.toolInput, undefined);
      const record: ToolCallRecord = {
        id: randomUUID(),
        sessionId: (event.sessionId as string) ?? null,
        toolName: event.tool,
        toolUseId: (event.toolUseId as string) ?? key,
        timestamp: event.timestamp,
        durationMs: null,
        success: false,
        errorType: 'timeout',
        ...(event.inputSize !== undefined && { inputSizeBytes: event.inputSize }),
        ...(event.inputHash !== undefined && { inputHash: event.inputHash }),
        ...toolFields,
      };
      this.emitRecord(record);
    }
  }

  private flushPending(): void {
    for (const [key, event] of this.pending) {
      const toolFields = parseToolSpecificFields(event.tool, event.toolInput, undefined);
      const record: ToolCallRecord = {
        id: randomUUID(),
        sessionId: (event.sessionId as string) ?? null,
        toolName: event.tool,
        toolUseId: (event.toolUseId as string) ?? key,
        timestamp: event.timestamp,
        durationMs: null,
        success: false,
        errorType: 'timeout',
        ...(event.inputSize !== undefined && { inputSizeBytes: event.inputSize }),
        ...(event.inputHash !== undefined && { inputHash: event.inputHash }),
        ...toolFields,
      };
      this.emitRecord(record);
    }
    this.pending.clear();
  }

  private pairingKey(event: HookEvent): string {
    const toolUseId = event.toolUseId as string | undefined;
    if (toolUseId) return toolUseId;
    // Append UUID so parallel pre-events for the same tool at the same timestamp
    // each get a unique slot in this.pending instead of overwriting each other.
    return `${event.tool}:${event.timestamp}:${randomUUID()}`;
  }

  private findOldestPendingKey(tool: string): string | undefined {
    let oldestKey: string | undefined;
    let oldestTimestamp = Infinity;
    for (const [k, v] of this.pending) {
      if (v.tool === tool && v.timestamp < oldestTimestamp) {
        oldestKey = k;
        oldestTimestamp = v.timestamp;
      }
    }
    return oldestKey;
  }

  private emitRecord(record: ToolCallRecord): void {
    try {
      this.onRecord(record);
    } catch (err) {
      logger.warn('onRecord callback failed', {
        recordId: record.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
