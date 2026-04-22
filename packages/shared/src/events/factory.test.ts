import { createAiRequest, createAiResponse, createAiMessage } from './factory.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('createAiRequest', () => {
  const baseParams = {
    provider: 'anthropic' as const,
    model: 'claude-sonnet-4-20250514',
    requestMethod: 'messages.create' as const,
    messageCount: 3,
    streamingEnabled: false,
    appName: 'test-app',
  };

  it('generates a valid UUID and sets timestamp', () => {
    const before = Date.now();
    const event = createAiRequest(baseParams);
    const after = Date.now();

    expect(event.id).toMatch(UUID_REGEX);
    expect(event.timestamp).toBeGreaterThanOrEqual(before);
    expect(event.timestamp).toBeLessThanOrEqual(after);
  });

  it('includes all required fields', () => {
    const event = createAiRequest(baseParams);

    expect(event.provider).toBe('anthropic');
    expect(event.model).toBe('claude-sonnet-4-20250514');
    expect(event.requestMethod).toBe('messages.create');
    expect(event.messageCount).toBe(3);
    expect(event.streamingEnabled).toBe(false);
    expect(event['nr.appName']).toBe('test-app');
  });

  it('defaults optional fields', () => {
    const event = createAiRequest(baseParams);

    expect(event.maxTokens).toBeNull();
    expect(event.temperature).toBeNull();
    expect(event.topP).toBeNull();
    expect(event.systemPromptLength).toBeNull();
    expect(event.toolCount).toBe(0);
    expect(event.toolNames).toEqual([]);
    expect(event.thinkingEnabled).toBe(false);
    expect(event.thinkingBudgetTokens).toBeNull();
    expect(event['nr.entityGuid']).toBeNull();
    expect(event.customAttributes).toEqual({});
  });

  it('accepts all optional fields', () => {
    const event = createAiRequest({
      ...baseParams,
      maxTokens: 1024,
      temperature: 0.7,
      topP: 0.9,
      systemPromptLength: 500,
      toolCount: 2,
      toolNames: ['calc', 'search'],
      thinkingEnabled: true,
      thinkingBudgetTokens: 10000,
      entityGuid: 'abc-123',
      customAttributes: { team: 'backend', feature: 'chat' },
    });

    expect(event.maxTokens).toBe(1024);
    expect(event.temperature).toBe(0.7);
    expect(event.topP).toBe(0.9);
    expect(event.systemPromptLength).toBe(500);
    expect(event.toolCount).toBe(2);
    expect(event.toolNames).toEqual(['calc', 'search']);
    expect(event.thinkingEnabled).toBe(true);
    expect(event.thinkingBudgetTokens).toBe(10000);
    expect(event['nr.entityGuid']).toBe('abc-123');
    expect(event.customAttributes).toEqual({ team: 'backend', feature: 'chat' });
  });

  it('accepts a pre-generated id and timestamp', () => {
    const event = createAiRequest({
      ...baseParams,
      id: 'my-custom-id',
      timestamp: 1000,
    });

    expect(event.id).toBe('my-custom-id');
    expect(event.timestamp).toBe(1000);
  });

  it('throws on missing model', () => {
    expect(() => createAiRequest({ ...baseParams, model: '' })).toThrow('requires a model');
  });

  it('throws on missing provider', () => {
    expect(() => createAiRequest({ ...baseParams, provider: '' as 'anthropic' })).toThrow(
      'requires a provider',
    );
  });

  it('throws on missing requestMethod', () => {
    expect(() =>
      createAiRequest({ ...baseParams, requestMethod: '' as 'messages.create' }),
    ).toThrow('requires a requestMethod');
  });

  it('throws on missing appName', () => {
    expect(() => createAiRequest({ ...baseParams, appName: '' })).toThrow('requires an appName');
  });
});

describe('createAiResponse', () => {
  const baseParams = {
    provider: 'google' as const,
    model: 'gemini-2.0-flash',
    durationMs: 1500,
    inputTokens: 100,
    outputTokens: 50,
    appName: 'test-app',
  };

  it('generates a valid UUID and sets timestamp', () => {
    const before = Date.now();
    const event = createAiResponse(baseParams);
    const after = Date.now();

    expect(event.id).toMatch(UUID_REGEX);
    expect(event.timestamp).toBeGreaterThanOrEqual(before);
    expect(event.timestamp).toBeLessThanOrEqual(after);
  });

  it('computes totalTokens as inputTokens + outputTokens + thinkingTokens + cache tokens', () => {
    const event = createAiResponse({
      ...baseParams,
      thinkingTokens: 200,
      cacheReadTokens: 30,
      cacheCreationTokens: 20,
    });

    expect(event.totalTokens).toBe(400); // 100 + 50 + 200 + 30 + 20
  });

  it('computes tokensPerSecond from outputTokens and durationMs', () => {
    const event = createAiResponse(baseParams);

    // 50 tokens / 1500ms * 1000 = 33.333...
    expect(event.tokensPerSecond).toBeCloseTo(33.333, 2);
  });

  it('sets tokensPerSecond to null when durationMs is 0', () => {
    const event = createAiResponse({ ...baseParams, durationMs: 0 });
    expect(event.tokensPerSecond).toBeNull();
  });

  it('sets tokensPerSecond to null when outputTokens is 0', () => {
    const event = createAiResponse({ ...baseParams, outputTokens: 0 });
    expect(event.tokensPerSecond).toBeNull();
  });

  it('defaults optional fields', () => {
    const event = createAiResponse(baseParams);

    expect(event.timeToFirstTokenMs).toBeNull();
    expect(event.thinkingTokens).toBe(0);
    expect(event.cacheReadTokens).toBe(0);
    expect(event.cacheCreationTokens).toBe(0);
    expect(event.costInputUsd).toBeNull();
    expect(event.costOutputUsd).toBeNull();
    expect(event.costThinkingUsd).toBeNull();
    expect(event.costCacheReadUsd).toBeNull();
    expect(event.costCacheCreationUsd).toBeNull();
    expect(event.costTotalUsd).toBeNull();
    expect(event.stopReason).toBeNull();
    expect(event.contentBlockTypes).toEqual([]);
    expect(event.error).toBeNull();
    expect(event.customAttributes).toEqual({});
  });

  it('accepts all optional fields including costs and error', () => {
    const event = createAiResponse({
      ...baseParams,
      timeToFirstTokenMs: 200,
      thinkingTokens: 300,
      cacheReadTokens: 10,
      cacheCreationTokens: 5,
      costInputUsd: 0.001,
      costOutputUsd: 0.003,
      costThinkingUsd: 0.002,
      costCacheReadUsd: 0.0001,
      costCacheCreationUsd: 0.0005,
      costTotalUsd: 0.0066,
      stopReason: 'end_turn',
      contentBlockTypes: ['text', 'tool_use'],
      error: { type: 'api_error', message: 'failed', statusCode: 500 },
    });

    expect(event.timeToFirstTokenMs).toBe(200);
    expect(event.thinkingTokens).toBe(300);
    expect(event.cacheReadTokens).toBe(10);
    expect(event.cacheCreationTokens).toBe(5);
    expect(event.costInputUsd).toBe(0.001);
    expect(event.costTotalUsd).toBe(0.0066);
    expect(event.stopReason).toBe('end_turn');
    expect(event.contentBlockTypes).toEqual(['text', 'tool_use']);
    expect(event.error).toEqual({ type: 'api_error', message: 'failed', statusCode: 500 });
  });

  it('paired request and response share the same id', () => {
    const sharedId = 'shared-uuid-123';
    const request = createAiRequest({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      requestMethod: 'messages.create',
      messageCount: 1,
      streamingEnabled: false,
      appName: 'test-app',
      id: sharedId,
    });
    const response = createAiResponse({
      ...baseParams,
      id: sharedId,
    });

    expect(request.id).toBe(sharedId);
    expect(response.id).toBe(sharedId);
  });

  it('throws on missing model', () => {
    expect(() => createAiResponse({ ...baseParams, model: '' })).toThrow('requires a model');
  });

  it('throws on missing provider', () => {
    expect(() => createAiResponse({ ...baseParams, provider: '' as 'google' })).toThrow(
      'requires a provider',
    );
  });

  it('throws on missing appName', () => {
    expect(() => createAiResponse({ ...baseParams, appName: '' })).toThrow('requires an appName');
  });
});

describe('createAiMessage', () => {
  const baseParams = {
    role: 'user' as const,
    content: 'Hello, Claude!',
    contentLength: 14,
    sequence: 0,
    appName: 'test-app',
  };

  it('generates a valid UUID and sets timestamp', () => {
    const before = Date.now();
    const event = createAiMessage(baseParams);
    const after = Date.now();

    expect(event.id).toMatch(UUID_REGEX);
    expect(event.timestamp).toBeGreaterThanOrEqual(before);
    expect(event.timestamp).toBeLessThanOrEqual(after);
  });

  it('preserves content and contentLength independently', () => {
    const truncated = createAiMessage({
      ...baseParams,
      content: 'Hello...', // truncated version
      contentLength: 5000, // original length before truncation
      sequence: 2,
    });

    expect(truncated.content).toBe('Hello...');
    expect(truncated.contentLength).toBe(5000);
    expect(truncated.sequence).toBe(2);
  });

  it('includes all fields', () => {
    const event = createAiMessage(baseParams);

    expect(event.role).toBe('user');
    expect(event.content).toBe('Hello, Claude!');
    expect(event.contentLength).toBe(14);
    expect(event.sequence).toBe(0);
    expect(event['nr.appName']).toBe('test-app');
    expect(event.customAttributes).toEqual({});
  });

  it('accepts custom attributes', () => {
    const event = createAiMessage({
      ...baseParams,
      customAttributes: { conversationId: 'conv-123' },
    });

    expect(event.customAttributes).toEqual({ conversationId: 'conv-123' });
  });

  it('throws on missing role', () => {
    expect(() => createAiMessage({ ...baseParams, role: '' as 'user' })).toThrow('requires a role');
  });

  it('throws on missing appName', () => {
    expect(() => createAiMessage({ ...baseParams, appName: '' })).toThrow('requires an appName');
  });
});
