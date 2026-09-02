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

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  constants as fsConstants,
} from 'node:fs';
import { resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from '../shared/index.js';

import { redactSensitive } from '../config.js';

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

/**
 * The fields Preflight reads out of `CLAUDE_JOB_DIR/state.json` (Claude Code
 * writes this for background jobs). Every field is optional and `unknown` — a
 * given build of Claude Code may omit any of them, and the readers below
 * validate each before use. `name`/`nameSource`/`intent` are consumed by
 * `readJobState`; `resolveFromJobDir` reads only `linkScanPath`.
 */
interface ClaudeJobDirState {
  readonly linkScanPath?: unknown;
  readonly sessionId?: unknown;
  readonly name?: unknown;
  readonly nameSource?: unknown;
  readonly intent?: unknown;
}

/**
 * Read and JSON-parse `<claudeJobDir>/state.json`, returning the parsed object
 * or null on any failure (missing dir, unreadable, invalid JSON, non-object).
 * Shared by `resolveFromJobDir` and `readJobState` so both derive from one
 * read; neither's public contract changes.
 */
function readAndParseJobState(claudeJobDir: string | null | undefined): ClaudeJobDirState | null {
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
  return parsed as ClaudeJobDirState;
}

/**
 * Extract the session UUID from a `linkScanPath` value: the basename minus its
 * extension, validated against `SESSION_ID_RE` so a path-traversing value is
 * never accepted. Returns null when absent or invalid.
 */
function sessionIdFromLinkScanPath(linkScanPath: unknown): string | null {
  if (typeof linkScanPath !== 'string' || linkScanPath.length === 0) return null;
  const file = basename(linkScanPath);
  const dot = file.lastIndexOf('.');
  const sid = dot > 0 ? file.slice(0, dot) : file;
  return SESSION_ID_RE.test(sid) ? sid : null;
}

/**
 * Try to resolve the session_id synchronously from `CLAUDE_JOB_DIR/state.json`.
 * Returns the validated session_id or null.
 */
export function resolveFromJobDir(claudeJobDir: string | null | undefined): string | null {
  const parsed = readAndParseJobState(claudeJobDir);
  if (!parsed) return null;
  return sessionIdFromLinkScanPath(parsed.linkScanPath);
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
 * Sanitize a cwd into the single filename segment used both by the collector's
 * `writeCwdBreadcrumb()` (session-by-cwd breadcrumb) and by Claude Code's own
 * transcript-directory naming under `~/.claude/projects/`: backslash, forward
 * slash, and colon each become `-`. Must stay identical to
 * `collector-script.ts` so both sides derive the same filename independently.
 * Colons are stripped so a Windows drive letter (e.g. `C:`) never survives into
 * a filename where `path.resolve()` on win32 would reinterpret it as a
 * drive-relative component and read/write outside the intended directory.
 */
export function sanitizeCwdForFilename(cwd: string): string {
  return cwd.replace(/[\\/:]/g, '-');
}

/**
 * Try to resolve the session_id synchronously from the cwd breadcrumb file.
 * Fallback for platforms where the PPID breadcrumb never matches (see the
 * module doc comment above). Returns the validated session_id or null.
 */
export function resolveFromCwd(storagePath: string, cwd: string | undefined): string | null {
  if (typeof cwd !== 'string' || cwd.length === 0) return null;
  const sanitizedCwd = sanitizeCwdForFilename(cwd);
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

// ---------------------------------------------------------------------------
// Session naming
//
// Replaces cwd-basename naming (which labels every session in a repo
// identically) with Claude Code's own per-session human-readable titles. Two
// name sources, both authored by Claude Code:
//   1. The background-job state file (CLAUDE_JOB_DIR/state.json) — present only
//      for background jobs; carries a possibly human-authored `name`.
//   2. The transcript JSONL (universal) — carries `ai-title` records that
//      Claude Code refines over the session.
// `resolveSessionName` combines them into a single precedence decision.
// ---------------------------------------------------------------------------

/** Where a resolved session name came from, most trusted first. */
export type SessionNameSource = 'user' | 'ai-title' | 'auto' | 'cwd';

/**
 * The naming-relevant fields read out of `CLAUDE_JOB_DIR/state.json`.
 * `sessionId`/`name`/`nameSource` are labels; `intent` is CONTENT.
 */
export interface JobState {
  /** Full session UUID, from the explicit `sessionId` field or `linkScanPath`. */
  readonly sessionId: string | null;
  /** Human-readable title Claude Code wrote for the job. */
  readonly name: string | null;
  /** Whether a human named it (`user`) or Claude auto-generated it (`auto`). */
  readonly nameSource: 'user' | 'auto' | null;
  /**
   * SENSITIVE (CONTENT): the job's first user prompt. Populated ONLY when
   * `readJobState` is called with `{ recordContent: true }`; otherwise null,
   * so the sensitive field is off by construction rather than by convention.
   * Because `recordContent` is force-disabled under highSecurity upstream
   * (never bypass), passing `config.recordContent` keeps intent null in high
   * security mode automatically. Even when populated it is returned verbatim,
   * so any consumer MUST still pass it through `redactSensitive()` before it
   * reaches a log, NR event, tool response, or persisted file. Phase-1 wiring
   * reads `name`/`nameSource` only and never requests or forwards `intent`.
   */
  readonly intent: string | null;
}

/**
 * Read the naming fields from `CLAUDE_JOB_DIR/state.json`. Sibling to
 * `resolveFromJobDir` (whose `string | null` contract is unchanged) — returns
 * null when there is no readable state file. `sessionId` prefers an explicit
 * `sessionId` field, falling back to the UUID embedded in `linkScanPath`.
 *
 * The sensitive `intent` (first-prompt CONTENT) is populated ONLY when
 * `options.recordContent === true`; it is null otherwise. This gates the
 * content field by construction (mirroring `DecisionTracker`'s `recordContent`
 * gate) so a future consumer that copies the `name`/`nameSource` wiring cannot
 * leak prompt content by simply reading `.intent`. Pass `config.recordContent`
 * (already force-disabled under highSecurity) to stay compliant; the `name`/
 * `nameSource` display labels are never gated.
 */
export function readJobState(
  claudeJobDir: string | null | undefined,
  options?: { readonly recordContent?: boolean },
): JobState | null {
  const parsed = readAndParseJobState(claudeJobDir);
  if (!parsed) return null;

  const sessionId =
    typeof parsed.sessionId === 'string' && SESSION_ID_RE.test(parsed.sessionId)
      ? parsed.sessionId
      : sessionIdFromLinkScanPath(parsed.linkScanPath);
  const name = typeof parsed.name === 'string' && parsed.name.length > 0 ? parsed.name : null;
  const nameSource =
    parsed.nameSource === 'user' || parsed.nameSource === 'auto' ? parsed.nameSource : null;
  const intent =
    options?.recordContent === true && typeof parsed.intent === 'string' && parsed.intent.length > 0
      ? parsed.intent
      : null;

  return { sessionId, name, nameSource, intent };
}

// Bounded transcript reads: scan at most this many bytes back from EOF, one
// chunk at a time, to find the last `ai-title`. A degenerate huge transcript
// with no title in its tail costs at most MAX_SCAN_BYTES of IO, never the
// whole file.
const TRANSCRIPT_TITLE_CHUNK_BYTES = 64 * 1024;
const TRANSCRIPT_TITLE_MAX_SCAN_BYTES = 1024 * 1024;

/** The one transcript record shape we care about here. */
interface TranscriptTitleLine {
  readonly type?: unknown;
  readonly aiTitle?: unknown;
}

/**
 * Scan `text` (a suffix of a transcript JSONL file) for the LAST `ai-title`
 * record and return its `aiTitle` (raw, unredacted — the caller redacts).
 * `firstFragmentComplete` must be true only when `text` begins exactly at a
 * file/line boundary; otherwise the substring before the first newline is a
 * partial line whose start lies in an earlier, unread region and is skipped.
 * Scanning newest-first means the first match is the file's last `ai-title`.
 */
export function findLastAiTitleInText(text: string, firstFragmentComplete: boolean): string | null {
  const parts = text.split('\n');
  for (let i = parts.length - 1; i >= 0; i--) {
    if (i === 0 && !firstFragmentComplete) break; // partial leading line — its start is unread
    const line = parts[i]!;
    if (line.length === 0) continue;
    // Cheap pre-filter: `ai-title` records are rare, so skip JSON.parse unless
    // the marker is present at all.
    if (!line.includes('"ai-title"')) continue;
    let parsed: TranscriptTitleLine;
    try {
      parsed = JSON.parse(line) as TranscriptTitleLine;
    } catch {
      continue;
    }
    if (
      parsed.type === 'ai-title' &&
      typeof parsed.aiTitle === 'string' &&
      parsed.aiTitle.length > 0
    ) {
      return parsed.aiTitle;
    }
  }
  return null;
}

/**
 * Locate a session's transcript file under `<projectsDir>/<slug>/<sessionId>.jsonl`.
 *
 * Claude Code names each project subdirectory with a slug derived from the cwd,
 * but that scheme is NOT the same as our breadcrumb `sanitizeCwdForFilename`
 * (Claude Code also replaces `.` — so `/repo/.claude/wt` becomes
 * `-repo--claude-wt`). Rather than mirror an undocumented slug scheme that can
 * drift, we exploit the fact that a session id is a UUID — globally unique
 * across every project slug — and find the one subdirectory that contains
 * `<sessionId>.jsonl`. Returns the first match, or null.
 */
function findTranscriptPath(projectsDir: string, sessionId: string): string | null {
  const fileName = `${sessionId}.jsonl`;
  let entries: string[];
  try {
    entries = readdirSync(projectsDir);
  } catch (err) {
    logger.debug('projects dir unreadable', { error: String(err) });
    return null;
  }
  for (const entry of entries) {
    const candidate = resolve(projectsDir, entry, fileName);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Read the last `ai-title` from a session's transcript JSONL, redacted.
 * Locates the transcript by matching `<sessionId>.jsonl` under any project slug
 * (see `findTranscriptPath` — robust to Claude Code's cwd-slug scheme). Reads
 * BOUNDED — reverse-scans the file's tail one chunk at a time up to
 * `TRANSCRIPT_TITLE_MAX_SCAN_BYTES`, never slurping the whole file. Returns null
 * on any miss (no file, no title, bad sessionId) and never throws.
 *
 * @param projectsDir Override for `~/.claude/projects` (test seam).
 */
export function readTranscriptTitle(input: {
  readonly projectsDir?: string;
  readonly sessionId: string;
}): string | null {
  const { sessionId } = input;
  if (!SESSION_ID_RE.test(sessionId)) return null;

  const projectsDir = input.projectsDir ?? resolve(homedir(), '.claude', 'projects');
  const transcriptPath = findTranscriptPath(projectsDir, sessionId);
  if (transcriptPath === null) return null;

  let fd: number;
  let size: number;
  try {
    size = statSync(transcriptPath).size;
    if (size === 0) return null;
    fd = openSync(transcriptPath, fsConstants.O_RDONLY);
  } catch (err) {
    logger.debug('transcript unreadable', { error: String(err) });
    return null;
  }

  try {
    let pos = size;
    // Accumulate raw chunks and decode the contiguous tail as ONE buffer each
    // iteration, so a multi-byte UTF-8 sequence straddling a 64KB chunk
    // boundary is decoded intact — decoding each chunk in isolation would
    // corrupt a straddling character to U+FFFD on both sides.
    const chunks: Buffer[] = [];
    while (pos > 0 && size - pos < TRANSCRIPT_TITLE_MAX_SCAN_BYTES) {
      const chunkSize = Math.min(TRANSCRIPT_TITLE_CHUNK_BYTES, pos);
      pos -= chunkSize;
      const buffer = Buffer.alloc(chunkSize);
      const bytesRead = readSync(fd, buffer, 0, chunkSize, pos);
      chunks.unshift(bytesRead === chunkSize ? buffer : buffer.subarray(0, bytesRead));
      const acc = Buffer.concat(chunks).toString('utf-8');
      // `pos === 0` means `acc` now starts at the file head, so its first line
      // is complete; otherwise the leading fragment is partial and skipped.
      const title = findLastAiTitleInText(acc, pos === 0);
      if (title !== null) return redactSensitive(title);
    }
    return null;
  } catch (err) {
    logger.debug('transcript read failed', { error: String(err) });
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Directory basenames too generic to serve as a session label. Single source
 * of truth for the guard `SessionTracker`'s streaming cwd fallback also uses. A
 * degenerate startup cwd yields no authoritative `cwd` name (step 4 falls
 * through to null), leaving the tracker's streaming fallback free to upgrade to
 * a better name from a later tool call's cwd.
 */
export const DEGENERATE_NAMES: ReadonlySet<string> = new Set([
  'tmp',
  'temp',
  'var',
  'usr',
  'opt',
  'home',
  '.',
  '..',
  '',
]);

/** Inputs to the pure `resolveSessionName` precedence decision. */
export interface ResolveSessionNameInputs {
  /** Parsed background-job state, from `readJobState` (null if none). */
  readonly jobState?: JobState | null;
  /** Last transcript `ai-title`, from `readTranscriptTitle` (null if none). */
  readonly transcriptTitle?: string | null;
  /** Working directory, for the basename fallback. */
  readonly cwd?: string | null;
}

/** A resolved session name plus which source produced it. */
export interface SessionNameResult {
  readonly name: string;
  readonly source: SessionNameSource;
}

/**
 * Pure precedence decision for a session's display name (first hit wins):
 *   1. state.json `name` where `nameSource === 'user'`  → `user`
 *   2. transcript last `ai-title`                        → `ai-title`
 *   3. state.json `name` where `nameSource === 'auto'`   → `auto`
 *   4. basename(cwd), unless degenerate                  → `cwd`
 *   5. null
 * Does no IO and gates on nothing: callers pass already-read values and redact
 * the returned name at each sink.
 */
export function resolveSessionName(inputs: ResolveSessionNameInputs): SessionNameResult | null {
  const jobState = inputs.jobState ?? null;

  if (jobState && jobState.nameSource === 'user' && jobState.name) {
    return { name: jobState.name, source: 'user' };
  }
  if (inputs.transcriptTitle && inputs.transcriptTitle.length > 0) {
    return { name: inputs.transcriptTitle, source: 'ai-title' };
  }
  if (jobState && jobState.nameSource === 'auto' && jobState.name) {
    return { name: jobState.name, source: 'auto' };
  }
  const cwd = inputs.cwd;
  if (typeof cwd === 'string' && cwd.length > 0) {
    const base = basename(cwd);
    if (base.length > 0 && !DEGENERATE_NAMES.has(base.toLowerCase())) {
      return { name: base, source: 'cwd' };
    }
  }
  return null;
}

/**
 * Trust rank of a session-name source; LOWER is more trusted. Mirrors
 * `resolveSessionName`'s precedence exactly: `user`(0) > `ai-title`(1) >
 * `auto`(2) > `cwd`(3). Used to decide whether a freshly re-resolved name may
 * replace the one already in place (see `shouldReplaceSessionName`).
 */
export function sessionNameSourceRank(source: SessionNameSource): number {
  switch (source) {
    case 'user':
      return 0;
    case 'ai-title':
      return 1;
    case 'auto':
      return 2;
    case 'cwd':
      return 3;
  }
}

/**
 * Whether a re-resolved name from `next` should replace a name currently
 * sourced from `current`. Freshness re-resolution (Phase 2) re-reads Claude
 * Code's name sources at persist/shutdown time so a refined `ai-title` — or a
 * name a human later assigns — supersedes the first-prompt guess.
 *
 * Replaces only when `next` is at least as trusted as `current`
 * (`rank(next) <= rank(current)`): an equal-or-better source wins (which also
 * picks up refined text for the SAME source, e.g. an updated `ai-title`),
 * while a strictly-less-trusted source is refused. That refusal is the
 * load-bearing invariant: a `user`-sourced name is NEVER downgraded to
 * `auto`/`cwd`, even if the job-state file that supplied it later disappears
 * and re-resolution would otherwise fall through to the transcript title or
 * the cwd basename. A `null` current source (session not yet named) always
 * accepts.
 */
export function shouldReplaceSessionName(
  current: SessionNameSource | null,
  next: SessionNameSource,
): boolean {
  if (current === null) return true;
  return sessionNameSourceRank(next) <= sessionNameSourceRank(current);
}
