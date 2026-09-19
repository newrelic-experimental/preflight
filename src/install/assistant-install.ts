/**
 * Multi-assistant install table for `preflight install` / `uninstall` / `doctor`.
 *
 * Claude Code and GitHub Copilot keep their dedicated writers
 * (`install-helper.ts`, `copilot-install-helper.ts`) because of WSL path
 * targeting and the VS Code collision fix. Every other file-based full-hooks
 * assistant is installed from this table with the same merge-and-filter
 * semantics: strip our previous entries, append the current ones, never
 * clobber unrelated user hooks.
 *
 * Detection is "config directory exists", matching issue #721. Hook/MCP JSON
 * and paths are taken from `docs/ADAPTERS.md` / each adapter's
 * `getHookInstallInstructions()`, with official-doc citations on any path
 * that ADAPTERS.md only named at project scope.
 *
 * Plugin-based platforms (opencode, Kilo Code, Pi) and mcp-tools-only
 * platforms (Zed, Continue, Cline) are intentionally absent — they have no
 * mergeable hooks.json, and this issue does not expand into #555 native
 * installers.
 */

import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';

import { createLogger } from '../shared/index.js';
import { readJsonFileStrict, writeJsonFile } from './json-utils.js';

const logger = createLogger('assistant-install');

const COLLECTOR_COMMAND = 'preflight-collector';
const MCP_SERVER_COMMAND = 'preflight';
export const ASSISTANT_MCP_SERVER_KEY = 'newrelic-preflight';
const STALE_MCP_KEYS = ['preflight', 'nr-ai-observability'] as const;
const KIRO_HOOKS_FILENAME = 'preflight-observability.json';

/**
 * Matches the collector binary name as a path tail or bare command, so we
 * recognize both `preflight-collector` and `"/abs/path/preflight-collector"`.
 * Does not require a subcommand — Cursor/Windsurf/Kiro/Amazon Q/Droid/Codex
 * invoke the collector with no argv marker (it dispatches on the payload).
 */
const PREFLIGHT_COLLECTOR_RE = /(?:^|[\s/\\"])preflight-collector(?:[\s"]|$)/;

// ---------------------------------------------------------------------------
// Assistant ids
// ---------------------------------------------------------------------------

/**
 * Canonical ids match `PlatformAdapter.platformName` so `--platform` and
 * `--assistants` share one vocabulary. `claude` / `amazonq` / `gemini` are
 * accepted as aliases in `parseAssistantsOption`.
 */
export const ASSISTANT_IDS = [
  'claude-code',
  'cursor',
  'windsurf',
  'kiro',
  'amazon-q',
  'copilot',
  'droid',
  'gemini-cli',
  'codex',
] as const;

export type AssistantId = (typeof ASSISTANT_IDS)[number];

/** Assistants whose hook/MCP files this module writes (not Claude, not Copilot). */
export const FILE_ASSISTANT_IDS = [
  'cursor',
  'windsurf',
  'kiro',
  'amazon-q',
  'droid',
  'gemini-cli',
  'codex',
] as const;

export type FileAssistantId = (typeof FILE_ASSISTANT_IDS)[number];

const ASSISTANT_ALIASES: Record<string, AssistantId> = {
  claude: 'claude-code',
  'claude-code': 'claude-code',
  cursor: 'cursor',
  windsurf: 'windsurf',
  kiro: 'kiro',
  'amazon-q': 'amazon-q',
  amazonq: 'amazon-q',
  copilot: 'copilot',
  droid: 'droid',
  'gemini-cli': 'gemini-cli',
  gemini: 'gemini-cli',
  codex: 'codex',
};

export const ASSISTANT_DISPLAY_NAMES: Record<AssistantId, string> = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  kiro: 'Amazon Kiro',
  'amazon-q': 'Amazon Q Developer CLI',
  copilot: 'GitHub Copilot',
  droid: 'Factory Droid',
  'gemini-cli': 'Gemini CLI',
  codex: 'OpenAI Codex',
};

export function isAssistantId(value: string): value is AssistantId {
  return (ASSISTANT_IDS as readonly string[]).includes(value);
}

export function isFileAssistantId(value: string): value is FileAssistantId {
  return (FILE_ASSISTANT_IDS as readonly string[]).includes(value);
}

export function formatAssistantIdList(): string {
  return ASSISTANT_IDS.join(', ');
}

// ---------------------------------------------------------------------------
// Option parsing / detection
// ---------------------------------------------------------------------------

export type AssistantsResolution =
  | { readonly mode: 'detect' }
  | { readonly mode: 'all' }
  | { readonly mode: 'explicit'; readonly ids: readonly AssistantId[] };

export class AssistantsOptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssistantsOptionError';
  }
}

/**
 * Parse `--assistants <list>`. `undefined` means detect-from-disk.
 * `all` configures every known assistant, including ones not installed yet.
 */
export function parseAssistantsOption(raw: string | undefined): AssistantsResolution {
  if (raw === undefined) return { mode: 'detect' };
  const tokens = raw
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) {
    throw new AssistantsOptionError(
      `--assistants was empty. Pass a comma-separated list, or "all". Supported: ${formatAssistantIdList()}`,
    );
  }
  if (tokens.includes('all')) {
    if (tokens.length > 1) {
      throw new AssistantsOptionError(
        `"all" cannot be combined with specific assistant names. Use --assistants all, or a list such as cursor,kiro.`,
      );
    }
    return { mode: 'all' };
  }
  const ids: AssistantId[] = [];
  const unknown: string[] = [];
  for (const token of tokens) {
    const mapped = ASSISTANT_ALIASES[token];
    if (mapped === undefined) {
      unknown.push(token);
    } else if (!ids.includes(mapped)) {
      ids.push(mapped);
    }
  }
  if (unknown.length > 0) {
    throw new AssistantsOptionError(
      `Unknown assistant${unknown.length > 1 ? 's' : ''} "${unknown.join(', ')}". Supported: ${formatAssistantIdList()}`,
    );
  }
  return { mode: 'explicit', ids };
}

export interface DetectOptions {
  readonly home: string;
}

/**
 * An assistant is "present" when at least one of its documented config
 * directories exists under `home`. Dirs are from ADAPTERS.md / the issue
 * (#721) plus the official user-level Windsurf path (`~/.codeium/windsurf`).
 */
export function detectDirsFor(id: AssistantId, home: string): readonly string[] {
  switch (id) {
    case 'claude-code':
      return [resolve(home, '.claude')];
    case 'cursor':
      return [resolve(home, '.cursor')];
    case 'windsurf':
      // ADAPTERS.md names `.windsurf/` (project). Official user-level hooks/MCP
      // live under ~/.codeium/windsurf — https://docs.windsurf.com/windsurf/cascade/hooks
      // and https://docs.windsurf.com/windsurf/cascade/mcp (mcp_config.json).
      return [resolve(home, '.windsurf'), resolve(home, '.codeium', 'windsurf')];
    case 'kiro':
      return [resolve(home, '.kiro')];
    case 'amazon-q':
      return [resolve(home, '.aws', 'amazonq')];
    case 'copilot':
      return [resolve(home, '.copilot')];
    case 'droid':
      return [resolve(home, '.factory')];
    case 'gemini-cli':
      return [resolve(home, '.gemini')];
    case 'codex':
      return [resolve(home, '.codex')];
  }
}

export function isAssistantPresent(id: AssistantId, home: string): boolean {
  return detectDirsFor(id, home).some((dir) => existsSync(dir));
}

export function detectPresentAssistants(home: string): AssistantId[] {
  return ASSISTANT_IDS.filter((id) => isAssistantPresent(id, home));
}

/**
 * Default install: always include Claude Code (backward compatible — today's
 * `preflight install` creates ~/.claude/settings.json even when that dir is
 * missing) plus every other assistant whose config dir exists.
 *
 * `--assistants` / `--assistants all` replace that set entirely.
 */
export function resolveInstallTargets(raw: string | undefined, home: string): AssistantId[] {
  const parsed = parseAssistantsOption(raw);
  if (parsed.mode === 'all') return [...ASSISTANT_IDS];
  if (parsed.mode === 'explicit') return [...parsed.ids];
  const detected = detectPresentAssistants(home).filter((id) => id !== 'claude-code');
  return ['claude-code', ...detected];
}

/**
 * Default uninstall cleans every assistant we might have written (not only
 * currently detected dirs — `--assistants all` may have created files). An
 * explicit `--assistants` list restricts cleanup to those ids.
 */
export function resolveUninstallTargets(raw: string | undefined): AssistantId[] {
  const parsed = parseAssistantsOption(raw);
  if (parsed.mode === 'detect' || parsed.mode === 'all') return [...ASSISTANT_IDS];
  return [...parsed.ids];
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export interface AssistantIoOptions {
  readonly home: string;
  readonly cwd?: string;
  readonly scope: 'user' | 'project';
  readonly binPath?: string | null;
  readonly creds?: { readonly licenseKey?: string; readonly accountId?: string };
  /** Forwarded to writeJsonFile's symlink guard (temp homes in tests). */
  readonly allowedBase?: string;
}

export interface AssistantPaths {
  readonly hooksPath?: string;
  readonly mcpPath?: string;
  /** Amazon Q only — merge hooks into each existing `*.json` here. */
  readonly agentDir?: string;
}

export function resolveAssistantPaths(id: AssistantId, opts: AssistantIoOptions): AssistantPaths {
  const cwd = opts.cwd ?? process.cwd();
  const base = opts.scope === 'project' ? cwd : opts.home;

  switch (id) {
    case 'claude-code':
      return {
        hooksPath:
          opts.scope === 'project'
            ? resolve(cwd, '.claude', 'settings.json')
            : resolve(opts.home, '.claude', 'settings.json'),
        mcpPath:
          opts.scope === 'project' ? resolve(cwd, '.mcp.json') : resolve(opts.home, '.mcp.json'),
      };
    case 'cursor':
      // hooks: ADAPTERS.md + https://cursor.com/docs/hooks
      // mcp: https://cursor.com/docs/mcp (`~/.cursor/mcp.json` global)
      return {
        hooksPath: resolve(base, '.cursor', 'hooks.json'),
        mcpPath: resolve(base, '.cursor', 'mcp.json'),
      };
    case 'windsurf':
      // Project: `.windsurf/hooks.json` / `.windsurf/mcp_config.json` (ADAPTERS.md).
      // User: `~/.codeium/windsurf/hooks.json` + `mcp_config.json`
      // (https://docs.windsurf.com/windsurf/cascade/hooks).
      if (opts.scope === 'project') {
        return {
          hooksPath: resolve(cwd, '.windsurf', 'hooks.json'),
          mcpPath: resolve(cwd, '.windsurf', 'mcp_config.json'),
        };
      }
      return {
        hooksPath: resolve(opts.home, '.codeium', 'windsurf', 'hooks.json'),
        mcpPath: resolve(opts.home, '.codeium', 'windsurf', 'mcp_config.json'),
      };
    case 'kiro':
      // MCP: ADAPTERS.md `~/.kiro/settings/mcp.json`.
      // Hooks: #117 + kiro.dev/docs/configuration — `~/.kiro/hooks/` (global)
      // and `.kiro/hooks/` (project). Filename from KiroAdapter.
      return {
        hooksPath: resolve(base, '.kiro', 'hooks', KIRO_HOOKS_FILENAME),
        mcpPath: resolve(base, '.kiro', 'settings', 'mcp.json'),
      };
    case 'amazon-q':
      // MCP: ADAPTERS.md `~/.aws/amazonq/mcp.json` / `.amazonq/mcp.json`.
      // Hooks: per-agent, `~/.aws/amazonq/cli-agents/<name>.json`
      // (https://aws.github.io/amazon-q-developer-cli/agent-format.html#hooks-field).
      if (opts.scope === 'project') {
        return {
          mcpPath: resolve(cwd, '.amazonq', 'mcp.json'),
          agentDir: resolve(cwd, '.amazonq', 'cli-agents'),
        };
      }
      return {
        mcpPath: resolve(opts.home, '.aws', 'amazonq', 'mcp.json'),
        agentDir: resolve(opts.home, '.aws', 'amazonq', 'cli-agents'),
      };
    case 'copilot':
      return {
        hooksPath:
          opts.scope === 'project'
            ? resolve(cwd, '.github', 'hooks', 'preflight.json')
            : resolve(opts.home, '.copilot', 'hooks', 'preflight.json'),
      };
    case 'droid':
      // ADAPTERS.md: `~/.factory/hooks.json` / `.factory/hooks.json`
      return { hooksPath: resolve(base, '.factory', 'hooks.json') };
    case 'gemini-cli':
      // ADAPTERS.md: `~/.gemini/settings.json` / `.gemini/settings.json`
      return { hooksPath: resolve(base, '.gemini', 'settings.json') };
    case 'codex':
      // ADAPTERS.md: `~/.codex/hooks.json` / `<repo>/.codex/hooks.json`
      return { hooksPath: resolve(base, '.codex', 'hooks.json') };
  }
}

// ---------------------------------------------------------------------------
// Command / entry helpers
// ---------------------------------------------------------------------------

export function quoteCollectorInvocation(binPath?: string | null): string {
  if (binPath === null || binPath === undefined) return COLLECTOR_COMMAND;
  const collectorPath = join(dirname(binPath), COLLECTOR_COMMAND);
  return `"${collectorPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function resolvePreflightCommand(binPath?: string | null): string {
  if (binPath === null || binPath === undefined) return MCP_SERVER_COMMAND;
  return join(dirname(binPath), MCP_SERVER_COMMAND);
}

export function commandContainsPreflightCollector(command: string): boolean {
  return PREFLIGHT_COLLECTOR_RE.test(command);
}

export function entryContainsPreflightCollector(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const obj = entry as Record<string, unknown>;

  if (typeof obj.command === 'string' && commandContainsPreflightCollector(obj.command)) {
    return true;
  }
  if (Array.isArray(obj.hooks) && obj.hooks.some(entryContainsPreflightCollector)) {
    return true;
  }
  if (typeof obj.action === 'object' && obj.action !== null) {
    const action = obj.action as Record<string, unknown>;
    if (typeof action.command === 'string' && commandContainsPreflightCollector(action.command)) {
      return true;
    }
  }
  return false;
}

function filterPreflightEntries(entries: unknown[]): unknown[] {
  return entries.filter((e) => !entryContainsPreflightCollector(e));
}

function mergeEventArrays(
  existingHooks: Record<string, unknown>,
  newEntries: Record<string, unknown[]>,
  binPath?: string | null,
): Record<string, unknown> {
  const hooks = { ...existingHooks };
  for (const [event, generated] of Object.entries(newEntries)) {
    const existingArr = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
    if (binPath !== null && binPath !== undefined) {
      hooks[event] = [...filterPreflightEntries(existingArr), ...generated];
    } else if (!existingArr.some(entryContainsPreflightCollector)) {
      hooks[event] = [...existingArr, ...generated];
    } else {
      hooks[event] = existingArr;
    }
  }
  return hooks;
}

function removeEventArrays(
  existingHooks: Record<string, unknown>,
  events: readonly string[],
): Record<string, unknown> {
  const hooks = { ...existingHooks };
  for (const event of events) {
    if (!Array.isArray(hooks[event])) continue;
    const filtered = filterPreflightEntries(hooks[event] as unknown[]);
    if (filtered.length > 0) hooks[event] = filtered;
    else delete hooks[event];
  }
  return hooks;
}

function eventsWired(
  hooks: Record<string, unknown>,
  events: readonly string[],
): { readonly wired: readonly string[]; readonly missing: readonly string[] } {
  const wired: string[] = [];
  const missing: string[] = [];
  for (const event of events) {
    const arr = hooks[event];
    if (Array.isArray(arr) && arr.some(entryContainsPreflightCollector)) wired.push(event);
    else missing.push(event);
  }
  return { wired, missing };
}

// ---------------------------------------------------------------------------
// Generators — hook payloads from ADAPTERS.md / adapter instructions
// ---------------------------------------------------------------------------

const CURSOR_HOOK_EVENTS = [
  'beforeShellExecution',
  'afterShellExecution',
  'beforeMCPExecution',
  'afterMCPExecution',
  'beforeReadFile',
  'afterFileEdit',
] as const;

const WINDSURF_HOOK_EVENTS = [
  'pre_read_code',
  'post_read_code',
  'pre_write_code',
  'post_write_code',
  'pre_run_command',
  'post_run_command',
] as const;

const AMAZON_Q_HOOK_EVENTS = ['preToolUse', 'postToolUse'] as const;
const DROID_HOOK_EVENTS = ['PreToolUse', 'PostToolUse'] as const;
const GEMINI_HOOK_EVENTS = ['BeforeTool', 'AfterTool'] as const;
const CODEX_HOOK_EVENTS = ['PreToolUse', 'PostToolUse'] as const;

function flatCommandEntries(events: readonly string[], command: string): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const event of events) {
    out[event] = [{ command }];
  }
  return out;
}

function nestedMatcherEntries(
  events: readonly string[],
  command: string,
  matcher: string,
): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const event of events) {
    out[event] = [{ matcher, hooks: [{ type: 'command', command }] }];
  }
  return out;
}

export function generateCursorHooks(binPath?: string | null): Record<string, unknown> {
  const command = quoteCollectorInvocation(binPath);
  return { version: 1, hooks: flatCommandEntries(CURSOR_HOOK_EVENTS, command) };
}

export function generateWindsurfHooks(binPath?: string | null): Record<string, unknown> {
  const command = quoteCollectorInvocation(binPath);
  return { hooks: flatCommandEntries(WINDSURF_HOOK_EVENTS, command) };
}

export function generateDroidHooks(binPath?: string | null): Record<string, unknown> {
  const command = quoteCollectorInvocation(binPath);
  return { hooks: nestedMatcherEntries(DROID_HOOK_EVENTS, command, '*') };
}

export function generateCodexHooks(binPath?: string | null): Record<string, unknown> {
  const command = quoteCollectorInvocation(binPath);
  return { hooks: nestedMatcherEntries(CODEX_HOOK_EVENTS, command, '*') };
}

export function generateGeminiHookEntries(binPath?: string | null): Record<string, unknown[]> {
  const command = quoteCollectorInvocation(binPath);
  return nestedMatcherEntries(GEMINI_HOOK_EVENTS, command, '*');
}

export function generateAmazonQHookEntries(binPath?: string | null): Record<string, unknown[]> {
  return flatCommandEntries(AMAZON_Q_HOOK_EVENTS, quoteCollectorInvocation(binPath));
}

export interface KiroHookDef {
  readonly name: string;
  readonly trigger: 'PreToolUse' | 'PostToolUse';
  readonly action: { readonly type: 'command'; readonly command: string };
}

export function generateKiroHookDefs(binPath?: string | null): KiroHookDef[] {
  const command = `MCP_CLIENT=kiro ${quoteCollectorInvocation(binPath)}`;
  return [
    {
      name: 'preflight-pre-tool',
      trigger: 'PreToolUse',
      action: { type: 'command', command },
    },
    {
      name: 'preflight-post-tool',
      trigger: 'PostToolUse',
      action: { type: 'command', command },
    },
  ];
}

function mcpEnvFor(
  id: FileAssistantId,
  creds?: { readonly licenseKey?: string; readonly accountId?: string },
): Record<string, string> {
  const env: Record<string, string> = {};
  if (id === 'cursor') env.MCP_CLIENT = 'cursor';
  if (id === 'windsurf') env.MCP_CLIENT = 'windsurf';
  if (id === 'amazon-q') env.MCP_CLIENT = 'amazon-q';
  if (id === 'kiro') {
    env.MCP_CLIENT = 'kiro';
    // Required: Kiro's MCP subprocess gets no ambient platform signal
    // (ADAPTERS.md "Known gap — detection needs an explicit opt-in").
    env.NEW_RELIC_AI_PLATFORM = 'kiro';
  }
  if (creds?.licenseKey) env.NEW_RELIC_LICENSE_KEY = creds.licenseKey;
  if (creds?.accountId) env.NEW_RELIC_ACCOUNT_ID = creds.accountId;
  return env;
}

export function generateAssistantMcpEntry(
  id: FileAssistantId,
  binPath?: string | null,
  creds?: { readonly licenseKey?: string; readonly accountId?: string },
): Record<string, unknown> {
  const env = mcpEnvFor(id, creds);
  const entry: Record<string, unknown> = {
    command: resolvePreflightCommand(binPath),
    args: ['--stdio'],
  };
  if (Object.keys(env).length > 0) entry.env = env;
  return { [ASSISTANT_MCP_SERVER_KEY]: entry };
}

// ---------------------------------------------------------------------------
// Zod — only the keys we write; everything else passes through
// ---------------------------------------------------------------------------

const HooksObjectSchema = z
  .object({ hooks: z.record(z.string(), z.unknown()).optional() })
  .passthrough();
const CursorHooksSchema = z
  .object({ version: z.number().optional(), hooks: z.record(z.string(), z.unknown()).optional() })
  .passthrough();
const KiroHooksSchema = z
  .object({ version: z.unknown().optional(), hooks: z.array(z.unknown()).optional() })
  .passthrough();
const GeminiSettingsSchema = z
  .object({
    hooks: z
      .object({
        BeforeTool: z.array(z.unknown()).optional(),
        AfterTool: z.array(z.unknown()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
const McpConfigSchema = z
  .object({ mcpServers: z.record(z.string(), z.unknown()).optional() })
  .passthrough();
const AmazonQAgentSchema = z
  .object({ hooks: z.record(z.string(), z.unknown()).optional() })
  .passthrough();

function parseOrThrow(
  schema: z.ZodType<Record<string, unknown>>,
  existing: Record<string, unknown>,
  label: string,
): void {
  const parsed = schema.safeParse(existing);
  if (!parsed.success) {
    throw new Error(
      `Existing ${label} has unexpected shape — fix manually before running install.\n${parsed.error.message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Merge / remove (pure)
// ---------------------------------------------------------------------------

function mergeMappedHooksFile(
  existing: Record<string, unknown>,
  generated: Record<string, unknown>,
  schema: z.ZodType<Record<string, unknown>>,
  label: string,
  binPath?: string | null,
): Record<string, unknown> {
  parseOrThrow(schema, existing, label);
  const result: Record<string, unknown> = { ...existing };
  if ('version' in generated) result.version = generated.version;
  const existingHooks =
    typeof result.hooks === 'object' && result.hooks !== null
      ? { ...(result.hooks as Record<string, unknown>) }
      : {};
  const generatedHooks =
    typeof generated.hooks === 'object' && generated.hooks !== null
      ? (generated.hooks as Record<string, unknown[]>)
      : {};
  result.hooks = mergeEventArrays(existingHooks, generatedHooks, binPath);
  return result;
}

function removeMappedHooksFile(
  existing: Record<string, unknown>,
  events: readonly string[],
): Record<string, unknown> {
  const result = { ...existing };
  if (typeof result.hooks !== 'object' || result.hooks === null) return result;
  const hooks = removeEventArrays(result.hooks as Record<string, unknown>, events);
  if (Object.keys(hooks).length > 0) result.hooks = hooks;
  else delete result.hooks;
  return result;
}

export function mergeCursorHooksFile(
  existing: Record<string, unknown>,
  binPath?: string | null,
): Record<string, unknown> {
  return mergeMappedHooksFile(
    existing,
    generateCursorHooks(binPath),
    CursorHooksSchema,
    'Cursor hooks file',
    binPath,
  );
}

export function removeCursorHooksFile(existing: Record<string, unknown>): Record<string, unknown> {
  return removeMappedHooksFile(existing, CURSOR_HOOK_EVENTS);
}

export function mergeWindsurfHooksFile(
  existing: Record<string, unknown>,
  binPath?: string | null,
): Record<string, unknown> {
  return mergeMappedHooksFile(
    existing,
    generateWindsurfHooks(binPath),
    HooksObjectSchema,
    'Windsurf hooks file',
    binPath,
  );
}

export function removeWindsurfHooksFile(
  existing: Record<string, unknown>,
): Record<string, unknown> {
  return removeMappedHooksFile(existing, WINDSURF_HOOK_EVENTS);
}

export function mergeDroidHooksFile(
  existing: Record<string, unknown>,
  binPath?: string | null,
): Record<string, unknown> {
  return mergeMappedHooksFile(
    existing,
    generateDroidHooks(binPath),
    HooksObjectSchema,
    'Droid hooks file',
    binPath,
  );
}

export function removeDroidHooksFile(existing: Record<string, unknown>): Record<string, unknown> {
  return removeMappedHooksFile(existing, DROID_HOOK_EVENTS);
}

export function mergeCodexHooksFile(
  existing: Record<string, unknown>,
  binPath?: string | null,
): Record<string, unknown> {
  return mergeMappedHooksFile(
    existing,
    generateCodexHooks(binPath),
    HooksObjectSchema,
    'Codex hooks file',
    binPath,
  );
}

export function removeCodexHooksFile(existing: Record<string, unknown>): Record<string, unknown> {
  return removeMappedHooksFile(existing, CODEX_HOOK_EVENTS);
}

export function mergeGeminiSettings(
  existing: Record<string, unknown>,
  binPath?: string | null,
): Record<string, unknown> {
  parseOrThrow(GeminiSettingsSchema, existing, 'Gemini CLI settings file');
  const result = { ...existing };
  const existingHooks =
    typeof result.hooks === 'object' && result.hooks !== null
      ? { ...(result.hooks as Record<string, unknown>) }
      : {};
  result.hooks = mergeEventArrays(existingHooks, generateGeminiHookEntries(binPath), binPath);
  return result;
}

export function removeGeminiSettings(existing: Record<string, unknown>): Record<string, unknown> {
  const result = { ...existing };
  if (typeof result.hooks !== 'object' || result.hooks === null) return result;
  const hooks = removeEventArrays(result.hooks as Record<string, unknown>, GEMINI_HOOK_EVENTS);
  if (Object.keys(hooks).length > 0) result.hooks = hooks;
  else delete result.hooks;
  return result;
}

function kiroHookIsOurs(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const obj = entry as Record<string, unknown>;
  if (typeof obj.name === 'string' && obj.name.startsWith('preflight-')) return true;
  return entryContainsPreflightCollector(entry);
}

export function mergeKiroHooksFile(
  existing: Record<string, unknown>,
  binPath?: string | null,
): Record<string, unknown> {
  parseOrThrow(KiroHooksSchema, existing, 'Kiro hooks file');
  const result: Record<string, unknown> = { ...existing, version: existing.version ?? 'v1' };
  const existingArr = Array.isArray(result.hooks) ? [...(result.hooks as unknown[])] : [];
  const without = existingArr.filter((e) => !kiroHookIsOurs(e));
  const generated = generateKiroHookDefs(binPath);
  if (binPath !== null && binPath !== undefined) {
    result.hooks = [...without, ...generated];
  } else if (!existingArr.some(kiroHookIsOurs)) {
    result.hooks = [...existingArr, ...generated];
  } else {
    result.hooks = existingArr;
  }
  return result;
}

export function removeKiroHooksFile(existing: Record<string, unknown>): Record<string, unknown> {
  const result = { ...existing };
  if (!Array.isArray(result.hooks)) return result;
  const filtered = (result.hooks as unknown[]).filter((e) => !kiroHookIsOurs(e));
  if (filtered.length > 0) result.hooks = filtered;
  else delete result.hooks;
  return result;
}

export function mergeAmazonQAgent(
  existing: Record<string, unknown>,
  binPath?: string | null,
): Record<string, unknown> {
  parseOrThrow(AmazonQAgentSchema, existing, 'Amazon Q agent file');
  const result = { ...existing };
  const existingHooks =
    typeof result.hooks === 'object' && result.hooks !== null
      ? { ...(result.hooks as Record<string, unknown>) }
      : {};
  result.hooks = mergeEventArrays(existingHooks, generateAmazonQHookEntries(binPath), binPath);
  return result;
}

export function removeAmazonQAgent(existing: Record<string, unknown>): Record<string, unknown> {
  const result = { ...existing };
  if (typeof result.hooks !== 'object' || result.hooks === null) return result;
  const hooks = removeEventArrays(result.hooks as Record<string, unknown>, AMAZON_Q_HOOK_EVENTS);
  if (Object.keys(hooks).length > 0) result.hooks = hooks;
  else delete result.hooks;
  return result;
}

export function mergeAssistantMcpConfig(
  existing: Record<string, unknown>,
  id: FileAssistantId,
  binPath?: string | null,
  creds?: { readonly licenseKey?: string; readonly accountId?: string },
): Record<string, unknown> {
  parseOrThrow(McpConfigSchema, existing, 'MCP config file');
  const result = { ...existing };
  const mcpServers: Record<string, unknown> =
    typeof result.mcpServers === 'object' && result.mcpServers !== null
      ? { ...(result.mcpServers as Record<string, unknown>) }
      : {};

  for (const staleKey of STALE_MCP_KEYS) {
    delete mcpServers[staleKey];
  }

  const generated = generateAssistantMcpEntry(id, binPath, creds);
  const newEntry = generated[ASSISTANT_MCP_SERVER_KEY] as Record<string, unknown>;

  if (binPath !== null && binPath !== undefined) {
    const existingEntry =
      typeof mcpServers[ASSISTANT_MCP_SERVER_KEY] === 'object' &&
      mcpServers[ASSISTANT_MCP_SERVER_KEY] !== null
        ? (mcpServers[ASSISTANT_MCP_SERVER_KEY] as Record<string, unknown>)
        : {};
    const existingEnv =
      typeof existingEntry.env === 'object' && existingEntry.env !== null
        ? (existingEntry.env as Record<string, unknown>)
        : {};
    const newEnv =
      typeof newEntry.env === 'object' && newEntry.env !== null
        ? (newEntry.env as Record<string, string>)
        : {};
    mcpServers[ASSISTANT_MCP_SERVER_KEY] = {
      ...existingEntry,
      ...newEntry,
      env: { ...existingEnv, ...newEnv },
    };
  } else if (!(ASSISTANT_MCP_SERVER_KEY in mcpServers)) {
    mcpServers[ASSISTANT_MCP_SERVER_KEY] = newEntry;
  }

  result.mcpServers = mcpServers;
  return result;
}

export function removeAssistantMcpConfig(
  existing: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...existing };
  if (typeof result.mcpServers !== 'object' || result.mcpServers === null) return result;
  const mcpServers = { ...(result.mcpServers as Record<string, unknown>) };
  delete mcpServers[ASSISTANT_MCP_SERVER_KEY];
  for (const staleKey of STALE_MCP_KEYS) {
    delete mcpServers[staleKey];
  }
  if (Object.keys(mcpServers).length > 0) result.mcpServers = mcpServers;
  else delete result.mcpServers;
  return result;
}

// ---------------------------------------------------------------------------
// File I/O apply
// ---------------------------------------------------------------------------

export interface AssistantApplyResult {
  readonly id: FileAssistantId;
  readonly written: readonly string[];
  readonly skipped: readonly string[];
}

function writeMerged(
  path: string,
  transform: (existing: Record<string, unknown>) => Record<string, unknown>,
  allowedBase: string | undefined,
): void {
  const existing = readJsonFileStrict(path);
  writeJsonFile(path, transform(existing), allowedBase);
}

function listAgentFiles(dir: string): string[] {
  try {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

export function applyFileAssistantInstall(
  id: FileAssistantId,
  opts: AssistantIoOptions,
): AssistantApplyResult {
  const paths = resolveAssistantPaths(id, opts);
  const allowedBase = opts.allowedBase ?? opts.home;
  const written: string[] = [];
  const skipped: string[] = [];
  const binPath = opts.binPath;

  if (paths.hooksPath) {
    const merge = mergeFnFor(id);
    writeMerged(paths.hooksPath, (existing) => merge(existing, binPath), allowedBase);
    written.push(paths.hooksPath);
  }

  if (paths.mcpPath) {
    writeMerged(
      paths.mcpPath,
      (existing) => mergeAssistantMcpConfig(existing, id, binPath, opts.creds),
      allowedBase,
    );
    written.push(paths.mcpPath);
  }

  if (paths.agentDir) {
    const agents = listAgentFiles(paths.agentDir);
    if (agents.length === 0) {
      skipped.push(
        `No Amazon Q agent files in ${paths.agentDir} — MCP written; hooks will merge once a cli-agents/*.json exists`,
      );
    }
    for (const agentPath of agents) {
      writeMerged(agentPath, (existing) => mergeAmazonQAgent(existing, binPath), allowedBase);
      written.push(agentPath);
    }
  }

  logger.debug('installed assistant', { id, written, skipped });
  return { id, written, skipped };
}

export function applyFileAssistantUninstall(
  id: FileAssistantId,
  opts: AssistantIoOptions,
): AssistantApplyResult {
  const paths = resolveAssistantPaths(id, opts);
  const allowedBase = opts.allowedBase ?? opts.home;
  const written: string[] = [];
  const skipped: string[] = [];

  if (paths.hooksPath && existsSync(paths.hooksPath)) {
    if (id === 'kiro') {
      const existing = readJsonFileStrict(paths.hooksPath);
      const removed = removeKiroHooksFile(existing);
      const hooksLeft = Array.isArray(removed.hooks) ? removed.hooks.length : 0;
      if (hooksLeft === 0) {
        unlinkSync(paths.hooksPath);
      } else {
        writeJsonFile(paths.hooksPath, removed, allowedBase);
      }
      written.push(paths.hooksPath);
    } else {
      const remove = removeFnFor(id);
      writeMerged(paths.hooksPath, remove, allowedBase);
      written.push(paths.hooksPath);
    }
  } else if (paths.hooksPath) {
    skipped.push(paths.hooksPath);
  }

  if (paths.mcpPath && existsSync(paths.mcpPath)) {
    writeMerged(paths.mcpPath, removeAssistantMcpConfig, allowedBase);
    written.push(paths.mcpPath);
  } else if (paths.mcpPath) {
    skipped.push(paths.mcpPath);
  }

  if (paths.agentDir) {
    for (const agentPath of listAgentFiles(paths.agentDir)) {
      writeMerged(agentPath, removeAmazonQAgent, allowedBase);
      written.push(agentPath);
    }
  }

  return { id, written, skipped };
}

function mergeFnFor(
  id: FileAssistantId,
): (existing: Record<string, unknown>, binPath?: string | null) => Record<string, unknown> {
  switch (id) {
    case 'cursor':
      return mergeCursorHooksFile;
    case 'windsurf':
      return mergeWindsurfHooksFile;
    case 'kiro':
      return mergeKiroHooksFile;
    case 'droid':
      return mergeDroidHooksFile;
    case 'gemini-cli':
      return mergeGeminiSettings;
    case 'codex':
      return mergeCodexHooksFile;
    case 'amazon-q':
      return (existing) => existing;
  }
}

function removeFnFor(
  id: FileAssistantId,
): (existing: Record<string, unknown>) => Record<string, unknown> {
  switch (id) {
    case 'cursor':
      return removeCursorHooksFile;
    case 'windsurf':
      return removeWindsurfHooksFile;
    case 'kiro':
      return removeKiroHooksFile;
    case 'droid':
      return removeDroidHooksFile;
    case 'gemini-cli':
      return removeGeminiSettings;
    case 'codex':
      return removeCodexHooksFile;
    case 'amazon-q':
      return (existing) => existing;
  }
}

export function existingAssistantFiles(id: AssistantId, opts: AssistantIoOptions): string[] {
  const paths = resolveAssistantPaths(id, opts);
  const found: string[] = [];
  if (paths.hooksPath && existsSync(paths.hooksPath)) found.push(paths.hooksPath);
  if (paths.mcpPath && existsSync(paths.mcpPath)) found.push(paths.mcpPath);
  if (paths.agentDir) found.push(...listAgentFiles(paths.agentDir));
  return found;
}

// ---------------------------------------------------------------------------
// Doctor / status
// ---------------------------------------------------------------------------

export type AssistantPartStatus = 'ok' | 'missing' | 'partial' | 'n/a' | 'malformed';

export interface AssistantInstallStatus {
  readonly id: AssistantId;
  readonly displayName: string;
  readonly detected: boolean;
  readonly hooks: AssistantPartStatus;
  readonly mcp: AssistantPartStatus;
  readonly hooksPath?: string;
  readonly mcpPath?: string;
  readonly detail: string;
}

function mcpEntryLooksLikeOurs(servers: Record<string, unknown>): boolean {
  for (const key of [ASSISTANT_MCP_SERVER_KEY, ...STALE_MCP_KEYS]) {
    const entry = servers[key];
    if (typeof entry !== 'object' || entry === null) continue;
    const command = (entry as Record<string, unknown>).command;
    if (typeof command === 'string' && /preflight/.test(command)) return true;
    const args = (entry as Record<string, unknown>).args;
    if (Array.isArray(args) && args.some((a) => typeof a === 'string' && a.includes('preflight'))) {
      return true;
    }
  }
  return false;
}

function inspectHooksObject(
  hooks: Record<string, unknown>,
  events: readonly string[],
): AssistantPartStatus {
  const { missing } = eventsWired(hooks, events);
  if (missing.length === 0) return 'ok';
  if (missing.length < events.length) return 'partial';
  return 'missing';
}

function readObject(path: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
  try {
    return { ok: true, value: readJsonFileStrict(path) };
  } catch {
    return { ok: false };
  }
}

export function inspectAssistant(
  id: AssistantId,
  opts: AssistantIoOptions,
): AssistantInstallStatus {
  const displayName = ASSISTANT_DISPLAY_NAMES[id];
  const detected = isAssistantPresent(id, opts.home);
  const paths = resolveAssistantPaths(id, opts);

  if (id === 'copilot') {
    const hooksPath = paths.hooksPath;
    if (!hooksPath || !existsSync(hooksPath)) {
      return {
        id,
        displayName,
        detected,
        hooks: 'missing',
        mcp: 'n/a',
        hooksPath,
        detail: `Copilot hooks file not found${hooksPath ? ` (${hooksPath})` : ''}`,
      };
    }
    const read = readObject(hooksPath);
    if (!read.ok) {
      return {
        id,
        displayName,
        detected,
        hooks: 'malformed',
        mcp: 'n/a',
        hooksPath,
        detail: `Copilot hooks file could not be parsed: ${hooksPath}`,
      };
    }
    const hooks =
      typeof read.value.hooks === 'object' && read.value.hooks !== null
        ? (read.value.hooks as Record<string, unknown>)
        : {};
    const status = inspectHooksObject(hooks, ['PreToolUse', 'PostToolUse']);
    return {
      id,
      displayName,
      detected,
      hooks: status,
      mcp: 'n/a',
      hooksPath,
      detail:
        status === 'ok'
          ? `Copilot hooks found in ${hooksPath}`
          : `Copilot hooks ${status} in ${hooksPath}`,
    };
  }

  let hooks: AssistantPartStatus = paths.hooksPath || paths.agentDir ? 'missing' : 'n/a';
  let mcp: AssistantPartStatus = paths.mcpPath ? 'missing' : 'n/a';
  const notes: string[] = [];

  if (paths.hooksPath) {
    if (!existsSync(paths.hooksPath)) {
      hooks = 'missing';
      notes.push(`hooks file not found (${paths.hooksPath})`);
    } else {
      const read = readObject(paths.hooksPath);
      if (!read.ok) {
        hooks = 'malformed';
        notes.push(`hooks file malformed (${paths.hooksPath})`);
      } else if (id === 'kiro') {
        const arr = Array.isArray(read.value.hooks) ? (read.value.hooks as unknown[]) : [];
        const hasPre = arr.some(
          (h) =>
            kiroHookIsOurs(h) &&
            typeof h === 'object' &&
            h !== null &&
            (h as Record<string, unknown>).trigger === 'PreToolUse',
        );
        const hasPost = arr.some(
          (h) =>
            kiroHookIsOurs(h) &&
            typeof h === 'object' &&
            h !== null &&
            (h as Record<string, unknown>).trigger === 'PostToolUse',
        );
        hooks = hasPre && hasPost ? 'ok' : hasPre || hasPost ? 'partial' : 'missing';
        notes.push(
          hooks === 'ok'
            ? `Kiro hooks found in ${paths.hooksPath}`
            : `Kiro hooks ${hooks} in ${paths.hooksPath}`,
        );
      } else if (id === 'gemini-cli') {
        const h =
          typeof read.value.hooks === 'object' && read.value.hooks !== null
            ? (read.value.hooks as Record<string, unknown>)
            : {};
        hooks = inspectHooksObject(h, GEMINI_HOOK_EVENTS);
        notes.push(
          hooks === 'ok'
            ? `Gemini BeforeTool/AfterTool hooks found in ${paths.hooksPath}`
            : `Gemini hooks ${hooks} in ${paths.hooksPath}`,
        );
      } else {
        const events =
          id === 'cursor'
            ? CURSOR_HOOK_EVENTS
            : id === 'windsurf'
              ? WINDSURF_HOOK_EVENTS
              : id === 'droid'
                ? DROID_HOOK_EVENTS
                : CODEX_HOOK_EVENTS;
        const h =
          typeof read.value.hooks === 'object' && read.value.hooks !== null
            ? (read.value.hooks as Record<string, unknown>)
            : {};
        hooks = inspectHooksObject(h, events);
        notes.push(
          hooks === 'ok'
            ? `hooks found in ${paths.hooksPath}`
            : `hooks ${hooks} in ${paths.hooksPath}`,
        );
      }
    }
  }

  if (paths.mcpPath) {
    if (!existsSync(paths.mcpPath)) {
      mcp = 'missing';
      notes.push(`MCP file not found (${paths.mcpPath})`);
    } else {
      const read = readObject(paths.mcpPath);
      if (!read.ok) {
        mcp = 'malformed';
        notes.push(`MCP file malformed (${paths.mcpPath})`);
      } else {
        const servers =
          typeof read.value.mcpServers === 'object' && read.value.mcpServers !== null
            ? (read.value.mcpServers as Record<string, unknown>)
            : {};
        mcp = mcpEntryLooksLikeOurs(servers) ? 'ok' : 'missing';
        notes.push(
          mcp === 'ok' ? `MCP registered in ${paths.mcpPath}` : `MCP missing in ${paths.mcpPath}`,
        );
      }
    }
  }

  if (paths.agentDir) {
    const agents = listAgentFiles(paths.agentDir);
    if (agents.length === 0) {
      if (hooks === 'missing') {
        notes.push(`no Amazon Q agent files in ${paths.agentDir} to hold hooks`);
      }
    } else {
      let okAgents = 0;
      let partialAgents = 0;
      for (const agentPath of agents) {
        const read = readObject(agentPath);
        if (!read.ok) continue;
        const h =
          typeof read.value.hooks === 'object' && read.value.hooks !== null
            ? (read.value.hooks as Record<string, unknown>)
            : {};
        const status = inspectHooksObject(h, AMAZON_Q_HOOK_EVENTS);
        if (status === 'ok') okAgents += 1;
        else if (status === 'partial') partialAgents += 1;
      }
      if (okAgents === agents.length) hooks = 'ok';
      else if (okAgents > 0 || partialAgents > 0) hooks = 'partial';
      else hooks = 'missing';
      notes.push(
        hooks === 'ok'
          ? `hooks found in ${okAgents} Amazon Q agent file(s)`
          : `Amazon Q agent hooks ${hooks} (${agents.length} file(s) in ${paths.agentDir})`,
      );
    }
  }

  return {
    id,
    displayName,
    detected,
    hooks,
    mcp,
    hooksPath: paths.hooksPath,
    mcpPath: paths.mcpPath,
    detail: notes.join('; ') || `${displayName} not configured`,
  };
}

export function assistantStatusToCheck(status: AssistantInstallStatus): {
  readonly check: string;
  readonly status: 'ok' | 'warn' | 'fail' | 'skip';
  readonly detail: string;
  readonly fix?: string;
} {
  const check = `${status.displayName} hooks`;
  const partsBroken = [status.hooks, status.mcp].filter(
    (p) => p === 'missing' || p === 'partial' || p === 'malformed',
  );
  if (partsBroken.length === 0) {
    return { check, status: 'ok', detail: status.detail };
  }
  const failed = [status.hooks, status.mcp].some((p) => p === 'missing' || p === 'malformed');
  return {
    check,
    status: failed ? 'fail' : 'warn',
    detail: status.detail,
    fix: `preflight install --assistants ${status.id}`,
  };
}

/** Home used when the caller does not inject one (production CLI / doctor). */
export function defaultHome(): string {
  return homedir();
}
