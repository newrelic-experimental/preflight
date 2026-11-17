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
 * `session-by-ppid/<pid>.txt` and `session-by-cwd/<sanitized-cwd>.txt`.
 * Older collectors wrote that layout at the storage root itself, with no
 * writer.
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

export function breadcrumbWriter(env: NodeJS.ProcessEnv): string {
  for (const key of ENGINE_ENV_KEYS) {
    const name = canonicalPlatformName(env[key]);
    if (name === 'generic-mcp') return UNATTRIBUTED_BREADCRUMB_WRITER;
    if (name !== undefined) return name;
  }
  return CLAUDE_CODE_ENV_SIGNALS.some((key) => env[key] !== undefined)
    ? CLAUDE_CODE_PLATFORM_NAME
    : UNATTRIBUTED_BREADCRUMB_WRITER;
}
