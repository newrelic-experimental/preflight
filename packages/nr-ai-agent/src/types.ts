export interface AiRequestRecord {
  id: string;
  timestamp: number;
  provider: 'anthropic' | 'google';
  model: string;
  requestModel: string;
  requestMethod: string;
  streaming: boolean;

  // Request params
  maxTokens: number | null;
  temperature: number | null;
  topP: number | null;
  topK: number | null;
  messageCount: number;
  toolCount: number;
  toolNames: string[];
  thinkingEnabled: boolean;
  thinkingBudgetTokens: number | null;
  systemPromptLength: number | null;

  // Response data
  durationMs: number;
  timeToFirstTokenMs: number | null;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  stopReason: string | null;
  contentBlockTypes: string[];

  // Content (only if recordContent=true)
  systemPrompt: string | null;
  lastUserMessage: string | null;
  responseText: string | null;

  // Error info
  error: {
    type: string;
    message: string;
    statusCode: number | null;
  } | null;
}

export interface AiEmbeddingRecord {
  id: string;
  timestamp: number;
  provider: 'anthropic' | 'google';
  model: string;
  requestModel: string;

  // Response data
  durationMs: number;
  inputTokens: number;
  embeddingDimensions: number;
  embeddingCount: number;

  // Error info
  error: {
    type: string;
    message: string;
    statusCode: number | null;
  } | null;
}

export type EmbeddingRecordHandler = (record: AiEmbeddingRecord) => void;

export interface WrapperConfig {
  enabled: boolean;
  recordContent: boolean;
  highSecurity: boolean;
  contentMaxLength: number;
}

export type RecordHandler = (record: AiRequestRecord) => void;
