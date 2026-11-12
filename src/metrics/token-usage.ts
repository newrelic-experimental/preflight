import type { TokenUsage } from '../shared/index.js';
import type { SubagentTurnEvent } from '../hooks/event-processor.js';
import type { TokenEvent } from '../storage/types.js';

export function tokenUsageFromTokenEvent(event: TokenEvent): TokenUsage {
  return {
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    thinkingTokens: 0,
    cacheReadTokens: event.cacheReadTokens,
    cacheCreationTokens: event.cacheCreationTokens,
    ...(event.cacheCreation1hTokens !== undefined && {
      cacheCreation1hTokens: event.cacheCreation1hTokens,
    }),
    totalTokens: event.inputTokens + event.outputTokens,
  };
}

export function tokenUsageFromSubagentTurn(turn: SubagentTurnEvent): TokenUsage {
  return {
    inputTokens: turn.inputTokens,
    outputTokens: turn.outputTokens,
    // Subagent reasoning tokens (extended thinking) live under
    // `output_tokens_details.reasoning_tokens`; map to `thinkingTokens`
    // so the existing `thinkingPerMTok` rate column charges correctly.
    thinkingTokens: turn.reasoningTokens,
    cacheReadTokens: turn.cacheReadTokens,
    cacheCreationTokens: turn.cacheCreationTokens,
    ...(turn.cacheCreation1hTokens !== undefined && {
      cacheCreation1hTokens: turn.cacheCreation1hTokens,
    }),
    totalTokens:
      turn.inputTokens +
      turn.outputTokens +
      turn.reasoningTokens +
      turn.cacheReadTokens +
      turn.cacheCreationTokens,
  };
}
