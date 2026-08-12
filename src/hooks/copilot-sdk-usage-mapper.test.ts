import { afterEach, describe, expect, it } from '@jest/globals';
import {
  mapAssistantUsageEvent,
  resolveBufferPath,
  resolveStoragePath,
} from './copilot-sdk-usage-mapper.js';

describe('mapAssistantUsageEvent', () => {
  // Real assistant.usage payload captured live from a Copilot CLI session
  // (Phase 0 spike, 2026-08-12) — see /memories/session/copilot-sdk-usage-plan.md.
  it('maps a real captured event (first call, no cache reads)', () => {
    const data = {
      model: 'claude-opus-5',
      inputTokens: 40891,
      outputTokens: 134,
      cacheReadTokens: 0,
      cacheWriteTokens: 40889,
      reasoningTokens: 49,
      apiCallId: 'msg_011CdyNdWPfiRzEn1KTwuNp2',
    };
    const result = mapAssistantUsageEvent(data, 'sess-1', 1786561408464);
    expect(result).toEqual({
      mode: 'token',
      tool: 'copilot-sdk-usage',
      timestamp: 1786561408464,
      sessionId: 'sess-1',
      messageId: 'msg_011CdyNdWPfiRzEn1KTwuNp2',
      model: 'claude-opus-5',
      // 40891 - 0 - 40889 = 2 (matches the SDK's own tokenDetails "input" breakdown)
      inputTokens: 2,
      outputTokens: 134,
      cacheReadTokens: 0,
      cacheCreationTokens: 40889,
    });
  });

  it('maps a real captured event (second call, cache read + cache write both present)', () => {
    const data = {
      model: 'claude-opus-5',
      inputTokens: 44671,
      outputTokens: 109,
      cacheReadTokens: 40889,
      cacheWriteTokens: 3780,
      apiCallId: 'msg_011CdyNdqbpdxBtA68tir2pv',
    };
    const result = mapAssistantUsageEvent(data, 'sess-1', 1786561411655);
    // 44671 - 40889 - 3780 = 2 (matches the SDK's own tokenDetails "input" breakdown)
    expect(result).toMatchObject({
      inputTokens: 2,
      outputTokens: 109,
      cacheReadTokens: 40889,
      cacheCreationTokens: 3780,
      messageId: 'msg_011CdyNdqbpdxBtA68tir2pv',
    });
  });

  it('clamps inputTokens to 0 rather than going negative on inconsistent data', () => {
    const data = {
      model: 'gpt-5.4',
      inputTokens: 10,
      cacheReadTokens: 8,
      cacheWriteTokens: 8,
      apiCallId: 'msg_1',
    };
    const result = mapAssistantUsageEvent(data, 'sess-1', 1000);
    expect(result?.inputTokens).toBe(0);
  });

  it('defaults missing outputTokens/cacheReadTokens/cacheWriteTokens to 0', () => {
    const data = { model: 'gpt-5.4', inputTokens: 50, apiCallId: 'msg_1' };
    const result = mapAssistantUsageEvent(data, 'sess-1', 1000);
    expect(result).toMatchObject({
      inputTokens: 50,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it('returns null when model is missing (schema-drift safe, never crashes)', () => {
    const data = { inputTokens: 50, apiCallId: 'msg_1' };
    expect(mapAssistantUsageEvent(data, 'sess-1', 1000)).toBeNull();
  });

  it('returns null when apiCallId is missing (no stable dedup key)', () => {
    const data = { model: 'gpt-5.4', inputTokens: 50 };
    expect(mapAssistantUsageEvent(data, 'sess-1', 1000)).toBeNull();
  });

  it('returns null when data is not an object', () => {
    expect(mapAssistantUsageEvent(null, 'sess-1', 1000)).toBeNull();
    expect(mapAssistantUsageEvent('not an object', 'sess-1', 1000)).toBeNull();
    expect(mapAssistantUsageEvent(undefined, 'sess-1', 1000)).toBeNull();
  });

  it('coerces non-number token fields to 0 rather than propagating NaN', () => {
    const data = {
      model: 'gpt-5.4',
      inputTokens: 'not-a-number',
      outputTokens: null,
      apiCallId: 'msg_1',
    };
    const result = mapAssistantUsageEvent(data, 'sess-1', 1000);
    expect(result).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });
});

describe('resolveStoragePath', () => {
  const ORIGINAL_ENV = process.env.NEW_RELIC_AI_MCP_STORAGE_PATH;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.NEW_RELIC_AI_MCP_STORAGE_PATH;
    else process.env.NEW_RELIC_AI_MCP_STORAGE_PATH = ORIGINAL_ENV;
  });

  it('honors NEW_RELIC_AI_MCP_STORAGE_PATH when set', () => {
    process.env.NEW_RELIC_AI_MCP_STORAGE_PATH = '/custom/storage';
    expect(resolveStoragePath()).toBe('/custom/storage');
  });

  it('defaults to ~/.newrelic-preflight when unset', () => {
    delete process.env.NEW_RELIC_AI_MCP_STORAGE_PATH;
    expect(resolveStoragePath()).toMatch(/\.newrelic-preflight$/);
  });
});

describe('resolveBufferPath', () => {
  it('builds the standard buffer-<sessionId>.jsonl path', () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const path = resolveBufferPath('/storage', sessionId);
    expect(path).toBe('/storage/buffer-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl');
  });

  it('returns null for a sessionId containing path-traversal characters', () => {
    expect(resolveBufferPath('/storage', '../../etc/passwd')).toBeNull();
  });

  it('returns null for an empty sessionId', () => {
    expect(resolveBufferPath('/storage', '')).toBeNull();
  });
});
