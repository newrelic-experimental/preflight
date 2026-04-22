import { randomUUID } from 'node:crypto';
import type {
  AiRequest,
  AiResponse,
  AiMessage,
  AiProvider,
  AiRequestMethod,
  AiMessageRole,
} from './types.js';

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
  customAttributes?: Record<string, string | number>;
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

  return {
    id: params.id ?? randomUUID(),
    timestamp: params.timestamp ?? Date.now(),
    provider: params.provider,
    model: params.model,
    requestMethod: params.requestMethod,
    maxTokens: params.maxTokens ?? null,
    temperature: params.temperature ?? null,
    topP: params.topP ?? null,
    systemPromptLength: params.systemPromptLength ?? null,
    messageCount: params.messageCount,
    toolCount: params.toolCount ?? 0,
    toolNames: params.toolNames ?? [],
    thinkingEnabled: params.thinkingEnabled ?? false,
    thinkingBudgetTokens: params.thinkingBudgetTokens ?? null,
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
  customAttributes?: Record<string, string | number>;
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

  const inputTokens = params.inputTokens;
  const outputTokens = params.outputTokens;
  const thinkingTokens = params.thinkingTokens ?? 0;
  const cacheReadTokens = params.cacheReadTokens ?? 0;
  const cacheCreationTokens = params.cacheCreationTokens ?? 0;
  const totalTokens = inputTokens + outputTokens + thinkingTokens + cacheReadTokens + cacheCreationTokens;

  const durationMs = params.durationMs;
  const tokensPerSecond =
    durationMs > 0 && outputTokens > 0 ? (outputTokens / durationMs) * 1000 : null;

  return {
    id: params.id ?? randomUUID(),
    timestamp: params.timestamp ?? Date.now(),
    provider: params.provider,
    model: params.model,
    durationMs,
    timeToFirstTokenMs: params.timeToFirstTokenMs ?? null,
    tokensPerSecond,
    inputTokens,
    outputTokens,
    thinkingTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens,
    costInputUsd: params.costInputUsd ?? null,
    costOutputUsd: params.costOutputUsd ?? null,
    costThinkingUsd: params.costThinkingUsd ?? null,
    costCacheReadUsd: params.costCacheReadUsd ?? null,
    costCacheCreationUsd: params.costCacheCreationUsd ?? null,
    costTotalUsd: params.costTotalUsd ?? null,
    stopReason: params.stopReason ?? null,
    contentBlockTypes: params.contentBlockTypes ?? [],
    error: params.error ?? null,
    'nr.appName': params.appName,
    customAttributes: params.customAttributes ?? {},
  };
}

export interface CreateAiMessageParams {
  role: AiMessageRole;
  content: string;
  contentLength: number;
  sequence: number;
  appName: string;
  customAttributes?: Record<string, string | number>;
  id?: string;
  timestamp?: number;
}

export function createAiMessage(params: CreateAiMessageParams): AiMessage {
  if (!params.role) {
    throw new Error('AiMessage requires a role');
  }
  if (!params.appName) {
    throw new Error('AiMessage requires an appName');
  }

  return {
    id: params.id ?? randomUUID(),
    timestamp: params.timestamp ?? Date.now(),
    role: params.role,
    content: params.content,
    contentLength: params.contentLength,
    sequence: params.sequence,
    'nr.appName': params.appName,
    customAttributes: params.customAttributes ?? {},
  };
}
