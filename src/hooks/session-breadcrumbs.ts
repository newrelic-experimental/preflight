import { resolve } from 'node:path';

import {
  CLAUDE_CODE_ENV_SIGNALS,
  CLAUDE_CODE_PLATFORM_NAME,
} from '../platforms/claude-code-adapter.js';
import { canonicalPlatformName, ENGINE_ENV_KEYS } from '../platforms/platform-names.js';
import { UNATTRIBUTED_BREADCRUMB_WRITER } from '../platforms/types.js';

/**
 * Session breadcrumbs live at `<storage>/breadcrumbs/<writer>/`, one
 * directory per engine whose hooks wrote them, each laid out as
 * `session-by-ppid/<pid>.txt` and `session-by-cwd/<sanitized-cwd>.txt`, plus
 * `session-by-id/<session>.txt` for every session it filed. Collectors also
 * copy the ppid and cwd breadcrumbs to the storage root itself, with no
 * writer, where older collectors wrote only that layout. A server skips a root
 * copy whose session any writer filed.
 */
export const BREADCRUMBS_DIR = 'breadcrumbs';

/**
 * A cwd breadcrumb idle this long is collected. The resolver accepts a cwd
 * breadcrumb only while its session was active within 12 hours, so the window
 * is well past that. A legacy-root breadcrumb the resolver accepts by process
 * start time is also collected once idle this long, because the sweep cannot
 * see other processes' start times. A process that old normally resolved on its first
 * poll.
 */
export const STALE_CWD_BREADCRUMB_MS = 7 * 24 * 60 * 60 * 1000;

export function breadcrumbRoot(storagePath: string, writer: string): string {
  return resolve(storagePath, BREADCRUMBS_DIR, writer);
}

/**
 * Anything started from a Claude Code shell inherits its env signals, so a hook
 * for a session other than the one CLAUDE_CODE_SESSION_ID names belongs to
 * another engine.
 */
export function isClaudeCodeHook(env: NodeJS.ProcessEnv, sessionId: unknown): boolean {
  const claudeSessionId = env.CLAUDE_CODE_SESSION_ID;
  if (claudeSessionId !== undefined && claudeSessionId !== sessionId) return false;
  return CLAUDE_CODE_ENV_SIGNALS.some((key) => env[key] !== undefined);
}

export function breadcrumbWriter(env: NodeJS.ProcessEnv, sessionId: string): string {
  for (const key of ENGINE_ENV_KEYS) {
    const name = canonicalPlatformName(env[key]);
    if (name === 'generic-mcp') return UNATTRIBUTED_BREADCRUMB_WRITER;
    if (name !== undefined) return name;
  }
  return isClaudeCodeHook(env, sessionId)
    ? CLAUDE_CODE_PLATFORM_NAME
    : UNATTRIBUTED_BREADCRUMB_WRITER;
}
