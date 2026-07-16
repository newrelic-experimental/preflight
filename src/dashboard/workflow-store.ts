/**
 * WorkflowStore — read-only filesystem reader for the dashboard's
 * `/api/workflows` endpoints.
 *
 * Walks `~/.claude/projects/<slug>/<sessionId>/workflows/wf_*.json` and turns
 * each rollup into a `ScriptWorkflowRunRow` matching the wire shape on
 * `AiWorkflowRun` (run_source='script'). The watcher running in
 * `--stdio` mode emits the same data to NR; this reader is the local-side
 * mirror so the dashboard works offline.
 *
 * Cheap by construction: stat-then-read with a 24h cutoff and an in-memory
 * mtime cache. Doesn't load script files (script parsing happens in the
 * watcher and is shipped as part of the NR event; the dashboard reads the
 * declared topology back via NR / live SSE).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { createLogger } from '../shared/index.js';
import { redactSensitive } from '../config.js';
import { parseWorkflowScript, type DeclaredTopology } from '../hooks/workflow-script-parser.js';

const logger = createLogger('workflow-store');

const SESSION_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const PROJECTS_DIR_NAME = '.claude/projects';
// Mirrors SubagentTimelineStore's MAX_AGENTS_PER_SESSION bound — without
// this, GET /api/workflows?since=0 walks and returns every wf_*.json ever
// written across all projects/sessions with no upper bound.
const MAX_RUNS = 500;

export interface WorkflowRunRow {
  readonly workflow_run_id: string;
  readonly parent_session_id: string;
  readonly task_id: string | null;
  readonly workflow_name: string;
  readonly status: string;
  readonly incomplete: boolean;
  readonly error_reason: string | null;
  readonly default_model: string;
  readonly started_at: number;
  readonly duration_ms: number;
  readonly agent_count: number;
  readonly total_tokens: number;
  readonly total_usd: number | null;
  readonly declared_phases: number | null;
  readonly observed_phases: number;
  readonly declared_parallel_widths: Array<number | 'dynamic'>;
  /**
   * `null` — WorkflowStore has no access to the subagent token sum (that
   * requires the live SubagentWatcher's in-memory state, only available
   * from the --stdio process), so it can't compute this delta at all. This
   * distinguishes "not computed" from a genuine 0% delta.
   */
  readonly token_reconciliation_delta: number | null;
  readonly run_source: 'script' | 'agent_tool';
  readonly script_path: string | null;
  readonly workflow_json_path: string;
  readonly agents?: WorkflowAgentRow[];
  readonly topology?: DeclaredTopology | null;
}

export interface WorkflowAgentRow {
  readonly agent_id: string;
  readonly label: string;
  readonly phase_index: number;
  readonly phase_title: string;
  readonly model: string;
  readonly state: string;
  readonly attempt: number;
  readonly duration_ms: number | null;
  readonly tokens: number;
  readonly tool_calls: number;
  readonly started_at: number | null;
  // Intentionally NOT included (user content):
  // - prompt_preview / last_tool_summary / result_preview / last_error
  // The dashboard renders pointers, not previews.
}

export interface WorkflowStoreOptions {
  readonly projectsDir?: string;
  readonly windowHours?: number;
  /** Hook so the dashboard can inflate cost from the live cost tracker. */
  readonly getCostForRun?: (runId: string) => number;
}

interface CacheEntry {
  mtimeMs: number;
  row: WorkflowRunRow;
}

export class WorkflowStore {
  private readonly projectsDir: string;
  private readonly windowHours: number;
  private readonly getCostForRun: WorkflowStoreOptions['getCostForRun'];
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: WorkflowStoreOptions = {}) {
    this.projectsDir = options.projectsDir ?? join(homedir(), PROJECTS_DIR_NAME);
    this.windowHours = options.windowHours ?? 24 * 30; // 30 days for dashboard listing
    this.getCostForRun = options.getCostForRun;
  }

  /**
   * List runs that overlap the given window (defaults to 30 days). Optional
   * filtering by status / run_source for the workflow listing UI.
   */
  listRuns(opts?: { since?: number; runSource?: string; status?: string }): WorkflowRunRow[] {
    const cutoffMs =
      opts?.since !== undefined ? opts.since : Date.now() - this.windowHours * 60 * 60 * 1000;
    const out: WorkflowRunRow[] = [];
    if (!existsSync(this.projectsDir)) return out;

    let projectEntries: string[];
    try {
      projectEntries = readdirSync(this.projectsDir);
    } catch (err) {
      logger.warn('Failed to enumerate projects dir', { error: String(err) });
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

      let sessionEntries: string[];
      try {
        sessionEntries = readdirSync(projectPath);
      } catch {
        continue;
      }
      for (const sessionId of sessionEntries) {
        if (!SESSION_ID_RE.test(sessionId)) continue;
        const wfDir = join(projectPath, sessionId, 'workflows');
        if (!existsSync(wfDir)) continue;
        let wfEntries: string[];
        try {
          wfEntries = readdirSync(wfDir);
        } catch {
          continue;
        }
        for (const name of wfEntries) {
          if (!name.startsWith('wf_') || !name.endsWith('.json')) continue;
          const path = join(wfDir, name);
          let fst;
          try {
            fst = statSync(path);
          } catch {
            continue;
          }
          if (fst.mtimeMs < cutoffMs) continue;
          const row = this.readRow(path, sessionId, fst.mtimeMs);
          if (!row) continue;
          if (opts?.runSource && opts.runSource !== 'all' && row.run_source !== opts.runSource) {
            continue;
          }
          if (opts?.status && opts.status !== 'all') {
            if (opts.status === 'complete' && row.incomplete) continue;
            if (opts.status === 'incomplete' && !row.incomplete) continue;
          }
          // Skip the heavy `agents` payload from list views — only the detail
          // view returns it.
          out.push({ ...row, agents: undefined });
        }
      }
    }
    out.sort((a, b) => b.started_at - a.started_at);
    return out.length > MAX_RUNS ? out.slice(0, MAX_RUNS) : out;
  }

  /** Detail view — returns a single run plus its per-agent breakdown. */
  getRun(runId: string): WorkflowRunRow | null {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(runId)) return null;
    if (!existsSync(this.projectsDir)) return null;
    let projectEntries: string[];
    try {
      projectEntries = readdirSync(this.projectsDir);
    } catch {
      return null;
    }
    for (const project of projectEntries) {
      const projectPath = join(this.projectsDir, project);
      try {
        if (!statSync(projectPath).isDirectory()) continue;
      } catch {
        continue;
      }
      let sessionEntries: string[];
      try {
        sessionEntries = readdirSync(projectPath);
      } catch {
        continue;
      }
      for (const sessionId of sessionEntries) {
        if (!SESSION_ID_RE.test(sessionId)) continue;
        const path = join(projectPath, sessionId, 'workflows', `${runId}.json`);
        if (!existsSync(path)) continue;
        let fst;
        try {
          fst = statSync(path);
        } catch {
          continue;
        }
        return this.readRow(path, sessionId, fst.mtimeMs);
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private readRow(path: string, parentSessionId: string, mtimeMs: number): WorkflowRunRow | null {
    const cached = this.cache.get(path);
    if (cached && cached.mtimeMs === mtimeMs) return cached.row;

    let raw: string;
    try {
      raw = readFileSync(path, 'utf-8');
    } catch {
      return null;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }

    const runId = typeof parsed.runId === 'string' ? parsed.runId : '';
    if (!runId) return null;
    const startTime = typeof parsed.startTime === 'number' ? parsed.startTime : 0;
    const durationMs = typeof parsed.durationMs === 'number' ? parsed.durationMs : 0;
    const status = typeof parsed.status === 'string' ? parsed.status : 'unknown';
    const wfName = typeof parsed.workflowName === 'string' ? parsed.workflowName : 'unknown';
    const defaultModel = typeof parsed.defaultModel === 'string' ? parsed.defaultModel : 'unknown';
    const agentCount = typeof parsed.agentCount === 'number' ? parsed.agentCount : 0;
    const totalTokens =
      typeof parsed.totalTokens === 'number' && parsed.totalTokens >= 0 ? parsed.totalTokens : 0;
    const taskId =
      parsed.taskId === null || typeof parsed.taskId === 'string' ? parsed.taskId : null;
    const incomplete = status !== 'completed';

    // Run-level failure reason: only the orchestrator's own top-level
    // `error` diagnostic, reduced to its first message line and redacted. We
    // never surface per-agent errors, prompts, results, or full stack traces.
    const rawError = typeof parsed.error === 'string' ? parsed.error : '';
    let errorReason: string | null = null;
    if (incomplete && rawError) {
      let firstLine = rawError.split('\n')[0] ?? '';
      // Defensive: if a stack frame leaked onto the first line, cut it.
      const frameIdx = firstLine.indexOf('    at ');
      if (frameIdx !== -1) firstLine = firstLine.slice(0, frameIdx);
      firstLine = firstLine.trim();
      if (firstLine) {
        errorReason = redactSensitive(firstLine).slice(0, 200);
      }
    }

    const wp = Array.isArray(parsed.workflowProgress) ? parsed.workflowProgress : [];
    const seenPhaseTitles = new Set<string>();
    const agents: WorkflowAgentRow[] = [];
    for (const entry of wp) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      if (e.type !== 'workflow_agent') continue;
      const title = typeof e.phaseTitle === 'string' ? e.phaseTitle : '';
      if (title) seenPhaseTitles.add(title);
      agents.push({
        agent_id: typeof e.agentId === 'string' ? e.agentId : '',
        label: typeof e.label === 'string' ? e.label : '',
        phase_index: typeof e.phaseIndex === 'number' ? e.phaseIndex : -1,
        phase_title: title,
        model: typeof e.model === 'string' ? e.model : '',
        state: typeof e.state === 'string' ? e.state : 'unknown',
        attempt: typeof e.attempt === 'number' ? e.attempt : 1,
        duration_ms: typeof e.durationMs === 'number' ? e.durationMs : null,
        tokens: typeof e.tokens === 'number' ? e.tokens : 0,
        tool_calls: typeof e.toolCalls === 'number' ? e.toolCalls : 0,
        started_at: typeof e.startedAt === 'number' ? e.startedAt : null,
      });
    }
    const observedPhases = seenPhaseTitles.size;

    // Topology from script (best-effort)
    let scriptPath = typeof parsed.scriptPath === 'string' ? parsed.scriptPath : null;
    if (!scriptPath) {
      const wfDir = dirname(path);
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
    // Security: `parsed.scriptPath` is read verbatim from an untrusted on-disk
    // wf_*.json. Before reading it, require the resolved path to stay under
    // `projectsDir` (no traversal to /etc/passwd, ~/.ssh, or a sibling
    // agent-*.meta.json prompt), and cap the read size. Mirrors the guard in
    // WorkflowWatcher.processFile().
    //
    // path.relative() + this escape check is the containment pattern CodeQL
    // recognises as a path-injection sanitizer (see static-handler.ts's
    // identical comment). It must stay inlined here, not delegated to a
    // helper function — extracting it breaks CodeQL's recognition of the
    // sanitizer even for a trivial wrapper, and a startsWith(root + '/')
    // check (the previous approach) never covers Windows since resolve()
    // there yields backslash-separated paths.
    const SCRIPT_MAX_BYTES = 262_144; // 256 KiB
    let topology: DeclaredTopology | null = null;
    if (scriptPath && existsSync(scriptPath)) {
      const root = resolve(this.projectsDir);
      const resolved = resolve(scriptPath);
      const rel = relative(root, resolved);
      const contained = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
      const scriptOk =
        contained &&
        (() => {
          try {
            return statSync(resolved).size <= SCRIPT_MAX_BYTES;
          } catch {
            return false;
          }
        })();
      if (scriptOk) {
        const result = parseWorkflowScript(resolved);
        if (result.status === 'ok') topology = result.topology;
      }
    }

    const usd = this.getCostForRun?.(runId) ?? 0;
    const totalUsd = usd > 0 ? usd : null;

    const row: WorkflowRunRow = {
      workflow_run_id: runId,
      parent_session_id: parentSessionId,
      task_id: taskId ?? null,
      workflow_name: topology?.workflowName ?? wfName,
      status,
      incomplete,
      error_reason: errorReason,
      default_model: defaultModel,
      started_at: startTime,
      duration_ms: durationMs,
      agent_count: agentCount,
      total_tokens: totalTokens,
      total_usd: totalUsd,
      declared_phases: topology?.declaredPhases ?? null,
      observed_phases: observedPhases,
      declared_parallel_widths: topology?.declaredParallelWidths
        ? Array.from(topology.declaredParallelWidths)
        : [],
      token_reconciliation_delta: null,
      run_source: 'script',
      script_path: scriptPath,
      workflow_json_path: path,
      agents,
      topology,
    };
    this.cache.set(path, { mtimeMs, row });
    return row;
  }
}
