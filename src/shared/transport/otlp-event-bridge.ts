import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { resourceFromAttributes } from '@opentelemetry/resources';

import type { NrEventData } from '../events/types.js';
import { createLogger } from '../logger.js';
import {
  validateOtlpEndpoint,
  hasOtlpAuthHeader,
  DEFAULT_CLIENT_NAME,
  buildUserAgent,
  sanitizeClientString,
} from './otlp-shared.js';

const logger = createLogger('otlp-event-bridge');

export interface OtlpEventBridgeOptions {
  readonly endpoint: string;
  readonly headers?: Record<string, string>;
  readonly appName: string;
  /**
   * OTel logger name used to identify the source of log records emitted by
   * this bridge. Defaults to `'ai-telemetry'` when not provided. Pass
   * `'preflight'`, `'nr-ai-agent'`, etc. so telemetry from different
   * consumers is distinguishable in the NR Logs UI.
   */
  readonly clientName?: string;
  /** Version of the consuming client, stamped as the OTel instrumentation scope version. */
  readonly clientVersion?: string;
}

export class OtlpEventBridge {
  private readonly loggerProvider: LoggerProvider;
  private readonly otelLogger: ReturnType<LoggerProvider['getLogger']>;
  private readonly hasAuth: boolean;
  private readonly endpoint: string;
  private hasWarnedNoAuth = false;

  constructor(options: OtlpEventBridgeOptions) {
    validateOtlpEndpoint(options.endpoint, 'OtlpEventBridge');

    const clientName = sanitizeClientString(options.clientName, DEFAULT_CLIENT_NAME);
    const clientVersion = sanitizeClientString(options.clientVersion, '');

    this.endpoint = options.endpoint;
    this.hasAuth = hasOtlpAuthHeader(options.headers ?? {});

    const exporter = new OTLPLogExporter({
      url: `${options.endpoint}/v1/logs`,
      headers: {
        ...(options.headers ?? {}),
        'User-Agent': buildUserAgent(clientName, clientVersion),
      },
    });

    this.loggerProvider = new LoggerProvider({
      resource: resourceFromAttributes({ 'service.name': options.appName }),
      processors: [new BatchLogRecordProcessor(exporter)],
    });

    this.otelLogger = this.loggerProvider.getLogger(clientName, clientVersion || undefined);
  }

  sendEvents(events: NrEventData[]): void {
    if (!this.hasAuth && !this.hasWarnedNoAuth) {
      this.hasWarnedNoAuth = true;
      logger.warn('OtlpEventBridge sending events with no auth header — collector may reject', {
        endpoint: this.endpoint,
      });
    }
    for (const event of events) {
      this.otelLogger.emit({
        severityText: 'INFO',
        body: String(event['eventType'] ?? 'AiEvent'),
        // Filter to scalar values only — the OTel SDK's AnyValue type also
        // accepts arrays/objects/null, and a non-scalar value would produce a
        // malformed log record. NrEventData is typed as all-scalar but callers
        // may pass unexpected shapes.
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
