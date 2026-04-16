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
  detectSettingsPath,
} from './install-helper.js';

// ---------------------------------------------------------------------------
// Temp directory setup (mirrors collector-script.test.ts)
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = resolve(tmpdir(), `nr-install-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
  it('returns PreToolUse and PostToolUse entries', () => {
    const hooks = generateHookEntries();

    expect(hooks.PreToolUse).toEqual([{ matcher: '.*', command: 'nr-ai-observe pre-tool' }]);
    expect(hooks.PostToolUse).toEqual([{ matcher: '.*', command: 'nr-ai-observe post-tool' }]);
  });
});

describe('generateMcpServerEntry', () => {
  it('returns nr-ai-observability MCP server config', () => {
    const entry = generateMcpServerEntry();

    expect(entry).toEqual({
      'nr-ai-observability': { command: 'nr-ai-mcp-server', args: ['--stdio'] },
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

// ---------------------------------------------------------------------------
// mergeSettings
// ---------------------------------------------------------------------------

describe('mergeSettings', () => {
  it('creates full structure from empty object', () => {
    const result = mergeSettings({});

    expect(result.hooks).toBeDefined();
    const hooks = result.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PostToolUse).toHaveLength(1);
    expect((hooks.PreToolUse[0] as Record<string, string>).command).toBe('nr-ai-observe pre-tool');
    expect((hooks.PostToolUse[0] as Record<string, string>).command).toBe('nr-ai-observe post-tool');

    expect(result.mcpServers).toBeDefined();
    const servers = result.mcpServers as Record<string, unknown>;
    expect(servers['nr-ai-observability']).toEqual({
      command: 'nr-ai-mcp-server',
      args: ['--stdio'],
    });
  });

  it('preserves existing hooks and MCP servers', () => {
    const existing = {
      hooks: {
        PreToolUse: [{ matcher: '.*', command: 'my-other-hook' }],
        StopToolUse: [{ matcher: 'Bash', command: 'my-bash-guard' }],
      },
      mcpServers: {
        'my-server': { command: 'my-mcp', args: [] },
      },
      otherSetting: true,
    };

    const result = mergeSettings(existing);

    const hooks = result.hooks as Record<string, unknown[]>;
    // Existing PreToolUse hook preserved, ours appended
    expect(hooks.PreToolUse).toHaveLength(2);
    expect((hooks.PreToolUse[0] as Record<string, string>).command).toBe('my-other-hook');
    expect((hooks.PreToolUse[1] as Record<string, string>).command).toBe('nr-ai-observe pre-tool');
    // Non-Pre/Post hook preserved
    expect(hooks.StopToolUse).toEqual([{ matcher: 'Bash', command: 'my-bash-guard' }]);

    const servers = result.mcpServers as Record<string, unknown>;
    expect(servers['my-server']).toEqual({ command: 'my-mcp', args: [] });
    expect(servers['nr-ai-observability']).toBeDefined();

    expect(result.otherSetting).toBe(true);
  });

  it('is idempotent — running twice does not duplicate entries', () => {
    const once = mergeSettings({});
    const twice = mergeSettings(once);

    const hooks = twice.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PostToolUse).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// removeSettings
// ---------------------------------------------------------------------------

describe('removeSettings', () => {
  it('removes only nr-ai-observe entries, keeps others', () => {
    const settings = {
      hooks: {
        PreToolUse: [
          { matcher: '.*', command: 'my-other-hook' },
          { matcher: '.*', command: 'nr-ai-observe pre-tool' },
        ],
        PostToolUse: [{ matcher: '.*', command: 'nr-ai-observe post-tool' }],
      },
      mcpServers: {
        'my-server': { command: 'my-mcp', args: [] },
        'nr-ai-observability': { command: 'nr-ai-mcp-server', args: ['--stdio'] },
      },
    };

    const result = removeSettings(settings);

    const hooks = result.hooks as Record<string, unknown[]>;
    // PreToolUse kept with other hook, PostToolUse removed entirely
    expect(hooks.PreToolUse).toEqual([{ matcher: '.*', command: 'my-other-hook' }]);
    expect(hooks.PostToolUse).toBeUndefined();

    const servers = result.mcpServers as Record<string, unknown>;
    expect(servers['my-server']).toBeDefined();
    expect(servers['nr-ai-observability']).toBeUndefined();
  });

  it('cleans up empty hooks and mcpServers objects', () => {
    const settings = mergeSettings({});
    const result = removeSettings(settings);

    expect(result.hooks).toBeUndefined();
    expect(result.mcpServers).toBeUndefined();
  });

  it('returns unchanged object when our entries are not present', () => {
    const settings = {
      hooks: {
        PreToolUse: [{ matcher: '.*', command: 'some-other-hook' }],
      },
      mcpServers: {
        'other-server': { command: 'other', args: [] },
      },
      otherKey: 42,
    };

    const result = removeSettings(settings);

    expect(result).toEqual(settings);
  });
});

// ---------------------------------------------------------------------------
// Integration: full install/uninstall cycle with temp files
// ---------------------------------------------------------------------------

describe('integration: install/uninstall cycle', () => {
  it('install produces valid JSON with correct structure', () => {
    const settingsPath = resolve(tmpDir, 'settings.json');
    writeFileSync(settingsPath, '{}');

    const existing = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    const merged = mergeSettings(existing);
    writeFileSync(settingsPath, JSON.stringify(merged, null, 2));

    // Read back and verify
    const readBack = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    expect(readBack.hooks).toBeDefined();
    expect(readBack.mcpServers).toBeDefined();

    const hooks = readBack.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PostToolUse).toHaveLength(1);
  });

  it('uninstall after install removes our entries but keeps others', () => {
    const settingsPath = resolve(tmpDir, 'settings.json');
    const initial = {
      hooks: { PreToolUse: [{ matcher: '.*', command: 'keep-me' }] },
      mcpServers: { 'keep-server': { command: 'keep', args: [] } },
    };
    writeFileSync(settingsPath, JSON.stringify(initial));

    // Install
    let data = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    data = mergeSettings(data);
    writeFileSync(settingsPath, JSON.stringify(data, null, 2));

    // Uninstall
    data = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    data = removeSettings(data);
    writeFileSync(settingsPath, JSON.stringify(data, null, 2));

    const readBack = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    const hooks = readBack.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toEqual([{ matcher: '.*', command: 'keep-me' }]);

    const servers = readBack.mcpServers as Record<string, unknown>;
    expect(servers['keep-server']).toBeDefined();
    expect(servers['nr-ai-observability']).toBeUndefined();
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
