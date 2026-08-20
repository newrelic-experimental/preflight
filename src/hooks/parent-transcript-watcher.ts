/**
 * Parent Transcript Watcher — polls a Claude Code session's own main
 * transcript and emits one `mode: 'token'` line per real assistant turn into
 * that session's hook buffer.
 *
 * Replaces the old hook-triggered scanner in collector-script.ts
 * (`collectTranscriptTokens`/`readLastAssistantUsage`), which only ran when a
 * PreToolUse/PostToolUse hook fired and even then returned only the single
 * most recent assistant-with-usage entry. Any turn producing no tool call
 * never triggered a hook at all, and any turn superseded by another before
 * the next hook fired was silently and permanently dropped. This watcher is
 * independent of tool-call timing entirely — it tails the transcript on its
 * own interval via a durable byte cursor, mirroring `SubagentWatcher`, so
 * every real turn is captured regardless of whether it called a tool.
 *
 * Discovery differs from `SubagentWatcher`: a main transcript lives directly
 * at `<projectsDir>/<projectDir>/<sessionId>.jsonl` (flat file under the
 * project dir), not nested under a `subagents/` subdirectory. In scoped mode
 * (`parentSessionId` set — the `--stdio` case) the resolved path is cached
 * after first discovery, since a session's own transcript path never moves.
 *
 * Cursor durability: byte cursor persisted to
 * `~/.newrelic-preflight/.parent-transcript-pos-<sessionId>` survives
 * restart. On crash mid-emit the next poll re-reads from the previous cursor
 * → potential duplicates, which downstream dedupes by (sessionId, messageId)
 * in `HookEventProcessor.handleTokenEvent()`.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { createLogger } from '../shared/index.js';
import type { LocalStore } from '../storage/local-store.js';
import type { RawTranscriptEntry, RawAssistantMessage, RawUsage } from './transcript-types.js';

const logger = createLogger('parent-transcript-watcher');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_DISCOVERY_HOURS = 24;
const MAX_BYTES_PER_POLL = 64 * 1024;
/** See SubagentWatcher's identical constant for the OOM-bug rationale this guards against. */
const MAX_PARTIAL_LINE_BYTES = 1024 * 1024; // 1 MiB
const SESSION_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const PROJECTS_DIR_NAME = '.claude/projects';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParentTranscriptWatcherOptions {
  /** Storage path for cursor state (defaults to ~/.newrelic-preflight). */
  readonly storagePath?: string;
  /** ~/.claude/projects directory; defaults to homedir-relative. */
  readonly projectsDir?: string;
  /** Poll interval in ms. Default 2000. */
  readonly pollIntervalMs?: number;
  /** Cold-scan eligibility window for unfiltered mode. Default 24h. */
  readonly discoveryHours?: number;
  /** LocalStore, used to exclude sessions already owned by a live --stdio watcher in unfiltered mode. */
  readonly localStore?: LocalStore;
  /**
   * If provided, watcher only processes this one session's transcript.
   * Default: process every session id under projectsDir (matches `--local`
   * unscoped semantics).
   */
  readonly parentSessionId?: string;
}

interface ParsedParentTurn {
  readonly timestampMs: number;
  readonly messageId: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
}

interface CursorState {
  readonly bytePos: number;
  readonly partialLine: string;
  /**
   * The resolved transcript path this byte offset belongs to. The cursor file
   * is keyed by sessionId alone, but the canonical file for a sessionId can
   * switch (repo rename → newest-mtime copy under a different project dir). A
   * byte offset from the previous file is meaningless against the new one, so
   * `processFile` resets to a fresh cursor when this differs from the file it
   * is about to read. Undefined for a cursor file written before this field
   * existed (no reset — it keeps its existing offset, exactly as before).
   */
  readonly path?: string;
}

export interface ParentTranscriptWatcherHealth {
  readonly filesWatched: number;
  readonly linesRead: number;
  readonly bytesRead: number;
  readonly parseErrors: number;
}

// ---------------------------------------------------------------------------
// ParentTranscriptWatcher
// ---------------------------------------------------------------------------

export class ParentTranscriptWatcher {
  private readonly storagePath: string;
  private readonly projectsDir: string;
  private readonly pollIntervalMs: number;
  private readonly discoveryHours: number;
  private readonly parentSessionFilter: string | null;
  private readonly localStore: LocalStore | undefined;

  private intervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;

  // Scoped-mode only: a session's transcript path never moves once found, so
  // caching it avoids re-scanning every project dir on every poll for the
  // life of a session (unlike SubagentWatcher, which must rescan every poll
  // since new subagent files can appear at any time).
  private cachedScopedPath: string | null = null;

  private readonly partialByPath = new Map<string, string>();
  private readonly decoderByPath = new Map<string, StringDecoder>();

  private filesWatched = 0;
  private linesRead = 0;
  private bytesRead = 0;
  private parseErrors = 0;

  constructor(options: ParentTranscriptWatcherOptions = {}) {
    this.storagePath = options.storagePath ?? join(homedir(), '.newrelic-preflight');
    this.projectsDir = options.projectsDir ?? join(homedir(), PROJECTS_DIR_NAME);
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const envHours = parseInt(process.env.NR_AI_WATCHER_DISCOVERY_HOURS ?? '', 10);
    this.discoveryHours =
      options.discoveryHours ??
      (Number.isFinite(envHours) && envHours > 0 ? envHours : DEFAULT_DISCOVERY_HOURS);
    this.parentSessionFilter = options.parentSessionId ?? null;
    this.localStore = options.localStore;
  }

  start(): void {
    if (this.running) {
      logger.warn('ParentTranscriptWatcher already running');
      return;
    }
    this.running = true;
    if (!existsSync(this.storagePath)) {
      mkdirSync(this.storagePath, { recursive: true, mode: 0o700 });
    }
    this.intervalId = setInterval(() => this.poll(), this.pollIntervalMs);
    this.intervalId.unref();
    logger.info('ParentTranscriptWatcher started', {
      pollIntervalMs: this.pollIntervalMs,
      discoveryHours: this.discoveryHours,
      projectsDir: this.projectsDir,
      scoped: this.parentSessionFilter !== null,
    });
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    logger.info('ParentTranscriptWatcher stopped');
  }

  /**
   * Single poll cycle. Public so tests can drive deterministically without
   * waiting on the interval timer.
   */
  poll(): void {
    try {
      const files = this.discoverFiles();
      this.filesWatched = files.length;
      for (const file of files) {
        this.processFile(file.path, file.sessionId);
      }
      this.evictStalePartials(files);
    } catch (err) {
      this.recordError(err);
    }
  }

  /** Public snapshot of watcher health counters, for tests and future dashboard wiring. */
  getHealthStats(): ParentTranscriptWatcherHealth {
    return {
      filesWatched: this.filesWatched,
      linesRead: this.linesRead,
      bytesRead: this.bytesRead,
      parseErrors: this.parseErrors,
    };
  }

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  private discoverFiles(): Array<{ path: string; sessionId: string }> {
    if (this.parentSessionFilter) {
      const path = this.resolveScopedPath();
      return path ? [{ path, sessionId: this.parentSessionFilter }] : [];
    }
    return this.discoverUnfiltered();
  }

  /**
   * Scoped mode: locate the one known session's own transcript by scanning
   * every top-level project dir for `<sessionId>.jsonl` — deliberately not
   * derived from cwd, since a cwd-derived dashed dir name breaks under git
   * worktrees (the same reason collector-script.ts's retired getTranscriptPath()
   * preferred the hook's transcript_path field, which this watcher has no
   * access to).
   *
   * When the sessionId exists under more than one project dir (a repo rename
   * leaves the old dir's copy behind), pick the newest-mtime copy — the same
   * canonical-selection rule discoverUnfiltered() uses — rather than the first
   * arbitrary readdir match, which was nondeterministic and could freeze onto
   * the stale copy. Cached after first success for poll-loop efficiency; a
   * rename that occurs AFTER this cache is warmed is followed on the next
   * process restart (the path-aware cursor then resets cleanly onto the new
   * file). Mid-session re-resolution is intentionally not attempted here to
   * avoid flip-flopping between two concurrently-touched copies.
   */
  private resolveScopedPath(): string | null {
    if (this.cachedScopedPath && existsSync(this.cachedScopedPath)) {
      return this.cachedScopedPath;
    }
    const sessionId = this.parentSessionFilter;
    if (!sessionId || !existsSync(this.projectsDir)) return null;
    let entries: string[];
    try {
      entries = readdirSync(this.projectsDir);
    } catch (err) {
      this.recordError(err);
      return null;
    }
    let best: { path: string; mtimeMs: number } | null = null;
    for (const project of entries) {
      const candidate = join(this.projectsDir, project, `${sessionId}.jsonl`);
      try {
        const st = statSync(candidate);
        if (!st.isFile()) continue;
        if (
          best === null ||
          st.mtimeMs > best.mtimeMs ||
          (st.mtimeMs === best.mtimeMs && candidate < best.path)
        ) {
          best = { path: candidate, mtimeMs: st.mtimeMs };
        }
      } catch {
        /* not in this project dir */
      }
    }
    if (best === null) return null; // not created yet — Claude Code creates it lazily
    this.cachedScopedPath = best.path;
    return best.path;
  }

  /**
   * Unfiltered (--local) mode: discover every session's main transcript
   * across all project dirs, excluding sessions already owned by a live
   * --stdio heartbeat — identical race-avoidance to SubagentWatcher's
   * unfiltered discovery, so the two processes never fight over the same
   * cursor file.
   */
  private discoverUnfiltered(): Array<{ path: string; sessionId: string }> {
    if (!existsSync(this.projectsDir)) return [];
    const cutoffMs = Date.now() - this.discoveryHours * 60 * 60 * 1000;
    const liveOwnedSessionIds = this.localStore?.getActiveSessionIdsFromHeartbeats() ?? null;

    let projectEntries: string[];
    try {
      projectEntries = readdirSync(this.projectsDir);
    } catch (err) {
      this.recordError(err);
      return [];
    }
    // The same sessionId can exist under MORE THAN ONE project dir — Claude Code
    // creates a new project-slug directory when a repo is renamed/moved, and the
    // old dir's `<sessionId>.jsonl` lingers with divergent content. Since the
    // byte cursor is keyed by sessionId alone (cursorPath), reading two files
    // for one sessionId would apply one file's byte offset to the other's
    // unrelated bytes — re-parsing mismatched turns and inflating token/cost
    // totals (observed: a resumed session double-counted across two project
    // dirs). Keep only the newest-mtime copy per sessionId: after a rename the
    // stale dir stops being written, so newest === the active, canonical file.
    const canonicalBySession = new Map<string, { path: string; mtimeMs: number }>();
    for (const project of projectEntries) {
      const projectPath = join(this.projectsDir, project);
      let entries: string[];
      try {
        entries = readdirSync(projectPath);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (!name.endsWith('.jsonl')) continue;
        const sessionId = name.slice(0, -'.jsonl'.length);
        if (!SESSION_ID_RE.test(sessionId)) continue;
        if (liveOwnedSessionIds?.has(sessionId)) continue;
        const path = join(projectPath, name);
        let st;
        try {
          st = statSync(path);
        } catch {
          continue;
        }
        if (!st.isFile() || st.mtimeMs < cutoffMs) continue;
        const existing = canonicalBySession.get(sessionId);
        // Newest mtime wins; on an exact mtime tie (mtime-preserving
        // copy/restore, coarse-resolution FS, same-second writes) break
        // deterministically by lexicographically-smallest path so the choice
        // is stable across platforms/runs rather than following readdir order.
        if (
          existing === undefined ||
          st.mtimeMs > existing.mtimeMs ||
          (st.mtimeMs === existing.mtimeMs && path < existing.path)
        ) {
          canonicalBySession.set(sessionId, { path, mtimeMs: st.mtimeMs });
        }
      }
    }
    const out: Array<{ path: string; sessionId: string }> = [];
    for (const [sessionId, { path }] of canonicalBySession) {
      out.push({ path, sessionId });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Per-file processing
  // -------------------------------------------------------------------------

  private processFile(path: string, sessionId: string): void {
    let size: number;
    try {
      size = statSync(path).size;
    } catch (err) {
      this.recordError(err);
      return;
    }

    const cursorPath = this.cursorPath(sessionId);
    const persisted = this.readCursor(cursorPath);
    // If the canonical copy for this sessionId switched project dirs since the
    // last poll (repo rename → newest-mtime copy now wins in discovery), the
    // persisted byte offset belongs to the OLD file and is meaningless against
    // this one. Start fresh so the new file is read from the top; the
    // event-processor dedupes any shared-history turns by (sessionId,
    // messageId), and day-bucketing attributes each re-read turn to its real
    // transcript-timestamp day, so "spend today" is unaffected.
    const switchedFile = persisted.path !== undefined && persisted.path !== path;
    const startCursor: CursorState = switchedFile
      ? { bytePos: 0, partialLine: '', path }
      : persisted;
    if (switchedFile) this.partialByPath.delete(path);
    if (startCursor.bytePos >= size) return;

    const remaining = size - startCursor.bytePos;
    const toRead = Math.min(remaining, MAX_BYTES_PER_POLL);
    let buf: Buffer;
    let actuallyRead = 0;
    let fd: number | null = null;
    try {
      fd = openSync(path, 'r');
      buf = Buffer.allocUnsafe(toRead);
      actuallyRead = readSync(fd, buf, 0, toRead, startCursor.bytePos);
    } catch (err) {
      this.recordError(err);
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          /* ignore */
        }
      }
      return;
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }
    if (actuallyRead === 0) return;

    let decoder = this.decoderByPath.get(path);
    if (decoder === undefined) {
      decoder = new StringDecoder('utf-8');
      this.decoderByPath.set(path, decoder);
    }
    const chunk = decoder.write(buf.subarray(0, actuallyRead));
    this.bytesRead += actuallyRead;

    const carried = this.partialByPath.get(path) ?? startCursor.partialLine;
    const combined = carried + chunk;

    // The byte cursor ALWAYS advances by the bytes just read — see
    // SubagentWatcher.processFile()'s identical comment for the OOM bug this
    // invariant fixes (advancing only to the last newline can freeze the
    // cursor forever on an oversized line).
    const nextBytePos = startCursor.bytePos + actuallyRead;

    const lastNewline = combined.lastIndexOf('\n');
    let lines: string[] = [];
    let newPartial = combined;
    if (lastNewline >= 0) {
      lines = combined.slice(0, lastNewline).split('\n');
      newPartial = combined.slice(lastNewline + 1);
    }

    if (newPartial.length > MAX_PARTIAL_LINE_BYTES) {
      newPartial = '';
      this.parseErrors += 1;
    }

    for (const line of lines) {
      if (!line) continue;
      this.linesRead += 1;
      const parsed = this.tryParseLine(line);
      if (parsed === null) continue;

      const event: Record<string, unknown> = {
        mode: 'token',
        tool: 'transcript',
        timestamp: parsed.timestampMs,
        sessionId,
        messageId: parsed.messageId,
        model: parsed.model,
        inputTokens: parsed.inputTokens,
        outputTokens: parsed.outputTokens,
        cacheReadTokens: parsed.cacheReadTokens,
        cacheCreationTokens: parsed.cacheCreationTokens,
      };
      this.appendToParentBuffer(sessionId, event);
    }

    this.writeCursor(cursorPath, nextBytePos, newPartial, path);
    if (newPartial.length > 0) {
      this.partialByPath.set(path, newPartial);
    } else {
      this.partialByPath.delete(path);
    }
  }

  /**
   * Drop in-memory partial-line state for files no longer discovered this
   * poll (e.g. an aged-out or removed session), bounding partialByPath by the
   * live file set. The persisted cursor is left untouched.
   */
  private evictStalePartials(files: Array<{ path: string; sessionId: string }>): void {
    if (this.partialByPath.size === 0 && this.decoderByPath.size === 0) return;
    const live = new Set<string>();
    for (const f of files) live.add(f.path);
    for (const path of this.partialByPath.keys()) {
      if (!live.has(path)) this.partialByPath.delete(path);
    }
    for (const path of this.decoderByPath.keys()) {
      if (!live.has(path)) this.decoderByPath.delete(path);
    }
  }

  /**
   * Parse a JSONL line, returning non-null only for a real, non-sidechain
   * assistant turn with a usable model, message id, and usage object.
   */
  private tryParseLine(line: string): ParsedParentTurn | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.parseErrors += 1;
      return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as RawTranscriptEntry;
    if (obj.type !== 'assistant') return null;
    // Subagent turns are inlined into the main transcript too — skip them so
    // they're never double-attributed as parent-session cost. Mirrors
    // TranscriptMessageTracker.isRealAssistantEntry()'s identical check.
    if (obj.isSidechain === true) return null;
    const message = obj.message;
    if (!message || typeof message !== 'object') return null;
    const m = message as RawAssistantMessage;
    const model = typeof m.model === 'string' ? m.model : null;
    if (!model || model === '<synthetic>') return null;
    const messageId = typeof m.id === 'string' ? m.id : null;
    if (!messageId) return null;
    const usage = m.usage;
    if (!usage || typeof usage !== 'object') return null;
    const u = usage as RawUsage;

    const tsRaw = typeof obj.timestamp === 'string' ? obj.timestamp : null;
    const timestampMs = tsRaw ? Date.parse(tsRaw) : Date.now();
    if (!Number.isFinite(timestampMs)) return null;

    return {
      timestampMs,
      messageId,
      model,
      inputTokens: num(u.input_tokens),
      outputTokens: num(u.output_tokens),
      cacheReadTokens: num(u.cache_read_input_tokens),
      cacheCreationTokens: num(u.cache_creation_input_tokens),
    };
  }

  // -------------------------------------------------------------------------
  // Buffer + cursor I/O
  // -------------------------------------------------------------------------

  private cursorPath(sessionId: string): string {
    return join(this.storagePath, `.parent-transcript-pos-${sessionId}`);
  }

  private readCursor(cursorPath: string): CursorState {
    if (!existsSync(cursorPath)) return { bytePos: 0, partialLine: '' };
    try {
      const raw = readFileSync(cursorPath, 'utf-8').trim();
      const parsed = JSON.parse(raw);
      const bytePos =
        typeof parsed.bytePos === 'number' && parsed.bytePos >= 0 ? parsed.bytePos : 0;
      const partialLine = typeof parsed.partialLine === 'string' ? parsed.partialLine : '';
      const path = typeof parsed.path === 'string' ? parsed.path : undefined;
      return { bytePos, partialLine, path };
    } catch {
      return { bytePos: 0, partialLine: '' };
    }
  }

  private writeCursor(
    cursorPath: string,
    bytePos: number,
    partialLine: string,
    sourcePath: string,
  ): void {
    try {
      if (!existsSync(this.storagePath)) {
        mkdirSync(this.storagePath, { recursive: true, mode: 0o700 });
      }
      const dir = dirname(cursorPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(cursorPath, JSON.stringify({ bytePos, partialLine, path: sourcePath }), {
        mode: 0o600,
      });
    } catch (err) {
      this.recordError(err);
    }
  }

  /**
   * Append to the session's own buffer file. Mirrors the path-naming used by
   * `LocalStore`/`SubagentWatcher` so `HookEventProcessor.poll()` picks it up.
   */
  private appendToParentBuffer(sessionId: string, event: object): void {
    const path = join(this.storagePath, `buffer-${sessionId}.jsonl`);
    try {
      if (!existsSync(this.storagePath)) {
        mkdirSync(this.storagePath, { recursive: true, mode: 0o700 });
      }
      appendFileSync(path, JSON.stringify(event) + '\n', { mode: 0o600 });
    } catch (err) {
      this.recordError(err);
    }
  }

  private recordError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('ParentTranscriptWatcher error', { message: message.slice(0, 200) });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

/**
 * Stable cursor file path computation, exported for tests that want to
 * inspect cursor state without instantiating the watcher.
 */
export function buildParentTranscriptCursorPath(storagePath: string, sessionId: string): string {
  return resolve(storagePath, `.parent-transcript-pos-${sessionId}`);
}
