import { createAiRequest, createAiResponse, createAiMessage } from './factory.js';
import { aiRequestToNrEvent, aiResponseToNrEvent, aiMessageToNrEvent } from './serialize.js';

describe('aiRequestToNrEvent', () => {
  it('produces flat key-value pairs with no nested objects', () => {
    const event = createAiRequest({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      requestMethod: 'messages.create',
      messageCount: 3,
      streamingEnabled: true,
      appName: 'my-app',
      maxTokens: 1024,
      temperature: 0.7,
      topP: 0.9,
      systemPromptLength: 500,
      toolCount: 2,
      toolNames: ['calc', 'search'],
      thinkingEnabled: true,
      thinkingBudgetTokens: 10000,
      entityGuid: 'guid-123',
      customAttributes: { team: 'backend', priority: 1 },
    });

    const nrEvent = aiRequestToNrEvent(event);

    // All values must be string, number, or boolean — no objects or arrays
    for (const [key, value] of Object.entries(nrEvent)) {
      expect(['string', 'number', 'boolean']).toContain(typeof value);
      expect(key).not.toContain('[');
      // Keys should be strings
      expect(typeof key).toBe('string');
    }

    // Check specific fields
    expect(nrEvent.eventType).toBe('AiRequest');
    expect(nrEvent.id).toBe(event.id);
    expect(nrEvent.timestamp).toBe(event.timestamp);
    expect(nrEvent.provider).toBe('anthropic');
    expect(nrEvent.model).toBe('claude-sonnet-4-20250514');
    expect(nrEvent.requestMethod).toBe('messages.create');
    expect(nrEvent.messageCount).toBe(3);
    expect(nrEvent.streamingEnabled).toBe(true);
    expect(nrEvent['nr.appName']).toBe('my-app');
    expect(nrEvent.maxTokens).toBe(1024);
    expect(nrEvent.temperature).toBe(0.7);
    expect(nrEvent.topP).toBe(0.9);
    expect(nrEvent.systemPromptLength).toBe(500);
    expect(nrEvent.toolCount).toBe(2);
    expect(nrEvent.toolNames).toBe('["calc","search"]');
    expect(nrEvent.thinkingEnabled).toBe(true);
    expect(nrEvent.thinkingBudgetTokens).toBe(10000);
    expect(nrEvent['nr.entityGuid']).toBe('guid-123');
    expect(nrEvent['custom.team']).toBe('backend');
    expect(nrEvent['custom.priority']).toBe(1);
  });

  it('omits null fields', () => {
    const event = createAiRequest({
      provider: 'google',
      model: 'gemini-2.0-flash',
      requestMethod: 'models.generateContent',
      messageCount: 1,
      streamingEnabled: false,
      appName: 'my-app',
    });

    const nrEvent = aiRequestToNrEvent(event);

    expect(nrEvent).not.toHaveProperty('maxTokens');
    expect(nrEvent).not.toHaveProperty('temperature');
    expect(nrEvent).not.toHaveProperty('topP');
    expect(nrEvent).not.toHaveProperty('systemPromptLength');
    expect(nrEvent).not.toHaveProperty('toolNames');
    expect(nrEvent).not.toHaveProperty('thinkingBudgetTokens');
    expect(nrEvent).not.toHaveProperty('nr.entityGuid');
  });
});

describe('aiResponseToNrEvent', () => {
  it('produces flat key-value pairs with no nested objects', () => {
    const event = createAiResponse({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      durationMs: 1500,
      timeToFirstTokenMs: 200,
      inputTokens: 100,
      outputTokens: 50,
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
      appName: 'my-app',
      customAttributes: { runId: 'run-abc' },
    });

    const nrEvent = aiResponseToNrEvent(event);

    for (const value of Object.values(nrEvent)) {
      expect(['string', 'number', 'boolean']).toContain(typeof value);
    }

    expect(nrEvent.eventType).toBe('AiResponse');
    expect(nrEvent.id).toBe(event.id);
    expect(nrEvent.durationMs).toBe(1500);
    expect(nrEvent.timeToFirstTokenMs).toBe(200);
    expect(nrEvent.inputTokens).toBe(100);
    expect(nrEvent.outputTokens).toBe(50);
    expect(nrEvent.thinkingTokens).toBe(300);
    expect(nrEvent.totalTokens).toBe(465);
    expect(nrEvent.stopReason).toBe('end_turn');
    expect(nrEvent.contentBlockTypes).toBe('["text","tool_use"]');
    expect(nrEvent['cost.inputUsd']).toBe(0.001);
    expect(nrEvent['cost.totalUsd']).toBe(0.0066);
    expect(nrEvent['error.type']).toBe('api_error');
    expect(nrEvent['error.message']).toBe('failed');
    expect(nrEvent['error.statusCode']).toBe(500);
    expect(nrEvent['custom.runId']).toBe('run-abc');
  });

  it('omits null fields and empty arrays', () => {
    const event = createAiResponse({
      provider: 'google',
      model: 'gemini-2.0-flash',
      durationMs: 500,
      inputTokens: 10,
      outputTokens: 0,
      appName: 'my-app',
    });

    const nrEvent = aiResponseToNrEvent(event);

    expect(nrEvent).not.toHaveProperty('timeToFirstTokenMs');
    expect(nrEvent).not.toHaveProperty('tokensPerSecond');
    expect(nrEvent).not.toHaveProperty('stopReason');
    expect(nrEvent).not.toHaveProperty('contentBlockTypes');
    expect(nrEvent).not.toHaveProperty('cost.inputUsd');
    expect(nrEvent).not.toHaveProperty('cost.totalUsd');
    expect(nrEvent).not.toHaveProperty('error.type');
    expect(nrEvent).not.toHaveProperty('error.message');
    expect(nrEvent).not.toHaveProperty('error.statusCode');
  });

  it('includes tokensPerSecond when computable', () => {
    const event = createAiResponse({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      durationMs: 1000,
      inputTokens: 100,
      outputTokens: 50,
      appName: 'my-app',
    });

    const nrEvent = aiResponseToNrEvent(event);
    expect(nrEvent.tokensPerSecond).toBe(50);
  });
});

describe('aiMessageToNrEvent', () => {
  it('produces flat key-value pairs', () => {
    const event = createAiMessage({
      role: 'assistant',
      content: 'Hello!',
      contentLength: 6,
      sequence: 1,
      appName: 'my-app',
      customAttributes: { conversationId: 'conv-1' },
    });

    const nrEvent = aiMessageToNrEvent(event);

    for (const value of Object.values(nrEvent)) {
      expect(['string', 'number', 'boolean']).toContain(typeof value);
    }

    expect(nrEvent.eventType).toBe('AiMessage');
    expect(nrEvent.id).toBe(event.id);
    expect(nrEvent.role).toBe('assistant');
    expect(nrEvent.content).toBe('Hello!');
    expect(nrEvent.contentLength).toBe(6);
    expect(nrEvent.sequence).toBe(1);
    expect(nrEvent['nr.appName']).toBe('my-app');
    expect(nrEvent['custom.conversationId']).toBe('conv-1');
  });
});

describe('GenAI semantic convention attributes', () => {
  describe('aiRequestToNrEvent', () => {
    it('emits gen_ai.system for known providers', () => {
      const event = createAiRequest({ provider: 'anthropic', model: 'claude-sonnet-4-6', requestMethod: 'messages.create', messageCount: 1, streamingEnabled: false, appName: 'test' });
      const data = aiRequestToNrEvent(event);
      expect(data['gen_ai.system']).toBe('anthropic');
    });

    it('maps google provider to google_genai', () => {
      const event = createAiRequest({ provider: 'google', model: 'gemini-2.0-flash', requestMethod: 'models.generateContent', messageCount: 1, streamingEnabled: false, appName: 'test' });
      const data = aiRequestToNrEvent(event);
      expect(data['gen_ai.system']).toBe('google_genai');
    });

    it('emits gen_ai.request.model', () => {
      const event = createAiRequest({ provider: 'anthropic', model: 'claude-opus-4-7', requestMethod: 'messages.create', messageCount: 1, streamingEnabled: false, appName: 'test' });
      const data = aiRequestToNrEvent(event);
      expect(data['gen_ai.request.model']).toBe('claude-opus-4-7');
    });

    it('maps messages.create to gen_ai.operation.name = chat', () => {
      const event = createAiRequest({ provider: 'anthropic', model: 'claude-sonnet-4-6', requestMethod: 'messages.create', messageCount: 1, streamingEnabled: false, appName: 'test' });
      const data = aiRequestToNrEvent(event);
      expect(data['gen_ai.operation.name']).toBe('chat');
    });

    it('maps models.embedContent to gen_ai.operation.name = embeddings', () => {
      const event = createAiRequest({ provider: 'google', model: 'gemini-2.0-flash', requestMethod: 'models.embedContent', messageCount: 1, streamingEnabled: false, appName: 'test' });
      const data = aiRequestToNrEvent(event);
      expect(data['gen_ai.operation.name']).toBe('embeddings');
    });

    it('emits gen_ai.request.max_tokens when set', () => {
      const event = createAiRequest({ provider: 'anthropic', model: 'claude-sonnet-4-6', requestMethod: 'messages.create', messageCount: 1, streamingEnabled: false, appName: 'test', maxTokens: 1024 });
      const data = aiRequestToNrEvent(event);
      expect(data['gen_ai.request.max_tokens']).toBe(1024);
    });

    it('omits gen_ai.request.max_tokens when null', () => {
      const event = createAiRequest({ provider: 'anthropic', model: 'claude-sonnet-4-6', requestMethod: 'messages.create', messageCount: 1, streamingEnabled: false, appName: 'test', maxTokens: null });
      const data = aiRequestToNrEvent(event);
      expect(data['gen_ai.request.max_tokens']).toBeUndefined();
    });

    it('emits gen_ai.request.stream', () => {
      const streaming = createAiRequest({ provider: 'anthropic', model: 'claude-sonnet-4-6', requestMethod: 'messages.create', messageCount: 1, streamingEnabled: true, appName: 'test' });
      const notStreaming = createAiRequest({ provider: 'anthropic', model: 'claude-sonnet-4-6', requestMethod: 'messages.create', messageCount: 1, streamingEnabled: false, appName: 'test' });
      expect(aiRequestToNrEvent(streaming)['gen_ai.request.stream']).toBe(true);
      expect(aiRequestToNrEvent(notStreaming)['gen_ai.request.stream']).toBe(false);
    });

    it('emits gen_ai.request.temperature when set', () => {
      const event = createAiRequest({ provider: 'anthropic', model: 'claude-sonnet-4-6', requestMethod: 'messages.create', messageCount: 1, streamingEnabled: false, appName: 'test', temperature: 0.7 });
      const data = aiRequestToNrEvent(event);
      expect(data['gen_ai.request.temperature']).toBe(0.7);
    });

    it('emits gen_ai.request.top_p when set', () => {
      const event = createAiRequest({ provider: 'anthropic', model: 'claude-sonnet-4-6', requestMethod: 'messages.create', messageCount: 1, streamingEnabled: false, appName: 'test', topP: 0.9 });
      const data = aiRequestToNrEvent(event);
      expect(data['gen_ai.request.top_p']).toBe(0.9);
    });
  });

  describe('aiResponseToNrEvent', () => {
    it('emits gen_ai.usage.input_tokens and gen_ai.usage.output_tokens', () => {
      const event = createAiResponse({ provider: 'anthropic', model: 'claude-sonnet-4-6', durationMs: 100, inputTokens: 100, outputTokens: 50, appName: 'test' });
      const data = aiResponseToNrEvent(event);
      expect(data['gen_ai.usage.input_tokens']).toBe(100);
      expect(data['gen_ai.usage.output_tokens']).toBe(50);
    });

    it('emits gen_ai.usage.reasoning.output_tokens when thinkingTokens > 0', () => {
      const event = createAiResponse({ provider: 'anthropic', model: 'claude-sonnet-4-6', durationMs: 100, inputTokens: 10, outputTokens: 10, thinkingTokens: 200, appName: 'test' });
      const data = aiResponseToNrEvent(event);
      expect(data['gen_ai.usage.reasoning.output_tokens']).toBe(200);
    });

    it('omits gen_ai.usage.reasoning.output_tokens when thinkingTokens === 0', () => {
      const event = createAiResponse({ provider: 'anthropic', model: 'claude-sonnet-4-6', durationMs: 100, inputTokens: 10, outputTokens: 10, thinkingTokens: 0, appName: 'test' });
      const data = aiResponseToNrEvent(event);
      expect(data['gen_ai.usage.reasoning.output_tokens']).toBeUndefined();
    });

    it('emits gen_ai.usage.cache_read.input_tokens when cacheReadTokens > 0', () => {
      const event = createAiResponse({ provider: 'anthropic', model: 'claude-sonnet-4-6', durationMs: 100, inputTokens: 10, outputTokens: 10, cacheReadTokens: 300, appName: 'test' });
      const data = aiResponseToNrEvent(event);
      expect(data['gen_ai.usage.cache_read.input_tokens']).toBe(300);
    });

    it('emits gen_ai.usage.cache_creation.input_tokens when cacheCreationTokens > 0', () => {
      const event = createAiResponse({ provider: 'anthropic', model: 'claude-sonnet-4-6', durationMs: 100, inputTokens: 10, outputTokens: 10, cacheCreationTokens: 150, appName: 'test' });
      const data = aiResponseToNrEvent(event);
      expect(data['gen_ai.usage.cache_creation.input_tokens']).toBe(150);
    });

    it('emits gen_ai.response.finish_reason when stopReason is set', () => {
      const event = createAiResponse({ provider: 'anthropic', model: 'claude-sonnet-4-6', durationMs: 100, inputTokens: 10, outputTokens: 10, stopReason: 'end_turn', appName: 'test' });
      const data = aiResponseToNrEvent(event);
      expect(data['gen_ai.response.finish_reason']).toBe('end_turn');
    });

    it('emits gen_ai.response.model', () => {
      const event = createAiResponse({ provider: 'anthropic', model: 'claude-sonnet-4-6', durationMs: 100, inputTokens: 10, outputTokens: 10, appName: 'test' });
      const data = aiResponseToNrEvent(event);
      expect(data['gen_ai.response.model']).toBe('claude-sonnet-4-6');
    });
  });
});
