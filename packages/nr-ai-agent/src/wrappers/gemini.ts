import type { GoogleGenAI } from '@google/genai';
import type {
  GenerateContentParameters,
  GenerateContentResponse,
  GenerateContentConfig,
  EmbedContentParameters,
  EmbedContentResponse,
  Content,
  Part,
  SafetyRating,
  GroundingMetadata,
  Tool,
} from '@google/genai';
import { randomUUID } from 'node:crypto';
import { RequestTimer } from '@nr-ai-observatory/shared';
import type { RequestTimerMetrics } from '@nr-ai-observatory/shared';
import type {
  AiRequestRecord,
  AiEmbeddingRecord,
  WrapperConfig,
  RecordHandler,
  EmbeddingRecordHandler,
} from '../types.js';

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function extractLastUserMessage(contents: GenerateContentParameters['contents']): string | null {
  if (typeof contents === 'string') return contents;
  if (!Array.isArray(contents)) {
    // Single Content or Part object
    const content = contents as Content | Part;
    if ('parts' in content && content.parts) {
      return extractTextFromParts(content.parts);
    }
    if ('text' in content && typeof content.text === 'string') {
      return content.text;
    }
    return null;
  }

  // Array — could be Content[] or PartUnion[]
  // Walk backwards looking for user content
  for (let i = contents.length - 1; i >= 0; i--) {
    const item = contents[i];
    if (typeof item === 'string') return item;
    if ('role' in item && item.role === 'model') continue;
    if ('parts' in item && item.parts) {
      const text = extractTextFromParts(item.parts);
      if (text) return text;
    }
    if ('text' in item && typeof item.text === 'string') {
      return item.text;
    }
  }
  return null;
}

function extractTextFromParts(parts: Part[]): string | null {
  const texts = parts
    .filter((p) => 'text' in p && typeof p.text === 'string' && !p.thought)
    .map((p) => p.text as string);
  return texts.length > 0 ? texts.join('') : null;
}

function extractSystemInstruction(config: GenerateContentConfig | undefined): string | null {
  if (!config?.systemInstruction) return null;
  const si = config.systemInstruction;
  if (typeof si === 'string') return si;
  if ('parts' in si && si.parts) return extractTextFromParts(si.parts);
  if ('text' in si && typeof si.text === 'string') return si.text;
  return null;
}

function extractSystemInstructionLength(config: GenerateContentConfig | undefined): number | null {
  const text = extractSystemInstruction(config);
  return text !== null ? text.length : null;
}

function extractToolNames(tools: GenerateContentConfig['tools'] | undefined): string[] {
  if (!tools || !Array.isArray(tools)) return [];
  const names: string[] = [];
  for (const tool of tools) {
    const t = tool as Tool;
    if (t.functionDeclarations) {
      for (const fd of t.functionDeclarations) {
        if (fd.name) names.push(fd.name);
      }
    }
    if (t.googleSearch) names.push('googleSearch');
    if (t.codeExecution) names.push('codeExecution');
    if (t.retrieval) names.push('retrieval');
  }
  return names;
}

function extractThinkingConfig(config: GenerateContentConfig | undefined): {
  enabled: boolean;
  budgetTokens: number | null;
} {
  if (!config?.thinkingConfig) return { enabled: false, budgetTokens: null };
  const tc = config.thinkingConfig;
  return {
    enabled: true,
    budgetTokens: tc.thinkingBudget ?? null,
  };
}

function extractMessageCount(contents: GenerateContentParameters['contents']): number {
  if (typeof contents === 'string') return 1;
  if (!Array.isArray(contents)) return 1;
  return contents.length;
}

function extractResponseText(response: GenerateContentResponse): string | null {
  // Use the SDK's built-in text accessor
  const text = response.text;
  return text !== undefined && text !== '' ? text : null;
}

function extractFinishReason(response: GenerateContentResponse): string | null {
  const candidate = response.candidates?.[0];
  return candidate?.finishReason ?? null;
}

function extractSafetyRatings(
  response: GenerateContentResponse,
): { category: string; probability: string; blocked: boolean }[] | null {
  const candidate = response.candidates?.[0];
  if (!candidate?.safetyRatings || candidate.safetyRatings.length === 0) return null;
  return candidate.safetyRatings.map((r: SafetyRating) => ({
    category: r.category ?? 'UNKNOWN',
    probability: r.probability ?? 'UNKNOWN',
    blocked: r.blocked ?? false,
  }));
}

function extractGroundingInfo(
  response: GenerateContentResponse,
): { hasGrounding: boolean; chunksCount: number; supportsCount: number } | null {
  const candidate = response.candidates?.[0];
  const gm: GroundingMetadata | undefined = candidate?.groundingMetadata;
  if (!gm) return null;
  return {
    hasGrounding: true,
    chunksCount: gm.groundingChunks?.length ?? 0,
    supportsCount: gm.groundingSupports?.length ?? 0,
  };
}

function extractContentBlockTypes(response: GenerateContentResponse): string[] {
  const candidate = response.candidates?.[0];
  if (!candidate?.content?.parts) return [];
  const types = new Set<string>();
  for (const part of candidate.content.parts) {
    if (part.text !== undefined) {
      if (part.thought) {
        types.add('thinking');
      } else {
        types.add('text');
      }
    }
    if (part.functionCall) types.add('function_call');
    if (part.executableCode) types.add('executable_code');
    if (part.codeExecutionResult) types.add('code_execution_result');
    if (part.inlineData) types.add('inline_data');
  }
  return [...types];
}

function buildBaseRecord(
  params: GenerateContentParameters,
  config: WrapperConfig,
): Omit<
  AiRequestRecord,
  | 'durationMs'
  | 'timeToFirstTokenMs'
  | 'inputTokens'
  | 'outputTokens'
  | 'thinkingTokens'
  | 'cacheReadTokens'
  | 'cacheCreationTokens'
  | 'totalTokens'
  | 'stopReason'
  | 'contentBlockTypes'
  | 'responseText'
  | 'error'
> {
  const genConfig = params.config;
  const toolNames = extractToolNames(genConfig?.tools);
  const thinkingConfig = extractThinkingConfig(genConfig);
  const shouldCapture = config.recordContent && !config.highSecurity;
  const rawSystemInstruction = extractSystemInstruction(genConfig);
  const rawUserMessage = extractLastUserMessage(params.contents);

  return {
    id: randomUUID(),
    timestamp: Date.now(),
    provider: 'google',
    model: '',
    requestModel: params.model,
    requestMethod: '',
    streaming: false,
    maxTokens: genConfig?.maxOutputTokens ?? null,
    temperature: genConfig?.temperature ?? null,
    topP: genConfig?.topP ?? null,
    topK: genConfig?.topK ?? null,
    messageCount: extractMessageCount(params.contents),
    toolCount: toolNames.length,
    toolNames,
    thinkingEnabled: thinkingConfig.enabled,
    thinkingBudgetTokens: thinkingConfig.budgetTokens,
    systemPromptLength: extractSystemInstructionLength(genConfig),
    systemPrompt:
      shouldCapture && rawSystemInstruction !== null
        ? truncate(rawSystemInstruction, config.contentMaxLength)
        : null,
    lastUserMessage:
      shouldCapture && rawUserMessage !== null
        ? truncate(rawUserMessage, config.contentMaxLength)
        : null,
  };
}

function finalizeRecord(
  base: ReturnType<typeof buildBaseRecord>,
  response: GenerateContentResponse,
  metrics: RequestTimerMetrics,
  wrapperConfig: WrapperConfig,
): AiRequestRecord {
  const shouldCapture = wrapperConfig.recordContent && !wrapperConfig.highSecurity;
  const usage = response.usageMetadata;
  const inputTokens = usage?.promptTokenCount ?? 0;
  const outputTokens = usage?.candidatesTokenCount ?? 0;
  const thinkingTokens = usage?.thoughtsTokenCount ?? 0;
  const cacheRead = usage?.cachedContentTokenCount ?? 0;
  const rawResponseText = extractResponseText(response);

  return {
    ...base,
    model: base.requestModel,
    durationMs: metrics.durationMs,
    timeToFirstTokenMs: metrics.timeToFirstTokenMs,
    inputTokens,
    outputTokens,
    thinkingTokens,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: 0,
    totalTokens: usage?.totalTokenCount ?? inputTokens + outputTokens + thinkingTokens,
    stopReason: extractFinishReason(response),
    contentBlockTypes: extractContentBlockTypes(response),
    responseText:
      shouldCapture && rawResponseText !== null
        ? truncate(rawResponseText, wrapperConfig.contentMaxLength)
        : null,
    error: null,
  };
}

function buildErrorRecord(
  base: ReturnType<typeof buildBaseRecord>,
  err: unknown,
  timer: RequestTimer,
): AiRequestRecord {
  timer.stop();
  const metrics = timer.getMetrics();
  const error = err as { status?: number; error?: { type?: string }; message?: string };
  return {
    ...base,
    model: base.requestModel,
    durationMs: metrics.durationMs,
    timeToFirstTokenMs: null,
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    stopReason: null,
    contentBlockTypes: [],
    responseText: null,
    error: {
      type: error.error?.type ?? (err instanceof Error ? err.constructor.name : 'Unknown'),
      message: truncate(error.message ?? (err instanceof Error ? err.message : String(err)), 1024),
      statusCode: error.status ?? null,
    },
  };
}

type ModelsType = GoogleGenAI['models'];

function wrapGenerateContent(
  original: ModelsType['generateContent'],
  config: WrapperConfig,
  onRecord: RecordHandler,
): ModelsType['generateContent'] {
  return async function wrappedGenerateContent(
    params: GenerateContentParameters,
  ): Promise<GenerateContentResponse> {
    const base = buildBaseRecord(params, config);
    base.requestMethod = 'models.generateContent';
    base.streaming = false;
    const timer = new RequestTimer();
    timer.start();

    try {
      const response = await original(params);
      timer.stop();
      const record = finalizeRecord(base, response, timer.getMetrics(), config);
      onRecord(record);
      return response;
    } catch (err) {
      const record = buildErrorRecord(base, err, timer);
      onRecord(record);
      throw err;
    }
  };
}

function wrapGenerateContentStream(
  original: ModelsType['generateContentStream'],
  config: WrapperConfig,
  onRecord: RecordHandler,
): ModelsType['generateContentStream'] {
  return async function wrappedGenerateContentStream(
    params: GenerateContentParameters,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const base = buildBaseRecord(params, config);
    base.requestMethod = 'models.generateContentStream';
    base.streaming = true;
    const timer = new RequestTimer();
    timer.start();

    try {
      const stream = await original(params);
      return wrapAsyncGenerator(stream, base, timer, config, onRecord);
    } catch (err) {
      const record = buildErrorRecord(base, err, timer);
      onRecord(record);
      throw err;
    }
  };
}

async function* wrapAsyncGenerator(
  stream: AsyncGenerator<GenerateContentResponse>,
  base: ReturnType<typeof buildBaseRecord>,
  timer: RequestTimer,
  config: WrapperConfig,
  onRecord: RecordHandler,
): AsyncGenerator<GenerateContentResponse> {
  let lastChunk: GenerateContentResponse | null = null;
  let thinkingStarted = false;

  try {
    for await (const chunk of stream) {
      // Detect TTFT from first chunk with text content
      if (chunk.text !== undefined && chunk.text !== '') {
        timer.markFirstToken();
      }

      // Detect thinking phase from thought parts
      const candidate = chunk.candidates?.[0];
      const parts = candidate?.content?.parts;
      if (parts) {
        const hasThought = parts.some((p) => p.thought);
        if (hasThought && !thinkingStarted) {
          timer.markThinkingStart();
          thinkingStarted = true;
        } else if (!hasThought && thinkingStarted) {
          timer.markThinkingEnd();
          thinkingStarted = false;
        }
      }

      lastChunk = chunk;
      yield chunk;
    }

    // If thinking never ended explicitly (e.g. stream ended during thinking), close it
    if (thinkingStarted) {
      timer.markThinkingEnd();
    }

    // Stream completed — finalize from the last chunk which has accumulated usage
    if (lastChunk) {
      timer.stop();
      const record = finalizeRecord(base, lastChunk, timer.getMetrics(), config);
      onRecord(record);
    }
  } catch (err) {
    const record = buildErrorRecord(base, err, timer);
    onRecord(record);
    throw err;
  }
}

function wrapEmbedContent(
  original: ModelsType['embedContent'],
  config: WrapperConfig,
  onEmbeddingRecord: EmbeddingRecordHandler,
): ModelsType['embedContent'] {
  return async function wrappedEmbedContent(
    params: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    const startTime = performance.now();

    try {
      const response = await original(params);
      const embeddings = response.embeddings ?? [];
      const firstEmbedding = embeddings[0];

      const record: AiEmbeddingRecord = {
        id: randomUUID(),
        timestamp: Date.now(),
        provider: 'google',
        model: params.model,
        requestModel: params.model,
        durationMs: performance.now() - startTime,
        inputTokens: firstEmbedding?.statistics?.tokenCount ?? 0,
        embeddingDimensions: firstEmbedding?.values?.length ?? 0,
        embeddingCount: embeddings.length,
        error: null,
      };
      onEmbeddingRecord(record);
      return response;
    } catch (err) {
      const error = err as { status?: number; error?: { type?: string }; message?: string };
      const record: AiEmbeddingRecord = {
        id: randomUUID(),
        timestamp: Date.now(),
        provider: 'google',
        model: params.model,
        requestModel: params.model,
        durationMs: performance.now() - startTime,
        inputTokens: 0,
        embeddingDimensions: 0,
        embeddingCount: 0,
        error: {
          type: error.error?.type ?? (err instanceof Error ? err.constructor.name : 'Unknown'),
          message: truncate(
            error.message ?? (err instanceof Error ? err.message : String(err)),
            1024,
          ),
          statusCode: error.status ?? null,
        },
      };
      onEmbeddingRecord(record);
      throw err;
    }
  };
}

export function wrapGeminiClient(
  client: GoogleGenAI,
  config: WrapperConfig,
  onRecord: RecordHandler,
  onEmbeddingRecord: EmbeddingRecordHandler,
): GoogleGenAI {
  if (!config.enabled) return client;

  const originalGenerateContent = client.models.generateContent.bind(client.models);
  const originalGenerateContentStream = client.models.generateContentStream.bind(client.models);
  const originalEmbedContent = client.models.embedContent.bind(client.models);

  client.models.generateContent = wrapGenerateContent(originalGenerateContent, config, onRecord);
  client.models.generateContentStream = wrapGenerateContentStream(
    originalGenerateContentStream,
    config,
    onRecord,
  );
  client.models.embedContent = wrapEmbedContent(originalEmbedContent, config, onEmbeddingRecord);

  return client;
}

// Re-export extraction functions for use in enrichment/transforms
export { extractSafetyRatings, extractGroundingInfo };
