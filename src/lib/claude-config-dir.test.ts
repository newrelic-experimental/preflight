import { resolve } from 'node:path';

import { claudeConfigDir, claudeProjectsDir } from './claude-config-dir.js';

describe('claudeConfigDir', () => {
  it('falls back to ~/.claude when CLAUDE_CONFIG_DIR is unset', () => {
    expect(claudeConfigDir({}, '/home/dev')).toBe('/home/dev/.claude');
  });

  it('treats an empty or blank CLAUDE_CONFIG_DIR as unset', () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '  ' }, '/home/dev')).toBe('/home/dev/.claude');
  });

  it('uses CLAUDE_CONFIG_DIR when set', () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/opt/claude-cfg' }, '/home/dev')).toBe(
      '/opt/claude-cfg',
    );
  });

  it('resolves a relative CLAUDE_CONFIG_DIR', () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: 'cfg' }, '/home/dev')).toBe(resolve('cfg'));
  });
});

describe('claudeProjectsDir', () => {
  it('appends projects to the config dir', () => {
    expect(claudeProjectsDir({}, '/home/dev')).toBe('/home/dev/.claude/projects');
    expect(claudeProjectsDir({ CLAUDE_CONFIG_DIR: '/opt/claude-cfg' }, '/home/dev')).toBe(
      '/opt/claude-cfg/projects',
    );
  });
});
