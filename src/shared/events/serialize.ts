import type {
  AiProvider,
  AiRequestMethod,
  AiRequest,
  AiResponse,
  AiMessage,
  AiAgentTaskSummary,
  AiAntiPattern,
  AiAgentMessage,
  AiContextReset,
  NrEventData,
} from './types.js';
import { createLogger } from '../logger.js';

const serializeLogger = createLogger('events-serialize');

/**
 * NR-reserved attribute names + library-internal namespaces a custom
 * attribute key must NOT collide with. The `custom.`
 * prefix already scopes most user-supplied keys safely, but we enforce a
 * deny-list against the bare key (pre-prefix) so callers can't smuggle a
 * reserved attribute name in via `customAttributes` and confuse NRQL
 * dashboards downstream.
 *
 * Membership rules:
 *   - NR Events API reserved attributes: `eventType`, `timestamp`,
 *     `accountId`, `entity.guid`, `appId`. NR rejects events that try to
 *     overwrite these via attribute payload, but the rejection is silent
 *     at ingest — better to fail-fast with a debug log here.
 *   - Library-internal namespaces: any key starting with `nr.` or
 *     `gen_ai.` would land at `custom.nr.<x>` / `custom.gen_ai.<x>`
 *     after prefixing — which doesn't collide, but is misleading because
 *     the bare `nr.<x>` and `gen_ai.<x>` namespaces ARE reserved at the
 *     top level. Reject the bare-key form to avoid the cognitive trap.
 *   - `schemaVersion` — reserved for the library's own use.
 *   - `type` — easy to confuse with NR's `eventType`; many dashboards
 *     use `type` for log/event categorization.
 */
const RESERVED_CUSTOM_KEYS: ReadonlySet<string> = new Set([
  'eventType',
  'timestamp',
  'accountId',
  'entity.guid',
  'appId',
  'schemaVersion',
  'type',
]);

function isReservedCustomKey(key: string): boolean {
  if (RESERVED_CUSTOM_KEYS.has(key)) return true;
  if (key.startsWith('nr.')) return true;
  if (key.startsWith('gen_ai.')) return true;
  return false;
}

/**
 * Apply customAttribute clipping and reject keys that
 * would collide with reserved/internal namespaces. Drop +
 * debug-log on rejection so misuse is discoverable but doesn't fail
 * the entire event.
 */
function applyCustomAttributes(
  data: NrEventData,
  custom: Record<string, string | number | boolean>,
  options: SerializeOptions | undefined,
  eventType: string,
): void {
  for (const [key, value] of Object.entries(custom)) {
    if (isReservedCustomKey(key)) {
      serializeLogger.debug(`${eventType}: customAttributes key "${key}" is reserved — dropping`, {
        eventType,
        key,
      });
      continue;
    }
    data[`custom.${key}`] = clipCustomAttribute(value, options);
  }
}

// NR Events API caps attribute values at 4096 UTF-8 bytes.
// Truncating by character count can still exceed the byte cap for multi-byte
// scripts (CJK = 3 bytes/char, emoji = 4 bytes/char). Truncate by byte count.
const NR_VALUE_MAX_BYTES = 4096;
const NR_VALUE_SUFFIX = '...'; // 3 bytes (ASCII)

// Shared helper used by both truncate() and clipCustomAttribute().
// Finds the longest code-point prefix of `s` whose UTF-8 byte length fits
// within `maxBytes`, then appends '...'. Called only when the string is
// already known to exceed `maxBytes`.
//
// Uses binary search (O(log n) Buffer.byteLength calls) instead of the
// previous linear-decrement loop (O(n) calls). For a worst-case string of
// all 4-byte emoji at the 4096-byte cap, this reduces ~1024 Buffer.byteLength
// calls to ~12.
const SUFFIX_BYTES = Buffer.byteLength(NR_VALUE_SUFFIX, 'utf8'); // 3 (ASCII)
function truncateToBytes(s: string, maxBytes: number): string {
  const target = maxBytes - SUFFIX_BYTES;
  const codePoints = Array.from(s);
  // Binary search for the largest cut that fits within target bytes.
  let lo = 0;
  let hi = codePoints.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(codePoints.slice(0, mid).join(''), 'utf8') <= target) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return codePoints.slice(0, lo).join('') + NR_VALUE_SUFFIX;
}

function truncate(s: string): string {
  // Fast path: ASCII-only strings — byte length == char length.
  if (s.length <= NR_VALUE_MAX_BYTES / 4) return s;
  if (Buffer.byteLength(s, 'utf8') <= NR_VALUE_MAX_BYTES) return s;
  return truncateToBytes(s, NR_VALUE_MAX_BYTES);
}

// `customAttributes` is the one channel that lets a
// caller smuggle arbitrary string content into telemetry. In high-security
// mode we clip every string custom attribute to 256 chars so a misuse like
// `customAttributes: { lastUserMessage: <whole prompt> }` cannot exfiltrate
// content. Numbers pass through unchanged. Structural fields like
// `toolNames`, `contentBlockTypes`, and `description` are NOT clipped —
// they are bounded enum/identifier metadata, not free-form user input.
//
// Even in normal mode, a string custom attribute that
// exceeds NR's per-attribute byte cap (4096) gets the entire event rejected
// or silently truncated by the Events API. Apply NR_VALUE_MAX as a floor on
// every string custom attribute so callers cannot accidentally drop their
// own events by passing a long field. The high-security 256-char clip runs
// on top of that.
const CUSTOM_ATTR_MAX_HS_BYTES = 256;
function clipCustomAttribute(
  value: string | number | boolean,
  options?: SerializeOptions,
): string | number | boolean {
  // Booleans pass through alongside strings and numbers.
  if (typeof value !== 'string') return value;
  const maxBytes = options?.highSecurity === true ? CUSTOM_ATTR_MAX_HS_BYTES : NR_VALUE_MAX_BYTES;
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  return truncateToBytes(value, maxBytes);
}

/**
 * High-security mode field-suppression contract.
 *
 * When `highSecurity: true` is passed to a serializer, the resulting
 * NrEventData has the following content-bearing fields suppressed:
 *
 *   - `error.message` is **omitted entirely** (provider error bodies often
 *     echo verbatim prompt fragments back). `error.type` and
 *     `error.statusCode` are still emitted — they are bounded enum-like
 *     values useful for triage and don't leak content. Applies to
 *     `aiResponseToNrEvent`.
 *
 *   - Every string value in `customAttributes` is **clipped to 256
 *     characters** (with a trailing `...` marker). Numeric custom
 *     attributes pass through unchanged. Applies to **all** serializers.
 *     In normal mode (highSecurity: false / omitted), string values are
 *     still truncated at 4000 chars so a long attribute cannot push the
 *     event past NR's 4096-byte per-attribute cap.
 *
 * Structural / metadata fields are intentionally NOT suppressed in
 * high-security mode — they are bounded identifiers, not free-form
 * content:
 *
 *   - `toolNames`, `contentBlockTypes`, `requestMethod`, `model`,
 *     `provider`, `stopReason`, `patternType`, `severity`, etc.
 *   - `AiAntiPattern.description` (enum-derived diagnostic text written
 *     by the agent, not by the upstream model).
 *
 * Per-message content (`AiMessage.content`) is gated separately by
 * `recordContent` on the consumer's `AgentConfig`, which `highSecurity`
 * forces to `false` at config-load time. The message serializer assumes
 * the caller has already honored that flag and does not clip `content`
 * here.
 */
export interface SerializeOptions {
  readonly highSecurity?: boolean;
}

/**
 * Maps the library's internal `AiProvider` literal to the canonical
 * `gen_ai.provider.name` value defined by the OpenTelemetry GenAI semantic
 * conventions. The wire field is still emitted as
 * `gen_ai.system` for backward-compat with existing NR dashboards — that
 * was the previous OTel attribute name (the spec renamed `gen_ai.system`
 * to `gen_ai.provider.name` but the value enum is the same registry).
 *
 * The OTel spec mixes dot-case (`aws.bedrock`, `gcp.gemini`,
 * `azure.ai.openai`, `ibm.watsonx.ai`) and underscore-case (`mistral_ai`,
 * `x_ai`, `moonshot_ai`, `deepseek`, `groq`). The visual inconsistency
 * looks typo-prone but is faithful to the registry — *not* something to
 * "normalize" by hand. When adding a new provider, look up its value at
 * https://github.com/open-telemetry/semantic-conventions-genai (model/
 * gen-ai/registry.yaml, `gen_ai.provider.name` members).
 *
 * `google` maps to `gcp.gemini` (the Gemini API at
 * `generativelanguage.googleapis.com`) rather than the more generic
 * `gcp.gen_ai` because the codebase's token-extraction path is
 * Gemini-shape. Consumers calling Google's Vertex AI endpoint would
 * see this stamp as well, but Vertex-specific telemetry would be
 * better captured by widening `AiProvider` (out of scope for this
 * spelling fix).
 */
// Typed as Record<AiProvider, string> so a new AiProvider value causes a
// compile error until a gen_ai.system mapping is added here.
const PROVIDER_TO_GENAI_SYSTEM: Record<AiProvider, string> = {
  anthropic: 'anthropic',
  google: 'gcp.gemini',
  openai: 'openai',
  bedrock: 'aws.bedrock',
  mistral: 'mistral_ai',
  cohere: 'cohere',
};

/**
 * Maps the library's `AiRequestMethod` literal onto the canonical
 * `gen_ai.operation.name` value. Predefined OTel
 * values today are `chat`, `generate_content`, `embeddings`, plus
 * `text_completion`. Method names that don't match any entry fall
 * through and the `gen_ai.operation.name` attribute is omitted from
 * the wire payload — this is the OTel-recommended behavior for
 * unrecognized operations.
 */
// Partial<Record<...>> so unrecognized methods fall through cleanly.
// Unlike PROVIDER_TO_GENAI_SYSTEM (which uses non-Partial Record to enforce exhaustiveness),
// coverage here is intentionally partial — adding a new AiRequestMethod without an
// entry produces no compile error; the attribute is simply omitted per the OTel fallthrough
// described in the JSDoc above.
const METHOD_TO_GENAI_OPERATION: Partial<Record<AiRequestMethod, string>> = {
  'messages.create': 'chat',
  'messages.stream': 'chat',
  'models.generateContent': 'generate_content',
  'models.generateContentStream': 'generate_content',
  'models.embedContent': 'embeddings',
  'chat.completions.create': 'chat',
  // OpenAI Node SDK: `client.embeddings.create({...})`.
  'embeddings.create': 'embeddings',
  converse: 'chat',
  'converse-stream': 'chat',
  'chat.complete': 'chat',
  'chat.stream': 'chat',
  chat: 'chat',
  chatStream: 'chat',
  // Cohere Node SDK: `client.embed(...)`.
  embed: 'embeddings',
};

/**
 * Event schema version. Bump whenever the wire-format
 * shape of any serializer changes in a way that downstream NR dashboards
 * built on the previous shape would silently mis-render. The current value
 * is stamped on every emitted event (`schemaVersion: 1`) so dashboards can
 * filter on `WHERE schemaVersion = 1` and catch a future migration before
 * the data renders incorrectly.
 *
 * Bumping policy:
 *   - Add a field: NO bump required (new field is null/missing on old events).
 *   - Remove or rename a field: bump.
 *   - Change a field's type or unit: bump.
 *   - Change a field's semantic meaning: bump.
 *
 * The metric-API summary migration is an analogous (separate) wire
 * change and is covered by NR's metric `type` field, not this schema version.
 */
export const EVENT_SCHEMA_VERSION = 1;

export function aiRequestToNrEvent(event: AiRequest, options?: SerializeOptions): NrEventData {
  const data: NrEventData = {
    eventType: 'AiRequest',
    schemaVersion: EVENT_SCHEMA_VERSION,
    id: event.id,
    timestamp: event.timestamp,
    provider: event.provider,
    model: event.model,
    requestMethod: event.requestMethod,
    messageCount: event.messageCount,
    toolCount: event.toolCount,
    thinkingEnabled: event.thinkingEnabled,
    streamingEnabled: event.streamingEnabled,
    'nr.appName': event['nr.appName'],
  };

  if (event.maxTokens !== null) data.maxTokens = event.maxTokens;
  if (event.temperature !== null) data.temperature = event.temperature;
  if (event.topP !== null) data.topP = event.topP;
  if (event.systemPromptLength !== null) data.systemPromptLength = event.systemPromptLength;
  if (event.toolNames.length > 0) data.toolNames = truncate(JSON.stringify(event.toolNames));
  if (event.thinkingBudgetTokens !== null) data.thinkingBudgetTokens = event.thinkingBudgetTokens;
  if (event['nr.entityGuid'] !== null) data['nr.entityGuid'] = event['nr.entityGuid'];

  // GenAI semantic convention attributes (OTel spec, experimental)
  const genAiSystem = PROVIDER_TO_GENAI_SYSTEM[event.provider] ?? event.provider;
  data['gen_ai.system'] = genAiSystem;
  data['gen_ai.request.model'] = event.model;

  const genAiOperation = METHOD_TO_GENAI_OPERATION[event.requestMethod];
  if (genAiOperation) data['gen_ai.operation.name'] = genAiOperation;

  if (event.maxTokens !== null) data['gen_ai.request.max_tokens'] = event.maxTokens;
  if (event.temperature !== null) data['gen_ai.request.temperature'] = event.temperature;
  if (event.topP !== null) data['gen_ai.request.top_p'] = event.topP;
  data['gen_ai.request.stream'] = event.streamingEnabled;

  applyCustomAttributes(data, event.customAttributes, options, String(data.eventType));

  return data;
}

export function aiResponseToNrEvent(event: AiResponse, options?: SerializeOptions): NrEventData {
  const data: NrEventData = {
    eventType: 'AiResponse',
    schemaVersion: EVENT_SCHEMA_VERSION,
    id: event.id,
    timestamp: event.timestamp,
    provider: event.provider,
    model: event.model,
    durationMs: event.durationMs,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    thinkingTokens: event.thinkingTokens,
    cacheReadTokens: event.cacheReadTokens,
    cacheCreationTokens: event.cacheCreationTokens,
    totalTokens: event.totalTokens,
    'nr.appName': event['nr.appName'],
  };

  // Emit `nr.entityGuid` so AiResponse events route to the
  // owning NR entity surface, matching `aiRequestToNrEvent`. Without this the
  // factory's entityGuid input was silently dropped at serialization time
  // even though the AiResponse interface declared the field.
  if (event['nr.entityGuid'] !== null) data['nr.entityGuid'] = event['nr.entityGuid'];

  if (event.timeToFirstTokenMs !== null) data.timeToFirstTokenMs = event.timeToFirstTokenMs;
  if (event.tokensPerSecond !== null) data.tokensPerSecond = event.tokensPerSecond;
  if (event.stopReason !== null) data.stopReason = event.stopReason;
  if (event.contentBlockTypes.length > 0) {
    data.contentBlockTypes = truncate(JSON.stringify(event.contentBlockTypes));
  }

  if (event.costInputUsd !== null) data['cost.inputUsd'] = event.costInputUsd;
  if (event.costOutputUsd !== null) data['cost.outputUsd'] = event.costOutputUsd;
  if (event.costThinkingUsd !== null) data['cost.thinkingUsd'] = event.costThinkingUsd;
  if (event.costCacheReadUsd !== null) data['cost.cacheReadUsd'] = event.costCacheReadUsd;
  if (event.costCacheCreationUsd !== null) {
    data['cost.cacheCreationUsd'] = event.costCacheCreationUsd;
  }
  if (event.costTotalUsd !== null) data['cost.totalUsd'] = event.costTotalUsd;

  if (event.error !== null) {
    data['error.type'] = truncate(event.error.type);
    // In high-security mode, drop error.message (may contain verbatim
    // prompt fragments). error.type + error.statusCode still surface enough
    // signal for triage without leaking user content via the error path.
    if (options?.highSecurity !== true) {
      data['error.message'] = truncate(event.error.message);
    }
    if (event.error.statusCode !== null) data['error.statusCode'] = event.error.statusCode;
  }

  // GenAI semantic convention attributes (OTel spec, experimental)
  const genAiSystem = PROVIDER_TO_GENAI_SYSTEM[event.provider] ?? event.provider;
  data['gen_ai.system'] = genAiSystem;
  data['gen_ai.response.model'] = event.model;

  // Per OTel GenAI SemConv, gen_ai.usage.input_tokens MUST include ALL input
  // tokens (cached + fresh). Provider semantics differ:
  //
  // Anthropic: inputTokens = fresh only; cache tokens are disjoint → sum all.
  // Gemini / OpenAI: inputTokens already includes cached content (the cache
  //   tokens are a SUBSET of inputTokens, not separate) → using inputTokens
  //   alone is correct; adding cacheReadTokens would double-count.
  // Bedrock, Mistral, Cohere: no cache token overlap → same as Anthropic.
  const otelInputTokens =
    event.provider === 'google' || event.provider === 'openai'
      ? event.inputTokens
      : event.inputTokens + event.cacheReadTokens + event.cacheCreationTokens;

  data['gen_ai.usage.input_tokens'] = otelInputTokens;
  // gen_ai.usage.output_tokens semantics differ by provider.
  //
  // Anthropic / Google: thinkingTokens is DISJOINT from outputTokens
  //   (extended-thinking and thought-summary tokens are separate) → add both.
  // OpenAI: reasoning_tokens (→ thinkingTokens) is a SUBSET of
  //   completion_tokens (→ outputTokens) — adding it again double-counts.
  //   outputTokens alone equals completion_tokens which is what OTel
  //   gen_ai.usage.output_tokens should reflect for OpenAI.
  // Bedrock / Mistral / Cohere: thinkingTokens is always 0, so both
  //   formulas produce the same result; disjoint form is correct.
  data['gen_ai.usage.output_tokens'] =
    event.provider === 'openai' ? event.outputTokens : event.outputTokens + event.thinkingTokens;

  if (event.thinkingTokens > 0) data['gen_ai.usage.reasoning.output_tokens'] = event.thinkingTokens;
  if (event.cacheReadTokens > 0)
    data['gen_ai.usage.cache_read.input_tokens'] = event.cacheReadTokens;
  if (event.cacheCreationTokens > 0)
    data['gen_ai.usage.cache_creation.input_tokens'] = event.cacheCreationTokens;

  if (event.stopReason !== null) data['gen_ai.response.finish_reason'] = event.stopReason;

  applyCustomAttributes(data, event.customAttributes, options, String(data.eventType));

  return data;
}

export function aiMessageToNrEvent(event: AiMessage, options?: SerializeOptions): NrEventData {
  const data: NrEventData = {
    eventType: 'AiMessage',
    schemaVersion: EVENT_SCHEMA_VERSION,
    id: event.id,
    timestamp: event.timestamp,
    role: event.role,
    content: truncate(event.content),
    contentLength: event.contentLength, // original (pre-truncation) length
    sequence: event.sequence,
    'nr.appName': event['nr.appName'],
  };

  // Emit `nr.entityGuid` so AiMessage events route to the
  // owning NR entity surface, matching `aiRequestToNrEvent` / `aiResponseToNrEvent`.
  if (event['nr.entityGuid'] !== null) data['nr.entityGuid'] = event['nr.entityGuid'];

  applyCustomAttributes(data, event.customAttributes, options, String(data.eventType));

  return data;
}

/**
 * Dotted-key naming convention for the four newer
 * agent-shaped event types (`AiAgentTaskSummary`, `AiAntiPattern`,
 * `AiAgentMessage`, `AiContextReset`). These serializers emit attributes
 * with a `<namespace>.<field>` shape (e.g. `ai.agent.task_duration_ms`,
 * `ai.antipattern.severity`) alongside top-level non-namespaced fields
 * (e.g. `id`, `timestamp`, `taskName`).
 *
 * The dotted form is the OTel-style and aligns with `gen_ai.*` already in
 * use on AiRequest/AiResponse — operators querying these in NRQL must
 * backtick-quote: `SELECT \`ai.agent.task_duration_ms\` FROM AiAgentTaskSummary`.
 *
 * The mixed top-level + namespaced shape (`taskName` flat, `ai.agent.*`
 * dotted) is intentional: the top-level fields carry record identity that
 * the eventType bucket already groups by (you query `FROM AiAgentTaskSummary`
 * so `eventType` provides the namespace), while the `ai.<area>.*` fields
 * cluster metric-shaped attributes by source area so dashboards can
 * `SELECT keyset() WHERE attribute LIKE 'ai.agent.%'`.
 *
 * This convention is documented here rather than enforced — adding new
 * fields to these event types should follow it for consistency, but the
 * library does not validate the shape at runtime.
 */
// NOTE: The four agent-shaped event types below do not emit gen_ai.*
// OTel SemConv attributes (e.g. gen_ai.system) because they lack a `provider`
// field. Adding provider to these types is a post-0.1.0 task; until then,
// NRQL queries on gen_ai.* will not return these event types.
export function aiAgentTaskSummaryToNrEvent(
  event: AiAgentTaskSummary,
  options?: SerializeOptions,
): NrEventData {
  const data: NrEventData = {
    eventType: 'AiAgentTaskSummary',
    schemaVersion: EVENT_SCHEMA_VERSION,
    id: event.id,
    timestamp: event.timestamp,
    traceId: event.traceId,
    spanId: event.spanId,
    taskName: truncate(event.taskName),
    'ai.agent.task_duration_ms': event.durationMs,
    'ai.agent.total_steps': event.stepCount,
    'ai.agent.llm_calls_per_task': event.totalLlmCalls,
    'ai.agent.tool_calls_per_task': event.totalToolCalls,
    'ai.agent.tokens_per_task': event.totalTokens,
    'ai.agent.task_success': event.success,
    'nr.appName': event['nr.appName'],
  };

  if (event['nr.entityGuid'] !== null) data['nr.entityGuid'] = event['nr.entityGuid'];
  if (event.provider) data['gen_ai.system'] = PROVIDER_TO_GENAI_SYSTEM[event.provider];
  if (event.totalCostUsd !== null) data['ai.agent.cost_per_task_usd'] = event.totalCostUsd;
  if (event.delegationCount !== undefined)
    data['ai.agent.delegation_count'] = event.delegationCount;
  if (event.spawnCount !== undefined) data['ai.agent.spawn_count'] = event.spawnCount;
  if (event.delegationDepth !== undefined)
    data['ai.agent.delegation_depth'] = event.delegationDepth;
  if (event.interAgentMessages !== undefined)
    data['ai.agent.inter_agent_messages'] = event.interAgentMessages;
  if (event.delegationOverheadMs !== undefined)
    data['ai.agent.delegation_overhead_ms'] = event.delegationOverheadMs;

  applyCustomAttributes(data, event.customAttributes, options, String(data.eventType));

  return data;
}

export function aiAntiPatternToNrEvent(
  event: AiAntiPattern,
  options?: SerializeOptions,
): NrEventData {
  const data: NrEventData = {
    eventType: 'AiAntiPattern',
    schemaVersion: EVENT_SCHEMA_VERSION,
    id: event.id,
    timestamp: event.timestamp,
    traceId: event.traceId,
    patternType: event.patternType,
    severity: event.severity,
    description: truncate(event.description),
    'nr.appName': event['nr.appName'],
  };

  if (event['nr.entityGuid'] !== null) data['nr.entityGuid'] = event['nr.entityGuid'];
  if (event.provider) data['gen_ai.system'] = PROVIDER_TO_GENAI_SYSTEM[event.provider];
  if (event.toolName !== undefined) data.toolName = event.toolName;
  if (event.repeatCount !== undefined) data.repeatCount = event.repeatCount;
  if (event.depthIndex !== undefined) data.depthIndex = event.depthIndex;
  if (event.taskComplexity !== undefined) data.taskComplexity = event.taskComplexity;
  if (event.contextPressure != null) data.contextPressure = event.contextPressure;
  if (event.tokenShare != null) data.tokenShare = event.tokenShare;
  if (event.attemptCount !== undefined) data.attemptCount = event.attemptCount;

  applyCustomAttributes(data, event.customAttributes, options, String(data.eventType));

  return data;
}

export function aiAgentMessageToNrEvent(
  event: AiAgentMessage,
  options?: SerializeOptions,
): NrEventData {
  const data: NrEventData = {
    eventType: 'AiAgentMessage',
    schemaVersion: EVENT_SCHEMA_VERSION,
    id: event.id,
    timestamp: event.timestamp,
    traceId: event.traceId,
    fromAgent: truncate(event.fromAgent),
    toAgent: truncate(event.toAgent),
    messageType: truncate(event.messageType),
    'nr.appName': event['nr.appName'],
  };

  if (event['nr.entityGuid'] !== null) data['nr.entityGuid'] = event['nr.entityGuid'];
  if (event.provider) data['gen_ai.system'] = PROVIDER_TO_GENAI_SYSTEM[event.provider];
  if (event.tokenCount !== undefined) data.tokenCount = event.tokenCount;

  applyCustomAttributes(data, event.customAttributes, options, String(data.eventType));

  return data;
}

export function aiContextResetToNrEvent(
  event: AiContextReset,
  options?: SerializeOptions,
): NrEventData {
  const data: NrEventData = {
    eventType: 'AiContextReset',
    schemaVersion: EVENT_SCHEMA_VERSION,
    id: event.id,
    timestamp: event.timestamp,
    traceId: event.traceId,
    conversationId: truncate(event.conversationId),
    tokensBefore: event.tokensBefore,
    tokensAfter: event.tokensAfter,
    tokensRemoved: event.tokensRemoved,
    compressionRatio: event.compressionRatio,
    reason: event.reason,
    'nr.appName': event['nr.appName'],
  };

  if (event['nr.entityGuid'] !== null) data['nr.entityGuid'] = event['nr.entityGuid'];
  if (event.provider) data['gen_ai.system'] = PROVIDER_TO_GENAI_SYSTEM[event.provider];
  if (event.turnsRemoved !== undefined) data.turnsRemoved = event.turnsRemoved;

  applyCustomAttributes(data, event.customAttributes, options, String(data.eventType));

  return data;
}
