import type { ToolCallRecord } from '../storage/types.js';

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

/**
 * Fills in `ToolCallRecord.agentId` from a `toolUseId → agentId` map when the
 * record's own `agentId` is absent — Claude Code's hook envelope documents
 * `agent_id`/`agent_type` as present on every hook event fired inside a
 * subagent call, but in practice it never populates. `toolUseId`
 * is reliable on both sides: it's already captured correctly on every
 * ToolCallRecord, and it's the same id Claude Code assigns to the matching
 * `tool_use` block in that subagent's own transcript, which `SubagentWatcher`
 * already tails for token accounting. Returns the same object reference when
 * no backfill applies, so callers can cheaply check whether anything changed.
 *
 * This join carries identity only. Type is a separate, per-`agentId` lookup
 * — see {@link backfillAgentType}.
 */
export function backfillAgentId(
  record: ToolCallRecord,
  toolUseIdToAgentId: ReadonlyMap<string, string>,
): ToolCallRecord {
  if (record.agentId !== undefined) return record;
  if (typeof record.toolUseId !== 'string') return record;
  const agentId = toolUseIdToAgentId.get(record.toolUseId);
  if (agentId === undefined) return record;
  return { ...record, agentId };
}

/**
 * Fills in `ToolCallRecord.agentType` from the `agentId → agentType` map
 * built from the parent's own Agent-tool record (`spawnedAgentId` +
 * `subagentType`). Same per-`agentId` granularity as CostTracker's
 * subagent-cost-by-type breakdown — not per tool-use. Call after
 * {@link backfillAgentId} so a just-resolved id can carry a type.
 *
 * Returns the same object reference when no backfill applies. Type stays
 * undefined (no invented labels) when:
 * - the record has no `agentId` (parent/orchestrator call, or the id join
 *   has not caught up yet)
 * - `agentTypeByAgentId` has no entry (the spawning Agent call never paired)
 * - a type is already present on the record (hook envelope wins)
 */
export function backfillAgentType(
  record: ToolCallRecord,
  agentTypeByAgentId: ReadonlyMap<string, string>,
): ToolCallRecord {
  if (record.agentType !== undefined) return record;
  if (record.agentId === undefined) return record;
  const agentType = agentTypeByAgentId.get(record.agentId);
  if (agentType === undefined) return record;
  return { ...record, agentType };
}
