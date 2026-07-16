/**
 * Subagent Watcher — polls Claude Code subagent JSONL transcripts and emits
 * one `mode: 'subagent_token'` line per assistant turn into the parent
 * session's hook buffer.
 *
 * This closes a cost-correctness gap: subagent tokens (visible only
 * inside `~/.claude/projects/<slug>/<sessionId>/subagents/agent-*.jsonl`) never
 * reached `CostTracker.recordTokenUsage()` because the existing collector at
 * `collector-script.ts:178-219 readLastAssistantUsage()` only tails the parent
 * session's transcript.
 *
 * Watches two paths under each session directory:
 *   - `subagents/agent-{id}.jsonl` (ad-hoc Task calls)
 *   - `subagents/workflows/wf_{runId}/agent-{id}.jsonl` (workflow-spawned)
 *
 * Cursor durability: byte cursors persisted to
 * `~/.newrelic-preflight/.subagent-pos-<parentSessionId>-<agentId>` survive restart.
 * On crash mid-emit the next poll re-reads from the previous cursor →
 * potential duplicates which downstream dedupes by (agent_id, message.id).
 *
 * Startup-discovery budget: only files with mtime in the last 24h are eligible
 * for cold scan (configurable via `NR_AI_WATCHER_DISCOVERY_HOURS`); older
 * files emit `discovery_skipped` once each. Backfill of older files is
 * a separate, future concern.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

import { createLogger } from '../shared/index.js';
import type { LocalStore } from '../storage/local-store.js';

const logger = createLogger('subagent-watcher');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_DISCOVERY_HOURS = 24;
const MAX_BYTES_PER_POLL = 64 * 1024;
/**
 * Hard cap on the retained partial-line (un-terminated tail) per file.
 *
 * A single JSONL assistant turn is normally a few tens of KiB; the largest
 * legitimate lines observed in the wild are well under 1 MiB. When a file
 * contains a line longer than this — pathologically large content, a corrupt
 * never-terminated record, or a binary blob that happens to have no `\n` — the
 * watcher must NOT keep accumulating it across polls.
 *
 * Without this cap, any line longer than MAX_BYTES_PER_POLL caused an
 * unbounded leak: the byte cursor could only advance to a newline boundary, so
 * a chunk with no newline left the cursor frozen, and every 2s poll re-read the
 * same bytes and appended them to `partialByPath` forever (~64 KiB / poll / file
 * → multi-GB RSS in minutes). Capping the partial bounds `partialByPath` values
 * to MAX_PARTIAL_LINE_BYTES + one chunk and guarantees forward progress.
 */
const MAX_PARTIAL_LINE_BYTES = 1024 * 1024; // 1 MiB
const HEALTH_INTERVAL_MS = 60_000;
const SCHEMA_FINGERPRINT_REEMIT_MS = 60 * 60 * 1000; // 1h
const COST_SELF_CHECK_MS = 60 * 60 * 1000; // 1h
const SESSION_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const AGENT_ID_RE = /^a[a-f0-9]{16}$/;
const PROJECTS_DIR_NAME = '.claude/projects';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Event emitted into the parent buffer for each new assistant turn observed
 * in a subagent JSONL. Mirrors the wire shape of the existing 'token' mode
 * but adds the subagent-attribution fields.
 */
export interface SubagentTokenEvent {
  readonly mode: 'subagent_token';
  readonly tool: 'subagent';
  readonly timestamp: number;
  readonly sessionId: string; // parent session id
  readonly agentId: string;
  readonly workflowRunId: string | null;
  readonly messageId: string;
  readonly turnUuid: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly reasoningTokens: number;
  readonly stopReason: string | null;
  readonly schemaFingerprint: string;
}

/**
 * Health event emitted by the watcher itself. Written with
 * `mode: 'observability_health'` so the event-processor routes it to a
 * dedicated handler distinct from the token / pre / post families.
 */
export interface ObservabilityHealthEvent {
  readonly mode: 'observability_health';
  readonly tool: 'observability_health';
  readonly timestamp: number;
  readonly watcher: 'workflow' | 'subagent';
  readonly filesWatched: number;
  readonly linesRead: number;
  readonly bytesRead: number;
  readonly parseErrors: number;
  readonly schemaDrifts: number;
  readonly lastError: { code: string; class: string } | null;
  readonly event?:
    | 'schema_drift'
    | 'plane_overlap'
    | 'parser_skip'
    | 'discovered_workflow'
    | 'discovery_skipped'
    | 'late_arrival_dropped'
    | 'oversized_line_dropped'
    | 'watcher_disabled_by_lock'
    | 'cost_self_check';
  readonly dimension?: 'usage_keys' | 'content_block_types' | 'wf_progress_types';
  readonly fingerprint?: string;
  readonly workflowRunId?: string;
  readonly costSelfCheckDeltaPct?: number;
}

export interface SubagentWatcherOptions {
  /** Storage path for cursor + fingerprint state (defaults to ~/.newrelic-preflight). */
  readonly storagePath?: string;
  /** ~/.claude/projects directory; defaults to homedir-relative. */
  readonly projectsDir?: string;
  /** Poll interval in ms. Default 2000. */
  readonly pollIntervalMs?: number;
  /** Cold-scan eligibility window. Default 24h. */
  readonly discoveryHours?: number;
  /** LocalStore (used to peek the parent buffer path naming convention). */
  readonly localStore?: LocalStore;
  /**
   * If provided, watcher only processes files belonging to this session id.
   * Default: process every session id under projectsDir (matches `--local`
   * drainAll semantics).
   */
  readonly parentSessionId?: string;
  /**
   * Optional ground-truth cost computation hook. Called once per
   * COST_SELF_CHECK_MS to compute current `costTracker.totalUsd` for the
   * runtime self-check. Returns delta in percent (0-100); when this
   * hook is omitted, the self-check is skipped.
   */
  readonly costSelfCheck?: () => { trackedUsd: number; groundTruthUsd: number };
}

/** Result row from the JSONL parse (private to the module). */
interface ParsedAssistantTurn {
  readonly timestampMs: number;
  readonly messageId: string;
  readonly turnUuid: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly reasoningTokens: number;
  readonly stopReason: string | null;
  readonly usageKeysFingerprint: string;
  readonly contentBlockTypesFingerprint: string;
}

interface DiscoveredFile {
  readonly path: string;
  readonly parentSessionId: string;
  readonly agentId: string;
  readonly workflowRunId: string | null;
  /** Stat from discovery time (filterByMtime), reused by processFile to avoid a second statSync on the same path. */
  readonly stat: Stats;
}

interface CursorState {
  readonly bytePos: number;
  readonly partialLine: string;
}

// ---------------------------------------------------------------------------
// SubagentWatcher
// ---------------------------------------------------------------------------

export interface SubagentWatcherHealth {
  readonly filesWatched: number;
  readonly linesRead: number;
  readonly bytesRead: number;
  readonly parseErrors: number;
  readonly schemaDrifts: number;
  /** Lock-based disable is not implemented yet (forward-declared); always false. */
  readonly watcherDisabledByLock: boolean;
}

export class SubagentWatcher {
  private readonly storagePath: string;
  private readonly projectsDir: string;
  private readonly pollIntervalMs: number;
  private readonly discoveryHours: number;
  private readonly parentSessionFilter: string | null;
  private readonly costSelfCheck: SubagentWatcherOptions['costSelfCheck'];

  private intervalId: ReturnType<typeof setInterval> | null = null;
  private healthIntervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;

  // Per-file in-memory partial-line retention. The persisted byte cursor
  // points to the start of the next un-read byte; this map carries any trailing
  // content past the last newline that didn't form a complete line yet. It is
  // an in-memory fast path that mirrors the `partialLine` persisted in the
  // cursor file. Bounded per-entry by MAX_PARTIAL_LINE_BYTES (see processFile)
  // and per-key by the number of files discovered this poll (see poll()).
  private readonly partialByPath = new Map<string, string>();

  // Health counters
  private filesWatched = 0;
  private linesRead = 0;
  private bytesRead = 0;
  private parseErrors = 0;
  private schemaDrifts = 0;
  private lastError: { code: string; class: string } | null = null;

  // Schema-drift dedup across a 1h window. Persisted to
  // ~/.newrelic-preflight/.schema-fingerprints.
  private seenFingerprints = new Map<string, number>();
  // Files that already emitted `discovery_skipped` so we don't re-emit on
  // every poll for the same too-old file.
  private readonly discoverySkippedAnnounced = new Set<string>();
  private lastCostSelfCheckMs = 0;

  constructor(options: SubagentWatcherOptions = {}) {
    this.storagePath = options.storagePath ?? join(homedir(), '.newrelic-preflight');
    this.projectsDir = options.projectsDir ?? join(homedir(), PROJECTS_DIR_NAME);
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const envHours = parseInt(process.env.NR_AI_WATCHER_DISCOVERY_HOURS ?? '', 10);
    this.discoveryHours =
      options.discoveryHours ??
      (Number.isFinite(envHours) && envHours > 0 ? envHours : DEFAULT_DISCOVERY_HOURS);
    this.parentSessionFilter = options.parentSessionId ?? null;
    this.costSelfCheck = options.costSelfCheck;
    this.loadFingerprints();
  }

  start(): void {
    if (this.running) {
      logger.warn('SubagentWatcher already running');
      return;
    }
    this.running = true;
    if (!existsSync(this.storagePath)) {
      mkdirSync(this.storagePath, { recursive: true, mode: 0o700 });
    }
    this.intervalId = setInterval(() => this.poll(), this.pollIntervalMs);
    this.intervalId.unref();
    this.healthIntervalId = setInterval(() => this.emitHealth(), HEALTH_INTERVAL_MS);
    this.healthIntervalId.unref();
    logger.info('SubagentWatcher started', {
      pollIntervalMs: this.pollIntervalMs,
      discoveryHours: this.discoveryHours,
      projectsDir: this.projectsDir,
    });
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.healthIntervalId !== null) {
      clearInterval(this.healthIntervalId);
      this.healthIntervalId = null;
    }
    this.persistFingerprints();
    logger.info('SubagentWatcher stopped');
  }

  /**
   * Single poll cycle. Public so tests can drive deterministically without
   * waiting on the interval timer.
   */
  poll(): void {
    try {
      const files = this.discoverFiles();
      this.filesWatched = files.length;
      for (const file of files) {
        this.processFile(file);
      }
      this.evictStalePartials(files);
      this.maybeRunCostSelfCheck();
    } catch (err) {
      this.recordError(err);
    }
  }

  /** Reset counters; for tests. */
  resetHealth(): void {
    this.filesWatched = 0;
    this.linesRead = 0;
    this.bytesRead = 0;
    this.parseErrors = 0;
    this.schemaDrifts = 0;
    this.lastError = null;
  }

  /** Public snapshot of watcher health counters for the dashboard panel. */
  getHealthStats(): SubagentWatcherHealth {
    return {
      filesWatched: this.filesWatched,
      linesRead: this.linesRead,
      bytesRead: this.bytesRead,
      parseErrors: this.parseErrors,
      schemaDrifts: this.schemaDrifts,
      watcherDisabledByLock: false,
    };
  }

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  private discoverFiles(): DiscoveredFile[] {
    const out: DiscoveredFile[] = [];
    if (!existsSync(this.projectsDir)) return out;
    const cutoffMs = Date.now() - this.discoveryHours * 60 * 60 * 1000;

    let projectEntries: string[];
    try {
      projectEntries = readdirSync(this.projectsDir);
    } catch (err) {
      this.recordError(err);
      return out;
    }
    for (const project of projectEntries) {
      const projectPath = join(this.projectsDir, project);
      let stat;
      try {
        stat = statSync(projectPath);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;

      // Each project dir contains <sessionId> subdirs whose name matches
      // SESSION_ID_RE (UUID v4 lower-hex with hyphens).
      let sessionEntries: string[];
      try {
        sessionEntries = readdirSync(projectPath);
      } catch {
        continue;
      }
      for (const sessionId of sessionEntries) {
        if (!SESSION_ID_RE.test(sessionId)) continue;
        if (this.parentSessionFilter && sessionId !== this.parentSessionFilter) continue;
        const sessionDir = join(projectPath, sessionId);
        const subDir = join(sessionDir, 'subagents');
        if (!existsSync(subDir)) continue;

        // Ad-hoc: subagents/agent-*.jsonl
        try {
          for (const name of readdirSync(subDir)) {
            if (!name.startsWith('agent-') || !name.endsWith('.jsonl')) continue;
            const agentId = name.slice('agent-'.length, -'.jsonl'.length);
            if (!AGENT_ID_RE.test(agentId)) continue;
            const path = join(subDir, name);
            const stat = this.filterByMtime(path, cutoffMs);
            if (stat) {
              out.push({ path, parentSessionId: sessionId, agentId, workflowRunId: null, stat });
            }
          }
        } catch {
          /* directory unreadable — skip */
        }

        // Workflow-spawned: subagents/workflows/wf_*/agent-*.jsonl
        const wfDir = join(subDir, 'workflows');
        if (!existsSync(wfDir)) continue;
        try {
          for (const wfName of readdirSync(wfDir)) {
            if (!wfName.startsWith('wf_')) continue;
            const wfRunId = wfName;
            const wfRunDir = join(wfDir, wfName);
            let stat2;
            try {
              stat2 = statSync(wfRunDir);
            } catch {
              continue;
            }
            if (!stat2.isDirectory()) continue;
            try {
              for (const name of readdirSync(wfRunDir)) {
                if (!name.startsWith('agent-') || !name.endsWith('.jsonl')) continue;
                const agentId = name.slice('agent-'.length, -'.jsonl'.length);
                if (!AGENT_ID_RE.test(agentId)) continue;
                const path = join(wfRunDir, name);
                const stat = this.filterByMtime(path, cutoffMs);
                if (stat) {
                  out.push({
                    path,
                    parentSessionId: sessionId,
                    agentId,
                    workflowRunId: wfRunId,
                    stat,
                  });
                }
              }
            } catch {
              /* skip */
            }
          }
        } catch {
          /* skip */
        }
      }
    }
    return out;
  }

  /** Returns the file's Stats when it passes the mtime cutoff, else null — callers reuse the Stats instead of re-statting the same path. */
  private filterByMtime(path: string, cutoffMs: number): Stats | null {
    try {
      const st = statSync(path);
      if (st.mtimeMs < cutoffMs) {
        if (!this.discoverySkippedAnnounced.has(path)) {
          this.discoverySkippedAnnounced.add(path);
          this.appendHealth({
            mode: 'observability_health',
            tool: 'observability_health',
            timestamp: Date.now(),
            watcher: 'subagent',
            filesWatched: 0,
            linesRead: 0,
            bytesRead: 0,
            parseErrors: 0,
            schemaDrifts: 0,
            lastError: null,
            event: 'discovery_skipped',
          });
        }
        return null;
      }
      return st;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Per-file processing
  // -------------------------------------------------------------------------

  private processFile(file: DiscoveredFile): void {
    const st = file.stat;
    const cursorPath = this.cursorPath(file.parentSessionId, file.agentId);
    const startCursor = this.readCursor(cursorPath);

    if (startCursor.bytePos >= st.size) return;

    const remaining = st.size - startCursor.bytePos;
    const toRead = Math.min(remaining, MAX_BYTES_PER_POLL);
    let buf: Buffer;
    let actuallyRead = 0;
    let fd: number | null = null;
    try {
      fd = openSync(file.path, 'r');
      buf = Buffer.allocUnsafe(toRead);
      actuallyRead = readSync(fd, buf, 0, toRead, startCursor.bytePos);
    } catch (err) {
      this.recordError(err);
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          /* ignore */
        }
      }
      return;
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }
    if (actuallyRead === 0) return;

    const chunk = buf.subarray(0, actuallyRead).toString('utf-8');
    this.bytesRead += actuallyRead;

    // Carry over any partial-line content from the previous poll. The in-memory
    // map is the fast path; on a cold start (e.g. after restart) we fall back to
    // the partial persisted alongside the byte cursor.
    const carried = this.partialByPath.get(file.path) ?? startCursor.partialLine;
    const combined = carried + chunk;

    // The byte cursor ALWAYS advances by the bytes we just read from the file —
    // those bytes are now folded into `combined` and must never be re-read.
    // (The previous implementation only advanced to the last newline, which
    // froze the cursor whenever a single line exceeded MAX_BYTES_PER_POLL and
    // caused `partialByPath` to grow without bound — the OOM root cause. It also
    // double-counted the partial region, prepending bytes that the cursor had
    // already advanced past.)
    const nextBytePos = startCursor.bytePos + actuallyRead;

    // Split into complete lines (terminated by '\n') and a trailing remainder.
    const lastNewline = combined.lastIndexOf('\n');
    let lines: string[] = [];
    let newPartial = combined;
    if (lastNewline >= 0) {
      lines = combined.slice(0, lastNewline).split('\n');
      newPartial = combined.slice(lastNewline + 1);
    }

    // Bound the retained partial. A remainder larger than MAX_PARTIAL_LINE_BYTES
    // is not a line we will ever be able to parse (a line that big is corrupt or
    // pathological); drop it so the partial can't accumulate across polls. The
    // cursor has already advanced past these bytes, so we make forward progress
    // and never revisit them.
    let droppedOversized = false;
    if (newPartial.length > MAX_PARTIAL_LINE_BYTES) {
      droppedOversized = true;
      newPartial = '';
      this.parseErrors += 1;
    }

    // Emit token events for each parsed assistant turn
    for (const line of lines) {
      if (!line) continue;
      this.linesRead += 1;
      const parsed = this.tryParseLine(line, file);
      if (parsed === null) continue;
      this.handleSchemaFingerprint('usage_keys', parsed.usageKeysFingerprint, file.workflowRunId);
      this.handleSchemaFingerprint(
        'content_block_types',
        parsed.contentBlockTypesFingerprint,
        file.workflowRunId,
      );

      const event: SubagentTokenEvent = {
        mode: 'subagent_token',
        tool: 'subagent',
        timestamp: parsed.timestampMs,
        sessionId: file.parentSessionId,
        agentId: file.agentId,
        workflowRunId: file.workflowRunId,
        messageId: parsed.messageId,
        turnUuid: parsed.turnUuid,
        model: parsed.model,
        inputTokens: parsed.inputTokens,
        outputTokens: parsed.outputTokens,
        cacheReadTokens: parsed.cacheReadTokens,
        cacheCreationTokens: parsed.cacheCreationTokens,
        reasoningTokens: parsed.reasoningTokens,
        stopReason: parsed.stopReason,
        schemaFingerprint: parsed.usageKeysFingerprint,
      };
      this.appendToParentBuffer(file.parentSessionId, event);
    }

    // Persist the advanced cursor plus the (bounded) trailing partial so a
    // restart resumes exactly where we left off. Keep the in-memory mirror in
    // sync; when the partial is empty, drop the key entirely so a fully-consumed
    // file leaves no residual entry in the map.
    this.writeCursor(cursorPath, nextBytePos, newPartial);
    if (newPartial.length > 0) {
      this.partialByPath.set(file.path, newPartial);
    } else {
      this.partialByPath.delete(file.path);
    }

    if (droppedOversized) {
      this.appendHealth({
        mode: 'observability_health',
        tool: 'observability_health',
        timestamp: Date.now(),
        watcher: 'subagent',
        filesWatched: this.filesWatched,
        linesRead: this.linesRead,
        bytesRead: this.bytesRead,
        parseErrors: this.parseErrors,
        schemaDrifts: this.schemaDrifts,
        lastError: this.lastError,
        event: 'oversized_line_dropped',
      });
    }
  }

  /**
   * Drop in-memory partial-line state for files that are no longer discovered
   * (e.g. session directory removed, file aged past the discovery window). This
   * keeps `partialByPath` bounded by the live file set rather than the
   * all-time-seen file set. The persisted cursor file is left untouched — if the
   * file reappears, we resume from it.
   */
  private evictStalePartials(files: DiscoveredFile[]): void {
    if (this.partialByPath.size === 0) return;
    const live = new Set<string>();
    for (const f of files) live.add(f.path);
    for (const path of this.partialByPath.keys()) {
      if (!live.has(path)) this.partialByPath.delete(path);
    }
  }

  /**
   * Parse a JSONL line, return non-null only when it's a valid assistant turn
   * with usage. Sets parseErrors counter on JSON parse failures.
   */
  private tryParseLine(line: string, _file: DiscoveredFile): ParsedAssistantTurn | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.parseErrors += 1;
      return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    if (obj.type !== 'assistant') return null;
    const message = obj.message;
    if (!message || typeof message !== 'object') return null;
    const m = message as Record<string, unknown>;
    const model = typeof m.model === 'string' ? m.model : null;
    if (!model || model === '<synthetic>') return null;
    const messageId = typeof m.id === 'string' ? m.id : null;
    if (!messageId) return null;
    const usage = m.usage;
    if (!usage || typeof usage !== 'object') return null;
    const u = usage as Record<string, unknown>;

    const turnUuid = typeof obj.uuid === 'string' ? obj.uuid : '';
    const tsRaw = typeof obj.timestamp === 'string' ? obj.timestamp : null;
    const timestampMs = tsRaw ? Date.parse(tsRaw) : Date.now();
    if (!Number.isFinite(timestampMs)) return null;

    const inputTokens = num(u.input_tokens);
    const outputTokens = num(u.output_tokens);
    const cacheReadTokens = num(u.cache_read_input_tokens);
    const cacheCreationTokens = num(u.cache_creation_input_tokens);
    let reasoningTokens = 0;
    const otd = u.output_tokens_details;
    if (otd && typeof otd === 'object') {
      reasoningTokens = num((otd as Record<string, unknown>).reasoning_tokens);
    }
    const stopReason = typeof m.stop_reason === 'string' ? m.stop_reason : null;

    const usageKeysFingerprint = computeUsageKeysFingerprint(u);
    const contentBlockTypesFingerprint = computeContentBlockTypesFingerprint(m.content);

    return {
      timestampMs,
      messageId,
      turnUuid,
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      reasoningTokens,
      stopReason,
      usageKeysFingerprint,
      contentBlockTypesFingerprint,
    };
  }

  // -------------------------------------------------------------------------
  // Buffer + cursor I/O
  // -------------------------------------------------------------------------

  private cursorPath(parentSessionId: string, agentId: string): string {
    return join(this.storagePath, `.subagent-pos-${parentSessionId}-${agentId}`);
  }

  private readCursor(cursorPath: string): CursorState {
    if (!existsSync(cursorPath)) return { bytePos: 0, partialLine: '' };
    try {
      const raw = readFileSync(cursorPath, 'utf-8').trim();
      const parsed = JSON.parse(raw);
      const bytePos =
        typeof parsed.bytePos === 'number' && parsed.bytePos >= 0 ? parsed.bytePos : 0;
      const partialLine = typeof parsed.partialLine === 'string' ? parsed.partialLine : '';
      return { bytePos, partialLine };
    } catch {
      return { bytePos: 0, partialLine: '' };
    }
  }

  private writeCursor(cursorPath: string, bytePos: number, partialLine: string): void {
    try {
      if (!existsSync(this.storagePath)) {
        mkdirSync(this.storagePath, { recursive: true, mode: 0o700 });
      }
      const dir = dirname(cursorPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(cursorPath, JSON.stringify({ bytePos, partialLine }), { mode: 0o600 });
    } catch (err) {
      this.recordError(err);
    }
  }

  /**
   * Append to the parent's per-session buffer file. Mirrors the path-naming
   * used by `LocalStore` so `HookEventProcessor.poll()` will pick it up.
   */
  private appendToParentBuffer(parentSessionId: string, event: object): void {
    const path = join(this.storagePath, `buffer-${parentSessionId}.jsonl`);
    try {
      if (!existsSync(this.storagePath)) {
        mkdirSync(this.storagePath, { recursive: true, mode: 0o700 });
      }
      appendFileSync(path, JSON.stringify(event) + '\n', { mode: 0o600 });
    } catch (err) {
      this.recordError(err);
    }
  }

  private appendHealth(event: ObservabilityHealthEvent): void {
    // Health rides through the same parent-buffer pipeline so the
    // event-processor's poll picks it up uniformly. When no specific session
    // is in scope we fan out to a shared bucket (`buffer-health.jsonl`) which
    // `drainAllBuffers()` covers via its `buffer-*.jsonl` glob; we use a
    // sessionless name when the watcher is unfiltered.
    const sessionId = this.parentSessionFilter ?? 'health';
    this.appendToParentBuffer(sessionId, event);
  }

  // -------------------------------------------------------------------------
  // Schema-drift sentinels
  // -------------------------------------------------------------------------

  private handleSchemaFingerprint(
    dimension: 'usage_keys' | 'content_block_types' | 'wf_progress_types',
    fingerprint: string,
    workflowRunId: string | null,
  ): void {
    const key = `${dimension}:${fingerprint}`;
    const lastSeen = this.seenFingerprints.get(key);
    const now = Date.now();
    if (lastSeen !== undefined && now - lastSeen < SCHEMA_FINGERPRINT_REEMIT_MS) return;
    this.seenFingerprints.set(key, now);
    this.persistFingerprints();
    if (lastSeen === undefined) {
      this.schemaDrifts += 1;
    }
    this.appendHealth({
      mode: 'observability_health',
      tool: 'observability_health',
      timestamp: now,
      watcher: 'subagent',
      filesWatched: this.filesWatched,
      linesRead: this.linesRead,
      bytesRead: this.bytesRead,
      parseErrors: this.parseErrors,
      schemaDrifts: this.schemaDrifts,
      lastError: this.lastError,
      event: 'schema_drift',
      dimension,
      fingerprint,
      ...(workflowRunId ? { workflowRunId } : {}),
    });
  }

  private loadFingerprints(): void {
    const path = join(this.storagePath, '.schema-fingerprints');
    if (!existsSync(path)) return;
    try {
      const raw = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'number') this.seenFingerprints.set(k, v);
        }
      }
    } catch {
      /* ignore — corrupt file means a fresh start */
    }
  }

  private persistFingerprints(): void {
    const path = join(this.storagePath, '.schema-fingerprints');
    try {
      if (!existsSync(this.storagePath)) {
        mkdirSync(this.storagePath, { recursive: true, mode: 0o700 });
      }
      // Trim entries older than the re-emission window so the file does not
      // grow unbounded.
      const now = Date.now();
      const out: Record<string, number> = {};
      for (const [k, v] of this.seenFingerprints) {
        if (now - v < SCHEMA_FINGERPRINT_REEMIT_MS * 24) out[k] = v;
      }
      writeFileSync(path, JSON.stringify(out), { mode: 0o600 });
    } catch (err) {
      this.recordError(err);
    }
  }

  // -------------------------------------------------------------------------
  // Health emission
  // -------------------------------------------------------------------------

  private emitHealth(): void {
    const event: ObservabilityHealthEvent = {
      mode: 'observability_health',
      tool: 'observability_health',
      timestamp: Date.now(),
      watcher: 'subagent',
      filesWatched: this.filesWatched,
      linesRead: this.linesRead,
      bytesRead: this.bytesRead,
      parseErrors: this.parseErrors,
      schemaDrifts: this.schemaDrifts,
      lastError: this.lastError,
    };
    this.appendHealth(event);
  }

  private maybeRunCostSelfCheck(): void {
    if (!this.costSelfCheck) return;
    const now = Date.now();
    if (now - this.lastCostSelfCheckMs < COST_SELF_CHECK_MS) return;
    this.lastCostSelfCheckMs = now;
    let result: { trackedUsd: number; groundTruthUsd: number };
    try {
      result = this.costSelfCheck();
    } catch (err) {
      this.recordError(err);
      return;
    }
    const denom = Math.max(result.groundTruthUsd, 1e-9);
    const deltaPct = ((result.groundTruthUsd - result.trackedUsd) / denom) * 100;
    this.appendHealth({
      mode: 'observability_health',
      tool: 'observability_health',
      timestamp: now,
      watcher: 'subagent',
      filesWatched: this.filesWatched,
      linesRead: this.linesRead,
      bytesRead: this.bytesRead,
      parseErrors: this.parseErrors,
      schemaDrifts: this.schemaDrifts,
      lastError: this.lastError,
      event: 'cost_self_check',
      costSelfCheckDeltaPct: deltaPct,
    });
  }

  private recordError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string }).code ?? 'UNKNOWN';
    const cls = err instanceof Error ? err.constructor.name : 'Error';
    this.lastError = { code: String(code).slice(0, 80), class: String(cls).slice(0, 80) };
    logger.warn('SubagentWatcher error', { code, message: message.slice(0, 200) });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

function computeUsageKeysFingerprint(usage: Record<string, unknown>): string {
  const keys: string[] = [];
  for (const k of Object.keys(usage).sort()) keys.push(k);
  // Include child keys of `output_tokens_details` so reasoning-token drift
  // produces a distinct fingerprint without inflating the dimension space.
  const otd = usage.output_tokens_details;
  if (otd && typeof otd === 'object') {
    for (const k of Object.keys(otd as Record<string, unknown>).sort()) {
      keys.push(`output_tokens_details.${k}`);
    }
  }
  return shortHash(keys.join('|'));
}

function computeContentBlockTypesFingerprint(content: unknown): string {
  if (!Array.isArray(content)) return shortHash('');
  const set = new Set<string>();
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      typeof (block as { type?: unknown }).type === 'string'
    ) {
      set.add(String((block as { type: string }).type));
    }
  }
  const sorted = Array.from(set).sort();
  return shortHash(sorted.join('|'));
}

function shortHash(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 16);
}

/**
 * Stable cursor file path computation, exported for tests that want to
 * pre-create cursor state without instantiating the watcher.
 */
export function buildSubagentCursorPath(
  storagePath: string,
  parentSessionId: string,
  agentId: string,
): string {
  return resolve(storagePath, `.subagent-pos-${parentSessionId}-${agentId}`);
}
