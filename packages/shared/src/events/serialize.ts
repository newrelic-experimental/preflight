import type { AiRequest, AiResponse, AiMessage, AiAgentTaskSummary, AiAntiPattern, AiAgentMessage, AiContextReset, NrEventData } from './types.js';

const PROVIDER_TO_GENAI_SYSTEM: Record<string, string> = {
  anthropic: 'anthropic',
  google: 'google_genai',
  openai: 'openai',
  bedrock: 'aws.bedrock',
  mistral: 'mistral_ai',
  cohere: 'cohere',
};

const METHOD_TO_GENAI_OPERATION: Record<string, string> = {
  'messages.create': 'chat',
  'messages.stream': 'chat',
  'models.generateContent': 'generate_content',
  'models.generateContentStream': 'generate_content',
  'models.embedContent': 'embeddings',
  'chat.completions.create': 'chat',
  'converse': 'chat',
  'converse-stream': 'chat',
  'chat.complete': 'chat',
  'chat.stream': 'chat',
  'chat': 'chat',
  'chatStream': 'chat',
};

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

  // GenAI semantic convention attributes (OTel spec, experimental)
  const genAiSystem = PROVIDER_TO_GENAI_SYSTEM[event.provider] ?? event.provider;
  data['gen_ai.system'] = genAiSystem;
  data['gen_ai.response.model'] = event.model;

  data['gen_ai.usage.input_tokens'] = event.inputTokens;
  data['gen_ai.usage.output_tokens'] = event.outputTokens;

  if (event.thinkingTokens > 0) data['gen_ai.usage.reasoning.output_tokens'] = event.thinkingTokens;
  if (event.cacheReadTokens > 0) data['gen_ai.usage.cache_read.input_tokens'] = event.cacheReadTokens;
  if (event.cacheCreationTokens > 0) data['gen_ai.usage.cache_creation.input_tokens'] = event.cacheCreationTokens;

  if (event.stopReason !== null) data['gen_ai.response.finish_reason'] = event.stopReason;

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

export function aiAgentTaskSummaryToNrEvent(event: AiAgentTaskSummary): NrEventData {
  const data: NrEventData = {
    eventType: 'AiAgentTaskSummary',
    id: event.id,
    timestamp: event.timestamp,
    traceId: event.traceId,
    spanId: event.spanId,
    taskName: event.taskName,
    'ai.agent.task_duration_ms': event.durationMs,
    'ai.agent.total_steps': event.stepCount,
    'ai.agent.llm_calls_per_task': event.totalLlmCalls,
    'ai.agent.tool_calls_per_task': event.totalToolCalls,
    'ai.agent.tokens_per_task': event.totalTokens,
    'ai.agent.task_success': event.success,
    'nr.appName': event['nr.appName'],
  };

  if (event.totalCostUsd !== null) data['ai.agent.cost_per_task_usd'] = event.totalCostUsd;
  if (event.delegationCount !== undefined) data['ai.agent.delegation_count'] = event.delegationCount;
  if (event.spawnCount !== undefined) data['ai.agent.spawn_count'] = event.spawnCount;
  if (event.delegationDepth !== undefined) data['ai.agent.delegation_depth'] = event.delegationDepth;
  if (event.interAgentMessages !== undefined) data['ai.agent.inter_agent_messages'] = event.interAgentMessages;
  if (event.delegationOverheadMs !== undefined) data['ai.agent.delegation_overhead_ms'] = event.delegationOverheadMs;

  for (const [key, value] of Object.entries(event.customAttributes)) {
    data[key] = value;
  }

  return data;
}

export function aiAntiPatternToNrEvent(event: AiAntiPattern): NrEventData {
  const data: NrEventData = {
    eventType: 'AiAntiPattern',
    id: event.id,
    timestamp: event.timestamp,
    traceId: event.traceId,
    type: event.patternType,
    severity: event.severity,
    description: event.description,
    'nr.appName': event['nr.appName'],
  };

  if (event.toolName !== undefined) data.toolName = event.toolName;
  if (event.repeatCount !== undefined) data.repeatCount = event.repeatCount;
  if (event.depthIndex !== undefined) data.depthIndex = event.depthIndex;
  if (event.taskComplexity !== undefined) data.taskComplexity = event.taskComplexity;
  if (event.contextPressure !== undefined) data.contextPressure = event.contextPressure;
  if (event.tokenShare !== undefined) data.tokenShare = event.tokenShare;
  if (event.attemptCount !== undefined) data.attemptCount = event.attemptCount;

  for (const [key, value] of Object.entries(event.customAttributes)) {
    data[key] = value;
  }

  return data;
}

export function aiAgentMessageToNrEvent(event: AiAgentMessage): NrEventData {
  const data: NrEventData = {
    eventType: 'AiAgentMessage',
    id: event.id,
    timestamp: event.timestamp,
    traceId: event.traceId,
    fromAgent: event.fromAgent,
    toAgent: event.toAgent,
    messageType: event.messageType,
    'nr.appName': event['nr.appName'],
  };

  if (event.tokenCount !== undefined) data.tokenCount = event.tokenCount;

  for (const [key, value] of Object.entries(event.customAttributes)) {
    data[key] = value;
  }

  return data;
}

export function aiContextResetToNrEvent(event: AiContextReset): NrEventData {
  const data: NrEventData = {
    eventType: 'AiContextReset',
    id: event.id,
    timestamp: event.timestamp,
    traceId: event.traceId,
    conversationId: event.conversationId,
    tokensBefore: event.tokensBefore,
    tokensAfter: event.tokensAfter,
    tokensRemoved: event.tokensRemoved,
    compressionRatio: event.compressionRatio,
    reason: event.reason,
    'nr.appName': event['nr.appName'],
  };

  if (event.turnsRemoved !== undefined) data.turnsRemoved = event.turnsRemoved;

  for (const [key, value] of Object.entries(event.customAttributes)) {
    data[key] = value;
  }

  return data;
}
