import type { ToolCallRecord } from '../storage/types.js';

/** The read side of a string-keyed lookup — satisfied by `Map` and `BoundedMap`. */
export interface StringLookup {
  get(key: string): string | undefined;
}

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
 * record's own `agentId` is absent. Claude Code's hook envelope documents
 * `agent_id` as present on every hook event fired inside a subagent call, but
 * some installs have been observed never sending it (#656). `toolUseId`
 * is reliable on both sides: it's already captured correctly on every
 * ToolCallRecord, and it's the same id Claude Code assigns to the matching
 * `tool_use` block in that subagent's own transcript, which `SubagentWatcher`
 * already tails for token accounting. Returns the same object reference when
 * no backfill applies, so callers can cheaply check whether anything changed.
 */
export function backfillAgentId(
  record: ToolCallRecord,
  toolUseIdToAgentId: StringLookup,
): ToolCallRecord {
  if (record.agentId !== undefined) return record;
  if (typeof record.toolUseId !== 'string') return record;
  const agentId = toolUseIdToAgentId.get(record.toolUseId);
  if (agentId === undefined) return record;
  return { ...record, agentId };
}

/**
 * Fills in `ToolCallRecord.agentType` from an `agentId → subagent type` map
 * once the record's `agentId` is known (either from the envelope or from
 * `backfillAgentId()`, so run that first). Recent Claude Code sends
 * `agent_type` on the hook envelope itself, and a non-empty envelope value is
 * never overwritten; this covers the records where the envelope left it out
 * (as on the installs in #656). The map is filled from the subagent
 * transcript's meta sidecar and from the parent's own `Agent` tool call (see
 * `SubagentAttributionIndex`). Returns the same object reference when no
 * backfill applies.
 */
export function backfillAgentType(
  record: ToolCallRecord,
  agentTypeByAgentId: StringLookup,
): ToolCallRecord {
  if (typeof record.agentType === 'string' && record.agentType.length > 0) return record;
  if (typeof record.agentId !== 'string') return record;
  const agentType = agentTypeByAgentId.get(record.agentId);
  if (agentType === undefined) return record;
  return { ...record, agentType };
}
