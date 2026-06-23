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
import type { ToolCallRecord } from '../storage/types.js';
import type { ProxyToolCallRecord, ProxyRequestRecord } from '../proxy/types.js';
import type { AiCodingTask } from '../metrics/task-detector.js';
import type { AntiPattern } from '../metrics/anti-patterns.js';
import type { SessionTracker } from '../metrics/session-tracker.js';
import type { CostTracker } from '../metrics/cost-tracker.js';
import type { EfficiencyScorer } from '../metrics/efficiency-score.js';
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
      });
      otlpEventBridge = new OtlpEventBridge({
        endpoint: options.otlpEndpoint,
        headers: options.otlpHeaders,
        appName: options.appName,
        clientName: 'newrelic-preflight',
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
    if (this.costTracker || this.efficiencyScorer) {
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
