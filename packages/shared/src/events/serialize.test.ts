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
