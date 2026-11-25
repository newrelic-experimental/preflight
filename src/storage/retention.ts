import { rmSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createLogger } from '../core/index.js';
import { parseSessionFilename } from './session-store.js';
import { listDirOrEmpty, WRITERS_DIR } from './session-writers.js';

const logger = createLogger('retention');

const PURGED_SUFFIXES = ['.json', '.corrupt', '.merged', '.tmp'];
/** One hour. A writer's temp file outlives its save only when the writer died mid-save. */
const STALE_WRITER_TMP_DAYS = 1 / 24;

/**
 * Delete every `PURGED_SUFFIXES` file in `<storagePath>/<subdir>` whose mtime
 * is older than `retainDays`. Shared by `purgeOldSessions` and
 * `purgeOldWeeklySummaries` — only the subdirectory and log label differ.
 */
function purgeOldFiles(
  storagePath: string,
  subdir: string,
  retainDays: number,
  fileKind: string,
  keep: (file: string) => boolean = () => false,
): number {
  const dir = resolve(storagePath, subdir);
  // Files are deleted if mtime < cutoff. Files exactly at the cutoff (rare in practice) are retained.
  const cutoffMs = Date.now() - retainDays * 24 * 60 * 60 * 1000;
  let deletedCount = 0;

  for (const file of listDirOrEmpty(dir)) {
    if (!PURGED_SUFFIXES.some((suffix) => file.endsWith(suffix)) || keep(file)) continue;
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
  const sessionsDir = resolve(storagePath, 'sessions');
  const writersDir = join(sessionsDir, WRITERS_DIR);
  const cutoffMs = Date.now() - retainDays * 24 * 60 * 60 * 1000;
  const newest = new Map<string, number>();
  const seen = (sessionId: string, path: string) =>
    newest.set(sessionId, Math.max(newest.get(sessionId) ?? 0, mtimeOf(path)));
  for (const file of listDirOrEmpty(sessionsDir)) {
    const sessionId = parseSessionFilename(file)?.sessionId;
    if (sessionId) seen(sessionId, join(sessionsDir, file));
  }
  const writerDirs = listDirOrEmpty(writersDir);
  const hasWriters = new Set(writerDirs);
  let deleted = 0;
  for (const sessionId of writerDirs) {
    const dir = join(writersDir, sessionId);
    deleted += purgeOldFiles(
      storagePath,
      join('sessions', WRITERS_DIR, sessionId),
      STALE_WRITER_TMP_DAYS,
      'writer temp',
      (file) => !file.endsWith('.tmp'),
    );
    for (const path of [dir, ...listDirOrEmpty(dir).map((name) => join(dir, name))])
      seen(sessionId, path);
  }
  const isLiveWriterSession = (sessionId: string | undefined) =>
    sessionId !== undefined &&
    hasWriters.has(sessionId) &&
    (newest.get(sessionId) ?? 0) >= cutoffMs;

  deleted += purgeOldFiles(storagePath, 'sessions', retainDays, 'session', (file) =>
    isLiveWriterSession(parseSessionFilename(file)?.sessionId),
  );
  for (const sessionId of writerDirs.filter((id) => !isLiveWriterSession(id))) {
    const dir = join(writersDir, sessionId);
    const files = listDirOrEmpty(dir).length;
    try {
      rmSync(dir, { recursive: true, force: true });
      deleted += files;
    } catch (err) {
      logger.warn('Failed to delete session writer files', { sessionId, error: String(err) });
    }
  }
  return deleted;
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

export function purgeOldWeeklySummaries(storagePath: string, retainDays: number): number {
  return purgeOldFiles(storagePath, 'weekly_summaries', retainDays, 'weekly summary');
}
