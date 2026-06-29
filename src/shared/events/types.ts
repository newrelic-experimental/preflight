export type AiProvider = 'anthropic' | 'google' | 'openai' | 'bedrock' | 'mistral' | 'cohere';

export type AiRequestMethod =
  | 'messages.create'
  | 'messages.stream'
  | 'models.generateContent'
  | 'models.generateContentStream'
  | 'models.embedContent'
  | 'chat.completions.create'
  // OpenAI's embeddings endpoint. Added so consumers
  // calling `client.embeddings.create({...})` (the OpenAI Node SDK shape)
  // can pass the verbatim method name and have it map to
  // `gen_ai.operation.name = 'embeddings'` in serialize.ts.
  | 'embeddings.create'
  | 'converse'
  | 'converse-stream'
  | 'chat.complete'
  | 'chat.stream'
  | 'chat'
  | 'chatStream'
  // Cohere's embeddings endpoint (`client.embed(...)`).
  | 'embed';

export interface AiRequest {
  readonly id: string;
  readonly timestamp: number;
  readonly provider: AiProvider;
  readonly model: string;
  readonly requestMethod: AiRequestMethod;

  readonly maxTokens: number | null;
  readonly temperature: number | null;
  readonly topP: number | null;
  readonly systemPromptLength: number | null;
  readonly messageCount: number;
  readonly toolCount: number;
  readonly toolNames: string[];
  readonly thinkingEnabled: boolean;
  readonly thinkingBudgetTokens: number | null;
  readonly streamingEnabled: boolean;

  readonly 'nr.appName': string;
  readonly 'nr.entityGuid': string | null;
  readonly customAttributes: Record<string, string | number | boolean>;
}

export interface AiResponse {
  readonly id: string;
  readonly timestamp: number;
  readonly provider: AiProvider;
  readonly model: string;

  readonly durationMs: number;
  readonly timeToFirstTokenMs: number | null;
  readonly tokensPerSecond: number | null;

  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly thinkingTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly totalTokens: number;

  readonly costInputUsd: number | null;
  readonly costOutputUsd: number | null;
  readonly costThinkingUsd: number | null;
  readonly costCacheReadUsd: number | null;
  readonly costCacheCreationUsd: number | null;
  readonly costTotalUsd: number | null;

  readonly stopReason: string | null;
  readonly contentBlockTypes: string[];

  readonly error: { type: string; message: string; statusCode: number | null } | null;

  readonly 'nr.appName': string;
  readonly 'nr.entityGuid': string | null;
  readonly customAttributes: Record<string, string | number | boolean>;
}

export type AiMessageRole = 'system' | 'user' | 'assistant';

export interface AiMessage {
  readonly id: string;
  readonly timestamp: number;
  readonly role: AiMessageRole;
  readonly content: string;
  readonly contentLength: number;
  readonly sequence: number;

  readonly 'nr.appName': string;
  readonly 'nr.entityGuid': string | null;
  readonly customAttributes: Record<string, string | number | boolean>;
}

export type NrEventData = Record<string, string | number | boolean>;

// WIP: SpanType and SpanAttributes are reserved for a future distributed
// tracing feature. No factory or serializer exists yet — intentionally NOT exported
// from index.ts. Implement createSpanAttributes() + spanAttributesToNrEvent() before
// re-exporting. Do not use from consumer code until backed by implementations.
// The underscore prefix suppresses @typescript-eslint/no-unused-vars.
type _SpanType = 'agent_task' | 'llm_call' | 'tool_call' | 'sub_agent' | 'planning';

interface _SpanAttributes {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly spanType: _SpanType;
  readonly name: string;
  readonly startTime: number;
  readonly endTime: number | null;
  readonly durationMs: number | null;
  readonly success: boolean | null;
  readonly output?: string;
  readonly model?: string;
  readonly toolName?: string;
  readonly input?: string;
  readonly customAttributes: Record<string, string | number | boolean>;
}

export interface AiAgentTaskSummary {
  readonly id: string;
  readonly timestamp: number;
  readonly traceId: string;
  readonly spanId: string;
  readonly taskName: string;
  readonly durationMs: number;
  readonly totalLlmCalls: number;
  readonly totalToolCalls: number;
  readonly totalTokens: number;
  readonly totalCostUsd: number | null;
  readonly stepCount: number;
  readonly success: boolean;
  readonly provider?: AiProvider;
  readonly delegationCount?: number;
  readonly spawnCount?: number;
  readonly delegationDepth?: number;
  readonly interAgentMessages?: number;
  readonly delegationOverheadMs?: number;
  readonly 'nr.appName': string;
  readonly 'nr.entityGuid': string | null;
  readonly customAttributes: Record<string, string | number | boolean>;
}

export type AntiPatternType =
  | 'spinning_wheels'
  | 'overthinking'
  | 'underthinking'
  | 'context_stuffing'
  | 'token_explosion'
  | 'bail_out';

export interface AiAntiPattern {
  readonly id: string;
  readonly timestamp: number;
  readonly traceId: string;
  readonly patternType: AntiPatternType;
  readonly severity: 'low' | 'medium' | 'high';
  readonly description: string;
  readonly provider?: AiProvider;
  readonly toolName?: string;
  readonly repeatCount?: number;
  readonly depthIndex?: number;
  readonly taskComplexity?: 'simple' | 'moderate' | 'complex';
  readonly contextPressure?: number | null;
  readonly tokenShare?: number | null;
  readonly attemptCount?: number;
  readonly 'nr.appName': string;
  readonly 'nr.entityGuid': string | null;
  readonly customAttributes: Record<string, string | number | boolean>;
}

export interface AiAgentMessage {
  readonly id: string;
  readonly timestamp: number;
  readonly traceId: string;
  readonly fromAgent: string;
  readonly toAgent: string;
  readonly messageType: string;
  readonly provider?: AiProvider;
  readonly tokenCount?: number;
  readonly 'nr.appName': string;
  readonly 'nr.entityGuid': string | null;
  readonly customAttributes: Record<string, string | number | boolean>;
}

export interface AiContextReset {
  readonly id: string;
  readonly timestamp: number;
  readonly traceId: string;
  readonly conversationId: string;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly tokensRemoved: number;
  readonly compressionRatio: number;
  readonly reason: 'summarization' | 'truncation' | 'sliding_window' | 'manual';
  readonly provider?: AiProvider;
  readonly turnsRemoved?: number;
  readonly 'nr.appName': string;
  readonly 'nr.entityGuid': string | null;
  readonly customAttributes: Record<string, string | number | boolean>;
}
