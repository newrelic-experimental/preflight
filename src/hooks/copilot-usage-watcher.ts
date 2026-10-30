/**
 * Copilot Usage Watcher — polls VS Code Copilot agent debug logs and emits
 * one `mode: 'token'` line per LLM request into the session's hook buffer,
 * giving Copilot sessions token-exact cost (the same fidelity
 * ParentTranscriptWatcher gives Claude Code sessions) instead of
 * content-size estimation.
 *
 * Source of truth: VS Code writes per-request records to
 * `<userDataDir>/workspaceStorage/<hash>/GitHub.copilot-chat/debug-logs/<sessionId>/main.jsonl`,
 * where `<sessionId>` is the same chat session id VS Code sends as
 * `session_id` in agent hook payloads — so events emitted here land in the
 * same `buffer-<sessionId>.jsonl` the hook collector writes to. Each usage
 * record is `{ type: 'llm_request', sid, ts, attrs: { model, inputTokens,
 * outputTokens, cachedTokens, responseId, copilotUsageNanoAiu, ... } }`.
 * This path + schema are produced by VS Code's `chatDebugFileLoggerService.ts`
 * (formerly `microsoft/vscode-copilot-chat`, now merged into
 * `microsoft/vscode` under `extensions/copilot/` and archived); the record
 * shape is documented in its `otel-data-flow.html` and cross-checked against a
 * real main.jsonl (VS Code 1.109 / Copilot Chat).
 * The hooks doc notes transcript/debug-log formats are not a stable API
 * (code.visualstudio.com/docs/copilot/customization/hooks) — same stability
 * tier as the Claude Code transcript format the parent/subagent watchers
 * already depend on; schema drift degrades to zero emissions, never a crash.
 *
 * Tailing/cursor mechanics mirror `ParentTranscriptWatcher`: durable byte
 * cursor per session (`.copilot-usage-pos-<sessionId>`), bounded reads per
 * poll, bounded partial-line carry, duplicate emissions after a crash are
 * deduped downstream by (sessionId, messageId) in
 * `HookEventProcessor.handleTokenEvent()` — `responseId` serves as the
 * message id.
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
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { createLogger } from '../shared/index.js';
import type { LocalStore } from '../storage/local-store.js';

const logger = createLogger('copilot-usage-watcher');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_DISCOVERY_HOURS = 24;
// Copilot debug-log lines embed full inputMessages payloads and routinely run
// hundreds of KiB — far larger than transcript lines. A bigger window keeps a
// single record from spanning many polls (each carry-over persists the whole
// partial line into the cursor file).
const MAX_BYTES_PER_POLL = 1024 * 1024;
/** See SubagentWatcher's identical constant for the OOM-bug rationale this guards against. */
const MAX_PARTIAL_LINE_BYTES = 4 * 1024 * 1024; // 4 MiB — sized to the larger log lines
// A line past the cap is not dropped: its head and tail windows are kept and
// the middle is elided, so memory stays bounded while the usage fields, which
// sit near the line's ends, are still extracted when the line completes.
const ELIDE_KEEP_CHARS = 64 * 1024;
// A raw JSONL line cannot contain a literal NUL, so the mark is unambiguous.
const ELIDE_MARK = '\u0000ELIDED\u0000';
// A replaced log is recognised by its first bytes, not its size or inode: a new
// file can be larger than the old cursor, and ext4 reuses freed inodes.
const FINGERPRINT_BYTES = 256;
const SESSION_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const COPILOT_LOG_SUBPATH = join('GitHub.copilot-chat', 'debug-logs');

/**
 * VS Code Remote (WSL, SSH, dev containers, Codespaces) `workspaceStorage`
 * roots. When the Copilot Chat extension runs in a remote extension host, it
 * writes debug logs under the server's user-data dir rather than the desktop
 * one, so these must be searched alongside the local roots or remote sessions
 * silently yield zero token events (and therefore $0.00 cost).
 */
function remoteWorkspaceStorageRoots(home: string): string[] {
  return ['.vscode-server', '.vscode-server-insiders', '.vscode-remote'].map((dir) =>
    join(home, dir, 'data', 'User', 'workspaceStorage'),
  );
}

/**
 * Default VS Code `workspaceStorage` roots per OS (stable + Insiders), plus
 * the remote-server roots used by WSL/SSH/dev-container sessions.
 * Sourced from VS Code's documented user-data locations
 * (code.visualstudio.com/docs/configure/command-line#_advanced-cli-options).
 */
export function defaultWorkspaceStorageRoots(): string[] {
  const home = homedir();
  const variants = ['Code', 'Code - Insiders'];
  const remote = remoteWorkspaceStorageRoots(home);
  if (process.platform === 'darwin') {
    return [
      ...variants.map((v) =>
        join(home, 'Library', 'Application Support', v, 'User', 'workspaceStorage'),
      ),
      ...remote,
    ];
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
    return [...variants.map((v) => join(appData, v, 'User', 'workspaceStorage')), ...remote];
  }
  return [...variants.map((v) => join(home, '.config', v, 'User', 'workspaceStorage')), ...remote];
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CopilotUsageWatcherOptions {
  /** Storage path for cursor state + buffers (defaults to ~/.newrelic-preflight). */
  readonly storagePath?: string;
  /** VS Code workspaceStorage roots to scan; defaults to per-OS conventions. */
  readonly workspaceStorageRoots?: string[];
  /** Poll interval in ms. Default 2000. */
  readonly pollIntervalMs?: number;
  /** Cold-scan eligibility window (mtime) for discovered logs. Default 24h. */
  readonly discoveryHours?: number;
  /**
   * If provided, only this session's debug log is processed (the `--stdio`
   * case). Default: every recent session log (matches `--local` semantics).
   */
  readonly parentSessionId?: string;
  /** LocalStore, used to exclude sessions already owned by a live --stdio watcher in unscoped mode. */
  readonly localStore?: LocalStore;
}

export interface CopilotUsageWatcherHealth {
  readonly filesWatched: number;
  readonly linesRead: number;
  readonly bytesRead: number;
  readonly parseErrors: number;
  /**
   * True when at least one VS Code workspaceStorage root exists but no Copilot
   * `debug-logs` directory was found in any of them — the signature of the
   * off-by-default `github.copilot.chat.agentDebugLog.fileLogging.enabled`
   * setting. Lets callers distinguish "integration broken" from "prerequisite
   * not enabled" instead of silently reporting zero cost. False when no root
   * exists at all (VS Code absent / wrong OS path — cannot conclude).
   */
  readonly debugLoggingLikelyDisabled: boolean;
}

interface ParsedUsageRecord {
  readonly timestampMs: number;
  readonly sessionId: string | null;
  readonly responseId: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
}

interface CursorState {
  readonly bytePos: number;
  readonly partialLine: string;
  /** Base64 of the log's first bytes when last read. Absent in cursors written before it existed. */
  readonly fingerprint?: string;
}

// ---------------------------------------------------------------------------
// CopilotUsageWatcher
// ---------------------------------------------------------------------------

export class CopilotUsageWatcher {
  private readonly storagePath: string;
  private readonly workspaceStorageRoots: string[];
  private readonly pollIntervalMs: number;
  private readonly discoveryHours: number;
  private readonly parentSessionFilter: string | null;
  private readonly localStore: LocalStore | undefined;

  private intervalId: ReturnType<typeof setInterval> | null = null;
  private readonly bytePosBySession = new Map<string, number>();
  private readonly partialByPath = new Map<string, string>();
  private readonly decoderByPath = new Map<string, StringDecoder>();

  private filesWatched = 0;
  private linesRead = 0;
  private bytesRead = 0;
  private parseErrors = 0;
  private warnedElided = false;
  private debugLoggingLikelyDisabled = false;
  private warnedDebugLoggingDisabled = false;

  constructor(options: CopilotUsageWatcherOptions = {}) {
    this.storagePath = options.storagePath ?? join(homedir(), '.newrelic-preflight');
    this.workspaceStorageRoots = options.workspaceStorageRoots ?? defaultWorkspaceStorageRoots();
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.discoveryHours = options.discoveryHours ?? DEFAULT_DISCOVERY_HOURS;
    this.parentSessionFilter = options.parentSessionId ?? null;
    this.localStore = options.localStore;
  }

  start(): void {
    if (this.intervalId !== null) return;
    this.intervalId = setInterval(() => {
      try {
        this.poll();
      } catch (err) {
        this.recordError(err);
      }
    }, this.pollIntervalMs);
    this.intervalId.unref?.();
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  getHealth(): CopilotUsageWatcherHealth {
    return {
      filesWatched: this.filesWatched,
      linesRead: this.linesRead,
      bytesRead: this.bytesRead,
      parseErrors: this.parseErrors,
      debugLoggingLikelyDisabled: this.debugLoggingLikelyDisabled,
    };
  }

  /** One discovery + tail pass. Exported for direct testing. */
  poll(): void {
    const files = this.discoverFiles();
    this.filesWatched = files.length;
    this.evictStalePartials(files);
    for (const file of files) {
      try {
        this.tailFile(file.path, file.sessionId);
      } catch (err) {
        this.recordError(err);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  private discoverFiles(): Array<{ path: string; sessionId: string }> {
    const out: Array<{ path: string; sessionId: string }> = [];
    const cutoffMs = Date.now() - this.discoveryHours * 3_600_000;
    // Unscoped (--local) mode: skip sessions a live --stdio process already
    // tails, so two processes never race on the same cursor file — identical
    // to ParentTranscriptWatcher's unfiltered discovery.
    const liveOwnedSessionIds =
      this.parentSessionFilter === null
        ? (this.localStore?.getActiveSessionIdsFromHeartbeats() ?? null)
        : null;
    let anyRootExists = false;
    let anyDebugLogDir = false;
    for (const root of this.workspaceStorageRoots) {
      if (!existsSync(root)) continue;
      anyRootExists = true;
      let workspaceHashes: string[];
      try {
        workspaceHashes = readdirSync(root);
      } catch {
        continue;
      }
      for (const hash of workspaceHashes) {
        const logsDir = join(root, hash, COPILOT_LOG_SUBPATH);
        if (!existsSync(logsDir)) continue;
        anyDebugLogDir = true;
        let sessionDirs: string[];
        try {
          sessionDirs = readdirSync(logsDir);
        } catch {
          continue;
        }
        for (const sessionId of sessionDirs) {
          if (!SESSION_ID_RE.test(sessionId)) continue;
          if (this.parentSessionFilter !== null && sessionId !== this.parentSessionFilter) {
            continue;
          }
          if (liveOwnedSessionIds?.has(sessionId)) continue;
          const logPath = join(logsDir, sessionId, 'main.jsonl');
          try {
            const st = statSync(logPath);
            if (!st.isFile()) continue;
            // Scoped mode always tails its own session; unscoped applies the
            // recency window so old logs don't trigger unbounded cold scans.
            if (
              this.parentSessionFilter === null &&
              st.mtimeMs < cutoffMs &&
              !this.hasUnreadBytes(sessionId, st.size)
            ) {
              continue;
            }
          } catch {
            continue;
          }
          out.push({ path: logPath, sessionId });
        }
      }
    }
    // A VS Code install is present (root exists) yet no Copilot debug-logs
    // directory anywhere ⇒ the off-by-default fileLogging setting is almost
    // certainly not enabled. Warn once so a zero-cost session reads as a
    // missing prerequisite rather than a broken integration.
    this.debugLoggingLikelyDisabled = anyRootExists && !anyDebugLogDir;
    if (this.debugLoggingLikelyDisabled && !this.warnedDebugLoggingDisabled) {
      this.warnedDebugLoggingDisabled = true;
      logger.warn(
        'No Copilot debug-logs directory found; token-exact cost is unavailable. ' +
          'Enable "github.copilot.chat.agentDebugLog.fileLogging.enabled" in VS Code ' +
          'settings.json and reload the window.',
      );
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Tailing
  // -------------------------------------------------------------------------

  private tailFile(path: string, dirSessionId: string): void {
    const cursorPath = this.cursorPath(dirSessionId);
    const persisted = this.readCursor(cursorPath);
    const memPartial = this.partialByPath.get(path);
    let startCursor: CursorState =
      memPartial !== undefined ? { ...persisted, partialLine: memPartial } : persisted;

    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return;
    }
    let head: Buffer;
    try {
      head = readBytes(path, 0, Math.min(size, FINGERPRINT_BYTES));
    } catch (err) {
      this.recordError(err);
      return;
    }
    // Truncated or replaced file: restart from 0, and drop the carried partial
    // line and decoder state, which belong to the old file's bytes. A cursor
    // without a fingerprint can only detect truncation.
    const knownHead =
      startCursor.fingerprint === undefined ? null : Buffer.from(startCursor.fingerprint, 'base64');
    const replaced = knownHead !== null && !onePrefixesOther(head, knownHead);
    if (startCursor.bytePos > size || replaced) {
      startCursor = { bytePos: 0, partialLine: '' };
      this.partialByPath.delete(path);
      this.decoderByPath.delete(path);
    }
    const fingerprint = (
      knownHead !== null && !replaced && knownHead.length > head.length ? knownHead : head
    ).toString('base64');
    const fromPos = startCursor.bytePos;
    if (fromPos >= size) {
      this.bytePosBySession.set(dirSessionId, fromPos);
      return;
    }

    const toRead = Math.min(size - fromPos, MAX_BYTES_PER_POLL);
    let buf: Buffer;
    try {
      buf = readBytes(path, fromPos, toRead);
    } catch (err) {
      this.recordError(err);
      return;
    }
    const actuallyRead = buf.length;
    if (actuallyRead <= 0) {
      this.bytePosBySession.set(dirSessionId, fromPos);
      return;
    }
    this.bytesRead += actuallyRead;

    let decoder = this.decoderByPath.get(path);
    if (!decoder) {
      decoder = new StringDecoder('utf8');
      this.decoderByPath.set(path, decoder);
    }
    const combined = startCursor.partialLine + decoder.write(buf.subarray(0, actuallyRead));
    const nextBytePos = fromPos + actuallyRead;

    const lastNewline = combined.lastIndexOf('\n');
    let lines: string[] = [];
    let newPartial = combined;
    if (lastNewline >= 0) {
      lines = combined.slice(0, lastNewline).split('\n');
      newPartial = combined.slice(lastNewline + 1);
    }
    newPartial = elideOversize(newPartial);

    for (const line of lines) {
      if (!line) continue;
      this.linesRead += 1;
      const parsed = line.includes(ELIDE_MARK)
        ? this.parseElidedLine(line)
        : this.tryParseLine(line);
      if (parsed === null) continue;
      const sessionId = parsed.sessionId ?? dirSessionId;
      this.appendToBuffer(sessionId, {
        mode: 'token',
        tool: 'copilot-usage',
        timestamp: parsed.timestampMs,
        sessionId,
        messageId: parsed.responseId,
        model: parsed.model,
        // VS Code's inputTokens is cache-INCLUSIVE (verified against a real
        // main.jsonl: each request's cachedTokens ≈ the previous request's
        // inputTokens). CostTracker follows the Anthropic convention where
        // input excludes cache reads, so emit only the uncached remainder —
        // otherwise cached tokens are double-billed at full input rate.
        inputTokens: Math.max(0, parsed.inputTokens - parsed.cachedTokens),
        outputTokens: parsed.outputTokens,
        // `cachedTokens` is the only cache figure the debug-log schema exposes,
        // and it is cache-READ (confirmed against a real main.jsonl: it tracks
        // the previous request's input). KNOWN ESTIMATION GAP: VS Code does not
        // surface cache-CREATION (cache-write) tokens separately, so any turn
        // with a fresh cache write has those tokens folded into `inputTokens`
        // above and billed at the base input rate instead of the premium
        // `cacheCreationPerMTok` rate (src/shared/pricing.ts). This causes a
        // small, consistent UNDER-billing on cache-write turns. We report 0
        // rather than guess a split the source doesn't provide; revisit if VS
        // Code adds a cache-creation field to the schema.
        cacheReadTokens: parsed.cachedTokens,
        cacheCreationTokens: 0,
      });
    }

    this.writeCursor(cursorPath, nextBytePos, newPartial, fingerprint);
    this.bytePosBySession.set(dirSessionId, nextBytePos);
    if (newPartial.length > 0) this.partialByPath.set(path, newPartial);
    else this.partialByPath.delete(path);
  }

  private evictStalePartials(files: Array<{ path: string; sessionId: string }>): void {
    if (this.partialByPath.size === 0 && this.decoderByPath.size === 0) return;
    const live = new Set(files.map((f) => f.path));
    for (const path of this.partialByPath.keys()) {
      if (!live.has(path)) this.partialByPath.delete(path);
    }
    for (const path of this.decoderByPath.keys()) {
      if (!live.has(path)) this.decoderByPath.delete(path);
    }
  }

  /**
   * Parse a debug-log JSONL line, returning non-null only for an
   * `llm_request` record carrying a model, responseId, and token counts.
   */
  private tryParseLine(line: string): ParsedUsageRecord | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.parseErrors += 1;
      return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    if (obj.type !== 'llm_request') return null;
    const attrs = obj.attrs;
    if (!attrs || typeof attrs !== 'object') return null;
    const a = attrs as Record<string, unknown>;
    const model = typeof a.model === 'string' && a.model.length > 0 ? a.model : null;
    if (!model) return null;
    const responseId =
      typeof a.responseId === 'string' && a.responseId.length > 0 ? a.responseId : null;
    if (!responseId) return null;
    const timestampMs =
      typeof obj.ts === 'number' && Number.isFinite(obj.ts) && obj.ts > 0 ? obj.ts : Date.now();
    const sid = typeof obj.sid === 'string' && SESSION_ID_RE.test(obj.sid) ? obj.sid : null;
    return {
      timestampMs,
      sessionId: sid,
      responseId,
      model,
      inputTokens: num(a.inputTokens),
      outputTokens: num(a.outputTokens),
      cachedTokens: num(a.cachedTokens),
    };
  }

  /**
   * Extract usage fields from a line whose middle was elided. Only scalar
   * fields are matched, and an escaped quote inside a string payload never
   * matches the unescaped patterns below. A field that fell in the elided
   * middle yields no record: a guessed zero-token record would misreport cost.
   */
  private parseElidedLine(line: string): ParsedUsageRecord | null {
    const at = line.indexOf(ELIDE_MARK);
    const head = line.slice(0, at);
    const tail = line.slice(at + ELIDE_MARK.length);
    const find = (re: RegExp): string | null => (re.exec(head) ?? re.exec(tail))?.[1] ?? null;
    if (find(/("type":"llm_request")/) === null) return null;
    // A number must end at a delimiter, or a value cut by the head boundary
    // would match its leading digits.
    const findNumber = (name: string): number | null => {
      const raw = find(new RegExp(`"${name}":(\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)(?=[,}\\s])`));
      return raw === null ? null : num(Number(raw));
    };
    const model = find(/"model":"([^"\\]+)"/);
    const responseId = find(/"responseId":"([^"\\]+)"/);
    const inputTokens = findNumber('inputTokens');
    const outputTokens = findNumber('outputTokens');
    if (!model || !responseId || inputTokens === null || outputTokens === null) {
      this.parseErrors += 1;
      if (!this.warnedElided) {
        this.warnedElided = true;
        logger.warn('Skipped an oversize Copilot log line whose usage fields were not recoverable');
      }
      return null;
    }
    const ts = Number(/"ts":(\d+)/.exec(head)?.[1]);
    const sid = /"sid":"([^"\\]+)"/.exec(head)?.[1];
    return {
      timestampMs: Number.isFinite(ts) && ts > 0 ? ts : Date.now(),
      sessionId: sid !== undefined && SESSION_ID_RE.test(sid) ? sid : null,
      responseId,
      model,
      inputTokens,
      outputTokens,
      cachedTokens: findNumber('cachedTokens') ?? 0,
    };
  }

  // -------------------------------------------------------------------------
  // Buffer + cursor I/O
  // -------------------------------------------------------------------------

  private cursorPath(sessionId: string): string {
    return join(this.storagePath, `.copilot-usage-pos-${sessionId}`);
  }

  /**
   * True when a cursor exists and the file has bytes past it. An existing
   * cursor is read from disk once per session and tailFile keeps the cached
   * position current, so the 2s poll does not re-read every old session's
   * cursor file. Absence is not cached: another process may create the cursor.
   */
  private hasUnreadBytes(sessionId: string, size: number): boolean {
    let bytePos = this.bytePosBySession.get(sessionId);
    if (bytePos === undefined) {
      const cursorPath = this.cursorPath(sessionId);
      if (!existsSync(cursorPath)) return false;
      bytePos = this.readCursor(cursorPath).bytePos;
      this.bytePosBySession.set(sessionId, bytePos);
    }
    return bytePos < size;
  }

  private readCursor(cursorPath: string): CursorState {
    if (!existsSync(cursorPath)) return { bytePos: 0, partialLine: '' };
    try {
      const parsed = JSON.parse(readFileSync(cursorPath, 'utf-8').trim()) as Record<
        string,
        unknown
      >;
      const bytePos =
        typeof parsed.bytePos === 'number' && parsed.bytePos >= 0 ? parsed.bytePos : 0;
      const partialLine = typeof parsed.partialLine === 'string' ? parsed.partialLine : '';
      const fingerprint = typeof parsed.fingerprint === 'string' ? parsed.fingerprint : undefined;
      return { bytePos, partialLine, fingerprint };
    } catch {
      return { bytePos: 0, partialLine: '' };
    }
  }

  private writeCursor(
    cursorPath: string,
    bytePos: number,
    partialLine: string,
    fingerprint: string,
  ): void {
    try {
      if (!existsSync(this.storagePath)) {
        mkdirSync(this.storagePath, { recursive: true, mode: 0o700 });
      }
      writeFileSync(cursorPath, JSON.stringify({ bytePos, partialLine, fingerprint }), {
        mode: 0o600,
      });
    } catch (err) {
      this.recordError(err);
    }
  }

  /** Append into the session's hook buffer, same path convention as the collector. */
  private appendToBuffer(sessionId: string, event: object): void {
    try {
      if (!existsSync(this.storagePath)) {
        mkdirSync(this.storagePath, { recursive: true, mode: 0o700 });
      }
      appendFileSync(
        join(this.storagePath, `buffer-${sessionId}.jsonl`),
        JSON.stringify(event) + '\n',
        {
          mode: 0o600,
        },
      );
    } catch (err) {
      this.recordError(err);
    }
  }

  private recordError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('CopilotUsageWatcher error', { message: message.slice(0, 200) });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Bound a carried partial line. Past the cap, keep the first and last
 * ELIDE_KEEP_CHARS and replace the middle with ELIDE_MARK.
 */
function elideOversize(partial: string): string {
  const at = partial.indexOf(ELIDE_MARK);
  if (at === -1) {
    if (partial.length <= MAX_PARTIAL_LINE_BYTES) return partial;
    return (
      partial.slice(0, ELIDE_KEEP_CHARS) +
      ELIDE_MARK +
      partial.slice(partial.length - ELIDE_KEEP_CHARS)
    );
  }
  const tailStart = at + ELIDE_MARK.length;
  if (partial.length - tailStart <= 2 * ELIDE_KEEP_CHARS) return partial;
  return partial.slice(0, tailStart) + partial.slice(partial.length - ELIDE_KEEP_CHARS);
}

function readBytes(path: string, pos: number, len: number): Buffer {
  const buf = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  try {
    const n = len === 0 ? 0 : readSync(fd, buf, 0, len, pos);
    return n === len ? buf : buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

function onePrefixesOther(a: Buffer, b: Buffer): boolean {
  const n = Math.min(a.length, b.length);
  return a.subarray(0, n).equals(b.subarray(0, n));
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}
