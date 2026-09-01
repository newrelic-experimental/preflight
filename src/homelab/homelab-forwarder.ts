import { Agent } from 'undici';
import { createLogger } from '../shared/index.js';
import { validateSsrfUrl, createSsrfSafeLookup } from '../security/ssrf.js';
import type { ToolCallRecord } from '../storage/types.js';

const logger = createLogger('homelab-forwarder');

const MAX_BUFFER_SIZE = 1000;
const FLUSH_INTERVAL_MS = 5_000;

export interface HomelabForwarderOptions {
  readonly serverUrl: string;
  readonly token: string;
  readonly developer: string;
  readonly sessionId: string;
}

export class HomelabForwarder {
  private readonly serverUrl: string;
  private readonly token: string;
  private readonly developer: string;
  private readonly sessionId: string;
  private buffer: ToolCallRecord[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  // Built once and reused for every post() call. Its connect.lookup resolves
  // and validates the address actually connected to (see
  // createSsrfSafeLookup()'s doc comment) — allowPrivateNetworks: true
  // because a homelab server is, by design, almost always at a private LAN
  // address; only cloud metadata endpoints and non-http(s) schemes are
  // blocked here, not RFC-1918/loopback ranges.
  private readonly dispatcher: Agent;

  constructor(opts: HomelabForwarderOptions) {
    validateSsrfUrl('HomelabForwarder', new URL(opts.serverUrl), { allowPrivateNetworks: true });
    this.serverUrl = opts.serverUrl;
    this.token = opts.token;
    this.developer = opts.developer;
    this.sessionId = opts.sessionId;
    this.dispatcher = new Agent({
      connect: {
        lookup: createSsrfSafeLookup('HomelabForwarder (resolved)', { allowPrivateNetworks: true }),
      },
    });
  }

  start(): void {
    if (this.stopped) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, FLUSH_INTERVAL_MS);
    this.timer.unref?.();
  }

  enqueue(record: ToolCallRecord): void {
    if (this.stopped) return;
    if (this.buffer.length >= MAX_BUFFER_SIZE) {
      this.buffer.shift();
    }
    this.buffer.push(record);
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0);
    await this.post(batch);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
    await this.dispatcher.close().catch((err: unknown) => {
      logger.warn('Failed to close homelab forwarder dispatcher', { error: String(err) });
    });
  }

  private async post(records: ToolCallRecord[]): Promise<void> {
    const payload = JSON.stringify({
      developer: this.developer,
      sessionId: this.sessionId,
      records,
    });
    try {
      const response = await fetch(`${this.serverUrl}/ingest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: payload,
        signal: AbortSignal.timeout(5_000),
        dispatcher: this.dispatcher,
      } as RequestInit & { dispatcher: Agent });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (err) {
      logger.warn('Failed to forward events to homelab server', {
        error: String(err),
        count: records.length,
      });
    }
  }
}
