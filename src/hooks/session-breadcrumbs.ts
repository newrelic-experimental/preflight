import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

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

/** Every registered platform's `platformName`, which a hook may name in any case or separator. */
const PLATFORM_NAMES = [
  'claude-code',
  'cursor',
  'windsurf',
  'copilot',
  'copilot-app',
  'copilot-sdk',
  'zed',
  'continue',
  'amazon-q',
  'kiro',
  'droid',
  'gemini-cli',
  'cline',
  'codex',
  'opencode',
  'kilocode',
  'pi',
  'antigravity',
  'generic-mcp',
] as const;

const aliasKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

const WRITER_BY_ALIAS = new Map<string, string>(PLATFORM_NAMES.map((n) => [aliasKey(n), n]));

/** The writers with a breadcrumb directory under `storagePath`, whatever else sits beside them. */
export function breadcrumbWriters(storagePath: string): string[] {
  try {
    return readdirSync(resolve(storagePath, BREADCRUMBS_DIR), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export function breadcrumbRoot(storagePath: string, writer: string): string {
  return resolve(storagePath, BREADCRUMBS_DIR, writer);
}

/**
 * The writer a hook files its breadcrumbs under: the platform its command
 * names, `unattributed` when it names none, or null when it names an engine
 * Preflight has no adapter for, whose breadcrumbs no server could own.
 */
export function breadcrumbWriter(engine: string | undefined): string | null {
  if (engine === undefined) return UNATTRIBUTED_BREADCRUMB_WRITER;
  return WRITER_BY_ALIAS.get(aliasKey(engine)) ?? null;
}
