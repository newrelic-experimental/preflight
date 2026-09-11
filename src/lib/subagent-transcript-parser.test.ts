import { parseAssistantTurnLine, num } from './subagent-transcript-parser.js';

function makeLine(overrides: {
  type?: string;
  uuid?: string;
  timestamp?: string | null;
  message?: Record<string, unknown> | null;
}): string {
  const base = {
    type: 'assistant',
    uuid: 'turn-uuid-1',
    timestamp: '2026-06-15T12:00:00.000Z',
    message: {
      id: 'msg_1',
      model: 'claude-opus-4-7',
      stop_reason: 'end_turn',
      content: [{ type: 'text' }],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 200,
      },
    },
    ...overrides,
  };
  if (overrides.timestamp === null) delete (base as Record<string, unknown>).timestamp;
  if (overrides.message === null) delete (base as Record<string, unknown>).message;
  return JSON.stringify(base);
}

describe('parseAssistantTurnLine', () => {
  it('extracts all fields from a well-formed assistant turn with usage', () => {
    const { fields, invalidJson } = parseAssistantTurnLine(makeLine({}));
    expect(invalidJson).toBe(false);
    expect(fields).toEqual({
      messageId: 'msg_1',
      model: 'claude-opus-4-7',
      turnUuid: 'turn-uuid-1',
      rawTimestamp: '2026-06-15T12:00:00.000Z',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 1000,
      cacheCreationTokens: 200,
      reasoningTokens: 0,
      stopReason: 'end_turn',
      usageKeysFingerprint: expect.any(String),
      contentBlockTypesFingerprint: expect.any(String),
    });
  });

  it('extracts reasoning_tokens from output_tokens_details', () => {
    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'u',
      timestamp: '2026-06-15T12:00:00.000Z',
      message: {
        id: 'msg_r',
        model: 'claude-opus-4-7',
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          output_tokens_details: { reasoning_tokens: 750 },
        },
      },
    });
    const { fields } = parseAssistantTurnLine(line);
    expect(fields?.reasoningTokens).toBe(750);
  });

  it('flags invalidJson on malformed JSON, without throwing', () => {
    const result = parseAssistantTurnLine('NOT_VALID_JSON{{{');
    expect(result.invalidJson).toBe(true);
    expect(result.fields).toBeNull();
  });

  it('returns fields:null, invalidJson:false for a non-assistant type', () => {
    const line = JSON.stringify({ type: 'user', message: { id: 'x' } });
    const result = parseAssistantTurnLine(line);
    expect(result.fields).toBeNull();
    expect(result.invalidJson).toBe(false);
  });

  it('returns fields:null for a missing message object', () => {
    const line = JSON.stringify({ type: 'assistant' });
    const result = parseAssistantTurnLine(line);
    expect(result.fields).toBeNull();
    expect(result.invalidJson).toBe(false);
  });

  it('returns fields:null for a missing/non-object usage', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { id: 'msg_1', model: 'claude-opus-4-7' },
    });
    const result = parseAssistantTurnLine(line);
    expect(result.fields).toBeNull();
  });

  it('passes through model:null (not rejected) when model is missing', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { id: 'msg_1', usage: { input_tokens: 1, output_tokens: 1 } },
    });
    const { fields } = parseAssistantTurnLine(line);
    expect(fields?.model).toBeNull();
  });

  it('passes through model:"<synthetic>" unfiltered (caller decides whether to reject)', () => {
    const line = makeLine({
      message: {
        id: 'msg_1',
        model: '<synthetic>',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    const { fields } = parseAssistantTurnLine(line);
    expect(fields?.model).toBe('<synthetic>');
  });

  it('passes through messageId:null (not rejected) when message.id is missing', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { model: 'claude-opus-4-7', usage: { input_tokens: 1, output_tokens: 1 } },
    });
    const { fields } = parseAssistantTurnLine(line);
    expect(fields?.messageId).toBeNull();
  });

  it('passes through rawTimestamp:null (not rejected) when timestamp is missing', () => {
    const line = makeLine({ timestamp: null });
    const { fields } = parseAssistantTurnLine(line);
    expect(fields?.rawTimestamp).toBeNull();
  });

  it('defaults turnUuid to "" when uuid is missing', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_1',
        model: 'claude-opus-4-7',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    const { fields } = parseAssistantTurnLine(line);
    expect(fields?.turnUuid).toBe('');
  });

  it('produces different usageKeysFingerprints for different usage-key shapes', () => {
    const a = parseAssistantTurnLine(makeLine({})).fields?.usageKeysFingerprint;
    const line2 = JSON.stringify({
      type: 'assistant',
      uuid: 'u',
      timestamp: '2026-06-15T12:00:00.000Z',
      message: {
        id: 'msg_2',
        model: 'claude-opus-4-7',
        usage: { input_tokens: 1, output_tokens: 1, brand_new_key: 5 },
      },
    });
    const b = parseAssistantTurnLine(line2).fields?.usageKeysFingerprint;
    expect(a).not.toBe(b);
  });

  it('produces a different usageKeysFingerprint when an output_tokens_details child key changes', () => {
    const withReasoning = JSON.stringify({
      type: 'assistant',
      uuid: 'u',
      timestamp: '2026-06-15T12:00:00.000Z',
      message: {
        id: 'msg_otd',
        model: 'claude-opus-4-7',
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          output_tokens_details: { reasoning_tokens: 5 },
        },
      },
    });
    const withoutReasoning = JSON.stringify({
      type: 'assistant',
      uuid: 'u',
      timestamp: '2026-06-15T12:00:00.000Z',
      message: {
        id: 'msg_otd2',
        model: 'claude-opus-4-7',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    const a = parseAssistantTurnLine(withReasoning).fields?.usageKeysFingerprint;
    const b = parseAssistantTurnLine(withoutReasoning).fields?.usageKeysFingerprint;
    expect(a).not.toBe(b);
  });

  it('produces different contentBlockTypesFingerprints for different content-block shapes', () => {
    const a = parseAssistantTurnLine(makeLine({})).fields?.contentBlockTypesFingerprint;
    const line2 = JSON.stringify({
      type: 'assistant',
      uuid: 'u',
      timestamp: '2026-06-15T12:00:00.000Z',
      message: {
        id: 'msg_2',
        model: 'claude-opus-4-7',
        content: [{ type: 'tool_use' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    const b = parseAssistantTurnLine(line2).fields?.contentBlockTypesFingerprint;
    expect(a).not.toBe(b);
  });
});

describe('num', () => {
  it('returns 0 for non-numbers, NaN, and negatives', () => {
    expect(num(undefined)).toBe(0);
    expect(num('5')).toBe(0);
    expect(num(NaN)).toBe(0);
    expect(num(-1)).toBe(0);
  });

  it('returns the value for a finite non-negative number', () => {
    expect(num(42)).toBe(42);
    expect(num(0)).toBe(0);
  });
});
