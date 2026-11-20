/**
 * Sends one event per request to taxonomy-enforcer and records what was sent
 * in `sent.log`, so `preflight usage-reports show` can print it back.
 */

import { appendFileSync, readFileSync, statSync } from 'node:fs';

import { createLogger } from '../core/index.js';
import { VERSION } from '../version.js';
import {
  MAX_CONSECUTIVE_SEND_FAILURES,
  SEND_TIMEOUT_MS,
  USAGE_REPORTS_ENDPOINT,
} from './constants.js';
import type { TrackEvent } from './events.js';
import { ensureDir, sentLogPath, writeFileAtomic } from './state.js';

const logger = createLogger('usage-reports');

const SENT_LOG_MAX_BYTES = 512 * 1024;

export type FetchFn = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;

export interface SenderOptions {
  readonly dir: string;
  readonly debug: boolean;
  readonly fetchFn?: FetchFn;
  readonly stderr?: (line: string) => void;
}

export class UsageReportSender {
  private consecutiveFailures = 0;
  private readonly fetchFn: FetchFn;
  private readonly stderr: (line: string) => void;

  constructor(private readonly opts: SenderOptions) {
    this.fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init));
    this.stderr = opts.stderr ?? ((line) => process.stderr.write(line + '\n'));
  }

  /** Debug mode prints payloads instead of sending them. */
  get debug(): boolean {
    return this.opts.debug;
  }

  /** False after three failed sends in a row; stays false until the process restarts. */
  get available(): boolean {
    return this.consecutiveFailures < MAX_CONSECUTIVE_SEND_FAILURES;
  }

  /** Sends events in order and stops at the first failure. Returns true if all were sent. */
  async sendAll(events: readonly TrackEvent[]): Promise<boolean> {
    for (const event of events) {
      if (!(await this.send(event))) return false;
    }
    return true;
  }

  async send(event: TrackEvent): Promise<boolean> {
    if (!this.available) return false;
    if (this.opts.debug) {
      this.stderr(`[usage-reports debug, not sent] ${JSON.stringify(event)}`);
      return true;
    }
    try {
      const res = await this.fetchFn(USAGE_REPORTS_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': `preflight/${VERSION}` },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.consecutiveFailures = 0;
      this.log(event);
      return true;
    } catch (err) {
      this.consecutiveFailures++;
      logger.debug('Usage report send failed', {
        error: err instanceof Error ? err.message : String(err),
        consecutiveFailures: this.consecutiveFailures,
      });
      return false;
    }
  }

  private log(event: TrackEvent): void {
    try {
      ensureDir(this.opts.dir);
      const path = sentLogPath(this.opts.dir);
      appendFileSync(path, JSON.stringify({ sentAt: new Date().toISOString(), event }) + '\n', {
        mode: 0o600,
      });
      if (statSync(path).size > SENT_LOG_MAX_BYTES) {
        const lines = readFileSync(path, 'utf-8').trimEnd().split('\n');
        writeFileAtomic(path, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n');
      }
    } catch {
      // the log is a convenience; never fail a send over it
    }
  }
}
