import { createLogger } from '../shared/index.js';
import { normalizeAgentType } from '../lib/agent-id.js';
import { BoundedMap } from '../lib/bounded-map.js';
import type { ToolCallRecord } from '../storage/types.js';
import { backfillAgentId, backfillAgentType } from './agent-partition.js';

const logger = createLogger('subagent-attribution');

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

/**
 * What one subagent transcript turn tells the index: its subagent, that
 * subagent's type when known, and the tool calls it made.
 */
export interface SubagentTurnAttribution {
  readonly agentId: string;
  readonly toolUseIds: readonly string[];
  readonly agentType?: string;
}

/**
 * Reads the turns live subagent transcripts gained since they were last read,
 * feeding each into the index (`SubagentWatcher` does, through its
 * `onTurnRead` option), and returns how many it read.
 */
export interface LiveSubagentTranscriptReader {
  readLiveTails(sessionId: string | undefined): number;
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
 *   `SubagentWatcher` turn), from a hook envelope that carries both fields,
 *   and as a fallback from the parent's own `Agent` tool call, the one record
 *   carrying both `spawnedAgentId` (`tool_response.agentId`) and
 *   `subagentType` (`tool_input.subagent_type`).
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

  /**
   * Learns a subagent's type from the parent's `Agent` tool call; ignores every
   * other record. `subagentType` is `tool_input.subagent_type` read straight
   * off a `buffer.jsonl` line, so it passes the same `normalizeAgentType()`
   * check as the sidecar type before it can be backfilled onto audit records.
   */
  recordAgentToolCall(record: ToolCallRecord): void {
    if (record.toolName !== 'Agent') return;
    const spawnedAgentId =
      typeof record.spawnedAgentId === 'string' ? record.spawnedAgentId : undefined;
    const subagentType = normalizeAgentType(record.subagentType);
    if (spawnedAgentId && subagentType && !this.agentTypeByAgentId.has(spawnedAgentId)) {
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

  /** Records a subagent transcript turn's type and `tool_use` ids. */
  recordSubagentTurn(turn: SubagentTurnAttribution): void {
    this.recordSubagentType(turn.agentId, turn.agentType);
    this.recordSubagentToolUses(turn.agentId, turn.toolUseIds);
  }

  /**
   * Attributes a hook record as it arrives, before any consumer (notably the
   * audit trail) sees it. An envelope carrying both `agent_id` and
   * `agent_type` teaches the index that subagent's type, for turns that lack a
   * sidecar. When the backfill still leaves `agentId` unknown for a record
   * with a `toolUseId`, `reader` reads the live subagent transcripts now and
   * the backfill runs again: a fast call's `tool_use` line is usually on disk
   * but not yet polled, and the record would otherwise be audited without its
   * subagent (#681). Parent-session calls take the same path, at the cost of
   * one stat per live transcript. If the read throws, the record is returned
   * as the first backfill left it.
   */
  attributeAtIntake(
    record: ToolCallRecord,
    reader: LiveSubagentTranscriptReader | null,
  ): ToolCallRecord {
    if (typeof record.agentId === 'string' && record.agentId.length > 0) {
      this.recordSubagentType(record.agentId, normalizeAgentType(record.agentType));
    }
    const backfilled = this.backfill(record);
    if (
      reader === null ||
      backfilled.agentId !== undefined ||
      typeof backfilled.toolUseId !== 'string'
    ) {
      return backfilled;
    }
    let turnsRead: number;
    try {
      turnsRead = reader.readLiveTails(record.sessionId ?? undefined);
    } catch (err) {
      logger.warn('On-demand subagent transcript read failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return backfilled;
    }
    return turnsRead > 0 ? this.backfill(backfilled) : backfilled;
  }

  /** The subagent type for `agentId`, if its sidecar, a hook envelope, or its spawning `Agent` call has been seen. */
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
