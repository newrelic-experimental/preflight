/**
 * Makes `--local`'s silent New Relic data loss visible (#479).
 *
 * `--local` drains every per-session buffer that has no live owning `--stdio`
 * engine (`LocalStore.drainAllBuffers()` skips any buffer whose
 * `active-<sessionId>.pid` heartbeat names a live PID). When `--local` has
 * cloud credentials it forwards those sessions to New Relic itself. When the
 * config asks for cloud export (mode `cloud`/`both`) but this process can't
 * see the credentials — typically because they live only in a shell
 * environment variable, which the dashboard LaunchAgent does not inherit —
 * `--local` falls back to local mode and those sessions never reach New
 * Relic. This monitor records each such session, warns once per session, and
 * backs the `unforwardedSessions` field on `GET /api/health`. The fix-it
 * hint is logged once, by the caller's startup warning, not per session.
 */

import { createLogger } from '../shared/index.js';
import { MissingCloudCredentialError, type Mode } from '../config.js';

const logger = createLogger('unforwarded-session-monitor');

const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const DEFAULT_MAX_TRACKED_SESSIONS = 500;
/** How many sessions `getSnapshot()` lists, newest activity first. */
const SNAPSHOT_SESSION_LIMIT = 20;

/** Which credential this process was missing when it fell back to local mode. */
export type CloudForwardingGapReason = 'missing-license-key' | 'missing-account-id';

export interface CloudForwardingGap {
  readonly reason: CloudForwardingGapReason;
  /** The config field named by `reason`. */
  readonly missingField: 'licenseKey' | 'accountId';
  /** The mode the config asked for before the fallback (`cloud` or `both`). */
  readonly requestedMode: Mode;
}

export interface UnforwardedSessionEntry {
  readonly sessionId: string;
  readonly toolCalls: number;
  readonly firstSeenMs: number;
  readonly lastSeenMs: number;
}

export interface UnforwardedSessionsSnapshot {
  readonly reason: CloudForwardingGapReason;
  readonly requestedMode: Mode;
  /**
   * Distinct identified sessions drained without forwarding, among those
   * still tracked: past the cap the least recently active are evicted.
   */
  readonly count: number;
  /** Sessions evicted to stay under the cap. One seen again counts again. */
  readonly evictedSessions: number;
  /** Tool calls drained without forwarding, across every session. */
  readonly toolCalls: number;
  /** The share of `toolCalls` with no usable session id. Not in `count`. */
  readonly untrackedToolCalls: number;
  /** Up to 20 sessions, most recently active first. */
  readonly sessions: readonly UnforwardedSessionEntry[];
  /** True when `sessions` omits some of the `count` sessions. */
  readonly truncated: boolean;
  readonly hint: string;
}

export interface UnforwardedSessionMonitorOptions {
  readonly gap: CloudForwardingGap;
  /**
   * Cap on per-session entries kept in memory. Default 500. Past it the least
   * recently active entry is evicted, so a session losing data now is always
   * listed however long the process has been up.
   */
  readonly maxTrackedSessions?: number;
  /** Test seam for the one-per-session warning. */
  readonly warn?: (message: string, fields: Record<string, unknown>) => void;
  /** Test seam for the clock. */
  readonly now?: () => number;
}

/** How to fix the gap. Log it once at startup; the per-session warnings omit it. */
export const UNFORWARDED_SESSIONS_HINT =
  'This dashboard process is not forwarding to New Relic because it cannot see your cloud ' +
  'credentials. Add licenseKey and accountId to the config file (the dashboard LaunchAgent ' +
  'does not inherit shell environment variables), then restart the dashboard.';

/**
 * Read the config-load error `--local` catches before falling back to local
 * mode: a `MissingCloudCredentialError`, thrown directly or carried as the
 * `cause` of a wrapping error. Returns null for any other error, which
 * `--local` rethrows.
 */
export function detectCloudForwardingGap(err: unknown): CloudForwardingGap | null {
  const source =
    err instanceof MissingCloudCredentialError
      ? err
      : err instanceof Error && err.cause instanceof MissingCloudCredentialError
        ? err.cause
        : undefined;
  if (!source) return null;
  return {
    reason: source.missingField === 'licenseKey' ? 'missing-license-key' : 'missing-account-id',
    missingField: source.missingField,
    requestedMode: source.mode,
  };
}

interface MutableEntry {
  toolCalls: number;
  firstSeenMs: number;
  lastSeenMs: number;
}

export class UnforwardedSessionMonitor {
  private readonly gap: CloudForwardingGap;
  private readonly maxTrackedSessions: number;
  private readonly warn: (message: string, fields: Record<string, unknown>) => void;
  private readonly now: () => number;
  /** Least recently active first: an update re-inserts its entry at the end. */
  private readonly sessions = new Map<string, MutableEntry>();
  private evictedSessions = 0;
  private untrackedToolCalls = 0;
  private totalToolCalls = 0;
  private warnedUntracked = false;

  constructor(options: UnforwardedSessionMonitorOptions) {
    this.gap = options.gap;
    this.maxTrackedSessions = options.maxTrackedSessions ?? DEFAULT_MAX_TRACKED_SESSIONS;
    this.warn = options.warn ?? ((message, fields) => logger.warn(message, fields));
    this.now = options.now ?? Date.now;
  }

  /**
   * Record one tool call drained from an ownerless buffer and not forwarded.
   * Warns the first time each session is seen, and again if it comes back
   * after eviction. A missing or malformed session id is counted without an
   * entry.
   */
  recordToolCall(sessionId: string | null | undefined): void {
    this.totalToolCalls++;
    const nowMs = this.now();
    const existing = typeof sessionId === 'string' ? this.sessions.get(sessionId) : undefined;
    if (typeof sessionId === 'string' && existing) {
      existing.toolCalls++;
      existing.lastSeenMs = nowMs;
      this.sessions.delete(sessionId);
      this.sessions.set(sessionId, existing);
      return;
    }
    if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
      this.untrackedToolCalls++;
      if (!this.warnedUntracked) {
        this.warnedUntracked = true;
        this.warn(
          'Tool calls with no trackable session id are not reaching New Relic; counting them as untrackedToolCalls',
          { reason: this.gap.reason, requestedMode: this.gap.requestedMode },
        );
      }
      return;
    }
    if (this.sessions.size >= this.maxTrackedSessions) {
      const leastRecent = this.sessions.keys().next().value;
      if (leastRecent !== undefined) this.sessions.delete(leastRecent);
      this.evictedSessions++;
    }
    this.sessions.set(sessionId, { toolCalls: 1, firstSeenMs: nowMs, lastSeenMs: nowMs });
    this.warn('Session has no owning --stdio engine and is not reaching New Relic', {
      sessionId,
      reason: this.gap.reason,
      requestedMode: this.gap.requestedMode,
    });
  }

  getSnapshot(): UnforwardedSessionsSnapshot {
    const sessions = [...this.sessions]
      .slice(-SNAPSHOT_SESSION_LIMIT)
      .reverse()
      .map(([sessionId, e]) => ({ sessionId, ...e }));
    return {
      reason: this.gap.reason,
      requestedMode: this.gap.requestedMode,
      count: this.sessions.size,
      evictedSessions: this.evictedSessions,
      toolCalls: this.totalToolCalls,
      untrackedToolCalls: this.untrackedToolCalls,
      sessions,
      truncated: sessions.length < this.sessions.size,
      hint: UNFORWARDED_SESSIONS_HINT,
    };
  }
}
