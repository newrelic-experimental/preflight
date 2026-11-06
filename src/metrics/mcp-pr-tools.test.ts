import { mcpPrToolAction } from './mcp-pr-tools.js';

describe('mcpPrToolAction()', () => {
  it.each([
    ['create_pull_request', 'create'],
    ['update_pull_request', 'edit'],
    ['mcp__github__create_pull_request', 'create'],
    ['mcp__github-remote__update_pull_request', 'edit'],
    ['mcp__plugin_github_github__create_pull_request', 'create'],
  ])('maps %s to %s', (toolName, action) => {
    expect(mcpPrToolAction(toolName)).toBe(action);
  });

  it.each([
    'mcp__github__create_pull_request_with_copilot',
    'mcp__github__update_pull_request_branch',
    'mcp__github__merge_pull_request',
    'mcp__create_pull_request',
    'Bash',
    'toString',
    'mcp__github__constructor',
  ])('maps %s to nothing', (toolName) => {
    expect(mcpPrToolAction(toolName)).toBeUndefined();
  });
});
