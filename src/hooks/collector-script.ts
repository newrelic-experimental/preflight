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
  writeFileSync,
  openSync,
  closeSync,
  mkdirSync,
  existsSync,
  utimesSync,
  constants as fsConstants,
} from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { REDACTION_PATTERNS } from '../redaction-patterns.js';
import { resolveRecordContent } from '../record-content-gate.js';

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
  return resolveRecordContent(
    getHighSecurity(),
    process.env.NEW_RELIC_AI_MCP_RECORD_CONTENT === 'true',
  );
}

function getMaxContentLength(): number {
  const val = process.env.NEW_RELIC_AI_MCP_MAX_CONTENT_LENGTH;
  if (val === undefined) return 10_240;
  const parsed = parseInt(val, 10);
  return Number.isNaN(parsed) ? 10_240 : parsed;
}

// ---------------------------------------------------------------------------
// Inline redaction (patterns shared with config.ts via ../redaction-patterns.js)
// ---------------------------------------------------------------------------

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

/** A content block carrying a `text` field — narrows before reading `.text`. */
function hasStringText(block: unknown): block is { text: string } {
  return (
    typeof block === 'object' &&
    block !== null &&
    'text' in block &&
    typeof (block as { text?: unknown }).text === 'string'
  );
}

// ---------------------------------------------------------------------------
// PPID + cwd breadcrumbs — let the MCP server learn the Claude Code session_id
//
// Claude Code spawns its MCP server and hook collector scripts as children of
// the same process; they share a PPID. The MCP can read its own process.ppid
// (= Claude Code's PID) and look up the matching session_id here.
//
// Some platforms interpose a shell between Claude Code and the hook collector
// that the ancestor-PID walk below doesn't reach (native Windows via Git
// Bash, for one) — there, the collector's ppid never matches the MCP's own
// process.ppid. writeCwdBreadcrumb() writes a second breadcrumb keyed by the
// sanitized project cwd instead, which the MCP server falls back to (via
// resolveFromCwd() in session-resolver.ts) only when the PPID lookup misses.
//
// Hot-path: every PreToolUse / PostToolUse hook runs this. The
// existsSync + content-equality short-circuit makes the steady state a single
// stat() and one read per breadcrumb — well under the <5ms budget.
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
      // Short-circuit: no content rewrite needed if it already matches, but
      // still touch mtime — resolveFromBreadcrumb() (session-resolver.ts)
      // rejects a breadcrumb older than the reading process's own start
      // time, so an actively-hooked session's breadcrumb must keep looking
      // fresh across an MCP server restart (same ppid, same session_id,
      // content genuinely unchanged) or that restart would permanently lose
      // ppid-based resolution for the rest of the session. A breadcrumb from
      // a session that's actually over stops getting touched here (nothing
      // calls this with its old ppid+session_id again), so it still goes
      // stale and gets rejected exactly as intended.
      if (existsSync(breadcrumbPath)) {
        try {
          if (readFileSync(breadcrumbPath, 'utf-8').trim() === sessionId) {
            const now = new Date();
            try {
              utimesSync(breadcrumbPath, now, now);
            } catch {
              // Best-effort — an unwritable mtime doesn't block the session.
            }
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

let _cwdBreadcrumbWriteFailed = false;

function writeCwdBreadcrumb(sessionId: string, cwd: string | undefined): void {
  if (!SESSION_ID_RE.test(sessionId)) return;
  if (typeof cwd !== 'string' || cwd.length === 0) return;

  try {
    const storageDir = process.env.NEW_RELIC_AI_MCP_STORAGE_PATH ?? DEFAULT_STORAGE_DIR;
    const breadcrumbDir = resolve(storageDir, 'session-by-cwd');
    mkdirSync(breadcrumbDir, { recursive: true, mode: 0o700 });

    // Same sanitization scheme as getTranscriptPath() above, so the MCP
    // server's resolveFromCwd() can derive an identical filename from its
    // own process.cwd() without any shared state beyond this convention.
    // Colons are also stripped (unlike getTranscriptPath) — a Windows drive
    // letter like "C:" left in the filename gets misinterpreted by
    // path.resolve() on win32 as a drive-relative path component rather than
    // a literal character, which can write/read outside this storage dir.
    const sanitizedCwd = cwd.replace(/[\\/:]/g, '-');
    const breadcrumbPath = resolve(breadcrumbDir, `${sanitizedCwd}.txt`);

    if (existsSync(breadcrumbPath)) {
      try {
        if (readFileSync(breadcrumbPath, 'utf-8').trim() === sessionId) {
          _cwdBreadcrumbWriteFailed = false;
          return;
        }
      } catch {
        // Fall through to rewrite if the read failed.
      }
    }
    writeFileSync(breadcrumbPath, sessionId, { mode: 0o600 });
    _cwdBreadcrumbWriteFailed = false;
  } catch (err) {
    if (!_cwdBreadcrumbWriteFailed) {
      process.stderr.write(
        `[preflight-collector] Warning: cannot write cwd breadcrumb: ${String(err)}\n`,
      );
      _cwdBreadcrumbWriteFailed = true;
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
  tool_result?: unknown;
  tool_use_id?: string;
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
  error?: string;
  is_interrupt?: boolean;
  // StopFailure (code.claude.com/docs/en/hooks.md) reuses `error` above for its
  // closed error-type enum and adds these two free-text fields: error_details
  // ("when available", no strict type — string or an object to JSON.stringify)
  // and last_assistant_message (the raw API error text shown to the user, NOT
  // Claude's conversational output as it is for Stop/SubagentStop).
  error_details?: unknown;
  last_assistant_message?: string;
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
  // Antigravity (https://antigravity.google/docs/hooks, identical on
  // /docs/ide/hooks) sends no field naming which event fired at all —
  // PreToolUse payloads carry `toolCall`/`stepIdx`; PostToolUse payloads
  // carry only `stepIdx`/`error`. `conversationId` is Antigravity's closest
  // analog to session_id (never sends session_id, same situation as
  // Cursor's conversation_id and Windsurf's trajectory_id).
  toolCall?: { name?: string; args?: Record<string, unknown> };
  stepIdx?: number;
  conversationId?: string;
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

  // Common field: file_path (Read, Write, Edit). VS Code Copilot hooks send
  // camelCase tool_input keys (filePath) per the hooks FAQ
  // (https://code.visualstudio.com/docs/copilot/customization/hooks).
  if (typeof obj.file_path === 'string') meta.file_path = obj.file_path;
  else if (typeof obj.filePath === 'string') meta.file_path = obj.filePath;

  switch (toolName) {
    case 'Read':
      if (typeof obj.offset === 'number') meta.offset = obj.offset;
      if (typeof obj.limit === 'number') meta.limit = obj.limit;
      break;
    case 'Write':
    case 'create_file': // VS Code Copilot — same `content` field shape
      if (typeof obj.content === 'string') {
        meta.contentLength = obj.content.length;
        meta.lineCount = obj.content.length > 0 ? countLines(obj.content) : 0;
      }
      break;
    // VS Code Copilot's find-and-replace edit tools. Field names are camelCase
    // (oldString/newString) per the hooks FAQ; tool names from toolNames.ts in
    // microsoft/vscode (extensions/copilot/src/extension/tools/common/).
    case 'replace_string_in_file': {
      const oldStr = obj.oldString;
      const newStr = obj.newString;
      if (typeof oldStr === 'string') {
        meta.oldStringLength = oldStr.length;
        meta.oldLineCount = oldStr.length > 0 ? countLines(oldStr) : 0;
      }
      if (typeof newStr === 'string') {
        meta.newStringLength = newStr.length;
        meta.newLineCount = newStr.length > 0 ? countLines(newStr) : 0;
        meta.isDelete = newStr.length === 0;
      }
      break;
    }
    case 'multi_replace_string_in_file':
      if (Array.isArray(obj.replacements)) meta.replacementsCount = obj.replacements.length;
      break;
    case 'run_in_terminal':
      if (typeof obj.command === 'string') meta.command = redact(obj.command);
      if (typeof obj.explanation === 'string') meta.description = redact(obj.explanation);
      if (typeof obj.isBackground === 'boolean') meta.run_in_background = obj.isBackground;
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
    // PowerShell is a real, first-party Claude Code tool on native Windows,
    // auto-enabled without Git Bash (code.claude.com/docs/en/tools-reference,
    // /setup, /env-vars) — same command/description/timeout/run_in_background
    // input shape as Bash.
    case 'Bash':
    case 'PowerShell':
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
  // Antigravity (https://antigravity.google/docs/hooks) never sends
  // session_id either — conversationId (camelCase, Antigravity's own field
  // name) is its closest analog, same role trajectory_id plays for Windsurf.
  const sessionId =
    data.session_id ?? data.conversation_id ?? data.trajectory_id ?? data.conversationId;

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
    writeCwdBreadcrumb(data.session_id, data.cwd);
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

  // Gemini CLI (https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/index.md,
  // "Strict JSON requirements") requires hook stdout to be either empty
  // (treated as a parse failure that falls back to a warning + "Allow") or
  // valid JSON — every one of its own example hooks prints "{}" even for
  // pure side-effect hooks. No other platform reads this collector's
  // stdout, so this check is scoped to Gemini CLI only.
  const isGeminiCli =
    process.env.MCP_CLIENT === 'gemini-cli' || process.env.NEW_RELIC_AI_PLATFORM === 'gemini-cli';

  // Antigravity (https://antigravity.google/docs/hooks) sends no field
  // naming which event fired — payload shape is the only signal. Hoisted
  // once so the dispatch branch below and the required-stdout-reply block
  // further down can never diverge on which event they think this is, same
  // precedent as isGeminiCli above.
  const isAntigravityPre = data.toolCall !== undefined;
  const isAntigravityPost =
    !isAntigravityPre &&
    typeof data.stepIdx === 'number' &&
    data.hook_event_name === undefined &&
    data.agent_action_name === undefined;

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
    // GitHub Copilot CLI sends the tool's result under `tool_result`, not
    // `tool_response`, and signals outcome with `result_type: 'success' |
    // 'failure'` rather than a `success` boolean (confirmed against the CLI's
    // own runtime, which serializes `toolResult`/`resultType`/
    // `text_result_for_llm` and fires a matching `postToolUseFailure` event).
    // Without this alias every Copilot CLI tool call recorded outputSize 0,
    // no output metadata, and success: true unconditionally.
    const toolResponse = data.tool_response ?? data.tool_result;
    const responseObj =
      toolResponse !== null && typeof toolResponse === 'object' && !Array.isArray(toolResponse)
        ? (toolResponse as Record<string, unknown>)
        : undefined;
    const responseSuccess =
      responseObj === undefined
        ? undefined
        : responseObj.success !== undefined
          ? responseObj.success
          : responseObj.result_type !== undefined
            ? responseObj.result_type !== 'failure'
            : undefined;
    event = {
      mode: 'post' as const,
      tool: toolName,
      timestamp,
      outputSize: sizeOf(toolResponse),
      success: typeof responseSuccess === 'boolean' ? responseSuccess : true,
    };

    // Store input metadata as fallback for orphaned-post pairing (pre-event may be missing)
    const postInputMeta = extractInputMeta(toolName, data.tool_input);
    if (postInputMeta !== undefined) event.toolInput = postInputMeta;

    // Store only the metadata fields needed for tool-specific parsing
    const outputMeta = extractOutputMeta(toolName, toolResponse);
    if (outputMeta !== undefined) event.toolOutput = outputMeta;

    if (recordContent && toolResponse !== undefined) {
      const content =
        typeof toolResponse === 'string' ? toolResponse : JSON.stringify(toolResponse);
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
  } else if (eventName === 'beforetool') {
    // Gemini CLI (https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md)
    // sends BeforeTool/AfterTool instead of PreToolUse/PostToolUse, but the
    // fields inside those events (tool_name, tool_input, tool_response) match
    // Claude Code's shape exactly — reuse the same field extraction as the
    // pretooluse branch above.
    event = {
      mode: 'pre' as const,
      tool: toolName,
      timestamp,
      inputSize: sizeOf(data.tool_input),
      inputHash: hashInput(data.tool_input),
    };

    const inputMeta = extractInputMeta(toolName, data.tool_input);
    if (inputMeta !== undefined) event.toolInput = inputMeta;

    if (recordContent && data.tool_input !== undefined) {
      const content =
        typeof data.tool_input === 'string' ? data.tool_input : JSON.stringify(data.tool_input);
      event.inputContent = redact(truncate(content, maxContentLen));
    }
  } else if (eventName === 'aftertool') {
    // Gemini CLI has no tool_response.success boolean (unlike Kiro/Amazon Q) —
    // failure is signaled by the presence of tool_response.error instead
    // (https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md,
    // AfterTool's documented output fields: "tool_response... containing
    // llmContent, returnDisplay, and optional error").
    const toolResponse = data.tool_response;
    const hasError =
      toolResponse !== null &&
      typeof toolResponse === 'object' &&
      !Array.isArray(toolResponse) &&
      (toolResponse as Record<string, unknown>).error !== undefined;
    event = {
      mode: 'post' as const,
      tool: toolName,
      timestamp,
      outputSize: sizeOf(data.tool_response),
      success: !hasError,
    };

    const postInputMeta = extractInputMeta(toolName, data.tool_input);
    if (postInputMeta !== undefined) event.toolInput = postInputMeta;

    const outputMeta = extractOutputMeta(toolName, data.tool_response);
    if (outputMeta !== undefined) event.toolOutput = outputMeta;

    if (recordContent && data.tool_response !== undefined) {
      const content =
        typeof data.tool_response === 'string'
          ? data.tool_response
          : JSON.stringify(data.tool_response);
      event.outputContent = redact(truncate(content, maxContentLen));
    }
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
  } else if (isAntigravityPre) {
    // Antigravity PreToolUse — no self-describing event-name field exists
    // (see HookInput's comment above); presence of `toolCall` is
    // Antigravity's own signal that this is PreToolUse, since PostToolUse
    // never carries that key.
    const agyToolName = data.toolCall?.name ?? 'unknown';
    event = {
      mode: 'pre' as const,
      tool: agyToolName,
      timestamp,
      inputSize: sizeOf(data.toolCall?.args),
      inputHash: hashInput(data.toolCall?.args),
      ...(typeof data.stepIdx === 'number' && { toolUseId: String(data.stepIdx) }),
    };

    // Raw Antigravity argument names (CommandLine, TargetFile, etc.) don't
    // match any canonical-name case in extractInputMeta()'s switch, so this
    // currently always returns undefined — a known, documented gap (see
    // docs/ADAPTERS.md's Antigravity section), not a guess at field names.
    const inputMeta = extractInputMeta(agyToolName, data.toolCall?.args);
    if (inputMeta !== undefined) event.toolInput = inputMeta;

    if (recordContent && data.toolCall?.args !== undefined) {
      event.inputContent = redact(truncate(JSON.stringify(data.toolCall.args), maxContentLen));
    }
  } else if (isAntigravityPost) {
    // Antigravity PostToolUse — carries no tool-name field at all, only
    // stepIdx/error. toolUseId-based pairing in event-processor.ts recovers
    // the real tool name from the matched pre-event (confirmed by reading
    // HookEventProcessor.handlePostEvent(): the merged record's toolName
    // always comes from the pre-event, never the post-event's own tool
    // field) — 'unknown' here is a safe placeholder, not a broken mapping.
    const hasError = typeof data.error === 'string' && data.error !== '';
    event = {
      mode: 'post' as const,
      tool: 'unknown',
      timestamp,
      success: !hasError,
      toolUseId: String(data.stepIdx),
      ...(typeof data.error === 'string' && data.error !== '' && { error: redact(data.error) }),
    };
  } else if (eventName === 'stopfailure') {
    // Fires once per turn when a model-API call ultimately fails after
    // Claude Code's own internal retries are exhausted
    // (code.claude.com/docs/en/hooks.md). Pure notification — no decision
    // control. `data.error` here is the 10-value closed error-type enum
    // (rate_limit | overloaded | authentication_failed | ... | unknown),
    // mapped downstream to ApiErrorType by
    // metrics/api-failure-tracker.ts#mapClaudeCodeErrorType — never mapped
    // here, since storage/types.ts must not depend on that module.
    event = {
      mode: 'api_failure' as const,
      errorType: data.error ?? 'unknown',
      timestamp,
    };

    // error_details/last_assistant_message are free-text "content" — same
    // sensitivity class as tool input/output content — unlike errorType
    // (a safe closed enum), so both are gated behind recordContent.
    if (recordContent) {
      if (data.error_details !== undefined) {
        const details =
          typeof data.error_details === 'string'
            ? data.error_details
            : JSON.stringify(data.error_details);
        event.errorDetails = redact(truncate(details, maxContentLen));
      }
      if (typeof data.last_assistant_message === 'string') {
        event.lastAssistantMessage = redact(truncate(data.last_assistant_message, maxContentLen));
      }
    }
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

  // Gemini CLI's own hook examples always print "{}" before exiting 0, even
  // for pure side-effect hooks — see the isGeminiCli comment above. Gated to
  // Gemini CLI only; no other platform's collector behavior changes.
  if (isGeminiCli) {
    try {
      process.stdout.write('{}\n');
    } catch {
      // Silent failure — never block Gemini CLI
    }
  }

  // Antigravity requires a stdout reply on every PreToolUse/PostToolUse hook
  // invocation (https://antigravity.google/docs/hooks) — a required
  // `decision` field for PreToolUse, an empty object for PostToolUse.
  // Preflight is observation-only, so this always allows.
  if (isAntigravityPre) {
    try {
      process.stdout.write('{"decision":"allow"}\n');
    } catch {
      // Silent failure — never block Antigravity
    }
  } else if (isAntigravityPost) {
    try {
      process.stdout.write('{}\n');
    } catch {
      // Silent failure — never block Antigravity
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
  getBufferPath,
  writePpidBreadcrumb,
  writeCwdBreadcrumb,
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
 * fails with EACCES for the non-root user even though fd 0 is readable.
 *
 * A second case where the path fails but the fd works: when the spawning
 * process is itself Node/Electron (VS Code's Copilot Chat runs hooks this
 * way), libuv backs a `stdio: 'pipe'` child with a *socketpair* rather than
 * a FIFO. `open()` on a unix socket via /proc/self/fd fails with ENXIO, so
 * `/dev/stdin` is unusable there even though fd 0 reads fine.
 *
 * Rather than enumerate errnos, fall back to the fd on any /dev/stdin
 * failure — the fd read is the more universally correct source, and the path
 * is only preferred to dodge the EAGAIN risk noted above. If the fallback
 * fails too, that error propagates.
 */
function readStdinSync(): string {
  if (process.platform === 'win32') {
    return _stdinFs.readFileSync(process.stdin.fd);
  }
  try {
    return _stdinFs.readFileSync('/dev/stdin');
  } catch {
    return _stdinFs.readFileSync(process.stdin.fd);
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
