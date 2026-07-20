/**
 * WorkflowRunTracker — captures one record per detected workflow run.
 *
 * Two input sources (identifier-space discriminator):
 *   1. run_source: 'agent_tool' — from PreToolUse/PostToolUse hook pairs on
 *      the 'Agent' tool.  workflow_run_id = toolUseId (toolu_*).
 *      Entry points: recordAgentToolCall(record) or recordToolCall(record).
 *
 *   2. run_source: 'script' — from wf_*.json WorkflowWatcher events.
 *      workflow_run_id = wf_<hex>-<hex>.
 *      Entry point: recordScriptRun(event).
 *
 * For agent_tool runs, non-Agent tool calls that fall within a run's
 * [started_at, started_at + duration_ms] window are attributed to it via
 * tool_call_count and child_agent_count heuristics (best-effort, because hook
 * payloads do not distinguish inner-subagent calls from parent calls).
 */

import { createLogger } from '../shared/index.js';
import type { ToolCallRecord } from '../storage/types.js';
import type { Resettable } from './tracker-contracts.js';

const logger = createLogger('workflow-run-tracker');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WorkflowRunStatus = 'completed' | 'errored' | 'in_progress';

/** Event shape produced by the WorkflowWatcher from wf_*.json files. */
export interface WorkflowRunEvent {
  readonly mode: 'workflow_run';
  readonly timestamp: number;
  readonly workflowRunId: string;
  readonly status: string;
  readonly durationMs: number | null;
  readonly totalTokens: number;
  readonly agentCount: number;
  readonly workflowName: string;
  readonly phases: readonly string[];
  readonly workflowProgress: ReadonlyArray<{
    readonly type?: string;
    readonly state?: string;
    readonly agentId?: string;
  }>;
  readonly parentSessionId: string;
}

/**
 * One row per completed workflow run.
 *
 * Fields marked "agent_tool only" are null when run_source === 'script'.
 * Fields marked "script only" are null/0 when run_source === 'agent_tool'.
 */
export interface WorkflowRunMetrics {
  readonly workflow_run_id: string;
  readonly run_source: 'agent_tool' | 'script';
  readonly session_id: string;
  readonly workflow_name: string;
  readonly status: string;
  readonly started_at: number;
  readonly duration_ms: number;
  readonly agent_count: number;
  readonly total_tokens: number;
  readonly declared_phases: number | null;
  readonly observed_phases: number;
  readonly incomplete: boolean;
  // agent_tool-only fields (null when run_source === 'script'):
  readonly subagent_type: string | null;
  readonly agent_name: string | null;
  readonly agent_model: string | null;
  readonly agent_description: string | null;
  readonly run_in_background: boolean | null;
  readonly exit_error: string | null;
  // attribution heuristics (agent_tool only; 0 for script):
  readonly tool_call_count: number;
  readonly child_agent_count: number;
}

export interface WorkflowRunTrackerOptions {
  /** Max characters of agent_description retained on the metrics row. */
  readonly descriptionMaxLength?: number;
  /** Hard cap on simultaneously-tracked open runs to prevent unbounded growth. */
  readonly maxOpenRuns?: number;
  /** Hard cap on drainable completed runs awaiting consumption. */
  readonly maxCompletedRuns?: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_DESCRIPTION_MAX_LENGTH = 256;
const DEFAULT_MAX_OPEN_RUNS = 256;
const DEFAULT_MAX_COMPLETED_RUNS = 1024;

/** Statuses from script runs that indicate the run did not finish cleanly. */
const INCOMPLETE_STATUSES = new Set(['killed', 'progress']);

// ---------------------------------------------------------------------------
// Internal mutable state
// ---------------------------------------------------------------------------

interface MutableRun {
  workflow_run_id: string;
  run_source: 'agent_tool' | 'script';
  session_id: string;
  workflow_name: string;
  status: string;
  started_at: number;
  duration_ms: number;
  agent_count: number;
  total_tokens: number;
  declared_phases: number | null;
  observed_phases: number;
  incomplete: boolean;
  subagent_type: string | null;
  agent_name: string | null;
  agent_model: string | null;
  agent_description: string | null;
  run_in_background: boolean | null;
  exit_error: string | null;
  tool_call_count: number;
  child_agent_count: number;
}

function freezeRun(run: MutableRun): WorkflowRunMetrics {
  return {
    workflow_run_id: run.workflow_run_id,
    run_source: run.run_source,
    session_id: run.session_id,
    workflow_name: run.workflow_name,
    status: run.status,
    started_at: run.started_at,
    duration_ms: run.duration_ms,
    agent_count: run.agent_count,
    total_tokens: run.total_tokens,
    declared_phases: run.declared_phases,
    observed_phases: run.observed_phases,
    incomplete: run.incomplete,
    subagent_type: run.subagent_type,
    agent_name: run.agent_name,
    agent_model: run.agent_model,
    agent_description: run.agent_description,
    run_in_background: run.run_in_background,
    exit_error: run.exit_error,
    tool_call_count: run.tool_call_count,
    child_agent_count: run.child_agent_count,
  };
}

function readString(record: ToolCallRecord, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

function readBoolean(record: ToolCallRecord, key: string): boolean {
  const value = record[key];
  return typeof value === 'boolean' ? value : false;
}

// ---------------------------------------------------------------------------
// WorkflowRunTracker
// ---------------------------------------------------------------------------

export class WorkflowRunTracker implements Resettable {
  private readonly descriptionMaxLength: number;
  private readonly maxOpenRuns: number;
  private readonly maxCompletedRuns: number;

  /** Open runs keyed by workflow_run_id. Insertion order = arrival order. */
  private readonly openRuns = new Map<string, MutableRun>();

  /** Completed (drainable) runs in arrival order. */
  private readonly completed: MutableRun[] = [];

  constructor(options?: WorkflowRunTrackerOptions) {
    this.descriptionMaxLength = options?.descriptionMaxLength ?? DEFAULT_DESCRIPTION_MAX_LENGTH;
    this.maxOpenRuns = options?.maxOpenRuns ?? DEFAULT_MAX_OPEN_RUNS;
    this.maxCompletedRuns = options?.maxCompletedRuns ?? DEFAULT_MAX_COMPLETED_RUNS;
  }

  // ---------------------------------------------------------------------------
  // Input: Agent tool hook pairs
  // ---------------------------------------------------------------------------

  /**
   * Record a ToolCallRecord from the hook event processor.
   * Only Agent tool calls are recorded as workflow runs; other tool calls are
   * attributed to the enclosing run as child calls.
   *
   * Kept for backward compatibility — delegates to recordAgentToolCall or
   * the attribution heuristic as appropriate.
   */
  recordToolCall(record: ToolCallRecord): void {
    if (record.toolName === 'Agent') {
      this.recordAgentToolCall(record);
      return;
    }
    this.attributeChildToolCall(record);
  }

  /**
   * Record a completed Agent tool call hook pair.
   * Only processes records where toolName === 'Agent'.
   */
  recordAgentToolCall(record: ToolCallRecord): void {
    if (record.toolName !== 'Agent') return;

    const workflowRunId = record.toolUseId;
    if (typeof workflowRunId !== 'string' || workflowRunId.length === 0) {
      logger.warn('agent_record_missing_tool_use_id', { recordId: record.id });
      return;
    }

    const description = readString(record, 'agentDescription').slice(0, this.descriptionMaxLength);
    const sessionId = record.sessionId ?? '';
    const durationMs = record.durationMs ?? 0;
    const startedAt = record.timestamp - durationMs;

    // Attribute this Agent call as a child of an enclosing parent run, if any.
    // Done before opening the new run so we don't accidentally count a run as
    // its own child when started_at == enclosing.started_at.
    this.incrementParentChildAgentCount(sessionId, startedAt);

    const status = record.success ? 'completed' : 'errored';
    const exitError = !record.success && typeof record.error === 'string' ? record.error : null;

    const agentName = readString(record, 'agentName');
    const workflowName = agentName.length > 0 ? agentName : 'agent_tool';

    const run: MutableRun = {
      workflow_run_id: workflowRunId,
      run_source: 'agent_tool',
      session_id: sessionId,
      workflow_name: workflowName,
      status,
      started_at: startedAt,
      duration_ms: durationMs,
      agent_count: 1,
      total_tokens: 0,
      declared_phases: null,
      observed_phases: 0,
      incomplete: status === 'errored',
      subagent_type: readString(record, 'subagentType') || null,
      agent_name: agentName || null,
      agent_model: readString(record, 'agentModel') || null,
      agent_description: description || null,
      run_in_background: readBoolean(record, 'runInBackground'),
      exit_error: exitError,
      tool_call_count: 0,
      child_agent_count: 0,
    };

    // ToolCallRecord is only emitted post-pair, so we move directly to
    // completed for draining/NR emission. We ALSO keep the same run object in
    // openRuns (rather than deleting it) so attributeChildToolCall() can still
    // find it via findEnclosingRun() for child tool calls that arrive after
    // this run is drained — e.g. a run_in_background agent whose own Agent
    // call completes (and gets drained) before its background work finishes
    // emitting further tool-call records. enforceOpenRunsCap() bounds growth.
    this.pushCompleted(run);
    this.openRuns.set(workflowRunId, run);
    this.enforceOpenRunsCap();
  }

  // ---------------------------------------------------------------------------
  // Input: WorkflowWatcher script events
  // ---------------------------------------------------------------------------

  /**
   * Record a workflow run event from a wf_*.json WorkflowWatcher file.
   *
   * NOTE: currently unused in production wiring. `src/index.ts` feeds only
   * `run_source='agent_tool'` runs into the tracker (via `onWorkflowAgent` →
   * `recordToolCall`); script workflow runs are surfaced to the dashboard by
   * WorkflowStore reading wf_*.json directly, not through this tracker. This
   * method is retained (and covered by tests) for a future buffer path that
   * routes WorkflowWatcher events through the processor — do not delete.
   */
  recordScriptRun(event: WorkflowRunEvent): void {
    const incomplete = INCOMPLETE_STATUSES.has(event.status);

    // declared_phases: non-empty phases array → count, otherwise null
    const declaredPhases = event.phases.length > 0 ? event.phases.length : null;

    // observed_phases: count distinct `type` values seen in workflowProgress
    const observedPhases = new Set(
      event.workflowProgress.map((p) => p.type).filter((t): t is string => t !== undefined),
    ).size;

    const durationMs = event.durationMs ?? 0;

    const run: MutableRun = {
      workflow_run_id: event.workflowRunId,
      run_source: 'script',
      session_id: event.parentSessionId,
      workflow_name: event.workflowName,
      status: event.status,
      started_at: event.timestamp - durationMs,
      duration_ms: durationMs,
      agent_count: event.agentCount,
      total_tokens: event.totalTokens,
      declared_phases: declaredPhases,
      observed_phases: observedPhases,
      incomplete,
      subagent_type: null,
      agent_name: null,
      agent_model: null,
      agent_description: null,
      run_in_background: null,
      exit_error: null,
      tool_call_count: 0,
      child_agent_count: 0,
    };

    logger.debug('script run recorded', {
      workflow_run_id: run.workflow_run_id,
      status: run.status,
    });
    this.pushCompleted(run);
  }

  // ---------------------------------------------------------------------------
  // Output
  // ---------------------------------------------------------------------------

  /**
   * Returns and clears all completed (drainable) runs in arrival order.
   * Open (in-progress) runs are not returned.
   * Each run is returned exactly once.
   */
  drainCompleted(): WorkflowRunMetrics[] {
    if (this.completed.length === 0) return [];
    const out = this.completed.map(freezeRun);
    this.completed.length = 0;
    return out;
  }

  /**
   * Snapshot of all currently-tracked runs (open + completed-but-not-drained),
   * primarily for tests and MCP tool inspection. Does not clear the buffer.
   *
   * A completed agent_tool run is kept in BOTH `openRuns` (for attribution
   * lookups by late-arriving child tool calls) and `completed` (until
   * drained) — dedupe by workflow_run_id so it isn't double-counted here.
   */
  getMetrics(): readonly WorkflowRunMetrics[] {
    const seen = new Set<string>();
    const snapshot: WorkflowRunMetrics[] = [];
    for (const run of this.openRuns.values()) {
      seen.add(run.workflow_run_id);
      snapshot.push(freezeRun(run));
    }
    for (const run of this.completed) {
      if (seen.has(run.workflow_run_id)) continue;
      snapshot.push(freezeRun(run));
    }
    return snapshot;
  }

  /**
   * Clears all state for a new session. The sessionId parameter is accepted
   * for interface consistency with other trackers.
   */
  reset(_sessionId: string): void {
    this.openRuns.clear();
    this.completed.length = 0;
  }

  // ---------------------------------------------------------------------------
  // Private — attribution heuristics (agent_tool source only)
  // ---------------------------------------------------------------------------

  private attributeChildToolCall(record: ToolCallRecord): void {
    const sessionId = record.sessionId ?? '';
    const target = this.findEnclosingRun(sessionId, record.timestamp);
    if (target) target.tool_call_count += 1;
  }

  private incrementParentChildAgentCount(sessionId: string, timestamp: number): void {
    const target = this.findEnclosingRun(sessionId, timestamp);
    if (target) target.child_agent_count += 1;
  }

  /**
   * Find the most-recently-started run in the same session whose
   * [started_at, started_at + duration_ms] window encloses `timestamp`.
   * Returns null (no attribution) when no run's window encloses it — this is
   * a strict window check, not a nearest-run fallback.
   */
  private findEnclosingRun(sessionId: string, timestamp: number): MutableRun | null {
    let best: MutableRun | null = null;
    let bestStart = -Infinity;

    const consider = (run: MutableRun): void => {
      if (run.session_id !== sessionId) return;
      const end = run.started_at + run.duration_ms;
      if (timestamp < run.started_at) return;
      if (timestamp > end) return;
      if (run.started_at > bestStart) {
        best = run;
        bestStart = run.started_at;
      }
    };

    for (const run of this.openRuns.values()) consider(run);
    for (const run of this.completed) consider(run);
    return best;
  }

  private pushCompleted(run: MutableRun): void {
    this.completed.push(run);
    if (this.completed.length > this.maxCompletedRuns) {
      // Drop the oldest to keep memory bounded; consumers drain in arrival order.
      this.completed.shift();
    }
  }

  private enforceOpenRunsCap(): void {
    if (this.openRuns.size <= this.maxOpenRuns) return;
    const overflow = this.openRuns.size - this.maxOpenRuns;
    const it = this.openRuns.keys();
    for (let i = 0; i < overflow; i++) {
      const next = it.next();
      if (next.done === true) break;
      this.openRuns.delete(next.value);
    }
  }
}
