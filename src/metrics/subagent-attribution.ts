import { BoundedMap } from '../lib/bounded-map.js';
import type { ToolCallRecord } from '../storage/types.js';
import { backfillAgentId, backfillAgentType } from './agent-partition.js';

/**
 * One entry per subagent tool call. Each entry only has to live from when
 * `SubagentWatcher` sees the `tool_use` block until the hook record is
 * attributed at intake and again at task close, so 10k covers many concurrent
 * subagents' worth of in-flight calls in roughly 2 MB. Evicting an entry only
 * leaves that one call unattributed, which is already the best-effort
 * behavior when the transcript tail lags.
 */
export const DEFAULT_MAX_TOOL_USE_IDS = 10_000;

/** One entry per spawned subagent; far fewer than tool calls. */
export const DEFAULT_MAX_SUBAGENTS = 1_000;

/**
 * Idle expiry for both indexes. Any use refreshes an entry, so a live
 * subagent never expires; this only reclaims entries from sessions that
 * ended long ago in a `--local` daemon that otherwise runs indefinitely.
 */
export const DEFAULT_SUBAGENT_ATTRIBUTION_TTL_MS = 24 * 60 * 60 * 1000;

export interface SubagentAttributionIndexOptions {
  readonly maxToolUseIds?: number;
  readonly maxSubagents?: number;
  readonly ttlMs?: number;
  /** Clock override for tests. */
  readonly now?: () => number;
}

export interface SubagentAttributionIndexSize {
  readonly toolUseIds: number;
  readonly subagents: number;
}

/**
 * Joins the two signals that attribute a hook `ToolCallRecord` to the
 * subagent that made it when the hook envelope leaves `agent_id` or
 * `agent_type` out. Claude Code documents both on calls made inside a
 * subagent, and recent versions do send `agent_type`, but some installs have
 * been observed sending neither (#656):
 *
 * - `toolUseId → agentId`, from `tool_use` blocks `SubagentWatcher` finds
 *   while tailing each subagent's transcript (see `backfillAgentId()`).
 * - `agentId → subagent type`, from the subagent transcript's
 *   `agent-<id>.meta.json` sidecar (written at spawn, carried on each
 *   `SubagentWatcher` turn), and as a fallback from the parent's own `Agent`
 *   tool call, the one record carrying both `spawnedAgentId`
 *   (`tool_response.agentId`) and `subagentType` (`tool_input.subagent_type`).
 *
 * Both indexes are size-capped LRU maps with idle expiry so a long-running
 * `--local` daemon doesn't accumulate one entry per subagent call forever.
 */
export class SubagentAttributionIndex {
  private readonly toolUseIdToAgentId: BoundedMap<string, string>;
  private readonly agentTypeByAgentId: BoundedMap<string, string>;

  constructor(options: SubagentAttributionIndexOptions = {}) {
    const ttlMs = options.ttlMs ?? DEFAULT_SUBAGENT_ATTRIBUTION_TTL_MS;
    this.toolUseIdToAgentId = new BoundedMap({
      maxEntries: options.maxToolUseIds ?? DEFAULT_MAX_TOOL_USE_IDS,
      ttlMs,
      now: options.now,
    });
    this.agentTypeByAgentId = new BoundedMap({
      maxEntries: options.maxSubagents ?? DEFAULT_MAX_SUBAGENTS,
      ttlMs,
      now: options.now,
    });
  }

  /** Learns a subagent's type from the parent's `Agent` tool call; ignores every other record. */
  recordAgentToolCall(record: ToolCallRecord): void {
    if (record.toolName !== 'Agent') return;
    const spawnedAgentId =
      typeof record.spawnedAgentId === 'string' ? record.spawnedAgentId : undefined;
    const subagentType = typeof record.subagentType === 'string' ? record.subagentType : undefined;
    if (spawnedAgentId && subagentType) {
      this.agentTypeByAgentId.set(spawnedAgentId, subagentType);
    }
  }

  /**
   * Learns a subagent's type from its own transcript's meta sidecar, which
   * exists from spawn time. This is the earlier of the two type signals: the
   * parent's `Agent` call normally completes only after the subagent returns.
   */
  recordSubagentType(agentId: string, agentType: string | undefined): void {
    if (agentType) this.agentTypeByAgentId.set(agentId, agentType);
  }

  /** Records the `tool_use` ids a subagent transcript turn contained. */
  recordSubagentToolUses(agentId: string, toolUseIds: readonly string[]): void {
    for (const toolUseId of toolUseIds) {
      this.toolUseIdToAgentId.set(toolUseId, agentId);
    }
  }

  /** The subagent type for `agentId`, if its sidecar or spawning `Agent` call has been seen. */
  agentTypeFor(agentId: string): string | undefined {
    return this.agentTypeByAgentId.get(agentId);
  }

  /**
   * Fills in `agentId` and then `agentType` where each is absent and known.
   * Never overwrites envelope-provided values. Returns the same reference
   * when nothing changed.
   */
  backfill(record: ToolCallRecord): ToolCallRecord {
    return backfillAgentType(
      backfillAgentId(record, this.toolUseIdToAgentId),
      this.agentTypeByAgentId,
    );
  }

  get size(): SubagentAttributionIndexSize {
    return {
      toolUseIds: this.toolUseIdToAgentId.size,
      subagents: this.agentTypeByAgentId.size,
    };
  }
}
