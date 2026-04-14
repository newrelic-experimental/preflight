import { wrapGeminiClient, extractSafetyRatings, extractGroundingInfo } from './gemini.js';
import type {
  AiRequestRecord,
  AiEmbeddingRecord,
  WrapperConfig,
  RecordHandler,
  EmbeddingRecordHandler,
} from '../types.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

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

function makeEmbeddingRecorder(): {
  records: AiEmbeddingRecord[];
  handler: EmbeddingRecordHandler;
} {
  const records: AiEmbeddingRecord[] = [];
  return { records, handler: (r) => records.push(r) };
}

function makeGenerateContentResponse(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [{ text: 'Hello from Gemini' }],
        },
        finishReason: 'STOP',
        safetyRatings: [
          { category: 'HARM_CATEGORY_HARASSMENT', probability: 'NEGLIGIBLE', blocked: false },
          { category: 'HARM_CATEGORY_HATE_SPEECH', probability: 'NEGLIGIBLE', blocked: false },
          {
            category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
            probability: 'NEGLIGIBLE',
            blocked: false,
          },
          {
            category: 'HARM_CATEGORY_DANGEROUS_CONTENT',
            probability: 'NEGLIGIBLE',
            blocked: false,
          },
        ],
      },
    ],
    usageMetadata: {
      promptTokenCount: 10,
      candidatesTokenCount: 20,
      totalTokenCount: 30,
    },
    get text() {
      const candidate = (this as Record<string, unknown>).candidates as Record<string, unknown>[];
      const content = candidate?.[0]?.content as Record<string, unknown>;
      const parts = content?.parts as Record<string, unknown>[];
      return parts?.[0]?.text as string;
    },
    ...overrides,
  };
}

function makeGenerateParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'gemini-2.0-flash',
    contents: 'Hello',
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeMockClient(overrides: Record<string, unknown> = {}): any {
  return {
    models: {
      generateContent: jest.fn(),
      generateContentStream: jest.fn(),
      embedContent: jest.fn(),
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('wrapGeminiClient', () => {
  describe('enabled=false', () => {
    it('returns the original client unmodified', () => {
      const client = makeMockClient();
      const config = makeConfig({ enabled: false });
      const { handler } = makeRecorder();
      const { handler: embHandler } = makeEmbeddingRecorder();

      const result = wrapGeminiClient(client, config, handler, embHandler);

      expect(result).toBe(client);
    });
  });

  describe('models.generateContent() — non-streaming', () => {
    it('captures all fields in the AiRequestRecord', async () => {
      const response = makeGenerateContentResponse();
      const client = makeMockClient();
      client.models.generateContent.mockResolvedValue(response);

      const config = makeConfig({ recordContent: true });
      const { records, handler } = makeRecorder();
      const { handler: embHandler } = makeEmbeddingRecorder();
      wrapGeminiClient(client, config, handler, embHandler);

      const params = makeGenerateParams({
        config: {
          temperature: 0.7,
          topP: 0.9,
          topK: 40,
          maxOutputTokens: 2048,
          systemInstruction: 'You are a helpful assistant.',
          tools: [
            {
              functionDeclarations: [
                { name: 'calculator', description: 'math' },
                { name: 'search', description: 'search the web' },
              ],
            },
          ],
        },
      });

      const result = await client.models.generateContent(params);
      expect(result).toBe(response);
      expect(records).toHaveLength(1);

      const record = records[0];
      // Identity
      expect(record.id).toBeDefined();
      expect(record.timestamp).toBeGreaterThan(0);
      expect(record.provider).toBe('google');
      expect(record.model).toBe('gemini-2.0-flash');
      expect(record.requestModel).toBe('gemini-2.0-flash');
      expect(record.requestMethod).toBe('models.generateContent');
      expect(record.streaming).toBe(false);

      // Request params
      expect(record.maxTokens).toBe(2048);
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
      expect(record.inputTokens).toBe(10);
      expect(record.outputTokens).toBe(20);
      expect(record.totalTokens).toBe(30);
      expect(record.stopReason).toBe('STOP');
      expect(record.contentBlockTypes).toEqual(['text']);

      // Content capture
      expect(record.systemPrompt).toBe('You are a helpful assistant.');
      expect(record.lastUserMessage).toBe('Hello');
      expect(record.responseText).toBe('Hello from Gemini');

      // No error
      expect(record.error).toBeNull();
    });

    it('handles Content[] style messages', async () => {
      const response = makeGenerateContentResponse();
      const client = makeMockClient();
      client.models.generateContent.mockResolvedValue(response);

      const config = makeConfig({ recordContent: true });
      const { records, handler } = makeRecorder();
      const { handler: embHandler } = makeEmbeddingRecorder();
      wrapGeminiClient(client, config, handler, embHandler);

      await client.models.generateContent(
        makeGenerateParams({
          contents: [
            { role: 'user', parts: [{ text: 'First message' }] },
            { role: 'model', parts: [{ text: 'Response' }] },
            { role: 'user', parts: [{ text: 'Second message' }] },
          ],
        }),
      );

      expect(records[0].messageCount).toBe(3);
      expect(records[0].lastUserMessage).toBe('Second message');
    });

    it('captures thinking config when enabled', async () => {
      const response = makeGenerateContentResponse({
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 20,
          thoughtsTokenCount: 500,
          totalTokenCount: 530,
        },
      });
      const client = makeMockClient();
      client.models.generateContent.mockResolvedValue(response);

      const config = makeConfig();
      const { records, handler } = makeRecorder();
      const { handler: embHandler } = makeEmbeddingRecorder();
      wrapGeminiClient(client, config, handler, embHandler);

      await client.models.generateContent(
        makeGenerateParams({
          config: { thinkingConfig: { thinkingBudget: 10000 } },
        }),
      );

      expect(records[0].thinkingEnabled).toBe(true);
      expect(records[0].thinkingBudgetTokens).toBe(10000);
      expect(records[0].thinkingTokens).toBe(500);
      expect(records[0].totalTokens).toBe(530);
    });

    it('handles null/missing optional params gracefully', async () => {
      const response = makeGenerateContentResponse();
      const client = makeMockClient();
      client.models.generateContent.mockResolvedValue(response);

      const config = makeConfig({ recordContent: true });
      const { records, handler } = makeRecorder();
      const { handler: embHandler } = makeEmbeddingRecorder();
      wrapGeminiClient(client, config, handler, embHandler);

      // No config at all
      await client.models.generateContent({ model: 'gemini-2.0-flash', contents: 'Hi' });

      const record = records[0];
      expect(record.systemPromptLength).toBeNull();
      expect(record.systemPrompt).toBeNull();
      expect(record.toolCount).toBe(0);
      expect(record.toolNames).toEqual([]);
      expect(record.temperature).toBeNull();
      expect(record.topP).toBeNull();
      expect(record.topK).toBeNull();
      expect(record.maxTokens).toBeNull();
      expect(record.thinkingEnabled).toBe(false);
    });

    it('truncates content to contentMaxLength', async () => {
      const longText = 'a'.repeat(200);
      const response = {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: longText }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 },
        get text() {
          return longText;
        },
      };
      const client = makeMockClient();
      client.models.generateContent.mockResolvedValue(response);

      const config = makeConfig({ recordContent: true, contentMaxLength: 50 });
      const { records, handler } = makeRecorder();
      const { handler: embHandler } = makeEmbeddingRecorder();
      wrapGeminiClient(client, config, handler, embHandler);

      await client.models.generateContent(
        makeGenerateParams({
          contents: longText,
          config: { systemInstruction: longText },
        }),
      );

      expect(records[0].systemPrompt!.length).toBe(50);
      expect(records[0].lastUserMessage!.length).toBe(50);
      expect(records[0].responseText!.length).toBe(50);
    });
  });

  describe('models.generateContent() — error handling', () => {
    it('propagates errors and captures error record', async () => {
      const apiError = Object.assign(new Error('quota exceeded'), {
        status: 429,
        error: { type: 'rate_limit_error' },
      });
      const client = makeMockClient();
      client.models.generateContent.mockRejectedValue(apiError);

      const config = makeConfig();
      const { records, handler } = makeRecorder();
      const { handler: embHandler } = makeEmbeddingRecorder();
      wrapGeminiClient(client, config, handler, embHandler);

      await expect(client.models.generateContent(makeGenerateParams())).rejects.toThrow(
        'quota exceeded',
      );

      expect(records).toHaveLength(1);
      const record = records[0];
      expect(record.error).not.toBeNull();
      expect(record.error!.type).toBe('rate_limit_error');
      expect(record.error!.message).toBe('quota exceeded');
      expect(record.error!.statusCode).toBe(429);
      expect(record.inputTokens).toBe(0);
      expect(record.outputTokens).toBe(0);
    });
  });

  describe('models.generateContentStream() — streaming', () => {
    it('re-yields all chunks, measures TTFT, and accumulates usage', async () => {
      const chunks = [
        {
          candidates: [
            { content: { role: 'model', parts: [{ text: 'Hello' }] }, finishReason: null },
          ],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
          get text() {
            return 'Hello';
          },
        },
        {
          candidates: [
            { content: { role: 'model', parts: [{ text: ' world' }] }, finishReason: null },
          ],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, totalTokenCount: 20 },
          get text() {
            return ' world';
          },
        },
        {
          candidates: [
            { content: { role: 'model', parts: [{ text: '!' }] }, finishReason: 'STOP' },
          ],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 15, totalTokenCount: 25 },
          get text() {
            return '!';
          },
        },
      ];

      async function* mockStream() {
        for (const chunk of chunks) {
          yield chunk;
        }
      }

      const client = makeMockClient();
      client.models.generateContentStream.mockResolvedValue(mockStream());

      const config = makeConfig();
      const { records, handler } = makeRecorder();
      const { handler: embHandler } = makeEmbeddingRecorder();
      wrapGeminiClient(client, config, handler, embHandler);

      const stream = await client.models.generateContentStream(makeGenerateParams());

      const collected: unknown[] = [];
      for await (const chunk of stream) {
        collected.push(chunk);
      }

      // All chunks re-yielded
      expect(collected).toHaveLength(3);
      expect(collected[0]).toBe(chunks[0]);
      expect(collected[1]).toBe(chunks[1]);
      expect(collected[2]).toBe(chunks[2]);

      // Record produced from last chunk's usage
      expect(records).toHaveLength(1);
      const record = records[0];
      expect(record.streaming).toBe(true);
      expect(record.requestMethod).toBe('models.generateContentStream');
      expect(record.timeToFirstTokenMs).toBeGreaterThan(0);
      expect(record.inputTokens).toBe(10);
      expect(record.outputTokens).toBe(15);
      expect(record.totalTokens).toBe(25);
      expect(record.stopReason).toBe('STOP');
    });

    it('detects thinking phase from thought parts in stream', async () => {
      const chunks = [
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: 'Let me think...', thought: true }],
              },
              finishReason: null,
            },
          ],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 0,
            thoughtsTokenCount: 50,
            totalTokenCount: 60,
          },
          get text() {
            return undefined;
          },
        },
        {
          candidates: [
            {
              content: { role: 'model', parts: [{ text: 'Here is the answer' }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 20,
            thoughtsTokenCount: 50,
            totalTokenCount: 80,
          },
          get text() {
            return 'Here is the answer';
          },
        },
      ];

      async function* mockStream() {
        for (const chunk of chunks) {
          yield chunk;
        }
      }

      const client = makeMockClient();
      client.models.generateContentStream.mockResolvedValue(mockStream());

      const config = makeConfig();
      const { records, handler } = makeRecorder();
      const { handler: embHandler } = makeEmbeddingRecorder();
      wrapGeminiClient(client, config, handler, embHandler);

      const stream = await client.models.generateContentStream(makeGenerateParams());
      const collected: unknown[] = [];
      for await (const chunk of stream) {
        collected.push(chunk);
      }

      expect(collected).toHaveLength(2);
      expect(records).toHaveLength(1);
      const record = records[0];
      expect(record.streaming).toBe(true);
      // TTFT should be measured from the non-thought text chunk
      expect(record.timeToFirstTokenMs).toBeGreaterThan(0);
      expect(record.durationMs).toBeGreaterThan(0);
      expect(record.thinkingTokens).toBe(50);
    });

    it('captures error during stream iteration', async () => {
      async function* errorStream() {
        yield {
          candidates: [
            { content: { role: 'model', parts: [{ text: 'partial' }] }, finishReason: null },
          ],
          usageMetadata: {},
          get text() {
            return 'partial';
          },
        };
        throw new Error('stream broken');
      }

      const client = makeMockClient();
      client.models.generateContentStream.mockResolvedValue(errorStream());

      const config = makeConfig();
      const { records, handler } = makeRecorder();
      const { handler: embHandler } = makeEmbeddingRecorder();
      wrapGeminiClient(client, config, handler, embHandler);

      const stream = await client.models.generateContentStream(makeGenerateParams());

      const collected: unknown[] = [];
      await expect(async () => {
        for await (const chunk of stream) {
          collected.push(chunk);
        }
      }).rejects.toThrow('stream broken');

      expect(collected).toHaveLength(1);
      expect(records).toHaveLength(1);
      expect(records[0].error).not.toBeNull();
      expect(records[0].error!.message).toBe('stream broken');
    });

    it('handles error before iteration starts', async () => {
      const client = makeMockClient();
      client.models.generateContentStream.mockRejectedValue(new Error('connection refused'));

      const config = makeConfig();
      const { records, handler } = makeRecorder();
      const { handler: embHandler } = makeEmbeddingRecorder();
      wrapGeminiClient(client, config, handler, embHandler);

      await expect(client.models.generateContentStream(makeGenerateParams())).rejects.toThrow(
        'connection refused',
      );

      expect(records).toHaveLength(1);
      expect(records[0].error!.message).toBe('connection refused');
    });
  });

  describe('models.embedContent()', () => {
    it('produces an AiEmbeddingRecord with correct dimensions and token count', async () => {
      const response = {
        embeddings: [
          {
            values: new Array(768).fill(0.1),
            statistics: { tokenCount: 42, truncated: false },
          },
        ],
        metadata: { billableCharacterCount: 100 },
      };
      const client = makeMockClient();
      client.models.embedContent.mockResolvedValue(response);

      const config = makeConfig();
      const { handler } = makeRecorder();
      const { records: embRecords, handler: embHandler } = makeEmbeddingRecorder();
      wrapGeminiClient(client, config, handler, embHandler);

      const result = await client.models.embedContent({
        model: 'text-embedding-004',
        contents: 'Hello world',
      });

      expect(result).toBe(response);
      expect(embRecords).toHaveLength(1);

      const record = embRecords[0];
      expect(record.id).toBeDefined();
      expect(record.provider).toBe('google');
      expect(record.model).toBe('text-embedding-004');
      expect(record.requestModel).toBe('text-embedding-004');
      expect(record.durationMs).toBeGreaterThan(0);
      expect(record.inputTokens).toBe(42);
      expect(record.embeddingDimensions).toBe(768);
      expect(record.embeddingCount).toBe(1);
      expect(record.error).toBeNull();
    });

    it('handles multiple embeddings', async () => {
      const response = {
        embeddings: [
          { values: new Array(256).fill(0.1), statistics: { tokenCount: 10 } },
          { values: new Array(256).fill(0.2), statistics: { tokenCount: 15 } },
        ],
      };
      const client = makeMockClient();
      client.models.embedContent.mockResolvedValue(response);

      const config = makeConfig();
      const { handler } = makeRecorder();
      const { records: embRecords, handler: embHandler } = makeEmbeddingRecorder();
      wrapGeminiClient(client, config, handler, embHandler);

      await client.models.embedContent({
        model: 'text-embedding-004',
        contents: ['First', 'Second'],
      });

      expect(embRecords[0].embeddingCount).toBe(2);
      // Dimensions from first embedding
      expect(embRecords[0].embeddingDimensions).toBe(256);
      // Token count from first embedding
      expect(embRecords[0].inputTokens).toBe(10);
    });

    it('captures error and propagates it', async () => {
      const client = makeMockClient();
      client.models.embedContent.mockRejectedValue(new Error('embedding failed'));

      const config = makeConfig();
      const { handler } = makeRecorder();
      const { records: embRecords, handler: embHandler } = makeEmbeddingRecorder();
      wrapGeminiClient(client, config, handler, embHandler);

      await expect(
        client.models.embedContent({ model: 'text-embedding-004', contents: 'test' }),
      ).rejects.toThrow('embedding failed');

      expect(embRecords).toHaveLength(1);
      expect(embRecords[0].error).not.toBeNull();
      expect(embRecords[0].error!.message).toBe('embedding failed');
      expect(embRecords[0].inputTokens).toBe(0);
      expect(embRecords[0].embeddingDimensions).toBe(0);
    });
  });

  describe('safety ratings', () => {
    it('captures safety ratings per category', async () => {
      const response = makeGenerateContentResponse();
      const client = makeMockClient();
      client.models.generateContent.mockResolvedValue(response);

      const config = makeConfig();
      const { handler } = makeRecorder();
      const { handler: embHandler } = makeEmbeddingRecorder();
      wrapGeminiClient(client, config, handler, embHandler);

      await client.models.generateContent(makeGenerateParams());

      // Test the extraction helper directly
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ratings = extractSafetyRatings(response as any);
      expect(ratings).not.toBeNull();
      expect(ratings).toHaveLength(4);
      expect(ratings![0]).toEqual({
        category: 'HARM_CATEGORY_HARASSMENT',
        probability: 'NEGLIGIBLE',
        blocked: false,
      });
      expect(ratings![1]).toEqual({
        category: 'HARM_CATEGORY_HATE_SPEECH',
        probability: 'NEGLIGIBLE',
        blocked: false,
      });
    });

    it('returns null when no safety ratings present', () => {
      const response = makeGenerateContentResponse({
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'test' }] },
            finishReason: 'STOP',
          },
        ],
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ratings = extractSafetyRatings(response as any);
      expect(ratings).toBeNull();
    });
  });

  describe('grounding metadata', () => {
    it('captures grounding info when present', () => {
      const response = makeGenerateContentResponse({
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'test' }] },
            finishReason: 'STOP',
            groundingMetadata: {
              searchEntryPoint: { renderedContent: '<div>search</div>' },
              groundingChunks: [
                { web: { uri: 'https://example.com', title: 'Example' } },
                { web: { uri: 'https://example2.com', title: 'Example2' } },
              ],
              groundingSupports: [{ confidenceScores: [0.9], groundingChunkIndices: [0] }],
            },
          },
        ],
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const info = extractGroundingInfo(response as any);
      expect(info).not.toBeNull();
      expect(info!.hasGrounding).toBe(true);
      expect(info!.chunksCount).toBe(2);
      expect(info!.supportsCount).toBe(1);
    });

    it('returns null when grounding is not used', () => {
      const response = makeGenerateContentResponse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const info = extractGroundingInfo(response as any);
      expect(info).toBeNull();
    });
  });

  describe('recordContent=false', () => {
    it('suppresses text but keeps all numeric metrics', async () => {
      const response = makeGenerateContentResponse();
      const client = makeMockClient();
      client.models.generateContent.mockResolvedValue(response);

      const config = makeConfig({ recordContent: false });
      const { records, handler } = makeRecorder();
      const { handler: embHandler } = makeEmbeddingRecorder();
      wrapGeminiClient(client, config, handler, embHandler);

      await client.models.generateContent(
        makeGenerateParams({
          config: { systemInstruction: 'You are helpful.' },
        }),
      );

      const record = records[0];
      expect(record.systemPrompt).toBeNull();
      expect(record.lastUserMessage).toBeNull();
      expect(record.responseText).toBeNull();

      // Metrics still captured
      expect(record.inputTokens).toBe(10);
      expect(record.outputTokens).toBe(20);
      expect(record.durationMs).toBeGreaterThan(0);
      expect(record.systemPromptLength).toBeGreaterThan(0);
    });
  });

  describe('highSecurity=true', () => {
    it('content fields are always empty regardless of recordContent', async () => {
      const response = makeGenerateContentResponse();
      const client = makeMockClient();
      client.models.generateContent.mockResolvedValue(response);

      const config = makeConfig({ recordContent: true, highSecurity: true });
      const { records, handler } = makeRecorder();
      const { handler: embHandler } = makeEmbeddingRecorder();
      wrapGeminiClient(client, config, handler, embHandler);

      await client.models.generateContent(
        makeGenerateParams({
          config: { systemInstruction: 'Secret instructions' },
        }),
      );

      const record = records[0];
      expect(record.systemPrompt).toBeNull();
      expect(record.lastUserMessage).toBeNull();
      expect(record.responseText).toBeNull();

      // Metrics still captured
      expect(record.inputTokens).toBe(10);
      expect(record.outputTokens).toBe(20);
    });
  });

  describe('content block types', () => {
    it('detects function_call and thinking blocks', async () => {
      const response = {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                { text: 'Let me think...', thought: true },
                { text: 'Here is my answer' },
                { functionCall: { name: 'search', args: { query: 'test' } } },
              ],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 },
        get text() {
          return 'Here is my answer';
        },
      };
      const client = makeMockClient();
      client.models.generateContent.mockResolvedValue(response);

      const config = makeConfig();
      const { records, handler } = makeRecorder();
      const { handler: embHandler } = makeEmbeddingRecorder();
      wrapGeminiClient(client, config, handler, embHandler);

      await client.models.generateContent(makeGenerateParams());

      expect(records[0].contentBlockTypes).toEqual(
        expect.arrayContaining(['thinking', 'text', 'function_call']),
      );
      expect(records[0].contentBlockTypes).toHaveLength(3);
    });
  });

  describe('built-in tool names', () => {
    it('extracts googleSearch and codeExecution tool names', async () => {
      const response = makeGenerateContentResponse();
      const client = makeMockClient();
      client.models.generateContent.mockResolvedValue(response);

      const config = makeConfig();
      const { records, handler } = makeRecorder();
      const { handler: embHandler } = makeEmbeddingRecorder();
      wrapGeminiClient(client, config, handler, embHandler);

      await client.models.generateContent(
        makeGenerateParams({
          config: {
            tools: [
              { googleSearch: {} },
              { codeExecution: {} },
              { functionDeclarations: [{ name: 'myFunc' }] },
            ],
          },
        }),
      );

      expect(records[0].toolNames).toEqual(
        expect.arrayContaining(['googleSearch', 'codeExecution', 'myFunc']),
      );
      expect(records[0].toolCount).toBe(3);
    });
  });
});
