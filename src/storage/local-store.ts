import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { createLogger } from '../shared/index.js';
import type { HookEvent, SessionSummary, AuditEntry } from './types.js';

const logger = createLogger('local-store');

const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

/**
 * A buffer file is treated as orphan when its mtime is older than this AND
 * no live heartbeat is present. Five minutes is well past any normal harvest
 * tick (poll interval is sub-second) so a healthy MCP that's just sitting
 * idle without tool calls won't trip the threshold.
 */
const ORPHAN_BUFFER_MTIME_MS = 5 * 60 * 1000;

/**
 * Liveness probe via signal 0 — POSIX sends no signal but performs the
 * permission/existence checks. Returns true iff the PID names a live process
 * we have rights to signal. ESRCH = dead, EPERM = alive (different uid),
 * anything else (e.g. EINVAL on a malformed PID) = treat as dead.
 */
function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true; // exists, owned by another uid
    return false;
  }
}

export class LocalStore {
  private readonly storagePath: string;
  private readonly bufferPath: string;
  private readonly sessionId: string | null;

  /**
   * @param storagePath The base storage directory (e.g. ~/.newrelic-preflight).
   * @param bufferPathOrSessionId Either an explicit absolute buffer path
   *   (legacy / test override; takes precedence over sessionId) or a sessionId
   *   that scopes the per-session buffer file (`buffer-<sessionId>.jsonl`).
   *   Pass `undefined` for fan-out drain mode (`--local`) where there is no
   *   single owning session — `drainBuffer()` will then return [] and callers
   *   should use `drainAllBuffers()` instead.
   * @param sessionId Optional sessionId for scoping per-session buffers.
   *   Used when an explicit bufferPath is also provided (rare — the explicit
   *   path still wins for the buffer location, sessionId is then ignored).
   */
  constructor(storagePath: string, bufferPathOrSessionId?: string, sessionId?: string) {
    this.storagePath = storagePath;
    let resolvedBufferPath: string | null;
    let resolvedSessionId: string | null = null;

    if (bufferPathOrSessionId !== undefined && bufferPathOrSessionId.includes(sep)) {
      // Treat anything containing a path separator as an explicit path
      // override. Tests and `NEW_RELIC_AI_MCP_BUFFER_PATH` use this form.
      resolvedBufferPath = bufferPathOrSessionId;
      resolvedSessionId =
        typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId) ? sessionId : null;
    } else if (bufferPathOrSessionId !== undefined && SESSION_ID_RE.test(bufferPathOrSessionId)) {
      // Per-session buffer scoping.
      resolvedBufferPath = resolve(storagePath, `buffer-${bufferPathOrSessionId}.jsonl`);
      resolvedSessionId = bufferPathOrSessionId;
    } else if (bufferPathOrSessionId === undefined) {
      // No-session mode: --local drain-all, or pre-resolution startup. Leave
      // bufferPath at the legacy default so single-call drainBuffer() doesn't
      // crash on undefined; drainAllBuffers() is the right entry point here.
      resolvedBufferPath = resolve(storagePath, 'buffer.jsonl');
    } else {
      // Bare value that's neither a path nor a valid sessionId — refuse to
      // construct rather than silently routing live data to
      // buffer-unknown.jsonl, which the MCP's session-scoped drainBuffer()
      // would never read and which gcOrphanBuffers() would archive after 5
      // minutes of mtime staleness. The caller (src/index.ts) is responsible
      // for validating sessionTraceId against SESSION_ID_RE before passing it
      // here. session-resolver already enforces this; if this throws it's a
      // real bug worth surfacing.
      throw new Error(
        `LocalStore: invalid sessionId (must match SESSION_ID_RE /^[a-zA-Z0-9_-]{1,128}$/): ${JSON.stringify(
          bufferPathOrSessionId,
        )}`,
      );
    }

    this.bufferPath = resolvedBufferPath;
    this.sessionId = resolvedSessionId;
  }

  initialize(): void {
    const dirs = [
      this.storagePath,
      resolve(this.storagePath, 'sessions'),
      resolve(this.storagePath, 'weekly_summaries'),
      resolve(this.storagePath, 'audit'),
    ];

    for (const dir of dirs) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
    }

    logger.debug('Storage initialized', { path: this.storagePath });
  }

  /**
   * Append a hook event as a JSON line to the buffer file.
   * Uses appendFileSync for minimal latency (<5ms budget).
   */
  appendToBuffer(event: HookEvent): void {
    try {
      appendFileSync(this.bufferPath, JSON.stringify(event) + '\n', { mode: 0o600 });
    } catch (err) {
      // Never block the caller — log and move on
      logger.warn('Failed to append to buffer', { error: String(err) });
    }
  }

  /**
   * Atomically drain all events from the buffer file.
   * Renames the file to a temp path (atomic on POSIX), reads it, then deletes.
   * This avoids data loss from concurrent hook writes during drain.
   */
  drainBuffer(): HookEvent[] {
    return this.drainPath(this.bufferPath);
  }

  /**
   * Drain every per-session buffer file under the storage path. Used by
   * `--local` standalone mode where the dashboard owner sees all live
   * sessions' events. Each file is drained atomically (rename-then-read) so a
   * concurrent writer for that session can't lose events; orphan files (whose
   * MCP isn't running) are picked up too.
   */
  drainAllBuffers(): HookEvent[] {
    const all: HookEvent[] = [];
    let entries: string[];
    try {
      if (!existsSync(this.storagePath)) return [];
      entries = readdirSync(this.storagePath);
    } catch (err) {
      logger.warn('Failed to enumerate storage path for drainAllBuffers', { error: String(err) });
      return [];
    }
    for (const name of entries) {
      // Per-session: buffer-<id>.jsonl. Also pick up the legacy shared
      // buffer.jsonl so a freshly-upgraded user's pre-Fix-3 events still flow.
      if (!name.endsWith('.jsonl')) continue;
      if (name !== 'buffer.jsonl' && !name.startsWith('buffer-')) continue;
      const drained = this.drainPath(resolve(this.storagePath, name));
      if (drained.length > 0) {
        for (const event of drained) all.push(event);
      }
    }
    return all;
  }

  /**
   * Read every per-session buffer file under the storage path WITHOUT draining
   * (no rename, no unlink). Used by the dashboard owner's
   * `/api/sessions/today/aggregate` endpoint, which surfaces a global view
   * across every live session — its own session_id-scoped drainBuffer() only
   * covers its own events, so we need a read-only fan-out for cross-session
   * KPIs.
   *
   * Torn-line handling: the LAST non-empty line is the only line that can
   * legitimately be torn (a concurrent appender's incomplete write). If it
   * fails to parse we drop it silently. Any earlier line that fails to parse
   * is real corruption — events >PIPE_BUF (typically 4 KiB) interleaved by
   * concurrent appenders, or an on-disk write that flushed partially. We log
   * a WARN so the loss is visible rather than silently dropped.
   *
   * The legacy shared `buffer.jsonl` is included so an upgrading user with
   * unmigrated events still appears in aggregate views before the next
   * `migrateLegacyBuffer()` runs.
   */
  peekAllBuffers(): HookEvent[] {
    const all: HookEvent[] = [];
    let entries: string[];
    try {
      if (!existsSync(this.storagePath)) return [];
      entries = readdirSync(this.storagePath);
    } catch (err) {
      logger.warn('Failed to enumerate storage path for peekAllBuffers', { error: String(err) });
      return [];
    }
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      if (name !== 'buffer.jsonl' && !name.startsWith('buffer-')) continue;
      const path = resolve(this.storagePath, name);
      let raw: string;
      try {
        raw = readFileSync(path, 'utf-8');
      } catch {
        continue;
      }
      if (!raw.trim()) continue;
      // Find the index of the last non-empty line so we can distinguish a
      // legitimately-torn tail from real mid-file corruption.
      const lines = raw.split('\n');
      let lastNonEmptyIdx = -1;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i]!.trim()) {
          lastNonEmptyIdx = i;
          break;
        }
      }
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!line.trim()) continue;
        try {
          all.push(JSON.parse(line) as HookEvent);
        } catch {
          if (i === lastNonEmptyIdx) {
            // Torn-tail race against a concurrent appender — expected.
            continue;
          }
          // Mid-file parse failure means real data corruption — surface it.
          logger.warn('peekAllBuffers: dropping malformed mid-file line', {
            file: name,
            lineIndex: i,
            preview: line.slice(0, 100),
            eventsSoFar: all.length,
          });
        }
      }
    }
    return all;
  }

  /**
   * Write a heartbeat file `active-<sessionId>.pid` containing this process's
   * PID. Used by the dashboard owner's GC pass to determine which buffer
   * files still have a live owner. The MCP should call this once after
   * resolving its session_id, and remove it on graceful shutdown via
   * `removeHeartbeat()`.
   *
   * No-op if the LocalStore is not bound to a sessionId (e.g. --local mode).
   */
  writeHeartbeat(pid: number = process.pid): void {
    if (!this.sessionId) return;
    if (!Number.isFinite(pid) || pid <= 0) return;
    const heartbeatPath = resolve(this.storagePath, `active-${this.sessionId}.pid`);
    try {
      if (!existsSync(this.storagePath)) {
        mkdirSync(this.storagePath, { recursive: true, mode: 0o700 });
      }
      writeFileSync(heartbeatPath, String(pid), { mode: 0o600 });
    } catch (err) {
      logger.warn('Failed to write heartbeat file', { error: String(err) });
    }
  }

  /**
   * Remove this MCP's heartbeat file. Called from the shutdown handler so the
   * dashboard owner's next GC pass knows the buffer is up for adoption.
   *
   * No-op if no heartbeat was ever written or if the file is already gone.
   */
  removeHeartbeat(): void {
    if (!this.sessionId) return;
    const heartbeatPath = resolve(this.storagePath, `active-${this.sessionId}.pid`);
    try {
      if (existsSync(heartbeatPath)) unlinkSync(heartbeatPath);
    } catch (err) {
      logger.debug('Failed to remove heartbeat file', { error: String(err) });
    }
  }

  /**
   * Garbage-collect orphan per-session buffer files. A buffer is orphan when
   * no live process is currently draining it; we determine that with two
   * signals:
   *
   *   1. Heartbeat (authoritative): if `active-<sessionId>.pid` exists and
   *      its PID is alive, the buffer has an owner — leave it alone. If the
   *      heartbeat exists but the PID is dead (process crashed before
   *      cleanup), archive the buffer and delete the stale heartbeat.
   *   2. Mtime fallback: if no heartbeat exists AND the buffer hasn't been
   *      written to in `ORPHAN_BUFFER_MTIME_MS`, treat as orphan. This catches
   *      crashes that happened before any heartbeat was written.
   *
   * Recently-modified buffers without a heartbeat are left alone — the MCP
   * for that session may be in the breadcrumb-resolution window and not yet
   * have written its heartbeat.
   *
   * The `activeSessionIds` set is also consulted: any session id present
   * there is considered live regardless of heartbeat/mtime, which protects
   * against heartbeat write delays on slow disks.
   *
   * Orphan buffers are renamed to `buffer-<sessionId>.jsonl.archived-<ts>`
   * (preserved on disk for forensics, no longer scanned by the aggregator).
   *
   * @returns counts of files archived and stale heartbeats removed
   */
  gcOrphanBuffers(activeSessionIds: ReadonlySet<string>): {
    archived: number;
    staleHeartbeats: number;
  } {
    if (!existsSync(this.storagePath)) {
      return { archived: 0, staleHeartbeats: 0 };
    }
    let entries: string[];
    try {
      entries = readdirSync(this.storagePath);
    } catch (err) {
      logger.warn('Failed to enumerate storage path for gcOrphanBuffers', { error: String(err) });
      return { archived: 0, staleHeartbeats: 0 };
    }

    let archived = 0;
    let staleHeartbeats = 0;
    const now = Date.now();

    for (const name of entries) {
      // Match `buffer-<sessionId>.jsonl` exactly. Skip `.drain` companions and
      // already-archived files so a follow-up pass doesn't re-process them.
      if (!name.startsWith('buffer-') || !name.endsWith('.jsonl')) continue;
      if (name === 'buffer.jsonl') continue;

      const sessionId = name.slice('buffer-'.length, -'.jsonl'.length);
      // Defense in depth — a malformed sessionId would mean a malformed
      // heartbeat path; skip silently rather than archive.
      if (!SESSION_ID_RE.test(sessionId)) continue;

      const bufferPath = resolve(this.storagePath, name);
      const heartbeatPath = resolve(this.storagePath, `active-${sessionId}.pid`);
      const heartbeatExists = existsSync(heartbeatPath);

      let ownerAlive = false;
      let heartbeatStale = false;
      if (heartbeatExists) {
        try {
          const raw = readFileSync(heartbeatPath, 'utf-8').trim();
          const pid = Number.parseInt(raw, 10);
          if (isPidAlive(pid)) {
            ownerAlive = true;
          } else {
            heartbeatStale = true;
          }
        } catch {
          // Unreadable heartbeat — treat as stale so we don't leak the file.
          heartbeatStale = true;
        }
      }

      // Cross-check against the caller-supplied set of session ids that are
      // known to be live (via tool-call activity / LiveSessionRegistry). If
      // present here, the buffer is owned even if no heartbeat is on disk yet.
      if (activeSessionIds.has(sessionId)) ownerAlive = true;

      if (ownerAlive) continue;

      // Mtime fallback only applies when no heartbeat is on disk: a stale
      // heartbeat is enough on its own.
      let archive = heartbeatStale;
      if (!heartbeatExists) {
        try {
          const stat = statSync(bufferPath);
          if (now - stat.mtimeMs > ORPHAN_BUFFER_MTIME_MS) {
            archive = true;
          }
        } catch {
          // Buffer file vanished mid-scan — nothing to do.
          continue;
        }
      }

      if (!archive) continue;

      const archivedPath = `${bufferPath}.archived-${now}`;
      try {
        renameSync(bufferPath, archivedPath);
        archived++;
        logger.info('Archived orphan buffer', { sessionId, archivedPath });
        // Only remove the heartbeat once the archive rename has succeeded.
        // If the rename fails, leave the heartbeat so the next GC pass can
        // retry rather than treating the buffer as heartbeat-free.
        if (heartbeatExists) {
          try {
            unlinkSync(heartbeatPath);
            if (heartbeatStale) staleHeartbeats++;
          } catch (err) {
            logger.debug('Failed to remove heartbeat after archive', {
              sessionId,
              error: String(err),
            });
          }
        }
      } catch (err) {
        logger.warn('Failed to archive orphan buffer', { sessionId, error: String(err) });
      }
    }

    return { archived, staleHeartbeats };
  }

  /**
   * Scan `<storage>/active-*.pid` heartbeat files and return the set of
   * session ids whose owner PID is currently alive. Used by the dashboard
   * owner to construct the `activeSessionIds` argument to
   * `gcOrphanBuffers()`.
   */
  getActiveSessionIdsFromHeartbeats(): Set<string> {
    const active = new Set<string>();
    if (!existsSync(this.storagePath)) return active;
    let entries: string[];
    try {
      entries = readdirSync(this.storagePath);
    } catch {
      return active;
    }
    for (const name of entries) {
      if (!name.startsWith('active-') || !name.endsWith('.pid')) continue;
      const sessionId = name.slice('active-'.length, -'.pid'.length);
      if (!SESSION_ID_RE.test(sessionId)) continue;
      try {
        const raw = readFileSync(resolve(this.storagePath, name), 'utf-8').trim();
        const pid = Number.parseInt(raw, 10);
        if (isPidAlive(pid)) active.add(sessionId);
      } catch {
        // Unreadable heartbeat — leave the session out of the live set so a
        // mtime-based gc can still archive it eventually.
      }
    }
    return active;
  }

  /**
   * Garbage-collect stale per-PPID breadcrumb files at
   * `<storage>/session-by-ppid/<pid>.txt`. A breadcrumb is stale when its
   * PID names a process that no longer exists (Claude Code session ended).
   *
   * @returns the number of breadcrumb files deleted
   */
  gcStaleBreadcrumbs(): number {
    const breadcrumbDir = resolve(this.storagePath, 'session-by-ppid');
    if (!existsSync(breadcrumbDir)) return 0;

    let entries: string[];
    try {
      entries = readdirSync(breadcrumbDir);
    } catch (err) {
      logger.warn('Failed to enumerate breadcrumb dir for gcStaleBreadcrumbs', {
        error: String(err),
      });
      return 0;
    }

    let deleted = 0;
    for (const name of entries) {
      if (!name.endsWith('.txt')) continue;
      const pidStr = name.slice(0, -'.txt'.length);
      const pid = Number.parseInt(pidStr, 10);
      if (!Number.isFinite(pid) || pid <= 0) continue;
      if (isPidAlive(pid)) continue;
      const path = resolve(breadcrumbDir, name);
      try {
        unlinkSync(path);
        deleted++;
      } catch (err) {
        logger.debug('Failed to delete stale breadcrumb', { pid, error: String(err) });
      }
    }
    if (deleted > 0) {
      logger.info('Cleaned up stale breadcrumbs', { deleted });
    }
    return deleted;
  }

  /**
   * Migrate any pre-Fix-3 events left in the legacy shared `buffer.jsonl` into
   * per-session `buffer-<sessionId>.jsonl` files, then delete the legacy file.
   * Idempotent: returns 0 when the legacy file is absent or already empty.
   *
   * Concurrent-MCP-safe: the very first step is to atomically rename
   * `buffer.jsonl` to `buffer.jsonl.migrating-<pid>`. The rename is the
   * mutual-exclusion primitive — only one MCP wins; the loser sees ENOENT
   * (the file is no longer at the legacy path) and skips migration.
   *
   * Failure recovery: if any partition append fails partway through, the
   * `.migrating-<pid>` file is intentionally left in place. On the next boot
   * the legacy file is gone, so we no-op; the partitioned files written so
   * far hold the events that did make it across. The straggler events stuck
   * in `.migrating-<pid>` are recovered manually (forensics) or dropped — we
   * accept this trade because re-migrating from `.migrating-<pid>` would
   * re-append already-migrated partitions and produce duplicate events,
   * which is worse than a once-only loss bounded by the size of the legacy
   * file at upgrade time.
   *
   * Returns the number of events migrated.
   */
  migrateLegacyBuffer(): number {
    const legacyPath = resolve(this.storagePath, 'buffer.jsonl');
    if (!existsSync(legacyPath)) return 0;

    // Step 1: atomic rename for mutual exclusion against concurrent MCPs.
    const migratingPath = resolve(this.storagePath, `buffer.jsonl.migrating-${process.pid}`);
    // Guard against a prior crashed migration for this PID. On POSIX, rename(2)
    // atomically replaces the destination (never EEXIST), so without this check
    // a recycled PID would silently overwrite the stranded .migrating file and
    // lose its events.
    if (existsSync(migratingPath)) {
      logger.info('Legacy buffer migration: prior crashed migration file found; skipping', {
        migratingPath,
      });
      return 0;
    }
    try {
      renameSync(legacyPath, migratingPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // Another instance won the race.
        logger.info('Legacy buffer migration: another instance is migrating; skipping');
        return 0;
      }
      logger.warn('Failed to rename legacy buffer for migration', { error: String(err) });
      return 0;
    }

    let raw: string;
    try {
      raw = readFileSync(migratingPath, 'utf-8');
    } catch (err) {
      logger.warn('Failed to read legacy buffer.jsonl during migration', { error: String(err) });
      // Leave the .migrating file in place for forensic recovery; we already
      // own it via the rename so no concurrent process will retry.
      return 0;
    }

    if (!raw.trim()) {
      try {
        unlinkSync(migratingPath);
      } catch {
        // ignore
      }
      return 0;
    }

    const partitioned = new Map<string, string[]>();
    let count = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed === null || typeof parsed !== 'object') continue;
      const sid = (parsed as Record<string, unknown>).sessionId;
      const key = typeof sid === 'string' && SESSION_ID_RE.test(sid) ? sid : 'unknown';
      const bucket = partitioned.get(key) ?? [];
      bucket.push(line);
      partitioned.set(key, bucket);
      count++;
    }

    for (const [sid, lines] of partitioned) {
      const target = resolve(this.storagePath, `buffer-${sid}.jsonl`);
      try {
        appendFileSync(target, lines.join('\n') + '\n', { mode: 0o600 });
      } catch (err) {
        // Mid-partition failure: the .migrating file stays on disk so the
        // operator can recover forensically. We don't retry on next boot to
        // avoid duplicate events in already-migrated partitions.
        logger.warn(
          'Failed to migrate legacy buffer entries; leaving .migrating file for recovery',
          { sessionId: sid, migratingPath, error: String(err) },
        );
        return count;
      }
    }

    try {
      unlinkSync(migratingPath);
    } catch (err) {
      logger.warn('Migrated legacy buffer but failed to remove .migrating file', {
        migratingPath,
        error: String(err),
      });
    }
    logger.info('Legacy buffer.jsonl migrated to per-session files', {
      events: count,
      sessions: partitioned.size,
    });
    return count;
  }

  private drainPath(bufferPath: string): HookEvent[] {
    const tmpPath = bufferPath + '.drain';

    // Recover from a previous failed drain — the .drain file has events that
    // were never processed.
    if (existsSync(tmpPath)) {
      try {
        if (existsSync(bufferPath)) {
          const drainData = readFileSync(tmpPath, 'utf-8');
          const bufferData = readFileSync(bufferPath, 'utf-8');
          writeFileSync(
            bufferPath,
            drainData + (drainData.endsWith('\n') ? '' : '\n') + bufferData,
            { mode: 0o600 },
          );
          unlinkSync(tmpPath);
        } else {
          renameSync(tmpPath, bufferPath);
        }
      } catch {
        logger.warn('Failed to recover .drain file — will retry next poll');
      }
    }

    if (!existsSync(bufferPath)) {
      return [];
    }

    try {
      renameSync(bufferPath, tmpPath);
    } catch {
      return [];
    }

    try {
      const raw = readFileSync(tmpPath, 'utf-8');
      unlinkSync(tmpPath);

      if (!raw.trim()) {
        return [];
      }

      const events: HookEvent[] = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line) as HookEvent);
        } catch {
          logger.warn('Skipping malformed buffer line', { line: line.slice(0, 100) });
        }
      }
      return events;
    } catch (err) {
      logger.warn('Failed to drain buffer — will retry next poll', { error: String(err) });
      return [];
    }
  }

  /** The buffer path this store is currently scoped to (test helper). */
  getBufferPath(): string {
    return this.bufferPath;
  }

  /** The sessionId this store was scoped to, if any (test helper). */
  getSessionId(): string | null {
    return this.sessionId;
  }

  saveSession(session: SessionSummary): void {
    if (!SESSION_ID_RE.test(session.sessionId)) {
      logger.warn('Rejecting invalid sessionId for file path', { sessionId: session.sessionId });
      return;
    }
    const sessionsDir = resolve(this.storagePath, 'sessions');
    const filepath = resolve(sessionsDir, `${session.sessionId}.json`);
    if (!filepath.startsWith(sessionsDir + sep)) {
      throw new Error(`Session path escaped storage directory: ${filepath}`);
    }
    writeFileSync(filepath, JSON.stringify(session, null, 2) + '\n', { mode: 0o600 });
    logger.debug('Session saved', { sessionId: session.sessionId });
  }

  loadRecentSessions(days: number): SessionSummary[] {
    const sessionsDir = resolve(this.storagePath, 'sessions');
    if (!existsSync(sessionsDir)) {
      return [];
    }

    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const sessions: SessionSummary[] = [];

    for (const file of readdirSync(sessionsDir)) {
      if (!file.endsWith('.json')) continue;
      const filepath = join(sessionsDir, file);

      try {
        const stat = statSync(filepath);
        if (stat.mtimeMs < cutoff) continue;

        const raw = readFileSync(filepath, 'utf-8');
        const parsed = JSON.parse(raw) as unknown;
        // Guard against corrupted files (null, numbers, arrays) that would crash
        // the downstream sort on .startTime.
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          sessions.push(parsed as SessionSummary);
        }
      } catch {
        logger.warn('Skipping unreadable session file', { file });
      }
    }

    return sessions.sort((a, b) => a.startTime - b.startTime);
  }

  appendAuditLog(entry: AuditEntry): void {
    const date = new Date(entry.timestamp);
    const dateStr = date.toISOString().slice(0, 10); // YYYY-MM-DD
    const filename = `${dateStr}.jsonl`;
    const filepath = resolve(this.storagePath, 'audit', filename);

    try {
      appendFileSync(filepath, JSON.stringify(entry) + '\n', { mode: 0o600 });
    } catch (err) {
      logger.warn('Failed to append audit log', { error: String(err) });
    }
  }
}
