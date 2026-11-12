import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function claudeConfigDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string {
  const override = env.CLAUDE_CONFIG_DIR?.trim();
  return override ? resolve(override) : join(home, '.claude');
}

export function claudeProjectsDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string {
  return join(claudeConfigDir(env, home), 'projects');
}
