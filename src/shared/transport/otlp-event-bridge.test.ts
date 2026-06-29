import { LoggerProvider } from '@opentelemetry/sdk-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';

import type { NrEventData } from '../events/types.js';
import { OtlpEventBridge } from './otlp-event-bridge.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;

// Mock OTel SDK modules
jest.mock('@opentelemetry/exporter-logs-otlp-http', () => ({
  OTLPLogExporter: jest.fn().mockImplementation(() => ({
    shutdown: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('@opentelemetry/sdk-logs', () => ({
  LoggerProvider: jest.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.forceFlush = jest.fn().mockResolvedValue(undefined);
    this.shutdown = jest.fn().mockResolvedValue(undefined);
    const emitMock = jest.fn();
    this.getLogger = jest.fn().mockReturnValue({
      emit: emitMock,
    });
    this._emitMock = emitMock;
    return this;
  }),
  BatchLogRecordProcessor: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('@opentelemetry/resources', () => ({
  resourceFromAttributes: jest.fn().mockReturnValue({}),
}));

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.clearAllMocks();
});

afterEach(() => {
  stderrSpy.mockRestore();
});

describe('OtlpEventBridge', () => {
  // ---------------------------------------------------------------------------
  // 1. Constructor initializes with endpoint and appName
  // ---------------------------------------------------------------------------
  it('constructs with endpoint and appName', () => {
    const bridge = new OtlpEventBridge({
      endpoint: 'https://otlp.nr-data.net',
      headers: { 'api-key': 'test-key' },
      appName: 'test-app',
    });

    expect(bridge).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 2. sendEvents() accepts an array of events
  // ---------------------------------------------------------------------------
  it('sendEvents() accepts an array of events', () => {
    const bridge = new OtlpEventBridge({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
    });

    const events: NrEventData[] = [
      { eventType: 'AiToolCall', timestamp: 1000 },
      { eventType: 'AiAntiPattern', timestamp: 2000 },
    ];

    expect(() => bridge.sendEvents(events)).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // 3. sendEvents() with empty array does not throw
  // ---------------------------------------------------------------------------
  it('sendEvents() with empty array does not throw', () => {
    const bridge = new OtlpEventBridge({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
    });

    expect(() => bridge.sendEvents([])).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // 4. sendEvents() iterates over events
  // ---------------------------------------------------------------------------
  it('sendEvents() iterates over events without throwing', () => {
    const bridge = new OtlpEventBridge({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
    });

    const events: NrEventData[] = [
      { eventType: 'AiToolCall', timestamp: 1000 },
      { eventType: 'AiAntiPattern', timestamp: 2000 },
      { eventType: 'AiCodingTask', timestamp: 3000 },
    ];

    expect(() => bridge.sendEvents(events)).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // 5. flush() calls loggerProvider.forceFlush()
  // ---------------------------------------------------------------------------
  it('flush() does not throw', async () => {
    const bridge = new OtlpEventBridge({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
    });

    await expect(bridge.flush()).resolves.not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // 6. shutdown() calls loggerProvider.shutdown()
  // ---------------------------------------------------------------------------
  it('shutdown() does not throw', async () => {
    const bridge = new OtlpEventBridge({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
    });

    await expect(bridge.shutdown()).resolves.not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // 7. Multiple sendEvents() calls do not throw
  // ---------------------------------------------------------------------------
  it('multiple sendEvents() calls do not throw', () => {
    const bridge = new OtlpEventBridge({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
    });

    expect(() => {
      bridge.sendEvents([{ eventType: 'AiToolCall' }]);
      bridge.sendEvents([{ eventType: 'AiAntiPattern' }]);
      bridge.sendEvents([{ eventType: 'AiCodingTask' }]);
    }).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // 8. sendEvents() handles events with mixed attribute types
  // ---------------------------------------------------------------------------
  it('sendEvents() handles events with mixed attribute types', () => {
    const bridge = new OtlpEventBridge({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
    });

    const events: NrEventData[] = [
      {
        eventType: 'AiToolCall',
        timestamp: 1000,
        toolName: 'write_file',
        success: true,
        duration: 125.5,
      },
    ];

    expect(() => bridge.sendEvents(events)).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // 9. constructor with optional headers
  // ---------------------------------------------------------------------------
  it('constructs with optional headers', () => {
    const bridge1 = new OtlpEventBridge({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
    });

    const bridge2 = new OtlpEventBridge({
      endpoint: 'https://otlp.nr-data.net',
      headers: { 'api-key': 'test-key' },
      appName: 'test-app',
    });

    expect(bridge1).toBeDefined();
    expect(bridge2).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 10. sendEvents() calls otelLogger.emit() once per event
  // ---------------------------------------------------------------------------
  it('sendEvents() calls otelLogger.emit() once per event', () => {
    const bridge = new OtlpEventBridge({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
    });

    const events: NrEventData[] = [
      { eventType: 'AiToolCall', timestamp: 1000 },
      { eventType: 'AiAntiPattern', timestamp: 2000 },
      { eventType: 'AiCodingTask', timestamp: 3000 },
    ];

    bridge.sendEvents(events);

    const providerInstance = (LoggerProvider as jest.Mock).mock.results[0].value as Record<
      string,
      unknown
    >;
    const emitMock = providerInstance._emitMock as jest.Mock;
    expect(emitMock).toHaveBeenCalledTimes(3);

    // Verify LogRecord shape for the first event
    const firstCall = emitMock.mock.calls[0][0] as Record<string, unknown>;
    expect(firstCall.severityText).toBe('INFO');
    expect(firstCall.body).toBe('AiToolCall');
    expect(firstCall.timestamp).toBe(1000);
    expect(firstCall.attributes).toMatchObject({ eventType: 'AiToolCall', timestamp: 1000 });
  });

  // ---------------------------------------------------------------------------
  // 11. sendEvents() with missing timestamp uses Date.now()
  // ---------------------------------------------------------------------------
  it('sendEvents() with events without timestamp does not throw', () => {
    const bridge = new OtlpEventBridge({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
    });

    const events: NrEventData[] = [{ eventType: 'AiToolCall' }];

    expect(() => bridge.sendEvents(events)).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // 12. clientVersion is forwarded as the OTel scope version via getLogger
  // ---------------------------------------------------------------------------
  it('passes clientVersion to loggerProvider.getLogger as the scope version', () => {
    new OtlpEventBridge({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
      clientName: 'preflight',
      clientVersion: '1.2.3',
    });

    const providerInstance = (LoggerProvider as jest.Mock).mock.results[0].value as Record<
      string,
      unknown
    >;
    const getLoggerMock = providerInstance.getLogger as jest.Mock;
    expect(getLoggerMock).toHaveBeenCalledWith('preflight', '1.2.3');
  });

  it('passes undefined to getLogger when clientVersion is empty string', () => {
    new OtlpEventBridge({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
      clientName: 'preflight',
      clientVersion: '',
    });

    const providerInstance = (LoggerProvider as jest.Mock).mock.results[0].value as Record<
      string,
      unknown
    >;
    const getLoggerMock = providerInstance.getLogger as jest.Mock;
    expect(getLoggerMock).toHaveBeenCalledWith('preflight', undefined);
  });

  it('passes undefined to getLogger when clientVersion is omitted', () => {
    new OtlpEventBridge({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
    });

    const providerInstance = (LoggerProvider as jest.Mock).mock.results[0].value as Record<
      string,
      unknown
    >;
    const getLoggerMock = providerInstance.getLogger as jest.Mock;
    expect(getLoggerMock).toHaveBeenCalledWith('ai-telemetry', undefined);
  });

  it('stamps User-Agent on OTLPLogExporter headers', () => {
    new OtlpEventBridge({
      endpoint: 'https://otlp.nr-data.net',
      headers: { 'api-key': 'test-key' },
      appName: 'test-app',
      clientName: 'preflight',
      clientVersion: '2.0.0',
    });

    expect(OTLPLogExporter).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({ 'User-Agent': 'preflight/2.0.0' }),
      }),
    );
  });

  it('stamps name-only User-Agent when clientVersion is omitted', () => {
    new OtlpEventBridge({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
    });

    expect(OTLPLogExporter).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({ 'User-Agent': 'ai-telemetry' }),
      }),
    );
  });

  it('strips control characters from clientVersion before using in User-Agent', () => {
    new OtlpEventBridge({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
      clientName: 'preflight',
      clientVersion: '1.0\r\nX-Injected: evil',
    });

    expect(OTLPLogExporter).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({ 'User-Agent': 'preflight/1.0X-Injected: evil' }),
      }),
    );
  });

  it('strips control characters from clientName before using in User-Agent', () => {
    new OtlpEventBridge({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
      clientName: 'pre\nflight',
      clientVersion: '1.0.0',
    });

    expect(OTLPLogExporter).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({ 'User-Agent': 'preflight/1.0.0' }),
      }),
    );
  });

  // ---------------------------------------------------------------------------
  // 15-16. hasWarnedNoAuth warn-once behaviour
  // ---------------------------------------------------------------------------
  describe('hasWarnedNoAuth warn-once', () => {
    it('warns on first sendEvents() call when no auth header is present', () => {
      const bridge = new OtlpEventBridge({
        endpoint: 'https://otlp.nr-data.net',
        appName: 'test-app',
      });

      bridge.sendEvents([{ eventType: 'AiToolCall' }]);

      const warnCount = stderrSpy.mock.calls.filter((c: unknown[]) =>
        String(c[0] ?? '').includes('no auth header'),
      ).length;
      expect(warnCount).toBe(1);
    });

    it('warns only once across multiple sendEvents() calls', () => {
      const bridge = new OtlpEventBridge({
        endpoint: 'https://otlp.nr-data.net',
        appName: 'test-app',
      });

      bridge.sendEvents([{ eventType: 'AiToolCall' }]);
      bridge.sendEvents([{ eventType: 'AiAntiPattern' }]);
      bridge.sendEvents([{ eventType: 'AiCodingTask' }]);

      const warnCount = stderrSpy.mock.calls.filter((c: unknown[]) =>
        String(c[0] ?? '').includes('no auth header'),
      ).length;
      expect(warnCount).toBe(1);
    });

    it('does not warn when auth header is present', () => {
      const bridge = new OtlpEventBridge({
        endpoint: 'https://otlp.nr-data.net',
        headers: { 'api-key': 'test-key' },
        appName: 'test-app',
      });

      bridge.sendEvents([{ eventType: 'AiToolCall' }]);

      const warnedNoAuth = stderrSpy.mock.calls.some((c: unknown[]) =>
        String(c[0] ?? '').includes('no auth header'),
      );
      expect(warnedNoAuth).toBe(false);
    });

    it('does not warn when no events are sent', () => {
      new OtlpEventBridge({
        endpoint: 'https://otlp.nr-data.net',
        appName: 'test-app',
      });

      // No sendEvents call

      const warnedNoAuth = stderrSpy.mock.calls.some((c: unknown[]) =>
        String(c[0] ?? '').includes('no auth header'),
      );
      expect(warnedNoAuth).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 17-21. endpoint scheme enforcement
  // ---------------------------------------------------------------------------
  describe('endpoint scheme enforcement', () => {
    it('accepts https:// without warning', () => {
      expect(
        () =>
          new OtlpEventBridge({
            endpoint: 'https://otlp.nr-data.net',
            appName: 'test-app',
          }),
      ).not.toThrow();
      const warnedCleartext = stderrSpy.mock.calls.some((call: unknown[]) =>
        String(call[0] ?? '').includes('plain http://'),
      );
      expect(warnedCleartext).toBe(false);
    });

    it('accepts http://localhost without warning (loopback exception)', () => {
      expect(
        () =>
          new OtlpEventBridge({
            endpoint: 'http://localhost:4318',
            appName: 'test-app',
          }),
      ).not.toThrow();
      const warnedCleartext = stderrSpy.mock.calls.some((call: unknown[]) =>
        String(call[0] ?? '').includes('plain http://'),
      );
      expect(warnedCleartext).toBe(false);
    });

    it('emits a cleartext warning for http:// to a non-loopback host', () => {
      expect(
        () =>
          new OtlpEventBridge({
            endpoint: 'http://internal-collector.example.com:4318',
            appName: 'test-app',
          }),
      ).not.toThrow();
      const stderrText = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0] ?? '')).join('\n');
      expect(stderrText).toMatch(/plain http:\/\//);
      expect(stderrText).toMatch(/internal-collector\.example\.com/);
    });

    it('throws on a non-http(s) scheme', () => {
      expect(
        () =>
          new OtlpEventBridge({
            endpoint: 'ftp://collector.example.com',
            appName: 'test-app',
          }),
      ).toThrow(/OTLP endpoint must use http\(s\)/);
    });

    it('throws on a malformed endpoint URL', () => {
      expect(
        () =>
          new OtlpEventBridge({
            endpoint: 'not a url',
            appName: 'test-app',
          }),
      ).toThrow(/invalid OTLP endpoint URL/);
    });
  });
});
