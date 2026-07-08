import { dirname } from 'node:path';
import { areHooksInstalled, mergeSettings, detectSettingsPath } from './install-helper.js';
import { readJsonFileStrict, writeJsonFile, errMsg } from './json-utils.js';
import { resolveBinaryPath } from './schedule.js';

export type HeadlessInstallResult =
  | { readonly status: 'installed'; readonly settingsPath: string }
  | { readonly status: 'already_installed'; readonly settingsPath: string }
  | { readonly status: 'error'; readonly message: string };

/**
 * Installs PreToolUse/PostToolUse hooks into ~/.claude/settings.json (or
 * the project-level equivalent) without a TTY. Does NOT touch ~/.mcp.json —
 * Smithery handles MCP server registration separately.
 *
 * Returns a typed result so MCP tool callers can format a user-facing message.
 */
export function installHooksHeadless(
  options: { scope?: 'user' | 'project'; _settingsPathOverride?: string } = {},
): HeadlessInstallResult {
  const scope = options.scope ?? 'user';
  const settingsPath = options._settingsPathOverride ?? detectSettingsPath(scope, null);
  const binPath = resolveBinaryPath();

  try {
    const existing = readJsonFileStrict(settingsPath);

    if (areHooksInstalled(existing)) {
      return { status: 'already_installed', settingsPath };
    }

    const merged = mergeSettings(existing, binPath);
    writeJsonFile(settingsPath, merged, dirname(settingsPath));
    return { status: 'installed', settingsPath };
  } catch (err) {
    return { status: 'error', message: errMsg(err) };
  }
}
