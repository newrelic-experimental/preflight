/**
 * Generates and merges the Kiro hook file. Kiro hooks are workspace-scoped
 * (`.kiro/hooks/`, see docs/KIRO_POWER.md), so the file is written relative
 * to a project directory, never to the home directory.
 *
 * The command carries `MCP_CLIENT=kiro` itself: Kiro runs hook commands as a
 * process separate from the MCP server and does not pass them the server's
 * `env` block.
 */

import { join } from 'node:path';

export const KIRO_HOOKS_FILE = 'preflight-observability.json';
const KIRO_HOOK_NAME_PREFIX = 'Preflight:';
const KIRO_HOOK_COMMAND = 'MCP_CLIENT=kiro preflight-collector';
const KIRO_HOOK_TIMEOUT_SECONDS = 10;

interface KiroHook {
  readonly name: string;
  readonly trigger: string;
  readonly action: { readonly type: 'command'; readonly command: string };
  readonly timeout: number;
}

export function kiroHooksPath(projectDir: string): string {
  return join(projectDir, '.kiro', 'hooks', KIRO_HOOKS_FILE);
}

export function generateKiroHooks(): readonly KiroHook[] {
  return [
    {
      name: 'Preflight: pre tool call',
      trigger: 'PreToolUse',
      action: { type: 'command', command: KIRO_HOOK_COMMAND },
      timeout: KIRO_HOOK_TIMEOUT_SECONDS,
    },
    {
      name: 'Preflight: post tool call',
      trigger: 'PostToolUse',
      action: { type: 'command', command: KIRO_HOOK_COMMAND },
      timeout: KIRO_HOOK_TIMEOUT_SECONDS,
    },
  ];
}

function withoutPreflightHooks(existing: Record<string, unknown>): unknown[] {
  const current = Array.isArray(existing.hooks) ? (existing.hooks as unknown[]) : [];
  return current.filter((h) => {
    const name = (h as { name?: unknown } | null)?.name;
    return !(typeof name === 'string' && name.startsWith(KIRO_HOOK_NAME_PREFIX));
  });
}

/** Replaces Preflight's own entries and keeps every other hook in the file. */
export function mergeKiroHooksFile(existing: Record<string, unknown>): Record<string, unknown> {
  return {
    version: 'v1',
    ...existing,
    hooks: [...withoutPreflightHooks(existing), ...generateKiroHooks()],
  };
}

/** Drops Preflight's own entries and keeps every other hook in the file. */
export function removeKiroHooksFile(existing: Record<string, unknown>): Record<string, unknown> {
  return { ...existing, hooks: withoutPreflightHooks(existing) };
}
