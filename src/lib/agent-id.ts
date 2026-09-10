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
