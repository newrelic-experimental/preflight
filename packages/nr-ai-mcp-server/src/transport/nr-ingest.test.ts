import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { toolCallToNrEvent, NrIngestManager } from './nr-ingest.js';
import type { NrIngestOptions } from './nr-ingest.js';
import type { ToolCallRecord } from '../storage/types.js';
import { SessionTracker } from '../metrics/session-tracker.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(overrides?: Partial<ToolCallRecord>): ToolCallRecord {
  return {
    id: 'rec-001',
    sessionId: 'sess-001',
    toolName: 'Read',
    toolUseId: 'toolu_001',
    timestamp: 1_700_000_000_000, // ms
    durationMs: 50,
    success: true,
    ...overrides,
  };
}

const mockSendEvents = jest.fn<() => Promise<{ success: boolean; statusCode: number; retryCount: number }>>()
  .mockResolvedValue({ success: true, statusCode: 200, retryCount: 0 });
const mockSendMetrics = jest.fn<() => Promise<{ success: boolean; statusCode: number; retryCount: number }>>()
  .mockResolvedValue({ success: true, statusCode: 200, retryCount: 0 });
const mockSendLogs = jest.fn<() => Promise<{ success: boolean; statusCode: number; retryCount: number }>>()
  .mockResolvedValue({ success: true, statusCode: 200, retryCount: 0 });

function makeIngestOptions(overrides?: Partial<NrIngestOptions>): NrIngestOptions {
  return {
    licenseKey: 'test-license-key',
    transportOptions: { accountId: '12345' },
    developer: 'test-dev',
    appName: 'test-app',
    sessionTracker: new SessionTracker('test-session'),
    eventHarvestIntervalMs: 100_000, // long enough to not fire in tests
    metricHarvestIntervalMs: 100_000,
    sendEventsFn: mockSendEvents,
    sendMetricsFn: mockSendMetrics,
    sendLogsFn: mockSendLogs,
    ...overrides,
  };
}

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  mockSendEvents.mockClear();
  mockSendMetrics.mockClear();
  mockSendLogs.mockClear();
});

afterEach(() => {
  stderrSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// toolCallToNrEvent()
// ---------------------------------------------------------------------------

describe('toolCallToNrEvent()', () => {
  it('serializes standard fields correctly', () => {
    const record = makeRecord();
    const event = toolCallToNrEvent(record, { developer: 'dev1', appName: 'my-app' });

    expect(event.eventType).toBe('AiToolCall');
    expect(event.tool).toBe('Read');
    expect(event.tool_use_id).toBe('toolu_001');
    expect(event.success).toBe(true);
    expect(event.session_id).toBe('sess-001');
    expect(event.duration_ms).toBe(50);
    expect(event.developer).toBe('dev1');
    expect(event.app_name).toBe('my-app');
  });

  it('converts timestamp from ms to seconds', () => {
    const record = makeRecord({ timestamp: 1_700_000_000_000 });
    const event = toolCallToNrEvent(record, { developer: 'd', appName: 'a' });

    expect(event.timestamp).toBe(1_700_000_000);
  });

  it('includes tool-specific fields from parsers', () => {
    const record = makeRecord({
      filePath: '/src/index.ts',
      lineOffset: 10,
      lineLimit: 50,
    } as Partial<ToolCallRecord>);

    const event = toolCallToNrEvent(record, { developer: 'd', appName: 'a' });

    expect(event.filePath).toBe('/src/index.ts');
    expect(event.lineOffset).toBe(10);
    expect(event.lineLimit).toBe(50);
  });

  it('includes bash-specific boolean fields', () => {
    const record = makeRecord({
      toolName: 'Bash',
      command: 'npm test',
      isTestCommand: true,
      isBuildCommand: false,
    } as Partial<ToolCallRecord>);

    const event = toolCallToNrEvent(record, { developer: 'd', appName: 'a' });

    expect(event.command).toBe('npm test');
    expect(event.isTestCommand).toBe(true);
    expect(event.isBuildCommand).toBe(false);
  });

  it('includes platform attribute defaulting to claude-code', () => {
    const record = makeRecord();
    const event = toolCallToNrEvent(record, { developer: 'd', appName: 'a' });

    expect(event.platform).toBe('claude-code');
  });

  it('uses explicit platform from record when present', () => {
    const record = makeRecord({ platform: 'cursor' } as Partial<ToolCallRecord>);
    const event = toolCallToNrEvent(record, { developer: 'd', appName: 'a' });

    expect(event.platform).toBe('cursor');
  });

  it('skips null and undefined values', () => {
    const record = makeRecord({
      durationMs: null,
      errorType: undefined,
      sessionId: null,
    });

    const event = toolCallToNrEvent(record, { developer: 'd', appName: 'a' });

    expect(event).not.toHaveProperty('duration_ms');
    expect(event).not.toHaveProperty('error_type');
    expect(event).not.toHaveProperty('session_id');
  });

  it('skips object/array values in tool-specific fields', () => {
    const record = makeRecord({
      toolInput: { file_path: '/a.ts' },
      toolOutput: ['line1', 'line2'],
    } as Partial<ToolCallRecord>);

    const event = toolCallToNrEvent(record, { developer: 'd', appName: 'a' });

    expect(event).not.toHaveProperty('toolInput');
    expect(event).not.toHaveProperty('toolOutput');
  });

  it('includes error fields when present', () => {
    const record = makeRecord({
      success: false,
      errorType: 'timeout',
      error: 'Command timed out after 30s',
    });

    const event = toolCallToNrEvent(record, { developer: 'd', appName: 'a' });

    expect(event.success).toBe(false);
    expect(event.error_type).toBe('timeout');
    expect(event.error).toBe('Command timed out after 30s');
  });

  it('includes inputSizeBytes, outputSizeBytes, inputHash when present', () => {
    const record = makeRecord({
      inputSizeBytes: 256,
      outputSizeBytes: 1024,
      inputHash: 'abc123',
    });

    const event = toolCallToNrEvent(record, { developer: 'd', appName: 'a' });

    expect(event.input_size_bytes).toBe(256);
    expect(event.output_size_bytes).toBe(1024);
    expect(event.input_hash).toBe('abc123');
  });
});

// ---------------------------------------------------------------------------
// NrIngestManager
// ---------------------------------------------------------------------------

describe('NrIngestManager', () => {
  describe('ingestToolCall()', () => {
    it('buffers event and records metrics (verified via flush)', async () => {
      const manager = new NrIngestManager(makeIngestOptions());

      manager.ingestToolCall(makeRecord({ toolName: 'Edit', durationMs: 120 }));

      manager.start();
      await manager.stop();

      // Event was flushed (AiToolCall + AiAuditEvent per tool call)
      expect(mockSendEvents).toHaveBeenCalled();
      const sentEvents = (mockSendEvents.mock.calls[0] as unknown[])[0] as Array<Record<string, unknown>>;
      expect(sentEvents).toHaveLength(2);
      const toolCallEvent = sentEvents.find(e => e.eventType === 'AiToolCall')!;
      expect(toolCallEvent.tool).toBe('Edit');
      expect(toolCallEvent.duration_ms).toBe(120);

      // Metrics were flushed
      expect(mockSendMetrics).toHaveBeenCalled();
      const sentMetrics = (mockSendMetrics.mock.calls[0] as unknown[])[0] as Array<Record<string, unknown>>;
      const metricNames = sentMetrics.map(m => m.name);
      expect(metricNames).toContain('ai.tool.call_count.count');
      expect(metricNames).toContain('ai.tool.duration_ms.count');
      expect(metricNames).toContain('ai.tool.success.count');
    });
  });

  describe('start() / stop() lifecycle', () => {
    it('starts and stops without errors', async () => {
      const manager = new NrIngestManager(makeIngestOptions());

      manager.start();
      await manager.stop();
    });

    it('stop() triggers final flush of events and metrics', async () => {
      const manager = new NrIngestManager(makeIngestOptions());

      manager.ingestToolCall(makeRecord({ toolName: 'Read', durationMs: 50 }));
      manager.ingestToolCall(makeRecord({ toolName: 'Bash', durationMs: 200 }));

      manager.start();
      await manager.stop();

      expect(mockSendEvents).toHaveBeenCalled();
      const sentEvents = (mockSendEvents.mock.calls[0] as unknown[])[0] as Array<Record<string, unknown>>;
      // 2 AiToolCall + 2 AiAuditEvent = 4 events
      expect(sentEvents).toHaveLength(4);
      const toolCallEvents = sentEvents.filter(e => e.eventType === 'AiToolCall');
      expect(toolCallEvents).toHaveLength(2);
      expect(toolCallEvents[0]!.tool).toBe('Read');
      expect(toolCallEvents[1]!.tool).toBe('Bash');

      expect(mockSendMetrics).toHaveBeenCalled();
    });

    it('emits session gauges on stop', async () => {
      const sessionTracker = new SessionTracker('gauge-session');
      sessionTracker.recordToolCall(makeRecord({ toolName: 'Read', filePath: '/a.ts' }));
      sessionTracker.recordToolCall(makeRecord({ toolName: 'Write', filePath: '/b.ts' }));

      const manager = new NrIngestManager(makeIngestOptions({ sessionTracker }));

      manager.start();
      await manager.stop();

      expect(mockSendMetrics).toHaveBeenCalled();
      const sentMetrics = (mockSendMetrics.mock.calls[0] as unknown[])[0] as Array<Record<string, unknown>>;
      const metricNames = sentMetrics.map(m => m.name);

      expect(metricNames).toContain('ai.session.duration_ms.count');
      expect(metricNames).toContain('ai.session.unique_files_read.count');
      expect(metricNames).toContain('ai.session.unique_files_written.count');
    });
  });

  describe('error handling', () => {
    it('NR API errors are logged, not thrown', async () => {
      mockSendEvents.mockResolvedValueOnce({
        success: false,
        statusCode: 500,
        retryCount: 3,
        error: 'Internal Server Error',
      } as { success: boolean; statusCode: number; retryCount: number });

      const manager = new NrIngestManager(makeIngestOptions());
      manager.ingestToolCall(makeRecord());

      manager.start();
      await manager.stop();
    });
  });
});
