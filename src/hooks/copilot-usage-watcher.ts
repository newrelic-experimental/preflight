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
 * poll, bounded partial-line carry, and each `responseId` claimed in the
 * BilledTurnLedger before it is buffered, so a re-read after a crash or a torn
 * cursor emits nothing already emitted.
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
import { BilledTurnLedger } from './billed-turn-ledger.js';
import { ThrottledWarning } from './throttled-warning.js';
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
  /** The process's one billed-turn ledger; tests may omit it to get a private one. */
  readonly ledger?: BilledTurnLedger;
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
  readonly undated: boolean;
  readonly sessionId: string | null;
  /** The record's `responseId`, unique per API response. */
  readonly messageId: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
}

interface CursorState {
  readonly bytePos: number;
  readonly partialLine: string;
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
  private readonly ledger: BilledTurnLedger;
  private readonly retryWarning = new ThrottledWarning(
    logger,
    'CopilotUsageWatcher read deferred to the next poll',
  );

  private intervalId: ReturnType<typeof setInterval> | null = null;
  private readonly partialByPath = new Map<string, string>();
  private readonly decoderByPath = new Map<string, StringDecoder>();

  private filesWatched = 0;
  private linesRead = 0;
  private bytesRead = 0;
  private parseErrors = 0;
  private debugLoggingLikelyDisabled = false;
  private warnedDebugLoggingDisabled = false;

  constructor(options: CopilotUsageWatcherOptions = {}) {
    this.storagePath = options.storagePath ?? join(homedir(), '.newrelic-preflight');
    this.workspaceStorageRoots = options.workspaceStorageRoots ?? defaultWorkspaceStorageRoots();
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.discoveryHours = options.discoveryHours ?? DEFAULT_DISCOVERY_HOURS;
    this.parentSessionFilter = options.parentSessionId ?? null;
    this.localStore = options.localStore;
    this.ledger = options.ledger ?? new BilledTurnLedger({ storagePath: this.storagePath });
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
            if (this.parentSessionFilter === null && st.mtimeMs < cutoffMs) continue;
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
    const startCursor: CursorState =
      memPartial !== undefined
        ? { bytePos: persisted.bytePos, partialLine: memPartial }
        : persisted;

    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return;
    }
    // Truncated/rotated file: restart from 0.
    const fromPos = startCursor.bytePos > size ? 0 : startCursor.bytePos;
    if (fromPos >= size) return;

    const toRead = Math.min(size - fromPos, MAX_BYTES_PER_POLL);
    const buf = Buffer.alloc(toRead);
    let actuallyRead = 0;
    let fd: number | null = null;
    try {
      fd = openSync(path, 'r');
      actuallyRead = readSync(fd, buf, 0, toRead, fromPos);
    } catch (err) {
      this.recordError(err);
      return;
    } finally {
      if (fd !== null) closeSync(fd);
    }
    if (actuallyRead <= 0) return;

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
    let parseErrors = 0;
    if (newPartial.length > MAX_PARTIAL_LINE_BYTES) {
      newPartial = '';
      parseErrors += 1;
    }

    // Health counters wait until the read is committed, so a redone read counts once.
    const records: ParsedUsageRecord[] = [];
    let linesRead = 0;
    for (const line of lines) {
      if (!line) continue;
      linesRead += 1;
      const { parsed, invalidJson } = this.tryParseLine(line);
      if (invalidJson) parseErrors += 1;
      if (parsed !== null) records.push(parsed);
    }

    // If the claim, an append or the cursor write fails, the cursor stays put
    // and the next poll redoes the read: the ledger hands back the records
    // still owed and refuses the ones already appended.
    try {
      this.ledger.deliver(dirSessionId, records, (parsed) => {
        const sessionId = parsed.sessionId ?? dirSessionId;
        this.appendToBuffer(sessionId, {
          mode: 'token',
          tool: 'copilot-usage',
          timestamp: parsed.timestampMs,
          sessionId,
          messageId: parsed.messageId,
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
      });
      this.writeCursor(cursorPath, nextBytePos, newPartial);
    } catch (err) {
      this.retryWarning.warn(err);
      this.partialByPath.delete(path);
      this.decoderByPath.delete(path);
      return;
    }
    this.retryWarning.succeeded();
    this.bytesRead += actuallyRead;
    this.linesRead += linesRead;
    this.parseErrors += parseErrors;
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
   * Parse a debug-log JSONL line; `parsed` is non-null only for an
   * `llm_request` record carrying a model, responseId, and token counts.
   */
  private tryParseLine(line: string): { parsed: ParsedUsageRecord | null; invalidJson: boolean } {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      return { parsed: null, invalidJson: true };
    }
    const none = { parsed: null, invalidJson: false };
    if (!json || typeof json !== 'object') return none;
    const obj = json as Record<string, unknown>;
    if (obj.type !== 'llm_request') return none;
    const attrs = obj.attrs;
    if (!attrs || typeof attrs !== 'object') return none;
    const a = attrs as Record<string, unknown>;
    const model = typeof a.model === 'string' && a.model.length > 0 ? a.model : null;
    if (!model) return none;
    const responseId =
      typeof a.responseId === 'string' && a.responseId.length > 0 ? a.responseId : null;
    if (!responseId) return none;
    const ts = typeof obj.ts === 'number' && Number.isFinite(obj.ts) && obj.ts > 0 ? obj.ts : null;
    const sid = typeof obj.sid === 'string' && SESSION_ID_RE.test(obj.sid) ? obj.sid : null;
    const parsed: ParsedUsageRecord = {
      timestampMs: ts ?? Date.now(),
      undated: ts === null,
      sessionId: sid,
      messageId: responseId,
      model,
      inputTokens: num(a.inputTokens),
      outputTokens: num(a.outputTokens),
      cachedTokens: num(a.cachedTokens),
    };
    return { parsed, invalidJson: false };
  }

  // -------------------------------------------------------------------------
  // Buffer + cursor I/O
  // -------------------------------------------------------------------------

  private cursorPath(sessionId: string): string {
    return join(this.storagePath, `.copilot-usage-pos-${sessionId}`);
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
      return { bytePos, partialLine };
    } catch {
      return { bytePos: 0, partialLine: '' };
    }
  }

  private writeCursor(cursorPath: string, bytePos: number, partialLine: string): void {
    if (!existsSync(this.storagePath)) {
      mkdirSync(this.storagePath, { recursive: true, mode: 0o700 });
    }
    writeFileSync(cursorPath, JSON.stringify({ bytePos, partialLine }), { mode: 0o600 });
  }

  /** Append into the session's hook buffer, same path convention as the collector. */
  private appendToBuffer(sessionId: string, event: object): void {
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
  }

  private recordError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('CopilotUsageWatcher error', { message: message.slice(0, 200) });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}
