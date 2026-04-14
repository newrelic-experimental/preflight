import type { NrEventData } from '../events/types.js';

export interface EventBufferOptions {
  maxSize?: number;
}

const DEFAULT_MAX_SIZE = 1000;

export class EventBuffer {
  private readonly maxSize: number;
  private buffer: NrEventData[];
  private totalSeen: number;

  constructor(options?: EventBufferOptions) {
    this.maxSize = options?.maxSize ?? DEFAULT_MAX_SIZE;
    this.buffer = [];
    this.totalSeen = 0;
  }

  add(event: NrEventData): void {
    this.totalSeen++;

    if (this.buffer.length < this.maxSize) {
      this.buffer.push(event);
      return;
    }

    // Algorithm R reservoir sampling: replace a random element with
    // probability maxSize / totalSeen
    const j = Math.floor(Math.random() * this.totalSeen);
    if (j < this.maxSize) {
      this.buffer[j] = event;
    }
  }

  flush(): NrEventData[] {
    const snapshot = this.buffer;
    this.buffer = [];
    this.totalSeen = 0;
    return snapshot;
  }

  get size(): number {
    return this.buffer.length;
  }

  get totalAdded(): number {
    return this.totalSeen;
  }
}
