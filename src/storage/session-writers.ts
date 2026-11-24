import type { ByteEstimateLedger } from '../metrics/cost-tracker.js';
import { combineCallUsageByDay, subtractCallUsage } from '../metrics/call-usage.js';
import {
  addSummaries,
  byWriteOrder,
  exactTotalsOf,
  savedToolNameByUseId,
  type FullSessionSummary,
} from './session-store.js';

/**
 * One writer's own share of a session: only what this process drained, never a
 * total seeded from the saved file. Each process drains hook events and claims
 * transcript turns of its own, so writers' shares are disjoint and add.
 */
export interface WriterContribution {
  readonly summary: FullSessionSummary;
  /** This writer saw a real token report replace the session's byte estimates. */
  readonly retracted: boolean;
}

const NO_ESTIMATES: ByteEstimateLedger = {
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  costByModel: {},
  costByDayUsd: {},
};

/**
 * The session every writer's share adds up to. Inputs fold oldest writer first,
 * so the result does not depend on the order they are listed in. One call two
 * engines both drained counts once where the timelines carry its toolUseId.
 * Retraction is a fact about the session, so one retracted writer drops every
 * writer's estimates.
 */
export function foldWriterContributions(
  contributions: readonly [WriterContribution, ...WriterContribution[]],
): FullSessionSummary {
  const retracted = contributions.some((c) => c.retracted);
  const summaries = contributions
    .map((c) => (retracted ? withoutEstimates(c.summary) : c.summary))
    .sort(byWriteOrder);
  const sum = summaries.reduce((a, b) => addSummaries(a, b));
  const repeats = repeatedCallNames(summaries);
  if (repeats.length === 0) return sum;
  const toolBreakdown = { ...sum.toolBreakdown };
  for (const name of repeats) toolBreakdown[name] -= 1;
  return {
    ...sum,
    toolCallCount: sum.toolCallCount - repeats.length,
    toolBreakdown,
    bashCommandCount: sum.bashCommandCount - repeats.filter((name) => name === 'Bash').length,
  };
}

function repeatedCallNames(summaries: readonly FullSessionSummary[]): string[] {
  const seen = new Set<string>();
  const repeats: string[] = [];
  for (const summary of summaries) {
    for (const [toolUseId, toolName] of savedToolNameByUseId(summary)) {
      if (seen.has(toolUseId)) repeats.push(toolName);
      else seen.add(toolUseId);
    }
  }
  return repeats;
}

function withoutEstimates(s: FullSessionSummary): FullSessionSummary {
  const ledger = s.byteEstimates;
  if (ledger === undefined) return s;
  const exact = exactTotalsOf(s);
  return {
    ...s,
    estimatedCostUsd: exact.costUsd,
    costByDayUsd: s.costByDayUsd && exact.costByDayUsd,
    tokensInput: exact.inputTokens,
    tokensOutput: exact.outputTokens,
    unpricedByModel:
      s.unpricedByModel && subtractCallUsage(s.unpricedByModel, ledger.unpricedByModel),
    estimatedByModel:
      s.estimatedByModel && subtractCallUsage(s.estimatedByModel, ledger.estimatedByModel),
    unpricedByDay:
      s.unpricedByDay &&
      combineCallUsageByDay(s.unpricedByDay, ledger.unpricedByDay, subtractCallUsage),
    estimatedByDay:
      s.estimatedByDay &&
      combineCallUsageByDay(s.estimatedByDay, ledger.estimatedByDay, subtractCallUsage),
    byteEstimates: NO_ESTIMATES,
  };
}
