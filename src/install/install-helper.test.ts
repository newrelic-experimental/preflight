import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import {
  generateHookEntries,
  generateMcpServerEntry,
  generateNrConfig,
  mergeSettings,
  removeSettings,
  mergeMcpConfig,
  removeMcpConfig,
  detectSettingsPath,
  detectMcpConfigPath,
} from './install-helper.js';

// ---------------------------------------------------------------------------
// Temp directory setup (mirrors collector-script.test.ts)
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = resolve(
    tmpdir(),
    `nr-install-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

describe('generateHookEntries', () => {
  it('returns bare command names when no binPath provided', () => {
    const hooks = generateHookEntries();

    expect(hooks.PreToolUse).toEqual([
      { matcher: '', hooks: [{ type: 'command', command: 'preflight-collector pre-tool' }] },
    ]);
    expect(hooks.PostToolUse).toEqual([
      { matcher: '', hooks: [{ type: 'command', command: 'preflight-collector post-tool' }] },
    ]);
  });

  it('wsl mode: uses quoted wsl.exe -e with absolute path', () => {
    const hooks = generateHookEntries('/home/user/bin/preflight', { platform: 'wsl-windows-cc' });

    expect(hooks.PreToolUse[0].hooks[0].command).toBe(
      'wsl.exe -e "/home/user/bin/preflight-collector" pre-tool',
    );
    expect(hooks.PostToolUse[0].hooks[0].command).toBe(
      'wsl.exe -e "/home/user/bin/preflight-collector" post-tool',
    );
  });

  it('wsl mode: quotes path with spaces so cmd.exe does not split tokens', () => {
    const hooks = generateHookEntries('/home/john doe/bin/preflight', {
      platform: 'wsl-windows-cc',
    });

    expect(hooks.PreToolUse[0].hooks[0].command).toBe(
      'wsl.exe -e "/home/john doe/bin/preflight-collector" pre-tool',
    );
  });

  it('wsl mode: escapes backslashes before quotes, matching non-wsl branch behaviour', () => {
    const hooks = generateHookEntries('/path/with\\backslash/preflight', {
      platform: 'wsl-windows-cc',
    });

    expect(hooks.PreToolUse[0].hooks[0].command).toBe(
      'wsl.exe -e "/path/with\\\\backslash/preflight-collector" pre-tool',
    );
  });

  it('wsl mode: falls back to quoted bare command name when binPath is null', () => {
    const hooks = generateHookEntries(null, { platform: 'wsl-windows-cc' });

    expect(hooks.PreToolUse[0].hooks[0].command).toBe('wsl.exe -e "preflight-collector" pre-tool');
    expect(hooks.PostToolUse[0].hooks[0].command).toBe(
      'wsl.exe -e "preflight-collector" post-tool',
    );
  });

  it('uses quoted full path when binPath is provided', () => {
    const hooks = generateHookEntries('/usr/local/bin/preflight');

    expect(hooks.PreToolUse).toEqual([
      {
        matcher: '',
        hooks: [{ type: 'command', command: '"/usr/local/bin/preflight-collector" pre-tool' }],
      },
    ]);
    expect(hooks.PostToolUse).toEqual([
      {
        matcher: '',
        hooks: [{ type: 'command', command: '"/usr/local/bin/preflight-collector" post-tool' }],
      },
    ]);
  });

  it('quotes paths that contain spaces', () => {
    const hooks = generateHookEntries('/Users/John Doe/.nvm/versions/node/v24/bin/preflight');

    expect(hooks.PreToolUse[0].hooks[0].command).toBe(
      '"/Users/John Doe/.nvm/versions/node/v24/bin/preflight-collector" pre-tool',
    );
  });

  it('escapes backslashes before quotes in paths containing backslashes', () => {
    // A POSIX path whose directory component contains a literal backslash character.
    // Backslashes must be doubled before quote-escaping so a backslash adjacent to
    // the closing " cannot break the shell quoting.
    const hooks = generateHookEntries('/path/with\\backslash/preflight');

    expect(hooks.PreToolUse[0].hooks[0].command).toBe(
      '"/path/with\\\\backslash/preflight-collector" pre-tool',
    );
  });

  it('falls back to bare command when binPath is null', () => {
    const hooks = generateHookEntries(null);

    expect(hooks.PreToolUse[0].hooks[0].command).toBe('preflight-collector pre-tool');
  });
});

describe('mergeSettings — wsl-windows-cc platform', () => {
  it('generates quoted wsl.exe hook commands', () => {
    const result = mergeSettings({}, '/home/user/bin/preflight', { platform: 'wsl-windows-cc' });
    const hooks = result.hooks as Record<string, unknown[]>;
    const pre = hooks.PreToolUse[0] as Record<string, unknown>;
    expect((pre.hooks as Array<Record<string, string>>)[0].command).toBe(
      'wsl.exe -e "/home/user/bin/preflight-collector" pre-tool',
    );
  });

  it('is idempotent — re-installing with wsl mode does not duplicate entries', () => {
    const once = mergeSettings({}, '/home/user/bin/preflight', { platform: 'wsl-windows-cc' });
    const twice = mergeSettings(once, '/home/user/bin/preflight', { platform: 'wsl-windows-cc' });
    const hooks = twice.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PostToolUse).toHaveLength(1);
  });
});

describe('mergeMcpConfig — wsl-windows-cc platform', () => {
  it('generates wsl.exe MCP server entry', () => {
    const result = mergeMcpConfig({}, '/home/user/bin/preflight', { platform: 'wsl-windows-cc' });
    const servers = result.mcpServers as Record<string, unknown>;
    expect(servers['newrelic-preflight']).toEqual({
      command: 'wsl.exe',
      args: ['-e', '/home/user/bin/preflight', '--stdio'],
    });
  });
});

describe('detectSettingsPath — windowsHome override', () => {
  it('uses windowsHome as the base for user scope', () => {
    const path = detectSettingsPath('user', '/mnt/c/Users/alice');
    expect(path).toBe(resolve('/mnt/c/Users/alice', '.claude', 'settings.json'));
  });

  it('ignores windowsHome for project scope', () => {
    const path = detectSettingsPath('project', '/mnt/c/Users/alice');
    expect(path).toBe(resolve(process.cwd(), '.claude', 'settings.json'));
  });
});

describe('detectMcpConfigPath — windowsHome override', () => {
  it('uses windowsHome as the base for user scope', () => {
    const path = detectMcpConfigPath('user', '/mnt/c/Users/alice');
    expect(path).toBe(resolve('/mnt/c/Users/alice', '.mcp.json'));
  });
});

describe('generateMcpServerEntry', () => {
  it('returns bare command when no binPath provided', () => {
    const entry = generateMcpServerEntry();

    expect(entry).toEqual({
      'newrelic-preflight': { command: 'preflight', args: ['--stdio'] },
    });
  });

  it('uses full path derived from binPath bin directory', () => {
    const entry = generateMcpServerEntry('/usr/local/bin/preflight');

    expect(entry).toEqual({
      'newrelic-preflight': { command: '/usr/local/bin/preflight', args: ['--stdio'] },
    });
  });

  it('falls back to bare command when binPath is null', () => {
    const entry = generateMcpServerEntry(null);

    expect(entry['newrelic-preflight']).toEqual({
      command: 'preflight',
      args: ['--stdio'],
    });
  });

  it('wsl mode: uses wsl.exe -e with absolute path', () => {
    const entry = generateMcpServerEntry('/home/user/bin/preflight', {
      platform: 'wsl-windows-cc',
    });

    expect(entry['newrelic-preflight']).toEqual({
      command: 'wsl.exe',
      args: ['-e', '/home/user/bin/preflight', '--stdio'],
    });
  });

  it('wsl mode: falls back to bare command name when binPath is null', () => {
    const entry = generateMcpServerEntry(null, { platform: 'wsl-windows-cc' });

    expect(entry['newrelic-preflight']).toEqual({
      command: 'wsl.exe',
      args: ['-e', 'preflight', '--stdio'],
    });
  });
});

describe('generateNrConfig', () => {
  it('returns config with licenseKey and accountId', () => {
    const config = generateNrConfig('NRAK-abc123', '12345');

    expect(config).toEqual({ licenseKey: 'NRAK-abc123', accountId: '12345' });
  });
});

// ---------------------------------------------------------------------------
// detectSettingsPath
// ---------------------------------------------------------------------------

describe('detectSettingsPath', () => {
  it('returns ~/.claude/settings.json for user scope', () => {
    const path = detectSettingsPath('user');

    expect(path).toBe(resolve(homedir(), '.claude', 'settings.json'));
  });

  it('returns cwd/.claude/settings.json for project scope', () => {
    const path = detectSettingsPath('project');

    expect(path).toBe(resolve(process.cwd(), '.claude', 'settings.json'));
  });
});

describe('detectMcpConfigPath', () => {
  it('returns ~/.mcp.json for user scope', () => {
    const path = detectMcpConfigPath('user');

    expect(path).toBe(resolve(homedir(), '.mcp.json'));
  });

  it('returns cwd/.mcp.json for project scope', () => {
    const path = detectMcpConfigPath('project');

    expect(path).toBe(resolve(process.cwd(), '.mcp.json'));
  });
});

// ---------------------------------------------------------------------------
// mergeSettings
// ---------------------------------------------------------------------------

describe('mergeSettings', () => {
  it('creates hooks from empty object (no mcpServers)', () => {
    const result = mergeSettings({});

    expect(result.hooks).toBeDefined();
    const hooks = result.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PostToolUse).toHaveLength(1);

    const pre = hooks.PreToolUse[0] as Record<string, unknown>;
    expect(pre.hooks).toEqual([{ type: 'command', command: 'preflight-collector pre-tool' }]);
    const post = hooks.PostToolUse[0] as Record<string, unknown>;
    expect(post.hooks).toEqual([{ type: 'command', command: 'preflight-collector post-tool' }]);

    // MCP servers are NOT managed in settings.json
    expect(result.mcpServers).toBeUndefined();
  });

  it('preserves existing hooks and other settings', () => {
    const existing = {
      hooks: {
        PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'my-other-hook' }] }],
        StopToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-bash-guard' }] }],
      },
      otherSetting: true,
    };

    const result = mergeSettings(existing);

    const hooks = result.hooks as Record<string, unknown[]>;
    // Existing PreToolUse hook preserved, ours appended
    expect(hooks.PreToolUse).toHaveLength(2);
    const existingEntry = hooks.PreToolUse[0] as Record<string, unknown>;
    expect((existingEntry.hooks as Array<Record<string, string>>)[0].command).toBe('my-other-hook');
    const ourEntry = hooks.PreToolUse[1] as Record<string, unknown>;
    expect((ourEntry.hooks as Array<Record<string, string>>)[0].command).toBe(
      'preflight-collector pre-tool',
    );
    // Non-Pre/Post hook preserved
    expect(hooks.StopToolUse).toEqual([
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-bash-guard' }] },
    ]);

    expect(result.otherSetting).toBe(true);
  });

  it('preserves hook entries from other tools that use a non-standard shape', () => {
    const existing = {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', command: 'some-other-tool --pre' }],
        PostToolUse: [{ matcher: 'Edit', command: 'some-other-tool --post' }],
      },
    };

    const result = mergeSettings(existing);

    const hooks = result.hooks as Record<string, unknown[]>;

    // Pre: non-standard entry preserved, NR entry appended
    expect(hooks.PreToolUse).toHaveLength(2);
    expect(hooks.PreToolUse[0]).toEqual({ matcher: 'Bash', command: 'some-other-tool --pre' });
    const preNr = hooks.PreToolUse[1] as Record<string, unknown>;
    expect(preNr.hooks).toEqual([{ type: 'command', command: 'preflight-collector pre-tool' }]);

    // Post: same behaviour on the PostToolUse branch
    expect(hooks.PostToolUse).toHaveLength(2);
    expect(hooks.PostToolUse[0]).toEqual({ matcher: 'Edit', command: 'some-other-tool --post' });
    const postNr = hooks.PostToolUse[1] as Record<string, unknown>;
    expect(postNr.hooks).toEqual([{ type: 'command', command: 'preflight-collector post-tool' }]);
  });

  it('is idempotent — running twice does not duplicate entries', () => {
    const once = mergeSettings({});
    const twice = mergeSettings(once);

    const hooks = twice.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PostToolUse).toHaveLength(1);
  });

  it('upgrades a bare-name hook entry to a quoted absolute path on re-install', () => {
    const withBare = mergeSettings({});
    const withAbsolute = mergeSettings(withBare, '/usr/local/bin/preflight');

    const hooks = withAbsolute.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PostToolUse).toHaveLength(1);
    const pre = hooks.PreToolUse[0] as Record<string, unknown>;
    expect((pre.hooks as Array<Record<string, string>>)[0].command).toBe(
      '"/usr/local/bin/preflight-collector" pre-tool',
    );
  });

  it('upgrades a stale absolute-path hook entry to a new quoted path on re-install', () => {
    const withOld = mergeSettings({}, '/old/path/preflight');
    const withNew = mergeSettings(withOld, '/new/path/preflight');

    const hooks = withNew.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toHaveLength(1);
    const pre = hooks.PreToolUse[0] as Record<string, unknown>;
    expect((pre.hooks as Array<Record<string, string>>)[0].command).toBe(
      '"/new/path/preflight-collector" pre-tool',
    );
  });

  it('preserves an existing absolute-path hook when re-installing with null binPath', () => {
    const withAbsolute = mergeSettings({}, '/usr/local/bin/preflight');
    const reInstalled = mergeSettings(withAbsolute, null);

    const hooks = reInstalled.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toHaveLength(1);
    const pre = hooks.PreToolUse[0] as Record<string, unknown>;
    expect((pre.hooks as Array<Record<string, string>>)[0].command).toBe(
      '"/usr/local/bin/preflight-collector" pre-tool',
    );
  });
});

// ---------------------------------------------------------------------------
// removeSettings
// ---------------------------------------------------------------------------

describe('removeSettings', () => {
  it('removes only preflight hook entries, keeps others', () => {
    const settings = {
      hooks: {
        PreToolUse: [
          { matcher: '', hooks: [{ type: 'command', command: 'my-other-hook' }] },
          { matcher: '', hooks: [{ type: 'command', command: 'preflight-collector pre-tool' }] },
        ],
        PostToolUse: [
          { matcher: '', hooks: [{ type: 'command', command: 'preflight-collector post-tool' }] },
        ],
      },
    };

    const result = removeSettings(settings);

    const hooks = result.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toEqual([
      { matcher: '', hooks: [{ type: 'command', command: 'my-other-hook' }] },
    ]);
    expect(hooks.PostToolUse).toBeUndefined();
  });

  it('cleans up empty hooks object', () => {
    const settings = mergeSettings({});
    const result = removeSettings(settings);

    expect(result.hooks).toBeUndefined();
  });

  it('removes quoted absolute-path entries installed by the new code path', () => {
    const settings = mergeSettings({}, '/usr/local/bin/preflight');
    const result = removeSettings(settings);

    expect(result.hooks).toBeUndefined();
  });

  it('returns unchanged object when our entries are not present', () => {
    const settings = {
      hooks: {
        PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'some-other-hook' }] }],
      },
      otherKey: 42,
    };

    const result = removeSettings(settings);

    expect(result).toEqual(settings);
  });
});

// ---------------------------------------------------------------------------
// mergeMcpConfig
// ---------------------------------------------------------------------------

describe('mergeMcpConfig', () => {
  it('creates mcpServers from empty object', () => {
    const result = mergeMcpConfig({});

    expect(result.mcpServers).toBeDefined();
    const servers = result.mcpServers as Record<string, unknown>;
    expect(servers['newrelic-preflight']).toEqual({
      command: 'preflight',
      args: ['--stdio'],
    });
  });

  it('preserves existing MCP servers', () => {
    const existing = {
      mcpServers: {
        'my-server': { command: 'my-mcp', args: [] },
      },
    };

    const result = mergeMcpConfig(existing);

    const servers = result.mcpServers as Record<string, unknown>;
    expect(servers['my-server']).toEqual({ command: 'my-mcp', args: [] });
    expect(servers['newrelic-preflight']).toBeDefined();
  });

  it('is idempotent', () => {
    const once = mergeMcpConfig({});
    const twice = mergeMcpConfig(once);

    const servers = twice.mcpServers as Record<string, unknown>;
    expect(Object.keys(servers)).toHaveLength(1);
  });

  it('upgrades a bare-name MCP command to an absolute path on re-install', () => {
    const withBare = mergeMcpConfig({});
    const withAbsolute = mergeMcpConfig(withBare, '/usr/local/bin/preflight');

    const servers = withAbsolute.mcpServers as Record<string, unknown>;
    expect(Object.keys(servers)).toHaveLength(1);
    expect(servers['newrelic-preflight']).toEqual({
      command: '/usr/local/bin/preflight',
      args: ['--stdio'],
    });
  });

  it('upgrades a stale absolute-path MCP command on re-install', () => {
    const withOld = mergeMcpConfig({}, '/old/path/preflight');
    const withNew = mergeMcpConfig(withOld, '/new/path/preflight');

    const servers = withNew.mcpServers as Record<string, unknown>;
    expect(servers['newrelic-preflight']).toEqual({
      command: '/new/path/preflight',
      args: ['--stdio'],
    });
  });

  it('preserves user-added fields when upgrading the MCP command', () => {
    const existing = {
      mcpServers: {
        'newrelic-preflight': {
          command: 'preflight',
          args: ['--stdio', '--config', '/custom/config.json'],
          env: { MY_VAR: 'value' },
        },
      },
    };

    const result = mergeMcpConfig(existing, '/usr/local/bin/preflight');

    const servers = result.mcpServers as Record<string, unknown>;
    expect(servers['newrelic-preflight']).toEqual({
      command: '/usr/local/bin/preflight',
      args: ['--stdio'],
      env: { MY_VAR: 'value' },
    });
  });

  it('preserves an existing absolute-path MCP command when re-installing with null binPath', () => {
    const withAbsolute = mergeMcpConfig({}, '/usr/local/bin/preflight');
    const reInstalled = mergeMcpConfig(withAbsolute, null);

    const servers = reInstalled.mcpServers as Record<string, unknown>;
    expect(servers['newrelic-preflight']).toEqual({
      command: '/usr/local/bin/preflight',
      args: ['--stdio'],
    });
  });

  it('preserves remote/HTTP MCP server entries (url transport, no command/args)', () => {
    const existing = {
      mcpServers: {
        'remote-server': { url: 'https://example.com/mcp', transport: 'sse' },
      },
    };

    const result = mergeMcpConfig(existing);

    const servers = result.mcpServers as Record<string, unknown>;
    expect(servers['remote-server']).toEqual({ url: 'https://example.com/mcp', transport: 'sse' });
    expect(servers['newrelic-preflight']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// removeMcpConfig
// ---------------------------------------------------------------------------

describe('removeMcpConfig', () => {
  it('removes newrelic-preflight, keeps other servers', () => {
    const config = {
      mcpServers: {
        'my-server': { command: 'my-mcp', args: [] },
        'newrelic-preflight': { command: 'preflight', args: ['--stdio'] },
      },
    };

    const result = removeMcpConfig(config);

    const servers = result.mcpServers as Record<string, unknown>;
    expect(servers['my-server']).toBeDefined();
    expect(servers['newrelic-preflight']).toBeUndefined();
  });

  it('removes stale preflight and nr-ai-observability keys on uninstall', () => {
    const config = {
      mcpServers: {
        'my-server': { command: 'my-mcp', args: [] },
        preflight: { command: 'preflight', args: ['--stdio'] },
        'nr-ai-observability': { command: 'nr-ai-observe', args: ['--stdio'] },
      },
    };

    const result = removeMcpConfig(config);

    const servers = result.mcpServers as Record<string, unknown>;
    expect(servers['my-server']).toBeDefined();
    expect(servers['preflight']).toBeUndefined();
    expect(servers['nr-ai-observability']).toBeUndefined();
  });

  it('removes mcpServers key when empty', () => {
    const config = mergeMcpConfig({});
    const result = removeMcpConfig(config);

    expect(result.mcpServers).toBeUndefined();
  });

  it('returns unchanged object when our entry is not present', () => {
    const config = {
      mcpServers: {
        'other-server': { command: 'other', args: [] },
      },
    };

    const result = removeMcpConfig(config);

    expect(result).toEqual(config);
  });
});

// ---------------------------------------------------------------------------
// Integration: full install/uninstall cycle with temp files
// ---------------------------------------------------------------------------

describe('integration: install/uninstall cycle', () => {
  it('install produces valid JSON for both settings and MCP config', () => {
    const settingsPath = resolve(tmpDir, 'settings.json');
    const mcpPath = resolve(tmpDir, '.mcp.json');
    writeFileSync(settingsPath, '{}');
    writeFileSync(mcpPath, '{}');

    // Install hooks into settings.json
    const existingSettings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    writeFileSync(settingsPath, JSON.stringify(mergeSettings(existingSettings), null, 2));

    // Install MCP server into .mcp.json
    const existingMcp = JSON.parse(readFileSync(mcpPath, 'utf-8')) as Record<string, unknown>;
    writeFileSync(mcpPath, JSON.stringify(mergeMcpConfig(existingMcp), null, 2));

    // Verify settings.json has hooks but no mcpServers
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    expect(settings.hooks).toBeDefined();
    expect(settings.mcpServers).toBeUndefined();
    const hooks = settings.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PostToolUse).toHaveLength(1);

    // Verify .mcp.json has mcpServers
    const mcp = JSON.parse(readFileSync(mcpPath, 'utf-8')) as Record<string, unknown>;
    expect(mcp.mcpServers).toBeDefined();
    const servers = mcp.mcpServers as Record<string, unknown>;
    expect(servers['newrelic-preflight']).toEqual({
      command: 'preflight',
      args: ['--stdio'],
    });
  });

  it('uninstall after install removes our entries but keeps others', () => {
    const settingsPath = resolve(tmpDir, 'settings.json');
    const mcpPath = resolve(tmpDir, '.mcp.json');
    const initialSettings = {
      hooks: { PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'keep-me' }] }] },
    };
    const initialMcp = {
      mcpServers: { 'keep-server': { command: 'keep', args: [] } },
    };
    writeFileSync(settingsPath, JSON.stringify(initialSettings));
    writeFileSync(mcpPath, JSON.stringify(initialMcp));

    // Install
    let settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    writeFileSync(settingsPath, JSON.stringify(mergeSettings(settings), null, 2));
    let mcp = JSON.parse(readFileSync(mcpPath, 'utf-8')) as Record<string, unknown>;
    writeFileSync(mcpPath, JSON.stringify(mergeMcpConfig(mcp), null, 2));

    // Uninstall
    settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    writeFileSync(settingsPath, JSON.stringify(removeSettings(settings), null, 2));
    mcp = JSON.parse(readFileSync(mcpPath, 'utf-8')) as Record<string, unknown>;
    writeFileSync(mcpPath, JSON.stringify(removeMcpConfig(mcp), null, 2));

    const readBackSettings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    const hooks = readBackSettings.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toEqual([
      { matcher: '', hooks: [{ type: 'command', command: 'keep-me' }] },
    ]);

    const readBackMcp = JSON.parse(readFileSync(mcpPath, 'utf-8')) as Record<string, unknown>;
    const servers = readBackMcp.mcpServers as Record<string, unknown>;
    expect(servers['keep-server']).toBeDefined();
    expect(servers['newrelic-preflight']).toBeUndefined();
  });

  it('generateNrConfig produces valid config file content', () => {
    const configPath = resolve(tmpDir, 'config.json');
    const config = generateNrConfig('NRAK-test123', '99999');
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    const readBack = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    expect(readBack.licenseKey).toBe('NRAK-test123');
    expect(readBack.accountId).toBe('99999');
  });
});
