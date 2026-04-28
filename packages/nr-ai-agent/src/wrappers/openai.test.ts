import { wrapOpenAiClient } from './openai.js';
import type { AiRequestRecord, WrapperConfig, RecordHandler } from '../types.js';
import type OpenAI from 'openai';

interface MockCompletions {
  create: jest.Mock;
}

interface MockOpenAIClient {
  chat: {
    completions: MockCompletions;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCompletion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'chatcmpl-test123',
    object: 'chat.completion',
    created: 1700000000,
    model: 'gpt-4o',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'Hello from GPT' },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    },
    ...overrides,
  };
}

function makeCreateParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Hello' }],
    max_tokens: 1024,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    enabled: true,
    recordContent: true,
    highSecurity: false,
    contentMaxLength: 4096,
    redactionPatterns: [],
    ...overrides,
  };
}

function makeRecorder(): { records: AiRequestRecord[]; handler: RecordHandler } {
  const records: AiRequestRecord[] = [];
  return { records, handler: (r) => records.push(r) };
}

function makeChunks(includeUsage = true): Record<string, unknown>[] {
  const chunks: Record<string, unknown>[] = [
    {
      id: 'chatcmpl-stream1',
      object: 'chat.completion.chunk',
      created: 1700000000,
      model: 'gpt-4o',
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    },
    {
      id: 'chatcmpl-stream1',
      object: 'chat.completion.chunk',
      created: 1700000000,
      model: 'gpt-4o',
      choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
    },
    {
      id: 'chatcmpl-stream1',
      object: 'chat.completion.chunk',
      created: 1700000000,
      model: 'gpt-4o',
      choices: [{ index: 0, delta: { content: ' from GPT' }, finish_reason: null }],
    },
    {
      id: 'chatcmpl-stream1',
      object: 'chat.completion.chunk',
      created: 1700000000,
      model: 'gpt-4o',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    },
  ];

  if (includeUsage) {
    chunks.push({
      id: 'chatcmpl-stream1',
      object: 'chat.completion.chunk',
      created: 1700000000,
      model: 'gpt-4o',
      choices: [],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    });
  }

  return chunks;
}

function makeMockStream(chunks: Record<string, unknown>[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
    controller: { abort: jest.fn() },
  };
}

function makeMockClient(
  overrides: Partial<MockCompletions> = {},
): MockOpenAIClient {
  return {
    chat: {
      completions: {
        create: jest.fn(),
        ...overrides,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('wrapOpenAiClient', () => {
  describe('enabled=false', () => {
    it('returns the original client unmodified', () => {
      const client = makeMockClient();
      const config = makeConfig({ enabled: false });
      const { handler } = makeRecorder();

      const result = wrapOpenAiClient(client as unknown as OpenAI, config, handler);

      expect(result).toBe(client);
    });
  });

  describe('chat.completions.create() — non-streaming', () => {
    it('captures all fields in the AiRequestRecord', async () => {
      const completion = makeCompletion();
      const client = makeMockClient();
      client.chat.completions.create.mockResolvedValue(completion);

      const config = makeConfig({ recordContent: true });
      const { records, handler } = makeRecorder();

      wrapOpenAiClient(client as unknown as OpenAI, config, handler);

      const params = makeCreateParams({
        system: 'ignored — use system message instead',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Hello' },
        ],
        temperature: 0.7,
        top_p: 0.9,
        tools: [
          { type: 'function', function: { name: 'calculator', description: 'math', parameters: {} } },
          { type: 'function', function: { name: 'search', description: 'search', parameters: {} } },
        ],
      });

      const result = await client.chat.completions.create(params);

      expect(result).toBe(completion);
      expect(records).toHaveLength(1);

      const record = records[0];
      expect(record.provider).toBe('openai');
      expect(record.model).toBe('gpt-4o');
      expect(record.requestModel).toBe('gpt-4o');
      expect(record.requestMethod).toBe('chat.completions.create');
      expect(record.streaming).toBe(false);

      expect(record.maxTokens).toBe(1024);
      expect(record.temperature).toBe(0.7);
      expect(record.topP).toBe(0.9);
      expect(record.topK).toBeNull();
      expect(record.messageCount).toBe(2);
      expect(record.toolCount).toBe(2);
      expect(record.toolNames).toEqual(['calculator', 'search']);
      expect(record.thinkingEnabled).toBe(false);
      expect(record.thinkingBudgetTokens).toBeNull();
      expect(record.systemPromptLength).toBe('You are a helpful assistant.'.length);

      expect(record.durationMs).toBeGreaterThan(0);
      expect(record.timeToFirstTokenMs).toBeNull();
      expect(record.inputTokens).toBe(100);
      expect(record.outputTokens).toBe(50);
      expect(record.totalTokens).toBe(150);
      expect(record.cacheReadTokens).toBe(0);
      expect(record.cacheCreationTokens).toBe(0);
      expect(record.stopReason).toBe('stop');
      expect(record.contentBlockTypes).toEqual(['text']);

      expect(record.systemPrompt).toBe('You are a helpful assistant.');
      expect(record.lastUserMessage).toBe('Hello');
      expect(record.responseText).toBe('Hello from GPT');

      expect(record.error).toBeNull();
    });

    it('extracts system prompt and last user message from messages array', async () => {
      const completion = makeCompletion();
      const client = makeMockClient();
      client.chat.completions.create.mockResolvedValue(completion);

      const { records, handler } = makeRecorder();
      wrapOpenAiClient(client as unknown as OpenAI, makeConfig(), handler);

      await client.chat.completions.create(
        makeCreateParams({
          messages: [
            { role: 'system', content: 'Be concise.' },
            { role: 'user', content: 'First question' },
            { role: 'assistant', content: 'Answer one.' },
            { role: 'user', content: 'Second question' },
          ],
        }),
      );

      expect(records[0].systemPromptLength).toBe('Be concise.'.length);
      expect(records[0].systemPrompt).toBe('Be concise.');
      expect(records[0].lastUserMessage).toBe('Second question');
    });

    it('handles multipart user message content', async () => {
      const completion = makeCompletion();
      const client = makeMockClient();
      client.chat.completions.create.mockResolvedValue(completion);

      const { records, handler } = makeRecorder();
      wrapOpenAiClient(client as unknown as OpenAI, makeConfig(), handler);

      await client.chat.completions.create(
        makeCreateParams({
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Part one' },
                { type: 'text', text: 'Part two' },
              ],
            },
          ],
        }),
      );

      expect(records[0].lastUserMessage).toBe('Part one\nPart two');
    });

    it('handles null response content (tool-call-only response)', async () => {
      const completion = makeCompletion({
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      });
      const client = makeMockClient();
      client.chat.completions.create.mockResolvedValue(completion);

      const { records, handler } = makeRecorder();
      wrapOpenAiClient(client as unknown as OpenAI, makeConfig(), handler);

      await client.chat.completions.create(makeCreateParams());

      expect(records[0].contentBlockTypes).toEqual(['tool_use']);
      expect(records[0].responseText).toBeNull();
      expect(records[0].stopReason).toBe('tool_calls');
    });

    it('captures reasoning tokens for o1 models', async () => {
      const completion = makeCompletion({
        model: 'o1',
        usage: {
          prompt_tokens: 200,
          completion_tokens: 500,
          total_tokens: 700,
          completion_tokens_details: { reasoning_tokens: 400 },
        },
      });
      const client = makeMockClient();
      client.chat.completions.create.mockResolvedValue(completion);

      const { records, handler } = makeRecorder();
      wrapOpenAiClient(client as unknown as OpenAI, makeConfig(), handler);

      await client.chat.completions.create(makeCreateParams({ model: 'o1' }));

      expect(records[0].thinkingTokens).toBe(400);
      expect(records[0].inputTokens).toBe(200);
      expect(records[0].outputTokens).toBe(500);
    });

    it('handles missing optional params gracefully', async () => {
      const completion = makeCompletion();
      const client = makeMockClient();
      client.chat.completions.create.mockResolvedValue(completion);

      const { records, handler } = makeRecorder();
      wrapOpenAiClient(client as unknown as OpenAI, makeConfig(), handler);

      await client.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hi' }],
      });

      const record = records[0];
      expect(record.maxTokens).toBeNull();
      expect(record.temperature).toBeNull();
      expect(record.topP).toBeNull();
      expect(record.topK).toBeNull();
      expect(record.toolCount).toBe(0);
      expect(record.toolNames).toEqual([]);
      expect(record.systemPromptLength).toBeNull();
    });

    it('truncates content to contentMaxLength', async () => {
      const longText = 'a'.repeat(200);
      const completion = makeCompletion({
        choices: [{ index: 0, message: { role: 'assistant', content: longText }, finish_reason: 'stop' }],
      });
      const client = makeMockClient();
      client.chat.completions.create.mockResolvedValue(completion);

      const config = makeConfig({ recordContent: true, contentMaxLength: 50 });
      const { records, handler } = makeRecorder();
      wrapOpenAiClient(client as unknown as OpenAI, config, handler);

      await client.chat.completions.create(
        makeCreateParams({
          messages: [
            { role: 'system', content: longText },
            { role: 'user', content: longText },
          ],
        }),
      );

      expect(records[0].systemPrompt!.length).toBe(50);
      expect(records[0].lastUserMessage!.length).toBe(50);
      expect(records[0].responseText!.length).toBe(50);
    });
  });

  describe('chat.completions.create() — error handling', () => {
    it('propagates errors and captures error record', async () => {
      const apiError = Object.assign(new Error('rate limit exceeded'), {
        status: 429,
        error: { type: 'rate_limit_error' },
      });
      const client = makeMockClient();
      client.chat.completions.create.mockRejectedValue(apiError);

      const { records, handler } = makeRecorder();
      wrapOpenAiClient(client as unknown as OpenAI, makeConfig(), handler);

      await expect(client.chat.completions.create(makeCreateParams())).rejects.toThrow(
        'rate limit exceeded',
      );

      expect(records).toHaveLength(1);
      const record = records[0];
      expect(record.error).not.toBeNull();
      expect(record.error!.type).toBe('rate_limit_error');
      expect(record.error!.message).toBe('rate limit exceeded');
      expect(record.error!.statusCode).toBe(429);
      expect(record.inputTokens).toBe(0);
      expect(record.outputTokens).toBe(0);
    });

    it('handles generic Error without SDK error shape', async () => {
      const genericError = new TypeError('network failure');
      const client = makeMockClient();
      client.chat.completions.create.mockRejectedValue(genericError);

      const { records, handler } = makeRecorder();
      wrapOpenAiClient(client as unknown as OpenAI, makeConfig(), handler);

      await expect(client.chat.completions.create(makeCreateParams())).rejects.toThrow(
        'network failure',
      );

      expect(records[0].error!.type).toBe('TypeError');
      expect(records[0].error!.statusCode).toBeNull();
    });

    it('redacts secret patterns from error messages', async () => {
      const apiError = new Error('auth failed: Bearer sk-secret12345 was rejected');
      const client = makeMockClient();
      client.chat.completions.create.mockRejectedValue(apiError);

      const config = makeConfig({ redactionPatterns: [/Bearer\s+\S+/g] });
      const { records, handler } = makeRecorder();
      wrapOpenAiClient(client as unknown as OpenAI, config, handler);

      await expect(client.chat.completions.create(makeCreateParams())).rejects.toThrow();

      expect(records[0].error!.message).toBe('auth failed: [REDACTED] was rejected');
    });
  });

  describe('chat.completions.create({ stream: true })', () => {
    it('yields all chunks unmodified and captures usage and TTFT', async () => {
      const chunks = makeChunks();
      const mockStream = makeMockStream(chunks);
      const client = makeMockClient();
      client.chat.completions.create.mockResolvedValue(mockStream);

      const { records, handler } = makeRecorder();
      wrapOpenAiClient(client as unknown as OpenAI, makeConfig(), handler);

      const stream = await client.chat.completions.create(
        makeCreateParams({ stream: true }),
      );

      const collected: unknown[] = [];
      for await (const chunk of stream) {
        collected.push(chunk);
      }

      expect(collected).toHaveLength(chunks.length);
      for (let i = 0; i < chunks.length; i++) {
        expect(collected[i]).toBe(chunks[i]);
      }

      expect(records).toHaveLength(1);
      const record = records[0];
      expect(record.streaming).toBe(true);
      expect(record.requestMethod).toBe('chat.completions.create');
      expect(record.provider).toBe('openai');
      expect(record.timeToFirstTokenMs).toBeGreaterThan(0);
      expect(record.inputTokens).toBe(100);
      expect(record.outputTokens).toBe(50);
      expect(record.totalTokens).toBe(150);
      expect(record.stopReason).toBe('stop');
      expect(record.contentBlockTypes).toEqual(['text']);
      expect(record.responseText).toBe('Hello from GPT');
    });

    it('injects stream_options.include_usage into the request', async () => {
      const chunks = makeChunks();
      const mockStream = makeMockStream(chunks);
      const client = makeMockClient();
      client.chat.completions.create.mockResolvedValue(mockStream);

      const originalMock = client.chat.completions.create;
      wrapOpenAiClient(client as unknown as OpenAI, makeConfig(), makeRecorder().handler);

      const stream = await client.chat.completions.create(makeCreateParams({ stream: true }));
      for await (const _ of stream) {
        // drain
      }

      const callArgs = originalMock.mock.calls[0][0] as Record<string, unknown>;
      expect(callArgs.stream_options).toEqual({ include_usage: true });
    });

    it('captures error during stream iteration', async () => {
      const errorStream = {
        [Symbol.asyncIterator]: async function* () {
          yield {
            id: 'chatcmpl-err',
            object: 'chat.completion.chunk',
            model: 'gpt-4o',
            choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }],
          };
          throw new Error('stream interrupted');
        },
        controller: { abort: jest.fn() },
      };

      const client = makeMockClient();
      client.chat.completions.create.mockResolvedValue(errorStream);

      const { records, handler } = makeRecorder();
      wrapOpenAiClient(client as unknown as OpenAI, makeConfig(), handler);

      const stream = await client.chat.completions.create(makeCreateParams({ stream: true }));

      const collected: unknown[] = [];
      await expect(async () => {
        for await (const chunk of stream) {
          collected.push(chunk);
        }
      }).rejects.toThrow('stream interrupted');

      expect(collected).toHaveLength(1);
      expect(records).toHaveLength(1);
      expect(records[0].error).not.toBeNull();
      expect(records[0].error!.message).toBe('stream interrupted');
    });

    it('handles streaming without usage chunk gracefully', async () => {
      const chunks = makeChunks(false);
      const mockStream = makeMockStream(chunks);
      const client = makeMockClient();
      client.chat.completions.create.mockResolvedValue(mockStream);

      const { records, handler } = makeRecorder();
      wrapOpenAiClient(client as unknown as OpenAI, makeConfig(), handler);

      const stream = await client.chat.completions.create(makeCreateParams({ stream: true }));
      for await (const _ of stream) {
        // drain
      }

      expect(records).toHaveLength(1);
      expect(records[0].inputTokens).toBe(0);
      expect(records[0].outputTokens).toBe(0);
      expect(records[0].error).toBeNull();
    });

    it('preserves non-iterator properties on the stream proxy', async () => {
      const chunks = makeChunks();
      const mockStream = makeMockStream(chunks);
      const client = makeMockClient();
      client.chat.completions.create.mockResolvedValue(mockStream);

      wrapOpenAiClient(client as unknown as OpenAI, makeConfig(), makeRecorder().handler);

      const stream = await client.chat.completions.create(makeCreateParams({ stream: true }));
      expect((stream as unknown as typeof mockStream).controller).toBeDefined();
    });
  });

  describe('recordContent=false', () => {
    it('suppresses text but keeps all numeric metrics', async () => {
      const completion = makeCompletion();
      const client = makeMockClient();
      client.chat.completions.create.mockResolvedValue(completion);

      const config = makeConfig({ recordContent: false });
      const { records, handler } = makeRecorder();
      wrapOpenAiClient(client as unknown as OpenAI, config, handler);

      await client.chat.completions.create(
        makeCreateParams({
          messages: [
            { role: 'system', content: 'Be concise.' },
            { role: 'user', content: 'Hello' },
          ],
        }),
      );

      const record = records[0];
      expect(record.systemPrompt).toBeNull();
      expect(record.lastUserMessage).toBeNull();
      expect(record.responseText).toBeNull();

      expect(record.inputTokens).toBe(100);
      expect(record.outputTokens).toBe(50);
      expect(record.durationMs).toBeGreaterThan(0);
      expect(record.systemPromptLength).toBeGreaterThan(0);
    });
  });

  describe('highSecurity=true', () => {
    it('content fields are empty regardless of recordContent', async () => {
      const completion = makeCompletion();
      const client = makeMockClient();
      client.chat.completions.create.mockResolvedValue(completion);

      const config = makeConfig({ recordContent: true, highSecurity: true });
      const { records, handler } = makeRecorder();
      wrapOpenAiClient(client as unknown as OpenAI, config, handler);

      await client.chat.completions.create(
        makeCreateParams({
          messages: [
            { role: 'system', content: 'Secret instructions.' },
            { role: 'user', content: 'Secret data' },
          ],
        }),
      );

      const record = records[0];
      expect(record.systemPrompt).toBeNull();
      expect(record.lastUserMessage).toBeNull();
      expect(record.responseText).toBeNull();
      expect(record.inputTokens).toBe(100);
    });
  });

  describe('tool name sanitization', () => {
    it('truncates tool names longer than 256 characters', async () => {
      const longName = 'a'.repeat(300);
      const completion = makeCompletion();
      const client = makeMockClient();
      client.chat.completions.create.mockResolvedValue(completion);

      const { records, handler } = makeRecorder();
      wrapOpenAiClient(client as unknown as OpenAI, makeConfig(), handler);

      await client.chat.completions.create(
        makeCreateParams({
          tools: [{ type: 'function', function: { name: longName, description: 'long', parameters: {} } }],
        }),
      );

      expect(records[0].toolNames[0]).toHaveLength(256);
    });

    it('strips control characters from tool names', async () => {
      const completion = makeCompletion();
      const client = makeMockClient();
      client.chat.completions.create.mockResolvedValue(completion);

      const { records, handler } = makeRecorder();
      wrapOpenAiClient(client as unknown as OpenAI, makeConfig(), handler);

      await client.chat.completions.create(
        makeCreateParams({
          tools: [{ type: 'function', function: { name: 'tool\x00with\nnewline', description: 'bad', parameters: {} } }],
        }),
      );

      expect(records[0].toolNames[0]).toBe('toolwithnewline');
    });
  });
});
