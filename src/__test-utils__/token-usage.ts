import type { TokenUsage } from '../shared/tokens.js';

export function makeUsage(overrides?: Partial<TokenUsage>): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    ...overrides,
  };
}
