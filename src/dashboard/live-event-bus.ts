import { EventEmitter } from 'node:events';

// Events that can be attributed to a single Claude Code session_id carry it
// explicitly so dashboard clients can subscribe with a `?sessionId=` filter
// and so the Today view can render a per-session pill on each anti-pattern row.
// `AlertEvent.sessionId` stays optional because some alerts (system-level)
// don't originate from a specific session. The `HeartbeatEvent` deliberately
// stays global — it's a connection keepalive, not a data event.
export interface ToolCallEvent {
  readonly id: string;
  readonly sessionId: string;
  readonly tool: string;
  readonly durationMs: number;
  readonly costUsd: number;
  readonly ts: number;
}

export interface CostUpdateEvent {
  readonly sessionId: string;
  readonly sessionTotalUsd: number;
  readonly todayTotalUsd: number;
  readonly forecastEodUsd: number | null;
}

export interface AntiPatternEvent {
  readonly sessionId: string;
  readonly type: string;
  readonly target: string;
  readonly count: number;
}

export interface HeartbeatEvent {
  readonly ts: number;
}

export interface AlertEvent {
  readonly id: string;
  readonly sessionId?: string;
  readonly state: 'firing' | 'cleared';
  readonly severity: 'info' | 'warning' | 'critical';
  readonly title: string;
  readonly description: string;
  readonly value: number;
  readonly threshold: number;
  readonly firedAt: number;
}

export interface ContextUpdateEvent {
  readonly sessionId: string;
  readonly turnNumber: number;
  readonly totalTokens: number;
  readonly fillPercent: number;
  /**
   * Per-model context window cap (tokens). Resolved from the model in the
   * Anthropic usage metadata (claude-opus-4-7 → 1_000_000, claude-haiku-4-5
   * → 200_000, etc.). Carried on the SSE payload so the client doesn't have
   * to cross-reference the 10s-polling /api/context snapshot — the SSE
   * event arrives with the freshly-resolved cap, while the API may still
   * have the stale 200K default. Single source of truth for "X / Y" UI.
   */
  readonly contextWindow: number;
  readonly breakdown: {
    readonly system: number;
    readonly tools: number;
    readonly user: number;
    readonly assistant: number;
  };
  readonly growth: {
    readonly startTokens: number;
    readonly currentTokens: number;
    readonly delta: number;
  };
  readonly topTools: ReadonlyArray<{ readonly tool: string; readonly estimatedTokens: number }>;
}

export type LiveEventMap = {
  'tool-call': ToolCallEvent;
  'cost-update': CostUpdateEvent;
  'anti-pattern': AntiPatternEvent;
  'context-update': ContextUpdateEvent;
  heartbeat: HeartbeatEvent;
  alert: AlertEvent;
};

export type LiveEventName = keyof LiveEventMap;

export interface ReplayEntry {
  readonly seq: number;
  readonly event: LiveEventName;
  readonly payload: LiveEventMap[LiveEventName];
}

export interface LiveEventBusOptions {
  readonly replayBufferSize?: number;
}

const DEFAULT_BUFFER_SIZE = 100;

export interface SeqEntry<E extends LiveEventName = LiveEventName> {
  readonly seq: number;
  readonly payload: LiveEventMap[E];
}

// Internal channel prefix used by onWithSeq/emit so the bus can deliver the
// global seq alongside the payload without breaking the plain on()/emit()
// API. Subscribers who don't need the seq use on(); the SSE handler uses
// onWithSeq() so its frame ids match the bus's replay buffer namespace.
const SEQ_PREFIX = '__seq__:';

export class LiveEventBus {
  private readonly emitter = new EventEmitter();
  private readonly buffer: ReplayEntry[] = [];
  private readonly bufferSize: number;
  // Start at 1 so a fresh client's Last-Event-ID: 0 (or no header) replays
  // every buffered event — replayFrom filters seq > lastSeq, so seq=0 means
  // "I have nothing yet." Overflow at Number.MAX_SAFE_INTEGER is theoretical
  // (~285k years at 1 event/ms); no wraparound logic enforced.
  private nextSeq = 1;

  constructor(opts: LiveEventBusOptions = {}) {
    this.bufferSize = opts.replayBufferSize ?? DEFAULT_BUFFER_SIZE;
    // Each SSE connection adds 4 listeners (tool-call, cost-update,
    // anti-pattern, alert). 200 ÷ 4 = 50 concurrent connections before
    // Node emits MaxListenersExceededWarning, which is comfortable
    // headroom for parallel test runs and bursty client reconnects.
    this.emitter.setMaxListeners(200);
  }

  on<E extends LiveEventName>(event: E, handler: (payload: LiveEventMap[E]) => void): void {
    this.emitter.on(event, handler as (...args: unknown[]) => void);
  }

  off<E extends LiveEventName>(event: E, handler: (payload: LiveEventMap[E]) => void): void {
    this.emitter.off(event, handler as (...args: unknown[]) => void);
  }

  // Subscribe with the bus's global sequence number alongside the payload.
  // The seq is the same value stored in the replay buffer, so SSE consumers
  // can use it for frame ids and reconnect-replay filtering without a
  // namespace mismatch.
  onWithSeq<E extends LiveEventName>(event: E, handler: (entry: SeqEntry<E>) => void): void {
    this.emitter.on(SEQ_PREFIX + event, handler as (...args: unknown[]) => void);
  }

  offWithSeq<E extends LiveEventName>(event: E, handler: (entry: SeqEntry<E>) => void): void {
    this.emitter.off(SEQ_PREFIX + event, handler as (...args: unknown[]) => void);
  }

  emit<E extends LiveEventName>(event: E, payload: LiveEventMap[E]): void {
    const seq = this.nextSeq++;
    this.buffer.push({ seq, event, payload });
    if (this.buffer.length > this.bufferSize) this.buffer.shift();
    // Deliver to plain subscribers (payload only) and seq-aware subscribers
    // ({seq, payload}). Both are dispatched synchronously so the buffer/seq
    // invariants are visible to all subscribers.
    this.emitter.emit(event, payload);
    this.emitter.emit(SEQ_PREFIX + event, { seq, payload } satisfies SeqEntry<E>);
  }

  replayFrom(lastSeq: number): ReplayEntry[] {
    return this.buffer.filter((e) => e.seq > lastSeq);
  }
}
