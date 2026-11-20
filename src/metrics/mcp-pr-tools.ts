import type { PrEvent } from './git-efficiency-tracker.js';

/**
 * GitHub MCP server PR tools, keyed by the tool's own name, from the server's
 * tool reference (https://github.com/github/github-mcp-server#tools, "Pull
 * Requests": `create_pull_request` "Open new pull request",
 * `update_pull_request` "Edit pull request", `merge_pull_request` "Merge pull
 * request"). Each takes `owner` and `repo`; update and merge also take
 * `pullNumber`. The server's other PR tools stay out:
 * `update_pull_request_branch` merges the base into the PR's branch, which is
 * neither an edit of the PR nor a merge of it.
 */
const MCP_PR_TOOL_ACTION: Readonly<Record<string, PrEvent['action']>> = {
  create_pull_request: 'create',
  update_pull_request: 'edit',
  merge_pull_request: 'merge',
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

/** The PR fields a GitHub MCP tool call carries on its `ToolCallRecord`. */
export interface McpPrFields {
  readonly success?: boolean;
  readonly createdPrNumber?: string;
  readonly mcpPrNumber?: string;
}

/**
 * The PR event a GitHub MCP tool call denotes, or undefined when it denotes
 * none: not a PR tool, or a create or merge that failed and so changed
 * nothing. The number is the one a create opened (from its output) or the one
 * an edit or merge named (its `pullNumber` input).
 */
export function mcpPrEvent(
  toolName: string,
  record: McpPrFields,
  timestamp: number,
): PrEvent | undefined {
  const action = mcpPrToolAction(toolName);
  if (action === undefined) return undefined;
  if ((action === 'create' || action === 'merge') && record.success === false) return undefined;
  const prNumber = action === 'create' ? record.createdPrNumber : record.mcpPrNumber;
  return { timestamp, action, prNumber: prNumber ?? null };
}
