/**
 * Maps GitHub Copilot SDK `assistant.usage` events to Preflight's `mode:
 * 'token'` buffer-line contract, and resolves the buffer file path — the
 * shared, tested logic behind `copilot-sdk-extension/extension.mjs` (a
 * hand-maintained plain-JS mirror of this file; Copilot SDK extensions must
 * be written in JavaScript, so the logic can't be imported directly — see
 * that file's header comment).
 *
 * Field mapping verified against two real `assistant.usage` events captured
 * live from a Copilot SDK session, via the Copilot CLI host (see
 * copilot-sdk-usage-mapper.test.ts):
 * the SDK's `inputTokens` is inclusive of BOTH cache-read and cache-write
 * (unlike VS Code's debug log, which is cache-read-inclusive only) — proven
 * by cross-checking against the SDK's own `copilotUsage.tokenDetails`
 * per-token-type breakdown on both samples.
 */

import { homedir } from 'node:os';
import { resolve } from 'node:path';

const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

export interface TokenBufferLine {
  readonly mode: 'token';
  readonly tool: 'copilot-sdk-usage';
  readonly timestamp: number;
  readonly sessionId: string;
  readonly messageId: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Maps an `assistant.usage` event's `data` payload to a `mode: 'token'`
 * buffer line. Returns `null` when the payload is missing the two fields a
 * usable line requires — `model` (priced downstream) and `apiCallId` (the
 * stable per-call dedup key `HookEventProcessor.handleTokenEvent()` uses) —
 * rather than emitting a line with fabricated values. Never throws.
 */
export function mapAssistantUsageEvent(
  data: unknown,
  sessionId: string,
  timestampMs: number,
): TokenBufferLine | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;

  const model = typeof d.model === 'string' && d.model.length > 0 ? d.model : null;
  if (!model) return null;

  const apiCallId = typeof d.apiCallId === 'string' && d.apiCallId.length > 0 ? d.apiCallId : null;
  if (!apiCallId) return null;

  const inputTokensRaw = num(d.inputTokens);
  const cacheReadTokens = num(d.cacheReadTokens);
  const cacheCreationTokens = num(d.cacheWriteTokens);

  return {
    mode: 'token',
    tool: 'copilot-sdk-usage',
    timestamp: timestampMs,
    sessionId,
    messageId: apiCallId,
    model,
    // SDK's inputTokens is inclusive of both cache-read and cache-write —
    // subtract both so the uncached remainder isn't double-billed at the
    // base input rate (see header comment).
    inputTokens: Math.max(0, inputTokensRaw - cacheReadTokens - cacheCreationTokens),
    outputTokens: num(d.outputTokens),
    cacheReadTokens,
    cacheCreationTokens,
  };
}

/** Storage dir for cursor/buffer files — same env var and default as collector-script.ts. */
export function resolveStoragePath(): string {
  return process.env.NEW_RELIC_AI_MCP_STORAGE_PATH ?? resolve(homedir(), '.newrelic-preflight');
}

/**
 * Resolves `<storagePath>/buffer-<sessionId>.jsonl`. Validates `sessionId`
 * against the same pattern collector-script.ts uses, returning `null` for an
 * invalid id rather than letting it escape the storage dir.
 */
export function resolveBufferPath(storagePath: string, sessionId: string): string | null {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  return resolve(storagePath, `buffer-${sessionId}.jsonl`);
}
