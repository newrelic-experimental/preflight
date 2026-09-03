/**
 * Copilot App Usage Watcher — polls the GitHub Copilot desktop app's own
 * SQLite economics store and emits one `mode: 'token'` line per observed
 * usage delta into the session's hook buffer, giving Copilot-app sessions
 * token-exact cost the same way `CopilotUsageWatcher` does for VS Code's
 * Copilot Chat debug logs.
 *
 * Source of truth: `<copilotDir>/data.db`, a WAL-mode SQLite database the
 * app's Rust GUI keeps open for its lifetime (see `copilot-app-adapter.ts`
 * for how this file is used to detect the app at all). Its `sessions` table
 * carries one row per chat session, keyed by `id` — a UUID that is
 * byte-identical to the Preflight session id already flowing through the
 * hook pipeline (`session_id` in every PreToolUse/PostToolUse payload), so
 * no correlation key or lookup is needed to route a row's usage to the right
 * `buffer-<sessionId>.jsonl`. `total_input_tokens` / `total_output_tokens` /
 * `total_cached_tokens` / `total_reasoning_tokens` are cumulative counters
 * that grow monotonically while the session runs; this watcher diffs them
 * against a durable per-session cursor to emit only the delta since the last
 * poll, mirroring the byte-cursor approach `CopilotUsageWatcher` uses for its
 * log tail.
 *
 * The database is opened `readOnly: true` on every poll and closed
 * immediately after — this watcher must never hold a lock that could
 * contend with the app's own writer, and re-opening per poll means a schema
 * migration or file replacement between polls is picked up for free instead
 * of wedging a stale handle open.
 *
 * `data.db`'s schema is not a published API (it is the app's private
 * storage, verified empirically — see `copilot-app-adapter.ts`'s header),
 * so it carries the same stability tier as the Copilot debug-log format
 * `CopilotUsageWatcher` depends on: any drift (locked file, missing table,
 * missing/renamed column) is caught, logged once per process, and degrades
 * this watcher to zero emissions rather than crashing the host process.
 *
 * Known follow-up: `total_nano_aiu` (GitHub's own billing meter, denominated
 * in AIU × 1e9) is deliberately not read yet. Its exact semantics — in
 * particular whether it overlaps with `total_agent_merge_nano_aiu` on the
 * same row — are unestablished, so reading it now risks either double
 * counting or silently wrong units. Revisit once that's confirmed against a
 * real billing reconciliation.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createLogger } from '../shared/index.js';
import { getCopilotAppDir } from '../platforms/copilot-app-adapter.js';
import type { LocalStore } from '../storage/local-store.js';

const logger = createLogger('copilot-app-usage-watcher');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_DISCOVERY_HOURS = 24;
const SESSION_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SESSION_COLUMNS =
  'id, model, updated_at, total_input_tokens, total_output_tokens, total_cached_tokens, total_reasoning_tokens';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CopilotAppUsageWatcherOptions {
  /** Storage path for cursor state + buffers (defaults to ~/.newrelic-preflight). */
  readonly storagePath?: string;
  /** The app's data directory; defaults to the same resolution CopilotAppAdapter uses. */
  readonly copilotDir?: string;
  /** Poll interval in ms. Default 5000. */
  readonly pollIntervalMs?: number;
  /** Discovery window (updated_at) for unscoped session rows. Default 24h. */
  readonly discoveryHours?: number;
  /**
   * If provided, only this session's row is queried (the `--stdio` case).
   * Default: every recently-updated session (matches `--local` semantics).
   */
  readonly parentSessionId?: string;
  /** LocalStore, used to exclude sessions already owned by a live --stdio watcher in unscoped mode. */
  readonly localStore?: LocalStore;
}

export interface CopilotAppUsageWatcherHealth {
  readonly sessionsWatched: number;
  readonly linesEmitted: number;
  readonly parseErrors: number;
  readonly schemaDrifts: number;
  readonly dbMissing: boolean;
}

interface SessionTotalsRow {
  readonly id: string;
  readonly model: string | null;
  readonly updated_at: string;
  readonly total_input_tokens: number | null;
  readonly total_output_tokens: number | null;
  readonly total_cached_tokens: number | null;
  readonly total_reasoning_tokens: number | null;
}

/** Cumulative totals as of the last poll that produced an emission (or the re-baseline point). */
interface CursorState {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly reasoningTokens: number;
}

const ZERO_CURSOR: CursorState = {
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  reasoningTokens: 0,
};

// ---------------------------------------------------------------------------
// CopilotAppUsageWatcher
// ---------------------------------------------------------------------------

export class CopilotAppUsageWatcher {
  private readonly storagePath: string;
  private readonly copilotDir: string;
  private readonly pollIntervalMs: number;
  private readonly discoveryHours: number;
  private readonly parentSessionFilter: string | null;
  private readonly localStore: LocalStore | undefined;

  private intervalId: ReturnType<typeof setInterval> | null = null;

  private sessionsWatched = 0;
  private linesEmitted = 0;
  private parseErrors = 0;
  private schemaDrifts = 0;
  private dbMissing = false;
  private warnedSchemaDrift = false;

  constructor(options: CopilotAppUsageWatcherOptions = {}) {
    this.storagePath = options.storagePath ?? join(homedir(), '.newrelic-preflight');
    this.copilotDir = options.copilotDir ?? getCopilotAppDir();
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.discoveryHours = options.discoveryHours ?? DEFAULT_DISCOVERY_HOURS;
    this.parentSessionFilter = options.parentSessionId ?? null;
    this.localStore = options.localStore;
  }

  start(): void {
    if (this.intervalId !== null) return;
    this.intervalId = setInterval(() => {
      try {
        this.poll();
      } catch (err) {
        this.recordError(err);
      }
    }, this.pollIntervalMs);
    this.intervalId.unref?.();
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  getHealth(): CopilotAppUsageWatcherHealth {
    return {
      sessionsWatched: this.sessionsWatched,
      linesEmitted: this.linesEmitted,
      parseErrors: this.parseErrors,
      schemaDrifts: this.schemaDrifts,
      dbMissing: this.dbMissing,
    };
  }

  /** One discovery + emit pass. Exported for direct testing. */
  poll(): void {
    const dbPath = join(this.copilotDir, 'data.db');
    if (!existsSync(dbPath)) {
      this.dbMissing = true;
      this.sessionsWatched = 0;
      return;
    }
    this.dbMissing = false;

    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const rows = this.queryRows(db);
      this.sessionsWatched = rows.length;
      for (const row of rows) {
        try {
          this.processRow(row);
        } catch (err) {
          this.parseErrors += 1;
          this.recordError(err);
        }
      }
    } catch (err) {
      // Locked, corrupt, or missing table/column all land here — the app's
      // data.db schema is unpublished, so any of these reads as drift, not a
      // bug to crash on.
      this.schemaDrifts += 1;
      if (!this.warnedSchemaDrift) {
        this.warnedSchemaDrift = true;
        logger.warn('CopilotAppUsageWatcher: data.db read failed (schema drift or lock)', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      db?.close();
    }
  }

  // -------------------------------------------------------------------------
  // Querying
  // -------------------------------------------------------------------------

  private queryRows(db: DatabaseSync): SessionTotalsRow[] {
    if (this.parentSessionFilter !== null) {
      const stmt = db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`);
      return stmt.all(this.parentSessionFilter) as unknown as SessionTotalsRow[];
    }

    const stmt = db.prepare(
      `SELECT ${SESSION_COLUMNS} FROM sessions ORDER BY updated_at DESC LIMIT 50`,
    );
    const rows = stmt.all() as unknown as SessionTotalsRow[];
    const cutoffMs = Date.now() - this.discoveryHours * 3_600_000;
    // Unscoped (--local) mode: skip sessions a live --stdio process already
    // owns, so two processes never race on the same cursor file — identical
    // to CopilotUsageWatcher's unfiltered discovery.
    const liveOwnedSessionIds = this.localStore?.getActiveSessionIdsFromHeartbeats() ?? null;
    return rows.filter((row) => {
      if (!SESSION_ID_RE.test(row.id)) return false;
      if (liveOwnedSessionIds?.has(row.id)) return false;
      const updatedMs = Date.parse(row.updated_at);
      // Unparseable updated_at is treated as recent rather than excluded —
      // an unknown timestamp is not evidence of staleness.
      if (Number.isFinite(updatedMs) && updatedMs < cutoffMs) return false;
      return true;
    });
  }

  // -------------------------------------------------------------------------
  // Emission
  // -------------------------------------------------------------------------

  private processRow(row: SessionTotalsRow): void {
    const sessionId = row.id;
    const cursor = this.readCursor(sessionId);
    const totals: CursorState = {
      inputTokens: num(row.total_input_tokens),
      outputTokens: num(row.total_output_tokens),
      cachedTokens: num(row.total_cached_tokens),
      reasoningTokens: num(row.total_reasoning_tokens),
    };

    const shrank =
      totals.inputTokens < cursor.inputTokens ||
      totals.outputTokens < cursor.outputTokens ||
      totals.cachedTokens < cursor.cachedTokens ||
      totals.reasoningTokens < cursor.reasoningTokens;
    if (shrank) {
      // A total below the cursor means the session id was reused after a
      // fork/reset, or the app's own counters were reset — not a real
      // negative delta. Re-baseline without emitting so the next real growth
      // reports only its own delta.
      this.writeCursor(sessionId, totals);
      return;
    }

    const dInput = totals.inputTokens - cursor.inputTokens;
    const dOutput = totals.outputTokens - cursor.outputTokens;
    const dCached = totals.cachedTokens - cursor.cachedTokens;
    const dReasoning = totals.reasoningTokens - cursor.reasoningTokens;
    if (dInput === 0 && dOutput === 0 && dCached === 0 && dReasoning === 0) {
      return;
    }

    const updatedMs = Date.parse(row.updated_at);
    const timestamp = Number.isFinite(updatedMs) ? updatedMs : Date.now();

    this.appendToBuffer(sessionId, {
      mode: 'token',
      tool: 'copilot-app-usage',
      timestamp,
      sessionId,
      // 'auto' and other unpriceable model strings pass through as-is —
      // CostTracker simply can't price them, but the exact token counts
      // still land. Never invent a model mapping here.
      model: row.model ?? 'unknown',
      // Deterministic from the cumulative totals at emit time (not the
      // delta), so a crash between this append and the cursor write below
      // dedups downstream via HookEventProcessor's (sessionId, messageId)
      // ring instead of double-billing on the next poll's re-read.
      messageId: `copilot-app:${sessionId}:${totals.inputTokens}:${totals.outputTokens}`,
      // Mirrors CopilotUsageWatcher's verified cache-inclusive inputTokens
      // semantics from the same vendor's VS Code pipeline (see its comment at
      // the equivalent emission site in copilot-usage-watcher.ts) — inferred
      // here for the app DB, not independently verified. If
      // total_input_tokens turns out cache-exclusive the split under-reports
      // plain input, never double-bills.
      inputTokens: Math.max(0, dInput - dCached),
      cacheReadTokens: dCached,
      cacheCreationTokens: 0,
      outputTokens: dOutput,
      // dReasoning is tracked in the cursor above but not emitted here —
      // TokenEvent has no reasoning-token field.
    });
    this.linesEmitted += 1;

    this.writeCursor(sessionId, totals);
  }

  // -------------------------------------------------------------------------
  // Cursor + buffer I/O
  // -------------------------------------------------------------------------

  private cursorPath(sessionId: string): string {
    return join(this.storagePath, `.copilot-app-usage-pos-${sessionId}`);
  }

  private readCursor(sessionId: string): CursorState {
    const cursorPath = this.cursorPath(sessionId);
    if (!existsSync(cursorPath)) return ZERO_CURSOR;
    try {
      const parsed = JSON.parse(readFileSync(cursorPath, 'utf-8').trim()) as Record<
        string,
        unknown
      >;
      return {
        inputTokens: num(parsed.inputTokens),
        outputTokens: num(parsed.outputTokens),
        cachedTokens: num(parsed.cachedTokens),
        reasoningTokens: num(parsed.reasoningTokens),
      };
    } catch {
      return ZERO_CURSOR;
    }
  }

  private ensureStorageDir(): void {
    if (!existsSync(this.storagePath)) {
      mkdirSync(this.storagePath, { recursive: true, mode: 0o700 });
    }
  }

  private writeCursor(sessionId: string, totals: CursorState): void {
    try {
      this.ensureStorageDir();
      writeFileSync(this.cursorPath(sessionId), JSON.stringify(totals), { mode: 0o600 });
    } catch (err) {
      this.recordError(err);
    }
  }

  /** Append into the session's hook buffer, same path convention as the collector. */
  private appendToBuffer(sessionId: string, event: object): void {
    try {
      this.ensureStorageDir();
      appendFileSync(
        join(this.storagePath, `buffer-${sessionId}.jsonl`),
        JSON.stringify(event) + '\n',
        {
          mode: 0o600,
        },
      );
    } catch (err) {
      this.recordError(err);
    }
  }

  private recordError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('CopilotAppUsageWatcher error', { message: message.slice(0, 200) });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}
