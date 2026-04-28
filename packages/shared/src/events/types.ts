export type AiProvider = 'anthropic' | 'google' | 'openai';

export type AiRequestMethod =
  | 'messages.create'
  | 'messages.stream'
  | 'models.generateContent'
  | 'models.generateContentStream'
  | 'models.embedContent'
  | 'chat.completions.create';

export interface AiRequest {
  id: string;
  timestamp: number;
  provider: AiProvider;
  model: string;
  requestMethod: AiRequestMethod;

  maxTokens: number | null;
  temperature: number | null;
  topP: number | null;
  systemPromptLength: number | null;
  messageCount: number;
  toolCount: number;
  toolNames: string[];
  thinkingEnabled: boolean;
  thinkingBudgetTokens: number | null;
  streamingEnabled: boolean;

  'nr.appName': string;
  'nr.entityGuid': string | null;
  customAttributes: Record<string, string | number>;
}

export interface AiResponse {
  id: string;
  timestamp: number;
  provider: AiProvider;
  model: string;

  durationMs: number;
  timeToFirstTokenMs: number | null;
  tokensPerSecond: number | null;

  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;

  costInputUsd: number | null;
  costOutputUsd: number | null;
  costThinkingUsd: number | null;
  costCacheReadUsd: number | null;
  costCacheCreationUsd: number | null;
  costTotalUsd: number | null;

  stopReason: string | null;
  contentBlockTypes: string[];

  error: { type: string; message: string; statusCode: number | null } | null;

  'nr.appName': string;
  customAttributes: Record<string, string | number>;
}

export type AiMessageRole = 'system' | 'user' | 'assistant';

export interface AiMessage {
  id: string;
  timestamp: number;
  role: AiMessageRole;
  content: string;
  contentLength: number;
  sequence: number;

  'nr.appName': string;
  customAttributes: Record<string, string | number>;
}

export type NrEventData = Record<string, string | number | boolean>;
