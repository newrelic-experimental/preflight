import { mcpPrEvent, mcpPrToolAction } from './mcp-pr-tools.js';

describe('mcpPrToolAction()', () => {
  it.each([
    ['create_pull_request', 'create'],
    ['update_pull_request', 'edit'],
    ['mcp__github__create_pull_request', 'create'],
    ['mcp__github-remote__update_pull_request', 'edit'],
    ['mcp__plugin_github_github__create_pull_request', 'create'],
    ['mcp__github__merge_pull_request', 'merge'],
  ])('maps %s to %s', (toolName, action) => {
    expect(mcpPrToolAction(toolName)).toBe(action);
  });

  it.each([
    'mcp__github__create_pull_request_with_copilot',
    'mcp__github__update_pull_request_branch',
    'mcp__create_pull_request',
    'Bash',
    'toString',
    'mcp__github__constructor',
  ])('maps %s to nothing', (toolName) => {
    expect(mcpPrToolAction(toolName)).toBeUndefined();
  });
});

describe('mcpPrEvent()', () => {
  it("takes a create's number from its output and an edit's or merge's from its input", () => {
    const record = { createdPrNumber: '57', mcpPrNumber: '12' };
    expect(mcpPrEvent('mcp__github__create_pull_request', record, 1)?.prNumber).toBe('57');
    expect(mcpPrEvent('mcp__github__update_pull_request', record, 1)?.prNumber).toBe('12');
    expect(mcpPrEvent('mcp__github__merge_pull_request', record, 1)?.prNumber).toBe('12');
  });

  it('leaves the number null when the call carried none', () => {
    expect(mcpPrEvent('merge_pull_request', {}, 5)).toEqual({
      timestamp: 5,
      action: 'merge',
      prNumber: null,
    });
  });

  it('is undefined for a failed create or merge and for a tool that is not a PR tool', () => {
    expect(mcpPrEvent('create_pull_request', { success: false }, 1)).toBeUndefined();
    expect(mcpPrEvent('merge_pull_request', { success: false }, 1)).toBeUndefined();
    expect(mcpPrEvent('update_pull_request', { success: false }, 1)?.action).toBe('edit');
    expect(mcpPrEvent('Bash', {}, 1)).toBeUndefined();
  });
});
