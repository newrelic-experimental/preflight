/**
 * Logic for generating and merging GitHub Copilot hook/MCP settings — the
 * Copilot analog of `install-helper.ts`. Covers three separate files:
 *
 *   - `~/.copilot/hooks/preflight.json` (or `.github/hooks/preflight.json`) —
 *     shared by both the Copilot CLI and VS Code Copilot Chat.
 *   - VS Code's own `Code/User/mcp.json` — makes nr_observe_* tools available
 *     inside a VS Code Copilot Chat session.
 *   - VS Code's own `Code/User/settings.json` — the token-exact-cost debug
 *     log setting, and the fix for VS Code reading hook files from multiple
 *     locations at once (see `applyHookCollisionFix`).
 *
 * Most functions are pure/side-effect-free, with file I/O happening in the
 * CLI layer (cli.ts). `applyHookCollisionFix` is the one exception that reads
 * settings files directly, mirroring `readAndCheckHooks`'s documented
 * exception in `install-helper.ts`.
 *
 * The hooks file's commands embed the resolved platform tag directly
 * (`NEW_RELIC_AI_PLATFORM=copilot ...`) rather than relying on inherited
 * environment: Copilot's hooks-runner executes these commands with a plain
 * environment that does NOT include any `--env` vars set on a `copilot mcp
 * add` MCP-server registration — verified live against a real New Relic
 * account. Every hook-sourced Copilot event (CLI and VS Code Copilot Chat
 * both, since they share this one file) is tagged simply `'copilot'`.
 */

import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { z } from 'zod';
import { readJsonFileStrict, writeJsonFile, errMsg } from './json-utils.js';
import { entryContainsNrObserve } from './install-helper.js';
import { resolveDataDir } from '../deploy/data-paths.js';
import { copilotSdkExtensionInstallPath } from '../hooks/copilot-sdk-extension-health.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COLLECTOR_COMMAND = 'preflight-collector';
const MCP_SERVER_COMMAND = 'preflight';
export const COPILOT_MCP_SERVER_KEY = 'newrelic-preflight';
export const AGENT_DEBUG_LOG_SETTING = 'github.copilot.chat.agentDebugLog.fileLogging.enabled';
const HOOK_FILE_LOCATIONS_SETTING = 'chat.hookFilesLocations';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CopilotHookCommand {
  type: 'command';
  command: string;
}

export interface CopilotHooksFile {
  version: 1;
  hooks: { PreToolUse: CopilotHookCommand[]; PostToolUse: CopilotHookCommand[] };
}

export interface VsCodeMcpServerConfig {
  type: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

export function generateCopilotHooksFile(binPath?: string | null): CopilotHooksFile {
  // Quote the path so shells with sh -c don't split on spaces, matching
  // install-helper.ts's generateHookEntries() for Claude.
  const bin = binPath
    ? `"${join(dirname(binPath), COLLECTOR_COMMAND).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    : COLLECTOR_COMMAND;
  const pre = `NEW_RELIC_AI_PLATFORM=copilot ${bin} pre-tool`;
  const post = `NEW_RELIC_AI_PLATFORM=copilot ${bin} post-tool`;
  // Flat shape per GitHub's own Copilot hooks reference — each PreToolUse/
  // PostToolUse array entry is a command hook directly ({type, command}),
  // unlike Claude Code's settings.json which nests it one level deeper under
  // {matcher, hooks: [...]}. Wrapping it in Claude's shape here previously
  // made Copilot's hooks-runner silently fail to execute these commands at
  // all (confirmed live: zero hook events reached the collector after this
  // was written in the wrong shape, despite the file existing and validating
  // as JSON) — see docs/ADAPTERS.md and the adapters' own
  // getHookInstallInstructions() for the same flat shape.
  return {
    version: 1,
    hooks: {
      PreToolUse: [{ type: 'command', command: pre }],
      PostToolUse: [{ type: 'command', command: post }],
    },
  };
}

// MCP_CLIENT=copilot here is deliberately independent of the Copilot CLI's
// own `copilot mcp add --env MCP_CLIENT=copilot-sdk` registration (see
// registerCopilotMcpServer in cli.ts) — this env var only affects the MCP
// *server* process's own platform self-detection (session-level dashboard
// summaries, CopilotSdkAdapter's tool-name normalization for CLI sessions),
// not the hooks file's per-event NR tagging, which is controlled entirely by
// generateCopilotHooksFile's embedded NEW_RELIC_AI_PLATFORM=copilot above.
export function generateVsCodeMcpEntry(
  binPath?: string | null,
  creds?: { licenseKey?: string; accountId?: string },
): Record<string, VsCodeMcpServerConfig> {
  const command = binPath ? join(dirname(binPath), MCP_SERVER_COMMAND) : MCP_SERVER_COMMAND;
  const env: Record<string, string> = { MCP_CLIENT: 'copilot' };
  if (creds?.licenseKey) env.NEW_RELIC_LICENSE_KEY = creds.licenseKey;
  if (creds?.accountId) env.NEW_RELIC_ACCOUNT_ID = creds.accountId;
  return { [COPILOT_MCP_SERVER_KEY]: { type: 'stdio', command, args: ['--stdio'], env } };
}

export function generateHookFilesLocationsPatch(
  claudeSettingsPath: string,
): Record<string, Record<string, boolean>> {
  return { [HOOK_FILE_LOCATIONS_SETTING]: { [claudeSettingsPath]: false } };
}

// ---------------------------------------------------------------------------
// Path detection
// ---------------------------------------------------------------------------

export function detectCopilotHooksPath(scope: 'user' | 'project' = 'user'): string {
  if (scope === 'user') return resolve(homedir(), '.copilot', 'hooks', 'preflight.json');
  return resolve(process.cwd(), '.github', 'hooks', 'preflight.json');
}

// Resolves VS Code's "Code/User" user-data directory. macOS/Linux paths are
// confirmed only by strong analogy to settings.json's documented location
// (same "user profile folder" language VS Code's own docs use for both
// files); the Windows path is independently confirmed via a real user
// report. Callers must still check the resolved directory actually exists
// on disk before treating VS Code as present — this function only computes
// where the file *would* be.
function vsCodeUserDir(): string | null {
  if (process.platform === 'darwin') {
    return resolve(homedir(), 'Library', 'Application Support', 'Code', 'User');
  }
  if (process.platform === 'linux') {
    const xdgConfig = process.env.XDG_CONFIG_HOME?.trim();
    const configBase =
      xdgConfig && xdgConfig.length > 0 ? xdgConfig : resolve(homedir(), '.config');
    return resolve(configBase, 'Code', 'User');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim();
    if (!appData) return null;
    return resolve(appData, 'Code', 'User');
  }
  return null;
}

export function detectVsCodeMcpPath(): string | null {
  const dir = vsCodeUserDir();
  return dir ? resolve(dir, 'mcp.json') : null;
}

export function detectVsCodeSettingsPath(): string | null {
  const dir = vsCodeUserDir();
  return dir ? resolve(dir, 'settings.json') : null;
}

// ---------------------------------------------------------------------------
// Zod schemas — validate existing file shapes before merging
// ---------------------------------------------------------------------------

const HooksFieldSchema = z
  .object({
    PreToolUse: z.array(z.unknown()).optional(),
    PostToolUse: z.array(z.unknown()).optional(),
  })
  .passthrough();
const CopilotHooksSchema = z
  .object({ version: z.number().optional(), hooks: HooksFieldSchema.optional() })
  .passthrough();

const VsCodeMcpConfigSchema = z
  .object({ servers: z.record(z.string(), z.unknown()).optional() })
  .passthrough();

// ---------------------------------------------------------------------------
// mergeCopilotHooksFile / removeCopilotHooksFile
// ---------------------------------------------------------------------------

export function mergeCopilotHooksFile(
  existing: Record<string, unknown>,
  binPath?: string | null,
): Record<string, unknown> {
  const parsed = CopilotHooksSchema.safeParse(existing);
  if (!parsed.success) {
    throw new Error(
      `Existing Copilot hooks file has unexpected shape — fix manually before running install.\n${parsed.error.message}`,
    );
  }

  const result: Record<string, unknown> = { ...existing, version: 1 };
  const hookEntries = generateCopilotHooksFile(binPath).hooks;

  const hooks: Record<string, unknown> =
    typeof result.hooks === 'object' && result.hooks !== null
      ? { ...(result.hooks as Record<string, unknown>) }
      : {};

  for (const hookType of ['PreToolUse', 'PostToolUse'] as const) {
    const existingArr = Array.isArray(hooks[hookType]) ? [...(hooks[hookType] as unknown[])] : [];

    if (binPath !== null && binPath !== undefined) {
      // Resolved path available: remove stale entry and re-add with the
      // current absolute path so re-install always upgrades a bare-name or
      // outdated entry (matches mergeSettings's behavior for Claude).
      const withoutNr = existingArr.filter((e) => !entryContainsNrObserve(e));
      hooks[hookType] = [...withoutNr, ...hookEntries[hookType]];
    } else {
      // No path resolved: leave any existing entry untouched so a working
      // absolute-path hook is not downgraded to a bare name.
      if (!existingArr.some(entryContainsNrObserve)) {
        existingArr.push(...hookEntries[hookType]);
      }
      hooks[hookType] = existingArr;
    }
  }

  result.hooks = hooks;
  return result;
}

export function removeCopilotHooksFile(existing: Record<string, unknown>): Record<string, unknown> {
  const result = { ...existing };

  if (typeof result.hooks === 'object' && result.hooks !== null) {
    const hooks = { ...(result.hooks as Record<string, unknown>) };

    for (const hookType of ['PreToolUse', 'PostToolUse'] as const) {
      if (Array.isArray(hooks[hookType])) {
        const filtered = (hooks[hookType] as unknown[]).filter((e) => !entryContainsNrObserve(e));
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
// mergeVsCodeMcpConfig / removeVsCodeMcpConfig — operates on VS Code's own
// Code/User/mcp.json (top-level key is `servers`, not `mcpServers` — a real
// shape difference from Claude's .mcp.json).
// ---------------------------------------------------------------------------

export function mergeVsCodeMcpConfig(
  existing: Record<string, unknown>,
  binPath?: string | null,
  creds?: { licenseKey?: string; accountId?: string },
): Record<string, unknown> {
  const parsed = VsCodeMcpConfigSchema.safeParse(existing);
  if (!parsed.success) {
    throw new Error(
      `Existing VS Code MCP config file has unexpected shape — fix manually before running install.\n${parsed.error.message}`,
    );
  }

  const result = { ...existing };
  const servers: Record<string, unknown> =
    typeof result.servers === 'object' && result.servers !== null
      ? { ...(result.servers as Record<string, unknown>) }
      : {};

  if (binPath !== null && binPath !== undefined) {
    const newEntry = generateVsCodeMcpEntry(binPath, creds);
    const existingEntry =
      typeof servers[COPILOT_MCP_SERVER_KEY] === 'object' &&
      servers[COPILOT_MCP_SERVER_KEY] !== null
        ? (servers[COPILOT_MCP_SERVER_KEY] as Record<string, unknown>)
        : {};
    servers[COPILOT_MCP_SERVER_KEY] = { ...existingEntry, ...newEntry[COPILOT_MCP_SERVER_KEY] };
  } else if (!(COPILOT_MCP_SERVER_KEY in servers)) {
    servers[COPILOT_MCP_SERVER_KEY] = generateVsCodeMcpEntry(null, creds)[COPILOT_MCP_SERVER_KEY];
  }

  result.servers = servers;
  return result;
}

export function removeVsCodeMcpConfig(existing: Record<string, unknown>): Record<string, unknown> {
  const result = { ...existing };

  if (typeof result.servers === 'object' && result.servers !== null) {
    const servers = { ...(result.servers as Record<string, unknown>) };
    delete servers[COPILOT_MCP_SERVER_KEY];

    if (Object.keys(servers).length > 0) {
      result.servers = servers;
    } else {
      delete result.servers;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// mergeVsCodeSettings / removeVsCodeHookFilesLocationsEntry — operates on VS
// Code's own Code/User/settings.json. No Zod schema here: settings.json
// legitimately holds arbitrary keys of arbitrary shape from many extensions,
// so there's no meaningful sub-shape to validate beyond "it's an object",
// which readJsonFileStrict's contract already guarantees.
// ---------------------------------------------------------------------------

export function mergeVsCodeSettings(
  existing: Record<string, unknown>,
  patch: { hookFilesLocationsPatch?: Record<string, boolean>; enableAgentDebugLog?: boolean },
): Record<string, unknown> {
  const result = { ...existing };

  if (patch.hookFilesLocationsPatch) {
    const existingLocations =
      typeof result[HOOK_FILE_LOCATIONS_SETTING] === 'object' &&
      result[HOOK_FILE_LOCATIONS_SETTING] !== null
        ? (result[HOOK_FILE_LOCATIONS_SETTING] as Record<string, unknown>)
        : {};
    result[HOOK_FILE_LOCATIONS_SETTING] = {
      ...existingLocations,
      ...patch.hookFilesLocationsPatch,
    };
  }

  if (patch.enableAgentDebugLog) {
    result[AGENT_DEBUG_LOG_SETTING] = true;
  }

  return result;
}

// Uninstall only removes the specific claudeSettingsPath entry this
// installer added, and only if it's still exactly `false` (our fix) — never
// the whole chat.hookFilesLocations object, in case the user has unrelated
// entries there. The debug-log setting is deliberately left alone on
// uninstall — it's a user-facing preference, not exclusively ours.
export function removeVsCodeHookFilesLocationsEntry(
  existing: Record<string, unknown>,
  claudeSettingsPath: string,
): Record<string, unknown> {
  const result = { ...existing };

  if (
    typeof result[HOOK_FILE_LOCATIONS_SETTING] === 'object' &&
    result[HOOK_FILE_LOCATIONS_SETTING] !== null
  ) {
    const locations = { ...(result[HOOK_FILE_LOCATIONS_SETTING] as Record<string, unknown>) };
    if (locations[claudeSettingsPath] === false) {
      delete locations[claudeSettingsPath];
    }
    if (Object.keys(locations).length > 0) {
      result[HOOK_FILE_LOCATIONS_SETTING] = locations;
    } else {
      delete result[HOOK_FILE_LOCATIONS_SETTING];
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// applyHookCollisionFix — the one function here that reads files directly.
// ---------------------------------------------------------------------------

export interface HookCollisionFixResult {
  applied: boolean;
  reason?: 'vscode-settings-not-found' | 'claude-hooks-absent' | 'copilot-hooks-absent' | 'error';
}

/**
 * VS Code Copilot Chat reads hook files from both ~/.claude/settings.json
 * (Claude-format, read by default via chat.hookFilesLocations) and the
 * Copilot hooks file at the same time, with no dedup — verified live, every
 * tool call double-executes ("Executing 2 hook(s)") whenever both are
 * present, silently doubling toolCallCount and estimated cost. This patches
 * VS Code's settings.json to disable the Claude-format location so only the
 * Copilot hooks file fires.
 *
 * Called from BOTH the Claude-hooks install flow and the Copilot-hooks
 * install flow so the fix applies correctly regardless of install order —
 * pass `claudeHooksJustInstalled`/`copilotHooksJustInstalled` when the
 * caller just wrote that file this run (so this function doesn't need to
 * re-read a file its own caller already knows the state of).
 */
/**
 * Whether a hooks file has NR-pattern PreToolUse AND PostToolUse entries —
 * the two event types VS Code actually double-fires when it reads hooks from
 * both a Claude-format file and a Copilot-format file at once. Deliberately
 * narrower than install-helper.ts's own `areHooksInstalled` (which also
 * requires PermissionRequest/PermissionDenied, added for Claude's own
 * upgrade-detection): Copilot's hooks file never defines those two event
 * types at all (see generateCopilotHooksFile), so reusing that broader check
 * here would make this fix permanently unable to detect Copilot hooks as
 * present, and would also stop detecting older/partial Claude installs that
 * still double-fire.
 */
function hasNrToolUseHooks(content: Record<string, unknown>): boolean {
  const hooks = content.hooks;
  if (typeof hooks !== 'object' || hooks === null) return false;
  const h = hooks as Record<string, unknown>;
  return (['PreToolUse', 'PostToolUse'] as const).every((hookType) => {
    const arr = h[hookType];
    return Array.isArray(arr) && arr.some(entryContainsNrObserve);
  });
}

export function applyHookCollisionFix(opts: {
  claudeSettingsPath: string;
  copilotHooksPath: string;
  vsCodeSettingsPath: string | null;
  claudeHooksJustInstalled?: boolean;
  copilotHooksJustInstalled?: boolean;
  /** Forwarded to writeJsonFile's symlink guard — lets tests use a temp dir. */
  additionalAllowedBase?: string;
}): HookCollisionFixResult {
  if (!opts.vsCodeSettingsPath || !existsSync(dirname(opts.vsCodeSettingsPath))) {
    return { applied: false, reason: 'vscode-settings-not-found' };
  }

  const claudeHooksPresent =
    opts.claudeHooksJustInstalled ??
    (() => {
      try {
        return hasNrToolUseHooks(readJsonFileStrict(opts.claudeSettingsPath));
      } catch {
        return false;
      }
    })();
  if (!claudeHooksPresent) return { applied: false, reason: 'claude-hooks-absent' };

  const copilotHooksPresent =
    opts.copilotHooksJustInstalled ??
    (() => {
      try {
        return hasNrToolUseHooks(readJsonFileStrict(opts.copilotHooksPath));
      } catch {
        return false;
      }
    })();
  if (!copilotHooksPresent) return { applied: false, reason: 'copilot-hooks-absent' };

  try {
    const existing = readJsonFileStrict(opts.vsCodeSettingsPath);
    const merged = mergeVsCodeSettings(existing, {
      hookFilesLocationsPatch: generateHookFilesLocationsPatch(opts.claudeSettingsPath)[
        HOOK_FILE_LOCATIONS_SETTING
      ],
    });
    writeJsonFile(opts.vsCodeSettingsPath, merged, opts.additionalAllowedBase);
    return { applied: true };
  } catch {
    return { applied: false, reason: 'error' };
  }
}

// ---------------------------------------------------------------------------
// installCopilotSdkExtension — Copilot CLI only, for token-exact cost.
// ---------------------------------------------------------------------------

export interface SdkExtensionInstallResult {
  copied: boolean;
  reason?: string;
}

export function installCopilotSdkExtension(): SdkExtensionInstallResult {
  const destPath = copilotSdkExtensionInstallPath();
  if (existsSync(destPath)) return { copied: false, reason: 'exists' };

  let sourceDir: string;
  try {
    sourceDir = resolveDataDir('copilot-sdk-extension');
  } catch (err) {
    return { copied: false, reason: errMsg(err) };
  }

  try {
    mkdirSync(dirname(destPath), { recursive: true, mode: 0o700 });
    copyFileSync(resolve(sourceDir, 'extension.mjs'), destPath);
    return { copied: true };
  } catch (err) {
    return { copied: false, reason: errMsg(err) };
  }
}
