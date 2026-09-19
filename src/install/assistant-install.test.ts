import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ASSISTANT_MCP_SERVER_KEY,
  AssistantsOptionError,
  applyFileAssistantInstall,
  applyFileAssistantUninstall,
  commandContainsPreflightCollector,
  detectPresentAssistants,
  entryContainsPreflightCollector,
  generateCursorHooks,
  inspectAssistant,
  mergeAssistantMcpConfig,
  mergeCursorHooksFile,
  mergeKiroHooksFile,
  mergeWindsurfHooksFile,
  parseAssistantsOption,
  removeCursorHooksFile,
  removeKiroHooksFile,
  resolveInstallTargets,
  resolveUninstallTargets,
} from './assistant-install.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = resolve(
    tmpdir(),
    `nr-assistant-install-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function io(overrides?: Partial<{ scope: 'user' | 'project'; binPath: string | null }>) {
  return {
    home: tmpDir,
    cwd: tmpDir,
    scope: overrides?.scope ?? ('user' as const),
    binPath: overrides?.binPath === undefined ? '/opt/preflight/bin/preflight' : overrides.binPath,
    allowedBase: tmpDir,
  };
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
}

function writeJson(path: string, data: Record<string, unknown>): void {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Detection / --assistants parsing
// ---------------------------------------------------------------------------

describe('parseAssistantsOption', () => {
  it('treats a missing flag as detect-from-disk', () => {
    expect(parseAssistantsOption(undefined)).toEqual({ mode: 'detect' });
  });

  it('accepts all', () => {
    expect(parseAssistantsOption('all')).toEqual({ mode: 'all' });
  });

  it('accepts a comma-separated list and aliases', () => {
    expect(parseAssistantsOption('cursor, kiro, claude')).toEqual({
      mode: 'explicit',
      ids: ['cursor', 'kiro', 'claude-code'],
    });
  });

  it('rejects unknown names', () => {
    expect(() => parseAssistantsOption('cursor,nope')).toThrow(AssistantsOptionError);
    expect(() => parseAssistantsOption('cursor,nope')).toThrow(/Unknown assistant/);
  });

  it('rejects mixing all with specific names', () => {
    expect(() => parseAssistantsOption('all,cursor')).toThrow(/cannot be combined/);
  });

  it('rejects an empty list', () => {
    expect(() => parseAssistantsOption('  ,  ')).toThrow(/empty/);
  });
});

describe('detectPresentAssistants', () => {
  it('returns only assistants whose config dirs exist', () => {
    mkdirSync(join(tmpDir, '.cursor'), { recursive: true });
    mkdirSync(join(tmpDir, '.kiro'), { recursive: true });
    expect(detectPresentAssistants(tmpDir)).toEqual(['cursor', 'kiro']);
  });

  it('detects Windsurf via either ~/.windsurf or ~/.codeium/windsurf', () => {
    mkdirSync(join(tmpDir, '.codeium', 'windsurf'), { recursive: true });
    expect(detectPresentAssistants(tmpDir)).toEqual(['windsurf']);
    rmSync(join(tmpDir, '.codeium'), { recursive: true, force: true });
    mkdirSync(join(tmpDir, '.windsurf'), { recursive: true });
    expect(detectPresentAssistants(tmpDir)).toEqual(['windsurf']);
  });

  it('returns an empty list when the home has no assistant dirs', () => {
    expect(detectPresentAssistants(tmpDir)).toEqual([]);
  });
});

describe('resolveInstallTargets', () => {
  it('always includes Claude Code plus detected others when the flag is omitted', () => {
    mkdirSync(join(tmpDir, '.cursor'), { recursive: true });
    expect(resolveInstallTargets(undefined, tmpDir)).toEqual(['claude-code', 'cursor']);
  });

  it('does not require ~/.claude to exist for the default Claude target', () => {
    expect(resolveInstallTargets(undefined, tmpDir)).toEqual(['claude-code']);
  });

  it('--assistants overrides detection, including assistants that are not installed yet', () => {
    expect(resolveInstallTargets('windsurf,amazon-q', tmpDir)).toEqual(['windsurf', 'amazon-q']);
  });

  it('--assistants all returns every known id regardless of disk', () => {
    const targets = resolveInstallTargets('all', tmpDir);
    expect(targets).toContain('cursor');
    expect(targets).toContain('claude-code');
    expect(targets).toContain('copilot');
    expect(targets).toContain('kiro');
  });
});

describe('resolveUninstallTargets', () => {
  it('defaults to every assistant so leftover --assistants all files are cleaned', () => {
    expect(resolveUninstallTargets(undefined).length).toBeGreaterThan(4);
    expect(resolveUninstallTargets('all')).toEqual(resolveUninstallTargets(undefined));
  });

  it('restricts cleanup when an explicit list is given', () => {
    expect(resolveUninstallTargets('cursor')).toEqual(['cursor']);
  });
});

// ---------------------------------------------------------------------------
// Command matching
// ---------------------------------------------------------------------------

describe('entryContainsPreflightCollector', () => {
  it('matches bare, quoted, env-prefixed, nested, and Kiro action shapes', () => {
    expect(commandContainsPreflightCollector('preflight-collector')).toBe(true);
    expect(commandContainsPreflightCollector('"/abs/preflight-collector" pre-tool')).toBe(true);
    expect(commandContainsPreflightCollector('MCP_CLIENT=kiro preflight-collector')).toBe(true);
    expect(
      entryContainsPreflightCollector({
        matcher: '*',
        hooks: [{ type: 'command', command: 'preflight-collector' }],
      }),
    ).toBe(true);
    expect(
      entryContainsPreflightCollector({
        action: { type: 'command', command: 'MCP_CLIENT=kiro preflight-collector' },
      }),
    ).toBe(true);
  });

  it('does not match unrelated commands', () => {
    expect(entryContainsPreflightCollector({ command: 'eslint --fix' })).toBe(false);
    expect(entryContainsPreflightCollector({ command: 'not-preflight-collector' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cursor merge / idempotency / uninstall
// ---------------------------------------------------------------------------

describe('Cursor merge and uninstall', () => {
  it('merges hooks without clobbering unrelated user hooks', () => {
    const existing = {
      version: 1,
      hooks: {
        beforeShellExecution: [{ command: 'echo user-hook' }],
        sessionStart: [{ command: 'echo keep-me' }],
      },
    };
    const merged = mergeCursorHooksFile(existing, '/opt/preflight/bin/preflight');
    const hooks = merged.hooks as Record<string, unknown[]>;
    expect(hooks.beforeShellExecution).toEqual([
      { command: 'echo user-hook' },
      { command: '"/opt/preflight/bin/preflight-collector"' },
    ]);
    expect(hooks.sessionStart).toEqual([{ command: 'echo keep-me' }]);
    expect(hooks.afterFileEdit).toEqual([{ command: '"/opt/preflight/bin/preflight-collector"' }]);
  });

  it('is idempotent — a second merge does not duplicate our entries', () => {
    const first = mergeCursorHooksFile({}, '/opt/preflight/bin/preflight');
    const second = mergeCursorHooksFile(first, '/opt/preflight/bin/preflight');
    const hooks = second.hooks as Record<string, unknown[]>;
    expect(hooks.beforeShellExecution).toHaveLength(1);
    expect(first).toEqual(second);
  });

  it('upgrades a stale bare-name entry when binPath is resolved', () => {
    const stale = mergeCursorHooksFile({}, null);
    const upgraded = mergeCursorHooksFile(stale, '/opt/preflight/bin/preflight');
    const hooks = upgraded.hooks as Record<string, { command: string }[]>;
    expect(hooks.beforeShellExecution).toHaveLength(1);
    expect(hooks.beforeShellExecution[0]!.command).toBe('"/opt/preflight/bin/preflight-collector"');
  });

  it('removeCursorHooksFile leaves unrelated hooks in place', () => {
    const merged = mergeCursorHooksFile(
      { hooks: { beforeShellExecution: [{ command: 'echo user-hook' }] } },
      '/opt/bin/preflight',
    );
    const removed = removeCursorHooksFile(merged);
    const hooks = removed.hooks as Record<string, unknown[]>;
    expect(hooks.beforeShellExecution).toEqual([{ command: 'echo user-hook' }]);
    expect(hooks.afterFileEdit).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Windsurf / Kiro / Amazon Q / MCP apply against a temp home
// ---------------------------------------------------------------------------

describe('applyFileAssistantInstall / uninstall (temp home, no real $HOME)', () => {
  it('writes Cursor hooks.json and mcp.json under the injected home', () => {
    const result = applyFileAssistantInstall('cursor', io());
    const hooksPath = join(tmpDir, '.cursor', 'hooks.json');
    const mcpPath = join(tmpDir, '.cursor', 'mcp.json');
    expect(result.written).toEqual(expect.arrayContaining([hooksPath, mcpPath]));
    expect(existsSync(hooksPath)).toBe(true);
    const hooks = readJson(hooksPath);
    expect(hooks.version).toBe(1);
    const hookMap = hooks.hooks as Record<string, { command: string }[]>;
    expect(hookMap.beforeShellExecution[0]!.command).toContain('preflight-collector');
    const mcp = readJson(mcpPath);
    const servers = mcp.mcpServers as Record<
      string,
      { command: string; env?: Record<string, string> }
    >;
    expect(servers[ASSISTANT_MCP_SERVER_KEY]!.command).toBe('/opt/preflight/bin/preflight');
    expect(servers[ASSISTANT_MCP_SERVER_KEY]!.env?.MCP_CLIENT).toBe('cursor');
  });

  it('re-running Cursor install is idempotent on disk', () => {
    applyFileAssistantInstall('cursor', io());
    applyFileAssistantInstall('cursor', io());
    const hookMap = (readJson(join(tmpDir, '.cursor', 'hooks.json')).hooks ?? {}) as Record<
      string,
      unknown[]
    >;
    expect(hookMap.beforeShellExecution).toHaveLength(1);
  });

  it('writes Windsurf official user-level hooks and mcp_config.json', () => {
    applyFileAssistantInstall('windsurf', io());
    const hooksPath = join(tmpDir, '.codeium', 'windsurf', 'hooks.json');
    const mcpPath = join(tmpDir, '.codeium', 'windsurf', 'mcp_config.json');
    expect(existsSync(hooksPath)).toBe(true);
    expect(existsSync(mcpPath)).toBe(true);
    const hookMap = readJson(hooksPath).hooks as Record<string, unknown[]>;
    expect(hookMap.pre_read_code).toHaveLength(1);
    expect(hookMap.pre_run_command).toHaveLength(1);
  });

  it('writes Kiro MCP with NEW_RELIC_AI_PLATFORM=kiro and the standalone hooks file', () => {
    applyFileAssistantInstall('kiro', io());
    const hooksPath = join(tmpDir, '.kiro', 'hooks', 'preflight-observability.json');
    const mcpPath = join(tmpDir, '.kiro', 'settings', 'mcp.json');
    const hooksFile = readJson(hooksPath);
    expect(hooksFile.version).toBe('v1');
    const hooks = hooksFile.hooks as {
      name: string;
      trigger: string;
      action: { command: string };
    }[];
    expect(hooks).toHaveLength(2);
    expect(hooks[0]!.trigger).toBe('PreToolUse');
    expect(hooks[0]!.action.command).toContain('MCP_CLIENT=kiro');
    const servers = readJson(mcpPath).mcpServers as Record<
      string,
      { env?: Record<string, string> }
    >;
    expect(servers[ASSISTANT_MCP_SERVER_KEY]!.env?.NEW_RELIC_AI_PLATFORM).toBe('kiro');
  });

  it('Kiro merge keeps unrelated hooks in the same file', () => {
    const existing = {
      version: 'v1',
      hooks: [
        {
          name: 'lint-on-save',
          trigger: 'PostFileSave',
          action: { type: 'command', command: 'npm run lint' },
        },
      ],
    };
    const merged = mergeKiroHooksFile(existing, '/opt/bin/preflight');
    const hooks = merged.hooks as { name: string }[];
    expect(hooks.map((h) => h.name)).toEqual([
      'lint-on-save',
      'preflight-pre-tool',
      'preflight-post-tool',
    ]);
    const again = mergeKiroHooksFile(merged, '/opt/bin/preflight');
    expect(
      (again.hooks as unknown[]).filter((h) => entryContainsPreflightCollector(h)),
    ).toHaveLength(2);
  });

  it('writes Amazon Q MCP and merges hooks into existing cli-agents files only', () => {
    const agentPath = join(tmpDir, '.aws', 'amazonq', 'cli-agents', 'reviewer.json');
    writeJson(agentPath, { name: 'reviewer', tools: ['*'] });
    const result = applyFileAssistantInstall('amazon-q', io());
    expect(result.written).toEqual(
      expect.arrayContaining([join(tmpDir, '.aws', 'amazonq', 'mcp.json'), agentPath]),
    );
    const agent = readJson(agentPath);
    expect(agent.tools).toEqual(['*']);
    const hooks = agent.hooks as Record<string, { command: string }[]>;
    expect(hooks.preToolUse).toHaveLength(1);
    expect(hooks.postToolUse).toHaveLength(1);
  });

  it('does not invent an Amazon Q default agent when none exist', () => {
    const result = applyFileAssistantInstall('amazon-q', io());
    expect(existsSync(join(tmpDir, '.aws', 'amazonq', 'mcp.json'))).toBe(true);
    expect(existsSync(join(tmpDir, '.aws', 'amazonq', 'cli-agents'))).toBe(false);
    expect(result.skipped.some((s) => s.includes('No Amazon Q agent'))).toBe(true);
  });

  it('uninstall removes only Preflight entries and leaves user hooks / other MCP servers', () => {
    const cursorHooks = join(tmpDir, '.cursor', 'hooks.json');
    writeJson(cursorHooks, {
      version: 1,
      hooks: { beforeShellExecution: [{ command: 'echo keep' }] },
    });
    applyFileAssistantInstall('cursor', io());
    const mcpPath = join(tmpDir, '.cursor', 'mcp.json');
    const mcp = readJson(mcpPath);
    (mcp.mcpServers as Record<string, unknown>).other = { command: 'keep-me' };
    writeJson(mcpPath, mcp);

    applyFileAssistantUninstall('cursor', io());
    const hooks = readJson(cursorHooks).hooks as Record<string, unknown[]>;
    expect(hooks.beforeShellExecution).toEqual([{ command: 'echo keep' }]);
    expect(hooks.afterFileEdit).toBeUndefined();
    const servers = readJson(mcpPath).mcpServers as Record<string, unknown>;
    expect(servers[ASSISTANT_MCP_SERVER_KEY]).toBeUndefined();
    expect(servers.other).toEqual({ command: 'keep-me' });
  });

  it('uninstall deletes the dedicated Kiro hooks file when only our hooks remain', () => {
    applyFileAssistantInstall('kiro', io());
    const hooksPath = join(tmpDir, '.kiro', 'hooks', 'preflight-observability.json');
    expect(existsSync(hooksPath)).toBe(true);
    applyFileAssistantUninstall('kiro', io());
    expect(existsSync(hooksPath)).toBe(false);
    const servers = readJson(join(tmpDir, '.kiro', 'settings', 'mcp.json')).mcpServers;
    expect(servers).toBeUndefined();
  });

  it('Kiro uninstall keeps unrelated hooks in the same file', () => {
    applyFileAssistantInstall('kiro', io());
    const hooksPath = join(tmpDir, '.kiro', 'hooks', 'preflight-observability.json');
    const existing = readJson(hooksPath);
    (existing.hooks as unknown[]).unshift({
      name: 'lint-on-save',
      trigger: 'PostFileSave',
      action: { type: 'command', command: 'npm run lint' },
    });
    writeJson(hooksPath, existing);
    applyFileAssistantUninstall('kiro', io());
    expect(existsSync(hooksPath)).toBe(true);
    const hooks = readJson(hooksPath).hooks as { name: string }[];
    expect(hooks).toEqual([
      {
        name: 'lint-on-save',
        trigger: 'PostFileSave',
        action: { type: 'command', command: 'npm run lint' },
      },
    ]);
  });

  it('MCP merge preserves user env fields and replaces stale preflight keys', () => {
    const merged = mergeAssistantMcpConfig(
      {
        mcpServers: {
          preflight: { command: 'npx', args: ['preflight', '--stdio'] },
          other: { command: 'keep' },
          [ASSISTANT_MCP_SERVER_KEY]: {
            command: 'old',
            env: { KEEP_ME: 'yes', MCP_CLIENT: 'stale' },
          },
        },
      },
      'cursor',
      '/opt/bin/preflight',
    );
    const servers = merged.mcpServers as Record<
      string,
      { command: string; env?: Record<string, string> }
    >;
    expect(servers.preflight).toBeUndefined();
    expect(servers.other).toEqual({ command: 'keep' });
    expect(servers[ASSISTANT_MCP_SERVER_KEY]!.command).toBe('/opt/bin/preflight');
    expect(servers[ASSISTANT_MCP_SERVER_KEY]!.env?.KEEP_ME).toBe('yes');
    expect(servers[ASSISTANT_MCP_SERVER_KEY]!.env?.MCP_CLIENT).toBe('cursor');
  });

  it('does not write anything under the real home directory', () => {
    applyFileAssistantInstall('cursor', io());
    applyFileAssistantInstall('kiro', io());
    applyFileAssistantUninstall('cursor', io());
    // Every path we touched is under tmpDir (the injected home).
    for (const rel of ['.cursor/hooks.json', '.kiro/settings/mcp.json']) {
      expect(resolve(tmpDir, rel).startsWith(tmpDir)).toBe(true);
    }
  });
});

describe('inspectAssistant', () => {
  it('reports missing when files are absent', () => {
    const status = inspectAssistant('cursor', io());
    expect(status.hooks).toBe('missing');
    expect(status.mcp).toBe('missing');
    expect(status.detected).toBe(false);
  });

  it('reports ok after a successful install', () => {
    mkdirSync(join(tmpDir, '.cursor'), { recursive: true });
    applyFileAssistantInstall('cursor', io());
    const status = inspectAssistant('cursor', io());
    expect(status.detected).toBe(true);
    expect(status.hooks).toBe('ok');
    expect(status.mcp).toBe('ok');
  });

  it('reports partial when only some Cursor events are wired', () => {
    writeJson(join(tmpDir, '.cursor', 'hooks.json'), {
      version: 1,
      hooks: { beforeShellExecution: [{ command: 'preflight-collector' }] },
    });
    const status = inspectAssistant('cursor', io());
    expect(status.hooks).toBe('partial');
  });
});

describe('generateCursorHooks', () => {
  it('emits the six ADAPTERS.md events as flat {command} entries', () => {
    const file = generateCursorHooks();
    const hooks = file.hooks as Record<string, { command: string }[]>;
    expect(Object.keys(hooks)).toEqual([
      'beforeShellExecution',
      'afterShellExecution',
      'beforeMCPExecution',
      'afterMCPExecution',
      'beforeReadFile',
      'afterFileEdit',
    ]);
    expect(hooks.beforeShellExecution[0]).toEqual({ command: 'preflight-collector' });
  });
});

describe('mergeWindsurfHooksFile', () => {
  it('is idempotent and preserves extra events', () => {
    const first = mergeWindsurfHooksFile(
      { hooks: { pre_user_prompt: [{ command: 'echo keep' }] } },
      '/opt/bin/preflight',
    );
    const second = mergeWindsurfHooksFile(first, '/opt/bin/preflight');
    const hooks = second.hooks as Record<string, unknown[]>;
    expect(hooks.pre_read_code).toHaveLength(1);
    expect(hooks.pre_user_prompt).toEqual([{ command: 'echo keep' }]);
    expect(first).toEqual(second);
  });
});

describe('removeKiroHooksFile', () => {
  it('identifies our hooks by name prefix or collector command', () => {
    const removed = removeKiroHooksFile({
      version: 'v1',
      hooks: [
        { name: 'preflight-pre-tool', trigger: 'PreToolUse', action: { command: 'other' } },
        {
          name: 'custom',
          trigger: 'PreToolUse',
          action: { command: 'MCP_CLIENT=kiro preflight-collector' },
        },
        { name: 'keep', trigger: 'PostFileSave', action: { command: 'true' } },
      ],
    });
    expect(removed.hooks).toEqual([
      { name: 'keep', trigger: 'PostFileSave', action: { command: 'true' } },
    ]);
  });
});
