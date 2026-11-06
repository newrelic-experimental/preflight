import type { PrEvent } from './git-efficiency-tracker.js';

/**
 * GitHub MCP server PR tools, keyed by the tool's own name. Both names are
 * listed in the server's tool reference
 * (https://github.com/github/github-mcp-server#tools, "Pull Requests":
 * `create_pull_request` "Open new pull request", `update_pull_request` "Edit
 * pull request"), and live-account NRQL evidence shows both reaching Preflight
 * as `AiToolCall` events with these bare `tool` values. Deliberately limited
 * to those two; the server's other PR tools (`merge_pull_request`,
 * `update_pull_request_branch`, ...) are out of scope pending their own
 * evidence of how they should count.
 */
const MCP_PR_TOOL_ACTION: Readonly<Record<string, PrEvent['action']>> = {
  create_pull_request: 'create',
  update_pull_request: 'edit',
};

/**
 * The tool's own name, without the `mcp__<server>__` prefix Claude Code adds.
 * Claude Code names MCP tools `mcp__<server>__<tool>`, e.g.
 * `mcp__github__search_repositories`, and a plugin-bundled server's segment is
 * `plugin_<plugin>_<server>` (https://docs.anthropic.com/en/docs/claude-code/hooks,
 * "Match MCP tools"). The server segment is whatever key the user configured
 * the server under, so any server matches. Names without the prefix pass
 * through unchanged.
 */
function bareMcpToolName(toolName: string): string {
  const parts = toolName.split('__');
  if (parts.length >= 3 && parts[0] === 'mcp') return parts.slice(2).join('__');
  return toolName;
}

/**
 * The PR action a GitHub MCP tool call denotes, or undefined when the tool is
 * not one of `MCP_PR_TOOL_ACTION`'s. Matches the bare name and Claude Code's
 * `mcp__<server>__<tool>` form alike, but only the whole tool name:
 * `create_pull_request_with_copilot` is not a create.
 */
export function mcpPrToolAction(toolName: string): PrEvent['action'] | undefined {
  const bare = bareMcpToolName(toolName);
  return Object.hasOwn(MCP_PR_TOOL_ACTION, bare) ? MCP_PR_TOOL_ACTION[bare] : undefined;
}
