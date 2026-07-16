/**
 * Shared shapes for parsing Claude Code transcript JSONL lines. Multiple
 * files (subagent-watcher.ts, subagent-timeline-store.ts, collector-script.ts)
 * independently read the same on-disk transcript format; these types give
 * them one common vocabulary instead of each re-deriving an ad-hoc
 * `Record<string, unknown>` shape.
 */

/** One parsed JSONL line from a Claude Code transcript file. */
export interface RawTranscriptEntry {
  readonly type?: string;
  readonly message?: unknown;
  readonly uuid?: string;
  readonly timestamp?: string;
}

/** The `message` field of an assistant-turn transcript entry. */
export interface RawAssistantMessage {
  readonly model?: string;
  readonly id?: string;
  readonly usage?: unknown;
  readonly content?: unknown;
  readonly stop_reason?: string;
}

/**
 * The `message.usage` field of an assistant-turn transcript entry. Carries an
 * index signature (not a closed interface) because `computeUsageKeysFingerprint()`
 * in subagent-watcher.ts deliberately inventories ALL keys — known and
 * unknown — to detect API shape drift; a closed interface would make this
 * type unusable there. Every currently-known field is still separately typed
 * below for the call sites that read specific fields.
 */
export interface RawUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
  readonly output_tokens_details?: { readonly reasoning_tokens?: number };
  readonly [key: string]: unknown;
}
