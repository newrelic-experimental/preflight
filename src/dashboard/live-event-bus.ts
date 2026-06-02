import { EventEmitter } from 'node:events';

export interface ToolCallEvent {
  readonly id: string;
  readonly tool: string;
  readonly durationMs: number;
  readonly costUsd: number;
  readonly ts: number;
}

export interface CostUpdateEvent {
  readonly sessionTotalUsd: number;
  readonly todayTotalUsd: number;
  readonly forecastEodUsd: number | null;
}

export interface AntiPatternEvent {
  readonly type: string;
  readonly target: string;
  readonly count: number;
}

export interface HeartbeatEvent {
  readonly ts: number;
}

export interface AlertEvent {
  readonly id: string;
  readonly state: 'firing' | 'cleared';
  readonly severity: 'info' | 'warning' | 'critical';
  readonly title: string;
  readonly description: string;
  readonly value: number;
  readonly threshold: number;
  readonly firedAt: number;
}

export type LiveEventMap = {
  'tool-call': ToolCallEvent;
  'cost-update': CostUpdateEvent;
  'anti-pattern': AntiPatternEvent;
  'heartbeat': HeartbeatEvent;
  'alert': AlertEvent;
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

export class LiveEventBus {
  private readonly emitter = new EventEmitter();
  private readonly buffer: ReplayEntry[] = [];
  private readonly bufferSize: number;
  // Start at 1 so a fresh client's Last-Event-ID: 0 (or no header) replays
  // every buffered event — replayFrom filters seq > lastSeq, so seq=0 means
  // "I have nothing yet."
  private nextSeq = 1;

  constructor(opts: LiveEventBusOptions = {}) {
    this.bufferSize = opts.replayBufferSize ?? DEFAULT_BUFFER_SIZE;
    this.emitter.setMaxListeners(50);
  }

  on<E extends LiveEventName>(event: E, handler: (payload: LiveEventMap[E]) => void): void {
    this.emitter.on(event, handler as (...args: unknown[]) => void);
  }

  off<E extends LiveEventName>(event: E, handler: (payload: LiveEventMap[E]) => void): void {
    this.emitter.off(event, handler as (...args: unknown[]) => void);
  }

  emit<E extends LiveEventName>(event: E, payload: LiveEventMap[E]): void {
    const seq = this.nextSeq++;
    this.buffer.push({ seq, event, payload });
    if (this.buffer.length > this.bufferSize) this.buffer.shift();
    this.emitter.emit(event, payload);
  }

  replayFrom(lastSeq: number): ReplayEntry[] {
    return this.buffer.filter((e) => e.seq > lastSeq);
  }
}
