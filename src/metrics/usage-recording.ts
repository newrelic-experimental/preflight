/**
 * Where a token report's cost goes once the hook pipeline has read it: the
 * process's CostTracker and model breakdown, and the per-session rollup that
 * an unscoped process persists. src/index.ts wires the event processor to
 * these, and the usage-ledger property test drives the same functions, so the
 * test exercises the wiring rather than a copy of it.
 */

import type { CostBreakdown } from '../shared/index.js';

import type { SubagentTurnEvent } from '../hooks/event-processor.js';
import type { TokenEvent } from '../storage/types.js';
import type { CostTracker } from './cost-tracker.js';
import type { LocalSessionAggregator } from './local-session-aggregator.js';
import type { ModelUsageTracker } from './model-usage-tracker.js';
import { tokenUsageFromSubagentTurn, tokenUsageFromTokenEvent } from './token-usage.js';

export interface UsageSinks {
  readonly costTracker: CostTracker;
  readonly modelUsageTracker: Pick<ModelUsageTracker, 'recordUsage'>;
  readonly localSessionAggregator: Pick<LocalSessionAggregator, 'recordTokenUsage'>;
}

/**
 * Records a parent-transcript (or Copilot) token report. `isOwnEvent` is false
 * for another session's report drained by a --stdio engine: that one is only
 * priced, for its own session's rollup (see `isTokenEventForThisProcess`).
 */
export function recordTokenEventUsage(
  sinks: UsageSinks,
  event: TokenEvent,
  isOwnEvent: boolean,
): CostBreakdown {
  const usage = tokenUsageFromTokenEvent(event);
  let breakdown: CostBreakdown;
  if (!isOwnEvent) {
    breakdown = sinks.costTracker.priceUsage(usage, event.model);
  } else {
    const result = sinks.costTracker.recordUsage(usage, event.model, {
      timestampMs: event.timestamp,
      replacesEstimates: true,
      ...(event.usageId !== undefined && { usageId: event.usageId }),
      ...(event.responseMs !== undefined && { responseMs: event.responseMs }),
    });
    breakdown = result.breakdown;
    // A call already in the ledger (a redelivered buffer line after a
    // restart) is not a new request for the model breakdown either.
    if (result.recorded)
      sinks.modelUsageTracker.recordUsage(event.model, usage, breakdown.totalUsd);
  }
  sinks.localSessionAggregator.recordTokenUsage(event.sessionId, {
    timestamp: event.timestamp,
    costUsd: breakdown.totalUsd,
    ...(event.usageId !== undefined && { usageId: event.usageId }),
    model: event.model,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cacheReadTokens: event.cacheReadTokens,
    cacheCreationTokens: event.cacheCreationTokens,
  });
  return breakdown;
}

/** Records a subagent transcript turn, keyed by its message id. */
export function recordSubagentTurnUsage(
  sinks: UsageSinks,
  turn: SubagentTurnEvent,
  agentType: string | undefined,
): CostBreakdown {
  const usage = tokenUsageFromSubagentTurn(turn);
  const { breakdown, recorded } = sinks.costTracker.recordUsage(usage, turn.model, {
    timestampMs: turn.timestampMs,
    workflowRunId: turn.workflowRunId,
    agentId: turn.agentId,
    ...(agentType !== undefined && { agentType }),
    usageId: turn.messageId,
  });
  // Subagent turns are real model requests and cost real money, so they
  // belong in the model breakdown too — recording them only in the cost
  // tracker left Model Usage blind to every subagent-only session.
  if (recorded) sinks.modelUsageTracker.recordUsage(turn.model, usage, breakdown.totalUsd);
  // The only line that makes an orphan session's subagent spend durable:
  // without it, an unscoped process's aggregator never learns about this
  // session's subagent cost and persistSession() has nothing to write.
  // `agentId` is the same discriminator CostTracker splits parent-vs-subagent
  // on, so the two trackers can't drift.
  sinks.localSessionAggregator.recordTokenUsage(turn.parentSessionId, {
    timestamp: turn.timestampMs,
    costUsd: breakdown.totalUsd,
    model: turn.model,
    inputTokens: turn.inputTokens,
    outputTokens: turn.outputTokens,
    cacheReadTokens: turn.cacheReadTokens,
    cacheCreationTokens: turn.cacheCreationTokens,
    thinkingTokens: turn.reasoningTokens,
    agentId: turn.agentId,
    usageId: turn.messageId,
  });
  return breakdown;
}
