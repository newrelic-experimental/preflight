import type { AiRequest, AiResponse, AiMessage, NrEventData } from './types.js';

export function aiRequestToNrEvent(event: AiRequest): NrEventData {
  const data: NrEventData = {
    eventType: 'AiRequest',
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
  if (event.toolNames.length > 0) data.toolNames = JSON.stringify(event.toolNames);
  if (event.thinkingBudgetTokens !== null) data.thinkingBudgetTokens = event.thinkingBudgetTokens;
  if (event['nr.entityGuid'] !== null) data['nr.entityGuid'] = event['nr.entityGuid'];

  for (const [key, value] of Object.entries(event.customAttributes)) {
    data[`custom.${key}`] = value;
  }

  return data;
}

export function aiResponseToNrEvent(event: AiResponse): NrEventData {
  const data: NrEventData = {
    eventType: 'AiResponse',
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

  if (event.timeToFirstTokenMs !== null) data.timeToFirstTokenMs = event.timeToFirstTokenMs;
  if (event.tokensPerSecond !== null) data.tokensPerSecond = event.tokensPerSecond;
  if (event.stopReason !== null) data.stopReason = event.stopReason;
  if (event.contentBlockTypes.length > 0) {
    data.contentBlockTypes = JSON.stringify(event.contentBlockTypes);
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
    data['error.type'] = event.error.type;
    data['error.message'] = event.error.message;
    if (event.error.statusCode !== null) data['error.statusCode'] = event.error.statusCode;
  }

  for (const [key, value] of Object.entries(event.customAttributes)) {
    data[`custom.${key}`] = value;
  }

  return data;
}

export function aiMessageToNrEvent(event: AiMessage): NrEventData {
  const data: NrEventData = {
    eventType: 'AiMessage',
    id: event.id,
    timestamp: event.timestamp,
    role: event.role,
    content: event.content,
    contentLength: event.contentLength,
    sequence: event.sequence,
    'nr.appName': event['nr.appName'],
  };

  for (const [key, value] of Object.entries(event.customAttributes)) {
    data[`custom.${key}`] = value;
  }

  return data;
}
