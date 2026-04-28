/**
 * New Relic Event Ingestion — converts ToolCallRecords into NR events and
 * metrics, then ships them via the shared HarvestScheduler.
 */

import type { NrEventData, NrMetric, NrLogEntry, TransportOptions, TransportResult } from '@nr-ai-observatory/shared';
import { HarvestScheduler, MetricAggregator, sendEvents, sendMetrics } from '@nr-ai-observatory/shared';
import type { ToolCallRecord } from '../storage/types.js';
import type { ProxyToolCallRecord, ProxyRequestRecord } from '../proxy/types.js';
import type { AiCodingTask } from '../metrics/task-detector.js';
import type { AntiPattern } from '../metrics/anti-patterns.js';
import type { SessionTracker } from '../metrics/session-tracker.js';
import type { CostTracker } from '../metrics/cost-tracker.js';
import type { EfficiencyScorer } from '../metrics/efficiency-score.js';
import { ProxyMetricsTracker } from '../metrics/proxy-metrics.js';
import {
  AuditTrailManager,
  auditRecordToNrEvent,
  securityAlertToNrEvent,
} from '../security/index.js';
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
 * Convert a ToolCallRecord into a flat NR event object.
 *
 * Standard fields are mapped to snake_case NR attributes; any extra
 * tool-specific fields (string | number | boolean) are included as-is.
 */
export function toolCallToNrEvent(
  record: ToolCallRecord,
  attrs: { developer: string; appName: string; sessionTraceId?: string },
): NrEventData {
  const event: NrEventData = {
    eventType: 'AiToolCall',
    timestamp: Math.floor(record.timestamp / 1000),
    tool: record.toolName,
    tool_use_id: record.toolUseId,
    success: record.success,
    developer: attrs.developer,
    app_name: attrs.appName,
  };

  const sessionId = attrs.sessionTraceId ?? record.sessionId;
  if (sessionId != null) event.session_id = sessionId;
  if (record.durationMs != null) event.duration_ms = record.durationMs;
  if (record.errorType != null) event.error_type = record.errorType;
  if (record.error != null) event.error = record.error;
  if (record.inputSizeBytes != null) event.input_size_bytes = record.inputSizeBytes;
  if (record.outputSizeBytes != null) event.output_size_bytes = record.outputSizeBytes;
  if (record.inputHash != null) event.input_hash = record.inputHash;

  // Platform attribution — defaults to 'claude-code' for backward compatibility
  event.platform = typeof record.platform === 'string' ? record.platform : 'claude-code';

  // Include tool-specific fields from parsers
  for (const [key, value] of Object.entries(record)) {
    if (STANDARD_KEYS.has(key)) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      event[key] = value;
    }
  }

  return event;
}

/** Type guard for ProxyToolCallRecord (has serverName and upstreamLatencyMs). */
function isProxyToolCall(record: ToolCallRecord): record is ProxyToolCallRecord {
  return 'serverName' in record && 'upstreamLatencyMs' in record;
}

/**
 * Convert a ProxyToolCallRecord into an NR event with proxy-specific attributes.
 */
export function proxyToolCallToNrEvent(
  record: ProxyToolCallRecord,
  attrs: { developer: string; appName: string },
): NrEventData {
  const event: NrEventData = {
    eventType: 'AiMcpToolCall',
    timestamp: Math.floor(record.timestamp / 1000),
    server: record.serverName,
    tool: record.toolName,
    duration_ms: record.durationMs ?? 0,
    upstream_latency_ms: record.upstreamLatencyMs,
    success: record.success,
    developer: attrs.developer,
    app_name: attrs.appName,
  };

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
  attrs: { developer: string; appName: string },
): NrEventData {
  const event: NrEventData = {
    eventType: 'AiProxyRequest',
    timestamp: Math.floor(record.timestamp / 1000),
    server: record.serverName,
    method: record.method,
    duration_ms: record.durationMs,
    upstream_latency_ms: record.upstreamLatencyMs,
    success: record.success,
    developer: attrs.developer,
    app_name: attrs.appName,
  };

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
  attrs: { developer: string; appName: string; sessionTraceId?: string },
): NrEventData {
  const firstRecord = task.toolCalls[0];
  const platform =
    typeof firstRecord?.platform === 'string' ? firstRecord.platform : 'claude-code';

  const event: NrEventData = {
    eventType: 'AiCodingTask',
    timestamp: Math.floor(task.endTime / 1000),
    task_id: task.taskId,
    developer: attrs.developer,
    app_name: attrs.appName,
    platform,
    start_time: Math.floor(task.startTime / 1000),
    end_time: Math.floor(task.endTime / 1000),
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
    tokens_used: task.tokensUsed,
    asked_user_questions: task.askedUserQuestions,
    sub_agents_spawned: task.subAgentsSpawned,
  };

  const sessionId = attrs.sessionTraceId ?? firstRecord?.sessionId ?? null;
  if (sessionId != null) event.session_id = sessionId;

  return event;
}

/**
 * Convert an AntiPattern into a flat NR event object.
 *
 * Optional fields are only included when defined on the source pattern.
 */
export function antiPatternToNrEvent(
  pattern: AntiPattern,
  attrs: { developer: string; appName: string; sessionId?: string; platform?: string; taskId: string },
): NrEventData {
  const event: NrEventData = {
    eventType: 'AiAntiPattern',
    timestamp: Math.floor(Date.now() / 1000),
    type: pattern.type,
    task_id: attrs.taskId,
    developer: attrs.developer,
    app_name: attrs.appName,
    platform: attrs.platform ?? 'claude-code',
    suggestion: pattern.suggestion,
  };

  if (attrs.sessionId != null) event.session_id = attrs.sessionId;
  if (pattern.file != null) event.file = pattern.file;
  if (pattern.command != null) event.command = pattern.command;
  if (pattern.iterations != null) event.iterations = pattern.iterations;
  if (pattern.readCount != null) event.read_count = pattern.readCount;
  if (pattern.repeatCount != null) event.repeat_count = pattern.repeatCount;
  if (pattern.editCount != null) event.edit_count = pattern.editCount;
  if (pattern.agentCount != null) event.agent_count = pattern.agentCount;

  return event;
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
  private readonly metricHarvestIntervalMs: number;
  private sessionGaugeIntervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(options: NrIngestOptions) {
    this.developer = options.developer;
    this.appName = options.appName;
    this.sessionTraceId = options.sessionTraceId;
    this.sessionTracker = options.sessionTracker;
    this.proxyMetrics = new ProxyMetricsTracker();
    this.costTracker = options.costTracker;
    this.efficiencyScorer = options.efficiencyScorer;
    this.auditTrail = new AuditTrailManager({
      developer: options.developer,
      sessionId: options.sessionId ?? null,
      localStore: options.localStore,
    });
    this.metricHarvestIntervalMs = options.metricHarvestIntervalMs ?? 60_000;

    this.scheduler = new HarvestScheduler({
      licenseKey: options.licenseKey,
      transportOptions: options.transportOptions,
      eventHarvestIntervalMs: options.eventHarvestIntervalMs,
      metricHarvestIntervalMs: options.metricHarvestIntervalMs,
      sendEventsFn: options.sendEventsFn ?? sendEvents,
      sendMetricsFn: options.sendMetricsFn ?? sendMetrics,
    });

    this.logIngest = new LogIngestManager({
      licenseKey: options.licenseKey,
      transportOptions: options.transportOptions,
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
    });
    this.scheduler.addEvent(event);

    const server = record.serverName;
    this.scheduler.recordMetric('ai.mcp.proxy_request_count', 1, { server, method: record.method });
    if (record.durationMs != null) {
      this.scheduler.recordMetric('ai.mcp.proxy_request_duration_ms', record.durationMs, { server });
    }

    // Aggregate into proxy metrics tracker
    this.proxyMetrics.recordProxyRequest(record);
  }

  ingestToolCall(record: ToolCallRecord): void {
    // Buffer event for NR Events API
    const event = toolCallToNrEvent(record, {
      developer: this.developer,
      appName: this.appName,
      sessionTraceId: this.sessionTraceId,
    });
    this.scheduler.addEvent(event);

    // Record per-call metrics for NR Metric API
    const tool = record.toolName;
    const sessionId = this.sessionTraceId;
    this.scheduler.recordMetric('ai.tool.call_count', 1, sessionId != null ? { tool, session_id: sessionId } : { tool });
    if (record.durationMs != null) {
      this.scheduler.recordMetric('ai.tool.duration_ms', record.durationMs, sessionId != null ? { tool, session_id: sessionId } : { tool });
    }
    this.scheduler.recordMetric('ai.tool.success', record.success ? 1 : 0, sessionId != null ? { tool, session_id: sessionId } : { tool });

    // If this is a proxied tool call, also emit AiMcpToolCall event and aggregate
    if (isProxyToolCall(record)) {
      const proxyEvent = proxyToolCallToNrEvent(record, {
        developer: this.developer,
        appName: this.appName,
      });
      this.scheduler.addEvent(proxyEvent);
      this.proxyMetrics.recordProxyCall(record);
    }

    // Security audit trail
    const auditRecord = isProxyToolCall(record)
      ? this.auditTrail.recordProxyCall(record)
      : this.auditTrail.recordToolCall(record);
    this.scheduler.addEvent(auditRecordToNrEvent(auditRecord));
    if (auditRecord.securityAlert) {
      this.scheduler.addEvent(securityAlertToNrEvent(auditRecord));
    }
    // Queue audit log entry for NR Logs API
    this.logIngest.addAuditRecord(auditRecord);
  }

  ingestCodingTask(task: AiCodingTask): void {
    const event = codingTaskToNrEvent(task, {
      developer: this.developer,
      appName: this.appName,
      sessionTraceId: this.sessionTraceId,
    });
    this.scheduler.addEvent(event);
  }

  ingestAntiPattern(
    pattern: AntiPattern,
    context: { sessionId?: string; platform?: string; taskId: string },
  ): void {
    const event = antiPatternToNrEvent(pattern, {
      developer: this.developer,
      appName: this.appName,
      sessionId: this.sessionTraceId ?? context.sessionId,
      platform: context.platform,
      taskId: context.taskId,
    });
    this.scheduler.addEvent(event);
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
    // Clear session gauge interval
    if (this.sessionGaugeIntervalId !== null) {
      clearInterval(this.sessionGaugeIntervalId);
      this.sessionGaugeIntervalId = null;
    }

    // Emit final session gauges before marking as stopped
    this.emitSessionGauges();
    this.running = false;

    await Promise.all([this.scheduler.stop(), this.logIngest.stop()]);
  }

  private emitSessionGauges(): void {
    if (!this.running) return;
    const sessionId = this.sessionTraceId;

    const record = (name: string, value: number, attrs: Record<string, string | number> = {}) => {
      this.scheduler.recordMetric(
        name,
        value,
        sessionId != null ? { session_id: sessionId, ...attrs } : attrs,
      );
    };

    const metrics = this.sessionTracker.getMetrics();
    record('ai.session.duration_ms', metrics.sessionDurationMs);
    record('ai.session.unique_files_read', metrics.uniqueFilesRead);
    record('ai.session.unique_files_written', metrics.uniqueFilesWritten);

    // Emit cost and efficiency metrics with developer dimension so Team View
    // FACET developer queries return per-developer breakdowns.
    if (this.costTracker || this.efficiencyScorer) {
      const developer = this.developer;
      const scheduler = this.scheduler;
      const devAggregator = {
        record(name: string, value: number, attrs: Record<string, string | number> = {}) {
          scheduler.recordMetric(
            name,
            value,
            sessionId != null
              ? { developer, session_id: sessionId, ...attrs }
              : { developer, ...attrs },
          );
        },
      } as unknown as MetricAggregator;
      this.costTracker?.emitMetrics(devAggregator);
      this.efficiencyScorer?.emitMetrics(devAggregator);
    }

    // Emit aggregated proxy metrics
    const proxyMetrics = this.proxyMetrics.getMetrics();
    for (const [server, stats] of Object.entries(proxyMetrics.perServer)) {
      this.scheduler.recordMetric('ai.mcp.server_call_count', stats.callCount, { server });
      if (stats.latencyMs.count > 0) {
        const avg = stats.latencyMs.sum / stats.latencyMs.count;
        this.scheduler.recordMetric('ai.mcp.server_latency_ms', avg, { server });
      }
      if (stats.errorRate > 0) {
        this.scheduler.recordMetric('ai.mcp.server_error_rate', stats.errorRate, { server });
      }
    }
    if (proxyMetrics.avgProxyOverheadMs > 0) {
      this.scheduler.recordMetric('ai.mcp.proxy_overhead_ms', proxyMetrics.avgProxyOverheadMs);
    }
    for (const entry of proxyMetrics.toolPopularity) {
      this.scheduler.recordMetric('ai.mcp.tool_popularity', entry.count, {
        tool: entry.tool,
        server: entry.server,
      });
    }
  }
}
