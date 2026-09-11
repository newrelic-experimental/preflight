import { createHash } from 'node:crypto';

import type {
  RawTranscriptEntry,
  RawAssistantMessage,
  RawUsage,
} from '../hooks/transcript-types.js';

/**
 * Field-level result of parsing one JSONL transcript line as an assistant
 * turn with token usage. Deliberately does not reject on missing
 * model/messageId/timestamp — `SubagentWatcher` and `SubagentTimelineStore`
 * apply slightly different acceptance policies for those (see each call
 * site), so this module only does the parsing genuinely identical between
 * them: JSON validity, type/shape checks, numeric field extraction, and the
 * two schema-drift fingerprints.
 */
export interface ParsedAssistantTurnFields {
  readonly messageId: string | null;
  readonly model: string | null;
  readonly turnUuid: string;
  readonly rawTimestamp: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly reasoningTokens: number;
  readonly stopReason: string | null;
  readonly usageKeysFingerprint: string;
  readonly contentBlockTypesFingerprint: string;
}

export interface ParseAssistantTurnLineResult {
  /**
   * null when the line is not a usable assistant-turn-with-usage line: wrong
   * `type`, missing/non-object `message`, or missing/non-object
   * `message.usage`.
   */
  readonly fields: ParsedAssistantTurnFields | null;
  /** true only when `JSON.parse` itself threw on this line. */
  readonly invalidJson: boolean;
}

export function parseAssistantTurnLine(line: string): ParseAssistantTurnLineResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { fields: null, invalidJson: true };
  }
  if (!parsed || typeof parsed !== 'object') return { fields: null, invalidJson: false };
  const obj = parsed as RawTranscriptEntry;
  if (obj.type !== 'assistant') return { fields: null, invalidJson: false };

  const message = obj.message;
  if (!message || typeof message !== 'object') return { fields: null, invalidJson: false };
  const m = message as RawAssistantMessage;

  const usage = m.usage;
  if (!usage || typeof usage !== 'object') return { fields: null, invalidJson: false };
  const u = usage as RawUsage;

  const model = typeof m.model === 'string' ? m.model : null;
  const messageId = typeof m.id === 'string' ? m.id : null;
  const turnUuid = typeof obj.uuid === 'string' ? obj.uuid : '';
  const rawTimestamp = typeof obj.timestamp === 'string' ? obj.timestamp : null;
  const stopReason = typeof m.stop_reason === 'string' ? m.stop_reason : null;

  const inputTokens = num(u.input_tokens);
  const outputTokens = num(u.output_tokens);
  const cacheReadTokens = num(u.cache_read_input_tokens);
  const cacheCreationTokens = num(u.cache_creation_input_tokens);
  let reasoningTokens = 0;
  const otd = u.output_tokens_details;
  if (otd && typeof otd === 'object') {
    reasoningTokens = num(otd.reasoning_tokens);
  }

  const usageKeysFingerprint = computeUsageKeysFingerprint(u);
  const contentBlockTypesFingerprint = computeContentBlockTypesFingerprint(m.content);

  return {
    fields: {
      messageId,
      model,
      turnUuid,
      rawTimestamp,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      reasoningTokens,
      stopReason,
      usageKeysFingerprint,
      contentBlockTypesFingerprint,
    },
    invalidJson: false,
  };
}

export function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

function computeUsageKeysFingerprint(usage: Record<string, unknown>): string {
  const keys: string[] = [];
  for (const k of Object.keys(usage).sort()) keys.push(k);
  // Include child keys of `output_tokens_details` so reasoning-token drift
  // produces a distinct fingerprint without inflating the dimension space.
  const otd = usage.output_tokens_details;
  if (otd && typeof otd === 'object') {
    for (const k of Object.keys(otd as Record<string, unknown>).sort()) {
      keys.push(`output_tokens_details.${k}`);
    }
  }
  return shortHash(keys.join('|'));
}

function computeContentBlockTypesFingerprint(content: unknown): string {
  if (!Array.isArray(content)) return shortHash('');
  const set = new Set<string>();
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      typeof (block as { type?: unknown }).type === 'string'
    ) {
      set.add(String((block as { type: string }).type));
    }
  }
  const sorted = Array.from(set).sort();
  return shortHash(sorted.join('|'));
}

function shortHash(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 16);
}
