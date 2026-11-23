import { renameSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createLogger } from '../core/index.js';

const logger = createLogger('storage');
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_BACKOFF_MS = [10, 20, 40, 80];
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));
const warnedKeys = new Set<string>();

function warnOnce(key: string, message: string, data: Record<string, unknown>): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  logger.warn(message, data);
}

/**
 * Windows refuses to rename over a file another process has open, which
 * antivirus scanners do briefly after each write. Retry with backoff, then
 * write the target directly so writes never silently stop.
 */
export function renameIntoPlace(tmpPath: string, filepath: string, content: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmpPath, filepath);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (!RENAME_RETRY_CODES.has(code)) throw err;
      if (process.platform !== 'win32' || attempt === RENAME_BACKOFF_MS.length) break;
      Atomics.wait(SLEEP_CELL, 0, 0, RENAME_BACKOFF_MS[attempt]);
    }
  }
  try {
    writeFileSync(filepath, content, { mode: 0o600 });
  } catch (err) {
    warnOnce(
      `rename-failed:${filepath}`,
      'Could not rename file into place and the direct write failed too',
      { file: basename(filepath), error: err instanceof Error ? err.message : String(err) },
    );
    throw err;
  }
  warnOnce(`rename:${filepath}`, 'Could not rename file into place; wrote it directly', {
    file: basename(filepath),
  });
}
