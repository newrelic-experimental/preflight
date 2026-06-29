import {
  createAiRequest,
  createAiResponse,
  createAiMessage,
  createAiAgentTaskSummary,
  createAiAntiPattern,
  createAiAgentMessage,
  createAiContextReset,
} from './factory.js';
import {
  aiRequestToNrEvent,
  aiResponseToNrEvent,
  aiMessageToNrEvent,
  aiAntiPatternToNrEvent,
  aiAgentTaskSummaryToNrEvent,
  aiAgentMessageToNrEvent,
  aiContextResetToNrEvent,
  EVENT_SCHEMA_VERSION,
} from './serialize.js';
import type { AiAntiPattern } from './types.js';

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

  // Provider error messages may include verbatim user-prompt fragments
  // ("the prompt 'tell me about <X>' was rejected because…"). When the
  // consumer's config has `highSecurity: true`, error.message must be omitted
  // so it doesn't leak via the error path. error.type and error.statusCode
  // still surface for triage.
  it('omits error.message when highSecurity is true, but keeps error.type and error.statusCode', () => {
    const event = createAiResponse({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      durationMs: 200,
      inputTokens: 10,
      outputTokens: 0,
      error: {
        type: 'invalid_request_error',
        message: "the prompt 'leak me' was rejected because of policy",
        statusCode: 400,
      },
      appName: 'my-app',
    });

    const nrEvent = aiResponseToNrEvent(event, { highSecurity: true });

    expect(nrEvent['error.type']).toBe('invalid_request_error');
    expect(nrEvent['error.statusCode']).toBe(400);
    expect(nrEvent).not.toHaveProperty('error.message');
  });

  // Default (no options) and { highSecurity: false } both record error.message
  // verbatim — the redaction is opt-in to preserve existing telemetry value
  // when the consumer hasn't enabled high-security mode.
  it('records error.message verbatim when highSecurity is false or omitted', () => {
    const event = createAiResponse({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      durationMs: 200,
      inputTokens: 10,
      outputTokens: 0,
      error: { type: 'api_error', message: 'failed', statusCode: 500 },
      appName: 'my-app',
    });

    expect(aiResponseToNrEvent(event)['error.message']).toBe('failed');
    expect(aiResponseToNrEvent(event, {})['error.message']).toBe('failed');
    expect(aiResponseToNrEvent(event, { highSecurity: false })['error.message']).toBe('failed');
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

// All three serializers must emit nr.entityGuid when set.
// Pre-fix, only aiRequestToNrEvent stamped the field; aiResponseToNrEvent and
// aiMessageToNrEvent silently dropped it even though the factory accepted it.
describe('nr.entityGuid emission across all three serializers', () => {
  it('aiRequestToNrEvent emits nr.entityGuid when provided', () => {
    const event = createAiRequest({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      requestMethod: 'messages.create',
      messageCount: 1,
      streamingEnabled: false,
      appName: 'app',
      entityGuid: 'GUID-REQ',
    });
    expect(aiRequestToNrEvent(event)['nr.entityGuid']).toBe('GUID-REQ');
  });

  it('aiResponseToNrEvent emits nr.entityGuid when provided', () => {
    const event = createAiResponse({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      durationMs: 100,
      inputTokens: 0,
      outputTokens: 0,
      appName: 'app',
      entityGuid: 'GUID-RESP',
    });
    expect(aiResponseToNrEvent(event)['nr.entityGuid']).toBe('GUID-RESP');
  });

  it('aiMessageToNrEvent emits nr.entityGuid when provided', () => {
    const event = createAiMessage({
      role: 'user',
      content: 'hi',
      contentLength: 2,
      sequence: 0,
      appName: 'app',
      entityGuid: 'GUID-MSG',
    });
    expect(aiMessageToNrEvent(event)['nr.entityGuid']).toBe('GUID-MSG');
  });

  it('all three serializers omit nr.entityGuid when null', () => {
    const req = createAiRequest({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      requestMethod: 'messages.create',
      messageCount: 1,
      streamingEnabled: false,
      appName: 'app',
    });
    const resp = createAiResponse({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      durationMs: 100,
      inputTokens: 0,
      outputTokens: 0,
      appName: 'app',
    });
    const msg = createAiMessage({
      role: 'user',
      content: 'hi',
      contentLength: 2,
      sequence: 0,
      appName: 'app',
    });
    expect(aiRequestToNrEvent(req)).not.toHaveProperty('nr.entityGuid');
    expect(aiResponseToNrEvent(resp)).not.toHaveProperty('nr.entityGuid');
    expect(aiMessageToNrEvent(msg)).not.toHaveProperty('nr.entityGuid');
  });

  it('four newer event types emit nr.entityGuid when provided', () => {
    const guid = 'GUID-XYZ';
    const taskSummary = createAiAgentTaskSummary({
      traceId: 't1',
      spanId: 's1',
      taskName: 'test',
      durationMs: 100,
      totalLlmCalls: 1,
      totalToolCalls: 0,
      totalTokens: 50,
      stepCount: 1,
      success: true,
      appName: 'app',
      entityGuid: guid,
    });
    expect(aiAgentTaskSummaryToNrEvent(taskSummary)['nr.entityGuid']).toBe(guid);

    const antiPattern = createAiAntiPattern({
      traceId: 't1',
      patternType: 'spinning_wheels',
      severity: 'low',
      description: 'test',
      appName: 'app',
      entityGuid: guid,
    });
    expect(aiAntiPatternToNrEvent(antiPattern)['nr.entityGuid']).toBe(guid);

    const agentMsg = createAiAgentMessage({
      traceId: 't1',
      fromAgent: 'a',
      toAgent: 'b',
      messageType: 'request',
      appName: 'app',
      entityGuid: guid,
    });
    expect(aiAgentMessageToNrEvent(agentMsg)['nr.entityGuid']).toBe(guid);

    const contextReset = createAiContextReset({
      traceId: 't1',
      conversationId: 'c1',
      tokensBefore: 100,
      tokensAfter: 50,
      reason: 'summarization',
      appName: 'app',
      entityGuid: guid,
    });
    expect(aiContextResetToNrEvent(contextReset)['nr.entityGuid']).toBe(guid);
  });

  it('four newer event types omit nr.entityGuid when null', () => {
    const taskSummary = createAiAgentTaskSummary({
      traceId: 't1',
      spanId: 's1',
      taskName: 'test',
      durationMs: 100,
      totalLlmCalls: 1,
      totalToolCalls: 0,
      totalTokens: 50,
      stepCount: 1,
      success: true,
      appName: 'app',
    });
    expect(aiAgentTaskSummaryToNrEvent(taskSummary)).not.toHaveProperty('nr.entityGuid');
  });
});

describe('GenAI semantic convention attributes', () => {
  describe('aiRequestToNrEvent', () => {
    it('emits gen_ai.system for known providers', () => {
      const event = createAiRequest({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        requestMethod: 'messages.create',
        messageCount: 1,
        streamingEnabled: false,
        appName: 'test',
      });
      const data = aiRequestToNrEvent(event);
      expect(data['gen_ai.system']).toBe('anthropic');
    });

    // `google` maps to the OTel-canonical `gcp.gemini`
    // (was `google_genai` pre-fix; the OTel SemConv canonical value for
    // generativelanguage.googleapis.com is `gcp.gemini`).
    it('maps google provider to gcp.gemini per OTel SemConv', () => {
      const event = createAiRequest({
        provider: 'google',
        model: 'gemini-2.0-flash',
        requestMethod: 'models.generateContent',
        messageCount: 1,
        streamingEnabled: false,
        appName: 'test',
      });
      const data = aiRequestToNrEvent(event);
      expect(data['gen_ai.system']).toBe('gcp.gemini');
    });

    it('emits gen_ai.request.model', () => {
      const event = createAiRequest({
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        requestMethod: 'messages.create',
        messageCount: 1,
        streamingEnabled: false,
        appName: 'test',
      });
      const data = aiRequestToNrEvent(event);
      expect(data['gen_ai.request.model']).toBe('claude-opus-4-7');
    });

    it('maps messages.create to gen_ai.operation.name = chat', () => {
      const event = createAiRequest({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        requestMethod: 'messages.create',
        messageCount: 1,
        streamingEnabled: false,
        appName: 'test',
      });
      const data = aiRequestToNrEvent(event);
      expect(data['gen_ai.operation.name']).toBe('chat');
    });

    it('maps models.embedContent to gen_ai.operation.name = embeddings', () => {
      const event = createAiRequest({
        provider: 'google',
        model: 'gemini-2.0-flash',
        requestMethod: 'models.embedContent',
        messageCount: 1,
        streamingEnabled: false,
        appName: 'test',
      });
      const data = aiRequestToNrEvent(event);
      expect(data['gen_ai.operation.name']).toBe('embeddings');
    });

    // OpenAI's `client.embeddings.create({...})`.
    it('maps embeddings.create (OpenAI) to gen_ai.operation.name = embeddings', () => {
      const event = createAiRequest({
        provider: 'openai',
        model: 'text-embedding-3-small',
        requestMethod: 'embeddings.create',
        messageCount: 1,
        streamingEnabled: false,
        appName: 'test',
      });
      const data = aiRequestToNrEvent(event);
      expect(data['gen_ai.operation.name']).toBe('embeddings');
    });

    // Cohere's `client.embed(...)`.
    it('maps embed (Cohere) to gen_ai.operation.name = embeddings', () => {
      const event = createAiRequest({
        provider: 'cohere',
        model: 'embed-english-v3.0',
        requestMethod: 'embed',
        messageCount: 1,
        streamingEnabled: false,
        appName: 'test',
      });
      const data = aiRequestToNrEvent(event);
      expect(data['gen_ai.operation.name']).toBe('embeddings');
    });

    it('emits gen_ai.request.max_tokens when set', () => {
      const event = createAiRequest({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        requestMethod: 'messages.create',
        messageCount: 1,
        streamingEnabled: false,
        appName: 'test',
        maxTokens: 1024,
      });
      const data = aiRequestToNrEvent(event);
      expect(data['gen_ai.request.max_tokens']).toBe(1024);
    });

    it('omits gen_ai.request.max_tokens when null', () => {
      const event = createAiRequest({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        requestMethod: 'messages.create',
        messageCount: 1,
        streamingEnabled: false,
        appName: 'test',
        maxTokens: null,
      });
      const data = aiRequestToNrEvent(event);
      expect(data['gen_ai.request.max_tokens']).toBeUndefined();
    });

    it('emits gen_ai.request.stream', () => {
      const streaming = createAiRequest({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        requestMethod: 'messages.create',
        messageCount: 1,
        streamingEnabled: true,
        appName: 'test',
      });
      const notStreaming = createAiRequest({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        requestMethod: 'messages.create',
        messageCount: 1,
        streamingEnabled: false,
        appName: 'test',
      });
      expect(aiRequestToNrEvent(streaming)['gen_ai.request.stream']).toBe(true);
      expect(aiRequestToNrEvent(notStreaming)['gen_ai.request.stream']).toBe(false);
    });

    it('emits gen_ai.request.temperature when set', () => {
      const event = createAiRequest({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        requestMethod: 'messages.create',
        messageCount: 1,
        streamingEnabled: false,
        appName: 'test',
        temperature: 0.7,
      });
      const data = aiRequestToNrEvent(event);
      expect(data['gen_ai.request.temperature']).toBe(0.7);
    });

    it('emits gen_ai.request.top_p when set', () => {
      const event = createAiRequest({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        requestMethod: 'messages.create',
        messageCount: 1,
        streamingEnabled: false,
        appName: 'test',
        topP: 0.9,
      });
      const data = aiRequestToNrEvent(event);
      expect(data['gen_ai.request.top_p']).toBe(0.9);
    });
  });

  describe('aiResponseToNrEvent', () => {
    it('emits gen_ai.usage.input_tokens and gen_ai.usage.output_tokens', () => {
      const event = createAiResponse({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        durationMs: 100,
        inputTokens: 100,
        outputTokens: 50,
        appName: 'test',
      });
      const data = aiResponseToNrEvent(event);
      expect(data['gen_ai.usage.input_tokens']).toBe(100);
      expect(data['gen_ai.usage.output_tokens']).toBe(50);
    });

    it('emits gen_ai.usage.reasoning.output_tokens when thinkingTokens > 0', () => {
      const event = createAiResponse({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        durationMs: 100,
        inputTokens: 10,
        outputTokens: 10,
        thinkingTokens: 200,
        appName: 'test',
      });
      const data = aiResponseToNrEvent(event);
      expect(data['gen_ai.usage.reasoning.output_tokens']).toBe(200);
    });

    it('omits gen_ai.usage.reasoning.output_tokens when thinkingTokens === 0', () => {
      const event = createAiResponse({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        durationMs: 100,
        inputTokens: 10,
        outputTokens: 10,
        thinkingTokens: 0,
        appName: 'test',
      });
      const data = aiResponseToNrEvent(event);
      expect(data['gen_ai.usage.reasoning.output_tokens']).toBeUndefined();
    });

    it('emits gen_ai.usage.cache_read.input_tokens when cacheReadTokens > 0', () => {
      const event = createAiResponse({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        durationMs: 100,
        inputTokens: 10,
        outputTokens: 10,
        cacheReadTokens: 300,
        appName: 'test',
      });
      const data = aiResponseToNrEvent(event);
      expect(data['gen_ai.usage.cache_read.input_tokens']).toBe(300);
    });

    it('emits gen_ai.usage.cache_creation.input_tokens when cacheCreationTokens > 0', () => {
      const event = createAiResponse({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        durationMs: 100,
        inputTokens: 10,
        outputTokens: 10,
        cacheCreationTokens: 150,
        appName: 'test',
      });
      const data = aiResponseToNrEvent(event);
      expect(data['gen_ai.usage.cache_creation.input_tokens']).toBe(150);
    });

    it('Anthropic: gen_ai.usage.input_tokens sums inputTokens + cache tokens (disjoint semantics)', () => {
      // Anthropic: input_tokens = fresh only; cache tokens are disjoint.
      const event = createAiResponse({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        durationMs: 100,
        inputTokens: 1000,
        cacheReadTokens: 600,
        cacheCreationTokens: 0,
        outputTokens: 50,
        appName: 'test',
      });
      const data = aiResponseToNrEvent(event);
      expect(data['gen_ai.usage.input_tokens']).toBe(1600); // 1000 + 600
    });

    it('Gemini: gen_ai.usage.input_tokens uses inputTokens only (cache is a subset, not additive)', () => {
      // Gemini: promptTokenCount (inputTokens=1000) already includes cached content;
      // cachedContentTokenCount (cacheReadTokens=600) is a subset — NOT additive.
      const event = createAiResponse({
        provider: 'google',
        model: 'gemini-2.0-flash',
        durationMs: 100,
        inputTokens: 1000,
        cacheReadTokens: 600,
        outputTokens: 50,
        appName: 'test',
      });
      const data = aiResponseToNrEvent(event);
      expect(data['gen_ai.usage.input_tokens']).toBe(1000); // NOT 1600
    });

    it('OpenAI: gen_ai.usage.input_tokens uses inputTokens only (cached_tokens is a subset)', () => {
      // OpenAI: prompt_tokens (inputTokens=1000) includes cached portion;
      // cached_tokens (cacheReadTokens=400) is a subset — NOT additive.
      const event = createAiResponse({
        provider: 'openai',
        model: 'gpt-4o',
        durationMs: 100,
        inputTokens: 1000,
        cacheReadTokens: 400,
        outputTokens: 50,
        appName: 'test',
      });
      const data = aiResponseToNrEvent(event);
      expect(data['gen_ai.usage.input_tokens']).toBe(1000); // NOT 1400
    });

    it('emits gen_ai.response.finish_reason when stopReason is set', () => {
      const event = createAiResponse({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        durationMs: 100,
        inputTokens: 10,
        outputTokens: 10,
        stopReason: 'end_turn',
        appName: 'test',
      });
      const data = aiResponseToNrEvent(event);
      expect(data['gen_ai.response.finish_reason']).toBe('end_turn');
    });

    it('emits gen_ai.response.model', () => {
      const event = createAiResponse({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        durationMs: 100,
        inputTokens: 10,
        outputTokens: 10,
        appName: 'test',
      });
      const data = aiResponseToNrEvent(event);
      expect(data['gen_ai.response.model']).toBe('claude-sonnet-4-6');
    });

    // Per OTel SemConv, input_tokens MUST include cache
    // tokens (notes [16][17]) and output_tokens MUST include reasoning (note [19]).
    it('sums cache_read + cache_creation into gen_ai.usage.input_tokens', () => {
      const event = createAiResponse({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        durationMs: 100,
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 500,
        cacheCreationTokens: 200,
        appName: 'test',
      });
      const data = aiResponseToNrEvent(event);
      expect(data['gen_ai.usage.input_tokens']).toBe(800); // 100 + 500 + 200
      // The disjoint sub-attributes should also be present per spec
      expect(data['gen_ai.usage.cache_read.input_tokens']).toBe(500);
      expect(data['gen_ai.usage.cache_creation.input_tokens']).toBe(200);
    });

    it('sums reasoning into gen_ai.usage.output_tokens', () => {
      const event = createAiResponse({
        provider: 'google',
        model: 'gemini-2.5-pro',
        durationMs: 100,
        inputTokens: 10,
        outputTokens: 50,
        thinkingTokens: 200,
        appName: 'test',
      });
      const data = aiResponseToNrEvent(event);
      expect(data['gen_ai.usage.output_tokens']).toBe(250); // 50 + 200
      expect(data['gen_ai.usage.reasoning.output_tokens']).toBe(200);
    });

    it('does NOT add reasoning into gen_ai.usage.output_tokens for OpenAI', () => {
      // For OpenAI o1/o3/o4-mini, reasoning_tokens is already inside
      // completion_tokens, so gen_ai.usage.output_tokens should equal
      // outputTokens alone. gen_ai.usage.reasoning.output_tokens is still
      // emitted as an informational breakdown.
      const event = createAiResponse({
        provider: 'openai',
        model: 'o1',
        durationMs: 100,
        inputTokens: 100,
        outputTokens: 500,
        thinkingTokens: 300, // subset of outputTokens for OpenAI
        appName: 'test',
      });
      const data = aiResponseToNrEvent(event);
      expect(data['gen_ai.usage.output_tokens']).toBe(500); // outputTokens only, NOT 800
      expect(data['gen_ai.usage.reasoning.output_tokens']).toBe(300); // informational breakdown
    });
  });
});

describe('aiAntiPatternToNrEvent', () => {
  function makeAntiPattern(overrides: Partial<AiAntiPattern> = {}): AiAntiPattern {
    return {
      id: 'ap-1',
      timestamp: 1700000000000,
      traceId: 'trace-1',
      patternType: 'spinning_wheels',
      severity: 'medium',
      description: 'Repeating the same tool call without progress',
      'nr.appName': 'my-app',
      'nr.entityGuid': null,
      customAttributes: {},
      ...overrides,
    };
  }

  it('serializes patternType under the patternType key, not type', () => {
    const event = makeAntiPattern({ patternType: 'overthinking' });
    const nrEvent = aiAntiPatternToNrEvent(event);

    // `type` is reserved/conventional in the NR Events API surface and
    // collides with NR's own attribute. The serializer must use `patternType`.
    expect(nrEvent.patternType).toBe('overthinking');
    expect(nrEvent).not.toHaveProperty('type');
  });

  it('produces only flat string/number/boolean values', () => {
    const event = makeAntiPattern({
      toolName: 'search',
      repeatCount: 5,
      depthIndex: 2,
      taskComplexity: 'complex',
      contextPressure: 0.85,
      tokenShare: 0.4,
      attemptCount: 3,
      customAttributes: { team: 'backend', score: 7 },
    });
    const nrEvent = aiAntiPatternToNrEvent(event);

    for (const value of Object.values(nrEvent)) {
      expect(['string', 'number', 'boolean']).toContain(typeof value);
    }

    expect(nrEvent.eventType).toBe('AiAntiPattern');
    expect(nrEvent.id).toBe('ap-1');
    expect(nrEvent.severity).toBe('medium');
    expect(nrEvent.toolName).toBe('search');
    expect(nrEvent.repeatCount).toBe(5);
    expect(nrEvent['custom.team']).toBe('backend');
    expect(nrEvent['custom.score']).toBe(7);
  });
});

describe('highSecurity customAttributes clipping', () => {
  // customAttributes is the one channel that lets a caller smuggle
  // arbitrary string content into telemetry. In high-security mode we clip
  // every string custom attribute to 256 UTF-8 BYTES so a misuse like
  // `customAttributes: { lastUserMessage: <whole prompt> }` cannot exfiltrate
  // content. Numbers pass through unchanged.

  const longString = 'x'.repeat(500);

  it('clips long string customAttributes to 256 bytes on aiRequestToNrEvent', () => {
    const event = createAiRequest({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      requestMethod: 'messages.create',
      messageCount: 1,
      streamingEnabled: false,
      appName: 'test',
      customAttributes: { longField: longString },
    });

    const clipped = aiRequestToNrEvent(event, { highSecurity: true });
    expect(typeof clipped['custom.longField']).toBe('string');
    expect(Buffer.byteLength(clipped['custom.longField'] as string, 'utf8')).toBeLessThanOrEqual(
      256,
    );
    expect((clipped['custom.longField'] as string).endsWith('...')).toBe(true);

    // Default mode: passes through unchanged.
    const unclipped = aiRequestToNrEvent(event);
    expect((unclipped['custom.longField'] as string).length).toBe(500);
  });

  it('clips long string customAttributes to 256 bytes on aiResponseToNrEvent', () => {
    const event = createAiResponse({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      durationMs: 100,
      inputTokens: 10,
      outputTokens: 10,
      appName: 'test',
      customAttributes: { longField: longString },
    });

    const clipped = aiResponseToNrEvent(event, { highSecurity: true });
    expect(Buffer.byteLength(clipped['custom.longField'] as string, 'utf8')).toBeLessThanOrEqual(
      256,
    );
    expect((clipped['custom.longField'] as string).endsWith('...')).toBe(true);
  });

  it('clips long string customAttributes to 256 bytes on aiAntiPatternToNrEvent', () => {
    const event: AiAntiPattern = {
      id: 'ap-1',
      timestamp: 1700000000000,
      traceId: 'trace-1',
      patternType: 'spinning_wheels',
      severity: 'medium',
      description: 'Repeating',
      'nr.appName': 'my-app',
      'nr.entityGuid': null,
      customAttributes: { longField: longString },
    };

    const clipped = aiAntiPatternToNrEvent(event, { highSecurity: true });
    expect(Buffer.byteLength(clipped['custom.longField'] as string, 'utf8')).toBeLessThanOrEqual(
      256,
    );
    expect((clipped['custom.longField'] as string).endsWith('...')).toBe(true);
  });

  it('high-security byte cap honors multi-byte CJK content', () => {
    // CJK chars are 3 bytes each; a 200-char CJK string = 600 bytes — over the 256-byte cap.
    const cjkString = '中'.repeat(200);
    const event = createAiRequest({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      requestMethod: 'messages.create',
      messageCount: 1,
      streamingEnabled: false,
      appName: 'test',
      customAttributes: { cjkField: cjkString },
    });
    const clipped = aiRequestToNrEvent(event, { highSecurity: true });
    expect(Buffer.byteLength(clipped['custom.cjkField'] as string, 'utf8')).toBeLessThanOrEqual(
      256,
    );
    expect((clipped['custom.cjkField'] as string).endsWith('...')).toBe(true);
  });

  it('passes numeric customAttributes through unchanged in highSecurity mode', () => {
    const event = createAiRequest({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      requestMethod: 'messages.create',
      messageCount: 1,
      streamingEnabled: false,
      appName: 'test',
      customAttributes: { score: 42, ratio: 0.85 },
    });

    const clipped = aiRequestToNrEvent(event, { highSecurity: true });
    expect(clipped['custom.score']).toBe(42);
    expect(clipped['custom.ratio']).toBe(0.85);
  });

  it('leaves short string customAttributes unchanged in highSecurity mode', () => {
    const event = createAiRequest({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      requestMethod: 'messages.create',
      messageCount: 1,
      streamingEnabled: false,
      appName: 'test',
      customAttributes: { team: 'backend' },
    });

    const clipped = aiRequestToNrEvent(event, { highSecurity: true });
    expect(clipped['custom.team']).toBe('backend');
  });

  it('does not clip when options omitted or highSecurity is false', () => {
    const event = createAiRequest({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      requestMethod: 'messages.create',
      messageCount: 1,
      streamingEnabled: false,
      appName: 'test',
      customAttributes: { longField: longString },
    });

    expect((aiRequestToNrEvent(event)['custom.longField'] as string).length).toBe(500);
    expect((aiRequestToNrEvent(event, {})['custom.longField'] as string).length).toBe(500);
    expect(
      (aiRequestToNrEvent(event, { highSecurity: false })['custom.longField'] as string).length,
    ).toBe(500);
  });
});

describe('normal-mode customAttributes truncation', () => {
  // NR Events API rejects or silently truncates events whose attribute
  // values exceed 4096 bytes. Even outside high-security mode, string custom
  // attributes must be truncated at 4000 chars so a long attribute cannot
  // accidentally drop the event the caller is trying to record.
  const huge = 'x'.repeat(10_000);

  it('truncates long string customAttributes to 4096 bytes in normal mode', () => {
    const event = createAiRequest({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      requestMethod: 'messages.create',
      messageCount: 1,
      streamingEnabled: false,
      appName: 'test',
      customAttributes: { hugeField: huge },
    });

    const out = aiRequestToNrEvent(event)['custom.hugeField'] as string;
    // ASCII: byte length = char length. Output should be exactly 4096 bytes.
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(4096);
    expect(out.endsWith('...')).toBe(true);
  });

  it('truncates long string customAttributes to 4096 bytes when highSecurity is false', () => {
    const event = createAiRequest({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      requestMethod: 'messages.create',
      messageCount: 1,
      streamingEnabled: false,
      appName: 'test',
      customAttributes: { hugeField: huge },
    });

    const out = aiRequestToNrEvent(event, { highSecurity: false })['custom.hugeField'] as string;
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(4096);
    expect(out.endsWith('...')).toBe(true);
  });

  it('byte-truncation handles multi-byte (CJK) customAttribute strings within NR byte cap', () => {
    // CJK chars are 3 bytes each; a 2000-char CJK string = 6000 bytes — over cap.
    const cjkString = '中'.repeat(2000); // 6000 UTF-8 bytes
    const event = createAiRequest({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      requestMethod: 'messages.create',
      messageCount: 1,
      streamingEnabled: false,
      appName: 'test',
      customAttributes: { cjkField: cjkString },
    });
    const out = aiRequestToNrEvent(event)['custom.cjkField'] as string;
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(4096);
    expect(out.endsWith('...')).toBe(true);
  });

  it('passes numeric customAttributes through unchanged in normal mode', () => {
    const event = createAiRequest({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      requestMethod: 'messages.create',
      messageCount: 1,
      streamingEnabled: false,
      appName: 'test',
      customAttributes: { score: 42, ratio: 0.85 },
    });

    expect(aiRequestToNrEvent(event)['custom.score']).toBe(42);
    expect(aiRequestToNrEvent(event)['custom.ratio']).toBe(0.85);
  });

  it('high-security clip (256) takes precedence over normal-mode floor (4000)', () => {
    const event = createAiRequest({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      requestMethod: 'messages.create',
      messageCount: 1,
      streamingEnabled: false,
      appName: 'test',
      customAttributes: { hugeField: huge },
    });

    const hs = aiRequestToNrEvent(event, { highSecurity: true })['custom.hugeField'] as string;
    expect(Buffer.byteLength(hs, 'utf8')).toBeLessThanOrEqual(256);
    expect(hs.endsWith('...')).toBe(true);
  });
});

// Every serialized event stamps schemaVersion
describe('schemaVersion', () => {
  it('EVENT_SCHEMA_VERSION is exported and equals the current version', () => {
    expect(EVENT_SCHEMA_VERSION).toBe(1);
  });

  it('aiRequestToNrEvent stamps schemaVersion', () => {
    const event = createAiRequest({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      requestMethod: 'messages.create',
      messageCount: 1,
      streamingEnabled: false,
      appName: 'test',
      entityGuid: 'GUID',
    });
    expect(aiRequestToNrEvent(event).schemaVersion).toBe(EVENT_SCHEMA_VERSION);
  });

  it('aiResponseToNrEvent stamps schemaVersion', () => {
    const event = {
      id: 'r-1',
      timestamp: 1,
      provider: 'anthropic' as const,
      model: 'claude-sonnet-4-6',
      durationMs: 100,
      timeToFirstTokenMs: null,
      tokensPerSecond: null,
      inputTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      costInputUsd: null,
      costOutputUsd: null,
      costThinkingUsd: null,
      costCacheReadUsd: null,
      costCacheCreationUsd: null,
      costTotalUsd: null,
      stopReason: null,
      contentBlockTypes: [],
      error: null,
      'nr.appName': 'test',
      'nr.entityGuid': null,
      customAttributes: {},
    };
    expect(aiResponseToNrEvent(event).schemaVersion).toBe(EVENT_SCHEMA_VERSION);
  });
});

// RESERVED_KEYS deny-list on customAttributes
describe('RESERVED_KEYS enforcement on customAttributes', () => {
  it('drops customAttributes whose key collides with NR-reserved attributes', () => {
    const event = createAiRequest({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      requestMethod: 'messages.create',
      messageCount: 1,
      streamingEnabled: false,
      appName: 'test',
      customAttributes: {
        eventType: 'AiOverride',
        timestamp: 9999,
        accountId: 'acct-x',
        type: 'overridden',
        schemaVersion: 99,
      },
    });

    const out = aiRequestToNrEvent(event);
    // Reserved keys are dropped — they don't appear with the `custom.` prefix
    // either, since the deny-list runs before prefixing.
    expect(out).not.toHaveProperty('custom.eventType');
    expect(out).not.toHaveProperty('custom.timestamp');
    expect(out).not.toHaveProperty('custom.accountId');
    expect(out).not.toHaveProperty('custom.type');
    expect(out).not.toHaveProperty('custom.schemaVersion');
    // The top-level reserved attributes still hold their library-set values.
    expect(out.eventType).toBe('AiRequest');
    expect(out.schemaVersion).toBe(EVENT_SCHEMA_VERSION);
  });

  it('drops customAttributes keys in the nr.* and gen_ai.* internal namespaces', () => {
    const event = createAiRequest({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      requestMethod: 'messages.create',
      messageCount: 1,
      streamingEnabled: false,
      appName: 'test',
      customAttributes: {
        'nr.appName': 'override-app',
        'nr.entityGuid': 'override-guid',
        'gen_ai.system': 'override-system',
      },
    });

    const out = aiRequestToNrEvent(event);
    expect(out).not.toHaveProperty('custom.nr.appName');
    expect(out).not.toHaveProperty('custom.nr.entityGuid');
    expect(out).not.toHaveProperty('custom.gen_ai.system');
    // Library-set values still hold their canonical positions.
    expect(out['nr.appName']).toBe('test');
    expect(out['gen_ai.system']).toBe('anthropic');
  });

  it('passes through non-reserved customAttributes alongside dropped ones', () => {
    const event = createAiRequest({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      requestMethod: 'messages.create',
      messageCount: 1,
      streamingEnabled: false,
      appName: 'test',
      customAttributes: {
        eventType: 'dropped',
        team: 'backend',
        priority: 1,
      },
    });

    const out = aiRequestToNrEvent(event);
    expect(out).not.toHaveProperty('custom.eventType');
    expect(out['custom.team']).toBe('backend');
    expect(out['custom.priority']).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// aiAgentTaskSummaryToNrEvent
// ---------------------------------------------------------------------------
describe('aiAgentTaskSummaryToNrEvent', () => {
  const baseParams = {
    traceId: 'trace-abc',
    spanId: 'span-xyz',
    taskName: 'summarize-docs',
    durationMs: 5000,
    totalLlmCalls: 3,
    totalToolCalls: 2,
    totalTokens: 1500,
    totalCostUsd: 0.012,
    stepCount: 4,
    success: true,
    appName: 'test-app',
    entityGuid: 'entity-guid-1',
  };

  it('emits required attributes with correct values (happy path)', () => {
    const event = createAiAgentTaskSummary(baseParams);
    const out = aiAgentTaskSummaryToNrEvent(event);

    expect(out.eventType).toBe('AiAgentTaskSummary');
    expect(out.schemaVersion).toBe(EVENT_SCHEMA_VERSION);
    expect(out.taskName).toBe('summarize-docs');
    expect(out['ai.agent.task_duration_ms']).toBe(5000);
    expect(out['ai.agent.total_steps']).toBe(4);
    expect(out['ai.agent.llm_calls_per_task']).toBe(3);
    expect(out['ai.agent.tool_calls_per_task']).toBe(2);
    expect(out['ai.agent.tokens_per_task']).toBe(1500);
    expect(out['ai.agent.task_success']).toBe(true);
    expect(out['nr.appName']).toBe('test-app');
    expect(out['nr.entityGuid']).toBe('entity-guid-1');
  });

  it('emits ai.agent.cost_per_task_usd when totalCostUsd is non-null', () => {
    const out = aiAgentTaskSummaryToNrEvent(createAiAgentTaskSummary(baseParams));
    expect(out['ai.agent.cost_per_task_usd']).toBe(0.012);
  });

  it('omits ai.agent.cost_per_task_usd when totalCostUsd is null', () => {
    const out = aiAgentTaskSummaryToNrEvent(
      createAiAgentTaskSummary({ ...baseParams, totalCostUsd: null }),
    );
    expect(out).not.toHaveProperty('ai.agent.cost_per_task_usd');
  });

  it('emits optional delegation fields when present', () => {
    const out = aiAgentTaskSummaryToNrEvent(
      createAiAgentTaskSummary({
        ...baseParams,
        delegationCount: 2,
        spawnCount: 1,
        delegationDepth: 3,
        interAgentMessages: 5,
        delegationOverheadMs: 200,
      }),
    );
    expect(out['ai.agent.delegation_count']).toBe(2);
    expect(out['ai.agent.spawn_count']).toBe(1);
    expect(out['ai.agent.delegation_depth']).toBe(3);
    expect(out['ai.agent.inter_agent_messages']).toBe(5);
    expect(out['ai.agent.delegation_overhead_ms']).toBe(200);
  });

  it('omits delegation fields when absent', () => {
    const out = aiAgentTaskSummaryToNrEvent(createAiAgentTaskSummary(baseParams));
    expect(out).not.toHaveProperty('ai.agent.delegation_count');
    expect(out).not.toHaveProperty('ai.agent.spawn_count');
    expect(out).not.toHaveProperty('ai.agent.delegation_depth');
  });

  it('omits nr.entityGuid when entityGuid is null', () => {
    const out = aiAgentTaskSummaryToNrEvent(
      createAiAgentTaskSummary({ ...baseParams, entityGuid: null }),
    );
    expect(out).not.toHaveProperty('nr.entityGuid');
  });

  it('emits gen_ai.system when provider is set', () => {
    const out = aiAgentTaskSummaryToNrEvent(
      createAiAgentTaskSummary({ ...baseParams, provider: 'anthropic' }),
    );
    expect(out['gen_ai.system']).toBe('anthropic');
  });

  it('omits gen_ai.system when provider is absent', () => {
    const out = aiAgentTaskSummaryToNrEvent(createAiAgentTaskSummary(baseParams));
    expect(out).not.toHaveProperty('gen_ai.system');
  });
});

// ---------------------------------------------------------------------------
// aiAgentMessageToNrEvent
// ---------------------------------------------------------------------------
describe('aiAgentMessageToNrEvent', () => {
  const baseParams = {
    traceId: 'trace-msg',
    fromAgent: 'planner',
    toAgent: 'executor',
    messageType: 'task-delegation',
    appName: 'test-app',
    entityGuid: 'entity-guid-2',
  };

  it('emits required attributes with correct values (happy path)', () => {
    const event = createAiAgentMessage(baseParams);
    const out = aiAgentMessageToNrEvent(event);

    expect(out.eventType).toBe('AiAgentMessage');
    expect(out.schemaVersion).toBe(EVENT_SCHEMA_VERSION);
    expect(out.fromAgent).toBe('planner');
    expect(out.toAgent).toBe('executor');
    expect(out.messageType).toBe('task-delegation');
    expect(out['nr.appName']).toBe('test-app');
    expect(out['nr.entityGuid']).toBe('entity-guid-2');
  });

  it('emits tokenCount when provided', () => {
    const out = aiAgentMessageToNrEvent(createAiAgentMessage({ ...baseParams, tokenCount: 128 }));
    expect(out.tokenCount).toBe(128);
  });

  it('omits tokenCount when absent', () => {
    const out = aiAgentMessageToNrEvent(createAiAgentMessage(baseParams));
    expect(out).not.toHaveProperty('tokenCount');
  });

  it('omits nr.entityGuid when entityGuid is null', () => {
    const out = aiAgentMessageToNrEvent(createAiAgentMessage({ ...baseParams, entityGuid: null }));
    expect(out).not.toHaveProperty('nr.entityGuid');
  });

  it('emits gen_ai.system when provider is set', () => {
    const out = aiAgentMessageToNrEvent(
      createAiAgentMessage({ ...baseParams, provider: 'openai' }),
    );
    expect(out['gen_ai.system']).toBe('openai');
  });
});

// ---------------------------------------------------------------------------
// aiContextResetToNrEvent
// ---------------------------------------------------------------------------
describe('aiContextResetToNrEvent', () => {
  const baseParams = {
    traceId: 'trace-reset',
    conversationId: 'conv-abc',
    tokensBefore: 8000,
    tokensAfter: 2000,
    reason: 'summarization' as const,
    appName: 'test-app',
    entityGuid: 'entity-guid-3',
  };

  it('emits required attributes with correct values (happy path)', () => {
    const event = createAiContextReset(baseParams);
    const out = aiContextResetToNrEvent(event);

    expect(out.eventType).toBe('AiContextReset');
    expect(out.schemaVersion).toBe(EVENT_SCHEMA_VERSION);
    expect(out.conversationId).toBe('conv-abc');
    expect(out.tokensBefore).toBe(8000);
    expect(out.tokensAfter).toBe(2000);
    expect(out.tokensRemoved).toBe(6000);
    expect(out.reason).toBe('summarization');
    expect(out['nr.appName']).toBe('test-app');
    expect(out['nr.entityGuid']).toBe('entity-guid-3');
  });

  it('compressionRatio wire value is a number between 0 and 1', () => {
    const out = aiContextResetToNrEvent(createAiContextReset(baseParams));
    expect(typeof out.compressionRatio).toBe('number');
    expect(out.compressionRatio as number).toBeGreaterThanOrEqual(0);
    expect(out.compressionRatio as number).toBeLessThanOrEqual(1);
  });

  it('emits turnsRemoved when provided', () => {
    const out = aiContextResetToNrEvent(createAiContextReset({ ...baseParams, turnsRemoved: 5 }));
    expect(out.turnsRemoved).toBe(5);
  });

  it('omits turnsRemoved when absent', () => {
    const out = aiContextResetToNrEvent(createAiContextReset(baseParams));
    expect(out).not.toHaveProperty('turnsRemoved');
  });

  it('omits nr.entityGuid when entityGuid is null', () => {
    const out = aiContextResetToNrEvent(createAiContextReset({ ...baseParams, entityGuid: null }));
    expect(out).not.toHaveProperty('nr.entityGuid');
  });

  it('emits gen_ai.system when provider is set', () => {
    const out = aiContextResetToNrEvent(
      createAiContextReset({ ...baseParams, provider: 'google' }),
    );
    expect(out['gen_ai.system']).toBe('gcp.gemini');
  });
});
