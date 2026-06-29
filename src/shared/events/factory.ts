import { randomUUID } from 'node:crypto';
import { safeInt } from '../tokens.js';
import { createLogger } from '../logger.js';
import type {
  AiRequest,
  AiResponse,
  AiMessage,
  AiProvider,
  AiRequestMethod,
  AiMessageRole,
  AiAgentTaskSummary,
  AiAntiPattern,
  AntiPatternType,
  AiAgentMessage,
  AiContextReset,
} from './types.js';

const factoryLogger = createLogger('events-factory');

// Mirror safeInt but for float cost fields: NaN / Infinity -> null.
function safeFiniteOrNull(v: number | null | undefined): number | null {
  if (v == null) return null;
  return Number.isFinite(v) ? v : null;
}

/**
 * Warn-once for missing entityGuid.
 *
 * NR's entity model usually requires both `appName` and `entityGuid` to attach
 * events to a specific entity surface (APM service, browser app, etc.).
 * Without an entityGuid, events still ingest but land in a "standalone events"
 * view rather than attaching to a service.
 *
 * Warn once PER EVENT TYPE rather than once globally. The old boolean
 * flag would silence all subsequent factory calls after the very first
 * missing-entityGuid event, regardless of type — an operator who added
 * entityGuid to AiRequest but not AiAgentTaskSummary would never see the
 * warning for the summary events. A Set keyed by eventType gives one warning
 * per type, covering partial-coverage scenarios without flooding stderr.
 */
const entityGuidWarnedTypes = new Set<string>();

function warnIfMissingEntityGuid(eventType: string, entityGuid: string | null | undefined): void {
  if (entityGuidWarnedTypes.has(eventType)) return;
  if (entityGuid === null || entityGuid === undefined || entityGuid === '') {
    entityGuidWarnedTypes.add(eventType);
    factoryLogger.warn(
      `${eventType} created without entityGuid — events will not attach to an NR entity. ` +
        'Pass entityGuid alongside appName for entity-scoped routing.',
    );
  }
}

/**
 * Reset the warn-once set. Test-only — production code never resets.
 * Exported behind a `__` prefix so it's clearly internal.
 */
export function __resetEntityGuidWarning(): void {
  entityGuidWarnedTypes.clear();
}

export interface CreateAiRequestParams {
  provider: AiProvider;
  model: string;
  requestMethod: AiRequestMethod;
  maxTokens?: number | null;
  temperature?: number | null;
  topP?: number | null;
  systemPromptLength?: number | null;
  messageCount: number;
  toolCount?: number;
  toolNames?: string[];
  thinkingEnabled?: boolean;
  thinkingBudgetTokens?: number | null;
  streamingEnabled: boolean;
  appName: string;
  entityGuid?: string | null;
  customAttributes?: Record<string, string | number | boolean>;
  id?: string;
  timestamp?: number;
}

export function createAiRequest(params: CreateAiRequestParams): AiRequest {
  if (!params.model) {
    throw new Error('AiRequest requires a model');
  }
  if (!params.provider) {
    throw new Error('AiRequest requires a provider');
  }
  if (!params.requestMethod) {
    throw new Error('AiRequest requires a requestMethod');
  }
  if (!params.appName) {
    throw new Error('AiRequest requires an appName');
  }
  warnIfMissingEntityGuid('AiRequest', params.entityGuid);

  return {
    id: params.id ?? randomUUID(),
    timestamp: params.timestamp ?? Date.now(),
    provider: params.provider,
    model: params.model,
    requestMethod: params.requestMethod,
    // Sanitize numeric fields so NaN / Infinity / negative values don't reach
    // the wire. safeInt for integer counts; safeFiniteOrNull for floats.
    maxTokens: params.maxTokens != null ? safeInt(params.maxTokens) : null,
    temperature: safeFiniteOrNull(params.temperature),
    topP: safeFiniteOrNull(params.topP),
    systemPromptLength:
      params.systemPromptLength != null ? safeInt(params.systemPromptLength) : null,
    messageCount: safeInt(params.messageCount),
    toolCount: safeInt(params.toolCount ?? 0),
    toolNames: params.toolNames ?? [],
    thinkingEnabled: params.thinkingEnabled ?? false,
    thinkingBudgetTokens:
      params.thinkingBudgetTokens != null ? safeInt(params.thinkingBudgetTokens) : null,
    streamingEnabled: params.streamingEnabled,
    'nr.appName': params.appName,
    'nr.entityGuid': params.entityGuid ?? null,
    customAttributes: params.customAttributes ?? {},
  };
}

export interface CreateAiResponseParams {
  provider: AiProvider;
  model: string;
  durationMs: number;
  timeToFirstTokenMs?: number | null;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costInputUsd?: number | null;
  costOutputUsd?: number | null;
  costThinkingUsd?: number | null;
  costCacheReadUsd?: number | null;
  costCacheCreationUsd?: number | null;
  costTotalUsd?: number | null;
  stopReason?: string | null;
  contentBlockTypes?: string[];
  error?: { type: string; message: string; statusCode: number | null } | null;
  appName: string;
  entityGuid?: string | null;
  customAttributes?: Record<string, string | number | boolean>;
  id?: string;
  timestamp?: number;
}

export function createAiResponse(params: CreateAiResponseParams): AiResponse {
  if (!params.model) {
    throw new Error('AiResponse requires a model');
  }
  if (!params.provider) {
    throw new Error('AiResponse requires a provider');
  }
  if (!params.appName) {
    throw new Error('AiResponse requires an appName');
  }
  warnIfMissingEntityGuid('AiResponse', params.entityGuid);

  // Coerce token fields through safeInt so NaN, Infinity,
  // negative numbers, and floats from buggy callers don't propagate as
  // null/Infinity into the serialized event (where JSON.stringify maps them
  // to "null", which NR Events API silently drops).
  const inputTokens = safeInt(params.inputTokens);
  const outputTokens = safeInt(params.outputTokens);
  const thinkingTokens = safeInt(params.thinkingTokens);
  const cacheReadTokens = safeInt(params.cacheReadTokens);
  const cacheCreationTokens = safeInt(params.cacheCreationTokens);
  // For Google and OpenAI, inputTokens already includes cached content (cache
  // tokens are a subset, not additive). Adding them again double-counts.
  // Same provider-aware logic as serialize.ts gen_ai.usage.input_tokens.
  //
  // For OpenAI, thinkingTokens (reasoning_tokens from
  // completion_tokens_details) is already a SUBSET of outputTokens
  // (completion_tokens) — not a separate additive field. The prior code
  // added it unconditionally, relying on a comment that said "extractors
  // produce thinkingTokens=0 for OpenAI" — which is false for o1/o3/o4-mini.
  // Fix: OpenAI totalTokens = inputTokens + outputTokens (no thinking, no cache).
  // For Google, thinkingTokens (thoughtsTokenCount) IS disjoint from
  // outputTokens (candidatesTokenCount) per the Gemini API spec, so it is
  // still added for that provider.
  const totalTokens =
    params.provider === 'openai'
      ? inputTokens + outputTokens
      : params.provider === 'google'
        ? inputTokens + outputTokens + thinkingTokens
        : inputTokens + outputTokens + thinkingTokens + cacheReadTokens + cacheCreationTokens;

  // durationMs: coerce to a non-negative integer, matching createAiAgentTaskSummary.
  // safeInt(NaN|Infinity|negative) → 0. Fractional ms is caller error.
  const durationMs = safeInt(
    Number.isFinite(params.durationMs) && params.durationMs >= 0 ? params.durationMs : 0,
  );
  // timeToFirstTokenMs: apply the same non-negative finite guard.
  // NaN → null; Infinity → null; negative → null.
  const timeToFirstTokenMs: number | null =
    params.timeToFirstTokenMs != null &&
    Number.isFinite(params.timeToFirstTokenMs) &&
    params.timeToFirstTokenMs >= 0
      ? params.timeToFirstTokenMs
      : null;
  const tokensPerSecond =
    durationMs > 0 && outputTokens > 0 ? (outputTokens / durationMs) * 1000 : null;

  return {
    id: params.id ?? randomUUID(),
    timestamp: params.timestamp ?? Date.now(),
    provider: params.provider,
    model: params.model,
    durationMs,
    timeToFirstTokenMs,
    tokensPerSecond,
    inputTokens,
    outputTokens,
    thinkingTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens,
    costInputUsd: safeFiniteOrNull(params.costInputUsd),
    costOutputUsd: safeFiniteOrNull(params.costOutputUsd),
    costThinkingUsd: safeFiniteOrNull(params.costThinkingUsd),
    costCacheReadUsd: safeFiniteOrNull(params.costCacheReadUsd),
    costCacheCreationUsd: safeFiniteOrNull(params.costCacheCreationUsd),
    costTotalUsd: safeFiniteOrNull(params.costTotalUsd),
    stopReason: params.stopReason ?? null,
    contentBlockTypes: params.contentBlockTypes ?? [],
    error: params.error ?? null,
    'nr.appName': params.appName,
    'nr.entityGuid': params.entityGuid ?? null,
    customAttributes: params.customAttributes ?? {},
  };
}

export interface CreateAiMessageParams {
  role: AiMessageRole;
  content: string;
  contentLength: number;
  sequence: number;
  appName: string;
  entityGuid?: string | null;
  customAttributes?: Record<string, string | number | boolean>;
  id?: string;
  timestamp?: number;
}

export function createAiMessage(params: CreateAiMessageParams): AiMessage {
  if (!params.role) {
    throw new Error('AiMessage requires a role');
  }
  // Required-field validation made uniform across the
  // three factory functions. `content` is typed as `string` but JS callers
  // bypass the type system; reject `null` / `undefined` here so downstream
  // serialization doesn't emit `content: "null"` / `content: "undefined"`
  // verbatim. Empty string is allowed — a deliberately-empty assistant
  // response is a valid record.
  if (params.content === null || params.content === undefined) {
    throw new Error('AiMessage requires content');
  }
  if (!params.appName) {
    throw new Error('AiMessage requires an appName');
  }
  warnIfMissingEntityGuid('AiMessage', params.entityGuid);

  return {
    id: params.id ?? randomUUID(),
    timestamp: params.timestamp ?? Date.now(),
    role: params.role,
    content: params.content,
    contentLength: safeInt(params.contentLength),
    sequence: params.sequence,
    'nr.appName': params.appName,
    'nr.entityGuid': params.entityGuid ?? null,
    customAttributes: params.customAttributes ?? {},
  };
}

// ---------------------------------------------------------------------------
// Factory functions for the four newer agent-shaped
// event types. Previously these had serializers but no constructors, so
// consumers had to hand-build the type-shape and remember to set `id` /
// `timestamp` defaults themselves. The four factories below mirror the
// existing `createAiRequest` / `createAiResponse` / `createAiMessage`
// pattern: a `Create<Event>Params` interface, an `id` / `timestamp` default,
// `safeInt`-coerced numeric fields where appropriate, and a uniform
// `<EventName> requires a <field>` validation message shape.
// ---------------------------------------------------------------------------

export interface CreateAiAgentTaskSummaryParams {
  traceId: string;
  spanId: string;
  taskName: string;
  durationMs: number;
  totalLlmCalls: number;
  totalToolCalls: number;
  totalTokens: number;
  totalCostUsd?: number | null;
  stepCount: number;
  success: boolean;
  provider?: AiProvider;
  delegationCount?: number;
  spawnCount?: number;
  delegationDepth?: number;
  interAgentMessages?: number;
  delegationOverheadMs?: number;
  appName: string;
  entityGuid?: string | null;
  customAttributes?: Record<string, string | number | boolean>;
  id?: string;
  timestamp?: number;
}

export function createAiAgentTaskSummary(
  params: CreateAiAgentTaskSummaryParams,
): AiAgentTaskSummary {
  if (!params.traceId) {
    throw new Error('AiAgentTaskSummary requires a traceId');
  }
  if (!params.spanId) {
    throw new Error('AiAgentTaskSummary requires a spanId');
  }
  if (!params.taskName) {
    throw new Error('AiAgentTaskSummary requires a taskName');
  }
  if (!params.appName) {
    throw new Error('AiAgentTaskSummary requires an appName');
  }
  warnIfMissingEntityGuid('AiAgentTaskSummary', params.entityGuid);

  return {
    id: params.id ?? randomUUID(),
    timestamp: params.timestamp ?? Date.now(),
    traceId: params.traceId,
    spanId: params.spanId,
    taskName: params.taskName,
    // Sanitize numeric fields through safeInt so a buggy caller passing NaN /
    // Infinity doesn't propagate through serialize.ts as `null` and confuse
    // downstream NRQL aggregations.
    durationMs: safeInt(params.durationMs),
    totalLlmCalls: safeInt(params.totalLlmCalls),
    totalToolCalls: safeInt(params.totalToolCalls),
    totalTokens: safeInt(params.totalTokens),
    totalCostUsd: safeFiniteOrNull(params.totalCostUsd),
    stepCount: safeInt(params.stepCount),
    success: params.success,
    provider: params.provider,
    delegationCount:
      params.delegationCount !== undefined ? safeInt(params.delegationCount) : undefined,
    spawnCount: params.spawnCount !== undefined ? safeInt(params.spawnCount) : undefined,
    delegationDepth:
      params.delegationDepth !== undefined ? safeInt(params.delegationDepth) : undefined,
    interAgentMessages:
      params.interAgentMessages !== undefined ? safeInt(params.interAgentMessages) : undefined,
    delegationOverheadMs:
      params.delegationOverheadMs !== undefined ? safeInt(params.delegationOverheadMs) : undefined,
    'nr.appName': params.appName,
    'nr.entityGuid': params.entityGuid ?? null,
    customAttributes: params.customAttributes ?? {},
  };
}

export interface CreateAiAntiPatternParams {
  traceId: string;
  patternType: AntiPatternType;
  severity: 'low' | 'medium' | 'high';
  description: string;
  provider?: AiProvider;
  toolName?: string;
  repeatCount?: number;
  depthIndex?: number;
  taskComplexity?: 'simple' | 'moderate' | 'complex';
  contextPressure?: number | null;
  tokenShare?: number | null;
  attemptCount?: number;
  appName: string;
  entityGuid?: string | null;
  customAttributes?: Record<string, string | number | boolean>;
  id?: string;
  timestamp?: number;
}

export function createAiAntiPattern(params: CreateAiAntiPatternParams): AiAntiPattern {
  if (!params.traceId) {
    throw new Error('AiAntiPattern requires a traceId');
  }
  if (!params.patternType) {
    throw new Error('AiAntiPattern requires a patternType');
  }
  if (!params.severity) {
    throw new Error('AiAntiPattern requires a severity');
  }
  if (!params.description) {
    throw new Error('AiAntiPattern requires a description');
  }
  if (!params.appName) {
    throw new Error('AiAntiPattern requires an appName');
  }
  warnIfMissingEntityGuid('AiAntiPattern', params.entityGuid);

  return {
    id: params.id ?? randomUUID(),
    timestamp: params.timestamp ?? Date.now(),
    traceId: params.traceId,
    patternType: params.patternType,
    severity: params.severity,
    description: params.description,
    provider: params.provider,
    toolName: params.toolName,
    repeatCount: params.repeatCount !== undefined ? safeInt(params.repeatCount) : undefined,
    depthIndex: params.depthIndex !== undefined ? safeInt(params.depthIndex) : undefined,
    taskComplexity: params.taskComplexity,
    contextPressure: safeFiniteOrNull(params.contextPressure),
    tokenShare: safeFiniteOrNull(params.tokenShare),
    attemptCount: params.attemptCount !== undefined ? safeInt(params.attemptCount) : undefined,
    'nr.appName': params.appName,
    'nr.entityGuid': params.entityGuid ?? null,
    customAttributes: params.customAttributes ?? {},
  };
}

export interface CreateAiAgentMessageParams {
  traceId: string;
  fromAgent: string;
  toAgent: string;
  messageType: string;
  provider?: AiProvider;
  tokenCount?: number;
  appName: string;
  entityGuid?: string | null;
  customAttributes?: Record<string, string | number | boolean>;
  id?: string;
  timestamp?: number;
}

export function createAiAgentMessage(params: CreateAiAgentMessageParams): AiAgentMessage {
  if (!params.traceId) {
    throw new Error('AiAgentMessage requires a traceId');
  }
  if (!params.fromAgent) {
    throw new Error('AiAgentMessage requires a fromAgent');
  }
  if (!params.toAgent) {
    throw new Error('AiAgentMessage requires a toAgent');
  }
  if (!params.messageType) {
    throw new Error('AiAgentMessage requires a messageType');
  }
  if (!params.appName) {
    throw new Error('AiAgentMessage requires an appName');
  }
  warnIfMissingEntityGuid('AiAgentMessage', params.entityGuid);

  return {
    id: params.id ?? randomUUID(),
    timestamp: params.timestamp ?? Date.now(),
    traceId: params.traceId,
    fromAgent: params.fromAgent,
    toAgent: params.toAgent,
    messageType: params.messageType,
    provider: params.provider,
    tokenCount: params.tokenCount === undefined ? undefined : safeInt(params.tokenCount),
    'nr.appName': params.appName,
    'nr.entityGuid': params.entityGuid ?? null,
    customAttributes: params.customAttributes ?? {},
  };
}

export interface CreateAiContextResetParams {
  traceId: string;
  conversationId: string;
  tokensBefore: number;
  tokensAfter: number;
  reason: 'summarization' | 'truncation' | 'sliding_window' | 'manual';
  provider?: AiProvider;
  turnsRemoved?: number;
  appName: string;
  entityGuid?: string | null;
  customAttributes?: Record<string, string | number | boolean>;
  id?: string;
  timestamp?: number;
}

export function createAiContextReset(params: CreateAiContextResetParams): AiContextReset {
  if (!params.traceId) {
    throw new Error('AiContextReset requires a traceId');
  }
  if (!params.conversationId) {
    throw new Error('AiContextReset requires a conversationId');
  }
  if (!params.reason) {
    throw new Error('AiContextReset requires a reason');
  }
  if (!params.appName) {
    throw new Error('AiContextReset requires an appName');
  }
  warnIfMissingEntityGuid('AiContextReset', params.entityGuid);

  const tokensBefore = safeInt(params.tokensBefore);
  const tokensAfter = safeInt(params.tokensAfter);
  // Derived fields — compute here so callers don't have to remember the
  // contract. tokensRemoved is `before - after` (clamped at 0 because a
  // post-reset count higher than the pre-reset count is nonsensical, and
  // the resulting negative value would corrupt NRQL aggregations).
  const tokensRemoved = Math.max(0, tokensBefore - tokensAfter);
  // tokensBefore === 0 → identity reset (no content to compress); return 1.0
  // so dashboards averaging compressionRatio don't see artificially low values
  // from no-op resets. ratio > 1.0 is possible (summarizer preamble > savings)
  // and is preserved; a debug log makes the rare case diagnosable.
  let compressionRatio: number;
  if (tokensBefore === 0) {
    compressionRatio = 1;
  } else {
    compressionRatio = tokensAfter / tokensBefore;
    if (compressionRatio > 1) {
      factoryLogger.debug(
        'AiContextReset compressionRatio > 1 (post-reset tokens exceed pre-reset)',
        {
          tokensBefore,
          tokensAfter,
          compressionRatio,
        },
      );
    }
  }

  return {
    id: params.id ?? randomUUID(),
    timestamp: params.timestamp ?? Date.now(),
    traceId: params.traceId,
    conversationId: params.conversationId,
    tokensBefore,
    tokensAfter,
    tokensRemoved,
    compressionRatio,
    reason: params.reason,
    provider: params.provider,
    turnsRemoved: params.turnsRemoved !== undefined ? safeInt(params.turnsRemoved) : undefined,
    'nr.appName': params.appName,
    'nr.entityGuid': params.entityGuid ?? null,
    customAttributes: params.customAttributes ?? {},
  };
}
