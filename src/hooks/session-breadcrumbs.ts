import { resolve } from 'node:path';

import {
  CLAUDE_CODE_ENV_SIGNALS,
  CLAUDE_CODE_PLATFORM_NAME,
} from '../platforms/claude-code-adapter.js';
import { PLATFORM_NAMES } from '../platforms/platform-names.js';
import { UNATTRIBUTED_BREADCRUMB_WRITER } from '../platforms/types.js';

/**
 * Session breadcrumbs live at `<storage>/breadcrumbs/<writer>/`, one
 * directory per engine whose hooks wrote them, each laid out as
 * `session-by-ppid/<pid>.txt` and `session-by-cwd/<sanitized-cwd>.txt`.
 * Collectors before #979 wrote that layout at the storage root itself, with
 * no writer, and collectors since write it there too for servers that read
 * only that layout.
 */
export const BREADCRUMBS_DIR = 'breadcrumbs';

const aliasKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

const WRITER_BY_ALIAS = new Map<string, string>(PLATFORM_NAMES.map((n) => [aliasKey(n), n]));

export function breadcrumbRoot(storagePath: string, writer: string): string {
  return resolve(storagePath, BREADCRUMBS_DIR, writer);
}

export function breadcrumbWriter(env: NodeJS.ProcessEnv): string | null {
  const named = [env.MCP_CLIENT, env.NEW_RELIC_AI_PLATFORM].filter((n): n is string => !!n);
  for (const name of named) {
    const writer = WRITER_BY_ALIAS.get(aliasKey(name));
    if (writer !== undefined) return writer;
  }
  if (CLAUDE_CODE_ENV_SIGNALS.some((key) => env[key] !== undefined)) {
    return CLAUDE_CODE_PLATFORM_NAME;
  }
  return named.length === 0 ? UNATTRIBUTED_BREADCRUMB_WRITER : null;
}
