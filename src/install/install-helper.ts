/**
 * Pure logic for generating and merging Claude Code hook/MCP settings.
 *
 * All functions are side-effect-free — file I/O happens in the CLI layer (cli.ts).
 */

import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { PlatformTarget } from '../config.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOOK_MATCHER = '';
const MCP_SERVER_KEY = 'newrelic-preflight';
const MCP_SERVER_COMMAND = 'preflight';
const COLLECTOR_COMMAND = 'preflight-collector';
// Matches the hook commands this installer writes, in both bare-name and
// absolute-path forms (quoted or unquoted):
//   preflight-collector pre-tool
//   /abs/path/preflight-collector pre-tool
//   "/quoted/path/preflight-collector" pre-tool
const NR_HOOK_RE = /preflight-collector"?\s+(?:pre|post)-tool/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HookCommand {
  type: 'command';
  command: string;
}

export interface HookEntry {
  matcher: string;
  hooks: HookCommand[];
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

export function generateHookEntries(
  binPath?: string | null,
  options?: { platform?: PlatformTarget },
): HookEntries {
  let pre: string;
  let post: string;

  if (options?.platform === 'wsl-windows-cc') {
    // Windows Claude Code runs hooks via wsl.exe — call the WSL binary through interop.
    // Quote the path so cmd.exe doesn't split on spaces (e.g. /home/john doe/...).
    const collectorPath = binPath ? join(dirname(binPath), COLLECTOR_COMMAND) : COLLECTOR_COMMAND;
    const quotedPath = collectorPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    pre = `wsl.exe -e "${quotedPath}" pre-tool`;
    post = `wsl.exe -e "${quotedPath}" post-tool`;
  } else {
    // Quote the path so shells with sh -c don't split on spaces (e.g. /Users/John Doe/...).
    // Hook commands use preflight-collector (lightweight, <5ms budget).
    const bin = binPath
      ? `"${join(dirname(binPath), COLLECTOR_COMMAND).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
      : COLLECTOR_COMMAND;
    pre = `${bin} pre-tool`;
    post = `${bin} post-tool`;
  }

  return {
    PreToolUse: [{ matcher: HOOK_MATCHER, hooks: [{ type: 'command', command: pre }] }],
    PostToolUse: [{ matcher: HOOK_MATCHER, hooks: [{ type: 'command', command: post }] }],
  };
}

export function generateMcpServerEntry(
  binPath?: string | null,
  options?: { platform?: PlatformTarget },
): Record<string, McpServerConfig> {
  if (options?.platform === 'wsl-windows-cc') {
    // Windows Claude Code launches MCP servers as Windows processes — use wsl.exe interop.
    const serverPath = binPath ? join(dirname(binPath), MCP_SERVER_COMMAND) : MCP_SERVER_COMMAND;
    return {
      [MCP_SERVER_KEY]: { command: 'wsl.exe', args: ['-e', serverPath, '--stdio'] },
    };
  }
  // MCP server uses the main preflight binary.
  const command = binPath ? join(dirname(binPath), MCP_SERVER_COMMAND) : MCP_SERVER_COMMAND;
  return {
    [MCP_SERVER_KEY]: { command, args: ['--stdio'] },
  };
}

export function generateNrConfig(licenseKey: string, accountId: string): NrObserveConfig {
  return { licenseKey, accountId };
}

// ---------------------------------------------------------------------------
// Settings path detection
// ---------------------------------------------------------------------------

export function detectSettingsPath(scope: 'user' | 'project', windowsHome?: string | null): string {
  if (scope === 'user') {
    const base = windowsHome ?? homedir();
    return resolve(base, '.claude', 'settings.json');
  }
  return resolve(process.cwd(), '.claude', 'settings.json');
}

export function detectMcpConfigPath(
  scope: 'user' | 'project',
  windowsHome?: string | null,
): string {
  if (scope === 'user') {
    const base = windowsHome ?? homedir();
    return resolve(base, '.mcp.json');
  }
  return resolve(process.cwd(), '.mcp.json');
}

// ---------------------------------------------------------------------------
// Merge helpers
// ---------------------------------------------------------------------------

function entryContainsNrObserve(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const obj = entry as Record<string, unknown>;

  // New format: { matcher, hooks: [{ type, command }] }
  if (Array.isArray(obj.hooks)) {
    return obj.hooks.some(
      (h: unknown) =>
        typeof h === 'object' &&
        h !== null &&
        'command' in (h as Record<string, unknown>) &&
        typeof (h as Record<string, unknown>).command === 'string' &&
        NR_HOOK_RE.test((h as Record<string, unknown>).command as string),
    );
  }

  // Legacy flat format: { matcher, command }
  if ('command' in obj && typeof obj.command === 'string' && NR_HOOK_RE.test(obj.command)) {
    return true;
  }

  return false;
}

function filterNrObserveEntries(entries: unknown[]): unknown[] {
  return entries.filter((e) => !entryContainsNrObserve(e));
}

// ---------------------------------------------------------------------------
// Zod schemas — validate existing file shapes before merging
// ---------------------------------------------------------------------------

// Hooks: only require that PreToolUse/PostToolUse are arrays — individual
// entries may come from other tools in any shape, so we don't validate them.
const HooksFieldSchema = z
  .object({
    PreToolUse: z.array(z.unknown()).optional(),
    PostToolUse: z.array(z.unknown()).optional(),
  })
  .passthrough();
const SettingsSchema = z.object({ hooks: HooksFieldSchema.optional() }).passthrough();

// MCP config: only require mcpServers is a string-keyed record — individual
// entries may be stdio ({command, args}) or remote ({url, transport}), so we
// don't validate their shape.
const McpConfigSchema = z
  .object({
    mcpServers: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// mergeSettings
// ---------------------------------------------------------------------------

export function mergeSettings(
  existing: Record<string, unknown>,
  binPath?: string | null,
  options?: { platform?: PlatformTarget },
): Record<string, unknown> {
  const parsed = SettingsSchema.safeParse(existing);
  if (!parsed.success) {
    throw new Error(
      `Existing settings file has unexpected shape — fix manually before running install.\n${parsed.error.message}`,
    );
  }

  const result = { ...existing };
  const hookEntries = generateHookEntries(binPath, options);

  // --- Hooks ---
  const hooks: Record<string, unknown> =
    typeof result.hooks === 'object' && result.hooks !== null
      ? { ...(result.hooks as Record<string, unknown>) }
      : {};

  for (const hookType of ['PreToolUse', 'PostToolUse'] as const) {
    const existingArr = Array.isArray(hooks[hookType]) ? [...(hooks[hookType] as unknown[])] : [];

    if (binPath !== null && binPath !== undefined) {
      // Resolved path available: remove stale entry and re-add with the current
      // absolute path so re-install always upgrades a bare-name or outdated entry.
      const withoutNr = filterNrObserveEntries(existingArr);
      hooks[hookType] = [...withoutNr, ...hookEntries[hookType]];
    } else {
      // No path resolved (binary not on PATH): leave any existing entry untouched
      // so a working absolute-path hook is not downgraded to a bare name.
      if (!existingArr.some(entryContainsNrObserve)) {
        existingArr.push(...hookEntries[hookType]);
      }
      hooks[hookType] = existingArr;
    }
  }

  result.hooks = hooks;

  return result;
}

// ---------------------------------------------------------------------------
// mergeMcpConfig — operates on ~/.mcp.json (separate from settings.json)
// ---------------------------------------------------------------------------

export function mergeMcpConfig(
  existing: Record<string, unknown>,
  binPath?: string | null,
  options?: { platform?: PlatformTarget },
): Record<string, unknown> {
  const parsed = McpConfigSchema.safeParse(existing);
  if (!parsed.success) {
    throw new Error(
      `Existing MCP config file has unexpected shape — fix manually before running install.\n${parsed.error.message}`,
    );
  }

  const result = { ...existing };

  const mcpServers: Record<string, unknown> =
    typeof result.mcpServers === 'object' && result.mcpServers !== null
      ? { ...(result.mcpServers as Record<string, unknown>) }
      : {};

  // Remove stale keys from previous installs so ~/.mcp.json doesn't accumulate
  // duplicate server entries under old names.
  for (const staleKey of ['preflight', 'nr-ai-observability']) {
    delete mcpServers[staleKey];
  }

  if (binPath !== null && binPath !== undefined) {
    // Resolved path available: merge new command/args into existing entry,
    // preserving any user-added fields (env, timeout, etc.).
    const newEntry = generateMcpServerEntry(binPath, options);
    const existingEntry =
      typeof mcpServers[MCP_SERVER_KEY] === 'object' && mcpServers[MCP_SERVER_KEY] !== null
        ? (mcpServers[MCP_SERVER_KEY] as Record<string, unknown>)
        : {};
    mcpServers[MCP_SERVER_KEY] = { ...existingEntry, ...newEntry[MCP_SERVER_KEY] };
  } else if (!(MCP_SERVER_KEY in mcpServers)) {
    // No path resolved: only add if absent so a working absolute-path entry
    // is not downgraded to a bare name.
    mcpServers[MCP_SERVER_KEY] = generateMcpServerEntry(null, options)[MCP_SERVER_KEY];
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

  return result;
}

// ---------------------------------------------------------------------------
// removeMcpConfig — operates on ~/.mcp.json (separate from settings.json)
// ---------------------------------------------------------------------------

export function removeMcpConfig(existing: Record<string, unknown>): Record<string, unknown> {
  const result = { ...existing };

  if (typeof result.mcpServers === 'object' && result.mcpServers !== null) {
    const mcpServers = { ...(result.mcpServers as Record<string, unknown>) };
    delete mcpServers[MCP_SERVER_KEY];
    // Also remove stale keys from prior installs so uninstall is complete even
    // when the user never ran `preflight install` after upgrading.
    for (const staleKey of ['preflight', 'nr-ai-observability']) {
      delete mcpServers[staleKey];
    }

    if (Object.keys(mcpServers).length > 0) {
      result.mcpServers = mcpServers;
    } else {
      delete result.mcpServers;
    }
  }

  return result;
}
