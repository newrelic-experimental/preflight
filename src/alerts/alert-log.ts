import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

import { createLogger } from '../shared/index.js';

import type { AlertEvent } from '../dashboard/live-event-bus.js';

// Runtime shape check for entries read back from disk. Hand-edited or
// corrupted log files won't poison the API consumer with wrong-typed
// fields. Mirrors the AlertEvent interface in live-event-bus.ts.
const AlertEventSchema = z.object({
  id: z.string().min(1),
  state: z.enum(['firing', 'cleared']),
  severity: z.enum(['info', 'warning', 'critical']),
  title: z.string(),
  description: z.string(),
  value: z.number(),
  threshold: z.number(),
  firedAt: z.number(),
});

const logger = createLogger('alert-log');

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export interface AlertLogOptions {
  readonly path: string;
  readonly maxBytes?: number;
}

/**
 * Append-only JSONL log for alert events. One file with one rotation
 * (`<path>.1`). All filesystem I/O is deferred to first append() so the
 * constructor stays cheap and side-effect-free for testing.
 */
export class AlertLog {
  private readonly path: string;
  private readonly maxBytes: number;
  private initialized = false;
  private pending: Promise<void> = Promise.resolve();

  constructor(opts: AlertLogOptions) {
    this.path = opts.path;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  async append(event: AlertEvent): Promise<void> {
    // Serialize writes so concurrent callers don't interleave lines.
    this.pending = this.pending.then(async () => {
      try {
        await this.ensureInitialized();
        // rotateIfNeeded() can rename log.jsonl → log.jsonl.1 and
        // a process crash before the appendFile below would lose the
        // current event (not in .1, not in the new file). Acceptable for
        // Acceptable trade-off: (a) rotation is rare — tens of MB of alert
        // history per device — so the crash window is small; (b) the
        // alternative (write-temp + rename + append) doubles the I/O
        // cost on every append. Revisit if audit-trail compliance ever
        // demands stronger durability than "best-effort tail".
        await this.rotateIfNeeded();
        const line = JSON.stringify(event) + '\n';
        await fs.appendFile(this.path, line, { mode: 0o600 });
      } catch (err) {
        logger.error('Failed to append alert log entry', { error: String(err) });
      }
    });
    await this.pending;
  }

  async readRecent(limit: number): Promise<AlertEvent[]> {
    if (limit <= 0) return [];
    // Chain through pending AND reassign it so subsequent appends wait for
    // this read to finish. Without the reassignment, an append queued after
    // readRecent() can still race: both chain off the same resolved predecessor
    // and run concurrently — the append's rotation can then be observed by
    // doReadRecent mid-rename.
    const result = this.pending.then(() => this.doReadRecent(limit));
    this.pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async doReadRecent(limit: number): Promise<AlertEvent[]> {
    const readLines = async (filePath: string): Promise<string[]> => {
      try {
        const data = await fs.readFile(filePath, 'utf8');
        return data.split('\n').filter((l) => l.length > 0);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return [];
        logger.error('Failed to read alert log', { path: filePath, error: String(err) });
        return [];
      }
    };

    // Read the rotation backup first (older entries), then the primary file
    const [rotatedLines, primaryLines] = await Promise.all([
      readLines(`${this.path}.1`),
      readLines(this.path),
    ]);
    const allLines = [...rotatedLines, ...primaryLines];
    const slice = allLines.slice(-limit).reverse();

    const out: AlertEvent[] = [];
    for (const line of slice) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        logger.warn('Skipping malformed alert log line (invalid JSON)', {
          error: String(err),
        });
        continue;
      }
      const result = AlertEventSchema.safeParse(parsed);
      if (!result.success) {
        logger.warn('Skipping alert log entry with unexpected shape', {
          issue: result.error.issues[0]?.message ?? 'unknown',
        });
        continue;
      }
      out.push(result.data);
    }
    return out;
  }

  async rotateIfNeeded(): Promise<void> {
    try {
      const stat = await fs.stat(this.path);
      if (stat.size <= this.maxBytes) return;
      const rotated = `${this.path}.1`;
      // Replace any existing .1 (only one rotation kept).
      await fs.rename(this.path, rotated);
      // rename preserves source perms, so a manually pre-created
      // log with looser modes would carry that into .1. Force 0o600
      // explicitly. Best-effort — Windows/NFS may not support chmod, and
      // a perms failure shouldn't break rotation itself.
      try {
        await fs.chmod(rotated, 0o600);
      } catch {
        /* ignore */
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      logger.warn('Alert log rotation failed', { error: String(err) });
    }
  }

  async close(): Promise<void> {
    // Drain any in-flight writes.
    await this.pending;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    const dir = dirname(this.path);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    // Best-effort: tighten perms on the directory if it already existed with
    // looser perms. Failure here (e.g. on Windows or NFS) is not fatal.
    try {
      await fs.chmod(dir, 0o700);
    } catch {
      /* ignore */
    }
    this.initialized = true;
  }
}
