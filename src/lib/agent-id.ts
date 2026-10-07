/**
 * Shape of a Claude Code subagent-transcript agent id, as it appears in
 * `agent-<agentId>.jsonl` filenames under
 * `~/.claude/projects/<slug>/<sessionId>/subagents/`.
 *
 * A valid agentId is either:
 *  - `a<16-hex>` — an anonymous `Task`/`Agent` spawn, or
 *  - `a<name>-<16-hex>` — a subagent spawned with an explicit `name` (the
 *    `Agent` tool's `name` param, addressable later via SendMessage);
 *    `<name>` may itself contain hyphens.
 *
 * `subagent-watcher.ts` (transcript discovery/tailing), `subagent-timeline-
 * store.ts` (dashboard's independent re-parse for the timeline panel and
 * cost self-check), and `local-store.ts` (`SUBAGENT_CURSOR_RE`, cursor-file
 * GC) all need to agree on this shape — they describe one external contract
 * (Claude Code's own naming scheme), not three independently-tailored
 * validation rules, so the pattern lives here once rather than being
 * hand-copied into each.
 *
 * Exported as a source string (not a compiled RegExp) because callers embed
 * it differently: `AGENT_ID_RE` below anchors it standalone, while
 * `local-store.ts` interpolates it, unanchored, as one capture group inside
 * a larger cursor-filename pattern.
 */
export const AGENT_ID_PATTERN = 'a(?:[A-Za-z0-9_-]{1,64}-)?[a-f0-9]{16}';

/** Anchored form of {@link AGENT_ID_PATTERN}, for validating a standalone agentId string. */
export const AGENT_ID_RE = new RegExp(`^${AGENT_ID_PATTERN}$`);

/** Longest subagent type accepted from a transcript sidecar or buffer line. */
export const MAX_AGENT_TYPE_LENGTH = 128;

/**
 * Returns `value` when it is a usable subagent type (e.g. `Explore`): a
 * non-empty string of at most {@link MAX_AGENT_TYPE_LENGTH} characters with
 * no C0 control characters or DEL. Anything else yields `undefined`. The type
 * ends up as an NR event attribute, so a malformed or oversized value is
 * dropped rather than shipped.
 */
export function normalizeAgentType(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.length === 0 || value.length > MAX_AGENT_TYPE_LENGTH) return undefined;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return undefined;
  }
  return value;
}
