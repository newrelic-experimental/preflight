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
 * For agent_tool runs, tool_call_count and child_agent_count count the calls
 * whose hook `agentId` is the subagent the Agent call spawned
 * (`spawnedAgentId`). A foreground subagent's calls are recorded before its
 * Agent call returns, so they are counted as they arrive and claimed when the
 * Agent record closes the run. A background Agent call returns at launch, so
 * its run counts only the calls that finished before that, usually none.
 */

import { createLogger } from '../shared/index.js';
import { BoundedMap } from '../lib/bounded-map.js';
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
  /** Hard cap on subagents whose calls are counted while their Agent call is open. */
  readonly maxPendingSubagents?: number;
  /** Hard cap on drainable completed runs awaiting consumption. */
  readonly maxCompletedRuns?: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_DESCRIPTION_MAX_LENGTH = 256;
const DEFAULT_MAX_PENDING_SUBAGENTS = 256;
const DEFAULT_MAX_COMPLETED_RUNS = 1024;
const DEFAULT_MAX_COUNTED_AGENT_CALLS = 1024;

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

interface ChildCounts {
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
  private readonly maxCompletedRuns: number;

  /** Calls made by each subagent whose spawning Agent call has not been recorded yet. */
  private readonly pendingChildCounts: BoundedMap<string, ChildCounts>;

  /**
   * toolUseIds of Agent calls already counted toward their parent's
   * child_agent_count. A call that outlives the processor's orphan TTL arrives
   * twice (timeout record, then the late result), and counts once.
   */
  private readonly countedAgentCalls = new BoundedMap<string, true>({
    maxEntries: DEFAULT_MAX_COUNTED_AGENT_CALLS,
  });

  /** Completed (drainable) runs in arrival order. */
  private readonly completed: MutableRun[] = [];

  constructor(options?: WorkflowRunTrackerOptions) {
    this.descriptionMaxLength = options?.descriptionMaxLength ?? DEFAULT_DESCRIPTION_MAX_LENGTH;
    this.maxCompletedRuns = options?.maxCompletedRuns ?? DEFAULT_MAX_COMPLETED_RUNS;
    this.pendingChildCounts = new BoundedMap({
      maxEntries: options?.maxPendingSubagents ?? DEFAULT_MAX_PENDING_SUBAGENTS,
    });
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
    this.countChildCall(record, 'tool_call_count');
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

    if (!this.countedAgentCalls.has(workflowRunId)) {
      this.countedAgentCalls.set(workflowRunId, true);
      this.countChildCall(record, 'child_agent_count');
    }
    const spawnedAgentId = readString(record, 'spawnedAgentId');
    const children = this.pendingChildCounts.get(spawnedAgentId);
    this.pendingChildCounts.delete(spawnedAgentId);

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
      started_at: record.timestamp,
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
      tool_call_count: children?.tool_call_count ?? 0,
      child_agent_count: children?.child_agent_count ?? 0,
    };

    this.pushCompleted(run);
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
   * Snapshot of the completed-but-not-drained runs, primarily for tests and
   * MCP tool inspection. Does not clear the buffer.
   */
  getMetrics(): readonly WorkflowRunMetrics[] {
    return this.completed.map(freezeRun);
  }

  /**
   * Clears all state for a new session. The sessionId parameter is accepted
   * for interface consistency with other trackers.
   */
  reset(_sessionId: string): void {
    this.pendingChildCounts.clear();
    this.countedAgentCalls.clear();
    this.completed.length = 0;
  }

  // ---------------------------------------------------------------------------
  // Private — child attribution (agent_tool source only)
  // ---------------------------------------------------------------------------

  private countChildCall(record: ToolCallRecord, field: keyof ChildCounts): void {
    const agentId = readString(record, 'agentId');
    if (agentId.length === 0) return;
    const counts = this.pendingChildCounts.get(agentId) ?? {
      tool_call_count: 0,
      child_agent_count: 0,
    };
    counts[field] += 1;
    this.pendingChildCounts.set(agentId, counts);
  }

  private pushCompleted(run: MutableRun): void {
    this.completed.push(run);
    if (this.completed.length > this.maxCompletedRuns) {
      // Drop the oldest to keep memory bounded; consumers drain in arrival order.
      this.completed.shift();
    }
  }
}
