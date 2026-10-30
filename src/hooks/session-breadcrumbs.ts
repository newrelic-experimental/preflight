import { resolve } from 'node:path';

import { UNATTRIBUTED_BREADCRUMB_WRITER } from '../platforms/types.js';

/**
 * Session breadcrumbs live at `<storage>/breadcrumbs/<writer>/`, one
 * directory per engine whose hooks wrote them, each laid out as
 * `session-by-ppid/<pid>.txt` and `session-by-cwd/<sanitized-cwd>.txt`.
 * Collectors before #979 wrote that layout at the storage root itself, with
 * no writer.
 */
export const BREADCRUMBS_DIR = 'breadcrumbs';

const WRITER_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function breadcrumbRoot(storagePath: string, writer: string): string {
  return resolve(storagePath, BREADCRUMBS_DIR, writer);
}

/**
 * The writer a hook files its breadcrumbs under: the engine its environment
 * names, when that name is safe as a path segment, else unattributed.
 */
export function breadcrumbWriter(engine: string | undefined): string {
  return engine !== undefined && WRITER_RE.test(engine) ? engine : UNATTRIBUTED_BREADCRUMB_WRITER;
}
