import { describe, expect, it } from '@jest/globals';

import type { SubagentTurnEvent } from '../hooks/event-processor.js';
import type { TokenEvent } from '../storage/types.js';
import { CostTracker } from './cost-tracker.js';
import { tokenUsageFromSubagentTurn, tokenUsageFromTokenEvent } from './token-usage.js';

function makeTokenEvent(overrides?: Partial<TokenEvent>): TokenEvent {
  return {
    mode: 'token',
    timestamp: 1_700_000_000_000,
    sessionId: 'session-1',
    model: 'claude-fable-5',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 1_000_000,
    ...overrides,
  } as TokenEvent;
}

function makeSubagentTurn(overrides?: Partial<SubagentTurnEvent>): SubagentTurnEvent {
  return {
    timestampMs: 1_700_000_000_000,
    parentSessionId: 'session-1',
    agentId: 'agent-1',
    workflowRunId: null,
    messageId: 'msg_1',
    turnUuid: 'uuid-1',
    model: 'claude-fable-5',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 1_000_000,
    reasoningTokens: 0,
    stopReason: null,
    schemaFingerprint: 'fp',
    toolUseIds: [],
    ...overrides,
  };
}

describe('tokenUsageFromTokenEvent', () => {
  it('carries the 1-hour cache write count into the session cost', () => {
    const usage = tokenUsageFromTokenEvent(makeTokenEvent({ cacheCreation1hTokens: 1_000_000 }));
    expect(usage.cacheCreation1hTokens).toBe(1_000_000);
    expect(new CostTracker().recordTokenUsage(usage, 'claude-fable-5').totalUsd).toBe(20);
  });

  it('omits the field when the event has none and prices at the 5-minute rate', () => {
    const usage = tokenUsageFromTokenEvent(makeTokenEvent());
    expect('cacheCreation1hTokens' in usage).toBe(false);
    expect(new CostTracker().recordTokenUsage(usage, 'claude-fable-5').totalUsd).toBe(12.5);
  });
});

describe('tokenUsageFromSubagentTurn', () => {
  it('carries the 1-hour cache write count into the session cost', () => {
    const usage = tokenUsageFromSubagentTurn(
      makeSubagentTurn({ cacheCreation1hTokens: 1_000_000 }),
    );
    expect(usage.cacheCreation1hTokens).toBe(1_000_000);
    expect(new CostTracker().recordTokenUsage(usage, 'claude-fable-5').totalUsd).toBe(20);
  });

  it('omits the field when the turn has none and prices at the 5-minute rate', () => {
    const usage = tokenUsageFromSubagentTurn(makeSubagentTurn());
    expect('cacheCreation1hTokens' in usage).toBe(false);
    expect(new CostTracker().recordTokenUsage(usage, 'claude-fable-5').totalUsd).toBe(12.5);
  });

  it('maps reasoning tokens to thinking and totals every bucket', () => {
    const usage = tokenUsageFromSubagentTurn(
      makeSubagentTurn({
        inputTokens: 1,
        outputTokens: 2,
        reasoningTokens: 3,
        cacheReadTokens: 4,
        cacheCreationTokens: 5,
      }),
    );
    expect([usage.thinkingTokens, usage.totalTokens]).toEqual([3, 15]);
  });
});
