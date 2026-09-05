/**
 * Log Ingest — converts AuditRecords into NR Log entries and ships them
 * via the shared Logs API transport on a harvest interval.
 */

import { createLogger } from '../shared/index.js';
import type { NrLogEntry, TransportOptions, TransportResult } from '../shared/index.js';
import { sendLogs } from '../shared/index.js';
import { redactSensitive } from '../config.js';
import type { AuditRecord } from '../security/audit-trail.js';
import { attachAuditAttribution } from '../security/audit-trail.js';

const logger = createLogger('log-ingest');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SendLogsFn = (
  logs: NrLogEntry[],
  licenseKey: string,
  options: TransportOptions,
) => Promise<TransportResult>;

export interface LogIngestOptions {
  licenseKey: string;
  transportOptions: TransportOptions;
  developer: string;
  appName: string;
  logHarvestIntervalMs?: number;
  /** Override for testing; defaults to the shared sendLogs transport. */
  sendLogsFn?: SendLogsFn;
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

/**
 * Convert an AuditRecord into a structured NR Log entry.
 */
export function auditRecordToLogEntry(record: AuditRecord, appName: string): NrLogEntry {
  const attributes: Record<string, string | number | boolean> = {
    tool: record.tool,
    developer: record.developer,
    app_name: appName,
    'audit.action': record.action,
    'audit.security_alert': !!record.securityAlert,
  };

  attachAuditAttribution(attributes, record);
  // Defense-in-depth: AuditRecord is already constructed with redacted
  // filePath/command/detail (see audit-trail.ts), but apply redactSensitive
  // again here so a future caller that bypasses the AuditTrailManager
  // constructor cannot leak secrets via the NR Logs egress channel.
  if (record.filePath != null) attributes['audit.file_path'] = redactSensitive(record.filePath);
  if (record.command != null) attributes['audit.command'] = redactSensitive(record.command);

  if (record.securityAlert) {
    attributes['audit.severity'] = record.securityAlert.severity;
    attributes['audit.alert_type'] = record.securityAlert.alertType;
  }

  return {
    timestamp: record.timestamp,
    message: redactSensitive(record.detail),
    attributes,
  };
}

// ---------------------------------------------------------------------------
// LogIngestManager
// ---------------------------------------------------------------------------

const DEFAULT_LOG_HARVEST_MS = 5_000;

export class LogIngestManager {
  private buffer: NrLogEntry[] = [];
  private readonly maxBufferSize = 1_000;
  private readonly licenseKey: string;
  private readonly transportOptions: TransportOptions;
  private readonly developer: string;
  private readonly appName: string;
  private readonly sendLogsFn: SendLogsFn;
  private readonly harvestIntervalMs: number;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private inFlightFlush: Promise<void> | null = null;

  constructor(options: LogIngestOptions) {
    this.licenseKey = options.licenseKey;
    this.transportOptions = options.transportOptions;
    this.developer = options.developer;
    this.appName = options.appName;
    this.sendLogsFn = options.sendLogsFn ?? sendLogs;
    this.harvestIntervalMs = options.logHarvestIntervalMs ?? DEFAULT_LOG_HARVEST_MS;
  }

  addLog(entry: NrLogEntry): void {
    this.buffer.push(entry);
  }

  addAuditRecord(record: AuditRecord): void {
    this.addLog(auditRecordToLogEntry(record, this.appName));
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    this.intervalId = setInterval(() => {
      this.inFlightFlush = this.flush().finally(() => {
        this.inFlightFlush = null;
      });
    }, this.harvestIntervalMs);
    this.intervalId.unref();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    // Wait for any in-flight periodic flush to finish before draining the
    // final batch, so a concurrent requeueBatch() doesn't lose entries.
    if (this.inFlightFlush) await this.inFlightFlush.catch(() => {});
    await this.flush();
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const batch = this.buffer;
    this.buffer = [];

    try {
      const result = await this.sendLogsFn(batch, this.licenseKey, this.transportOptions);
      if (!result.success) {
        // Drop non-retryable 4xx (auth failure, bad payload) — re-queuing
        // would fill the buffer indefinitely with entries that will never succeed.
        const isNonRetryable =
          result.statusCode !== null &&
          result.statusCode >= 400 &&
          result.statusCode < 500 &&
          result.statusCode !== 408 &&
          result.statusCode !== 429;
        if (isNonRetryable) {
          logger.warn('Dropping non-retryable log batch', {
            statusCode: result.statusCode,
            batchSize: batch.length,
          });
        } else {
          logger.warn('Failed to send logs — re-queuing batch for retry', {
            batchSize: batch.length,
            error: result.error,
          });
          this.requeueBatch(batch);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('Unexpected error sending logs — re-queuing batch for retry', {
        batchSize: batch.length,
        error: message,
      });
      this.requeueBatch(batch);
    }
  }

  private requeueBatch(batch: NrLogEntry[]): void {
    // Trim new entries first so the failed batch (higher retry priority) is preserved.
    // If the batch itself exceeds the cap, keep its most-recent entries.
    const maxNew = Math.max(0, this.maxBufferSize - batch.length);
    // Guard: slice(-0) === slice(0) returns the full array in JS; use [] when maxNew is 0.
    const trimmedNew = maxNew === 0 ? [] : this.buffer.slice(-maxNew);
    const trimmedBatch = batch.slice(-this.maxBufferSize);
    const dropped = this.buffer.length - trimmedNew.length + (batch.length - trimmedBatch.length);
    this.buffer = [...trimmedBatch, ...trimmedNew];
    if (dropped > 0) {
      logger.warn('Log buffer overflow — entries dropped', { dropped });
    }
  }
}
