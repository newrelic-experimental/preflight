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
import type { HookEvent, ToolCallRecord, TokenEvent } from '../storage/types.js';
import { parseToolSpecificFields } from './tool-parsers.js';

const logger = createLogger('event-processor');

export interface HookEventProcessorOptions {
  store: LocalStore;
  pollIntervalMs?: number;
  orphanTimeoutMs?: number;
  /** Maximum pre-events held in memory awaiting a post. Defaults to 2000. */
  maxPendingEvents?: number;
  /**
   * When true, each poll cycle drains every per-session buffer file
   * (`buffer-*.jsonl`) via `LocalStore.drainAllBuffers()` instead of the
   * single per-session file. Used by `--local` mode where the dashboard
   * owns no specific Claude Code session and must surface events from every
   * live session.
   */
  drainAllSessions?: boolean;
  onRecord: (record: ToolCallRecord) => void;
  onTokenEvent?: (event: TokenEvent) => void;
}

const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_ORPHAN_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_PENDING = 2_000;

export class HookEventProcessor {
  private store: LocalStore;
  private readonly pollIntervalMs: number;
  private readonly orphanTimeoutMs: number;
  private drainAllSessions: boolean;
  private readonly onRecord: (record: ToolCallRecord) => void;
  private readonly onTokenEvent: ((event: TokenEvent) => void) | null;

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
    this.drainAllSessions = options.drainAllSessions ?? false;
    this.maxPendingEvents = options.maxPendingEvents ?? DEFAULT_MAX_PENDING;
    this.onRecord = options.onRecord;
    this.onTokenEvent = options.onTokenEvent ?? null;

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
        const events = this.drainOnce();
        if (events.length > 0) {
          this.processEvents(events);
        }
      } catch {
        logger.warn('Failed to drain buffer during shutdown');
      }

      logger.info('Event processor stopped');
    }

    // Always flush remaining pre-events as orphans — even on a second stop() call
    // or when stop() is called without start(). A second call on an already-empty
    // pending map is a no-op.
    this.flushPending();
  }

  /**
   * Hot-swap the underlying LocalStore and session-drain mode without
   * recreating the processor or its callbacks. Used when the provisional
   * unscoped store is replaced by the real session-scoped store once the
   * Claude Code session ID is resolved asynchronously.
   */
  replaceStore(newStore: LocalStore, drainAllSessions: boolean): void {
    this.stop();
    this.store = newStore;
    this.drainAllSessions = drainAllSessions;
    this.start();
  }

  /**
   * Process a batch of hook events, pairing pre/post by toolUseId.
   * Exported for direct testing — in production, called by poll().
   */
  processEvents(events: HookEvent[]): void {
    for (const event of events) {
      try {
        if (event.mode === 'token') {
          this.handleTokenEvent(event);
        } else if (event.mode === 'pre') {
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
      const events = this.drainOnce();
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

  private drainOnce(): HookEvent[] {
    return this.drainAllSessions ? this.store.drainAllBuffers() : this.store.drainBuffer();
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
        evictedKey = this.pending.keys().next().value as string | undefined;
        logger.warn('Evicting non-orphan pre-event due to capacity overflow', { evictedKey });
      }
      if (evictedKey) {
        const evicted = this.pending.get(evictedKey)!;
        this.pending.delete(evictedKey);
        // Emit a synthetic timeout record so the eviction is visible in metrics,
        // matching the behavior of sweepOrphans() and flushPending().
        const toolFields = parseToolSpecificFields(evicted.tool, evicted.toolInput, undefined);
        this.emitRecord({
          id: randomUUID(),
          sessionId: (evicted.sessionId as string) ?? null,
          toolName: evicted.tool,
          toolUseId: (evicted.toolUseId as string) ?? evictedKey,
          timestamp: evicted.timestamp,
          durationMs: null,
          success: false,
          errorType: 'timeout',
          ...(evicted.inputSize !== undefined && { inputSizeBytes: evicted.inputSize }),
          ...(evicted.inputHash !== undefined && { inputHash: evicted.inputHash }),
          ...toolFields,
        });
      }
    }
    this.pending.set(this.pairingKey(event), event);
  }

  private handlePostEvent(event: HookEvent): void {
    const toolUseId = event.toolUseId as string | undefined;
    // When toolUseId is present use it directly; otherwise find the oldest pending
    // pre-event with the same tool name (FIFO) so parallel same-tool calls don't
    // collide — the counter in pairingKey() gives each pre-event a unique key.
    const key =
      toolUseId ??
      this.findOldestPendingKey(event.tool) ??
      `${event.tool}:${event.timestamp}:${randomUUID()}`;
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
        ...(preEvent.cwd !== undefined && { cwd: preEvent.cwd as string }),
        ...(preEvent.permissionMode !== undefined && {
          permissionMode: preEvent.permissionMode as string,
        }),
        ...toolFields,
      };
      this.emitRecord(record);
    } else {
      // Orphaned post — no matching pre; use post-event's toolInput if present
      logger.debug('Orphaned post event — no matching pre', { tool: event.tool, key });
      const toolFields = parseToolSpecificFields(event.tool, event.toolInput, event.toolOutput);
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

  private handleTokenEvent(event: HookEvent): void {
    if (!this.onTokenEvent) return;
    const tokenEvent: TokenEvent = {
      mode: 'token',
      timestamp: event.timestamp,
      inputTokens:
        typeof event.inputTokens === 'number' && !isNaN(event.inputTokens) ? event.inputTokens : 0,
      outputTokens:
        typeof event.outputTokens === 'number' && !isNaN(event.outputTokens)
          ? event.outputTokens
          : 0,
      cacheReadTokens:
        typeof event.cacheReadTokens === 'number' && !isNaN(event.cacheReadTokens)
          ? event.cacheReadTokens
          : 0,
      cacheCreationTokens:
        typeof event.cacheCreationTokens === 'number' && !isNaN(event.cacheCreationTokens)
          ? event.cacheCreationTokens
          : 0,
      model: (event.model as string) ?? 'unknown',
      sessionId: event.sessionId as string | undefined,
    };
    try {
      this.onTokenEvent(tokenEvent);
    } catch (err) {
      logger.warn('onTokenEvent callback failed', {
        error: err instanceof Error ? err.message : String(err),
      });
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
      // Only match fallback-keyed entries (format: "Tool:timestamp:uuid") — skip
      // entries keyed by their real toolUseId so a no-toolUseId post event doesn't
      // steal a slot that belongs to a later post event that carries that toolUseId.
      const isFallbackKey = k.startsWith(`${v.tool}:`);
      if (
        v.tool.toLowerCase() === tool.toLowerCase() &&
        isFallbackKey &&
        v.timestamp < oldestTimestamp
      ) {
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
