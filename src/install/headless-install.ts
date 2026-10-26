import { dirname } from 'node:path';
import { areHooksInstalled, mergeSettings, detectSettingsPath } from './install-helper.js';
import { readJsonFileStrict, writeJsonFile, errMsg } from './json-utils.js';
import { resolveBinaryPath } from './schedule.js';
import type { AuditTrailManager } from '../security/audit-trail.js';

export type HeadlessInstallResult =
  | { readonly status: 'installed'; readonly settingsPath: string }
  | { readonly status: 'already_installed'; readonly settingsPath: string }
  | { readonly status: 'disabled'; readonly message: string }
  | { readonly status: 'error'; readonly message: string };

export const HEADLESS_INSTALL_DISABLED_MESSAGE =
  'nr_observe_install_hooks is disabled, so no changes were made. Run `preflight install` in a terminal to install the hooks, or set "allowHeadlessInstall": true in your Preflight config (or NEW_RELIC_AI_ALLOW_HEADLESS_INSTALL=true) to let this tool install them.';

/**
 * Installs the preflight hook entries (PreToolUse, PostToolUse,
 * PermissionRequest, PermissionDenied) into ~/.claude/settings.json (or
 * the project-level equivalent) without a TTY. Does NOT touch ~/.mcp.json —
 * Smithery handles MCP server registration separately.
 *
 * Refuses unless `allowHeadlessInstall` is true. Any connected MCP client can
 * call the tool, so rewriting the user's agent hook config is opt-in. A refusal
 * reads and writes nothing.
 *
 * Returns a typed result so MCP tool callers can format a user-facing message.
 */
export function installHooksHeadless(
  options: {
    scope?: 'user' | 'project';
    allowHeadlessInstall?: boolean;
    _settingsPathOverride?: string;
  } = {},
): HeadlessInstallResult {
  if (options.allowHeadlessInstall !== true) {
    return { status: 'disabled', message: HEADLESS_INSTALL_DISABLED_MESSAGE };
  }
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

/**
 * Builds the `headlessInstaller` the MCP tool calls. `allowHeadlessInstall` is
 * captured by value, so callers rebuild the installer once config has loaded.
 * The audit trail is read at call time via `getAuditTrail`. An audit entry is written only when hooks were
 * actually changed, so a refusal or an already-installed no-op leaves no entry.
 */
export function createHeadlessInstaller(options: {
  allowHeadlessInstall: boolean;
  getAuditTrail: () => AuditTrailManager | undefined;
  _settingsPathOverride?: string;
}): () => HeadlessInstallResult {
  return () => {
    const result = installHooksHeadless({
      allowHeadlessInstall: options.allowHeadlessInstall,
      _settingsPathOverride: options._settingsPathOverride,
    });
    if (result.status === 'installed') {
      options.getAuditTrail()?.recordHeadlessHookInstall(result.settingsPath);
    }
    return result;
  };
}
