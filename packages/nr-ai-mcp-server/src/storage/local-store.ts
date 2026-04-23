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
import { createLogger } from '@nr-ai-observatory/shared';
import type { HookEvent, SessionSummary, AuditEntry } from './types.js';

const logger = createLogger('local-store');

export class LocalStore {
  private readonly storagePath: string;
  private readonly bufferPath: string;

  constructor(storagePath: string, bufferPath?: string) {
    this.storagePath = storagePath;
    this.bufferPath = bufferPath ?? resolve(storagePath, 'buffer.jsonl');
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
      appendFileSync(this.bufferPath, JSON.stringify(event) + '\n');
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
    const tmpPath = this.bufferPath + '.drain';

    // Recover from a previous failed drain — the .drain file has events that
    // were never processed.
    if (existsSync(tmpPath)) {
      try {
        if (existsSync(this.bufferPath)) {
          const drainData = readFileSync(tmpPath, 'utf-8');
          const bufferData = readFileSync(this.bufferPath, 'utf-8');
          writeFileSync(this.bufferPath, drainData + (drainData.endsWith('\n') ? '' : '\n') + bufferData);
          unlinkSync(tmpPath);
        } else {
          renameSync(tmpPath, this.bufferPath);
        }
      } catch {
        logger.warn('Failed to recover .drain file — will retry next poll');
      }
    }

    if (!existsSync(this.bufferPath)) {
      return [];
    }

    try {
      renameSync(this.bufferPath, tmpPath);
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

  saveSession(session: SessionSummary): void {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(session.sessionId)) {
      logger.warn('Rejecting invalid sessionId for file path', { sessionId: session.sessionId });
      return;
    }
    const sessionsDir = resolve(this.storagePath, 'sessions');
    const filepath = resolve(sessionsDir, `${session.sessionId}.json`);
    if (!filepath.startsWith(sessionsDir + sep)) {
      throw new Error(`Session path escaped storage directory: ${filepath}`);
    }
    writeFileSync(filepath, JSON.stringify(session, null, 2) + '\n');
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
        sessions.push(JSON.parse(raw) as SessionSummary);
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
      appendFileSync(filepath, JSON.stringify(entry) + '\n');
    } catch (err) {
      logger.warn('Failed to append audit log', { error: String(err) });
    }
  }
}
