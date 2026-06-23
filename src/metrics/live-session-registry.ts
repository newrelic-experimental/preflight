/**
 * Tracks which sessions are currently active based on recent tool call activity.
 * A session is "live" if it received a tool call within the staleness threshold.
 */

import { basename } from 'node:path';

const DEFAULT_STALE_THRESHOLD_MS = 180_000; // 3 minutes
const MAX_CONCURRENCY_SAMPLES = 2880; // 24h at 30s intervals
const SAMPLE_INTERVAL_MS = 30_000;

export interface ConcurrencySample {
  readonly timestamp: number;
  readonly count: number;
}

export class LiveSessionRegistry {
  private readonly lastActivity = new Map<string, number>();
  private readonly sessionNames = new Map<string, string>();
  private readonly staleThresholdMs: number;
  private peakConcurrent = 0;
  private readonly concurrencyTimeSeries: ConcurrencySample[] = [];
  private samplingInterval: ReturnType<typeof setInterval> | null = null;

  constructor(staleThresholdMs = DEFAULT_STALE_THRESHOLD_MS) {
    this.staleThresholdMs = staleThresholdMs;
  }

  touch(sessionId: string, cwd?: string): void {
    this.lastActivity.set(sessionId, Date.now());
    if (cwd && !this.sessionNames.has(sessionId)) {
      const name = basename(cwd);
      if (name.length > 0 && name !== '.' && name !== '..') {
        this.sessionNames.set(sessionId, name);
      }
    }
    const liveCount = this.getLiveSessions().length;
    if (liveCount > this.peakConcurrent) {
      this.peakConcurrent = liveCount;
    }
  }

  getSessionName(sessionId: string): string | null {
    return this.sessionNames.get(sessionId) ?? null;
  }

  // The dashboard's `/api/sessions/live` endpoint surfaces last-activity per
  // live session so the Today selector can default to the most-recently-active
  // live session. Returns null when the session is not tracked (e.g. already
  // gc'd as stale).
  getLastActivity(sessionId: string): number | null {
    return this.lastActivity.get(sessionId) ?? null;
  }

  getLiveSessions(): string[] {
    const now = Date.now();
    const live: string[] = [];
    const stale: string[] = [];
    for (const [id, ts] of this.lastActivity) {
      if (now - ts <= this.staleThresholdMs) {
        live.push(id);
      } else {
        stale.push(id);
      }
    }
    for (const id of stale) {
      this.lastActivity.delete(id);
      this.sessionNames.delete(id);
    }
    return live;
  }

  reset(): void {
    this.lastActivity.clear();
    this.sessionNames.clear();
  }

  isLive(sessionId: string): boolean {
    const ts = this.lastActivity.get(sessionId);
    if (ts === undefined) return false;
    if (Date.now() - ts > this.staleThresholdMs) {
      this.lastActivity.delete(sessionId);
      this.sessionNames.delete(sessionId);
      return false;
    }
    return true;
  }

  startSampling(): void {
    if (this.samplingInterval) return;
    this.samplingInterval = setInterval(() => {
      const count = this.getLiveSessions().length;
      this.concurrencyTimeSeries.push({ timestamp: Date.now(), count });
      if (this.concurrencyTimeSeries.length > MAX_CONCURRENCY_SAMPLES) {
        this.concurrencyTimeSeries.shift();
      }
    }, SAMPLE_INTERVAL_MS);
    this.samplingInterval.unref();
  }

  stopSampling(): void {
    if (this.samplingInterval) {
      clearInterval(this.samplingInterval);
      this.samplingInterval = null;
    }
  }

  getConcurrentCount(): number {
    return this.getLiveSessions().length;
  }

  getPeakConcurrent(): number {
    return this.peakConcurrent;
  }

  getConcurrencyTimeSeries(): readonly ConcurrencySample[] {
    return this.concurrencyTimeSeries;
  }
}
