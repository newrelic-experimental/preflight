/**
 * Log Ingest — converts AuditRecords into NR Log entries and ships them
 * via the shared Logs API transport on a harvest interval.
 */

import { createLogger } from '@nr-ai-observatory/shared';
import type { NrLogEntry, TransportOptions, TransportResult } from '@nr-ai-observatory/shared';
import { sendLogs } from '@nr-ai-observatory/shared';
import type { AuditRecord } from '../security/audit-trail.js';

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

  if (record.sessionId != null) attributes.session_id = record.sessionId;
  if (record.filePath != null) attributes['audit.file_path'] = record.filePath;
  if (record.command != null) attributes['audit.command'] = record.command;

  if (record.securityAlert) {
    attributes['audit.severity'] = record.securityAlert.severity;
    attributes['audit.alert_type'] = record.securityAlert.alertType;
  }

  return {
    timestamp: record.timestamp,
    message: record.detail,
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
      void this.flush();
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

    await this.flush();
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const batch = this.buffer;
    this.buffer = [];

    try {
      const result = await this.sendLogsFn(batch, this.licenseKey, this.transportOptions);
      if (!result.success) {
        logger.warn('Failed to send logs — re-queuing batch for retry', {
          batchSize: batch.length,
          error: result.error,
        });
        this.requeueBatch(batch);
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
    this.buffer = [...batch, ...this.buffer];
    if (this.buffer.length > this.maxBufferSize) {
      const dropped = this.buffer.length - this.maxBufferSize;
      this.buffer = this.buffer.slice(0, this.maxBufferSize);
      logger.warn('Log buffer overflow — oldest entries dropped', { dropped });
    }
  }
}
