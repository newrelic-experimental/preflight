/**
 * New Relic Event Ingestion — converts ToolCallRecords into NR events and
 * metrics, then ships them via the shared HarvestScheduler.
 */

import type {
  NrEventData,
  NrMetric,
  NrLogEntry,
  TransportOptions,
  TransportResult,
} from '../shared/index.js';
import {
  HarvestScheduler,
  MetricAggregator,
  sendEvents,
  sendMetrics,
  OtlpTransport,
  OtlpEventBridge,
  createLogger,
} from '../shared/index.js';

const logger = createLogger('nr-ingest');
import { redactSensitive } from '../config.js';
import { VERSION } from '../version.js';
import type { ToolCallRecord, SubagentTokenEvent } from '../storage/types.js';
import type { ProxyToolCallRecord, ProxyRequestRecord } from '../proxy/types.js';
import type { AiCodingTask } from '../metrics/task-detector.js';
import type { WorkflowRunMetrics } from '../metrics/workflow-run-tracker.js';
import type { AntiPattern } from '../metrics/anti-patterns.js';
import type { SessionTracker } from '../metrics/session-tracker.js';
import type { CostTracker } from '../metrics/cost-tracker.js';
import type { EfficiencyScorer } from '../metrics/efficiency-score.js';
import type { FeedbackCollector } from '../tools/workflow-tools.js';
import type { BudgetThresholdEvent } from '../metrics/budget-tracker.js';
import type { ContextTurnSnapshot, ToolContextContribution } from '../metrics/context-tracker.js';
import { ProxyMetricsTracker } from '../metrics/proxy-metrics.js';
import {
  AuditTrailManager,
  auditRecordToNrEvent,
  securityAlertToNrEvent,
} from '../security/index.js';
import type { AuditRecord } from '../security/index.js';
import type { TurnCostAttributor } from '../metrics/turn-cost-attributor.js';
import type { LocalStore } from '../storage/index.js';
import { LogIngestManager } from './log-ingest.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SendEventsFn = (
  events: NrEventData[],
  licenseKey: string,
  options: TransportOptions,
) => Promise<TransportResult>;

type SendMetricsFn = (
  metrics: NrMetric[],
  licenseKey: string,
  options: TransportOptions,
) => Promise<TransportResult>;

type SendLogsFn = (
  logs: NrLogEntry[],
  licenseKey: string,
  options: TransportOptions,
) => Promise<TransportResult>;

export interface NrIngestOptions {
  licenseKey: string;
  transportOptions: TransportOptions;
  developer: string;
  appName: string;
  sessionTracker: SessionTracker;
  eventHarvestIntervalMs?: number;
  metricHarvestIntervalMs?: number;
  /** Session ID for audit trail context. */
  sessionId?: string | null;
  /** Trace ID generated at server startup — threaded through all NR events and metrics. */
  sessionTraceId?: string;
  /** LocalStore for persisting audit entries to disk. */
  localStore?: LocalStore;
  /**
   * Optional pre-constructed AuditTrailManager. When provided, NrIngestManager
   * uses it instead of constructing its own — lets the dashboard share the
   * same audit log instance in both `local` and `cloud`/`both` modes.
   */
  auditTrail?: AuditTrailManager;
  /** Override for testing; defaults to the shared sendEvents transport. */
  sendEventsFn?: SendEventsFn;
  /** Override for testing; defaults to the shared sendMetrics transport. */
  sendMetricsFn?: SendMetricsFn;
  /** Harvest interval for NR Logs API delivery. Default: 5000ms. */
  logHarvestIntervalMs?: number;
  /** Override for testing; defaults to the shared sendLogs transport. */
  sendLogsFn?: SendLogsFn;
  /** Cost tracker for emitting ai.cost.* metrics. */
  costTracker?: CostTracker;
  /** Efficiency scorer for emitting ai.efficiency.* metrics. */
  efficiencyScorer?: EfficiencyScorer;
  /** Feedback collector for emitting ai.feedback.count metrics. */
  feedbackCollector?: FeedbackCollector;
  teamId?: string | null;
  projectId?: string | null;
  orgId?: string | null;
  /** OTLP/HTTP endpoint URL. When set, telemetry is also exported via OTLP. */
  otlpEndpoint?: string | null;
  /** Additional HTTP headers for the OTLP exporter. */
  otlpHeaders?: Record<string, string>;
  /** Transport mode: 'nr-events-api', 'otlp', or 'both'. */
  transport?: 'nr-events-api' | 'otlp' | 'both';
  /** Turn cost attributor for enriching AiToolCall events with cost data. */
  turnCostAttributor?: TurnCostAttributor;
}

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

/** Standard ToolCallRecord keys that are handled explicitly. */
const STANDARD_KEYS = new Set([
  'id',
  'sessionId',
  'toolName',
  'toolUseId',
  'timestamp',
  'durationMs',
  'success',
  'errorType',
  'error',
  'inputSizeBytes',
  'outputSizeBytes',
  'inputHash',
  'platform',
]);

/**
 * Tool-specific string fields that may carry secrets (Bash commands, file paths,
 * grep patterns, sub-agent prompts, audit detail strings). Anything in this set
 * is run through redactSensitive() before leaving the process. New fields that
 * could contain user input must be added here — silent passthrough is the
 * default failure mode and it leaks secrets to NR.
 */
const REDACT_FIELD_KEYS = new Set([
  'command',
  'filePath',
  'file_path',
  'pattern',
  'agentDescription',
  'agent_description',
  'detail',
  'cwd',
  'commandDescription',
  'taskSubject',
  'grepPath',
  'globPath',
  'agentTeamName',
]);

/**
 * Convert a ToolCallRecord into a flat NR event object.
 *
 * Standard fields are mapped to snake_case NR attributes; any extra
 * tool-specific fields (string | number | boolean) are included as-is.
 */
export function toolCallToNrEvent(
  record: ToolCallRecord,
  attrs: {
    developer: string;
    appName: string;
    sessionTraceId?: string;
    teamId?: string | null;
    projectId?: string | null;
    orgId?: string | null;
  },
): NrEventData {
  const event: NrEventData = {
    eventType: 'AiToolCall',
    timestamp: record.timestamp,
    tool: record.toolName,
    tool_use_id: record.toolUseId,
    success: record.success,
    developer: attrs.developer,
    app_name: attrs.appName,
  };

  if (attrs.teamId) event.team_id = attrs.teamId;
  if (attrs.projectId) event.project_id = attrs.projectId;
  if (attrs.orgId) event.org_id = attrs.orgId;

  if (attrs.sessionTraceId != null) event.session_id = attrs.sessionTraceId;
  if (record.durationMs != null) event.duration_ms = record.durationMs;
  if (record.errorType != null) event.error_type = record.errorType;
  // Tool error messages occasionally include URLs from failed curl commands
  // and similar — possible to embed an Authorization header or token query
  // string in the message. Same redaction policy as the tool-specific fields.
  if (record.error != null) event.error = redactSensitive(record.error);
  if (record.inputSizeBytes != null) event.input_size_bytes = record.inputSizeBytes;
  if (record.outputSizeBytes != null) event.output_size_bytes = record.outputSizeBytes;
  if (record.inputHash != null) event.input_hash = record.inputHash;

  // Platform attribution — defaults to 'claude-code' for backward compatibility
  event.platform = typeof record.platform === 'string' ? record.platform : 'claude-code';

  // Include tool-specific fields from parsers. String fields known to potentially
  // carry secrets (commands, file paths, grep patterns, sub-agent prompts) are
  // redacted before egress — the auditRecordToNrEvent path already does this for
  // its own egress channel; the AiToolCall path must do the same.
  for (const [key, value] of Object.entries(record)) {
    if (STANDARD_KEYS.has(key)) continue;
    if (typeof value === 'string') {
      event[key] = REDACT_FIELD_KEYS.has(key) ? redactSensitive(value) : value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      event[key] = value;
    }
  }

  return event;
}

/** Type guard for ProxyToolCallRecord (has serverName and upstreamLatencyMs with correct types). */
export function isProxyToolCall(record: ToolCallRecord): record is ProxyToolCallRecord {
  return (
    'serverName' in record &&
    typeof (record as Record<string, unknown>).serverName === 'string' &&
    'upstreamLatencyMs' in record &&
    typeof (record as Record<string, unknown>).upstreamLatencyMs === 'number'
  );
}

/**
 * Convert a ProxyToolCallRecord into an NR event with proxy-specific attributes.
 */
export function proxyToolCallToNrEvent(
  record: ProxyToolCallRecord,
  attrs: {
    developer: string;
    appName: string;
    sessionTraceId?: string;
    teamId?: string | null;
    projectId?: string | null;
    orgId?: string | null;
  },
): NrEventData {
  const event: NrEventData = {
    eventType: 'AiMcpToolCall',
    timestamp: record.timestamp,
    server: record.serverName,
    tool: record.toolName,
    duration_ms: record.durationMs ?? 0,
    upstream_latency_ms: record.upstreamLatencyMs,
    success: record.success,
    developer: attrs.developer,
    app_name: attrs.appName,
  };

  if (attrs.teamId) event.team_id = attrs.teamId;
  if (attrs.projectId) event.project_id = attrs.projectId;
  if (attrs.orgId) event.org_id = attrs.orgId;

  if (attrs.sessionTraceId != null) event.session_id = attrs.sessionTraceId;
  if (record.proxyOverheadMs != null) event.proxy_overhead_ms = record.proxyOverheadMs;
  if (record.errorType != null) event.error_type = record.errorType;
  if (record.inputSizeBytes != null) event.request_size_bytes = record.inputSizeBytes;
  if (record.outputSizeBytes != null) event.response_size_bytes = record.outputSizeBytes;

  return event;
}

/**
 * Convert a ProxyRequestRecord (discovery methods like tools/list) into an NR event.
 */
export function proxyRequestToNrEvent(
  record: ProxyRequestRecord,
  attrs: {
    developer: string;
    appName: string;
    teamId?: string | null;
    projectId?: string | null;
    orgId?: string | null;
  },
): NrEventData {
  const event: NrEventData = {
    eventType: 'AiProxyRequest',
    timestamp: record.timestamp,
    server: record.serverName,
    method: record.method,
    duration_ms: record.durationMs,
    upstream_latency_ms: record.upstreamLatencyMs,
    success: record.success,
    developer: attrs.developer,
    app_name: attrs.appName,
  };

  if (attrs.teamId) event.team_id = attrs.teamId;
  if (attrs.projectId) event.project_id = attrs.projectId;
  if (attrs.orgId) event.org_id = attrs.orgId;

  if (record.proxyOverheadMs != null) event.proxy_overhead_ms = record.proxyOverheadMs;
  if (record.responseSizeBytes != null) event.response_size_bytes = record.responseSizeBytes;

  return event;
}

/**
 * Convert an AiCodingTask into a flat NR event object.
 *
 * All fields use snake_case to match the convention of AiToolCall/AiAuditEvent.
 * File path arrays are emitted as counts to keep event size small.
 */
export function codingTaskToNrEvent(
  task: AiCodingTask,
  attrs: {
    developer: string;
    appName: string;
    sessionTraceId?: string;
    teamId?: string | null;
    projectId?: string | null;
    orgId?: string | null;
  },
): NrEventData {
  const firstRecord = task.toolCalls[0];
  const platform = typeof firstRecord?.platform === 'string' ? firstRecord.platform : 'claude-code';

  const event: NrEventData = {
    eventType: 'AiCodingTask',
    timestamp: task.endTime,
    task_id: task.taskId,
    developer: attrs.developer,
    app_name: attrs.appName,
    platform,
    start_time: task.startTime,
    end_time: task.endTime,
    duration_ms: task.durationMs,
    tool_call_count: task.toolCallCount,
    files_read: task.filesRead.length,
    files_modified: task.filesModified.length,
    lines_added: task.linesAdded,
    lines_removed: task.linesRemoved,
    bash_commands_run: task.bashCommandsRun,
    tests_run: task.testsRun,
    tests_passed: task.testsPassed,
    build_run: task.buildRun,
    build_passed: task.buildPassed,
    estimated_cost_usd: task.estimatedCostUsd ?? 0,
    // Distinguish genuine zero-cost from "cost was never computed" so NRQL
    // sum(estimated_cost_usd) doesn't silently undercount.
    cost_estimated: task.estimatedCostUsd !== null,
    tokens_used: task.tokensUsed,
    asked_user_questions: task.askedUserQuestions,
    sub_agents_spawned: task.subAgentsSpawned,
  };

  if (attrs.teamId) event.team_id = attrs.teamId;
  if (attrs.projectId) event.project_id = attrs.projectId;
  if (attrs.orgId) event.org_id = attrs.orgId;

  // sessionTraceId is the resolved Claude Code session_id; the
  // firstRecord?.sessionId fallback was only meaningful when the MCP fabricated
  // its own UUID and lost cross-reference with the tool-call records.
  if (attrs.sessionTraceId != null) event.session_id = attrs.sessionTraceId;

  return event;
}

/**
 * Re-export `WorkflowRunMetrics` so call sites that import the shape from
 * `nr-ingest.ts` continue to resolve. The single source of truth lives in
 * the workflow-run-tracker module.
 */
export type { WorkflowRunMetrics } from '../metrics/workflow-run-tracker.js';

// ---------------------------------------------------------------------------
// Wire-shape types — script-driven workflow / subagent observability
// ---------------------------------------------------------------------------

/**
 * Aggregated record produced by `WorkflowWatcher` from a `wf_*.json` file.
 * Mirrors the wire shape on `AiWorkflowRun` for `run_source='script'`.
 * Used as input to `ingestScriptWorkflowRun` — distinct from
 * `WorkflowRunMetrics` (the agent-tool-spawn record from hooks).
 */
export interface ScriptWorkflowRunMetrics {
  readonly workflow_run_id: string; // wf_<hex>-<hex>
  readonly parent_session_id: string;
  readonly task_id: string | null;
  readonly workflow_name: string;
  readonly status: string;
  readonly default_model: string;
  readonly started_at: number;
  readonly duration_ms: number;
  readonly agent_count: number;
  /** Re-derived from sum of subagent JSONL usage; falls back to rollup totalTokens. */
  readonly total_tokens: number;
  readonly total_usd: number | null;
  readonly declared_phases: number | null;
  readonly observed_phases: number;
  /** JSON-encoded array, e.g. `[3,"dynamic",6]`. */
  readonly declared_parallel_widths: string;
  /**
   * (rollup.totalTokens − Σ subagent tokens) / rollup.totalTokens, in [-1,+∞).
   * `null` when no subagent token data has been collected for this run yet —
   * distinct from a genuine 0% delta.
   */
  readonly token_reconciliation_delta: number | null;
  readonly incomplete: boolean;
  readonly backfilled: boolean;
}

export interface SubagentTurnMetrics {
  readonly workflow_run_id: string | null;
  readonly agent_id: string;
  readonly parent_session_id: string;
  readonly message_id: string;
  readonly turn_uuid: string;
  readonly timestamp_ms: number;
  readonly model: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_tokens: number;
  readonly cache_read_tokens: number;
  readonly reasoning_tokens: number;
  readonly usd: number | null;
  readonly stop_reason: string | null;
  readonly schema_fingerprint: string;
}

export interface ObservabilityHealthMetrics {
  readonly timestamp: number;
  readonly watcher: 'workflow' | 'subagent';
  readonly files_watched: number;
  readonly lines_read: number;
  readonly bytes_read: number;
  readonly parse_errors: number;
  readonly schema_drifts: number;
  readonly last_error: { code: string; class: string } | null;
  readonly event?: string;
  readonly dimension?: string;
  readonly fingerprint?: string;
  readonly workflow_run_id?: string;
  readonly cost_self_check_delta_pct?: number;
}

export function subagentTurnToNrEvent(
  metrics: SubagentTurnMetrics,
  attrs: {
    developer: string;
    appName: string;
    teamId?: string | null;
    projectId?: string | null;
    orgId?: string | null;
  },
): NrEventData {
  const event: NrEventData = {
    eventType: 'AiSubagentTurn',
    event_version: 1,
    timestamp: metrics.timestamp_ms,
    workflow_run_id: metrics.workflow_run_id ?? '',
    agent_id: metrics.agent_id,
    parent_session_id: metrics.parent_session_id,
    message_id: metrics.message_id,
    turn_uuid: metrics.turn_uuid,
    timestamp_ms: metrics.timestamp_ms,
    // Declarative metadata: NOT redacted. The model identifier is
    // author-declared and must remain stable for grouping in NR.
    model: metrics.model,
    input_tokens: metrics.input_tokens,
    output_tokens: metrics.output_tokens,
    cache_creation_tokens: metrics.cache_creation_tokens,
    cache_read_tokens: metrics.cache_read_tokens,
    reasoning_tokens: metrics.reasoning_tokens,
    developer: attrs.developer,
    app_name: attrs.appName,
  };
  if (metrics.usd !== null) event.usd = metrics.usd;
  if (metrics.stop_reason !== null) event.stop_reason = metrics.stop_reason;
  if (metrics.schema_fingerprint) event.schema_fingerprint = metrics.schema_fingerprint;
  if (attrs.teamId) event.team_id = attrs.teamId;
  if (attrs.projectId) event.project_id = attrs.projectId;
  if (attrs.orgId) event.org_id = attrs.orgId;
  return event;
}

/**
 * Convert a `SubagentTokenEvent` (storage-layer record from the watcher
 * pipeline) into a flat NR event object.  Distinct from
 * `subagentTurnToNrEvent` which accepts the richer `SubagentTurnMetrics`
 * shape produced after USD computation.
 */
export function subagentTokenEventToNrEvent(
  event: SubagentTokenEvent,
  attrs: {
    developer: string;
    appName: string;
    teamId?: string | null;
    projectId?: string | null;
    orgId?: string | null;
  },
): NrEventData {
  const ev: NrEventData = {
    eventType: 'AiSubagentTurn',
    event_version: 1,
    timestamp: event.timestamp,
    agent_id: event.agentId,
    parent_session_id: event.parentSessionId,
    message_id: event.messageId,
    model: event.model,
    input_tokens: event.usage.inputTokens,
    output_tokens: event.usage.outputTokens,
    cache_creation_tokens: event.usage.cacheCreationTokens,
    cache_read_tokens: event.usage.cacheReadTokens,
    reasoning_tokens: event.usage.reasoningTokens,
    developer: attrs.developer,
    app_name: attrs.appName,
  };
  if (event.workflowRunId != null) ev.workflow_run_id = event.workflowRunId;
  if (attrs.teamId) ev.team_id = attrs.teamId;
  if (attrs.projectId) ev.project_id = attrs.projectId;
  if (attrs.orgId) ev.org_id = attrs.orgId;
  return ev;
}

export function scriptWorkflowRunToNrEvent(
  metrics: ScriptWorkflowRunMetrics,
  attrs: {
    developer: string;
    appName: string;
    teamId?: string | null;
    projectId?: string | null;
    orgId?: string | null;
  },
): NrEventData {
  const event: NrEventData = {
    eventType: 'AiWorkflowRun',
    event_version: 1,
    timestamp: metrics.started_at + metrics.duration_ms,
    run_source: 'script',
    workflow_run_id: metrics.workflow_run_id,
    // Declarative metadata: NOT redacted. meta.name is author-declared
    // and must remain stable for grouping in NR.
    workflow_name: metrics.workflow_name,
    parent_session_id: metrics.parent_session_id,
    status: metrics.status,
    default_model: metrics.default_model,
    started_at: metrics.started_at,
    duration_ms: metrics.duration_ms,
    agent_count: metrics.agent_count,
    total_tokens: metrics.total_tokens,
    observed_phases: metrics.observed_phases,
    declared_parallel_widths: metrics.declared_parallel_widths,
    incomplete: metrics.incomplete,
    backfilled: metrics.backfilled,
    developer: attrs.developer,
    app_name: attrs.appName,
  };
  if (metrics.task_id !== null) event.task_id = metrics.task_id;
  if (metrics.declared_phases !== null) event.declared_phases = metrics.declared_phases;
  if (metrics.total_usd !== null) event.total_usd = metrics.total_usd;
  if (metrics.token_reconciliation_delta !== null) {
    event.token_reconciliation_delta = metrics.token_reconciliation_delta;
  }
  if (attrs.teamId) event.team_id = attrs.teamId;
  if (attrs.projectId) event.project_id = attrs.projectId;
  if (attrs.orgId) event.org_id = attrs.orgId;
  return event;
}

export function observabilityHealthToNrEvent(
  metrics: ObservabilityHealthMetrics,
  attrs: {
    developer: string;
    appName: string;
    teamId?: string | null;
    projectId?: string | null;
    orgId?: string | null;
  },
): NrEventData {
  const event: NrEventData = {
    eventType: 'AiObservabilityHealth',
    event_version: 1,
    timestamp: metrics.timestamp,
    watcher: metrics.watcher,
    files_watched: metrics.files_watched,
    lines_read: metrics.lines_read,
    bytes_read: metrics.bytes_read,
    parse_errors: metrics.parse_errors,
    schema_drifts: metrics.schema_drifts,
    developer: attrs.developer,
    app_name: attrs.appName,
  };
  if (metrics.last_error !== null) {
    event.last_error_code = metrics.last_error.code;
    event.last_error_class = metrics.last_error.class;
  }
  if (metrics.event) event.event = metrics.event;
  if (metrics.dimension) event.dimension = metrics.dimension;
  if (metrics.fingerprint) event.fingerprint = metrics.fingerprint;
  if (metrics.workflow_run_id) event.workflow_run_id = metrics.workflow_run_id;
  if (typeof metrics.cost_self_check_delta_pct === 'number') {
    event.cost_self_check_delta_pct = metrics.cost_self_check_delta_pct;
  }
  if (attrs.teamId) event.team_id = attrs.teamId;
  if (attrs.projectId) event.project_id = attrs.projectId;
  if (attrs.orgId) event.org_id = attrs.orgId;
  return event;
}

/**
 * Convert a WorkflowRunMetrics into a flat NR event object.
 *
 * Mirrors the shape of `codingTaskToNrEvent` — snake_case attributes, team
 * attribution merged from `attrs`, the workflow agent description redacted
 * to match the policy applied to `Agent` tool input on the AiToolCall path.
 */
export function workflowRunToNrEvent(
  metrics: WorkflowRunMetrics,
  attrs: {
    developer: string;
    appName: string;
    sessionTraceId?: string;
    teamId?: string | null;
    projectId?: string | null;
    orgId?: string | null;
  },
): NrEventData {
  const event: NrEventData = {
    eventType: 'AiWorkflowRun',
    event_version: 1,
    // Identifier-space discriminator: hook-derived agent-tool runs
    // (toolu_*) coexist with script-driven runs (wf_<hex>-<hex>) in this
    // event type — `run_source` is the load-bearing field that lets NRQL
    // separate the two populations without colliding the id space.
    run_source: 'agent_tool',
    timestamp: metrics.started_at + metrics.duration_ms,
    workflow_run_id: metrics.workflow_run_id,
    developer: attrs.developer,
    app_name: attrs.appName,
    subagent_type: metrics.subagent_type ?? '',
    agent_name: metrics.agent_name ?? '',
    agent_model: metrics.agent_model ?? '',
    // Same redaction policy as the AiToolCall path — Agent descriptions are
    // user-supplied prompts that occasionally contain secrets.
    agent_description: redactSensitive(metrics.agent_description ?? ''),
    run_in_background: metrics.run_in_background ?? false,
    started_at: metrics.started_at,
    duration_ms: metrics.duration_ms,
    tool_call_count: metrics.tool_call_count,
    child_agent_count: metrics.child_agent_count,
    status: metrics.status,
  };

  if (metrics.exit_error != null) {
    // Workflow exit messages occasionally include URLs from failed curl/HTTP
    // calls inside the agent — same egress channel as `event.error` on
    // AiToolCall, so apply the same redaction.
    event.exit_error = redactSensitive(metrics.exit_error);
  }

  if (attrs.teamId) event.team_id = attrs.teamId;
  if (attrs.projectId) event.project_id = attrs.projectId;
  if (attrs.orgId) event.org_id = attrs.orgId;

  // Prefer the resolved Claude Code session ID when threaded through the
  // manager (matches codingTaskToNrEvent); otherwise fall back to
  // the session ID baked into the tracker output.
  const resolvedSessionId = attrs.sessionTraceId ?? metrics.session_id;
  if (resolvedSessionId) event.session_id = resolvedSessionId;

  return event;
}

/**
 * Convert an AntiPattern into a flat NR event object.
 *
 * Optional fields are only included when defined on the source pattern.
 */
export function antiPatternToNrEvent(
  pattern: AntiPattern,
  attrs: {
    developer: string;
    appName: string;
    sessionId?: string;
    platform?: string;
    taskId: string;
    teamId?: string | null;
    projectId?: string | null;
    orgId?: string | null;
    /** Detection wall-clock time in ms. Defaults to now if not provided. */
    detectedAt?: number;
  },
): NrEventData {
  const event: NrEventData = {
    eventType: 'AiAntiPattern',
    timestamp: attrs.detectedAt ?? Date.now(),
    // Field name is intentionally 'type' (not 'patternType') — used by all NRQL queries and dashboards. Do not rename.
    type: pattern.type,
    task_id: attrs.taskId,
    developer: attrs.developer,
    app_name: attrs.appName,
    platform: attrs.platform ?? 'claude-code',
    suggestion: pattern.suggestion,
  };

  if (attrs.teamId) event.team_id = attrs.teamId;
  if (attrs.projectId) event.project_id = attrs.projectId;
  if (attrs.orgId) event.org_id = attrs.orgId;

  if (attrs.sessionId != null) event.session_id = attrs.sessionId;
  // pattern.file is sourced from raw call.filePath in detectThrashing, and
  // pattern.command from raw Bash commands in other detectors — both can
  // carry query-string tokens or Authorization headers. Same egress channel
  // as toolCallToNrEvent, so the same redaction policy applies.
  if (pattern.file != null) event.file = redactSensitive(pattern.file);
  if (pattern.command != null) event.command = redactSensitive(pattern.command);
  if (pattern.iterations != null) event.iterations = pattern.iterations;
  if (pattern.readCount != null) event.read_count = pattern.readCount;
  if (pattern.repeatCount != null) event.repeat_count = pattern.repeatCount;
  if (pattern.editCount != null) event.edit_count = pattern.editCount;
  if (pattern.agentCount != null) event.agent_count = pattern.agentCount;

  return event;
}

// ---------------------------------------------------------------------------
// Retry classification
// ---------------------------------------------------------------------------

// 4xx errors that the transport already dropped as permanent failures — re-queuing them
// would cause an infinite retry loop since the same request will fail again. Exclude 408
// (Request Timeout, network-level, worth retrying) and 429 (Too Many Requests, rate-limited,
// worth retrying on the next harvest cycle).
function isNonRetryable4xx(statusCode: number): boolean {
  return statusCode >= 400 && statusCode < 500 && statusCode !== 408 && statusCode !== 429;
}

// ---------------------------------------------------------------------------
// NrIngestManager
// ---------------------------------------------------------------------------

export class NrIngestManager {
  private readonly scheduler: HarvestScheduler;
  private readonly logIngest: LogIngestManager;
  private readonly sessionTracker: SessionTracker;
  private readonly proxyMetrics: ProxyMetricsTracker;
  private readonly costTracker?: CostTracker;
  private readonly efficiencyScorer?: EfficiencyScorer;
  private readonly feedbackCollector?: FeedbackCollector;
  readonly auditTrail: AuditTrailManager;
  private readonly developer: string;
  private readonly appName: string;
  private readonly sessionTraceId: string | undefined;
  private readonly teamId: string | null | undefined;
  private readonly projectId: string | null | undefined;
  private readonly orgId: string | null | undefined;
  private readonly metricHarvestIntervalMs: number;
  private readonly turnCostAttributor?: TurnCostAttributor;
  private readonly otlpTransport: OtlpTransport | null;
  private readonly otlpEventBridge: OtlpEventBridge | null;
  private sessionGaugeIntervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(options: NrIngestOptions) {
    this.developer = options.developer;
    this.appName = options.appName;
    this.sessionTraceId = options.sessionTraceId;
    this.teamId = options.teamId;
    this.projectId = options.projectId;
    this.orgId = options.orgId;
    this.sessionTracker = options.sessionTracker;
    this.proxyMetrics = new ProxyMetricsTracker();
    this.costTracker = options.costTracker;
    this.efficiencyScorer = options.efficiencyScorer;
    this.feedbackCollector = options.feedbackCollector;
    this.turnCostAttributor = options.turnCostAttributor;
    this.auditTrail =
      options.auditTrail ??
      new AuditTrailManager({
        developer: options.developer,
        sessionId: options.sessionId ?? null,
        localStore: options.localStore,
      });
    this.metricHarvestIntervalMs = options.metricHarvestIntervalMs ?? 60_000;

    let otlpTransport: OtlpTransport | null = null;
    let otlpEventBridge: OtlpEventBridge | null = null;

    if (options.otlpEndpoint) {
      otlpTransport = new OtlpTransport({
        endpoint: options.otlpEndpoint,
        headers: options.otlpHeaders,
        appName: options.appName,
        clientName: 'newrelic-preflight',
        clientVersion: VERSION,
      });
      otlpEventBridge = new OtlpEventBridge({
        endpoint: options.otlpEndpoint,
        headers: options.otlpHeaders,
        appName: options.appName,
        clientName: 'newrelic-preflight',
        clientVersion: VERSION,
      });
      // OtlpTransport no longer has an explicit start() — providers initialise in the constructor.
    }
    this.otlpTransport = otlpTransport;
    this.otlpEventBridge = otlpEventBridge;

    // Wrap send functions so non-retryable 4xx failures (400, 403, etc.) are not
    // re-queued by HarvestScheduler. Returning success=true suppresses the requeue
    // without masking the original error — we log a warning before returning.
    const rawSendEventsFn = options.sendEventsFn ?? sendEvents;
    const classifyingEventsFn: SendEventsFn = async (events, licenseKey, opts) => {
      const result = await rawSendEventsFn(events, licenseKey, opts);
      if (!result.success && result.statusCode !== null && isNonRetryable4xx(result.statusCode)) {
        logger.warn('Dropping non-retryable event batch', {
          statusCode: result.statusCode,
          batchSize: events.length,
        });
        return { ...result, success: true };
      }
      return result;
    };

    const rawSendMetricsFn = options.sendMetricsFn ?? sendMetrics;
    const classifyingMetricsFn: SendMetricsFn = async (metrics, licenseKey, opts) => {
      const result = await rawSendMetricsFn(metrics, licenseKey, opts);
      if (!result.success && result.statusCode !== null && isNonRetryable4xx(result.statusCode)) {
        logger.warn('Dropping non-retryable metric batch', {
          statusCode: result.statusCode,
          batchSize: metrics.length,
        });
        return { ...result, success: true };
      }
      return result;
    };

    const transportOptions: TransportOptions = {
      ...options.transportOptions,
      clientName: 'newrelic-preflight',
      clientVersion: VERSION,
    };

    this.scheduler = new HarvestScheduler({
      licenseKey: options.licenseKey,
      transportOptions,
      eventHarvestIntervalMs: options.eventHarvestIntervalMs,
      metricHarvestIntervalMs: options.metricHarvestIntervalMs,
      sendEventsFn: classifyingEventsFn,
      sendMetricsFn: classifyingMetricsFn,
      otlpEventBridge: otlpEventBridge ?? undefined,
      otlpTransport: otlpTransport ?? undefined,
      transport: options.transport,
      allowProcessExit: true,
    });

    this.logIngest = new LogIngestManager({
      licenseKey: options.licenseKey,
      transportOptions,
      developer: options.developer,
      appName: options.appName,
      logHarvestIntervalMs: options.logHarvestIntervalMs,
      sendLogsFn: options.sendLogsFn,
    });
  }

  ingestProxyRequest(record: ProxyRequestRecord): void {
    const event = proxyRequestToNrEvent(record, {
      developer: this.developer,
      appName: this.appName,
      teamId: this.teamId,
      projectId: this.projectId,
      orgId: this.orgId,
    });
    this.scheduler.addEvent(event);

    const server = record.serverName;
    this.scheduler.recordMetric('ai.mcp.proxy_request_count', 1, { server, method: record.method });
    if (record.durationMs != null) {
      this.scheduler.recordMetric('ai.mcp.proxy_request_duration_ms', record.durationMs, {
        server,
      });
    }

    // Aggregate into proxy metrics tracker
    this.proxyMetrics.recordProxyRequest(record);
  }

  ingestToolCall(record: ToolCallRecord, auditRecord?: AuditRecord): void {
    // Buffer event for NR Events API
    const event = toolCallToNrEvent(record, {
      developer: this.developer,
      appName: this.appName,
      sessionTraceId: this.sessionTraceId,
      teamId: this.teamId,
      projectId: this.projectId,
      orgId: this.orgId,
    });

    // Cost attribution is available via the nr_observe_get_cost_per_tool MCP tool only.
    // Enriching NR events here would always produce null because the token event
    // (which finalizes turn cost) arrives asynchronously after ingestToolCall is called.

    this.scheduler.addEvent(event);

    // Record per-call metrics for NR Metric API
    const tool = record.toolName;
    const sessionId = this.sessionTraceId;
    const teamDims: Record<string, string> = {};
    if (this.teamId) teamDims.team_id = this.teamId;
    if (this.projectId) teamDims.project_id = this.projectId;
    if (this.orgId) teamDims.org_id = this.orgId;

    this.scheduler.recordMetric(
      'ai.tool.call_count',
      1,
      sessionId != null ? { tool, session_id: sessionId, ...teamDims } : { tool, ...teamDims },
    );
    if (record.durationMs != null) {
      this.scheduler.recordMetric(
        'ai.tool.duration_ms',
        record.durationMs,
        sessionId != null ? { tool, session_id: sessionId, ...teamDims } : { tool, ...teamDims },
      );
    }
    this.scheduler.recordMetric(
      'ai.tool.success',
      record.success ? 1 : 0,
      sessionId != null ? { tool, session_id: sessionId, ...teamDims } : { tool, ...teamDims },
    );

    // If this is a proxied tool call, also emit AiMcpToolCall event and aggregate
    if (isProxyToolCall(record)) {
      const proxyEvent = proxyToolCallToNrEvent(record, {
        developer: this.developer,
        appName: this.appName,
        sessionTraceId: this.sessionTraceId,
        teamId: this.teamId,
        projectId: this.projectId,
        orgId: this.orgId,
      });
      this.scheduler.addEvent(proxyEvent);
      this.proxyMetrics.recordProxyCall(record);
    }

    // Security audit trail. The caller may pass a pre-computed auditRecord
    // (e.g. from the onRecord pipeline so audit recording works in local mode);
    // fall back to recording here for any callers that don't.
    const finalAuditRecord =
      auditRecord ??
      (isProxyToolCall(record)
        ? this.auditTrail.recordProxyCall(record)
        : this.auditTrail.recordToolCall(record));
    this.scheduler.addEvent(
      auditRecordToNrEvent(finalAuditRecord, {
        teamId: this.teamId,
        projectId: this.projectId,
        orgId: this.orgId,
      }),
    );
    if (finalAuditRecord.securityAlert) {
      this.scheduler.addEvent(
        securityAlertToNrEvent(finalAuditRecord, {
          teamId: this.teamId,
          projectId: this.projectId,
          orgId: this.orgId,
        }),
      );
    }
    // Queue audit log entry for NR Logs API
    this.logIngest.addAuditRecord(finalAuditRecord);
  }

  ingestCodingTask(task: AiCodingTask): void {
    const event = codingTaskToNrEvent(task, {
      developer: this.developer,
      appName: this.appName,
      sessionTraceId: this.sessionTraceId,
      teamId: this.teamId,
      projectId: this.projectId,
      orgId: this.orgId,
    });
    this.scheduler.addEvent(event);
  }

  /**
   * Buffer a completed workflow run as a single `AiWorkflowRun` event.
   * Designed to be called from the runtime wiring (`src/index.ts`) for each
   * entry returned by `WorkflowRunTracker.drainCompleted()`. Mirrors
   * `ingestCodingTask` — single buffered event, no additional metric
   * emission for v0.
   */
  ingestWorkflowRun(metrics: WorkflowRunMetrics): void {
    const event = workflowRunToNrEvent(metrics, {
      developer: this.developer,
      appName: this.appName,
      sessionTraceId: this.sessionTraceId,
      teamId: this.teamId,
      projectId: this.projectId,
      orgId: this.orgId,
    });
    this.scheduler.addEvent(event);
  }

  /**
   * Buffer a script-watcher-derived workflow run (`run_source='script'`).
   * Distinct from `ingestWorkflowRun` — that path serializes the agent-tool
   * `WorkflowRunMetrics` shape; this one serializes the on-disk `wf_*.json`
   * rollup with subagent reconciliation.
   */
  ingestScriptWorkflowRun(metrics: ScriptWorkflowRunMetrics): void {
    const event = scriptWorkflowRunToNrEvent(metrics, {
      developer: this.developer,
      appName: this.appName,
      teamId: this.teamId,
      projectId: this.projectId,
      orgId: this.orgId,
    });
    this.scheduler.addEvent(event);
  }

  /**
   * Buffer a single subagent assistant turn (`AiSubagentTurn`).
   * Called per ToolCallRecord-equivalent by the SubagentWatcher pipeline
   * after `CostTracker.recordTokenUsage` has computed the per-turn USD.
   */
  ingestSubagentTurn(metrics: SubagentTurnMetrics): void {
    const event = subagentTurnToNrEvent(metrics, {
      developer: this.developer,
      appName: this.appName,
      teamId: this.teamId,
      projectId: this.projectId,
      orgId: this.orgId,
    });
    this.scheduler.addEvent(event);
  }

  /**
   * Buffer a `SubagentTokenEvent` (storage-layer record) as an `AiSubagentTurn`
   * NR event.  Distinct from `ingestSubagentTurn` which accepts the richer
   * `SubagentTurnMetrics` shape produced after USD computation.
   */
  ingestSubagentTokenEvent(event: SubagentTokenEvent): void {
    const ev = subagentTokenEventToNrEvent(event, {
      developer: this.developer,
      appName: this.appName,
      teamId: this.teamId,
      projectId: this.projectId,
      orgId: this.orgId,
    });
    this.scheduler.addEvent(ev);
  }

  /** Buffer an `AiObservabilityHealth` event from the watcher pipeline. */
  ingestObservabilityHealth(metrics: ObservabilityHealthMetrics): void {
    const event = observabilityHealthToNrEvent(metrics, {
      developer: this.developer,
      appName: this.appName,
      teamId: this.teamId,
      projectId: this.projectId,
      orgId: this.orgId,
    });
    this.scheduler.addEvent(event);
  }

  ingestAntiPattern(
    pattern: AntiPattern,
    context: { sessionId?: string; platform?: string; taskId: string; detectedAt?: number },
  ): void {
    const event = antiPatternToNrEvent(pattern, {
      developer: this.developer,
      appName: this.appName,
      sessionId: this.sessionTraceId,
      platform: context.platform,
      taskId: context.taskId,
      teamId: this.teamId,
      projectId: this.projectId,
      orgId: this.orgId,
      detectedAt: context.detectedAt,
    });
    this.scheduler.addEvent(event);
  }

  ingestContextSnapshot(
    snapshot: ContextTurnSnapshot,
    topTools: readonly ToolContextContribution[],
  ): void {
    const nrEvent: NrEventData = {
      eventType: 'AiContextSnapshot',
      timestamp: snapshot.timestamp,
      developer: this.developer,
      appName: this.appName,
      turn_number: snapshot.turnNumber,
      total_context_tokens: snapshot.inputTokens,
      output_tokens: snapshot.outputTokens,
      cache_read_tokens: snapshot.cacheReadTokens,
      cache_creation_tokens: snapshot.cacheCreationTokens,
      fill_percent: snapshot.fillPercent,
      system_tokens: snapshot.breakdown.system,
      tool_tokens: snapshot.breakdown.tools,
      user_tokens: snapshot.breakdown.user,
      assistant_tokens: snapshot.breakdown.assistant,
    };
    if (topTools.length > 0) {
      nrEvent.top_tool = topTools[0].tool;
      nrEvent.top_tool_bytes = topTools[0].totalBytes;
      nrEvent.top_tool_tokens = topTools[0].estimatedTokens;
    }
    if (this.teamId) nrEvent.team_id = this.teamId;
    if (this.projectId) nrEvent.project_id = this.projectId;
    if (this.orgId) nrEvent.org_id = this.orgId;
    if (this.sessionTraceId != null) nrEvent.session_id = this.sessionTraceId;
    this.scheduler.addEvent(nrEvent);
  }

  ingestBudgetWarning(event: BudgetThresholdEvent): void {
    const nrEvent: NrEventData = {
      eventType: 'AiBudgetWarning',
      timestamp: event.timestamp,
      developer: this.developer,
      appName: this.appName,
      budget_period: event.period,
      threshold_pct: event.thresholdPct,
      spent_usd: event.spentUsd,
      budget_usd: event.budgetUsd,
      remaining_usd: Math.max(0, event.budgetUsd - event.spentUsd),
    };
    if (this.teamId) nrEvent.team_id = this.teamId;
    if (this.projectId) nrEvent.project_id = this.projectId;
    if (this.orgId) nrEvent.org_id = this.orgId;
    if (this.sessionTraceId != null) nrEvent.session_id = this.sessionTraceId;
    this.scheduler.addEvent(nrEvent);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduler.start();
    this.logIngest.start();

    // Emit session-level gauges on the metric harvest cadence
    this.sessionGaugeIntervalId = setInterval(() => {
      this.emitSessionGauges();
    }, this.metricHarvestIntervalMs);
    this.sessionGaugeIntervalId.unref();
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    // Emit final session gauges before clearing interval and stopping scheduler
    this.emitSessionGauges();

    // Clear session gauge interval
    if (this.sessionGaugeIntervalId !== null) {
      clearInterval(this.sessionGaugeIntervalId);
      this.sessionGaugeIntervalId = null;
    }

    this.running = false;

    const cleanupPromises = [this.scheduler.stop(), this.logIngest.stop()];
    if (this.otlpTransport) {
      cleanupPromises.push(this.otlpTransport.shutdown());
    }
    if (this.otlpEventBridge) {
      cleanupPromises.push(this.otlpEventBridge.shutdown());
    }
    const results = await Promise.allSettled(cleanupPromises);
    for (const r of results) {
      if (r.status === 'rejected') {
        logger.warn('Error stopping NrIngest service', { error: String(r.reason) });
      }
    }
  }

  private emitSessionGauges(): void {
    if (!this.running) return;
    const sessionId = this.sessionTraceId;

    const teamAttrs: Record<string, string> = {};
    if (this.teamId) teamAttrs.team_id = this.teamId;
    if (this.projectId) teamAttrs.project_id = this.projectId;
    if (this.orgId) teamAttrs.org_id = this.orgId;

    const record = (name: string, value: number, attrs: Record<string, string | number> = {}) => {
      this.scheduler.recordMetric(
        name,
        value,
        sessionId != null ? { session_id: sessionId, ...attrs } : attrs,
      );
    };

    const metrics = this.sessionTracker.getMetrics();
    record('ai.session.duration_ms', metrics.sessionDurationMs, { ...teamAttrs });
    record('ai.session.unique_files_read', metrics.uniqueFilesRead, { ...teamAttrs });
    record('ai.session.unique_files_written', metrics.uniqueFilesWritten, { ...teamAttrs });

    // Emit cost and efficiency metrics with developer dimension so Team View
    // FACET developer queries return per-developer breakdowns.
    if (this.costTracker || this.efficiencyScorer || this.feedbackCollector) {
      const developer = this.developer;
      const scheduler = this.scheduler;
      const devAggregator = new MetricAggregator();
      const _origRecord = devAggregator.record.bind(devAggregator);
      // Override record() to inject developer + team attribution on every metric.
      // The bound original is preserved so TypeScript sees the full MetricAggregator type.
      (devAggregator as unknown as { record: typeof _origRecord }).record = (
        name: string,
        value: number,
        attrs: Record<string, string | number> = {},
      ) => {
        scheduler.recordMetric(
          name,
          value,
          sessionId != null
            ? { developer, session_id: sessionId, ...teamAttrs, ...attrs }
            : { developer, ...teamAttrs, ...attrs },
        );
        return true;
      };
      this.costTracker?.emitMetrics(devAggregator);
      this.efficiencyScorer?.emitMetrics(devAggregator);
      this.feedbackCollector?.emitMetrics(devAggregator);
    }

    // Emit aggregated proxy metrics
    const proxyMetrics = this.proxyMetrics.getMetrics();
    for (const [server, stats] of Object.entries(proxyMetrics.perServer)) {
      this.scheduler.recordMetric('ai.mcp.server_call_count', stats.callCount, {
        server,
        ...teamAttrs,
      });
      if (stats.latencyMs.count > 0) {
        const avg = stats.latencyMs.sum / stats.latencyMs.count;
        this.scheduler.recordMetric('ai.mcp.server_latency_ms', avg, { server, ...teamAttrs });
      }
      if (stats.errorRate > 0) {
        this.scheduler.recordMetric('ai.mcp.server_error_rate', stats.errorRate, {
          server,
          ...teamAttrs,
        });
      }
    }
    if (proxyMetrics.avgProxyOverheadMs > 0) {
      this.scheduler.recordMetric('ai.mcp.proxy_overhead_ms', proxyMetrics.avgProxyOverheadMs, {
        ...teamAttrs,
      });
    }
    // Cap at 100 (tool, server) combinations to stay within NR Metric API cardinality limits.
    const MAX_TOOL_POPULARITY_ENTRIES = 100;
    for (const entry of proxyMetrics.toolPopularity.slice(0, MAX_TOOL_POPULARITY_ENTRIES)) {
      this.scheduler.recordMetric('ai.mcp.tool_popularity', entry.count, {
        tool: entry.tool,
        server: entry.server,
        ...teamAttrs,
      });
    }
  }
}
