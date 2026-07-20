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
import { createDefaultRegistry } from '../platforms/index.js';
import type { PlatformAdapter } from '../platforms/types.js';
import type { LocalStore } from '../storage/local-store.js';
import type {
  HookEvent,
  PreHookEvent,
  PostHookEvent,
  TokenHookEvent,
  SubagentTokenHookEvent,
  ObservabilityHealthHookEvent,
  ToolCallRecord,
  TokenEvent,
  SubagentTokenEvent,
  WorkflowRunEvent,
} from '../storage/types.js';
import { parseToolSpecificFields } from './tool-parsers.js';

const logger = createLogger('event-processor');

/**
 * Maps a raw platform tool name via the adapter, falling back to the raw
 * name when the adapter can't recognize it (i.e. returns the literal string
 * `'Unknown'`). Without this fallback, every unmapped tool would collapse
 * into the same `'Unknown'` bucket — losing the original name in telemetry
 * and letting distinct unmapped tools collide on the same pairing key.
 */
function mapToolNameOrOriginal(adapter: PlatformAdapter, rawToolName: string): string {
  const mapped = adapter.mapToolName(rawToolName);
  return mapped === 'Unknown' ? rawToolName : mapped;
}

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
  /**
   * Fires for every paired ToolCallRecord whose `toolName === 'Agent'` —
   * feeds WorkflowRunTracker without altering the existing onRecord pipeline.
   * Invoked AFTER onRecord; errors are logged and swallowed.
   */
  onWorkflowAgent?: (record: ToolCallRecord) => void;
  /** Fires for every `mode: 'subagent_token'` line; errors swallowed. */
  onSubagentTurn?: (turn: SubagentTurnEvent) => void;
  /** Fires for every `mode: 'observability_health'` line; errors swallowed. */
  onObservabilityHealth?: (event: ObservabilityHealthFrame) => void;
  /** Fires for every `mode: 'subagent_token'` line as the typed wire shape. */
  onSubagentToken?: (event: SubagentTokenEvent) => void;
  /** Fires for every `mode: 'workflow_run'` line; errors swallowed. */
  onWorkflowRun?: (event: WorkflowRunEvent) => void;
  /**
   * Adapter used to map each platform's raw tool names (e.g. Kiro's `fs_read`)
   * to Preflight's canonical vocabulary (`Read`) before pairing/emitting.
   * Defaults to the process's auto-detected platform (env-var based via
   * `createDefaultRegistry().getActive()`), which resolves to `GenericMcpAdapter`
   * (identity mapping) when no platform-specific env vars are present.
   */
  platformAdapter?: PlatformAdapter;
}

/**
 * Flattened processor-internal shape extracted from a `mode: 'subagent_token'`
 * buffer entry, with all-numeric defaults applied. This is DISTINCT from the
 * storage `SubagentTokenEvent` wire shape (imported above): token counts are
 * hoisted to top-level fields here (rather than nested under `usage`), and it
 * carries extra processor-derived fields (`turnUuid`, `stopReason`,
 * `schemaFingerprint`). Not a duplicate of `SubagentTokenEvent`.
 */
export interface SubagentTurnEvent {
  readonly timestampMs: number;
  readonly parentSessionId: string;
  readonly agentId: string;
  readonly workflowRunId: string | null;
  readonly messageId: string;
  readonly turnUuid: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly reasoningTokens: number;
  readonly stopReason: string | null;
  readonly schemaFingerprint: string;
}

/** Wire-shape data extracted from a `mode: 'observability_health'` entry. */
export interface ObservabilityHealthFrame {
  readonly timestamp: number;
  readonly watcher: 'workflow' | 'subagent';
  readonly filesWatched: number;
  readonly linesRead: number;
  readonly bytesRead: number;
  readonly parseErrors: number;
  readonly schemaDrifts: number;
  readonly lastError: { code: string; class: string } | null;
  readonly event?: string;
  readonly dimension?: string;
  readonly fingerprint?: string;
  readonly workflowRunId?: string;
  readonly costSelfCheckDeltaPct?: number;
}

function numAttr(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
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
  private readonly onWorkflowAgent: ((record: ToolCallRecord) => void) | null;
  private readonly onSubagentTurn: ((turn: SubagentTurnEvent) => void) | null;
  private readonly onObservabilityHealth: ((event: ObservabilityHealthFrame) => void) | null;
  private readonly onSubagentToken: ((event: SubagentTokenEvent) => void) | null;
  private readonly onWorkflowRun: ((event: WorkflowRunEvent) => void) | null;
  private readonly platformAdapter: PlatformAdapter;
  /**
   * Dedup ring of `(agentId, messageId)` for recent subagent turns. Cursor
   * recovery may re-read a line after a crash mid-write; double-counting would
   * be silent, so we drop on the seen-set (capped at 4096 to bound memory).
   */
  private readonly subagentDedup = new Set<string>();
  private readonly subagentDedupOrder: string[] = [];
  /**
   * Dedup ring of `(workflowRunId, timestamp)` for recent workflow_run
   * events, mirroring subagentDedup above. This path only matters for
   * `--local` mode's buffer.jsonl route — `--stdio` mode's WorkflowWatcher
   * calls ingestScriptWorkflowRun() directly in-process, bypassing the
   * buffer/crash-recovery path entirely. The `.drain` file crash-recovery
   * path can re-deliver the same buffered line after a crash mid-write;
   * without this, that redelivery emits a duplicate AiWorkflowRun event
   * (doubling cost/token metrics for that run) since a new poll cycle's
   * legitimate re-emission for the SAME run uses a different timestamp.
   */
  private readonly workflowRunDedup = new Set<string>();
  private readonly workflowRunDedupOrder: string[] = [];

  private readonly pending: Map<string, PreHookEvent> = new Map();
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
    this.onWorkflowAgent = options.onWorkflowAgent ?? null;
    this.onSubagentTurn = options.onSubagentTurn ?? null;
    this.onObservabilityHealth = options.onObservabilityHealth ?? null;
    this.onSubagentToken = options.onSubagentToken ?? null;
    this.onWorkflowRun = options.onWorkflowRun ?? null;
    this.platformAdapter = options.platformAdapter ?? createDefaultRegistry().getActive();

    this.boundBeforeExit = () => {
      this.stop();
    };
    this.boundSigterm = () => {
      this.stop();
    };
  }

  /**
   * The platform name resolved for this process — either the explicitly
   * injected `platformAdapter`, or the auto-detected default. Resolved
   * once at construction time; this getter never re-detects.
   */
  get activePlatform(): string {
    return this.platformAdapter.platformName;
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
    for (const rawEvent of events) {
      const event: HookEvent =
        rawEvent.mode === 'pre' || rawEvent.mode === 'post'
          ? { ...rawEvent, tool: mapToolNameOrOriginal(this.platformAdapter, rawEvent.tool) }
          : rawEvent;
      try {
        if (event.mode === 'token') {
          this.handleTokenEvent(event);
        } else if (event.mode === 'pre') {
          this.handlePreEvent(event);
        } else if (event.mode === 'post') {
          this.handlePostEvent(event);
        } else if (event.mode === 'subagent_token') {
          this.handleSubagentTokenEvent(event);
        } else if (event.mode === 'observability_health') {
          this.handleObservabilityHealthEvent(event);
        } else if (event.mode === 'workflow_run') {
          this.handleWorkflowRunEvent(event);
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

  private handlePreEvent(event: PreHookEvent): void {
    if (this.pending.size >= this.maxPendingEvents) {
      // Prefer evicting events that are already past the orphan timeout
      const now = Date.now();
      // Named to avoid shared/redact.ts's SECRET_KEY_RE (which matches any key
      // name containing "key") — that would silently blank this diagnostic value.
      let evictedPairingId: string | undefined;
      for (const [key, pendingEvent] of this.pending) {
        if (now - pendingEvent.timestamp >= this.orphanTimeoutMs) {
          evictedPairingId = key;
          break;
        }
      }
      if (evictedPairingId === undefined) {
        evictedPairingId = this.pending.keys().next().value as string | undefined;
        logger.warn('Evicting non-orphan pre-event due to capacity overflow', {
          evictedPairingId,
        });
      }
      if (evictedPairingId) {
        const evicted = this.pending.get(evictedPairingId)!;
        this.pending.delete(evictedPairingId);
        // Emit a synthetic timeout record so the eviction is visible in metrics,
        // matching the behavior of sweepOrphans() and flushPending().
        const toolFields = parseToolSpecificFields(evicted.tool, evicted.toolInput, undefined);
        this.emitRecord({
          id: randomUUID(),
          sessionId: evicted.sessionId ?? null,
          toolName: evicted.tool,
          toolUseId: evicted.toolUseId ?? evictedPairingId,
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

  private handlePostEvent(event: PostHookEvent): void {
    const toolUseId = event.toolUseId;
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
        sessionId: preEvent.sessionId ?? event.sessionId ?? null,
        toolName: preEvent.tool,
        toolUseId: preEvent.toolUseId ?? key,
        timestamp: preEvent.timestamp,
        durationMs: Math.max(0, event.timestamp - preEvent.timestamp),
        success: event.success ?? true,
        ...(event.error !== undefined && { error: event.error }),
        ...(preEvent.inputSize !== undefined && { inputSizeBytes: preEvent.inputSize }),
        ...(event.outputSize !== undefined && { outputSizeBytes: event.outputSize }),
        ...(preEvent.inputHash !== undefined && { inputHash: preEvent.inputHash }),
        ...(preEvent.cwd !== undefined && { cwd: preEvent.cwd }),
        ...(preEvent.transcriptPath !== undefined && {
          transcriptPath: preEvent.transcriptPath,
        }),
        ...(preEvent.permissionMode !== undefined && {
          permissionMode: preEvent.permissionMode,
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
        sessionId: event.sessionId ?? null,
        toolName: event.tool,
        toolUseId: event.toolUseId ?? key,
        timestamp: event.timestamp,
        durationMs: null,
        success: event.success ?? true,
        ...(event.error !== undefined && { error: event.error }),
        ...(event.outputSize !== undefined && { outputSizeBytes: event.outputSize }),
        ...toolFields,
      };
      this.emitRecord(record);
    }
  }

  private handleTokenEvent(event: TokenHookEvent): void {
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
      model: event.model ?? 'unknown',
      sessionId: event.sessionId,
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
        sessionId: event.sessionId ?? null,
        toolName: event.tool,
        toolUseId: event.toolUseId ?? key,
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
        sessionId: event.sessionId ?? null,
        toolName: event.tool,
        toolUseId: event.toolUseId ?? key,
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

  private pairingKey(event: PreHookEvent): string {
    const toolUseId = event.toolUseId;
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

  private handleSubagentTokenEvent(event: SubagentTokenHookEvent): void {
    if (!this.onSubagentTurn && !this.onSubagentToken) return;
    const agentId = event.agentId ?? '';
    const messageId = event.messageId ?? '';
    if (!agentId || !messageId) return;
    const dedupKey = `${agentId}|${messageId}`;
    if (this.subagentDedup.has(dedupKey)) return;
    this.subagentDedup.add(dedupKey);
    this.subagentDedupOrder.push(dedupKey);
    if (this.subagentDedupOrder.length > 4096) {
      const evicted = this.subagentDedupOrder.shift();
      if (evicted) this.subagentDedup.delete(evicted);
    }

    const turn: SubagentTurnEvent = {
      timestampMs:
        typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)
          ? event.timestamp
          : Date.now(),
      parentSessionId: event.sessionId ?? '',
      agentId,
      workflowRunId: event.workflowRunId ?? null,
      messageId,
      turnUuid: event.turnUuid ?? '',
      model: event.model ?? 'unknown',
      inputTokens: numAttr(event.inputTokens),
      outputTokens: numAttr(event.outputTokens),
      cacheReadTokens: numAttr(event.cacheReadTokens),
      cacheCreationTokens: numAttr(event.cacheCreationTokens),
      reasoningTokens: numAttr(event.reasoningTokens),
      stopReason: event.stopReason ?? null,
      schemaFingerprint: event.schemaFingerprint ?? '',
    };
    if (this.onSubagentTurn) {
      try {
        this.onSubagentTurn(turn);
      } catch (err) {
        logger.warn('onSubagentTurn callback failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (this.onSubagentToken) {
      const tokenEvent: SubagentTokenEvent = {
        mode: 'subagent_token',
        timestamp: turn.timestampMs,
        agentId: turn.agentId,
        workflowRunId: turn.workflowRunId,
        messageId: turn.messageId,
        model: turn.model,
        usage: {
          inputTokens: turn.inputTokens,
          outputTokens: turn.outputTokens,
          cacheCreationTokens: turn.cacheCreationTokens,
          cacheReadTokens: turn.cacheReadTokens,
          reasoningTokens: turn.reasoningTokens,
        },
        parentSessionId: turn.parentSessionId,
      };
      try {
        this.onSubagentToken(tokenEvent);
      } catch (err) {
        logger.warn('onSubagentToken callback failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private handleWorkflowRunEvent(event: WorkflowRunEvent): void {
    if (!this.onWorkflowRun) return;
    const dedupKey = `${event.workflowRunId}|${event.timestamp}`;
    if (this.workflowRunDedup.has(dedupKey)) return;
    this.workflowRunDedup.add(dedupKey);
    this.workflowRunDedupOrder.push(dedupKey);
    if (this.workflowRunDedupOrder.length > 4096) {
      const evicted = this.workflowRunDedupOrder.shift();
      if (evicted) this.workflowRunDedup.delete(evicted);
    }
    try {
      this.onWorkflowRun(event);
    } catch (err) {
      logger.warn('onWorkflowRun callback failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private handleObservabilityHealthEvent(event: ObservabilityHealthHookEvent): void {
    if (!this.onObservabilityHealth) return;
    const frame: ObservabilityHealthFrame = {
      timestamp:
        typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)
          ? event.timestamp
          : Date.now(),
      watcher: event.watcher ?? 'subagent',
      filesWatched: numAttr(event.filesWatched),
      linesRead: numAttr(event.linesRead),
      bytesRead: numAttr(event.bytesRead),
      parseErrors: numAttr(event.parseErrors),
      schemaDrifts: numAttr(event.schemaDrifts),
      lastError: event.lastError && typeof event.lastError === 'object' ? event.lastError : null,
      ...(typeof event.event === 'string' ? { event: event.event } : {}),
      ...(typeof event.dimension === 'string' ? { dimension: event.dimension } : {}),
      ...(typeof event.fingerprint === 'string' ? { fingerprint: event.fingerprint } : {}),
      ...(typeof event.workflowRunId === 'string' ? { workflowRunId: event.workflowRunId } : {}),
      ...(typeof event.costSelfCheckDeltaPct === 'number'
        ? { costSelfCheckDeltaPct: event.costSelfCheckDeltaPct }
        : {}),
    };
    try {
      this.onObservabilityHealth(frame);
    } catch (err) {
      logger.warn('onObservabilityHealth callback failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
    // Workflow observability — additively notify any registered tracker when
    // an Agent tool call completes. Failures here MUST NOT propagate.
    if (this.onWorkflowAgent !== null && record.toolName === 'Agent') {
      try {
        this.onWorkflowAgent(record);
      } catch (err) {
        logger.warn('onWorkflowAgent callback failed', {
          recordId: record.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
