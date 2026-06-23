/**
 * Resolve the Claude Code session_id for the running MCP process.
 *
 * Two sources, in order:
 *   1. `CLAUDE_JOB_DIR` env var → read `<dir>/state.json`, regex-extract the
 *      session UUID from the `linkScanPath` field's filename. Instant; used
 *      by background-job MCPs.
 *   2. PPID breadcrumb at `<storage>/session-by-ppid/<process.ppid>.txt` —
 *      written by the hook collector on every tool call. Polled at exponential
 *      backoff: 100ms, 200ms, 500ms, 1s, 2s, then steady at 2s. No hard
 *      timeout; logs a single WARN at 60s if still unresolved.
 *
 * The MCP must never fabricate its own session_id. If neither path resolves,
 * tool handlers should report "session_id not yet resolved" rather than make
 * one up.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from '../shared/index.js';

const logger = createLogger('session-resolver');

const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const DEFAULT_STORAGE_DIR = resolve(homedir(), '.newrelic-preflight');
const POLL_SCHEDULE_MS = [100, 200, 500, 1000, 2000];
const STEADY_POLL_MS = 2000;
const WARN_AFTER_MS = 60_000;

export interface SessionResolverOptions {
  /** Override the storage path used to find the breadcrumb directory. */
  readonly storagePath?: string;
  /** Override `process.ppid` (test seam). */
  readonly ppid?: number;
  /** Override `process.env.CLAUDE_JOB_DIR` (test seam). */
  readonly claudeJobDir?: string | null;
  /** When true, skip the WARN log (test seam). */
  readonly suppressWarn?: boolean;
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
  const linkScanPath = (parsed as Record<string, unknown>).linkScanPath;
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
 */
export function resolveFromBreadcrumb(
  storagePath: string,
  ppid: number | undefined,
): string | null {
  if (typeof ppid !== 'number' || ppid <= 0) return null;
  const breadcrumbPath = resolve(storagePath, 'session-by-ppid', `${ppid}.txt`);
  if (!existsSync(breadcrumbPath)) return null;
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
  const storagePath = options.storagePath ?? DEFAULT_STORAGE_DIR;

  // Fast path: CLAUDE_JOB_DIR is set and contains a usable state.json. Used
  // by background-job MCPs where the parent doesn't fire hooks.
  const fromJobDir = resolveFromJobDir(claudeJobDir);
  if (fromJobDir) {
    logger.info('Resolved session_id from CLAUDE_JOB_DIR', { sessionId: fromJobDir });
    return fromJobDir;
  }

  // Synchronous attempt before we wait — common case is the breadcrumb is
  // already on disk because the user already typed at least one message.
  const immediate = resolveFromBreadcrumb(storagePath, ppid);
  if (immediate) {
    logger.info('Resolved session_id from breadcrumb (immediate)', { sessionId: immediate });
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
        if (options.signal) options.signal.removeEventListener('abort', onAbort);
        resolvePromise(sid);
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
