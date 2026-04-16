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

import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Lightweight config (env vars only — no file reads)
// ---------------------------------------------------------------------------

const DEFAULT_BUFFER_PATH = resolve(homedir(), '.nr-ai-observe', 'buffer.jsonl');

function getBufferPath(): string {
  return process.env.NEW_RELIC_AI_MCP_BUFFER_PATH ?? DEFAULT_BUFFER_PATH;
}

function getRecordContent(): boolean {
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
  /(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSPHRASE|PRIVATE_KEY)[\s]*[=:]\s*\S+/gi,
  /(?:sk-|ghp_|gho_|github_pat_|xoxb-|xoxp-|Bearer\s+)\S+/g,
  /-----BEGIN[\s\S]*?-----END[^\n]*-----/g,
];

function redact(value: string): string {
  let result = value;
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

    // Always store raw tool_input for tool-specific field parsing
    if (data.tool_input !== undefined) event.toolInput = data.tool_input;

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

    // Always store raw tool_response for tool-specific field parsing
    if (data.tool_response !== undefined) event.toolOutput = data.tool_response;

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
      error: data.error ?? 'unknown error',
      isInterrupt: data.is_interrupt ?? false,
    };
  } else {
    // Unknown hook event — ignore silently
    return;
  }

  // Attach session metadata
  if (data.session_id) event.sessionId = data.session_id;
  if (data.tool_use_id) event.toolUseId = data.tool_use_id;

  // Write to buffer — wrapped in try/catch for resilience
  try {
    const bufferPath = getBufferPath();
    const bufferDir = dirname(bufferPath);
    if (!existsSync(bufferDir)) {
      mkdirSync(bufferDir, { recursive: true });
    }
    appendFileSync(bufferPath, JSON.stringify(event) + '\n');
  } catch {
    // Silent failure — never block Claude Code
  }
}

// Exported for testing
export { processHook, redact, hashInput, sizeOf, truncate };

// ---------------------------------------------------------------------------
// Entry point — only when run directly
// ---------------------------------------------------------------------------

const _subcommand = process.argv[2];
if (_subcommand === 'install' || _subcommand === 'uninstall') {
  // Dynamic import keeps the hook path lightweight — commander and friends
  // are only loaded when the user explicitly runs install/uninstall.
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
