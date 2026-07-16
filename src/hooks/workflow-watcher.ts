/**
 * Workflow Watcher — polls `~/.claude/projects/<slug>/<sessionId>/workflows/wf_*.json`
 * and emits one `mode:'workflow_run'` JSONL line per mtime change.
 *
 * The on-disk JSON is the only place per-workflow rollups (status, total
 * tokens, agent count, declared topology via the sibling
 * `workflows/scripts/<name>-wf_<runId>.js`) are persisted; hooks only see
 * the parent's single Workflow tool_use.
 *
 * The watcher correlates with the SubagentWatcher's per-agent telemetry by
 * the `wf_<runId>` filename suffix. Token-reconciliation delta is computed
 * here so the dashboard can surface "rollup says X, sum-of-subagents says Y"
 * without an NR-side join (the dashboard's reconciliation card).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { createLogger } from '../shared/index.js';
import type {
  ObservabilityHealthMetrics,
  ScriptWorkflowRunMetrics,
} from '../transport/nr-ingest.js';
import { parseWorkflowScript, type DeclaredTopology } from './workflow-script-parser.js';

const logger = createLogger('workflow-watcher');

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_DISCOVERY_HOURS = 24;
const PROJECTS_DIR_NAME = '.claude/projects';
const SESSION_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const WF_FILE_RE = /^wf_/; // match prefix only (no fixed-suffix-length assumption)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkflowWatcherOptions {
  readonly storagePath?: string;
  readonly projectsDir?: string;
  readonly pollIntervalMs?: number;
  readonly discoveryHours?: number;
  readonly parentSessionId?: string;
  /**
   * Hook so the watcher can inflate `total_usd` from the existing
   * CostTracker without dragging the tracker into this module.
   */
  readonly getCostForRun?: (runId: string) => number;
  /**
   * Hook so the watcher can read sum-of-subagent-tokens for token
   * reconciliation. Returns 0 if no rows attribute to this run yet.
   */
  readonly getSubagentTokenSumForRun?: (runId: string) => number;
}

interface DiscoveredWorkflowFile {
  readonly path: string;
  readonly parentSessionId: string;
  readonly runId: string;
}

interface WorkflowJsonShape {
  readonly runId?: string;
  readonly taskId?: string | null;
  readonly workflowName?: string;
  readonly status?: string;
  readonly startTime?: number;
  readonly durationMs?: number | null;
  readonly defaultModel?: string;
  readonly agentCount?: number;
  readonly totalTokens?: number;
  readonly scriptPath?: string;
  readonly workflowProgress?: ReadonlyArray<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// WorkflowWatcher
// ---------------------------------------------------------------------------

export class WorkflowWatcher {
  private readonly storagePath: string;
  private readonly projectsDir: string;
  private readonly pollIntervalMs: number;
  private readonly discoveryHours: number;
  private readonly parentSessionFilter: string | null;
  private readonly getCostForRun: WorkflowWatcherOptions['getCostForRun'];
  private readonly getSubagentTokenSumForRun: WorkflowWatcherOptions['getSubagentTokenSumForRun'];

  private intervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;

  private readonly seenMtime = new Map<string, number>();
  private readonly emittedRuns = new Set<string>();
  private readonly topologyCache = new Map<string, DeclaredTopology | null>();
  // Paths whose seenMtime entry exists only to guard a one-time
  // discovery_skipped health event (see the cold-scan-skip branch in
  // discoverFiles()) — these never enter the processed `out` set, so
  // evictStale() must never delete them based on currentPaths membership.
  private readonly coldSkipGuards = new Set<string>();

  // Health counters
  private filesWatched = 0;
  private linesRead = 0;
  private bytesRead = 0;
  private parseErrors = 0;
  private schemaDrifts = 0;
  private lastError: { code: string; class: string } | null = null;

  // Callback wires (set after construction to avoid circular imports)
  private onRun: ((run: ScriptWorkflowRunMetrics) => void) | null = null;
  private onHealth: ((event: ObservabilityHealthMetrics) => void) | null = null;

  constructor(options: WorkflowWatcherOptions = {}) {
    this.storagePath = options.storagePath ?? join(homedir(), '.newrelic-preflight');
    this.projectsDir = options.projectsDir ?? join(homedir(), PROJECTS_DIR_NAME);
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const envHours = parseInt(process.env.NR_AI_WATCHER_DISCOVERY_HOURS ?? '', 10);
    this.discoveryHours =
      options.discoveryHours ??
      (Number.isFinite(envHours) && envHours > 0 ? envHours : DEFAULT_DISCOVERY_HOURS);
    this.parentSessionFilter = options.parentSessionId ?? null;
    this.getCostForRun = options.getCostForRun;
    this.getSubagentTokenSumForRun = options.getSubagentTokenSumForRun;
  }

  setOnRun(cb: (run: ScriptWorkflowRunMetrics) => void): void {
    this.onRun = cb;
  }

  setOnHealth(cb: (event: ObservabilityHealthMetrics) => void): void {
    this.onHealth = cb;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    if (!existsSync(this.storagePath)) {
      mkdirSync(this.storagePath, { recursive: true, mode: 0o700 });
    }
    this.intervalId = setInterval(() => this.poll(), this.pollIntervalMs);
    this.intervalId.unref();
    logger.info('WorkflowWatcher started');
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    logger.info('WorkflowWatcher stopped');
  }

  poll(): void {
    try {
      const files = this.discoverFiles();
      this.filesWatched = files.length;
      const currentPaths = new Set<string>();
      const currentRunIds = new Set<string>();
      for (const file of files) {
        currentPaths.add(file.path);
        currentRunIds.add(file.runId);
        let st;
        try {
          st = statSync(file.path);
        } catch {
          continue;
        }
        const prev = this.seenMtime.get(file.path);
        if (prev !== undefined && st.mtimeMs === prev) continue;
        this.seenMtime.set(file.path, st.mtimeMs);
        this.processFile(file, st.mtimeMs);
      }
      this.evictStale(currentPaths, currentRunIds);
    } catch (err) {
      this.recordError(err);
    }
  }

  // -------------------------------------------------------------------------
  // Eviction
  // -------------------------------------------------------------------------

  // Drops bookkeeping for paths/runs no longer present in the current
  // discovered set, mirroring SubagentWatcher.evictStalePartials() — without
  // this, seenMtime/emittedRuns/topologyCache grow for the process lifetime in
  // a long-lived --local dashboard, scaling with total historical run count
  // rather than active run count. topologyCache is keyed by the
  // content-derived runId, which can (rarely) differ from file.runId — an
  // over-eager evict there just forces a cache-miss recompute next access,
  // never a correctness issue. seenMtime entries in coldSkipGuards are
  // exempt from currentPaths-based eviction — they belong to files that
  // never enter the processed `out` set (see discoverFiles()), so they'd
  // otherwise be deleted and re-added every poll, re-emitting the
  // discovery_skipped health event indefinitely instead of just once.
  private evictStale(currentPaths: ReadonlySet<string>, currentRunIds: ReadonlySet<string>): void {
    for (const path of this.seenMtime.keys()) {
      if (!currentPaths.has(path) && !this.coldSkipGuards.has(path)) this.seenMtime.delete(path);
    }
    for (const runId of this.emittedRuns) {
      if (!currentRunIds.has(runId)) this.emittedRuns.delete(runId);
    }
    for (const runId of this.topologyCache.keys()) {
      if (!currentRunIds.has(runId)) this.topologyCache.delete(runId);
    }
  }

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  private discoverFiles(): DiscoveredWorkflowFile[] {
    const out: DiscoveredWorkflowFile[] = [];
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
      let st;
      try {
        st = statSync(projectPath);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;

      // When a parent session filter is set (the common case for a
      // per-session --stdio server instance), skip listing every sibling
      // session in this project — go straight to the one directory we care
      // about. Falls back to the full listing only when no filter is set
      // (e.g. --local, which watches every session).
      const sessionEntries: string[] = this.parentSessionFilter
        ? [this.parentSessionFilter]
        : (() => {
            try {
              return readdirSync(projectPath);
            } catch {
              return [];
            }
          })();
      for (const sessionId of sessionEntries) {
        if (!SESSION_ID_RE.test(sessionId)) continue;
        if (this.parentSessionFilter && sessionId !== this.parentSessionFilter) continue;
        const wfDir = join(projectPath, sessionId, 'workflows');
        if (!existsSync(wfDir)) continue;
        let wfEntries: string[];
        try {
          wfEntries = readdirSync(wfDir);
        } catch {
          continue;
        }
        for (const name of wfEntries) {
          if (!WF_FILE_RE.test(name) || !name.endsWith('.json')) continue;
          const path = join(wfDir, name);
          let fst;
          try {
            fst = statSync(path);
          } catch {
            continue;
          }
          if (fst.mtimeMs < cutoffMs && !this.emittedRuns.has(name.slice(0, -'.json'.length))) {
            // Skip cold-scan of files older than the discovery budget. The
            // first time we encounter such a file we emit a discovery_skipped
            // health event so the operator can tell why a known run is absent
            // from the dashboard. This path is never pushed to `out`, so it
            // never counts toward filesWatched/currentPaths — coldSkipGuards
            // records it separately so evictStale() knows to spare its
            // seenMtime entry (see the comment there).
            if (!this.seenMtime.has(path)) {
              this.seenMtime.set(path, fst.mtimeMs);
              this.coldSkipGuards.add(path);
              this.emitHealth({ event: 'discovery_skipped' });
            }
            continue;
          }
          out.push({ path, parentSessionId: sessionId, runId: name.slice(0, -'.json'.length) });
        }
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Per-file processing
  // -------------------------------------------------------------------------

  private processFile(file: DiscoveredWorkflowFile, mtimeMs: number): void {
    let raw: string;
    try {
      raw = readFileSync(file.path, 'utf-8');
    } catch (err) {
      this.recordError(err);
      return;
    }
    this.bytesRead += raw.length;
    let parsed: WorkflowJsonShape;
    try {
      parsed = JSON.parse(raw) as WorkflowJsonShape;
    } catch {
      // Partial-write protection: re-stat and only count as parse error
      // if mtime is stable.
      try {
        const st2 = statSync(file.path);
        if (st2.mtimeMs !== mtimeMs) return;
      } catch {
        return;
      }
      this.parseErrors += 1;
      logger.warn('JSON parse error on workflow file', { path: file.path });
      return;
    }

    const runId = typeof parsed.runId === 'string' ? parsed.runId : file.runId;
    const startTime = typeof parsed.startTime === 'number' ? parsed.startTime : 0;
    const durationMs = typeof parsed.durationMs === 'number' ? parsed.durationMs : 0;
    const status = typeof parsed.status === 'string' ? parsed.status : 'unknown';
    const incomplete = status !== 'completed';
    const wfName = typeof parsed.workflowName === 'string' ? parsed.workflowName : 'unknown';
    const defaultModel = typeof parsed.defaultModel === 'string' ? parsed.defaultModel : 'unknown';
    const agentCount = typeof parsed.agentCount === 'number' ? parsed.agentCount : 0;
    const totalTokensRollup =
      typeof parsed.totalTokens === 'number' && parsed.totalTokens >= 0 ? parsed.totalTokens : 0;
    const taskId =
      parsed.taskId === null || typeof parsed.taskId === 'string' ? parsed.taskId : null;

    // Observed phases = unique phaseTitle values across workflow_agent entries
    let observedPhases = 0;
    const wp = Array.isArray(parsed.workflowProgress) ? parsed.workflowProgress : [];
    const seenPhaseTitles = new Set<string>();
    for (const entry of wp) {
      if (entry && typeof entry === 'object') {
        const t = (entry as Record<string, unknown>).type;
        const title = (entry as Record<string, unknown>).phaseTitle;
        if (t === 'workflow_agent' && typeof title === 'string') {
          seenPhaseTitles.add(title);
        }
      }
    }
    observedPhases = seenPhaseTitles.size;

    // Static topology from script
    let topology = this.topologyCache.get(runId);
    if (topology === undefined) {
      let scriptPath = typeof parsed.scriptPath === 'string' ? parsed.scriptPath : null;
      if (!scriptPath) {
        // Fallback heuristic: the script lives in the sibling `scripts/`
        // directory under the same workflows dir.
        const wfDir = dirname(file.path);
        const scriptsDir = join(wfDir, 'scripts');
        if (existsSync(scriptsDir)) {
          try {
            for (const name of readdirSync(scriptsDir)) {
              if (name.endsWith(`-${runId}.js`)) {
                scriptPath = join(scriptsDir, name);
                break;
              }
            }
          } catch {
            /* skip */
          }
        }
      }
      // Security: `parsed.scriptPath` is read verbatim from an untrusted
      // on-disk wf_*.json. Before reading it, require the resolved path to
      // stay under `projectsDir` (no traversal to /etc/passwd, ~/.ssh, or a
      // sibling agent-*.meta.json prompt), and cap the read size. A path that
      // escapes containment or exceeds the cap is treated as parser_skip.
      //
      // path.relative() + this escape check is the containment pattern
      // CodeQL recognises as a path-injection sanitizer (see
      // static-handler.ts's identical comment). It must stay inlined here,
      // not delegated to a helper function — extracting it breaks CodeQL's
      // recognition of the sanitizer even for a trivial wrapper, and a
      // startsWith(root + '/') check (the previous approach) never covers
      // Windows since resolve() there yields backslash-separated paths.
      const SCRIPT_MAX_BYTES = 262_144; // 256 KiB
      let scriptOk = false;
      if (scriptPath && existsSync(scriptPath)) {
        const root = resolve(this.projectsDir);
        const resolved = resolve(scriptPath);
        const rel = relative(root, resolved);
        const contained = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
        if (contained) {
          try {
            scriptOk = statSync(resolved).size <= SCRIPT_MAX_BYTES;
          } catch {
            scriptOk = false;
          }
          if (scriptOk) scriptPath = resolved;
        }
        if (!scriptOk) {
          this.emitHealth({ event: 'parser_skip' });
        }
      }
      if (scriptOk && scriptPath) {
        const result = parseWorkflowScript(scriptPath);
        if (result.status === 'ok') {
          topology = result.topology;
        } else {
          topology = null;
          this.emitHealth({ event: 'parser_skip' });
        }
      } else {
        topology = null;
      }
      this.topologyCache.set(runId, topology);
    }

    // Token reconciliation delta. `null` (not 0) when no subagent data has
    // been collected yet for this run — otherwise every newly-discovered run
    // would show a false "100% gap" (subagentSum === 0 is indistinguishable
    // from "not collected yet" if we let it flow into the ratio below).
    const subagentSum = this.getSubagentTokenSumForRun?.(runId) ?? 0;
    const totalTokens = subagentSum > 0 ? subagentSum : totalTokensRollup;
    const tokenReconciliationDelta =
      subagentSum > 0 && totalTokensRollup > 0
        ? (totalTokensRollup - subagentSum) / totalTokensRollup
        : null;

    // Cost (if available)
    const usd = this.getCostForRun?.(runId) ?? 0;
    const totalUsd = usd > 0 ? usd : null;

    const declaredParallelWidthsJson = topology
      ? JSON.stringify(topology.declaredParallelWidths)
      : '[]';

    const metrics: ScriptWorkflowRunMetrics = {
      workflow_run_id: runId,
      parent_session_id: file.parentSessionId,
      task_id: taskId ?? null,
      workflow_name: topology?.workflowName ?? wfName,
      status,
      default_model: defaultModel,
      started_at: startTime,
      duration_ms: durationMs,
      agent_count: agentCount,
      total_tokens: totalTokens,
      total_usd: totalUsd,
      declared_phases: topology ? topology.declaredPhases : null,
      observed_phases: observedPhases,
      declared_parallel_widths: declaredParallelWidthsJson,
      token_reconciliation_delta: tokenReconciliationDelta,
      incomplete,
      backfilled: false,
    };

    if (this.onRun) {
      try {
        this.onRun(metrics);
      } catch (err) {
        this.recordError(err);
      }
    }
    // Keyed on file.runId (filename stem), matching exactly what
    // discoverFiles()'s old-file cutoff guard checks — NOT the
    // content-derived `runId` above, which can differ from the filename
    // stem (rename, copy, older tool version) and would otherwise let that
    // guard silently never fire for this file.
    if (!this.emittedRuns.has(file.runId)) {
      this.emittedRuns.add(file.runId);
      this.emitHealth({ event: 'discovered_workflow', workflow_run_id: runId });
    }
  }

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  private emitHealth(extra: Partial<ObservabilityHealthMetrics> = {}): void {
    if (!this.onHealth) return;
    try {
      this.onHealth({
        timestamp: Date.now(),
        watcher: 'workflow',
        files_watched: this.filesWatched,
        lines_read: this.linesRead,
        bytes_read: this.bytesRead,
        parse_errors: this.parseErrors,
        schema_drifts: this.schemaDrifts,
        last_error: this.lastError,
        ...extra,
      });
    } catch (err) {
      this.recordError(err);
    }
  }

  private recordError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string }).code ?? 'UNKNOWN';
    const cls = err instanceof Error ? err.constructor.name : 'Error';
    this.lastError = { code: String(code).slice(0, 80), class: String(cls).slice(0, 80) };
    logger.warn('WorkflowWatcher error', { code, message: message.slice(0, 200) });
  }
}
