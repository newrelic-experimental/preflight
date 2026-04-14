import { wrapAnthropicClient } from './anthropic.js';
import type { AiRequestRecord, WrapperConfig, RecordHandler } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers to build mock Anthropic SDK objects
// ---------------------------------------------------------------------------

function makeMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg_test123',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-20250514',
    content: [{ type: 'text', text: 'Hello from Claude' }],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
    },
    ...overrides,
  };
}

function makeCreateParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Hello' }],
    ...overrides,
  };
}

function makeConfig(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    enabled: true,
    recordContent: true,
    highSecurity: false,
    contentMaxLength: 4096,
    ...overrides,
  };
}

function makeRecorder(): { records: AiRequestRecord[]; handler: RecordHandler } {
  const records: AiRequestRecord[] = [];
  return { records, handler: (r) => records.push(r) };
}

/**
 * Build a mock async iterator that yields RawMessageStreamEvent-like objects.
 * Simulates the stream returned by `messages.create({ stream: true })`.
 */
function makeRawStreamEvents(): Record<string, unknown>[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_stream1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-20250514',
        content: [],
        stop_reason: null,
        usage: { input_tokens: 100, output_tokens: 0 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' from' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' Claude' } },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: ' streaming' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: '!' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 60 },
    },
    { type: 'message_stop' },
  ];
}

function makeMockRawStream(events: Record<string, unknown>[]) {
  const stream = {
    [Symbol.asyncIterator]: async function* () {
      for (const event of events) {
        yield event;
      }
    },
    controller: { abort: jest.fn() },
  };
  return stream;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeMockClient(overrides: Record<string, unknown> = {}): any {
  return {
    messages: {
      create: jest.fn(),
      stream: jest.fn(),
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('wrapAnthropicClient', () => {
  describe('enabled=false', () => {
    it('returns the original client unmodified', () => {
      const client = makeMockClient();
      const config = makeConfig({ enabled: false });
      const { handler } = makeRecorder();

      const result = wrapAnthropicClient(client, config, handler);

      expect(result).toBe(client);
    });
  });

  describe('messages.create() — non-streaming', () => {
    it('captures all fields in the AiRequestRecord', async () => {
      const message = makeMessage();
      const client = makeMockClient();
      client.messages.create.mockResolvedValue(message);

      const config = makeConfig({ recordContent: true });
      const { records, handler } = makeRecorder();

      wrapAnthropicClient(client, config, handler);

      const params = makeCreateParams({
        system: 'You are a helpful assistant.',
        temperature: 0.7,
        top_p: 0.9,
        top_k: 40,
        tools: [
          { name: 'calculator', description: 'math', input_schema: {} },
          { name: 'search', description: 'search', input_schema: {} },
        ],
      });

      const result = await client.messages.create(params);

      expect(result).toBe(message);
      expect(records).toHaveLength(1);

      const record = records[0];
      // Identity
      expect(record.id).toBeDefined();
      expect(record.timestamp).toBeGreaterThan(0);
      expect(record.provider).toBe('anthropic');
      expect(record.model).toBe('claude-sonnet-4-20250514');
      expect(record.requestModel).toBe('claude-sonnet-4-20250514');
      expect(record.requestMethod).toBe('messages.create');
      expect(record.streaming).toBe(false);

      // Request params
      expect(record.maxTokens).toBe(1024);
      expect(record.temperature).toBe(0.7);
      expect(record.topP).toBe(0.9);
      expect(record.topK).toBe(40);
      expect(record.messageCount).toBe(1);
      expect(record.toolCount).toBe(2);
      expect(record.toolNames).toEqual(['calculator', 'search']);
      expect(record.thinkingEnabled).toBe(false);
      expect(record.thinkingBudgetTokens).toBeNull();
      expect(record.systemPromptLength).toBe('You are a helpful assistant.'.length);

      // Response data
      expect(record.durationMs).toBeGreaterThan(0);
      expect(record.timeToFirstTokenMs).toBeNull(); // non-streaming
      expect(record.inputTokens).toBe(100);
      expect(record.outputTokens).toBe(50);
      expect(record.cacheReadTokens).toBe(10);
      expect(record.cacheCreationTokens).toBe(5);
      expect(record.totalTokens).toBe(150); // 100 + 50 + 0 thinking
      expect(record.stopReason).toBe('end_turn');
      expect(record.contentBlockTypes).toEqual(['text']);

      // Content capture
      expect(record.systemPrompt).toBe('You are a helpful assistant.');
      expect(record.lastUserMessage).toBe('Hello');
      expect(record.responseText).toBe('Hello from Claude');

      // No error
      expect(record.error).toBeNull();
    });

    it('handles array-style system prompt', async () => {
      const message = makeMessage();
      const client = makeMockClient();
      client.messages.create.mockResolvedValue(message);

      const config = makeConfig({ recordContent: true });
      const { records, handler } = makeRecorder();
      wrapAnthropicClient(client, config, handler);

      await client.messages.create(
        makeCreateParams({
          system: [
            { type: 'text', text: 'Part one.' },
            { type: 'text', text: 'Part two.' },
          ],
        }),
      );

      expect(records[0].systemPromptLength).toBe('Part one.'.length + 'Part two.'.length);
      expect(records[0].systemPrompt).toBe('Part one.\nPart two.');
    });

    it('handles multipart user message content', async () => {
      const message = makeMessage();
      const client = makeMockClient();
      client.messages.create.mockResolvedValue(message);

      const config = makeConfig({ recordContent: true });
      const { records, handler } = makeRecorder();
      wrapAnthropicClient(client, config, handler);

      await client.messages.create(
        makeCreateParams({
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'First part' },
                { type: 'text', text: 'Second part' },
              ],
            },
          ],
        }),
      );

      expect(records[0].lastUserMessage).toBe('First part\nSecond part');
    });

    it('captures thinking config when enabled', async () => {
      const message = makeMessage();
      const client = makeMockClient();
      client.messages.create.mockResolvedValue(message);

      const config = makeConfig();
      const { records, handler } = makeRecorder();
      wrapAnthropicClient(client, config, handler);

      await client.messages.create(
        makeCreateParams({
          thinking: { type: 'enabled', budget_tokens: 10000 },
        }),
      );

      expect(records[0].thinkingEnabled).toBe(true);
      expect(records[0].thinkingBudgetTokens).toBe(10000);
    });

    it('truncates content to contentMaxLength', async () => {
      const longText = 'a'.repeat(200);
      const message = makeMessage({
        content: [{ type: 'text', text: longText }],
      });
      const client = makeMockClient();
      client.messages.create.mockResolvedValue(message);

      const config = makeConfig({ recordContent: true, contentMaxLength: 50 });
      const { records, handler } = makeRecorder();
      wrapAnthropicClient(client, config, handler);

      await client.messages.create(
        makeCreateParams({
          system: longText,
          messages: [{ role: 'user', content: longText }],
        }),
      );

      expect(records[0].systemPrompt!.length).toBe(50);
      expect(records[0].lastUserMessage!.length).toBe(50);
      expect(records[0].responseText!.length).toBe(50);
    });

    it('handles null/missing optional params gracefully', async () => {
      const message = makeMessage();
      const client = makeMockClient();
      client.messages.create.mockResolvedValue(message);

      const config = makeConfig({ recordContent: true });
      const { records, handler } = makeRecorder();
      wrapAnthropicClient(client, config, handler);

      // No system, no tools, no temperature, no thinking
      await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hi' }],
      });

      const record = records[0];
      expect(record.systemPromptLength).toBeNull();
      expect(record.systemPrompt).toBeNull();
      expect(record.toolCount).toBe(0);
      expect(record.toolNames).toEqual([]);
      expect(record.temperature).toBeNull();
      expect(record.topP).toBeNull();
      expect(record.topK).toBeNull();
      expect(record.thinkingEnabled).toBe(false);
    });
  });

  describe('messages.create() — error handling', () => {
    it('propagates errors and captures error record', async () => {
      const apiError = Object.assign(new Error('rate limit exceeded'), {
        status: 429,
        error: { type: 'rate_limit_error' },
      });
      const client = makeMockClient();
      client.messages.create.mockRejectedValue(apiError);

      const config = makeConfig();
      const { records, handler } = makeRecorder();
      wrapAnthropicClient(client, config, handler);

      await expect(client.messages.create(makeCreateParams())).rejects.toThrow(
        'rate limit exceeded',
      );

      expect(records).toHaveLength(1);
      const record = records[0];
      expect(record.error).not.toBeNull();
      expect(record.error!.type).toBe('rate_limit_error');
      expect(record.error!.message).toBe('rate limit exceeded');
      expect(record.error!.statusCode).toBe(429);
      expect(record.durationMs).toBeGreaterThan(0);
      expect(record.inputTokens).toBe(0);
      expect(record.outputTokens).toBe(0);
    });

    it('handles generic Error without SDK error shape', async () => {
      const genericError = new TypeError('network failure');
      const client = makeMockClient();
      client.messages.create.mockRejectedValue(genericError);

      const config = makeConfig();
      const { records, handler } = makeRecorder();
      wrapAnthropicClient(client, config, handler);

      await expect(client.messages.create(makeCreateParams())).rejects.toThrow('network failure');

      expect(records[0].error!.type).toBe('TypeError');
      expect(records[0].error!.statusCode).toBeNull();
    });
  });

  describe('messages.create({ stream: true }) — raw stream', () => {
    it('yields all chunks unmodified and captures TTFT and usage', async () => {
      const events = makeRawStreamEvents();
      const rawStream = makeMockRawStream(events);
      const client = makeMockClient();
      client.messages.create.mockResolvedValue(rawStream);

      const config = makeConfig();
      const { records, handler } = makeRecorder();
      wrapAnthropicClient(client, config, handler);

      const stream = await client.messages.create(makeCreateParams({ stream: true }));

      // Collect all yielded events
      const collected: unknown[] = [];
      for await (const event of stream) {
        collected.push(event);
      }

      // All original events re-yielded
      expect(collected).toHaveLength(events.length);
      for (let i = 0; i < events.length; i++) {
        expect(collected[i]).toBe(events[i]);
      }

      // Record was produced
      expect(records).toHaveLength(1);
      const record = records[0];
      expect(record.streaming).toBe(true);
      expect(record.requestMethod).toBe('messages.create');
      expect(record.timeToFirstTokenMs).toBeGreaterThan(0);
      expect(record.outputTokens).toBe(60); // from message_delta usage
      expect(record.inputTokens).toBe(100); // from message_start
      expect(record.stopReason).toBe('end_turn');
    });

    it('captures error during stream iteration', async () => {
      const errorEvents = [
        {
          type: 'message_start',
          message: {
            id: 'msg_err',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-4-20250514',
            content: [],
            stop_reason: null,
            usage: { input_tokens: 50, output_tokens: 0 },
          },
        },
      ];

      const streamError = new Error('stream interrupted');
      const errorStream = {
        [Symbol.asyncIterator]: async function* () {
          for (const event of errorEvents) {
            yield event;
          }
          throw streamError;
        },
        controller: { abort: jest.fn() },
      };

      const client = makeMockClient();
      client.messages.create.mockResolvedValue(errorStream);

      const config = makeConfig();
      const { records, handler } = makeRecorder();
      wrapAnthropicClient(client, config, handler);

      const stream = await client.messages.create(makeCreateParams({ stream: true }));

      const collected: unknown[] = [];
      await expect(async () => {
        for await (const event of stream) {
          collected.push(event);
        }
      }).rejects.toThrow('stream interrupted');

      // The message_start was yielded before error
      expect(collected).toHaveLength(1);

      // Error record was captured
      expect(records).toHaveLength(1);
      expect(records[0].error).not.toBeNull();
      expect(records[0].error!.message).toBe('stream interrupted');
    });

    it('detects thinking phase from stream events', async () => {
      const thinkingEvents: Record<string, unknown>[] = [
        {
          type: 'message_start',
          message: {
            id: 'msg_think1',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-4-20250514',
            content: [],
            stop_reason: null,
            usage: { input_tokens: 100, output_tokens: 0 },
          },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'Let me think...' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'text', text: '' },
        },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Answer' } },
        { type: 'content_block_stop', index: 1 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 40 },
        },
        { type: 'message_stop' },
      ];

      const rawStream = makeMockRawStream(thinkingEvents);
      const client = makeMockClient();
      client.messages.create.mockResolvedValue(rawStream);

      const config = makeConfig();
      const { records, handler } = makeRecorder();
      wrapAnthropicClient(client, config, handler);

      const stream = await client.messages.create(makeCreateParams({ stream: true }));
      const collected: unknown[] = [];
      for await (const event of stream) {
        collected.push(event);
      }

      expect(collected).toHaveLength(thinkingEvents.length);
      expect(records).toHaveLength(1);
      const record = records[0];
      expect(record.streaming).toBe(true);
      // TTFT should be measured from the text_delta, not the thinking_delta
      expect(record.timeToFirstTokenMs).toBeGreaterThan(0);
      expect(record.durationMs).toBeGreaterThan(0);
    });

    it('preserves non-iterator properties on the stream proxy', async () => {
      const events = makeRawStreamEvents();
      const rawStream = makeMockRawStream(events);
      const client = makeMockClient();
      client.messages.create.mockResolvedValue(rawStream);

      const config = makeConfig();
      const { handler } = makeRecorder();
      wrapAnthropicClient(client, config, handler);

      const stream = await client.messages.create(makeCreateParams({ stream: true }));

      // The controller property should still be accessible
      expect(stream.controller).toBeDefined();
      expect(stream.controller.abort).toBeDefined();
    });
  });

  describe('messages.stream() — MessageStream', () => {
    it('measures TTFT and captures record on finalMessage', () => {
      const finalMsg = makeMessage();
      const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};

      const mockMessageStream = {
        on(event: string, cb: (...args: unknown[]) => void) {
          if (!listeners[event]) listeners[event] = [];
          listeners[event].push(cb);
          return mockMessageStream;
        },
      };

      const client = makeMockClient();
      client.messages.stream.mockReturnValue(mockMessageStream);

      const config = makeConfig();
      const { records, handler } = makeRecorder();
      wrapAnthropicClient(client, config, handler);

      const stream = client.messages.stream(makeCreateParams());
      expect(stream).toBe(mockMessageStream);

      // Simulate text event for TTFT
      expect(listeners['text']).toBeDefined();
      listeners['text'][0]('Hello');

      // Simulate finalMessage
      expect(listeners['finalMessage']).toBeDefined();
      listeners['finalMessage'][0](finalMsg);

      expect(records).toHaveLength(1);
      const record = records[0];
      expect(record.streaming).toBe(true);
      expect(record.requestMethod).toBe('messages.stream');
      expect(record.timeToFirstTokenMs).toBeGreaterThan(0);
      expect(record.model).toBe('claude-sonnet-4-20250514');
      expect(record.inputTokens).toBe(100);
      expect(record.outputTokens).toBe(50);
    });

    it('captures error record on stream error', () => {
      const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};

      const mockMessageStream = {
        on(event: string, cb: (...args: unknown[]) => void) {
          if (!listeners[event]) listeners[event] = [];
          listeners[event].push(cb);
          return mockMessageStream;
        },
      };

      const client = makeMockClient();
      client.messages.stream.mockReturnValue(mockMessageStream);

      const config = makeConfig();
      const { records, handler } = makeRecorder();
      wrapAnthropicClient(client, config, handler);

      client.messages.stream(makeCreateParams());

      // Simulate error event
      const err = new Error('connection reset');
      listeners['error'][0](err);

      expect(records).toHaveLength(1);
      expect(records[0].error).not.toBeNull();
      expect(records[0].error!.message).toBe('connection reset');
    });

    it('only records TTFT from the first text event', () => {
      const finalMsg = makeMessage();
      const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};

      const mockMessageStream = {
        on(event: string, cb: (...args: unknown[]) => void) {
          if (!listeners[event]) listeners[event] = [];
          listeners[event].push(cb);
          return mockMessageStream;
        },
      };

      const client = makeMockClient();
      client.messages.stream.mockReturnValue(mockMessageStream);

      const config = makeConfig();
      const { records, handler } = makeRecorder();
      wrapAnthropicClient(client, config, handler);

      client.messages.stream(makeCreateParams());

      // Fire text multiple times
      listeners['text'][0]('Hello');
      listeners['text'][0](' world');
      listeners['finalMessage'][0](finalMsg);

      const ttft = records[0].timeToFirstTokenMs;
      expect(ttft).toBeGreaterThan(0);
      // TTFT should be from first text event — we can't test exact equality
      // but we verify it was set (non-null)
      expect(ttft).not.toBeNull();
    });
  });

  describe('recordContent=false', () => {
    it('suppresses text but keeps all numeric metrics', async () => {
      const message = makeMessage();
      const client = makeMockClient();
      client.messages.create.mockResolvedValue(message);

      const config = makeConfig({ recordContent: false });
      const { records, handler } = makeRecorder();
      wrapAnthropicClient(client, config, handler);

      await client.messages.create(
        makeCreateParams({
          system: 'You are a helpful assistant.',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      );

      const record = records[0];
      // Content fields are null
      expect(record.systemPrompt).toBeNull();
      expect(record.lastUserMessage).toBeNull();
      expect(record.responseText).toBeNull();

      // But metrics are still captured
      expect(record.inputTokens).toBe(100);
      expect(record.outputTokens).toBe(50);
      expect(record.durationMs).toBeGreaterThan(0);
      expect(record.model).toBe('claude-sonnet-4-20250514');
      expect(record.systemPromptLength).toBeGreaterThan(0);
      expect(record.messageCount).toBe(1);
    });
  });

  describe('highSecurity=true', () => {
    it('content fields are always empty regardless of recordContent', async () => {
      const message = makeMessage();
      const client = makeMockClient();
      client.messages.create.mockResolvedValue(message);

      // Note: recordContent=true but highSecurity=true should override
      const config = makeConfig({ recordContent: true, highSecurity: true });
      const { records, handler } = makeRecorder();
      wrapAnthropicClient(client, config, handler);

      await client.messages.create(
        makeCreateParams({
          system: 'You are a helpful assistant.',
          messages: [{ role: 'user', content: 'Secret data' }],
        }),
      );

      const record = records[0];
      expect(record.systemPrompt).toBeNull();
      expect(record.lastUserMessage).toBeNull();
      expect(record.responseText).toBeNull();

      // Metrics still captured
      expect(record.inputTokens).toBe(100);
      expect(record.outputTokens).toBe(50);
    });
  });

  describe('multiple tool content block types', () => {
    it('captures distinct content block types', async () => {
      const message = makeMessage({
        content: [
          { type: 'text', text: 'Let me use a tool' },
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'calculator',
            input: { expression: '2+2' },
          },
        ],
      });
      const client = makeMockClient();
      client.messages.create.mockResolvedValue(message);

      const config = makeConfig();
      const { records, handler } = makeRecorder();
      wrapAnthropicClient(client, config, handler);

      await client.messages.create(makeCreateParams());

      expect(records[0].contentBlockTypes).toEqual(expect.arrayContaining(['text', 'tool_use']));
      expect(records[0].contentBlockTypes).toHaveLength(2);
    });
  });

  describe('response with no cache tokens', () => {
    it('defaults cache tokens to 0 when not present', async () => {
      const message = makeMessage({
        usage: { input_tokens: 80, output_tokens: 30 },
      });
      const client = makeMockClient();
      client.messages.create.mockResolvedValue(message);

      const config = makeConfig();
      const { records, handler } = makeRecorder();
      wrapAnthropicClient(client, config, handler);

      await client.messages.create(makeCreateParams());

      expect(records[0].cacheReadTokens).toBe(0);
      expect(records[0].cacheCreationTokens).toBe(0);
      expect(records[0].totalTokens).toBe(110); // 80 + 30
    });
  });
});
