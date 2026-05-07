import type OpenAI from 'openai';
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import type { Stream } from 'openai/streaming';
import { randomUUID } from 'node:crypto';
import { RequestTimer } from '@nr-ai-observatory/shared';
import type { RequestTimerMetrics } from '@nr-ai-observatory/shared';
import type { AiRequestRecord, WrapperConfig, RecordHandler } from '../types.js';

type CreateFn = OpenAI['chat']['completions']['create'];
type CreateParams = ChatCompletionCreateParamsNonStreaming | ChatCompletionCreateParamsStreaming;

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function redact(text: string, patterns: readonly RegExp[]): string {
  return patterns.reduce((s, pattern) => s.replace(pattern, '[REDACTED]'), text);
}

function sanitizeToolName(name: unknown): string {
  return String(name ?? '').slice(0, 256).replace(/[\x00-\x1f]/g, '');
}

function extractSystemPrompt(messages: ChatCompletionMessageParam[]): string | null {
  for (const msg of messages) {
    if (msg.role === 'system' && typeof msg.content === 'string') {
      return msg.content;
    }
  }
  return null;
}

function extractLastUserMessage(messages: ChatCompletionMessageParam[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') return msg.content;
      if (Array.isArray(msg.content)) {
        const texts = msg.content
          .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
          .map((p) => p.text);
        return texts.join('\n') || null;
      }
    }
  }
  return null;
}

function extractReasoningTokens(
  usage: { completion_tokens_details?: { reasoning_tokens?: number } } | null | undefined,
): number {
  return usage?.completion_tokens_details?.reasoning_tokens ?? 0;
}

function extractToolInfo(
  tools: CreateParams['tools'],
): { count: number; names: string[] } {
  if (!tools || tools.length === 0) return { count: 0, names: [] };
  const names = tools.map((t) => sanitizeToolName(t.function.name));
  return { count: tools.length, names };
}

function extractContentBlockTypes(
  response: ChatCompletion,
): string[] {
  const choice = response.choices[0];
  if (!choice) return [];
  const types = new Set<string>();
  if (choice.message.content) types.add('text');
  if (choice.message.tool_calls?.length) types.add('tool_use');
  return [...types];
}

function buildBaseRecord(
  params: CreateParams,
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
  const toolInfo = extractToolInfo(params.tools);
  const shouldCapture = config.recordContent && !config.highSecurity;
  const messages = params.messages as ChatCompletionMessageParam[];
  const rawSystemPrompt = extractSystemPrompt(messages);
  const rawUserMessage = extractLastUserMessage(messages);

  return {
    id: randomUUID(),
    timestamp: Date.now(),
    provider: 'openai',
    model: '',
    requestModel: params.model,
    requestMethod: '',
    streaming: false,
    maxTokens: params.max_tokens ?? null,
    temperature: params.temperature ?? null,
    topP: params.top_p ?? null,
    topK: null,
    messageCount: params.messages.length,
    toolCount: toolInfo.count,
    toolNames: toolInfo.names,
    thinkingEnabled: false,
    thinkingBudgetTokens: null,
    systemPromptLength: rawSystemPrompt !== null ? rawSystemPrompt.length : null,
    systemPrompt:
      shouldCapture && rawSystemPrompt !== null
        ? truncate(rawSystemPrompt, config.contentMaxLength)
        : null,
    lastUserMessage:
      shouldCapture && rawUserMessage !== null
        ? truncate(rawUserMessage, config.contentMaxLength)
        : null,
  };
}

function finalizeRecord(
  base: ReturnType<typeof buildBaseRecord>,
  response: ChatCompletion,
  metrics: RequestTimerMetrics,
  config: WrapperConfig,
): AiRequestRecord {
  const shouldCapture = config.recordContent && !config.highSecurity;
  const usage = response.usage;
  const cachedTokens = (usage as unknown as { prompt_tokens_details?: { cached_tokens?: number } }).prompt_tokens_details?.cached_tokens ?? 0;
  const inputTokens = (usage?.prompt_tokens ?? 0) - cachedTokens;
  const outputTokens = usage?.completion_tokens ?? 0;
  const thinkingTokens = extractReasoningTokens(
    usage as unknown as { completion_tokens_details?: { reasoning_tokens?: number } },
  );
  const responseContent = response.choices[0]?.message?.content ?? null;

  return {
    ...base,
    model: response.model,
    durationMs: metrics.durationMs,
    timeToFirstTokenMs: metrics.timeToFirstTokenMs,
    inputTokens,
    outputTokens,
    thinkingTokens,
    cacheReadTokens: cachedTokens,
    cacheCreationTokens: 0,
    totalTokens: usage?.total_tokens ?? inputTokens + outputTokens + thinkingTokens + cachedTokens,
    stopReason: response.choices[0]?.finish_reason ?? null,
    contentBlockTypes: extractContentBlockTypes(response),
    responseText:
      shouldCapture && responseContent !== null
        ? truncate(responseContent, config.contentMaxLength)
        : null,
    error: null,
  };
}

function buildErrorRecord(
  base: ReturnType<typeof buildBaseRecord>,
  err: unknown,
  timer: RequestTimer,
  config: WrapperConfig,
): AiRequestRecord {
  timer.stop();
  const metrics = timer.getMetrics();
  const error = err as { status?: number; error?: { type?: string }; message?: string };
  const rawMessage = error.message ?? (err instanceof Error ? err.message : String(err));
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
      message: truncate(redact(rawMessage, config.redactionPatterns), 1024),
      statusCode: error.status ?? null,
    },
  };
}

function wrapChunkStream(
  stream: Stream<ChatCompletionChunk>,
  base: ReturnType<typeof buildBaseRecord>,
  timer: RequestTimer,
  config: WrapperConfig,
  onRecord: RecordHandler,
): Stream<ChatCompletionChunk> {
  let model = base.requestModel;
  let stopReason: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let thinkingTokens = 0;
  let cacheReadTokens = 0;
  let totalTokens: number | null = null;
  let accumulatedText = '';
  let hasToolCalls = false;

  const originalIterator = stream[Symbol.asyncIterator].bind(stream);

  const wrappedIterator = async function* (): AsyncGenerator<ChatCompletionChunk> {
    try {
      for await (const chunk of { [Symbol.asyncIterator]: originalIterator }) {
        if (chunk.model) model = chunk.model;

        const delta = chunk.choices[0]?.delta;
        if (delta?.content) {
          timer.markFirstToken();
          accumulatedText += delta.content;
        }
        if (delta?.tool_calls?.length) {
          hasToolCalls = true;
        }

        const finishReason = chunk.choices[0]?.finish_reason;
        if (finishReason) stopReason = finishReason;

        if (chunk.usage) {
          const u = chunk.usage as unknown as {
            prompt_tokens?: number;
            completion_tokens?: number;
            total_tokens?: number;
            completion_tokens_details?: { reasoning_tokens?: number };
            prompt_tokens_details?: { cached_tokens?: number };
          };
          const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
          inputTokens = (u.prompt_tokens ?? 0) - cached;
          outputTokens = u.completion_tokens ?? 0;
          cacheReadTokens = cached;
          totalTokens = u.total_tokens ?? null;
          thinkingTokens = extractReasoningTokens(u);
        }

        yield chunk;
      }

      timer.stop();
      const metrics = timer.getMetrics();
      const shouldCapture = config.recordContent && !config.highSecurity;
      const contentBlockTypes: string[] = [];
      if (accumulatedText) contentBlockTypes.push('text');
      if (hasToolCalls) contentBlockTypes.push('tool_use');

      const record: AiRequestRecord = {
        ...base,
        model,
        durationMs: metrics.durationMs,
        timeToFirstTokenMs: metrics.timeToFirstTokenMs,
        inputTokens,
        outputTokens,
        thinkingTokens,
        cacheReadTokens,
        cacheCreationTokens: 0,
        totalTokens: totalTokens ?? inputTokens + outputTokens + thinkingTokens + cacheReadTokens,
        stopReason,
        contentBlockTypes,
        responseText:
          shouldCapture && accumulatedText
            ? truncate(accumulatedText, config.contentMaxLength)
            : null,
        error: null,
      };
      onRecord(record);
    } catch (err) {
      const record = buildErrorRecord(base, err, timer, config);
      onRecord(record);
      throw err;
    }
  };

  const proxy = new Proxy(stream, {
    get(target, prop, receiver) {
      if (prop === Symbol.asyncIterator) {
        return wrappedIterator;
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  return proxy;
}

function wrapCreate(
  original: CreateFn,
  config: WrapperConfig,
  onRecord: RecordHandler,
): CreateFn {
  return function wrappedCreate(
    this: OpenAI['chat']['completions'],
    body: CreateParams,
    options?: Parameters<CreateFn>[1],
  ): ReturnType<CreateFn> {
    if ('stream' in body && body.stream === true) {
      const base = buildBaseRecord(body, config);
      base.requestMethod = 'chat.completions.create';
      base.streaming = true;
      const timer = new RequestTimer();
      timer.start();

      const streamBody = { ...body, stream_options: { include_usage: true } };
      const promise = original.call(
        this,
        streamBody as ChatCompletionCreateParamsStreaming,
        options,
      ) as Promise<Stream<ChatCompletionChunk>>;

      return promise.then((stream) =>
        wrapChunkStream(stream, base, timer, config, onRecord),
      ) as ReturnType<CreateFn>;
    }

    const base = buildBaseRecord(body, config);
    base.requestMethod = 'chat.completions.create';
    base.streaming = false;
    const timer = new RequestTimer();
    timer.start();

    const promise = original.call(
      this,
      body as ChatCompletionCreateParamsNonStreaming,
      options,
    ) as Promise<ChatCompletion>;

    return promise.then(
      (response) => {
        timer.stop();
        const record = finalizeRecord(base, response, timer.getMetrics(), config);
        onRecord(record);
        return response;
      },
      (err) => {
        const record = buildErrorRecord(base, err, timer, config);
        onRecord(record);
        throw err;
      },
    ) as ReturnType<CreateFn>;
  } as CreateFn;
}

export function wrapOpenAiClient(
  client: OpenAI,
  config: WrapperConfig,
  onRecord: RecordHandler,
): OpenAI {
  if (!config.enabled) return client;

  const originalCreate = client.chat.completions.create.bind(client.chat.completions);
  client.chat.completions.create = wrapCreate(originalCreate, config, onRecord);

  return client;
}
