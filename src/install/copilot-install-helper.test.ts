import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  generateCopilotHooksFile,
  generateVsCodeMcpEntry,
  generateHookFilesLocationsPatch,
  detectCopilotHooksPath,
  detectVsCodeMcpPath,
  detectVsCodeSettingsPath,
  mergeCopilotHooksFile,
  removeCopilotHooksFile,
  mergeVsCodeMcpConfig,
  removeVsCodeMcpConfig,
  mergeVsCodeSettings,
  removeVsCodeHookFilesLocationsEntry,
  applyHookCollisionFix,
  COPILOT_MCP_SERVER_KEY,
  AGENT_DEBUG_LOG_SETTING,
} from './copilot-install-helper.js';
import { writeJsonFile } from './json-utils.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = resolve(
    tmpdir(),
    `nr-copilot-install-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe('generateCopilotHooksFile', () => {
  it('embeds a bare NEW_RELIC_AI_PLATFORM=copilot command when no binPath is given', () => {
    const file = generateCopilotHooksFile();
    expect(file.version).toBe(1);
    expect(file.hooks.PreToolUse[0]!.command).toBe(
      'NEW_RELIC_AI_PLATFORM=copilot preflight-collector pre-tool',
    );
    expect(file.hooks.PostToolUse[0]!.command).toBe(
      'NEW_RELIC_AI_PLATFORM=copilot preflight-collector post-tool',
    );
  });

  it('embeds a quoted absolute path plus the platform tag when binPath is given', () => {
    const file = generateCopilotHooksFile('/opt/homebrew/bin/preflight');
    expect(file.hooks.PreToolUse[0]!.command).toBe(
      'NEW_RELIC_AI_PLATFORM=copilot "/opt/homebrew/bin/preflight-collector" pre-tool',
    );
  });

  // Regression guard: GitHub's Copilot hooks schema is FLAT — each
  // PreToolUse/PostToolUse array entry is the command hook itself, not a
  // {matcher, hooks: [...]} wrapper like Claude Code's settings.json. Wrapping
  // it the Claude way made Copilot's hooks-runner silently never execute
  // these commands (confirmed live).
  it('emits the flat {type, command} shape, not a nested matcher/hooks wrapper', () => {
    const file = generateCopilotHooksFile();
    expect(file.hooks.PreToolUse[0]).toEqual({
      type: 'command',
      command: 'NEW_RELIC_AI_PLATFORM=copilot preflight-collector pre-tool',
    });
    expect(file.hooks.PostToolUse[0]).toEqual({
      type: 'command',
      command: 'NEW_RELIC_AI_PLATFORM=copilot preflight-collector post-tool',
    });
    expect(file.hooks.PreToolUse[0]).not.toHaveProperty('matcher');
    expect(file.hooks.PreToolUse[0]).not.toHaveProperty('hooks');
  });
});

describe('generateVsCodeMcpEntry', () => {
  it('tags the VS Code entry MCP_CLIENT=copilot regardless of the CLI registration', () => {
    const entry = generateVsCodeMcpEntry('/opt/homebrew/bin/preflight');
    expect(entry[COPILOT_MCP_SERVER_KEY]!.env.MCP_CLIENT).toBe('copilot');
    expect(entry[COPILOT_MCP_SERVER_KEY]!.type).toBe('stdio');
    expect(entry[COPILOT_MCP_SERVER_KEY]!.command).toBe('/opt/homebrew/bin/preflight');
    expect(entry[COPILOT_MCP_SERVER_KEY]!.args).toEqual(['--stdio']);
  });

  it('falls back to the bare command name when no binPath is given', () => {
    const entry = generateVsCodeMcpEntry(null);
    expect(entry[COPILOT_MCP_SERVER_KEY]!.command).toBe('preflight');
  });

  it('includes credentials only when provided', () => {
    const withoutCreds = generateVsCodeMcpEntry('/bin/preflight');
    expect(withoutCreds[COPILOT_MCP_SERVER_KEY]!.env.NEW_RELIC_LICENSE_KEY).toBeUndefined();

    const withCreds = generateVsCodeMcpEntry('/bin/preflight', {
      licenseKey: 'abc123',
      accountId: '456',
    });
    expect(withCreds[COPILOT_MCP_SERVER_KEY]!.env.NEW_RELIC_LICENSE_KEY).toBe('abc123');
    expect(withCreds[COPILOT_MCP_SERVER_KEY]!.env.NEW_RELIC_ACCOUNT_ID).toBe('456');
  });
});

describe('generateHookFilesLocationsPatch', () => {
  it('sets the given Claude settings path to false', () => {
    const patch = generateHookFilesLocationsPatch('/Users/x/.claude/settings.json');
    expect(patch['chat.hookFilesLocations']).toEqual({
      '/Users/x/.claude/settings.json': false,
    });
  });
});

// ---------------------------------------------------------------------------
// Path detection
// ---------------------------------------------------------------------------

describe('detectCopilotHooksPath', () => {
  it('resolves the user-level path under the home directory', () => {
    const path = detectCopilotHooksPath('user');
    expect(path.endsWith(join('.copilot', 'hooks', 'preflight.json'))).toBe(true);
  });

  it('resolves the project-level path under cwd', () => {
    const path = detectCopilotHooksPath('project');
    expect(path).toBe(resolve(process.cwd(), '.github', 'hooks', 'preflight.json'));
  });
});

describe('detectVsCodeMcpPath / detectVsCodeSettingsPath', () => {
  const originalPlatform = process.platform;
  const originalAppData = process.env.APPDATA;
  const originalXdg = process.env.XDG_CONFIG_HOME;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    if (originalAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = originalAppData;
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
  });

  it('resolves under Application Support on darwin', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const mcpPath = detectVsCodeMcpPath();
    expect(mcpPath).not.toBeNull();
    expect(mcpPath).toContain(join('Library', 'Application Support', 'Code', 'User', 'mcp.json'));
  });

  it('resolves under XDG_CONFIG_HOME on linux when set', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    process.env.XDG_CONFIG_HOME = '/custom/config';
    const settingsPath = detectVsCodeSettingsPath();
    expect(settingsPath).toBe(resolve('/custom/config', 'Code', 'User', 'settings.json'));
  });

  it('resolves under ~/.config on linux when XDG_CONFIG_HOME is unset', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    delete process.env.XDG_CONFIG_HOME;
    const settingsPath = detectVsCodeSettingsPath();
    expect(settingsPath).toContain(join('.config', 'Code', 'User', 'settings.json'));
  });

  it('resolves under APPDATA on win32', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    process.env.APPDATA = 'C:\\Users\\test\\AppData\\Roaming';
    const mcpPath = detectVsCodeMcpPath();
    expect(mcpPath).toBe(resolve('C:\\Users\\test\\AppData\\Roaming', 'Code', 'User', 'mcp.json'));
  });

  it('returns null on win32 when APPDATA is unset', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    delete process.env.APPDATA;
    expect(detectVsCodeMcpPath()).toBeNull();
    expect(detectVsCodeSettingsPath()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// mergeCopilotHooksFile / removeCopilotHooksFile
// ---------------------------------------------------------------------------

describe('mergeCopilotHooksFile', () => {
  it('writes fresh hooks into an empty file', () => {
    const merged = mergeCopilotHooksFile({}, '/bin/preflight');
    const hooks = merged.hooks as { PreToolUse: unknown[]; PostToolUse: unknown[] };
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PostToolUse).toHaveLength(1);
    expect(merged.version).toBe(1);
  });

  it('upgrades a stale bare-command entry to the absolute path when binPath is known', () => {
    const existing = {
      version: 1,
      hooks: {
        PreToolUse: [{ type: 'command', command: 'preflight-collector pre-tool' }],
        PostToolUse: [{ type: 'command', command: 'preflight-collector post-tool' }],
      },
    };
    const merged = mergeCopilotHooksFile(existing, '/opt/homebrew/bin/preflight');
    const hooks = merged.hooks as { PreToolUse: { command: string }[] };
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PreToolUse[0]!.command).toContain('/opt/homebrew/bin/preflight-collector');
  });

  it('does not downgrade a working absolute-path entry when binPath is unresolved', () => {
    const existing = {
      version: 1,
      hooks: {
        PreToolUse: [
          {
            type: 'command',
            command: 'NEW_RELIC_AI_PLATFORM=copilot "/abs/preflight-collector" pre-tool',
          },
        ],
        PostToolUse: [],
      },
    };
    const merged = mergeCopilotHooksFile(existing, null);
    const hooks = merged.hooks as { PreToolUse: { command: string }[] };
    expect(hooks.PreToolUse[0]!.command).toContain('/abs/preflight-collector');
  });

  it('preserves unrelated top-level keys', () => {
    const merged = mergeCopilotHooksFile({ someOtherKey: 'value' }, '/bin/preflight');
    expect(merged.someOtherKey).toBe('value');
  });

  it('throws on a malformed existing file', () => {
    expect(() =>
      mergeCopilotHooksFile({ hooks: { PreToolUse: 'not-an-array' } }, '/bin/preflight'),
    ).toThrow();
  });
});

describe('removeCopilotHooksFile', () => {
  it('removes NR hook entries and drops empty arrays', () => {
    const existing = {
      version: 1,
      hooks: {
        PreToolUse: [{ type: 'command', command: 'preflight-collector pre-tool' }],
        PostToolUse: [{ type: 'command', command: 'preflight-collector post-tool' }],
      },
    };
    const removed = removeCopilotHooksFile(existing);
    expect(removed.hooks).toBeUndefined();
  });

  it('preserves unrelated hook entries in the same array', () => {
    const existing = {
      hooks: {
        PreToolUse: [
          { type: 'command', command: 'preflight-collector pre-tool' },
          { type: 'command', command: 'some-other-tool pre-tool' },
        ],
        PostToolUse: [],
      },
    };
    const removed = removeCopilotHooksFile(existing);
    const hooks = removed.hooks as { PreToolUse: unknown[] };
    expect(hooks.PreToolUse).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// mergeVsCodeMcpConfig / removeVsCodeMcpConfig
// ---------------------------------------------------------------------------

describe('mergeVsCodeMcpConfig', () => {
  it('writes a fresh entry keyed under `servers`, not `mcpServers`', () => {
    const merged = mergeVsCodeMcpConfig({}, '/bin/preflight');
    expect(merged.mcpServers).toBeUndefined();
    const servers = merged.servers as Record<string, unknown>;
    expect(servers[COPILOT_MCP_SERVER_KEY]).toBeDefined();
  });

  it('preserves existing inputs and other servers', () => {
    const existing = {
      inputs: [{ id: 'foo', type: 'promptString' }],
      servers: { otherServer: { type: 'stdio', command: 'other' } },
    };
    const merged = mergeVsCodeMcpConfig(existing, '/bin/preflight');
    expect(merged.inputs).toEqual(existing.inputs);
    const servers = merged.servers as Record<string, unknown>;
    expect(servers.otherServer).toEqual({ type: 'stdio', command: 'other' });
    expect(servers[COPILOT_MCP_SERVER_KEY]).toBeDefined();
  });

  it('preserves user-added fields on the existing preflight entry when upgrading', () => {
    const existing = {
      servers: { [COPILOT_MCP_SERVER_KEY]: { type: 'stdio', command: 'old', timeout: 5000 } },
    };
    const merged = mergeVsCodeMcpConfig(existing, '/bin/preflight');
    const servers = merged.servers as Record<string, Record<string, unknown>>;
    expect(servers[COPILOT_MCP_SERVER_KEY]!.timeout).toBe(5000);
    expect(servers[COPILOT_MCP_SERVER_KEY]!.command).toBe('/bin/preflight');
  });

  it('does not downgrade an existing entry when binPath is unresolved', () => {
    const existing = { servers: { [COPILOT_MCP_SERVER_KEY]: { command: '/abs/preflight' } } };
    const merged = mergeVsCodeMcpConfig(existing, null);
    const servers = merged.servers as Record<string, Record<string, unknown>>;
    expect(servers[COPILOT_MCP_SERVER_KEY]!.command).toBe('/abs/preflight');
  });

  it('throws on a malformed existing file', () => {
    expect(() => mergeVsCodeMcpConfig({ servers: 'not-an-object' }, '/bin/preflight')).toThrow();
  });
});

describe('removeVsCodeMcpConfig', () => {
  it('removes only the preflight entry, preserving others', () => {
    const existing = {
      servers: {
        [COPILOT_MCP_SERVER_KEY]: { command: '/bin/preflight' },
        otherServer: { command: 'other' },
      },
    };
    const removed = removeVsCodeMcpConfig(existing);
    const servers = removed.servers as Record<string, unknown>;
    expect(servers[COPILOT_MCP_SERVER_KEY]).toBeUndefined();
    expect(servers.otherServer).toBeDefined();
  });

  it('drops the servers key entirely when it becomes empty', () => {
    const existing = { servers: { [COPILOT_MCP_SERVER_KEY]: { command: '/bin/preflight' } } };
    const removed = removeVsCodeMcpConfig(existing);
    expect(removed.servers).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// mergeVsCodeSettings / removeVsCodeHookFilesLocationsEntry
// ---------------------------------------------------------------------------

describe('mergeVsCodeSettings', () => {
  it('preserves unrelated settings keys', () => {
    const merged = mergeVsCodeSettings({ 'editor.fontSize': 14 }, { enableAgentDebugLog: true });
    expect(merged['editor.fontSize']).toBe(14);
  });

  it('merges into an existing chat.hookFilesLocations object without clobbering other entries', () => {
    const existing = { 'chat.hookFilesLocations': { '/some/other/hooks.json': false } };
    const merged = mergeVsCodeSettings(existing, {
      hookFilesLocationsPatch: { '/claude/settings.json': false },
    });
    expect(merged['chat.hookFilesLocations']).toEqual({
      '/some/other/hooks.json': false,
      '/claude/settings.json': false,
    });
  });

  it('sets the debug-log setting only when requested', () => {
    const merged = mergeVsCodeSettings({}, {});
    expect(merged[AGENT_DEBUG_LOG_SETTING]).toBeUndefined();
    const enabled = mergeVsCodeSettings({}, { enableAgentDebugLog: true });
    expect(enabled[AGENT_DEBUG_LOG_SETTING]).toBe(true);
  });
});

describe('removeVsCodeHookFilesLocationsEntry', () => {
  it('removes only the given path when it is exactly false', () => {
    const existing = {
      'chat.hookFilesLocations': { '/claude/settings.json': false, '/other.json': false },
    };
    const removed = removeVsCodeHookFilesLocationsEntry(existing, '/claude/settings.json');
    expect(removed['chat.hookFilesLocations']).toEqual({ '/other.json': false });
  });

  it('leaves the entry alone if the user has since changed it to something other than false', () => {
    const existing = { 'chat.hookFilesLocations': { '/claude/settings.json': true } };
    const removed = removeVsCodeHookFilesLocationsEntry(existing, '/claude/settings.json');
    expect(removed['chat.hookFilesLocations']).toEqual({ '/claude/settings.json': true });
  });

  it('drops the whole key when it becomes empty', () => {
    const existing = { 'chat.hookFilesLocations': { '/claude/settings.json': false } };
    const removed = removeVsCodeHookFilesLocationsEntry(existing, '/claude/settings.json');
    expect(removed['chat.hookFilesLocations']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// applyHookCollisionFix
// ---------------------------------------------------------------------------

describe('applyHookCollisionFix()', () => {
  let claudeSettingsPath: string;
  let copilotHooksPath: string;
  let vsCodeSettingsPath: string;

  const claudeHooksContent = {
    hooks: {
      PreToolUse: [
        { matcher: '', hooks: [{ type: 'command', command: 'preflight-collector pre-tool' }] },
      ],
      PostToolUse: [
        { matcher: '', hooks: [{ type: 'command', command: 'preflight-collector post-tool' }] },
      ],
    },
  };
  const copilotHooksContent = {
    version: 1,
    hooks: {
      PreToolUse: [
        { type: 'command', command: 'NEW_RELIC_AI_PLATFORM=copilot preflight-collector pre-tool' },
      ],
      PostToolUse: [
        {
          type: 'command',
          command: 'NEW_RELIC_AI_PLATFORM=copilot preflight-collector post-tool',
        },
      ],
    },
  };

  beforeEach(() => {
    claudeSettingsPath = join(tmpDir, 'claude-settings.json');
    copilotHooksPath = join(tmpDir, 'copilot-hooks.json');
    vsCodeSettingsPath = join(tmpDir, 'vscode-settings.json');
  });

  it('applies the patch when both hook locations are present', () => {
    writeJsonFile(claudeSettingsPath, claudeHooksContent, tmpDir);
    writeJsonFile(copilotHooksPath, copilotHooksContent, tmpDir);
    writeJsonFile(vsCodeSettingsPath, {}, tmpDir);

    const result = applyHookCollisionFix({
      claudeSettingsPath,
      copilotHooksPath,
      vsCodeSettingsPath,
      additionalAllowedBase: tmpDir,
    });

    expect(result.applied).toBe(true);
    const written = JSON.parse(readFileSync(vsCodeSettingsPath, 'utf-8'));
    expect(written['chat.hookFilesLocations']).toEqual({ [claudeSettingsPath]: false });
  });

  it('does not apply when only Claude hooks are present', () => {
    writeJsonFile(claudeSettingsPath, claudeHooksContent, tmpDir);
    writeJsonFile(vsCodeSettingsPath, {}, tmpDir);

    const result = applyHookCollisionFix({
      claudeSettingsPath,
      copilotHooksPath,
      vsCodeSettingsPath,
    });
    expect(result).toEqual({ applied: false, reason: 'copilot-hooks-absent' });
  });

  it('does not apply when only Copilot hooks are present', () => {
    writeJsonFile(copilotHooksPath, copilotHooksContent, tmpDir);
    writeJsonFile(vsCodeSettingsPath, {}, tmpDir);

    const result = applyHookCollisionFix({
      claudeSettingsPath,
      copilotHooksPath,
      vsCodeSettingsPath,
    });
    expect(result).toEqual({ applied: false, reason: 'claude-hooks-absent' });
  });

  it('does not apply when VS Code is not installed', () => {
    const result = applyHookCollisionFix({
      claudeSettingsPath,
      copilotHooksPath,
      vsCodeSettingsPath: null,
    });
    expect(result).toEqual({ applied: false, reason: 'vscode-settings-not-found' });
  });

  it('honors claudeHooksJustInstalled/copilotHooksJustInstalled flags without re-reading disk', () => {
    writeJsonFile(vsCodeSettingsPath, {}, tmpDir);
    // Neither file exists on disk yet — the caller asserts both are "just installed".
    const result = applyHookCollisionFix({
      claudeSettingsPath,
      copilotHooksPath,
      vsCodeSettingsPath,
      claudeHooksJustInstalled: true,
      copilotHooksJustInstalled: true,
      additionalAllowedBase: tmpDir,
    });
    expect(result.applied).toBe(true);
  });
});
