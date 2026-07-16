#!/usr/bin/env node
/**
 * Hook collector script for Claude Code PreToolUse / PostToolUse / PostToolUseFailure hooks.
 *
 * Called by Claude Code on every tool invocation. Reads the hook JSON from stdin,
 * extracts key fields, and appends a single JSONL line to the buffer file.
 *
 * Design constraints:
 *   - <5ms execution budget — must never slow Claude Code
 *   - No heavy imports (no shared package, no commander, no zod)
 *   - All errors caught silently — always exits 0
 *   - Config via env vars only (no file reads for config)
 */

import {
  readFileSync,
  readSync,
  writeFileSync,
  openSync,
  closeSync,
  mkdirSync,
  existsSync,
  constants as fsConstants,
  statSync,
} from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

import type { RawTranscriptEntry, RawAssistantMessage } from './transcript-types.js';

// ---------------------------------------------------------------------------
// Lightweight config (env vars only — no file reads)
// ---------------------------------------------------------------------------

const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const DEFAULT_STORAGE_DIR = resolve(homedir(), '.newrelic-preflight');

/**
 * Resolve the per-session buffer path. Validates sessionId against
 * /^[a-zA-Z0-9_-]{1,128}$/ so a malicious session_id can't escape the storage
 * dir. When sessionId is missing or fails validation, falls back to
 * `buffer-unknown.jsonl` rather than the legacy shared `buffer.jsonl` — the
 * MCP no longer reads the shared path.
 *
 * `NEW_RELIC_AI_MCP_BUFFER_PATH` is honored verbatim when set (used by tests
 * and one-off configurations) and bypasses session-scoping.
 */
function getBufferPath(sessionId?: string): string {
  if (process.env.NEW_RELIC_AI_MCP_BUFFER_PATH !== undefined) {
    return process.env.NEW_RELIC_AI_MCP_BUFFER_PATH;
  }
  const storageDir = process.env.NEW_RELIC_AI_MCP_STORAGE_PATH ?? DEFAULT_STORAGE_DIR;
  const safeId =
    typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId) ? sessionId : 'unknown';
  return resolve(storageDir, `buffer-${safeId}.jsonl`);
}

// Cache only the file-read result to avoid repeated disk I/O on the hot path
// (<5ms budget per hook invocation) while keeping the env-var check dynamic
// so runtime changes in tests (and future dynamic config) are respected.
// This also eliminates the TOCTOU window between existsSync and readFileSync.
const HIGH_SECURITY_FROM_FILE: boolean = (() => {
  // Check new path first; fall back to legacy path during the migration window
  // (between upgrade and first server startup that runs migrateStoragePath).
  for (const dir of ['.newrelic-preflight', '.nr-ai-observe']) {
    try {
      const configPath = resolve(homedir(), dir, 'config.json');
      if (existsSync(configPath)) {
        const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
        return config.highSecurity === true;
      }
    } catch {
      // Silently ignore config read errors
    }
  }
  return false;
})();

function getHighSecurity(): boolean {
  return process.env.NEW_RELIC_AI_HIGH_SECURITY === 'true' || HIGH_SECURITY_FROM_FILE;
}

function getRecordContent(): boolean {
  const highSecurity = getHighSecurity();
  if (highSecurity) return false;
  return process.env.NEW_RELIC_AI_MCP_RECORD_CONTENT === 'true';
}

function getMaxContentLength(): number {
  const val = process.env.NEW_RELIC_AI_MCP_MAX_CONTENT_LENGTH;
  if (val === undefined) return 10_240;
  const parsed = parseInt(val, 10);
  return Number.isNaN(parsed) ? 10_240 : parsed;
}

// ---------------------------------------------------------------------------
// Inline redaction (mirrors config.ts DEFAULT_REDACTION_PATTERNS)
// ---------------------------------------------------------------------------

const REDACTION_PATTERNS: RegExp[] = [
  /(?<![a-zA-Z])(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSPHRASE|PRIVATE_KEY)(?![a-zA-Z])[\s]*[=:]\s*\S+/gi,
  /(?:sk-|ghp_|gho_|ghs_|github_pat_|xoxb-|xoxp-|Bearer\s+)[A-Za-z0-9_-]{20,200}/g,
  /-----BEGIN[^-\n]{0,100}-----[A-Za-z0-9+/=\r\n. ]{0,65536}-----END[^-\n]{0,100}-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIzaSy[0-9A-Za-z_-]{33}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bxox[a-z]-[0-9A-Za-z-]+/g,
];

const MAX_REDACT_BYTES = 1_048_576; // 1 MB

function redact(value: string): string {
  // Truncate by byte count, not character count — 4-byte emoji chars would otherwise
  // allow up to 4 MB of content through the regex pass.
  let result = value;
  if (Buffer.byteLength(value, 'utf8') > MAX_REDACT_BYTES) {
    const buf = Buffer.from(value, 'utf8').subarray(0, MAX_REDACT_BYTES);
    result = buf.toString('utf8').replace(/�$/, ''); // drop any partial surrogate at cut point
  }
  for (const pattern of REDACTION_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    result = result.replace(re, '[REDACTED]');
  }
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashInput(input: unknown): string {
  const str = JSON.stringify(input) ?? '';
  return createHash('sha256').update(str).digest('hex').slice(0, 16);
}

function sizeOf(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'string') return value.length;
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

function truncate(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  return value.slice(0, maxLen) + '...[truncated]';
}

function countLines(text: string): number {
  if (text === '') return 0;
  return (text.match(/\n/g) || []).length + 1;
}

// ---------------------------------------------------------------------------
// Transcript token collection
// ---------------------------------------------------------------------------

const TRANSCRIPT_TAIL_BYTES = 16_384;
const DEFAULT_MODEL = 'claude-opus-4-6';

interface TranscriptUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
  model?: string;
}

/** A content block carrying a `text` field — narrows before reading `.text`. */
function hasStringText(block: unknown): block is { text: string } {
  return (
    typeof block === 'object' &&
    block !== null &&
    'text' in block &&
    typeof (block as { text?: unknown }).text === 'string'
  );
}

function getClaudeHome(): string {
  return process.env.NR_AI_OBSERVE_CLAUDE_HOME ?? resolve(homedir(), '.claude');
}

function getTranscriptPath(cwd: string | undefined, sessionId: string | undefined): string | null {
  if (!sessionId) return null;
  const projectDir = cwd ? cwd.replace(/[\\/]/g, '-') : process.env.PWD?.replace(/[\\/]/g, '-');
  if (!projectDir) return null;
  return resolve(getClaudeHome(), 'projects', projectDir, `${sessionId}.jsonl`);
}

const WINDOWS_DRIVE_PATH_RE = /^([A-Za-z]):[\\/](.*)$/;

// Windows Claude Code sends Windows-style paths (C:\Users\...) even when this
// collector runs inside WSL; translate to the WSL mount so statSync can read it.
function translateWslPath(path: string): string {
  if (process.platform !== 'linux') return path;
  const match = WINDOWS_DRIVE_PATH_RE.exec(path);
  if (!match) return path;
  const [, drive, rest] = match;
  return `/mnt/${drive.toLowerCase()}/${rest.replace(/\\/g, '/')}`;
}

function readLastAssistantUsage(transcriptPath: string): TranscriptUsage | null {
  try {
    const stat = statSync(transcriptPath);
    if (stat.size === 0) return null;

    const fd = openSync(transcriptPath, fsConstants.O_RDONLY);
    try {
      const readSize = Math.min(stat.size, TRANSCRIPT_TAIL_BYTES);
      const buffer = Buffer.alloc(readSize);
      const bytesRead = readSync(fd, buffer, 0, readSize, stat.size - readSize);
      const tail = buffer.toString('utf-8', 0, bytesRead);

      const lines = tail.split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]) as RawTranscriptEntry;
          if (entry.type === 'assistant' && entry.message && typeof entry.message === 'object') {
            const msg = entry.message as RawAssistantMessage;
            // Skip synthetic entries (Claude Code's internal injections —
            // compaction summaries, system messages). They carry model:
            // '<synthetic>' which doesn't match any pricing table entry.
            if (msg.model === '<synthetic>') continue;
            if (msg.usage && typeof msg.usage === 'object') {
              const usage = { ...(msg.usage as TranscriptUsage) };
              if (typeof msg.model === 'string' && msg.model.length > 0) {
                usage.model = msg.model;
              }
              return usage;
            }
          }
        } catch {
          continue;
        }
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    // Silently ignore — transcript may not exist yet
  }
  return null;
}

function getLastTranscriptSize(sessionId: string): number {
  if (!SESSION_ID_RE.test(sessionId)) return 0;
  try {
    const bufferDir = dirname(getBufferPath(sessionId));
    const statePath = resolve(bufferDir, `.transcript-pos-${sessionId}`);
    if (existsSync(statePath)) {
      return parseInt(readFileSync(statePath, 'utf-8').trim(), 10) || 0;
    }
  } catch {
    // Ignore
  }
  return 0;
}

let _transcriptSizeWriteFailed = false;

function setLastTranscriptSize(sessionId: string, size: number): void {
  if (!SESSION_ID_RE.test(sessionId)) return;
  try {
    const bufferDir = dirname(getBufferPath(sessionId));
    if (!existsSync(bufferDir)) {
      mkdirSync(bufferDir, { recursive: true, mode: 0o700 });
    }
    const statePath = resolve(bufferDir, `.transcript-pos-${sessionId}`);
    writeFileSync(statePath, String(size), { mode: 0o600 });
    _transcriptSizeWriteFailed = false;
  } catch (err) {
    if (!_transcriptSizeWriteFailed) {
      process.stderr.write(
        `[preflight-collector] Warning: cannot persist transcript size: ${String(err)}\n`,
      );
      _transcriptSizeWriteFailed = true;
    }
  }
}

function collectTranscriptTokens(data: {
  cwd?: string;
  session_id?: string;
  transcript_path?: string;
}): void {
  const sessionId = data.session_id;
  // Prefer Claude Code's own transcript_path field — it's authoritative and
  // works under git worktrees, where deriving the path from cwd produces a
  // dashed directory that doesn't match the parent project's transcript dir.
  const rawTranscriptPath =
    typeof data.transcript_path === 'string' && data.transcript_path.length > 0
      ? data.transcript_path
      : getTranscriptPath(data.cwd, sessionId);
  const transcriptPath = rawTranscriptPath ? translateWslPath(rawTranscriptPath) : null;
  if (!transcriptPath || !sessionId) return;

  let currentSize: number;
  try {
    currentSize = statSync(transcriptPath).size;
  } catch {
    return;
  }

  let lastSize = getLastTranscriptSize(sessionId);
  if (currentSize < lastSize) {
    // Transcript file was rotated — reset tracking so we read from offset 0
    setLastTranscriptSize(sessionId, 0);
    lastSize = 0;
  }
  if (currentSize <= lastSize) return;

  const usage = readLastAssistantUsage(transcriptPath);
  if (!usage) return;

  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  if (inputTokens === 0 && outputTokens === 0) return;

  const tokenEvent: Record<string, unknown> = {
    mode: 'token',
    timestamp: Date.now(),
    inputTokens,
    outputTokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
    model: usage.model ?? DEFAULT_MODEL,
  };
  tokenEvent.sessionId = sessionId;

  try {
    const bufferPath = getBufferPath(sessionId);
    const bufferDir = dirname(bufferPath);
    if (!existsSync(bufferDir)) {
      mkdirSync(bufferDir, { recursive: true, mode: 0o700 });
    }

    const line = JSON.stringify(tokenEvent) + '\n';
    const fd = openSync(
      bufferPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND,
      0o600,
    );
    try {
      writeFileSync(fd, line);
    } finally {
      closeSync(fd);
    }
    // Persist the new size only after a successful buffer write so that a
    // write failure doesn't silently drop the token event on the next invocation.
    setLastTranscriptSize(sessionId, currentSize);
  } catch {
    // Silent failure — never block Claude Code
  }
}

// ---------------------------------------------------------------------------
// PPID breadcrumb — lets the MCP server learn the Claude Code session_id
//
// Claude Code spawns its MCP server and hook collector scripts as children of
// the same process; they share a PPID. The MCP can read its own process.ppid
// (= Claude Code's PID) and look up the matching session_id here.
//
// Hot-path: every PreToolUse / PostToolUse hook runs this. The
// existsSync + content-equality short-circuit makes the steady state a single
// stat() and one read — well under the <5ms budget.
// ---------------------------------------------------------------------------

/**
 * Seam for unit tests: replace `readFile` to inject fake `/proc/<pid>/stat`
 * content without touching the real filesystem. Production code never sets this.
 * @internal
 */
export const _procFs = {
  readFile: (path: string): string => readFileSync(path, 'utf-8'),
};

/**
 * Returns an array starting with `startPpid` and appended with each successive
 * parent PID read from `/proc/<pid>/stat`, up to `maxDepth` levels deep.
 *
 * On non-Linux systems `/proc` is absent; the first read throws, the loop
 * breaks immediately, and the return value is `[startPpid]` — identical to
 * the pre-walk behaviour. On Linux with a direct parent relationship it also
 * returns `[startPpid]` because the parent's ppid will be ≤ 1 (or absent).
 *
 * The walk is needed on WSL2 with fish/bash hook-runners that interpose an
 * intermediate `sh` process: the MCP server's `process.ppid` is Claude's PID,
 * but the collector's `process.ppid` is the interposed shell. Writing the
 * breadcrumb at every ancestor ensures the server finds it at its own ppid.
 */
export function getLinuxAncestorPids(startPpid: number, maxDepth = 5): number[] {
  const pids: number[] = [startPpid];
  let pid = startPpid;
  for (let depth = 0; depth < maxDepth && pid > 1; depth++) {
    try {
      const stat = _procFs.readFile(`/proc/${pid}/stat`);
      // Format: "pid (comm) state ppid pgrp ..."
      // The comm field can contain spaces and parentheses; use lastIndexOf to
      // find the field-separator ')' reliably.
      const lastParen = stat.lastIndexOf(')');
      if (lastParen === -1) break;
      // After the last ')': " state ppid ..." — split on space, index [1] is ppid.
      const parentPid = parseInt(stat.slice(lastParen + 2).split(' ')[1] ?? '0', 10);
      if (!Number.isFinite(parentPid) || parentPid <= 1) break;
      if (pids.includes(parentPid)) break; // cycle guard
      pids.push(parentPid);
      pid = parentPid;
    } catch {
      break;
    }
  }
  return pids;
}

let _breadcrumbWriteFailed = false;

function writePpidBreadcrumb(sessionId: string): void {
  if (!SESSION_ID_RE.test(sessionId)) return;
  const ppid = process.ppid;
  if (typeof ppid !== 'number' || ppid <= 0) return;

  try {
    const storageDir = process.env.NEW_RELIC_AI_MCP_STORAGE_PATH ?? DEFAULT_STORAGE_DIR;
    const breadcrumbDir = resolve(storageDir, 'session-by-ppid');
    mkdirSync(breadcrumbDir, { recursive: true, mode: 0o700 });

    // Walk ancestor PIDs. On Linux this includes any intermediate shell
    // processes interposed by the hook runner. On macOS/Windows the array
    // has exactly one element (process.ppid) — identical to before.
    // pids[0] (direct ppid) is the authoritative slot — the MCP server uses
    // its own process.ppid for lookup. Ancestor slots are best-effort; concurrent
    // sessions sharing a common ancestor PID may overwrite each other there.
    const pids = getLinuxAncestorPids(ppid);

    let wroteAny = false;
    for (const pid of pids) {
      const breadcrumbPath = resolve(breadcrumbDir, `${pid}.txt`);
      // Short-circuit: no write needed if content already matches.
      if (existsSync(breadcrumbPath)) {
        try {
          if (readFileSync(breadcrumbPath, 'utf-8').trim() === sessionId) {
            wroteAny = true;
            continue;
          }
        } catch {
          // Fall through to rewrite if the read failed.
        }
      }
      writeFileSync(breadcrumbPath, sessionId, { mode: 0o600 });
      wroteAny = true;
    }

    if (wroteAny) _breadcrumbWriteFailed = false;
  } catch (err) {
    if (!_breadcrumbWriteFailed) {
      process.stderr.write(
        `[preflight-collector] Warning: cannot write PPID breadcrumb: ${String(err)}\n`,
      );
      _breadcrumbWriteFailed = true;
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface HookInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  tool_use_id?: string;
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
  error?: string;
  is_interrupt?: boolean;
  // Cursor (https://cursor.com/docs/agent/hooks) sends a different field
  // vocabulary per hook type instead of the uniform tool_name/tool_input
  // Claude Code and Kiro use. conversation_id is Cursor's closest analog to
  // session_id — Cursor never sends session_id. command/file_path/content/
  // edits are confirmed via a real JSON example from Cursor's own team:
  // https://blog.gitbutler.com/cursor-hooks-deep-dive
  conversation_id?: string;
  command?: string;
  file_path?: string;
  content?: string;
  edits?: { old_string?: string; new_string?: string }[];
  // Windsurf (https://docs.windsurf.com/windsurf/cascade/hooks) sends a
  // completely different envelope from every other platform: the event name
  // itself is `agent_action_name`, not `hook_event_name`, and all
  // event-specific data lives nested under `tool_info` rather than flat
  // fields. `trajectory_id` is Windsurf's closest analog to session_id
  // ("Unique identifier for the overall Cascade conversation" per the docs
  // above) — Windsurf never sends session_id, the same situation as Cursor's
  // conversation_id.
  agent_action_name?: string;
  trajectory_id?: string;
  tool_info?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Extract only the metadata fields from tool_input that the tool-specific
 * parsers need. Full content strings are replaced with their lengths to
 * avoid writing sensitive data to the JSONL buffer on disk.
 */
function extractInputMeta(toolName: string, input: unknown): Record<string, unknown> | undefined {
  if (input === null || input === undefined || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  const meta: Record<string, unknown> = {};

  // Common field: file_path (Read, Write, Edit)
  if (typeof obj.file_path === 'string') meta.file_path = obj.file_path;

  switch (toolName) {
    case 'Read':
      if (typeof obj.offset === 'number') meta.offset = obj.offset;
      if (typeof obj.limit === 'number') meta.limit = obj.limit;
      break;
    case 'Write':
      if (typeof obj.content === 'string') {
        meta.contentLength = obj.content.length;
        meta.lineCount = obj.content.length > 0 ? countLines(obj.content) : 0;
      }
      break;
    case 'Edit':
      if (typeof obj.old_string === 'string') {
        meta.oldStringLength = obj.old_string.length;
        meta.oldLineCount = obj.old_string.length > 0 ? countLines(obj.old_string) : 0;
      }
      if (typeof obj.new_string === 'string') {
        meta.newStringLength = obj.new_string.length;
        meta.newLineCount = obj.new_string.length > 0 ? countLines(obj.new_string) : 0;
        meta.isDelete = obj.new_string.length === 0;
      }
      if (typeof obj.replace_all === 'boolean') meta.replace_all = obj.replace_all;
      break;
    case 'Bash':
      if (typeof obj.command === 'string') meta.command = redact(obj.command);
      if (typeof obj.description === 'string') meta.description = redact(obj.description);
      if (typeof obj.timeout === 'number') meta.timeout = obj.timeout;
      if (typeof obj.run_in_background === 'boolean')
        meta.run_in_background = obj.run_in_background;
      break;
    case 'Grep':
      if (typeof obj.pattern === 'string') meta.pattern = obj.pattern;
      if (typeof obj.path === 'string') meta.path = obj.path;
      if (typeof obj.output_mode === 'string') meta.output_mode = obj.output_mode;
      break;
    case 'Glob':
      if (typeof obj.pattern === 'string') meta.pattern = obj.pattern;
      if (typeof obj.path === 'string') meta.path = obj.path;
      break;
    case 'Agent':
      if (typeof obj.description === 'string') meta.description = obj.description;
      if (typeof obj.subagent_type === 'string') meta.subagent_type = obj.subagent_type;
      if (typeof obj.prompt === 'string') meta.promptLength = obj.prompt.length;
      if (typeof obj.run_in_background === 'boolean')
        meta.run_in_background = obj.run_in_background;
      if (typeof obj.name === 'string') meta.name = obj.name;
      if (typeof obj.team_name === 'string') meta.team_name = obj.team_name;
      if (typeof obj.isolation === 'string') meta.isolation = obj.isolation;
      if (typeof obj.model === 'string') meta.model = obj.model;
      break;
    case 'AskUserQuestion':
      if (Array.isArray(obj.questions)) meta.questions = new Array(obj.questions.length);
      break;
    case 'TaskCreate':
      if (typeof obj.subject === 'string') meta.subject = obj.subject;
      break;
    case 'TaskUpdate':
      if (typeof obj.taskId === 'string') meta.taskId = obj.taskId;
      if (typeof obj.status === 'string') meta.status = obj.status;
      if (typeof obj.subject === 'string') meta.subject = obj.subject;
      break;
  }

  return Object.keys(meta).length > 0 ? meta : undefined;
}

/**
 * Extract only the metadata fields from tool_response that the tool-specific
 * parsers need.
 */
function extractOutputMeta(toolName: string, output: unknown): Record<string, unknown> | undefined {
  if (output === null || output === undefined || typeof output !== 'object') return undefined;
  const obj = output as Record<string, unknown>;

  if (toolName === 'Bash') {
    if (typeof obj.exitCode === 'number') {
      return { exitCode: obj.exitCode };
    }
    if (typeof obj.exitCode === 'string') {
      const parsed = Number(obj.exitCode);
      if (!Number.isNaN(parsed)) return { exitCode: parsed };
    }
  }

  if (toolName === 'Edit') {
    const meta: Record<string, unknown> = {};
    if (typeof obj.success === 'boolean') meta.editSuccess = obj.success;
    if (typeof obj.error === 'string') meta.editError = obj.error.slice(0, 200);
    if (typeof obj.matched === 'boolean') meta.editMatched = obj.matched;
    return Object.keys(meta).length > 0 ? meta : undefined;
  }

  if (toolName === 'Grep') {
    const meta: Record<string, unknown> = {};
    if (typeof obj.matchCount === 'number') meta.grepMatchCount = obj.matchCount;
    else if (Array.isArray(obj.matches)) meta.grepMatchCount = obj.matches.length;
    else if (Array.isArray(obj.results)) meta.grepMatchCount = obj.results.length;
    if (Array.isArray(obj.content)) {
      let lineCount = 0;
      for (const block of obj.content) {
        if (hasStringText(block)) {
          lineCount += block.text.split('\n').length;
        }
      }
      if (lineCount > 0) meta.grepResultLines = lineCount;
    }
    return Object.keys(meta).length > 0 ? meta : undefined;
  }

  if (toolName === 'Agent') {
    const meta: Record<string, unknown> = {};
    if (typeof obj.completed === 'boolean') meta.agentCompleted = obj.completed;
    if (typeof obj.interrupted === 'boolean') meta.agentInterrupted = obj.interrupted;
    if (typeof obj.result === 'string') meta.agentResultLength = obj.result.length;
    else if (typeof obj.message === 'string') meta.agentResultLength = obj.message.length;
    else if (Array.isArray(obj.content)) {
      let totalLen = 0;
      for (const block of obj.content) {
        if (hasStringText(block)) {
          totalLen += block.text.length;
        }
      }
      if (totalLen > 0) meta.agentResultLength = totalLen;
    }
    return Object.keys(meta).length > 0 ? meta : undefined;
  }

  return undefined;
}

/**
 * Windsurf nests all event-specific data under `tool_info` instead of flat
 * top-level fields (https://docs.windsurf.com/windsurf/cascade/hooks).
 * Returns an empty object when tool_info is missing or malformed so callers
 * can destructure without null checks.
 */
function getWindsurfToolInfo(data: HookInput): Record<string, unknown> {
  return data.tool_info !== null && typeof data.tool_info === 'object' ? data.tool_info : {};
}

function processHook(raw: string): void {
  let data: HookInput;
  try {
    data = JSON.parse(raw) as HookInput;
  } catch {
    return; // Malformed JSON — skip silently
  }

  // Cursor (https://cursor.com/docs/agent/hooks) never sends session_id —
  // conversation_id is its closest analog (one per chat, like a Claude Code
  // session). Claude Code and Kiro always send session_id, so this only
  // takes effect for Cursor events.
  // Windsurf (https://docs.windsurf.com/windsurf/cascade/hooks) never sends
  // session_id either — trajectory_id is its closest analog, the same role
  // conversation_id plays for Cursor.
  const sessionId = data.session_id ?? data.conversation_id ?? data.trajectory_id;

  // Drop a PPID breadcrumb at the very top so the MCP server can resolve its
  // Claude Code session_id without an env-var or initialize-payload extension.
  // The function itself is a no-op when sessionId is missing or invalid, and
  // short-circuits if the breadcrumb is already current. Cursor's
  // conversation_id is deliberately excluded here — there is no confirmed
  // evidence that Cursor's own MCP-server child process shares Claude Code's
  // ancestry-based session-resolution model, so extending this to
  // conversation_id would be a guess, not a fix.
  if (typeof data.session_id === 'string' && data.session_id.length > 0) {
    writePpidBreadcrumb(data.session_id);
  }

  // Claude Code sends PascalCase hook names ('PreToolUse'); Kiro sends
  // lower-camelCase ('preToolUse') per https://kiro.dev/docs/cli/hooks.
  // Normalize case so both are recognized without hard-coding per-platform
  // spellings here (this file intentionally has no platform-adapter import —
  // see the file's own "no heavy imports" design constraint).
  // Windsurf sends the event name as agent_action_name, not hook_event_name
  // (https://docs.windsurf.com/windsurf/cascade/hooks) — already lowercase
  // with underscores (e.g. "pre_read_code"), but .toLowerCase() is harmless
  // and keeps this line uniform with every other platform's derivation.
  const eventName = (data.hook_event_name ?? data.agent_action_name)?.toLowerCase();
  const toolName = data.tool_name ?? 'unknown';
  const timestamp = Date.now();
  const recordContent = getRecordContent();
  const maxContentLen = getMaxContentLength();

  let event: Record<string, unknown>;

  if (eventName === 'pretooluse') {
    event = {
      mode: 'pre' as const,
      tool: toolName,
      timestamp,
      inputSize: sizeOf(data.tool_input),
      inputHash: hashInput(data.tool_input),
    };

    // Store only the metadata fields needed for tool-specific parsing
    const inputMeta = extractInputMeta(toolName, data.tool_input);
    if (inputMeta !== undefined) event.toolInput = inputMeta;

    if (recordContent && data.tool_input !== undefined) {
      const content =
        typeof data.tool_input === 'string' ? data.tool_input : JSON.stringify(data.tool_input);
      event.inputContent = redact(truncate(content, maxContentLen));
    }
  } else if (eventName === 'posttooluse') {
    // Claude Code generally signals tool failure via a separate
    // PostToolUseFailure event, so hardcoding true here was historically
    // almost always safe — with one known exception: Claude Code's own Edit
    // tool sets tool_response.success: false (see extractOutputMeta's Edit
    // case below, which has always read this into toolOutput.editSuccess)
    // when a find-and-replace doesn't match. Kiro and Amazon Q Developer CLI
    // both use this single postToolUse event for both outcomes and set
    // tool_response.success: false on failure (confirmed identical shape:
    // https://kiro.dev/docs/cli/hooks and
    // https://github.com/aws/amazon-q-developer-cli/blob/main/docs/hooks.md).
    // Reading tool_response.success here (defaulting to true when absent)
    // both fixes Kiro/Amazon Q and intentionally unifies the top-level
    // success/ToolCallRecord.success signal with the existing
    // toolOutput.editSuccess signal for Claude Code's own no-match Edit case
    // — a no-match edit is a genuine failure worth surfacing to
    // anti-pattern/task-completion metrics, not a behavior to special-case
    // away.
    const toolResponse = data.tool_response;
    const responseSuccess =
      toolResponse !== null && typeof toolResponse === 'object' && !Array.isArray(toolResponse)
        ? (toolResponse as Record<string, unknown>).success
        : undefined;
    event = {
      mode: 'post' as const,
      tool: toolName,
      timestamp,
      outputSize: sizeOf(data.tool_response),
      success: typeof responseSuccess === 'boolean' ? responseSuccess : true,
    };

    // Store input metadata as fallback for orphaned-post pairing (pre-event may be missing)
    const postInputMeta = extractInputMeta(toolName, data.tool_input);
    if (postInputMeta !== undefined) event.toolInput = postInputMeta;

    // Store only the metadata fields needed for tool-specific parsing
    const outputMeta = extractOutputMeta(toolName, data.tool_response);
    if (outputMeta !== undefined) event.toolOutput = outputMeta;

    if (recordContent && data.tool_response !== undefined) {
      const content =
        typeof data.tool_response === 'string'
          ? data.tool_response
          : JSON.stringify(data.tool_response);
      event.outputContent = redact(truncate(content, maxContentLen));
    }
  } else if (eventName === 'posttoolusefailure') {
    event = {
      mode: 'post' as const,
      tool: toolName,
      timestamp,
      success: false,
      error: redact(data.error ?? 'unknown error'),
      isInterrupt: data.is_interrupt ?? false,
    };
  } else if (eventName === 'beforeshellexecution') {
    // Cursor's shell hooks carry no tool_name field — the event name itself
    // identifies the tool. Confirmed payload shape:
    // https://blog.gitbutler.com/cursor-hooks-deep-dive
    const command = data.command ?? '';
    event = {
      mode: 'pre' as const,
      tool: 'Bash',
      timestamp,
      inputSize: sizeOf(command),
      inputHash: hashInput(command),
      toolInput: { command: redact(command) },
    };
  } else if (eventName === 'aftershellexecution') {
    // Cursor doesn't document a distinct failure event for shell (unlike
    // Claude Code's PostToolUseFailure) and no source confirms afterShellExecution's
    // exact payload fields — treat as success absent any failure signal, same
    // convention as Claude Code's PostToolUse-without-PostToolUseFailure.
    event = {
      mode: 'post' as const,
      tool: 'Bash',
      timestamp,
      success: true,
    };
  } else if (eventName === 'beforemcpexecution') {
    // tool_name here is an arbitrary third-party MCP tool name, not one of
    // Preflight's canonical built-in tool names — passed through as-is
    // (identity), matching how src/platforms/generic-mcp-adapter.ts already
    // treats third-party MCP tool names.
    const mcpTool = data.tool_name ?? 'unknown';
    event = {
      mode: 'pre' as const,
      tool: mcpTool,
      timestamp,
      inputSize: sizeOf(data.tool_input),
      inputHash: hashInput(data.tool_input),
    };
  } else if (eventName === 'aftermcpexecution') {
    // Same identity tool-name treatment and success-by-default convention as
    // aftershellexecution above — no source confirms this event's exact
    // success/output fields.
    const mcpTool = data.tool_name ?? 'unknown';
    event = {
      mode: 'post' as const,
      tool: mcpTool,
      timestamp,
      success: true,
    };
  } else if (eventName === 'beforereadfile') {
    // Cursor has no "afterReadFile" event — beforeReadFile is the only file-read
    // hook that exists (confirmed: https://blog.gitbutler.com/cursor-hooks-deep-dive
    // documents 6 original hooks, none pair with beforeReadFile). Emitted directly
    // as a completed post event — the same code path event-processor.ts already
    // uses for an orphaned PostToolUse with no matching pre-event — rather than
    // inventing new pairing semantics for a "pre-only" tool call.
    event = {
      mode: 'post' as const,
      tool: 'Read',
      timestamp,
      success: true,
      ...(data.file_path !== undefined && { toolInput: { file_path: data.file_path } }),
    };
    // data.content carries the actual file contents — never write it to the
    // buffer unless recordContent is enabled, same as Claude Code's existing
    // tool_response/tool_input content handling.
    if (recordContent && data.content !== undefined) {
      event.outputContent = redact(truncate(data.content, maxContentLen));
    }
  } else if (eventName === 'afterfileedit') {
    // Cursor has no "beforeFileEdit" event — afterFileEdit is post-only,
    // mirror image of beforeReadFile above: emitted directly as a completed
    // post event via the same orphaned-post code path.
    event = {
      mode: 'post' as const,
      tool: 'Edit',
      timestamp,
      success: true,
      ...(data.file_path !== undefined && { toolInput: { file_path: data.file_path } }),
    };
  } else if (eventName === 'pre_read_code') {
    // Confirmed payload: https://docs.windsurf.com/windsurf/cascade/hooks#pre_read_code
    const filePath = getWindsurfToolInfo(data).file_path;
    event = {
      mode: 'pre' as const,
      tool: 'Read',
      timestamp,
      inputSize: sizeOf(filePath),
      inputHash: hashInput(filePath),
      ...(typeof filePath === 'string' && { toolInput: { file_path: filePath } }),
    };
  } else if (eventName === 'post_read_code') {
    // No source documents a failure signal for this event — success: true
    // unconditionally, same convention as Cursor's afterShellExecution.
    const filePath = getWindsurfToolInfo(data).file_path;
    event = {
      mode: 'post' as const,
      tool: 'Read',
      timestamp,
      success: true,
      ...(typeof filePath === 'string' && { toolInput: { file_path: filePath } }),
    };
  } else if (eventName === 'pre_write_code') {
    // Maps to 'Edit' not 'Write' — tool_info carries an edits[] array of
    // {old_string, new_string}, the same shape as Claude Code's Edit tool,
    // not a full-file Write. Mirrors Cursor's afterFileEdit -> 'Edit'.
    const filePath = getWindsurfToolInfo(data).file_path;
    event = {
      mode: 'pre' as const,
      tool: 'Edit',
      timestamp,
      inputSize: sizeOf(filePath),
      inputHash: hashInput(filePath),
      ...(typeof filePath === 'string' && { toolInput: { file_path: filePath } }),
    };
  } else if (eventName === 'post_write_code') {
    const filePath = getWindsurfToolInfo(data).file_path;
    event = {
      mode: 'post' as const,
      tool: 'Edit',
      timestamp,
      success: true,
      ...(typeof filePath === 'string' && { toolInput: { file_path: filePath } }),
    };
  } else if (eventName === 'pre_run_command') {
    // Confirmed payload: https://docs.windsurf.com/windsurf/cascade/hooks#pre_run_command
    const commandLineRaw = getWindsurfToolInfo(data).command_line;
    const commandLine = typeof commandLineRaw === 'string' ? commandLineRaw : '';
    event = {
      mode: 'pre' as const,
      tool: 'Bash',
      timestamp,
      inputSize: sizeOf(commandLine),
      inputHash: hashInput(commandLine),
      toolInput: { command: redact(commandLine) },
    };
  } else if (eventName === 'post_run_command') {
    // No source documents an exit-code/output field for this event —
    // success: true unconditionally, same gap as Cursor's afterShellExecution.
    event = {
      mode: 'post' as const,
      tool: 'Bash',
      timestamp,
      success: true,
    };
  } else if (eventName === 'pre_mcp_tool_use') {
    // mcp_tool_name is an arbitrary third-party MCP tool name, passed through
    // as-is (identity) — same treatment as Cursor's beforeMCPExecution and
    // src/platforms/generic-mcp-adapter.ts.
    const toolInfo = getWindsurfToolInfo(data);
    const mcpTool = typeof toolInfo.mcp_tool_name === 'string' ? toolInfo.mcp_tool_name : 'unknown';
    event = {
      mode: 'pre' as const,
      tool: mcpTool,
      timestamp,
      inputSize: sizeOf(toolInfo.mcp_tool_arguments),
      inputHash: hashInput(toolInfo.mcp_tool_arguments),
    };
  } else if (eventName === 'post_mcp_tool_use') {
    const toolInfo = getWindsurfToolInfo(data);
    const mcpTool = typeof toolInfo.mcp_tool_name === 'string' ? toolInfo.mcp_tool_name : 'unknown';
    event = {
      mode: 'post' as const,
      tool: mcpTool,
      timestamp,
      success: true,
    };
  } else {
    // Unknown hook event — ignore silently
    return;
  }

  // Attach session metadata
  if (data.cwd) event.cwd = data.cwd;
  if (data.transcript_path) event.transcriptPath = data.transcript_path;
  if (data.permission_mode) event.permissionMode = data.permission_mode;
  if (sessionId) event.sessionId = sessionId;
  if (data.tool_use_id) event.toolUseId = data.tool_use_id;

  // Write to buffer — wrapped in try/catch for resilience.
  try {
    const bufferPath = getBufferPath(sessionId);
    const bufferDir = dirname(bufferPath);
    if (!existsSync(bufferDir)) {
      mkdirSync(bufferDir, { recursive: true, mode: 0o700 });
    }

    const line = JSON.stringify(event) + '\n';

    const fd = openSync(
      bufferPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND,
      0o600,
    );
    try {
      writeFileSync(fd, line);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Silent failure — never block Claude Code
  }

  // After writing the tool event, collect token usage from the transcript.
  // Only on PostToolUse — each assistant turn produces exactly one usage object.
  if (eventName === 'posttooluse') {
    try {
      collectTranscriptTokens(data);
    } catch {
      // Silent failure — transcript reading is best-effort
    }
  }
}

// Exported for testing
export {
  processHook,
  redact,
  hashInput,
  sizeOf,
  truncate,
  getRecordContent,
  collectTranscriptTokens,
  readLastAssistantUsage,
  getTranscriptPath,
  translateWslPath,
  getBufferPath,
  writePpidBreadcrumb,
  readStdinSync,
};

// ---------------------------------------------------------------------------
// Entry point — only when run directly (not when imported by the MCP server)
// ---------------------------------------------------------------------------

import { realpathSync } from 'node:fs';

const _resolvedScript = (() => {
  try {
    return realpathSync(process.argv[1]);
  } catch {
    return process.argv[1];
  }
})();
const _isDirectExecution =
  _resolvedScript != null && /collector-script\.[jt]s$/.test(_resolvedScript);

/**
 * Seam for unit tests: replace the underlying synchronous read so tests can
 * exercise both platform branches without reading the real fd 0, which can
 * hang inside a test runner. Production code never sets this.
 * @internal
 */
export const _stdinFs = {
  readFileSync: (pathOrFd: string | number): string => readFileSync(pathOrFd, 'utf-8'),
};

/**
 * Windows has no `/dev/stdin` device file, so reading stdin synchronously
 * there requires going through its file descriptor (0) directly instead.
 * POSIX keeps using the `/dev/stdin` path rather than switching to the fd
 * everywhere, since reading a pipe fd directly can throw EAGAIN there.
 *
 * The win32 branch relies on a libuv fix (v1.44, Feb 2022) that stopped
 * treating a closed pipe as an EOF *error* on Windows — before that, reading
 * fd 0 while stdin was piped (exactly how Claude Code invokes this script)
 * threw instead of returning cleanly. package.json's `engines.node` floor
 * (>=22) is well past every Node release carrying that fix; don't lower it
 * without re-checking this. See nodejs/node#35997 and libuv/libuv#3043.
 *
 * `/dev/stdin` is a symlink to `/proc/self/fd/0`, so opening it is a fresh
 * `open()` subject to a permission check against the pipe's current owner —
 * unlike reading the already-inherited fd 0, which needs no such check. That
 * distinction is invisible on a normal POSIX host, but surfaces when Claude
 * Code runs on a Windows host and spawns this script inside WSL via
 * `wsl.exe`: the piped stdin crossing that boundary is created by WSL's
 * root-owned init/relay (root:root, mode 0600), so re-opening `/dev/stdin`
 * fails with EACCES for the non-root user even though fd 0 is readable. Fall
 * back to the fd only on that specific error so the common case keeps
 * avoiding the EAGAIN risk above.
 */
function readStdinSync(): string {
  if (process.platform === 'win32') {
    return _stdinFs.readFileSync(process.stdin.fd);
  }
  try {
    return _stdinFs.readFileSync('/dev/stdin');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EACCES') {
      return _stdinFs.readFileSync(process.stdin.fd);
    }
    throw err;
  }
}

if (_isDirectExecution) {
  try {
    const stdin = readStdinSync();
    if (stdin.trim()) {
      processHook(stdin);
    }
  } catch {
    // Silent failure — never block Claude Code
  }
}
