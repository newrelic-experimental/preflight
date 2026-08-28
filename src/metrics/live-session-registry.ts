/**
 * Tracks which sessions are currently active based on recent tool call activity.
 * A session is "live" if it received a tool call within the staleness threshold.
 */

import { basename } from 'node:path';
import {
  isSyntheticSessionId,
  shouldReplaceSessionName,
  type SessionNameSource,
} from '../hooks/session-resolver.js';

export const DEFAULT_STALE_THRESHOLD_MS = 180_000; // 3 minutes
const MAX_CONCURRENCY_SAMPLES = 2880; // 24h at 30s intervals
const SAMPLE_INTERVAL_MS = 30_000;

export interface ConcurrencySample {
  readonly timestamp: number;
  readonly count: number;
}

export class LiveSessionRegistry {
  private readonly lastActivity = new Map<string, number>();
  private readonly sessionNames = new Map<string, string>();
  // Sessions whose name was set authoritatively (job-state title / transcript
  // ai-title). `touch()` must never overwrite these with a cwd basename.
  private readonly authoritativeNames = new Set<string>();
  // The source that produced each authoritative name, so a Phase-2 freshness
  // re-resolve can be refused when it would DOWNGRADE the name (e.g. a `cwd`
  // re-resolve arriving after a `user` name was set). Keyed identically to
  // `authoritativeNames`; cleared alongside it on eviction/reset.
  private readonly authoritativeSources = new Map<string, SessionNameSource>();
  private readonly staleThresholdMs: number;
  private peakConcurrent = 0;
  private readonly concurrencyTimeSeries: ConcurrencySample[] = [];
  private samplingInterval: ReturnType<typeof setInterval> | null = null;

  constructor(staleThresholdMs = DEFAULT_STALE_THRESHOLD_MS) {
    this.staleThresholdMs = staleThresholdMs;
  }

  touch(sessionId: string, cwd?: string): void {
    this.lastActivity.set(sessionId, Date.now());
    // Streaming FALLBACK naming: skip when an authoritative name is set, and
    // (as before) only fill the first time we see a cwd for this session.
    if (cwd && !this.authoritativeNames.has(sessionId) && !this.sessionNames.has(sessionId)) {
      const name = basename(cwd);
      if (name.length > 0 && name !== '.' && name !== '..') {
        this.sessionNames.set(sessionId, name);
        // Tag the fallback source so getSessionNameSource() reports 'cwd' for a
        // basename-named session (matching SessionTracker's streaming fallback,
        // which also tags 'cwd'). NOT added to `authoritativeNames`: this stays
        // a low-trust fallback that setAuthoritativeName may freely upgrade —
        // 'cwd' is the lowest rank, so shouldReplaceSessionName lets any real
        // source override it.
        this.authoritativeSources.set(sessionId, 'cwd');
      }
    }
    const liveCount = this.getLiveSessions({ includeSynthetic: true }).length;
    if (liveCount > this.peakConcurrent) {
      this.peakConcurrent = liveCount;
    }
  }

  /**
   * Set the authoritative display name for a session (from the job-state title
   * or transcript ai-title, per `resolveSessionName`'s precedence). Overrides
   * any cwd basename `touch()` may have already stored and pins it against
   * future `touch()` calls. Ignores empty names. Mirrors
   * `SessionTracker.setAuthoritativeName`, including the Phase-2 freshness
   * guard: when re-resolved on the persist/shutdown path, a strictly-less-
   * trusted `source` (e.g. `cwd` after a `user` name) is refused via
   * `shouldReplaceSessionName`, so a better name is never downgraded here.
   */
  setAuthoritativeName(sessionId: string, name: string, source: SessionNameSource): void {
    if (typeof name !== 'string' || name.length === 0) return;
    if (!shouldReplaceSessionName(this.authoritativeSources.get(sessionId) ?? null, source)) {
      return;
    }
    this.authoritativeNames.add(sessionId);
    this.authoritativeSources.set(sessionId, source);
    this.sessionNames.set(sessionId, name);
  }

  getSessionName(sessionId: string): string | null {
    return this.sessionNames.get(sessionId) ?? null;
  }

  /**
   * Which source produced the name `getSessionName` returns for this session
   * (see `SessionNameSource`), or null when the session is untracked or was
   * only ever named by the streaming cwd fallback in `touch()` (which records
   * a name but no source). Lets dashboard surfaces distinguish an
   * authoritative `user`/`ai-title`/`auto` name from a cwd-basename fallback,
   * matching the `session_name_source` the MCP tool and persisted summaries
   * already expose.
   */
  getSessionNameSource(sessionId: string): SessionNameSource | null {
    return this.authoritativeSources.get(sessionId) ?? null;
  }

  // The dashboard's `/api/sessions/live` endpoint surfaces last-activity per
  // live session so the Today selector can default to the most-recently-active
  // live session. Returns null when the session is not tracked (e.g. already
  // gc'd as stale).
  getLastActivity(sessionId: string): number | null {
    return this.lastActivity.get(sessionId) ?? null;
  }

  getLiveSessions(options?: { includeSynthetic?: boolean }): string[] {
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
      this.authoritativeNames.delete(id);
      this.authoritativeSources.delete(id);
    }
    // Synthetic session IDs (`local-*`, `proxy-*`, `pending-*`) are
    // MCP-internal bookkeeping from --local / proxy modes, not real Claude
    // Code sessions — dashboard consumers shouldn't see them as clickable
    // rows. Default to filtered; internal peak/count tracking opts into
    // `includeSynthetic: true` to keep its numbers unchanged.
    return options?.includeSynthetic ? live : live.filter((id) => !isSyntheticSessionId(id));
  }

  reset(): void {
    this.lastActivity.clear();
    this.sessionNames.clear();
    this.authoritativeNames.clear();
    this.authoritativeSources.clear();
  }

  isLive(sessionId: string): boolean {
    const ts = this.lastActivity.get(sessionId);
    if (ts === undefined) return false;
    if (Date.now() - ts > this.staleThresholdMs) {
      this.lastActivity.delete(sessionId);
      this.sessionNames.delete(sessionId);
      this.authoritativeNames.delete(sessionId);
      this.authoritativeSources.delete(sessionId);
      return false;
    }
    return true;
  }

  startSampling(): void {
    if (this.samplingInterval) return;
    this.samplingInterval = setInterval(() => {
      const count = this.getLiveSessions({ includeSynthetic: true }).length;
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
    return this.getLiveSessions({ includeSynthetic: true }).length;
  }

  getPeakConcurrent(): number {
    return this.peakConcurrent;
  }

  getConcurrencyTimeSeries(): readonly ConcurrencySample[] {
    return this.concurrencyTimeSeries;
  }
}
