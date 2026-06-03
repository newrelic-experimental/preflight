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

import { readFileSync, readSync, writeFileSync, openSync, closeSync, mkdirSync, existsSync, constants as fsConstants, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Lightweight config (env vars only — no file reads)
// ---------------------------------------------------------------------------

const DEFAULT_BUFFER_PATH = resolve(homedir(), '.nr-ai-observe', 'buffer.jsonl');

/** POSIX PIPE_BUF — writes at or below this size are atomic with O_APPEND. */
const PIPE_BUF = 4096;

function getBufferPath(): string {
  return process.env.NEW_RELIC_AI_MCP_BUFFER_PATH ?? DEFAULT_BUFFER_PATH;
}

function getHighSecurity(): boolean {
  const highSecurityEnv = process.env.NEW_RELIC_AI_MCP_HIGH_SECURITY === 'true';
  if (highSecurityEnv) return true;

  try {
    const configPath = resolve(homedir(), '.nr-ai-observe', 'config.json');
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      return config.highSecurity === true;
    }
  } catch {
    // Silently ignore config read errors
  }

  return false;
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
  /\b(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSPHRASE|PRIVATE_KEY)\b[\s]*[=:]\s*\S+/gi,
  /(?:sk-|ghp_|gho_|github_pat_|xoxb-|xoxp-|Bearer\s+)\S+/g,
  /-----BEGIN[\s\S]{0,65536}?-----END[^\n]{0,256}-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIzaSy[0-9A-Za-z_-]{33}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bxox[a-z]-[0-9A-Za-z-]+/g,
];

const MAX_REDACT_LEN = 1_048_576; // 1 MB

function redact(value: string): string {
  let result = value.length > MAX_REDACT_LEN ? value.slice(0, MAX_REDACT_LEN) : value;
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
  return JSON.stringify(value).length;
}

function truncate(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  return value.slice(0, maxLen) + '...[truncated]';
}

function countLines(text: string): number {
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
}

function getClaudeHome(): string {
  return process.env.NR_AI_OBSERVE_CLAUDE_HOME ?? resolve(homedir(), '.claude');
}

function getTranscriptPath(cwd: string | undefined, sessionId: string | undefined): string | null {
  if (!sessionId) return null;
  const projectDir = cwd
    ? cwd.replace(/\//g, '-')
    : process.env.PWD?.replace(/\//g, '-');
  if (!projectDir) return null;
  return resolve(getClaudeHome(), 'projects', projectDir, `${sessionId}.jsonl`);
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
          const entry = JSON.parse(lines[i]) as Record<string, unknown>;
          if (entry.type === 'assistant' && entry.message && typeof entry.message === 'object') {
            const msg = entry.message as Record<string, unknown>;
            if (msg.usage && typeof msg.usage === 'object') {
              return msg.usage as TranscriptUsage;
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
  try {
    const bufferDir = dirname(getBufferPath());
    const statePath = resolve(bufferDir, `.transcript-pos-${sessionId}`);
    if (existsSync(statePath)) {
      return parseInt(readFileSync(statePath, 'utf-8').trim(), 10) || 0;
    }
  } catch {
    // Ignore
  }
  return 0;
}

function setLastTranscriptSize(sessionId: string, size: number): void {
  try {
    const bufferDir = dirname(getBufferPath());
    if (!existsSync(bufferDir)) {
      mkdirSync(bufferDir, { recursive: true, mode: 0o700 });
    }
    const statePath = resolve(bufferDir, `.transcript-pos-${sessionId}`);
    writeFileSync(statePath, String(size), { mode: 0o600 });
  } catch {
    // Ignore
  }
}

function collectTranscriptTokens(data: { cwd?: string; session_id?: string }): void {
  const sessionId = data.session_id;
  const transcriptPath = getTranscriptPath(data.cwd as string | undefined, sessionId);
  if (!transcriptPath || !sessionId) return;

  let currentSize: number;
  try {
    currentSize = statSync(transcriptPath).size;
  } catch {
    return;
  }

  const lastSize = getLastTranscriptSize(sessionId);
  if (currentSize <= lastSize) return;

  const usage = readLastAssistantUsage(transcriptPath);
  if (!usage) return;

  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  if (inputTokens === 0 && outputTokens === 0) return;

  setLastTranscriptSize(sessionId, currentSize);

  const tokenEvent: Record<string, unknown> = {
    mode: 'token',
    timestamp: Date.now(),
    inputTokens,
    outputTokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
    model: DEFAULT_MODEL,
  };
  tokenEvent.sessionId = sessionId;

  try {
    const bufferPath = getBufferPath();
    const bufferDir = dirname(bufferPath);
    if (!existsSync(bufferDir)) {
      mkdirSync(bufferDir, { recursive: true, mode: 0o700 });
    }

    const line = JSON.stringify(tokenEvent) + '\n';
    const fd = openSync(bufferPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND, 0o600);
    try {
      writeFileSync(fd, line);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Silent failure — never block Claude Code
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
  error?: string;
  is_interrupt?: boolean;
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
      if (typeof obj.command === 'string') meta.command = obj.command;
      if (typeof obj.description === 'string') meta.description = obj.description;
      if (typeof obj.timeout === 'number') meta.timeout = obj.timeout;
      if (typeof obj.run_in_background === 'boolean') meta.run_in_background = obj.run_in_background;
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
      if (typeof obj.run_in_background === 'boolean') meta.run_in_background = obj.run_in_background;
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

  return undefined;
}

function processHook(raw: string): void {
  const data: HookInput = JSON.parse(raw);

  const eventName = data.hook_event_name;
  const toolName = data.tool_name ?? 'unknown';
  const timestamp = Date.now();
  const recordContent = getRecordContent();
  const maxContentLen = getMaxContentLength();

  let event: Record<string, unknown>;

  if (eventName === 'PreToolUse') {
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
      const content = typeof data.tool_input === 'string'
        ? data.tool_input
        : JSON.stringify(data.tool_input);
      event.inputContent = redact(truncate(content, maxContentLen));
    }
  } else if (eventName === 'PostToolUse') {
    event = {
      mode: 'post' as const,
      tool: toolName,
      timestamp,
      outputSize: sizeOf(data.tool_response),
      success: true,
    };

    // Store input metadata as fallback for orphaned-post pairing (pre-event may be missing)
    const postInputMeta = extractInputMeta(toolName, data.tool_input);
    if (postInputMeta !== undefined) event.toolInput = postInputMeta;

    // Store only the metadata fields needed for tool-specific parsing
    const outputMeta = extractOutputMeta(toolName, data.tool_response);
    if (outputMeta !== undefined) event.toolOutput = outputMeta;

    if (recordContent && data.tool_response !== undefined) {
      const content = typeof data.tool_response === 'string'
        ? data.tool_response
        : JSON.stringify(data.tool_response);
      event.outputContent = redact(truncate(content, maxContentLen));
    }
  } else if (eventName === 'PostToolUseFailure') {
    event = {
      mode: 'post' as const,
      tool: toolName,
      timestamp,
      success: false,
      error: redact(data.error ?? 'unknown error'),
      isInterrupt: data.is_interrupt ?? false,
    };
  } else {
    // Unknown hook event — ignore silently
    return;
  }

  // Attach session metadata
  if (data.session_id) event.sessionId = data.session_id;
  if (data.tool_use_id) event.toolUseId = data.tool_use_id;

  // Write to buffer — wrapped in try/catch for resilience.
  // Uses O_APPEND + single write to guarantee atomicity for lines <= PIPE_BUF.
  try {
    const bufferPath = getBufferPath();
    const bufferDir = dirname(bufferPath);
    if (!existsSync(bufferDir)) {
      mkdirSync(bufferDir, { recursive: true, mode: 0o700 });
    }

    let line = JSON.stringify(event) + '\n';

    // If the line exceeds PIPE_BUF, trim toolInput to fit — concurrent
    // writers can interleave larger writes on POSIX systems.
    if (line.length > PIPE_BUF && event.toolInput !== undefined) {
      const overhead = line.length - JSON.stringify(event.toolInput).length;
      const budget = PIPE_BUF - overhead - 20; // margin for truncation suffix
      event.toolInput = truncate(
        typeof event.toolInput === 'string' ? event.toolInput : JSON.stringify(event.toolInput),
        Math.max(budget, 64),
      );
      line = JSON.stringify(event) + '\n';
    }

    const fd = openSync(bufferPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND, 0o600);
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
  if (eventName === 'PostToolUse') {
    try {
      collectTranscriptTokens(data);
    } catch {
      // Silent failure — transcript reading is best-effort
    }
  }
}

// Exported for testing
export { processHook, redact, hashInput, sizeOf, truncate, getRecordContent, collectTranscriptTokens, readLastAssistantUsage, getTranscriptPath };

// ---------------------------------------------------------------------------
// Entry point — only when run directly (not when imported by the MCP server)
// ---------------------------------------------------------------------------

import { realpathSync } from 'node:fs';

const _resolvedScript = (() => {
  try { return realpathSync(process.argv[1]); } catch { return process.argv[1]; }
})();
const _isDirectExecution = _resolvedScript != null && /collector-script\.[jt]s$/.test(_resolvedScript);

if (_isDirectExecution) {
  const _subcommand = process.argv[2];
  if (_subcommand === 'install' || _subcommand === 'uninstall' || _subcommand === 'setup' || _subcommand === 'update' || (_subcommand !== undefined && _subcommand.startsWith('-'))) {
    // Dynamic import keeps the hook path lightweight — commander and friends
    // are only loaded when the user explicitly runs install/uninstall/setup.
    import('../install/cli.js')
      .then((mod) => mod.runInstallCli(process.argv.slice(2)))
      .catch((err: unknown) => {
        process.stderr.write(`Error: ${String(err)}\n`);
        process.exitCode = 1;
      });
  } else {
    try {
      const stdin = readFileSync('/dev/stdin', 'utf-8');
      if (stdin.trim()) {
        processHook(stdin);
      }
    } catch {
      // Silent failure — never block Claude Code
    }
  }
}
