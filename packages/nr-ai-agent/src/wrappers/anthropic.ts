import type Anthropic from '@anthropic-ai/sdk';
import type { RequestOptions } from '@anthropic-ai/sdk/core';
import type { MessageStream } from '@anthropic-ai/sdk/lib/MessageStream';
import type {
  MessageCreateParamsNonStreaming,
  MessageCreateParamsStreaming,
  MessageCreateParamsBase,
  RawMessageStreamEvent,
  Message,
  ContentBlock,
} from '@anthropic-ai/sdk/resources/messages/messages';
import type { Stream } from '@anthropic-ai/sdk/streaming';
import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { RequestTimer } from '@nr-ai-observatory/shared';
import type { RequestTimerMetrics } from '@nr-ai-observatory/shared';
import type { AiRequestRecord, WrapperConfig, RecordHandler } from '../types.js';

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function redact(text: string, patterns: readonly RegExp[]): string {
  return patterns.reduce((s, pattern) => s.replace(pattern, '[REDACTED]'), text);
}

function extractSystemPromptLength(
  system: MessageCreateParamsBase['system'] | undefined,
): number | null {
  if (!system) return null;
  if (typeof system === 'string') return system.length;
  return system.reduce((sum, block) => sum + ('text' in block ? block.text.length : 0), 0);
}

function extractSystemPromptText(
  system: MessageCreateParamsBase['system'] | undefined,
): string | null {
  if (!system) return null;
  if (typeof system === 'string') return system;
  return system
    .filter((b): b is { type: 'text'; text: string } => 'text' in b)
    .map((b) => b.text)
    .join('\n');
}

function extractLastUserMessage(messages: MessageCreateParamsBase['messages']): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') return msg.content;
      const textParts = msg.content.filter(
        (b): b is { type: 'text'; text: string } => 'type' in b && b.type === 'text',
      );
      return textParts.map((b) => b.text).join('\n') || null;
    }
  }
  return null;
}

function extractResponseText(content: ContentBlock[]): string | null {
  const textBlocks = content.filter((b) => b.type === 'text');
  if (textBlocks.length === 0) return null;
  return textBlocks.map((b) => (b as { text: string }).text).join('');
}

function extractContentBlockTypes(content: ContentBlock[]): string[] {
  return [...new Set(content.map((b) => b.type))];
}

function sanitizeToolName(name: unknown): string {
  return String(name ?? '').slice(0, 256).replace(/[\x00-\x1f]/g, '');
}

function extractToolInfo(tools: MessageCreateParamsBase['tools'] | undefined): {
  count: number;
  names: string[];
} {
  if (!tools || tools.length === 0) return { count: 0, names: [] };
  const names = tools.map((t) => sanitizeToolName(t.name));
  return { count: tools.length, names };
}

function extractThinkingConfig(thinking: MessageCreateParamsBase['thinking'] | undefined): {
  enabled: boolean;
  budgetTokens: number | null;
} {
  if (!thinking || thinking.type === 'disabled') {
    return { enabled: false, budgetTokens: null };
  }
  return { enabled: true, budgetTokens: thinking.budget_tokens };
}

function extractThinkingTokens(): number {
  // The SDK doesn't expose per-block token counts; callers
  // should prefer the usage-level data when available.
  return 0;
}

function buildBaseRecord(
  params: MessageCreateParamsBase,
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
  const thinkingConfig = extractThinkingConfig(params.thinking);
  const shouldCapture = config.recordContent && !config.highSecurity;
  const rawSystemPrompt = extractSystemPromptText(params.system);
  const rawUserMessage = extractLastUserMessage(params.messages);

  return {
    id: randomUUID(),
    timestamp: Date.now(),
    provider: 'anthropic',
    model: '',
    requestModel: params.model,
    requestMethod: '',
    streaming: false,
    maxTokens: params.max_tokens ?? null,
    temperature: params.temperature ?? null,
    topP: params.top_p ?? null,
    topK: params.top_k ?? null,
    messageCount: params.messages.length,
    toolCount: toolInfo.count,
    toolNames: toolInfo.names,
    thinkingEnabled: thinkingConfig.enabled,
    thinkingBudgetTokens: thinkingConfig.budgetTokens,
    systemPromptLength: extractSystemPromptLength(params.system),
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
  response: Message,
  metrics: RequestTimerMetrics,
  config: WrapperConfig,
): AiRequestRecord {
  const shouldCapture = config.recordContent && !config.highSecurity;
  const usage = response.usage;
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;
  const thinkingTokens = extractThinkingTokens();
  const rawResponseText = extractResponseText(response.content);

  return {
    ...base,
    model: response.model,
    durationMs: metrics.durationMs,
    timeToFirstTokenMs: metrics.timeToFirstTokenMs,
    inputTokens,
    outputTokens,
    thinkingTokens,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
    totalTokens: inputTokens + outputTokens + thinkingTokens + cacheRead + cacheCreation,
    stopReason: response.stop_reason,
    contentBlockTypes: extractContentBlockTypes(response.content),
    responseText:
      shouldCapture && rawResponseText !== null
        ? truncate(rawResponseText, config.contentMaxLength)
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

function wrapCreate(
  original: Anthropic['messages']['create'],
  config: WrapperConfig,
  onRecord: RecordHandler,
): Anthropic['messages']['create'] {
  return function wrappedCreate(
    this: Anthropic['messages'],
    body: MessageCreateParamsNonStreaming | MessageCreateParamsStreaming | MessageCreateParamsBase,
    options?: RequestOptions,
  ): ReturnType<Anthropic['messages']['create']> {
    if ('stream' in body && body.stream === true) {
      // Streaming via create() — the SDK returns a Stream<RawMessageStreamEvent>
      const base = buildBaseRecord(body, config);
      base.requestMethod = 'messages.create';
      base.streaming = true;
      const timer = new RequestTimer();
      timer.start();

      const promise = original.call(this, body as MessageCreateParamsStreaming, options) as Promise<
        Stream<RawMessageStreamEvent>
      >;

      return promise.then((stream) => {
        return wrapRawStream(stream, base, timer, config, onRecord);
      }) as ReturnType<Anthropic['messages']['create']>;
    }

    // Non-streaming
    const base = buildBaseRecord(body, config);
    base.requestMethod = 'messages.create';
    base.streaming = false;
    const timer = new RequestTimer();
    timer.start();

    const promise = original.call(
      this,
      body as MessageCreateParamsNonStreaming,
      options,
    ) as Promise<Message>;

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
    ) as ReturnType<Anthropic['messages']['create']>;
  } as Anthropic['messages']['create'];
}

function wrapRawStream(
  stream: Stream<RawMessageStreamEvent>,
  base: ReturnType<typeof buildBaseRecord>,
  timer: RequestTimer,
  config: WrapperConfig,
  onRecord: RecordHandler,
): Stream<RawMessageStreamEvent> {
  let finalMessage: Message | null = null;
  let thinkingBlockIndex: number | null = null;

  const originalIterator = stream[Symbol.asyncIterator].bind(stream);

  const wrappedIterator = async function* (): AsyncGenerator<RawMessageStreamEvent> {
    try {
      for await (const event of { [Symbol.asyncIterator]: originalIterator }) {
        // Detect first text content delta for TTFT
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        ) {
          timer.markFirstToken();
        }

        // Detect thinking phase from content_block_start/stop events
        if (
          event.type === 'content_block_start' &&
          event.content_block?.type === 'thinking'
        ) {
          thinkingBlockIndex = event.index;
          timer.markThinkingStart();
        }
        if (
          event.type === 'content_block_stop' &&
          thinkingBlockIndex !== null &&
          event.index === thinkingBlockIndex
        ) {
          timer.markThinkingEnd();
          thinkingBlockIndex = null;
        }

        // Capture the message from message_start for usage data
        if (event.type === 'message_start') {
          finalMessage = event.message;
        }

        // Capture final usage from message_delta
        if (event.type === 'message_delta' && finalMessage) {
          finalMessage.stop_reason = event.delta.stop_reason;
          finalMessage.usage.output_tokens = event.usage.output_tokens;
        }

        yield event;
      }

      // Stream completed successfully
      if (finalMessage) {
        timer.stop();
        const record = finalizeRecord(base, finalMessage, timer.getMetrics(), config);
        onRecord(record);
      }
    } catch (err) {
      const record = buildErrorRecord(base, err, timer, config);
      onRecord(record);
      throw err;
    }
  };

  // Preserve the stream's other properties (controller, tee, etc.)
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

function wrapStream(
  original: Anthropic['messages']['stream'],
  config: WrapperConfig,
  onRecord: RecordHandler,
): Anthropic['messages']['stream'] {
  return function wrappedStream(
    this: Anthropic['messages'],
    body: MessageCreateParamsBase,
    options?: RequestOptions,
  ): MessageStream {
    const base = buildBaseRecord(body, config);
    base.requestMethod = 'messages.stream';
    base.streaming = true;
    const timer = new RequestTimer();
    timer.start();

    const messageStream = original.call(this, body, options);

    messageStream.on('text', () => {
      timer.markFirstToken();
    });

    messageStream.once('finalMessage', (message: Message) => {
      timer.stop();
      const record = finalizeRecord(base, message, timer.getMetrics(), config);
      onRecord(record);
      (messageStream as unknown as EventEmitter).removeAllListeners();
    });

    messageStream.once('error', (err: Error) => {
      const record = buildErrorRecord(base, err, timer, config);
      onRecord(record);
      (messageStream as unknown as EventEmitter).removeAllListeners();
    });

    return messageStream;
  } as Anthropic['messages']['stream'];
}

export function wrapAnthropicClient(
  client: Anthropic,
  config: WrapperConfig,
  onRecord: RecordHandler,
): Anthropic {
  if (!config.enabled) return client;

  const originalCreate = client.messages.create.bind(client.messages);
  const originalStream = client.messages.stream.bind(client.messages);

  client.messages.create = wrapCreate(originalCreate, config, onRecord);
  client.messages.stream = wrapStream(originalStream, config, onRecord);

  return client;
}
