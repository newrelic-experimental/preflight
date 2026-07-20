import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLogger } from '../shared/index.js';

const logger = createLogger('retention');

/**
 * Delete every `.json` file in `<storagePath>/<subdir>` whose mtime is older
 * than `retainDays`. Shared by `purgeOldSessions` and
 * `purgeOldWeeklySummaries` — only the subdirectory and log label differ.
 */
function purgeOldJsonFiles(
  storagePath: string,
  subdir: string,
  retainDays: number,
  fileKind: string,
): number {
  const dir = resolve(storagePath, subdir);
  // Files are deleted if mtime < cutoff. Files exactly at the cutoff (rare in practice) are retained.
  const cutoffMs = Date.now() - retainDays * 24 * 60 * 60 * 1000;
  let deletedCount = 0;

  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return 0; // directory doesn't exist yet
  }

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const fullPath = resolve(dir, file);
    try {
      const stat = statSync(fullPath);
      if (stat.mtimeMs < cutoffMs) {
        try {
          unlinkSync(fullPath);
          deletedCount++;
          logger.debug(`Purged old ${fileKind} file`, {
            file,
            ageDays: Math.floor((Date.now() - stat.mtimeMs) / 86_400_000),
          });
        } catch (unlinkErr) {
          const code = (unlinkErr as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') {
            // Already deleted by another process — still count it
            deletedCount++;
          } else {
            logger.warn(`Failed to delete ${fileKind} file`, { file, error: String(unlinkErr) });
          }
        }
      }
    } catch (err) {
      logger.warn(`Failed to check/delete ${fileKind} file`, { file, error: String(err) });
    }
  }

  if (deletedCount > 0) {
    logger.info(`Purged old ${fileKind} files`, { count: deletedCount, retainDays });
  }

  return deletedCount;
}

export function purgeOldSessions(storagePath: string, retainDays: number): number {
  return purgeOldJsonFiles(storagePath, 'sessions', retainDays, 'session');
}

export function purgeOldWeeklySummaries(storagePath: string, retainDays: number): number {
  return purgeOldJsonFiles(storagePath, 'weekly_summaries', retainDays, 'weekly summary');
}
