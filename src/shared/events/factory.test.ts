import {
  createAiRequest,
  createAiResponse,
  createAiMessage,
  createAiAgentTaskSummary,
  createAiAntiPattern,
  createAiAgentMessage,
  createAiContextReset,
  __resetEntityGuidWarning,
} from './factory.js';

// Reset the warn-once flag before each test so module state does not leak
// across tests — any test that creates an event without entityGuid would
// otherwise silence the warning for all subsequent tests (§FAC3).
beforeEach(() => __resetEntityGuidWarning());

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('entityGuid warn-once (§FAC3)', () => {
  it('warns exactly once for missing entityGuid across multiple factory calls', () => {
    const stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const base = {
      provider: 'anthropic' as const,
      model: 'm',
      requestMethod: 'messages.create' as const,
      messageCount: 1,
      streamingEnabled: false,
      appName: 'app',
    };
    createAiRequest(base); // no entityGuid → warn fires
    createAiRequest(base); // second call → suppressed
    const calls = stderrSpy.mock.calls.filter((c) => String(c[0]).includes('entityGuid'));
    expect(calls).toHaveLength(1);
    stderrSpy.mockRestore();
  });
});

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

  it('computes totalTokens WITHOUT cache tokens for Google (cache is subset, §EV2)', () => {
    // baseParams uses provider:'google' — inputTokens already includes cached tokens,
    // so cacheReadTokens are NOT added again to avoid double-counting.
    const event = createAiResponse({
      ...baseParams,
      thinkingTokens: 200,
      cacheReadTokens: 30,
      cacheCreationTokens: 20,
    });
    expect(event.totalTokens).toBe(350); // 100 + 50 + 200 (cache tokens NOT added for Google)
  });

  it('computes totalTokens WITH cache tokens for Anthropic (cache is disjoint, §EV2)', () => {
    // For Anthropic, inputTokens is fresh-only and cache tokens are additive.
    const event = createAiResponse({
      ...baseParams,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
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

  // CODE_REVIEW §6.5 — token field sanitization
  it('coerces NaN/Infinity/negative token counts to 0', () => {
    const event = createAiResponse({
      ...baseParams,
      inputTokens: NaN,
      outputTokens: Infinity,
      thinkingTokens: -50,
      cacheReadTokens: 5.7, // floats floor to 5
      cacheCreationTokens: undefined as unknown as number,
    });

    expect(event.inputTokens).toBe(0);
    expect(event.outputTokens).toBe(0);
    expect(event.thinkingTokens).toBe(0);
    expect(event.cacheReadTokens).toBe(5);
    expect(event.cacheCreationTokens).toBe(0);
    // baseParams uses provider:'google' — cache tokens are NOT added to totalTokens (§EV2)
    expect(event.totalTokens).toBe(0);
  });

  it('coerces NaN/Infinity cost fields to null (§F1)', () => {
    const event = createAiResponse({
      ...baseParams,
      costInputUsd: NaN,
      costOutputUsd: Infinity,
      costTotalUsd: -Infinity,
      costThinkingUsd: NaN,
      costCacheReadUsd: Infinity,
      costCacheCreationUsd: -Infinity,
    });
    expect(event.costInputUsd).toBeNull();
    expect(event.costOutputUsd).toBeNull();
    expect(event.costTotalUsd).toBeNull();
    expect(event.costThinkingUsd).toBeNull();
    expect(event.costCacheReadUsd).toBeNull();
    expect(event.costCacheCreationUsd).toBeNull();
  });

  it('treats malformed durationMs as 0 (tokensPerSecond → null)', () => {
    const event = createAiResponse({
      ...baseParams,
      durationMs: NaN,
      outputTokens: 100,
    });
    expect(event.durationMs).toBe(0);
    expect(event.tokensPerSecond).toBeNull();
  });

  it('coerces negative durationMs to 0 (§FAC1)', () => {
    const event = createAiResponse({ ...baseParams, durationMs: -100, outputTokens: 50 });
    expect(event.durationMs).toBe(0);
    expect(event.tokensPerSecond).toBeNull();
  });

  it('coerces invalid timeToFirstTokenMs values to null (§FAC2)', () => {
    const nan = createAiResponse({ ...baseParams, timeToFirstTokenMs: NaN });
    expect(nan.timeToFirstTokenMs).toBeNull();

    const neg = createAiResponse({ ...baseParams, timeToFirstTokenMs: -50 });
    expect(neg.timeToFirstTokenMs).toBeNull();

    const inf = createAiResponse({ ...baseParams, timeToFirstTokenMs: Infinity });
    expect(inf.timeToFirstTokenMs).toBeNull();

    const valid = createAiResponse({ ...baseParams, timeToFirstTokenMs: 200 });
    expect(valid.timeToFirstTokenMs).toBe(200);
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

  // CODE_REVIEW §6.13 — required-field validation made uniform across
  // the three factory functions; null/undefined `content` is rejected
  // (empty string is allowed: an empty assistant response is a valid record).
  it('throws on null content', () => {
    expect(() => createAiMessage({ ...baseParams, content: null as unknown as string })).toThrow(
      'AiMessage requires content',
    );
  });

  it('throws on undefined content', () => {
    expect(() =>
      createAiMessage({ ...baseParams, content: undefined as unknown as string }),
    ).toThrow('AiMessage requires content');
  });

  it('accepts empty-string content (deliberately-empty response is valid)', () => {
    const event = createAiMessage({ ...baseParams, content: '' });
    expect(event.content).toBe('');
  });
});

// CODE_REVIEW §6.15 — factory functions for the four newer event types
describe('createAiAgentTaskSummary (CODE_REVIEW §6.15)', () => {
  const base = {
    traceId: 'trace-1',
    spanId: 'span-1',
    taskName: 'render-page',
    durationMs: 1234,
    totalLlmCalls: 3,
    totalToolCalls: 5,
    totalTokens: 8000,
    stepCount: 7,
    success: true,
    appName: 'test-app',
  };

  it('produces a fully-populated event with defaults', () => {
    const e = createAiAgentTaskSummary(base);
    expect(e.id).toBeTruthy();
    expect(e.timestamp).toBeGreaterThan(0);
    expect(e.taskName).toBe('render-page');
    expect(e.totalCostUsd).toBeNull();
    expect(e['nr.appName']).toBe('test-app');
    expect(e.customAttributes).toEqual({});
  });

  it('safeInt-coerces NaN/Infinity numeric fields to zero', () => {
    const e = createAiAgentTaskSummary({ ...base, totalTokens: NaN, durationMs: Infinity });
    expect(e.totalTokens).toBe(0);
    expect(e.durationMs).toBe(0);
  });

  it('coerces NaN/Infinity totalCostUsd to null (§F1)', () => {
    const e = createAiAgentTaskSummary({ ...base, totalCostUsd: NaN });
    expect(e.totalCostUsd).toBeNull();
  });

  it.each([
    ['traceId', 'AiAgentTaskSummary requires a traceId'],
    ['spanId', 'AiAgentTaskSummary requires a spanId'],
    ['taskName', 'AiAgentTaskSummary requires a taskName'],
    ['appName', 'AiAgentTaskSummary requires an appName'],
  ])('throws when %s is empty', (field, msg) => {
    expect(() => createAiAgentTaskSummary({ ...base, [field]: '' })).toThrow(msg);
  });
});

describe('createAiAntiPattern (CODE_REVIEW §6.15)', () => {
  const base = {
    traceId: 'trace-1',
    patternType: 'overthinking' as const,
    severity: 'medium' as const,
    description: 'Agent re-read the same file 5 times',
    appName: 'test-app',
  };

  it('produces a fully-populated event with defaults', () => {
    const e = createAiAntiPattern(base);
    expect(e.id).toBeTruthy();
    expect(e.patternType).toBe('overthinking');
    expect(e.severity).toBe('medium');
    expect(e['nr.appName']).toBe('test-app');
  });

  it.each([
    ['traceId', 'AiAntiPattern requires a traceId'],
    ['patternType', 'AiAntiPattern requires a patternType'],
    ['severity', 'AiAntiPattern requires a severity'],
    ['description', 'AiAntiPattern requires a description'],
    ['appName', 'AiAntiPattern requires an appName'],
  ])('throws when %s is empty', (field, msg) => {
    expect(() => createAiAntiPattern({ ...base, [field]: '' as unknown as never })).toThrow(msg);
  });

  it('coerces NaN/Infinity contextPressure and tokenShare to null (§F1)', () => {
    const e = createAiAntiPattern({ ...base, contextPressure: NaN, tokenShare: Infinity });
    expect(e.contextPressure).toBeNull();
    expect(e.tokenShare).toBeNull();
  });
});

describe('createAiAgentMessage (CODE_REVIEW §6.15)', () => {
  const base = {
    traceId: 'trace-1',
    fromAgent: 'planner',
    toAgent: 'executor',
    messageType: 'task-handoff',
    appName: 'test-app',
  };

  it('produces a fully-populated event with defaults', () => {
    const e = createAiAgentMessage(base);
    expect(e.id).toBeTruthy();
    expect(e.fromAgent).toBe('planner');
    expect(e.toAgent).toBe('executor');
    expect(e.tokenCount).toBeUndefined();
  });

  it('safeInt-coerces tokenCount when provided', () => {
    const e = createAiAgentMessage({ ...base, tokenCount: NaN });
    expect(e.tokenCount).toBe(0);
  });

  it.each([
    ['traceId', 'AiAgentMessage requires a traceId'],
    ['fromAgent', 'AiAgentMessage requires a fromAgent'],
    ['toAgent', 'AiAgentMessage requires a toAgent'],
    ['messageType', 'AiAgentMessage requires a messageType'],
    ['appName', 'AiAgentMessage requires an appName'],
  ])('throws when %s is empty', (field, msg) => {
    expect(() => createAiAgentMessage({ ...base, [field]: '' })).toThrow(msg);
  });
});

describe('createAiContextReset (CODE_REVIEW §6.15)', () => {
  const base = {
    traceId: 'trace-1',
    conversationId: 'conv-1',
    tokensBefore: 10000,
    tokensAfter: 4000,
    reason: 'summarization' as const,
    appName: 'test-app',
  };

  it('computes tokensRemoved + compressionRatio from the inputs', () => {
    const e = createAiContextReset(base);
    expect(e.tokensRemoved).toBe(6000);
    expect(e.compressionRatio).toBeCloseTo(0.4);
  });

  it('clamps tokensRemoved at zero when after > before (defensive)', () => {
    const e = createAiContextReset({ ...base, tokensBefore: 100, tokensAfter: 200 });
    expect(e.tokensRemoved).toBe(0);
  });

  it('returns compressionRatio of 1.0 for empty-input reset (tokensBefore === 0) — identity, not compression (§F2)', () => {
    const e = createAiContextReset({ ...base, tokensBefore: 0, tokensAfter: 0 });
    expect(e.compressionRatio).toBe(1);
  });

  it('allows compressionRatio > 1 (post-reset tokens exceed pre-reset) without clamping (§F2)', () => {
    const e = createAiContextReset({ ...base, tokensBefore: 100, tokensAfter: 150 });
    expect(e.compressionRatio).toBeCloseTo(1.5);
    expect(e.tokensRemoved).toBe(0); // still clamped at 0 (can't remove negative)
  });

  it.each([
    ['traceId', 'AiContextReset requires a traceId'],
    ['conversationId', 'AiContextReset requires a conversationId'],
    ['reason', 'AiContextReset requires a reason'],
    ['appName', 'AiContextReset requires an appName'],
  ])('throws when %s is empty', (field, msg) => {
    expect(() => createAiContextReset({ ...base, [field]: '' as unknown as never })).toThrow(msg);
  });
});
