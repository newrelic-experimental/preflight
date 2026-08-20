/**
 * Resolve the Claude Code session_id for the running MCP process.
 *
 * Three sources, in order:
 *   1. `CLAUDE_JOB_DIR` env var → read `<dir>/state.json`, regex-extract the
 *      session UUID from the `linkScanPath` field's filename. Instant; used
 *      by background-job MCPs.
 *   2. PPID breadcrumb at `<storage>/session-by-ppid/<process.ppid>.txt` —
 *      written by the hook collector on every tool call. Precise as long as
 *      the OS hasn't recycled the PPID to an unrelated process since the
 *      breadcrumb was written — resolveFromBreadcrumb() guards against that
 *      by rejecting a breadcrumb older than the resolving process's own
 *      start time (see its doc comment).
 *   3. cwd breadcrumb at `<storage>/session-by-cwd/<sanitized-cwd>.txt` —
 *      also written by the hook collector on every tool call, keyed by the
 *      project directory instead of a PID. Fallback for platforms where the
 *      PPID bridge never reaches the MCP's own `process.ppid` (e.g. native
 *      Windows, where Claude Code interposes Git Bash between itself and the
 *      hook collector but launches the MCP server directly). Only consulted
 *      when #2 misses.
 *   Both breadcrumb sources are polled together at exponential backoff:
 *   100ms, 200ms, 500ms, 1s, 2s, then steady at 2s. No hard timeout; logs a
 *   single WARN at 60s if still unresolved.
 *
 * The MCP must never fabricate its own session_id. If none of these resolve,
 * tool handlers should report "session_id not yet resolved" rather than make
 * one up.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from '../shared/index.js';

const logger = createLogger('session-resolver');

const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const DEFAULT_STORAGE_DIR = resolve(homedir(), '.newrelic-preflight');
const POLL_SCHEDULE_MS = [100, 200, 500, 1000, 2000];
const STEADY_POLL_MS = 2000;
const WARN_AFTER_MS = 60_000;

/** Which of the three sources produced a resolveSessionId() result. */
export type SessionIdSource = 'jobdir' | 'ppid' | 'cwd';

export interface SessionResolverOptions {
  /** Override the storage path used to find the breadcrumb directory. */
  readonly storagePath?: string;
  /** Override `process.ppid` (test seam). */
  readonly ppid?: number;
  /** Override `process.cwd()` (test seam). */
  readonly cwd?: string;
  /** Override `process.env.CLAUDE_JOB_DIR` (test seam). */
  readonly claudeJobDir?: string | null;
  /** When true, skip the WARN log (test seam). */
  readonly suppressWarn?: boolean;
  /**
   * Invoked once, synchronously, right before resolveSessionId's promise
   * settles, reporting which source produced the winning value. Purely
   * additive — omitting it changes no behavior. Lets callers detect a
   * cwd-sourced (lower-confidence) resolution without changing the
   * `Promise<string>` contract existing callers rely on.
   */
  readonly onResolutionSource?: (info: { source: SessionIdSource; sessionId: string }) => void;
}

/** The one field `resolveFromJobDir` reads out of `CLAUDE_JOB_DIR/state.json`. */
interface ClaudeJobDirState {
  readonly linkScanPath?: unknown;
}

/**
 * Try to resolve the session_id synchronously from `CLAUDE_JOB_DIR/state.json`.
 * Returns the validated session_id or null.
 */
export function resolveFromJobDir(claudeJobDir: string | null | undefined): string | null {
  if (!claudeJobDir || typeof claudeJobDir !== 'string') return null;
  const statePath = resolve(claudeJobDir, 'state.json');
  if (!existsSync(statePath)) return null;
  let raw: string;
  try {
    raw = readFileSync(statePath, 'utf-8');
  } catch (err) {
    logger.debug('CLAUDE_JOB_DIR/state.json unreadable', { error: String(err) });
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.debug('CLAUDE_JOB_DIR/state.json invalid JSON', { error: String(err) });
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const linkScanPath = (parsed as ClaudeJobDirState).linkScanPath;
  if (typeof linkScanPath !== 'string' || linkScanPath.length === 0) return null;

  // The session UUID is the basename minus its extension. Validate against
  // the same character class used everywhere else so we never accept a
  // path-traversing value.
  const file = basename(linkScanPath);
  const dot = file.lastIndexOf('.');
  const sid = dot > 0 ? file.slice(0, dot) : file;
  if (!SESSION_ID_RE.test(sid)) return null;
  return sid;
}

/**
 * Try to resolve the session_id synchronously from the PPID breadcrumb file.
 * Returns the validated session_id or null.
 *
 * Rejects a breadcrumb whose mtime predates `processStartMs` (defaults to
 * this process's own wall-clock start time). Without this, a breadcrumb keyed
 * on a PID the OS has since recycled — the PPID this process shares with an
 * unrelated PRIOR process — silently resolves to that prior process's
 * session_id, weeks after it ended. gcStaleBreadcrumbs() can't catch this: it
 * only checks whether the PID is alive, and a recycled PID always is.
 */
export function resolveFromBreadcrumb(
  storagePath: string,
  ppid: number | undefined,
  processStartMs: number = Date.now() - process.uptime() * 1000,
): string | null {
  if (typeof ppid !== 'number' || ppid <= 0) return null;
  const breadcrumbPath = resolve(storagePath, 'session-by-ppid', `${ppid}.txt`);
  if (!existsSync(breadcrumbPath)) return null;

  let mtimeMs: number;
  try {
    mtimeMs = statSync(breadcrumbPath).mtimeMs;
  } catch (err) {
    logger.debug('Breadcrumb file unstatable', { error: String(err) });
    return null;
  }
  if (mtimeMs < processStartMs) {
    logger.debug('Rejecting stale ppid breadcrumb (predates process start)', {
      ppid,
      mtimeMs,
      processStartMs,
    });
    return null;
  }

  let raw: string;
  try {
    raw = readFileSync(breadcrumbPath, 'utf-8');
  } catch (err) {
    logger.debug('Breadcrumb file unreadable', { error: String(err) });
    return null;
  }
  const sid = raw.trim();
  if (!SESSION_ID_RE.test(sid)) return null;
  return sid;
}

/**
 * Try to resolve the session_id synchronously from the cwd breadcrumb file.
 * Fallback for platforms where the PPID breadcrumb never matches (see the
 * module doc comment above). Returns the validated session_id or null.
 */
export function resolveFromCwd(storagePath: string, cwd: string | undefined): string | null {
  if (typeof cwd !== 'string' || cwd.length === 0) return null;
  // Same sanitization scheme as the collector's writeCwdBreadcrumb() /
  // getTranscriptPath() — must stay identical so both sides derive the same
  // filename independently. Colons are stripped too (unlike
  // getTranscriptPath) so a Windows drive letter never survives into the
  // filename — see the matching comment in writeCwdBreadcrumb().
  const sanitizedCwd = cwd.replace(/[\\/:]/g, '-');
  const breadcrumbPath = resolve(storagePath, 'session-by-cwd', `${sanitizedCwd}.txt`);
  if (!existsSync(breadcrumbPath)) return null;
  let raw: string;
  try {
    raw = readFileSync(breadcrumbPath, 'utf-8');
  } catch (err) {
    logger.debug('cwd breadcrumb file unreadable', { error: String(err) });
    return null;
  }
  const sid = raw.trim();
  if (!SESSION_ID_RE.test(sid)) return null;
  return sid;
}

/**
 * Returns the next poll delay for attempt index `i` (0-based).
 * Schedule: 100ms, 200ms, 500ms, 1s, 2s, then steady 2s.
 */
export function nextDelayMs(attempt: number): number {
  if (attempt < POLL_SCHEDULE_MS.length) return POLL_SCHEDULE_MS[attempt]!;
  return STEADY_POLL_MS;
}

/**
 * Resolve the Claude Code session_id, polling forever if needed.
 *
 * - First tries `CLAUDE_JOB_DIR` (synchronous, free).
 * - Falls back to the PPID breadcrumb with exponential backoff polling.
 * - Resolves to a validated session_id string when found. Never resolves to
 *   null; the only way out is success, the optional `signal`, or the caller
 *   stopping the surrounding process.
 * - Logs a single WARN at 60s if still unresolved.
 *
 * Pass an `AbortSignal` to allow shutdown to break the loop.
 */
export async function resolveSessionId(
  options: SessionResolverOptions & { signal?: AbortSignal } = {},
): Promise<string> {
  const claudeJobDir =
    options.claudeJobDir !== undefined
      ? options.claudeJobDir
      : (process.env.CLAUDE_JOB_DIR ?? null);
  const ppid = options.ppid ?? process.ppid;
  const cwd = options.cwd ?? process.cwd();
  const storagePath = options.storagePath ?? DEFAULT_STORAGE_DIR;

  // Fast path: CLAUDE_JOB_DIR is set and contains a usable state.json. Used
  // by background-job MCPs where the parent doesn't fire hooks.
  const fromJobDir = resolveFromJobDir(claudeJobDir);
  if (fromJobDir) {
    logger.info('Resolved session_id from CLAUDE_JOB_DIR', { sessionId: fromJobDir });
    options.onResolutionSource?.({ source: 'jobdir', sessionId: fromJobDir });
    return fromJobDir;
  }

  // Synchronous attempt before we wait — common case is the ppid breadcrumb
  // is already on disk because the user already typed at least one message.
  // The cwd breadcrumb is NOT checked synchronously here: unlike the ppid
  // breadcrumb (written per-process, no cross-session collision), a cwd
  // breadcrumb can already exist at t=0 as a stale leftover from an
  // unrelated prior session that ran in the same directory. Trusting it
  // immediately would let that stale value win a race against THIS
  // process's own ppid breadcrumb, which may simply not have been written
  // yet. Routing cwd through the poll loop below — where ppid is always
  // checked first, every tick — gives the precise signal a real chance
  // before falling back to the collision-prone one.
  const immediate = resolveFromBreadcrumb(storagePath, ppid);
  if (immediate) {
    logger.info('Resolved session_id from breadcrumb (immediate)', { sessionId: immediate });
    options.onResolutionSource?.({ source: 'ppid', sessionId: immediate });
    return immediate;
  }

  const startTime = Date.now();
  let warnedAt60s = false;
  let attempt = 0;

  return new Promise<string>((resolvePromise, rejectPromise) => {
    const onAbort = () => {
      rejectPromise(new Error('session resolution aborted'));
    };
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener('abort', onAbort, { once: true });
      // Re-check after registering in case the signal fired in the gap
      // between the earlier aborted check and addEventListener.
      if (options.signal.aborted) {
        onAbort();
        return;
      }
    }

    const tick = () => {
      if (options.signal?.aborted) {
        options.signal.removeEventListener('abort', onAbort);
        return;
      }
      const sid = resolveFromBreadcrumb(storagePath, ppid);
      if (sid) {
        const elapsed = Date.now() - startTime;
        logger.info('Resolved session_id from breadcrumb', { sessionId: sid, elapsedMs: elapsed });
        options.onResolutionSource?.({ source: 'ppid', sessionId: sid });
        if (options.signal) options.signal.removeEventListener('abort', onAbort);
        resolvePromise(sid);
        return;
      }
      const sidFromCwd = resolveFromCwd(storagePath, cwd);
      if (sidFromCwd) {
        const elapsed = Date.now() - startTime;
        logger.info('Resolved session_id from cwd breadcrumb (ppid fallback)', {
          sessionId: sidFromCwd,
          elapsedMs: elapsed,
        });
        options.onResolutionSource?.({ source: 'cwd', sessionId: sidFromCwd });
        if (options.signal) options.signal.removeEventListener('abort', onAbort);
        resolvePromise(sidFromCwd);
        return;
      }
      const elapsed = Date.now() - startTime;
      if (!warnedAt60s && elapsed >= WARN_AFTER_MS && !options.suppressWarn) {
        warnedAt60s = true;
        logger.warn(
          'session_id unresolved after 60s — breadcrumb missing; check that hook collector is installed and writing.',
        );
      }
      const delay = nextDelayMs(attempt++);
      const handle = setTimeout(tick, delay);
      // Don't keep the event loop alive on this timer alone — Ctrl+C / stdin
      // close should be able to terminate the MCP without explicitly
      // cancelling resolution.
      handle.unref?.();
    };

    const delay = nextDelayMs(attempt++);
    const handle = setTimeout(tick, delay);
    handle.unref?.();
  });
}

/**
 * Keep watching the PPID breadcrumb only (never cwd, never CLAUDE_JOB_DIR) —
 * used as a corrective safety net after an initial resolution came from the
 * cwd fallback. Same exponential-backoff schedule as resolveSessionId
 * (reuses nextDelayMs). Resolves on the first valid ppid hit; never resolves
 * null. The caller decides whether the resolved id differs from what's
 * already adopted and is worth acting on — this function doesn't know or
 * care. No 60s WARN log: a cwd-sourced session working fine while the ppid
 * breadcrumb stays silent is expected, not alarming.
 */
export async function watchPpidBreadcrumb(
  options: SessionResolverOptions & { signal?: AbortSignal } = {},
): Promise<string> {
  const ppid = options.ppid ?? process.ppid;
  const storagePath = options.storagePath ?? DEFAULT_STORAGE_DIR;

  let attempt = 0;

  return new Promise<string>((resolvePromise, rejectPromise) => {
    const onAbort = () => {
      rejectPromise(new Error('session resolution aborted'));
    };
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener('abort', onAbort, { once: true });
      if (options.signal.aborted) {
        onAbort();
        return;
      }
    }

    const tick = () => {
      if (options.signal?.aborted) {
        options.signal.removeEventListener('abort', onAbort);
        return;
      }
      const sid = resolveFromBreadcrumb(storagePath, ppid);
      if (sid) {
        logger.debug('Resolved corrected session_id from ppid breadcrumb', { sessionId: sid });
        if (options.signal) options.signal.removeEventListener('abort', onAbort);
        resolvePromise(sid);
        return;
      }
      const delay = nextDelayMs(attempt++);
      const handle = setTimeout(tick, delay);
      handle.unref?.();
    };

    const delay = nextDelayMs(attempt++);
    const handle = setTimeout(tick, delay);
    handle.unref?.();
  });
}

/**
 * Returns true for session IDs that are MCP-internal synthetic identifiers
 * (not real Claude Code session IDs). These should be hidden from user-facing
 * surfaces such as the dashboard session list and audit trail.
 *
 * Single source of truth: kept here alongside the other session-ID logic so
 * that adding a new synthetic prefix only requires one change.
 */
export function isSyntheticSessionId(id: string | null | undefined): boolean {
  if (!id) return false;
  return id.startsWith('local-') || id.startsWith('proxy-') || id.startsWith('pending-');
}

/**
 * Returns true for session IDs whose owning process's SubagentWatcher (if
 * any) runs unscoped — `--local`/proxy processes discover subagent
 * transcripts across every session, not just their own. Their own live
 * CostTracker therefore is NOT exclusively their own cost: some of it may
 * belong to other, already-separately-persisted sessions.
 *
 * Deliberately narrower than `isSyntheticSessionId`: a `pending-*` id is
 * still exactly one real `--stdio` session (mid session-ID resolution), so
 * its live cost genuinely is exclusively its own and must NOT be excluded
 * the same way. Callers deciding whether to add a process's own live
 * today-portion on top of an already-persisted-sessions sum (to avoid
 * double-counting) should check this, not `isSyntheticSessionId`.
 */
export function isUnscopedAggregatorSessionId(id: string | null | undefined): boolean {
  if (!id) return false;
  return id.startsWith('local-') || id.startsWith('proxy-');
}
