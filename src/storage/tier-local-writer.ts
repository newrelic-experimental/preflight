/**
 * Local-directory destination for one multi-tier telemetry tier.
 *
 * Appends NR event objects as JSONL, one file per UTC day, mirroring
 * `LocalStore.appendAuditLog()`'s shape and the CLAUDE.md storage-permission
 * invariant (directories 0o700, files 0o600).
 *
 * Writes are synchronous, like every other local-persistence path in this repo
 * (`LocalStore`, `collector-script.ts`) — no buffering, no timers, no
 * lifecycle. Write failures are logged and counted, never thrown: a local tier
 * pointed at an unmounted NAS must not take down the MCP server, and must not
 * affect delivery to any other tier.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { createLogger } from '../core/index.js';
import type { NrEventData } from '../core/index.js';

const logger = createLogger('tier-local-writer');

// NR accepts event timestamps in epoch seconds or milliseconds, and audit
// events use seconds. 1e11 ms is 1973 and 1e11 s is the year 5138, so any
// value below it is seconds.
const SECONDS_CEILING = 1e11;

function timestampToMs(timestamp: number): number {
  return Math.abs(timestamp) < SECONDS_CEILING ? timestamp * 1000 : timestamp;
}

export interface TierLocalWriterOptions {
  /** Tier name, used only for log attribution. */
  readonly tierName: string;
  /** Absolute directory this tier writes into (already resolved by validateTiers). */
  readonly path: string;
}

export class TierLocalWriter {
  private readonly tierName: string;
  private readonly path: string;
  private dirEnsured = false;
  private writes = 0;
  private failures = 0;

  constructor(options: TierLocalWriterOptions) {
    this.tierName = options.tierName;
    this.path = options.path;
  }

  /**
   * Absolute path of the JSONL file an event with this timestamp lands in.
   * Defaults to today's file. Exposed for tests and operator tooling.
   */
  getEventFilePath(timestampMs: number = Date.now()): string {
    const dateStr = new Date(timestampMs).toISOString().slice(0, 10); // YYYY-MM-DD
    return resolve(this.path, `events-${dateStr}.jsonl`);
  }

  /** Append one event. Never throws. */
  addEvent(event: NrEventData): void {
    const rawTimestamp = event.timestamp;
    const timestampMs = typeof rawTimestamp === 'number' ? timestampToMs(rawTimestamp) : Date.now();

    try {
      if (!this.dirEnsured) {
        mkdirSync(this.path, { recursive: true, mode: 0o700 });
        this.dirEnsured = true;
      }
      appendFileSync(this.getEventFilePath(timestampMs), JSON.stringify(event) + '\n', {
        mode: 0o600,
      });
      this.writes += 1;
    } catch (err) {
      this.failures += 1;
      logger.warn('Failed to append event to local tier — dropping event for this tier only', {
        tier: this.tierName,
        path: this.path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  getStats(): { readonly writes: number; readonly failures: number } {
    return { writes: this.writes, failures: this.failures };
  }
}
