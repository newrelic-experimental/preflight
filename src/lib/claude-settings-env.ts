import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

import { createLogger } from '../shared/index.js';
import { claudeConfigDir } from './claude-config-dir.js';

const logger = createLogger('claude-settings-env');

export interface ClaudeSettingsEnvOptions {
  readonly cwd?: string;
  readonly home?: string;
  readonly platform?: NodeJS.Platform;
}

function managedSettingsPath(os: NodeJS.Platform): string | null {
  if (os === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
  if (os === 'linux') return '/etc/claude-code/managed-settings.json';
  if (os === 'win32') return 'C:\\Program Files\\ClaudeCode\\managed-settings.json';
  return null;
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
 * shell value stays as the fallback for any key no settings file sets. Only the
 * managed-settings.json file is read; server-managed, MDM, and registry
 * sources are not.
 */
export function withClaudeSettingsEnv(
  env: NodeJS.ProcessEnv,
  options: ClaudeSettingsEnvOptions = {},
): NodeJS.ProcessEnv {
  const cwd = options.cwd ?? process.cwd();
  const managed = managedSettingsPath(options.platform ?? platform());
  const paths = [
    join(claudeConfigDir(env, options.home ?? homedir()), 'settings.json'),
    join(cwd, '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.local.json'),
    ...(managed ? [managed] : []),
  ];
  return Object.assign({}, env, ...paths.map(readEnvBlock));
}
