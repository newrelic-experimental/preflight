/**
 * Splits a flat, timestamp-ordered `ToolCallRecord[]` into one sequence per
 * agent — the parent/orchestrator session (`agentId` absent) plus one per
 * distinct subagent `agentId`. Sequence-based detectors (stuck-loop,
 * re-reading, blind-editing, redundant-reads, repeated-failures) must run
 * per group rather than over the flat list, or parallel subagents each
 * independently doing the same thing once (e.g. three agents each running
 * `npm test`) look like one agent repeating itself.
 *
 * Relative order within each returned group matches the input order; group
 * order matches each key's first appearance in the input.
 */
import type { ToolCallRecord } from '../storage/types.js';

export function partitionByAgent(
  toolCalls: readonly ToolCallRecord[],
): readonly ToolCallRecord[][] {
  const groups = new Map<string | undefined, ToolCallRecord[]>();

  for (const call of toolCalls) {
    const key = call.agentId;
    const group = groups.get(key);
    if (group) {
      group.push(call);
    } else {
      groups.set(key, [call]);
    }
  }

  return [...groups.values()];
}
