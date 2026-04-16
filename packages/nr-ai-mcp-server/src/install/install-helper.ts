/**
 * Pure logic for generating and merging Claude Code hook/MCP settings.
 *
 * All functions are side-effect-free — file I/O happens in the CLI layer (cli.ts).
 */

import { resolve } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOOK_COMMAND_PRE = 'nr-ai-observe pre-tool';
const HOOK_COMMAND_POST = 'nr-ai-observe post-tool';
const HOOK_MATCHER = '.*';
const MCP_SERVER_KEY = 'nr-ai-observability';
const MCP_SERVER_COMMAND = 'nr-ai-mcp-server';
const NR_OBSERVE_MARKER = 'nr-ai-observe';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HookEntry {
  matcher: string;
  command: string;
}

export interface HookEntries {
  PreToolUse: HookEntry[];
  PostToolUse: HookEntry[];
}

export interface McpServerConfig {
  command: string;
  args: string[];
}

export interface NrObserveConfig {
  licenseKey: string;
  accountId: string;
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

export function generateHookEntries(): HookEntries {
  return {
    PreToolUse: [{ matcher: HOOK_MATCHER, command: HOOK_COMMAND_PRE }],
    PostToolUse: [{ matcher: HOOK_MATCHER, command: HOOK_COMMAND_POST }],
  };
}

export function generateMcpServerEntry(): Record<string, McpServerConfig> {
  return {
    [MCP_SERVER_KEY]: { command: MCP_SERVER_COMMAND, args: ['--stdio'] },
  };
}

export function generateNrConfig(licenseKey: string, accountId: string): NrObserveConfig {
  return { licenseKey, accountId };
}

// ---------------------------------------------------------------------------
// Settings path detection
// ---------------------------------------------------------------------------

export function detectSettingsPath(scope: 'user' | 'project'): string {
  if (scope === 'user') {
    return resolve(homedir(), '.claude', 'settings.json');
  }
  return resolve(process.cwd(), '.claude', 'settings.json');
}

// ---------------------------------------------------------------------------
// Merge helpers
// ---------------------------------------------------------------------------

function hasNrObserveCommand(entries: unknown[]): boolean {
  return entries.some(
    (e) =>
      typeof e === 'object' &&
      e !== null &&
      'command' in e &&
      typeof (e as Record<string, unknown>).command === 'string' &&
      ((e as Record<string, unknown>).command as string).includes(NR_OBSERVE_MARKER),
  );
}

function filterNrObserveEntries(entries: unknown[]): unknown[] {
  return entries.filter(
    (e) =>
      !(
        typeof e === 'object' &&
        e !== null &&
        'command' in e &&
        typeof (e as Record<string, unknown>).command === 'string' &&
        ((e as Record<string, unknown>).command as string).includes(NR_OBSERVE_MARKER)
      ),
  );
}

// ---------------------------------------------------------------------------
// mergeSettings
// ---------------------------------------------------------------------------

export function mergeSettings(existing: Record<string, unknown>): Record<string, unknown> {
  const result = { ...existing };
  const hookEntries = generateHookEntries();

  // --- Hooks ---
  const hooks: Record<string, unknown> =
    typeof result.hooks === 'object' && result.hooks !== null
      ? { ...(result.hooks as Record<string, unknown>) }
      : {};

  for (const hookType of ['PreToolUse', 'PostToolUse'] as const) {
    const existingArr = Array.isArray(hooks[hookType]) ? [...(hooks[hookType] as unknown[])] : [];

    if (!hasNrObserveCommand(existingArr)) {
      existingArr.push(...hookEntries[hookType]);
    }

    hooks[hookType] = existingArr;
  }

  result.hooks = hooks;

  // --- MCP Servers ---
  const mcpServers: Record<string, unknown> =
    typeof result.mcpServers === 'object' && result.mcpServers !== null
      ? { ...(result.mcpServers as Record<string, unknown>) }
      : {};

  if (!(MCP_SERVER_KEY in mcpServers)) {
    const entry = generateMcpServerEntry();
    mcpServers[MCP_SERVER_KEY] = entry[MCP_SERVER_KEY];
  }

  result.mcpServers = mcpServers;

  return result;
}

// ---------------------------------------------------------------------------
// removeSettings
// ---------------------------------------------------------------------------

export function removeSettings(existing: Record<string, unknown>): Record<string, unknown> {
  const result = { ...existing };

  // --- Hooks ---
  if (typeof result.hooks === 'object' && result.hooks !== null) {
    const hooks = { ...(result.hooks as Record<string, unknown>) };

    for (const hookType of ['PreToolUse', 'PostToolUse'] as const) {
      if (Array.isArray(hooks[hookType])) {
        const filtered = filterNrObserveEntries(hooks[hookType] as unknown[]);
        if (filtered.length > 0) {
          hooks[hookType] = filtered;
        } else {
          delete hooks[hookType];
        }
      }
    }

    if (Object.keys(hooks).length > 0) {
      result.hooks = hooks;
    } else {
      delete result.hooks;
    }
  }

  // --- MCP Servers ---
  if (typeof result.mcpServers === 'object' && result.mcpServers !== null) {
    const mcpServers = { ...(result.mcpServers as Record<string, unknown>) };
    delete mcpServers[MCP_SERVER_KEY];

    if (Object.keys(mcpServers).length > 0) {
      result.mcpServers = mcpServers;
    } else {
      delete result.mcpServers;
    }
  }

  return result;
}
