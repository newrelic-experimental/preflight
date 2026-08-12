// Preflight — GitHub Copilot CLI usage-capture extension
//
// Gives Copilot CLI sessions token-exact cost, mirroring what
// CopilotUsageWatcher already gives VS Code Copilot Chat sessions (see
// src/hooks/copilot-usage-watcher.ts in the Preflight repo). Tool-call
// capture for the CLI already works via the existing PreToolUse/PostToolUse
// hooks (~/.copilot/hooks/preflight.json) — this extension covers only the
// cost signal those hooks can't see: per-call token counts.
//
// WHY THIS FILE IS HAND-WRITTEN PLAIN JAVASCRIPT, NOT COMPILED FROM TYPESCRIPT:
// Copilot CLI extensions must be plain JavaScript — TypeScript and other
// languages are not supported (docs.github.com/en/copilot/concepts/agents/
// copilot-cli/about-cli-extensions, "How extensions are discovered"). The
// mapping logic below is a deliberate, minimal mirror of the tested,
// type-checked TypeScript module at src/hooks/copilot-cli-usage-mapper.ts in
// the Preflight repo (see that file's tests for the field-mapping evidence,
// captured from two real assistant.usage events) — KEEP THE TWO IN SYNC.
//
// WHY assistant.usage ONLY (no tool-call capture here): assistant.usage is
// ephemeral — delivered live but never persisted or replayed on resume
// (github.com/github/copilot-sdk streaming-events.md). It is the only source
// of per-call token counts; the persisted session log carries only coarse,
// cumulative totals at shutdown/checkpoint. Tool calls are deliberately
// NOT captured here — the existing hooks already do that, and capturing
// them again here would double-count.
//
// Installation: copy this file to ~/.copilot/extensions/preflight/extension.mjs
// (user-level, applies to every session) and run the CLI with --experimental
// (or `/experimental on` in an interactive session) — extensions are an
// experimental CLI feature. See docs/ADAPTERS.md's "GitHub Copilot CLI"
// section in the Preflight repo for full setup steps.

import { joinSession } from '@github/copilot-sdk/extension';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

function resolveStoragePath() {
  return process.env.NEW_RELIC_AI_MCP_STORAGE_PATH ?? resolve(homedir(), '.newrelic-preflight');
}

function resolveBufferPath(storagePath, sessionId) {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  return resolve(storagePath, `buffer-${sessionId}.jsonl`);
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

// Mirrors mapAssistantUsageEvent() in copilot-cli-usage-mapper.ts — see that
// file's tests for the field-mapping evidence. Returns null (never throws)
// when the payload is missing the fields a usable line requires.
function mapAssistantUsageEvent(data, sessionId, timestampMs) {
  if (typeof data !== 'object' || data === null) return null;

  const model = typeof data.model === 'string' && data.model.length > 0 ? data.model : null;
  if (!model) return null;

  const apiCallId =
    typeof data.apiCallId === 'string' && data.apiCallId.length > 0 ? data.apiCallId : null;
  if (!apiCallId) return null;

  const inputTokensRaw = num(data.inputTokens);
  const cacheReadTokens = num(data.cacheReadTokens);
  const cacheCreationTokens = num(data.cacheWriteTokens);

  return {
    mode: 'token',
    tool: 'copilot-cli-usage',
    timestamp: timestampMs,
    sessionId,
    messageId: apiCallId,
    model,
    // SDK's inputTokens is inclusive of both cache-read and cache-write —
    // subtract both so the uncached remainder isn't double-billed at the
    // base input rate.
    inputTokens: Math.max(0, inputTokensRaw - cacheReadTokens - cacheCreationTokens),
    outputTokens: num(data.outputTokens),
    cacheReadTokens,
    cacheCreationTokens,
  };
}

function appendTokenLine(bufferPath, line) {
  try {
    mkdirSync(dirname(bufferPath), { recursive: true, mode: 0o700 });
    appendFileSync(bufferPath, JSON.stringify(line) + '\n', { mode: 0o600 });
  } catch {
    // Best-effort — a write failure here must never crash the extension
    // process or the CLI session it's attached to.
  }
}

try {
  const session = await joinSession({ tools: [] });
  const sessionId = typeof session?.sessionId === 'string' ? session.sessionId : null;

  if (sessionId) {
    const storagePath = resolveStoragePath();
    session.on('assistant.usage', (event) => {
      const line = mapAssistantUsageEvent(event?.data, sessionId, Date.now());
      if (!line) return;
      const bufferPath = resolveBufferPath(storagePath, sessionId);
      if (!bufferPath) return;
      appendTokenLine(bufferPath, line);
    });
  }
} catch {
  // If joinSession() itself fails (e.g. incompatible CLI version), do
  // nothing — never let this extension prevent the CLI session from working.
}
