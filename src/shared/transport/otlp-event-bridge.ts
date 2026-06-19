import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { resourceFromAttributes } from '@opentelemetry/resources';
import type { NrEventData } from '../events/types.js';
import { createLogger } from '../logger.js';
import { validateOtlpEndpoint, hasOtlpAuthHeader, DEFAULT_CLIENT_NAME } from './otlp-shared.js';

const logger = createLogger('otlp-event-bridge');

export interface OtlpEventBridgeOptions {
  endpoint: string;
  headers?: Record<string, string>;
  appName: string;
  /**
   * OTel logger name used to identify the source of log records emitted by
   * this bridge. Defaults to `'ai-telemetry'` when not provided. Pass
   * `'preflight'`, `'nr-ai-agent'`, etc. so telemetry from different
   * consumers is distinguishable in the NR Logs UI.
   */
  clientName?: string;
}

export class OtlpEventBridge {
  private readonly loggerProvider: LoggerProvider;
  private readonly otelLogger: ReturnType<LoggerProvider['getLogger']>;

  constructor(options: OtlpEventBridgeOptions) {
    validateOtlpEndpoint(options.endpoint, 'OtlpEventBridge');

    // Warn once at construction time when no auth header is present (§TR4),
    // matching the behaviour of OtlpTransport.exportMetrics().
    if (!hasOtlpAuthHeader(options.headers ?? {})) {
      logger.warn('OtlpEventBridge constructed with no auth header — collector may reject events', {
        endpoint: options.endpoint,
      });
    }

    const exporter = new OTLPLogExporter({
      url: `${options.endpoint}/v1/logs`,
      headers: options.headers ?? {},
    });

    this.loggerProvider = new LoggerProvider({
      resource: resourceFromAttributes({ 'service.name': options.appName }),
      processors: [new BatchLogRecordProcessor(exporter)],
    });

    this.otelLogger = this.loggerProvider.getLogger(options.clientName || DEFAULT_CLIENT_NAME);
  }

  sendEvents(events: NrEventData[]): void {
    for (const event of events) {
      this.otelLogger.emit({
        severityText: 'INFO',
        body: String(event['eventType'] ?? 'AiEvent'),
        // Filter to scalar values only — the OTel SDK's AnyValue type also
        // accepts arrays/objects/null, and a non-scalar value would produce a
        // malformed log record. NrEventData is typed as all-scalar but callers
        // may pass unexpected shapes (§TR2).
        attributes: Object.fromEntries(
          Object.entries(event).filter(
            ([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
          ),
        ),
        timestamp: typeof event.timestamp === 'number' ? event.timestamp : Date.now(),
      });
    }
  }

  async flush(): Promise<void> {
    await this.loggerProvider.forceFlush();
  }

  async shutdown(): Promise<void> {
    await this.loggerProvider.shutdown();
  }
}
