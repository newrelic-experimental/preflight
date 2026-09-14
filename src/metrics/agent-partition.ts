/**
 * Splits a flat, timestamp-ordered sequence into one group per agent — the
 * parent/orchestrator session (`agentId` absent) plus one per distinct
 * subagent `agentId`. Sequence-based detectors (stuck-loop, re-reading,
 * blind-editing, redundant-reads, repeated-failures) must run per group
 * rather than over the flat list, or parallel subagents each independently
 * doing the same thing once (e.g. three agents each running `npm test`) look
 * like one agent repeating itself.
 *
 * Generic over anything carrying an `agentId` — used for `ToolCallRecord[]`
 * (metric trackers) and for an indexed `ReplayTimelineEntry` wrapper (Replay
 * UI's `analyzeReplayTimeline`), which needs the same grouping but keyed by
 * an object other than the record itself.
 *
 * Relative order within each returned group matches the input order; group
 * order matches each key's first appearance in the input.
 */
export function partitionByAgent<T extends { readonly agentId?: string }>(
  items: readonly T[],
): readonly T[][] {
  const groups = new Map<string | undefined, T[]>();

  for (const item of items) {
    const key = item.agentId;
    const group = groups.get(key);
    if (group) {
      group.push(item);
    } else {
      groups.set(key, [item]);
    }
  }

  return [...groups.values()];
}
