import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';

import { createLogger } from '../core/index.js';
import { claudeConfigDir } from './claude-config-dir.js';

const logger = createLogger('claude-settings-env');

export interface ClaudeSettingsEnvOptions {
  readonly cwd?: string;
  readonly home?: string;
  readonly platform?: NodeJS.Platform;
  readonly managedSettingsPath?: string;
}

function managedSettingsPath(os: NodeJS.Platform): string | null {
  if (os === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
  if (os === 'linux') return '/etc/claude-code/managed-settings.json';
  if (os === 'win32') return 'C:\\Program Files\\ClaudeCode\\managed-settings.json';
  return null;
}

const EXPORTER_KEY = /^OTEL_[A-Z]+_EXPORTER$/;

function managedDropIns(managedPath: string): string[] {
  const dir = join(dirname(managedPath), 'managed-settings.d');
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
      .sort()
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

function onlyExportersTurnedOff(block: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(block)) {
    if (EXPORTER_KEY.test(key) && value.trim() === 'none') out[key] = value;
  }
  return out;
}

function readEnvBlock(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    const block = (parsed as { env?: unknown } | null)?.env;
    if (typeof block !== 'object' || block === null || Array.isArray(block)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(block)) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  } catch (err) {
    logger.debug('Could not read Claude Code settings env block', { path, error: String(err) });
    return {};
  }
}

/**
 * Overlays the `env` blocks of the settings files Claude Code reads onto `env`,
 * lowest to highest precedence: user, project, project-local, managed. The
 * shell value stays as the fallback for any key no settings file sets. Claude
 * Code ignores telemetry variables in project and local `env` blocks, so those
 * two files contribute only an `OTEL_*_EXPORTER` of `none`, which still turns
 * export off. Managed policy is managed-settings.json followed by the
 * managed-settings.d/*.json drop-ins in alphabetical order; server-managed,
 * MDM, and registry sources are not read.
 */
export function withClaudeSettingsEnv(
  env: NodeJS.ProcessEnv,
  options: ClaudeSettingsEnvOptions = {},
): NodeJS.ProcessEnv {
  const cwd = options.cwd ?? process.cwd();
  const managed =
    options.managedSettingsPath ?? managedSettingsPath(options.platform ?? platform());
  const blocks = [
    readEnvBlock(join(claudeConfigDir(env, options.home ?? homedir()), 'settings.json')),
    onlyExportersTurnedOff(readEnvBlock(join(cwd, '.claude', 'settings.json'))),
    onlyExportersTurnedOff(readEnvBlock(join(cwd, '.claude', 'settings.local.json'))),
    ...(managed ? [managed, ...managedDropIns(managed)].map(readEnvBlock) : []),
  ];
  return Object.assign({}, env, ...blocks);
}
