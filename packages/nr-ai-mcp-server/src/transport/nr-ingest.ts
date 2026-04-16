/**
 * New Relic Event Ingestion — converts ToolCallRecords into NR events and
 * metrics, then ships them via the shared HarvestScheduler.
 */

import type { NrEventData, NrMetric, TransportOptions, TransportResult } from '@nr-ai-observatory/shared';
import { HarvestScheduler, sendEvents, sendMetrics } from '@nr-ai-observatory/shared';
import type { ToolCallRecord } from '../storage/types.js';
import type { SessionTracker } from '../metrics/session-tracker.js';

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

export interface NrIngestOptions {
  licenseKey: string;
  transportOptions: TransportOptions;
  developer: string;
  appName: string;
  sessionTracker: SessionTracker;
  eventHarvestIntervalMs?: number;
  metricHarvestIntervalMs?: number;
  /** Override for testing; defaults to the shared sendEvents transport. */
  sendEventsFn?: SendEventsFn;
  /** Override for testing; defaults to the shared sendMetrics transport. */
  sendMetricsFn?: SendMetricsFn;
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
]);

/**
 * Convert a ToolCallRecord into a flat NR event object.
 *
 * Standard fields are mapped to snake_case NR attributes; any extra
 * tool-specific fields (string | number | boolean) are included as-is.
 */
export function toolCallToNrEvent(
  record: ToolCallRecord,
  attrs: { developer: string; appName: string },
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

  if (record.sessionId != null) event.session_id = record.sessionId;
  if (record.durationMs != null) event.duration_ms = record.durationMs;
  if (record.errorType != null) event.error_type = record.errorType;
  if (record.error != null) event.error = record.error;
  if (record.inputSizeBytes != null) event.input_size_bytes = record.inputSizeBytes;
  if (record.outputSizeBytes != null) event.output_size_bytes = record.outputSizeBytes;
  if (record.inputHash != null) event.input_hash = record.inputHash;

  // Include tool-specific fields from parsers
  for (const [key, value] of Object.entries(record)) {
    if (STANDARD_KEYS.has(key)) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      event[key] = value;
    }
  }

  return event;
}

// ---------------------------------------------------------------------------
// NrIngestManager
// ---------------------------------------------------------------------------

export class NrIngestManager {
  private readonly scheduler: HarvestScheduler;
  private readonly sessionTracker: SessionTracker;
  private readonly developer: string;
  private readonly appName: string;
  private readonly metricHarvestIntervalMs: number;
  private sessionGaugeIntervalId: ReturnType<typeof setInterval> | null = null;

  constructor(options: NrIngestOptions) {
    this.developer = options.developer;
    this.appName = options.appName;
    this.sessionTracker = options.sessionTracker;
    this.metricHarvestIntervalMs = options.metricHarvestIntervalMs ?? 60_000;

    this.scheduler = new HarvestScheduler({
      licenseKey: options.licenseKey,
      transportOptions: options.transportOptions,
      eventHarvestIntervalMs: options.eventHarvestIntervalMs,
      metricHarvestIntervalMs: options.metricHarvestIntervalMs,
      sendEventsFn: options.sendEventsFn ?? sendEvents,
      sendMetricsFn: options.sendMetricsFn ?? sendMetrics,
    });
  }

  ingestToolCall(record: ToolCallRecord): void {
    // Buffer event for NR Events API
    const event = toolCallToNrEvent(record, {
      developer: this.developer,
      appName: this.appName,
    });
    this.scheduler.addEvent(event);

    // Record per-call metrics for NR Metric API
    const tool = record.toolName;
    this.scheduler.recordMetric('ai.tool.call_count', 1, { tool });
    if (record.durationMs != null) {
      this.scheduler.recordMetric('ai.tool.duration_ms', record.durationMs, { tool });
    }
    this.scheduler.recordMetric('ai.tool.success', record.success ? 1 : 0, { tool });
  }

  start(): void {
    this.scheduler.start();

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

    // Emit final session gauges before shutdown
    this.emitSessionGauges();

    await this.scheduler.stop();
  }

  private emitSessionGauges(): void {
    const metrics = this.sessionTracker.getMetrics();
    this.scheduler.recordMetric('ai.session.duration_ms', metrics.sessionDurationMs);
    this.scheduler.recordMetric('ai.session.unique_files_read', metrics.uniqueFilesRead);
    this.scheduler.recordMetric('ai.session.unique_files_written', metrics.uniqueFilesWritten);
  }
}
