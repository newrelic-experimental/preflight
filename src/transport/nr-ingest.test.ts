import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  toolCallToNrEvent,
  codingTaskToNrEvent,
  antiPatternToNrEvent,
  proxyToolCallToNrEvent,
  proxyRequestToNrEvent,
  NrIngestManager,
  isProxyToolCall,
} from './nr-ingest.js';
import type { NrIngestOptions } from './nr-ingest.js';
import type { ToolCallRecord } from '../storage/types.js';
import type { ProxyToolCallRecord, ProxyRequestRecord } from '../proxy/types.js';
import type { AiCodingTask } from '../metrics/task-detector.js';
import type { AntiPattern } from '../metrics/anti-patterns.js';
import type { ContextTurnSnapshot, ToolContextContribution } from '../metrics/context-tracker.js';
import { SessionTracker } from '../metrics/session-tracker.js';
import { FeedbackCollector } from '../tools/workflow-tools.js';

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

function makeProxyRecord(overrides?: Partial<ProxyToolCallRecord>): ProxyToolCallRecord {
  return {
    ...makeRecord(),
    serverName: 'test-server',
    upstreamLatencyMs: 10,
    ...overrides,
  };
}

function makeProxyRequestRecord(overrides?: Partial<ProxyRequestRecord>): ProxyRequestRecord {
  return {
    id: 'preq-001',
    serverName: 'nr-mcp-server',
    method: 'tools/list',
    timestamp: 1_700_000_000_000,
    durationMs: 15,
    upstreamLatencyMs: 10,
    success: true,
    ...overrides,
  };
}

function makeContextSnapshot(overrides?: Partial<ContextTurnSnapshot>): ContextTurnSnapshot {
  return {
    turnNumber: 3,
    timestamp: 1_700_000_000_000,
    inputTokens: 5000,
    outputTokens: 200,
    cacheReadTokens: 1000,
    cacheCreationTokens: 0,
    fillPercent: 0.25,
    breakdown: { system: 500, tools: 2000, user: 1500, assistant: 1000 },
    ...overrides,
  };
}

function makeToolContribution(
  overrides?: Partial<ToolContextContribution>,
): ToolContextContribution {
  return {
    tool: 'Read',
    totalBytes: 4000,
    estimatedTokens: 1000,
    percentOfToolOutput: 50,
    ...overrides,
  };
}

function makePattern(overrides?: Partial<AntiPattern>): AntiPattern {
  return {
    type: 'thrashing',
    suggestion: 'Consider reviewing your approach before retrying',
    ...overrides,
  };
}

function makeTask(overrides?: Partial<AiCodingTask>): AiCodingTask {
  return {
    taskId: 'task-001',
    startTime: 1_700_000_000_000,
    endTime: 1_700_000_060_000,
    durationMs: 60_000,
    toolCallCount: 3,
    toolCallsByType: { Read: 2, Edit: 1 },
    filesRead: ['/a.ts', '/b.ts'],
    filesModified: ['/b.ts'],
    linesChanged: 10,
    linesAdded: 15,
    linesRemoved: 5,
    bashCommandsRun: 1,
    testsRun: 2,
    testsPassed: 2,
    buildRun: 1,
    buildPassed: 1,
    estimatedCostUsd: 0.004,
    tokensUsed: 1200,
    askedUserQuestions: 0,
    subAgentsSpawned: 0,
    toolCalls: [makeRecord({ sessionId: 'sess-001', platform: 'claude-code' })],
    ...overrides,
  };
}

const mockSendEvents = jest
  .fn<() => Promise<{ success: boolean; statusCode: number; retryCount: number }>>()
  .mockResolvedValue({ success: true, statusCode: 200, retryCount: 0 });
const mockSendMetrics = jest
  .fn<() => Promise<{ success: boolean; statusCode: number; retryCount: number }>>()
  .mockResolvedValue({ success: true, statusCode: 200, retryCount: 0 });
const mockSendLogs = jest
  .fn<() => Promise<{ success: boolean; statusCode: number; retryCount: number }>>()
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
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
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
    const event = toolCallToNrEvent(record, {
      developer: 'dev1',
      appName: 'my-app',
      sessionTraceId: 'sess-001',
    });

    expect(event.eventType).toBe('AiToolCall');
    expect(event.tool).toBe('Read');
    expect(event.tool_use_id).toBe('toolu_001');
    expect(event.success).toBe(true);
    expect(event.session_id).toBe('sess-001');
    expect(event.duration_ms).toBe(50);
    expect(event.developer).toBe('dev1');
    expect(event.app_name).toBe('my-app');
  });

  it('preserves timestamp in milliseconds', () => {
    const record = makeRecord({ timestamp: 1_700_000_000_000 });
    const event = toolCallToNrEvent(record, { developer: 'd', appName: 'a' });

    expect(event.timestamp).toBe(1_700_000_000_000);
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

  it('serializes bash classifier fields onto the AiToolCall event', () => {
    // The whole point of the classifier is that its output reaches NR. The
    // serializer relies on the index-signature spread loop, so this test
    // proves the contract end-to-end.
    const record = makeRecord({
      toolName: 'Bash',
      command: 'jest --watch',
      bashCategory: 'test-runner',
      bashLeading: 'jest',
      bashDestructive: false,
      bashNetwork: false,
    } as Partial<ToolCallRecord>);

    const event = toolCallToNrEvent(record, { developer: 'd', appName: 'a' });

    expect(event.bashCategory).toBe('test-runner');
    expect(event.bashLeading).toBe('jest');
    expect(event.bashDestructive).toBe(false);
    expect(event.bashNetwork).toBe(false);
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

  describe('redaction', () => {
    // Long enough Bearer token to match the pattern's {20,200} length constraint.
    const SECRET_TOKEN = 'sk-test-deadbeef0123456789abcdef0123456789';

    it('redacts secrets in Bash command before emitting AiToolCall', () => {
      const record = makeRecord({
        toolName: 'Bash',
        command: `curl -H "Authorization: Bearer ${SECRET_TOKEN}" https://api.example.com`,
      } as Partial<ToolCallRecord>);

      const event = toolCallToNrEvent(record, { developer: 'd', appName: 'a' });

      expect(typeof event.command).toBe('string');
      expect(event.command as string).not.toContain(SECRET_TOKEN);
      expect(event.command as string).toContain('[REDACTED]');
    });

    it('redacts secrets in filePath / file_path / agentDescription / detail / pattern', () => {
      const record = makeRecord({
        filePath: `/tmp/config?token=${SECRET_TOKEN}`,
        file_path: `/tmp/other?token=${SECRET_TOKEN}`,
        pattern: 'AKIAIOSFODNN7EXAMPLE',
        agentDescription: `Use token ${SECRET_TOKEN} to fetch`,
        detail: `Read /etc/passwd with ${SECRET_TOKEN}`,
      } as unknown as Partial<ToolCallRecord>);

      const event = toolCallToNrEvent(record, { developer: 'd', appName: 'a' });

      expect(event.filePath as string).not.toContain(SECRET_TOKEN);
      expect(event.file_path as string).not.toContain(SECRET_TOKEN);
      expect(event.pattern as string).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(event.agentDescription as string).not.toContain(SECRET_TOKEN);
      expect(event.detail as string).not.toContain(SECRET_TOKEN);
    });

    it('redacts secrets in commandDescription / taskSubject / grepPath / globPath / agentTeamName', () => {
      const record = makeRecord({
        commandDescription: `Run curl with token ${SECRET_TOKEN}`,
        taskSubject: `Rotate token ${SECRET_TOKEN}`,
        grepPath: `/tmp/${SECRET_TOKEN}/src`,
        globPath: `/tmp/${SECRET_TOKEN}/**/*.ts`,
        agentTeamName: `team-${SECRET_TOKEN}`,
      } as unknown as Partial<ToolCallRecord>);

      const event = toolCallToNrEvent(record, { developer: 'd', appName: 'a' });

      expect(event.commandDescription as string).not.toContain(SECRET_TOKEN);
      expect(event.taskSubject as string).not.toContain(SECRET_TOKEN);
      expect(event.grepPath as string).not.toContain(SECRET_TOKEN);
      expect(event.globPath as string).not.toContain(SECRET_TOKEN);
      expect(event.agentTeamName as string).not.toContain(SECRET_TOKEN);
    });

    it('does not redact non-sensitive string fields', () => {
      const record = makeRecord({
        toolName: 'Bash',
        isTestCommand: true,
        someBenignString: 'hello world',
      } as unknown as Partial<ToolCallRecord>);

      const event = toolCallToNrEvent(record, { developer: 'd', appName: 'a' });

      expect(event.someBenignString).toBe('hello world');
      expect(event.isTestCommand).toBe(true);
    });

    it('redacts secrets in record.error', () => {
      const record = makeRecord({
        success: false,
        errorType: 'http_error',
        error: `curl: (22) The requested URL returned error 401 — Authorization: Bearer ${SECRET_TOKEN}`,
      });

      const event = toolCallToNrEvent(record, { developer: 'd', appName: 'a' });

      expect(event.error as string).not.toContain(SECRET_TOKEN);
      expect(event.error as string).toContain('[REDACTED]');
    });
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
      const sentEvents = (mockSendEvents.mock.calls[0] as unknown[])[0] as Array<
        Record<string, unknown>
      >;
      expect(sentEvents).toHaveLength(2);
      const toolCallEvent = sentEvents.find((e) => e.eventType === 'AiToolCall')!;
      expect(toolCallEvent.tool).toBe('Edit');
      expect(toolCallEvent.duration_ms).toBe(120);

      // Metrics were flushed
      expect(mockSendMetrics).toHaveBeenCalled();
      const sentMetrics = (mockSendMetrics.mock.calls[0] as unknown[])[0] as Array<
        Record<string, unknown>
      >;
      const metricNames = sentMetrics.map((m) => m.name);
      expect(metricNames).toContain('ai.tool.call_count');
      expect(metricNames).toContain('ai.tool.duration_ms');
      expect(metricNames).toContain('ai.tool.success');
    });
  });

  describe('proxyRequestToNrEvent()', () => {
    it('serializes AiProxyRequest fields correctly', () => {
      const record = makeProxyRequestRecord();
      const event = proxyRequestToNrEvent(record, { developer: 'dev1', appName: 'my-app' });

      expect(event.eventType).toBe('AiProxyRequest');
      expect(event.server).toBe('nr-mcp-server');
      expect(event.method).toBe('tools/list');
      expect(event.duration_ms).toBe(15);
      expect(event.upstream_latency_ms).toBe(10);
      expect(event.success).toBe(true);
      expect(event.developer).toBe('dev1');
      expect(event.app_name).toBe('my-app');
    });

    it('includes proxy_overhead_ms and response_size_bytes when present', () => {
      const record = makeProxyRequestRecord({ proxyOverheadMs: 3, responseSizeBytes: 512 });
      const event = proxyRequestToNrEvent(record, { developer: 'd', appName: 'a' });

      expect(event.proxy_overhead_ms).toBe(3);
      expect(event.response_size_bytes).toBe(512);
    });

    it('omits proxy_overhead_ms and response_size_bytes when absent', () => {
      const record = makeProxyRequestRecord();
      const event = proxyRequestToNrEvent(record, { developer: 'd', appName: 'a' });

      expect(event).not.toHaveProperty('proxy_overhead_ms');
      expect(event).not.toHaveProperty('response_size_bytes');
    });

    it('includes team_id/project_id/org_id when provided', () => {
      const record = makeProxyRequestRecord();
      const event = proxyRequestToNrEvent(record, {
        developer: 'd',
        appName: 'a',
        teamId: 'team-1',
        projectId: 'proj-1',
        orgId: 'org-1',
      });

      expect(event.team_id).toBe('team-1');
      expect(event.project_id).toBe('proj-1');
      expect(event.org_id).toBe('org-1');
    });
  });

  describe('ingestProxyRequest()', () => {
    it('buffers AiProxyRequest event and records proxy metrics (verified via flush)', async () => {
      const manager = new NrIngestManager(makeIngestOptions());

      manager.ingestProxyRequest(makeProxyRequestRecord({ method: 'tools/call', durationMs: 42 }));

      manager.start();
      await manager.stop();

      expect(mockSendEvents).toHaveBeenCalled();
      const sentEvents = (mockSendEvents.mock.calls[0] as unknown[])[0] as Array<
        Record<string, unknown>
      >;
      const proxyEvent = sentEvents.find((e) => e.eventType === 'AiProxyRequest')!;
      expect(proxyEvent).toBeDefined();
      expect(proxyEvent.method).toBe('tools/call');
      expect(proxyEvent.duration_ms).toBe(42);

      expect(mockSendMetrics).toHaveBeenCalled();
      const sentMetrics = (mockSendMetrics.mock.calls[0] as unknown[])[0] as Array<
        Record<string, unknown>
      >;
      const metricNames = sentMetrics.map((m) => m.name);
      expect(metricNames).toContain('ai.mcp.proxy_request_count');
      expect(metricNames).toContain('ai.mcp.proxy_request_duration_ms');
    });

    it('does not emit ai.mcp.proxy_request_duration_ms metric when durationMs is null', async () => {
      const manager = new NrIngestManager(makeIngestOptions());

      manager.ingestProxyRequest(makeProxyRequestRecord({ durationMs: null as unknown as number }));

      manager.start();
      await manager.stop();

      const sentMetrics = (mockSendMetrics.mock.calls[0] as unknown[])[0] as Array<
        Record<string, unknown>
      >;
      const metricNames = sentMetrics.map((m) => m.name);
      expect(metricNames).not.toContain('ai.mcp.proxy_request_duration_ms');
    });
  });

  describe('ingestContextSnapshot()', () => {
    it('buffers AiContextSnapshot event with breakdown fields (verified via flush)', async () => {
      const manager = new NrIngestManager(makeIngestOptions());

      manager.ingestContextSnapshot(makeContextSnapshot(), [makeToolContribution()]);

      manager.start();
      await manager.stop();

      const sentEvents = (mockSendEvents.mock.calls[0] as unknown[])[0] as Array<
        Record<string, unknown>
      >;
      const snapshotEvent = sentEvents.find((e) => e.eventType === 'AiContextSnapshot')!;
      expect(snapshotEvent).toBeDefined();
      expect(snapshotEvent.turn_number).toBe(3);
      expect(snapshotEvent.total_context_tokens).toBe(5000);
      expect(snapshotEvent.fill_percent).toBe(0.25);
      expect(snapshotEvent.system_tokens).toBe(500);
      expect(snapshotEvent.tool_tokens).toBe(2000);
      expect(snapshotEvent.user_tokens).toBe(1500);
      expect(snapshotEvent.assistant_tokens).toBe(1000);
      expect(snapshotEvent.top_tool).toBe('Read');
      expect(snapshotEvent.top_tool_bytes).toBe(4000);
      expect(snapshotEvent.top_tool_tokens).toBe(1000);
    });

    it('omits top_tool fields when topTools is empty', async () => {
      const manager = new NrIngestManager(makeIngestOptions());

      manager.ingestContextSnapshot(makeContextSnapshot(), []);

      manager.start();
      await manager.stop();

      const sentEvents = (mockSendEvents.mock.calls[0] as unknown[])[0] as Array<
        Record<string, unknown>
      >;
      const snapshotEvent = sentEvents.find((e) => e.eventType === 'AiContextSnapshot')!;
      expect(snapshotEvent).not.toHaveProperty('top_tool');
      expect(snapshotEvent).not.toHaveProperty('top_tool_bytes');
      expect(snapshotEvent).not.toHaveProperty('top_tool_tokens');
    });

    it('includes session_id from sessionTraceId when set', async () => {
      const manager = new NrIngestManager({
        ...makeIngestOptions(),
        sessionTraceId: 'trace-abc',
      });

      manager.ingestContextSnapshot(makeContextSnapshot(), []);

      manager.start();
      await manager.stop();

      const sentEvents = (mockSendEvents.mock.calls[0] as unknown[])[0] as Array<
        Record<string, unknown>
      >;
      const snapshotEvent = sentEvents.find((e) => e.eventType === 'AiContextSnapshot')!;
      expect(snapshotEvent.session_id).toBe('trace-abc');
    });
  });

  describe('ingestToolCall() securityAlertToNrEvent wiring', () => {
    it('emits a SecurityAlert event when the audit record carries a security alert', async () => {
      const manager = new NrIngestManager(makeIngestOptions());

      manager.ingestToolCall(makeRecord({ toolName: 'Bash', command: 'rm -rf /' }));

      manager.start();
      await manager.stop();

      const sentEvents = (mockSendEvents.mock.calls[0] as unknown[])[0] as Array<
        Record<string, unknown>
      >;
      // AiToolCall + AiAuditEvent + SecurityAlert
      expect(sentEvents).toHaveLength(3);
      const alertEvent = sentEvents.find((e) => e.eventType === 'SecurityAlert')!;
      expect(alertEvent).toBeDefined();
      expect(alertEvent.severity).toBe('critical');
      expect(alertEvent.alert_type).toBe('destructive_command');
    });

    it('does not emit a SecurityAlert event for a benign tool call', async () => {
      const manager = new NrIngestManager(makeIngestOptions());

      manager.ingestToolCall(makeRecord({ toolName: 'Read', filePath: '/src/index.ts' }));

      manager.start();
      await manager.stop();

      const sentEvents = (mockSendEvents.mock.calls[0] as unknown[])[0] as Array<
        Record<string, unknown>
      >;
      // AiToolCall + AiAuditEvent only
      expect(sentEvents).toHaveLength(2);
      expect(sentEvents.find((e) => e.eventType === 'SecurityAlert')).toBeUndefined();
    });
  });

  describe('start() / stop() lifecycle', () => {
    it('starts and stops without errors', async () => {
      const manager = new NrIngestManager(makeIngestOptions());

      manager.start();
      await manager.stop();
    });

    it('calling start() twice does not create a second session-gauge interval', async () => {
      const manager = new NrIngestManager(makeIngestOptions());

      manager.start();
      const intervalIdAfterFirst = (manager as unknown as { sessionGaugeIntervalId: unknown })
        .sessionGaugeIntervalId;

      manager.start(); // second call — should be a no-op
      const intervalIdAfterSecond = (manager as unknown as { sessionGaugeIntervalId: unknown })
        .sessionGaugeIntervalId;

      expect(intervalIdAfterSecond).toBe(intervalIdAfterFirst);

      await manager.stop();
    });

    it('stop() triggers final flush of events and metrics', async () => {
      const manager = new NrIngestManager(makeIngestOptions());

      manager.ingestToolCall(makeRecord({ toolName: 'Read', durationMs: 50 }));
      manager.ingestToolCall(makeRecord({ toolName: 'Bash', durationMs: 200 }));

      manager.start();
      await manager.stop();

      expect(mockSendEvents).toHaveBeenCalled();
      const sentEvents = (mockSendEvents.mock.calls[0] as unknown[])[0] as Array<
        Record<string, unknown>
      >;
      // 2 AiToolCall + 2 AiAuditEvent = 4 events
      expect(sentEvents).toHaveLength(4);
      const toolCallEvents = sentEvents.filter((e) => e.eventType === 'AiToolCall');
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
      const sentMetrics = (mockSendMetrics.mock.calls[0] as unknown[])[0] as Array<
        Record<string, unknown>
      >;
      const metricNames = sentMetrics.map((m) => m.name);

      expect(metricNames).toContain('ai.session.duration_ms');
      expect(metricNames).toContain('ai.session.unique_files_read');
      expect(metricNames).toContain('ai.session.unique_files_written');
    });

    it('emits ai.feedback.count on stop when a feedbackCollector is provided', async () => {
      const sessionTracker = new SessionTracker('feedback-session');
      const feedbackCollector = new FeedbackCollector();
      feedbackCollector.record({ quality: 'good' });

      const manager = new NrIngestManager(makeIngestOptions({ sessionTracker, feedbackCollector }));

      manager.start();
      await manager.stop();

      expect(mockSendMetrics).toHaveBeenCalled();
      const sentMetrics = (mockSendMetrics.mock.calls[0] as unknown[])[0] as Array<
        Record<string, unknown>
      >;
      const feedbackMetrics = sentMetrics.filter((m) => m.name === 'ai.feedback.count');
      expect(feedbackMetrics).toHaveLength(1);
    });

    it('emitSessionGauges is a no-op after stop()', async () => {
      const sessionTracker = new SessionTracker('stopped-session');
      sessionTracker.recordToolCall(makeRecord({ toolName: 'Read', filePath: '/a.ts' }));

      const manager = new NrIngestManager(makeIngestOptions({ sessionTracker }));

      manager.start();
      await manager.stop();

      // At this point running=false. Calling emitSessionGauges should be a no-op.
      const recordMetricSpy = jest.spyOn(
        (manager as unknown as { scheduler: { recordMetric: (...args: unknown[]) => void } })
          .scheduler,
        'recordMetric',
      );

      (manager as unknown as { emitSessionGauges(): void }).emitSessionGauges();

      expect(recordMetricSpy).not.toHaveBeenCalled();
      recordMetricSpy.mockRestore();
    });

    it('stop() emits final session gauges before marking as stopped', async () => {
      const sessionTracker = new SessionTracker('final-gauge-session');
      sessionTracker.recordToolCall(makeRecord({ toolName: 'Read', filePath: '/x.ts' }));

      const manager = new NrIngestManager(makeIngestOptions({ sessionTracker }));

      manager.start();
      await manager.stop();

      expect(mockSendMetrics).toHaveBeenCalled();
      const sentMetrics = (mockSendMetrics.mock.calls[0] as unknown[])[0] as Array<
        Record<string, unknown>
      >;
      const metricNames = sentMetrics.map((m) => m.name);
      expect(metricNames).toContain('ai.session.duration_ms');
      expect(metricNames).toContain('ai.session.unique_files_read');
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

  describe('retry classification by HTTP status code', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('HTTP 400 — batch is dropped without re-queuing', async () => {
      const localSendEvents = jest
        .fn<() => Promise<{ success: boolean; statusCode: number; retryCount: number }>>()
        .mockResolvedValueOnce({ success: false, statusCode: 400, retryCount: 0 })
        .mockResolvedValue({ success: true, statusCode: 200, retryCount: 0 });

      const manager = new NrIngestManager(
        makeIngestOptions({
          sendEventsFn: localSendEvents,
          eventHarvestIntervalMs: 5_000,
          logHarvestIntervalMs: 100_000,
        }),
      );
      manager.ingestToolCall(makeRecord());
      manager.start();

      // Trigger first harvest tick — sendEvents returns 400; classification wrapper
      // converts to success=true so HarvestScheduler does NOT re-queue the batch.
      await jest.advanceTimersByTimeAsync(5_000);
      expect(localSendEvents).toHaveBeenCalledTimes(1);

      // stop() triggers final flush; retry buffer is empty so no second call.
      await manager.stop();
      expect(localSendEvents).toHaveBeenCalledTimes(1);
    });

    it('HTTP 403 — batch is dropped without re-queuing', async () => {
      const localSendEvents = jest
        .fn<() => Promise<{ success: boolean; statusCode: number; retryCount: number }>>()
        .mockResolvedValueOnce({ success: false, statusCode: 403, retryCount: 0 })
        .mockResolvedValue({ success: true, statusCode: 200, retryCount: 0 });

      const manager = new NrIngestManager(
        makeIngestOptions({
          sendEventsFn: localSendEvents,
          eventHarvestIntervalMs: 5_000,
          logHarvestIntervalMs: 100_000,
        }),
      );
      manager.ingestToolCall(makeRecord());
      manager.start();

      await jest.advanceTimersByTimeAsync(5_000);
      expect(localSendEvents).toHaveBeenCalledTimes(1);

      await manager.stop();
      expect(localSendEvents).toHaveBeenCalledTimes(1);
    });

    it('HTTP 429 — batch is re-queued and delivered on next harvest', async () => {
      const localSendEvents = jest
        .fn<() => Promise<{ success: boolean; statusCode: number; retryCount: number }>>()
        .mockResolvedValueOnce({ success: false, statusCode: 429, retryCount: 3 })
        .mockResolvedValue({ success: true, statusCode: 200, retryCount: 0 });

      const manager = new NrIngestManager(
        makeIngestOptions({
          sendEventsFn: localSendEvents,
          eventHarvestIntervalMs: 5_000,
          logHarvestIntervalMs: 100_000,
        }),
      );
      manager.ingestToolCall(makeRecord());
      manager.start();

      // First tick — sendEvents returns 429; HarvestScheduler re-queues the batch.
      await jest.advanceTimersByTimeAsync(5_000);
      expect(localSendEvents).toHaveBeenCalledTimes(1);

      // stop() final flush picks up the re-queued batch and sends it successfully.
      await manager.stop();
      expect(localSendEvents).toHaveBeenCalledTimes(2);
    });

    it('HTTP 503 — batch is re-queued and delivered on next harvest', async () => {
      const localSendEvents = jest
        .fn<() => Promise<{ success: boolean; statusCode: number; retryCount: number }>>()
        .mockResolvedValueOnce({ success: false, statusCode: 503, retryCount: 3 })
        .mockResolvedValue({ success: true, statusCode: 200, retryCount: 0 });

      const manager = new NrIngestManager(
        makeIngestOptions({
          sendEventsFn: localSendEvents,
          eventHarvestIntervalMs: 5_000,
          logHarvestIntervalMs: 100_000,
        }),
      );
      manager.ingestToolCall(makeRecord());
      manager.start();

      // First tick — sendEvents returns 503; HarvestScheduler re-queues the batch.
      await jest.advanceTimersByTimeAsync(5_000);
      expect(localSendEvents).toHaveBeenCalledTimes(1);

      // stop() final flush picks up the re-queued batch and sends it successfully.
      await manager.stop();
      expect(localSendEvents).toHaveBeenCalledTimes(2);
    });
  });
});

// ---------------------------------------------------------------------------
// codingTaskToNrEvent()
// ---------------------------------------------------------------------------

describe('codingTaskToNrEvent()', () => {
  it('serializes all standard fields with snake_case naming', () => {
    const task = makeTask();
    const event = codingTaskToNrEvent(task, { developer: 'dev1', appName: 'my-app' });

    expect(event.eventType).toBe('AiCodingTask');
    expect(event.task_id).toBe('task-001');
    expect(event.developer).toBe('dev1');
    expect(event.app_name).toBe('my-app');
    expect(event.duration_ms).toBe(60_000);
    expect(event.tool_call_count).toBe(3);
    expect(event.lines_added).toBe(15);
    expect(event.lines_removed).toBe(5);
    expect(event.bash_commands_run).toBe(1);
    expect(event.tests_run).toBe(2);
    expect(event.tests_passed).toBe(2);
    expect(event.build_run).toBe(1);
    expect(event.build_passed).toBe(1);
    expect(event.estimated_cost_usd).toBe(0.004);
    expect(event.tokens_used).toBe(1200);
    expect(event.asked_user_questions).toBe(0);
    expect(event.sub_agents_spawned).toBe(0);
  });

  it('emits files_read and files_modified as counts, not arrays', () => {
    const task = makeTask({ filesRead: ['/a.ts', '/b.ts', '/c.ts'], filesModified: ['/b.ts'] });
    const event = codingTaskToNrEvent(task, { developer: 'd', appName: 'a' });

    expect(event.files_read).toBe(3);
    expect(event.files_modified).toBe(1);
  });

  it('preserves timestamps in milliseconds', () => {
    const task = makeTask({ endTime: 1_700_000_060_000, startTime: 1_700_000_000_000 });
    const event = codingTaskToNrEvent(task, { developer: 'd', appName: 'a' });

    expect(event.timestamp).toBe(1_700_000_060_000);
    expect(event.start_time).toBe(1_700_000_000_000);
    expect(event.end_time).toBe(1_700_000_060_000);
  });

  it('sets session_id from the resolved sessionTraceId, not the tool call record (Fix 3)', () => {
    const task = makeTask({
      toolCalls: [makeRecord({ sessionId: 'sess-from-record' })],
    });
    // No sessionTraceId provided — Fix 3 removes the fallback to firstRecord.sessionId
    // because the MCP no longer fabricates its own ID; the resolved Claude Code
    // session_id is shared across all events of a session.
    const event = codingTaskToNrEvent(task, { developer: 'd', appName: 'a' });

    expect(event).not.toHaveProperty('session_id');

    const eventWithTrace = codingTaskToNrEvent(task, {
      developer: 'd',
      appName: 'a',
      sessionTraceId: 'real-claude-session-id',
    });
    expect(eventWithTrace.session_id).toBe('real-claude-session-id');
  });

  it('omits session_id when tool calls array is empty', () => {
    const task = makeTask({ toolCalls: [] });
    const event = codingTaskToNrEvent(task, { developer: 'd', appName: 'a' });

    expect(event).not.toHaveProperty('session_id');
  });

  it('sets estimated_cost_usd to 0 when estimatedCostUsd is null', () => {
    const task = makeTask({ estimatedCostUsd: null });
    const event = codingTaskToNrEvent(task, { developer: 'd', appName: 'a' });

    expect(event.estimated_cost_usd).toBe(0);
  });

  it('reads platform from the first tool call record', () => {
    const task = makeTask({
      toolCalls: [makeRecord({ platform: 'cursor' } as Partial<ToolCallRecord>)],
    });
    const event = codingTaskToNrEvent(task, { developer: 'd', appName: 'a' });

    expect(event.platform).toBe('cursor');
  });

  it('defaults platform to claude-code when tool calls are empty', () => {
    const task = makeTask({ toolCalls: [] });
    const event = codingTaskToNrEvent(task, { developer: 'd', appName: 'a' });

    expect(event.platform).toBe('claude-code');
  });
});

// ---------------------------------------------------------------------------
// NrIngestManager.ingestCodingTask()
// ---------------------------------------------------------------------------

describe('NrIngestManager.ingestCodingTask()', () => {
  it('queues an AiCodingTask event that is flushed on stop()', async () => {
    const manager = new NrIngestManager(makeIngestOptions());

    manager.ingestCodingTask(makeTask());
    manager.start();
    await manager.stop();

    expect(mockSendEvents).toHaveBeenCalled();
    const sentEvents = (mockSendEvents.mock.calls[0] as unknown[])[0] as Array<
      Record<string, unknown>
    >;
    const taskEvent = sentEvents.find((e) => e.eventType === 'AiCodingTask');
    expect(taskEvent).toBeDefined();
    expect(taskEvent!.task_id).toBe('task-001');
    expect(taskEvent!.estimated_cost_usd).toBe(0.004);
  });

  it('task event is queued alongside AiToolCall events in the same batch', async () => {
    const manager = new NrIngestManager(makeIngestOptions());

    manager.ingestToolCall(makeRecord({ toolName: 'Read' }));
    manager.ingestCodingTask(makeTask());
    manager.start();
    await manager.stop();

    const sentEvents = (mockSendEvents.mock.calls[0] as unknown[])[0] as Array<
      Record<string, unknown>
    >;
    const eventTypes = sentEvents.map((e) => e.eventType);
    expect(eventTypes).toContain('AiToolCall');
    expect(eventTypes).toContain('AiCodingTask');
  });
});

// ---------------------------------------------------------------------------
// antiPatternToNrEvent()
// ---------------------------------------------------------------------------

describe('antiPatternToNrEvent()', () => {
  it('serializes required fields', () => {
    const pattern = makePattern();
    const event = antiPatternToNrEvent(pattern, {
      developer: 'dev1',
      appName: 'my-app',
      sessionId: 'sess-001',
      platform: 'claude-code',
      taskId: 'task-001',
    });

    expect(event.eventType).toBe('AiAntiPattern');
    expect(event.type).toBe('thrashing');
    expect(event.task_id).toBe('task-001');
    expect(event.developer).toBe('dev1');
    expect(event.app_name).toBe('my-app');
    expect(event.platform).toBe('claude-code');
    expect(event.session_id).toBe('sess-001');
    expect(event.suggestion).toBe('Consider reviewing your approach before retrying');
  });

  it('omits optional fields when undefined', () => {
    const pattern = makePattern({ type: 're_reading' });
    const event = antiPatternToNrEvent(pattern, {
      developer: 'd',
      appName: 'a',
      taskId: 'task-002',
    });

    expect(event).not.toHaveProperty('session_id');
    expect(event).not.toHaveProperty('file');
    expect(event).not.toHaveProperty('command');
    expect(event).not.toHaveProperty('iterations');
    expect(event).not.toHaveProperty('read_count');
    expect(event).not.toHaveProperty('repeat_count');
    expect(event).not.toHaveProperty('edit_count');
    expect(event).not.toHaveProperty('agent_count');
  });

  it('includes optional fields when defined', () => {
    const pattern = makePattern({
      type: 'thrashing',
      file: '/src/foo.ts',
      iterations: 4,
    });
    const event = antiPatternToNrEvent(pattern, {
      developer: 'd',
      appName: 'a',
      taskId: 'task-003',
    });

    expect(event.file).toBe('/src/foo.ts');
    expect(event.iterations).toBe(4);
  });

  it('maps readCount to read_count and repeatCount to repeat_count', () => {
    const pattern = makePattern({ type: 're_reading', readCount: 5, repeatCount: 3 });
    const event = antiPatternToNrEvent(pattern, {
      developer: 'd',
      appName: 'a',
      taskId: 'task-004',
    });

    expect(event.read_count).toBe(5);
    expect(event.repeat_count).toBe(3);
    expect(event).not.toHaveProperty('readCount');
    expect(event).not.toHaveProperty('repeatCount');
  });

  it('maps editCount to edit_count and agentCount to agent_count', () => {
    const pattern = makePattern({ type: 'blind_editing', editCount: 6, agentCount: 2 });
    const event = antiPatternToNrEvent(pattern, {
      developer: 'd',
      appName: 'a',
      taskId: 'task-005',
    });

    expect(event.edit_count).toBe(6);
    expect(event.agent_count).toBe(2);
  });

  it('defaults platform to claude-code when not provided', () => {
    const event = antiPatternToNrEvent(makePattern(), {
      developer: 'd',
      appName: 'a',
      taskId: 'task-006',
    });

    expect(event.platform).toBe('claude-code');
  });

  it('redacts secrets in pattern.file and pattern.command', () => {
    const SECRET_TOKEN = 'sk-test-deadbeef0123456789abcdef0123456789';
    const pattern = makePattern({
      type: 'thrashing',
      file: `/src/foo.ts?token=${SECRET_TOKEN}`,
      command: `curl -H "Authorization: Bearer ${SECRET_TOKEN}"`,
    });

    const event = antiPatternToNrEvent(pattern, {
      developer: 'd',
      appName: 'a',
      taskId: 'task-redact',
    });

    expect(event.file as string).not.toContain(SECRET_TOKEN);
    expect(event.command as string).not.toContain(SECRET_TOKEN);
    expect(event.file as string).toContain('[REDACTED]');
    expect(event.command as string).toContain('[REDACTED]');
  });

  it('timestamp is in milliseconds', () => {
    const before = Date.now();
    const event = antiPatternToNrEvent(makePattern(), {
      developer: 'd',
      appName: 'a',
      taskId: 'task-007',
    });
    const after = Date.now();

    expect(event.timestamp as number).toBeGreaterThanOrEqual(before);
    expect(event.timestamp as number).toBeLessThanOrEqual(after);
  });
});

// ---------------------------------------------------------------------------
// NrIngestManager.ingestAntiPattern()
// ---------------------------------------------------------------------------

describe('NrIngestManager.ingestAntiPattern()', () => {
  it('queues an AiAntiPattern event that is flushed on stop()', async () => {
    const manager = new NrIngestManager(makeIngestOptions());

    manager.ingestAntiPattern(makePattern({ type: 'stuck_loop' }), {
      sessionId: 'sess-001',
      platform: 'claude-code',
      taskId: 'task-001',
    });
    manager.start();
    await manager.stop();

    expect(mockSendEvents).toHaveBeenCalled();
    const sentEvents = (mockSendEvents.mock.calls[0] as unknown[])[0] as Array<
      Record<string, unknown>
    >;
    const patternEvent = sentEvents.find((e) => e.eventType === 'AiAntiPattern');
    expect(patternEvent).toBeDefined();
    expect(patternEvent!.type).toBe('stuck_loop');
    expect(patternEvent!.task_id).toBe('task-001');
  });

  it('a task with no detected patterns emits zero AiAntiPattern events', async () => {
    const manager = new NrIngestManager(makeIngestOptions());

    // Ingest a coding task but no anti-patterns
    manager.ingestCodingTask(makeTask());
    manager.start();
    await manager.stop();

    const sentEvents = (mockSendEvents.mock.calls[0] as unknown[])[0] as Array<
      Record<string, unknown>
    >;
    const patternEvents = sentEvents.filter((e) => e.eventType === 'AiAntiPattern');
    expect(patternEvents).toHaveLength(0);
  });

  it('multiple patterns for the same task are all queued', async () => {
    const manager = new NrIngestManager(makeIngestOptions());
    const context = { sessionId: 'sess-001', platform: 'claude-code', taskId: 'task-001' };

    manager.ingestAntiPattern(makePattern({ type: 'thrashing' }), context);
    manager.ingestAntiPattern(makePattern({ type: 're_reading' }), context);
    manager.start();
    await manager.stop();

    const sentEvents = (mockSendEvents.mock.calls[0] as unknown[])[0] as Array<
      Record<string, unknown>
    >;
    const patternEvents = sentEvents.filter((e) => e.eventType === 'AiAntiPattern');
    expect(patternEvents).toHaveLength(2);
    const types = patternEvents.map((e) => e.type);
    expect(types).toContain('thrashing');
    expect(types).toContain('re_reading');
  });
});

// ---------------------------------------------------------------------------
// Session trace ID propagation
// ---------------------------------------------------------------------------

describe('session trace ID propagation', () => {
  const TRACE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  it('toolCallToNrEvent: uses sessionTraceId when provided, ignoring record.sessionId', () => {
    const record = makeRecord({ sessionId: 'old-session-id' });
    const event = toolCallToNrEvent(record, {
      developer: 'dev',
      appName: 'app',
      sessionTraceId: TRACE_ID,
    });
    expect(event.session_id).toBe(TRACE_ID);
  });

  it('toolCallToNrEvent: omits session_id when neither sessionTraceId nor record.sessionId is set', () => {
    const record = makeRecord({ sessionId: undefined });
    const event = toolCallToNrEvent(record, { developer: 'dev', appName: 'app' });
    expect(event.session_id).toBeUndefined();
  });

  it('codingTaskToNrEvent: uses sessionTraceId when provided', () => {
    const task = makeTask();
    const event = codingTaskToNrEvent(task, {
      developer: 'dev',
      appName: 'app',
      sessionTraceId: TRACE_ID,
    });
    expect(event.session_id).toBe(TRACE_ID);
  });

  it('codingTaskToNrEvent: omits session_id when sessionTraceId is absent (Fix 3 removes record fallback)', () => {
    const task = makeTask({
      toolCalls: [makeRecord({ sessionId: 'record-session-id' })],
    });
    const event = codingTaskToNrEvent(task, { developer: 'dev', appName: 'app' });
    // Fix 3: no longer falls back to firstRecord.sessionId. The resolved
    // sessionTraceId is the single source of truth for session_id on events.
    expect(event).not.toHaveProperty('session_id');
  });

  it('antiPatternToNrEvent: emits session_id from attrs.sessionId', () => {
    const pattern = makePattern();
    const event = antiPatternToNrEvent(pattern, {
      developer: 'dev',
      appName: 'app',
      sessionId: TRACE_ID,
      taskId: 'task-1',
    });
    expect(event.session_id).toBe(TRACE_ID);
  });

  it('NrIngestManager.ingestToolCall: emits sessionTraceId as session_id on AiToolCall event', async () => {
    const manager = new NrIngestManager({
      ...makeIngestOptions(),
      sessionTraceId: TRACE_ID,
    });
    manager.ingestToolCall(makeRecord({ sessionId: 'old-id' }));
    manager.start();
    await manager.stop();

    const sentEvents = (mockSendEvents.mock.calls[0] as unknown[])[0] as Array<
      Record<string, unknown>
    >;
    const toolCallEvent = sentEvents.find((e) => e.eventType === 'AiToolCall');
    expect(toolCallEvent?.session_id).toBe(TRACE_ID);
  });

  it('NrIngestManager.ingestAntiPattern: sessionTraceId takes precedence over context.sessionId', async () => {
    const manager = new NrIngestManager({
      ...makeIngestOptions(),
      sessionTraceId: TRACE_ID,
    });
    manager.ingestAntiPattern(makePattern(), { sessionId: 'context-id', taskId: 'task-1' });
    manager.start();
    await manager.stop();

    const sentEvents = (mockSendEvents.mock.calls[0] as unknown[])[0] as Array<
      Record<string, unknown>
    >;
    const patternEvent = sentEvents.find((e) => e.eventType === 'AiAntiPattern');
    expect(patternEvent?.session_id).toBe(TRACE_ID);
  });

  it('isProxyToolCall: returns true for valid proxy record', () => {
    const record = makeProxyRecord();
    expect(isProxyToolCall(record)).toBe(true);
  });

  it('isProxyToolCall: returns false when serverName is null', () => {
    const record = makeProxyRecord({ serverName: null as unknown as string });
    expect(isProxyToolCall(record)).toBe(false);
  });

  it('isProxyToolCall: returns false when serverName is not a string', () => {
    const record = makeProxyRecord({ serverName: 123 as unknown as string });
    expect(isProxyToolCall(record)).toBe(false);
  });

  it('isProxyToolCall: returns false when upstreamLatencyMs is null', () => {
    const record = makeProxyRecord({ upstreamLatencyMs: null as unknown as number });
    expect(isProxyToolCall(record)).toBe(false);
  });

  it('isProxyToolCall: returns false when upstreamLatencyMs is not a number', () => {
    const record = makeProxyRecord({ upstreamLatencyMs: 'broken' as unknown as number });
    expect(isProxyToolCall(record)).toBe(false);
  });

  it('isProxyToolCall: returns false when serverName is missing', () => {
    const record = makeRecord({ upstreamLatencyMs: 10 } as Partial<ToolCallRecord>);
    expect(isProxyToolCall(record)).toBe(false);
  });

  it('isProxyToolCall: returns false when upstreamLatencyMs is missing', () => {
    const record = makeRecord({ serverName: 'test-server' } as Partial<ToolCallRecord>);
    expect(isProxyToolCall(record)).toBe(false);
  });

  it('proxyToolCallToNrEvent: uses sessionTraceId when provided', () => {
    const record = makeProxyRecord({ sessionId: 'old-session-id' });
    const event = proxyToolCallToNrEvent(record, {
      developer: 'dev',
      appName: 'app',
      sessionTraceId: TRACE_ID,
    });
    expect(event.session_id).toBe(TRACE_ID);
  });

  it('proxyToolCallToNrEvent: omits session_id when neither sessionTraceId nor record.sessionId is set', () => {
    const record = makeProxyRecord({ sessionId: undefined });
    const event = proxyToolCallToNrEvent(record, { developer: 'dev', appName: 'app' });
    expect(event.session_id).toBeUndefined();
  });

  it('NrIngestManager.ingestBudgetWarning: emits session_id from sessionTraceId', async () => {
    const manager = new NrIngestManager({
      ...makeIngestOptions(),
      sessionTraceId: TRACE_ID,
    });
    manager.ingestBudgetWarning({
      period: 'session',
      thresholdPct: 80,
      spentUsd: 8,
      budgetUsd: 10,
      timestamp: Date.now(),
    });
    manager.start();
    await manager.stop();

    const sentEvents = (mockSendEvents.mock.calls[0] as unknown[])[0] as Array<
      Record<string, unknown>
    >;
    const budgetEvent = sentEvents.find((e) => e.eventType === 'AiBudgetWarning');
    expect(budgetEvent?.session_id).toBe(TRACE_ID);
  });

  it('NrIngestManager.ingestBudgetWarning: omits session_id when no sessionTraceId', async () => {
    const manager = new NrIngestManager(makeIngestOptions());
    manager.ingestBudgetWarning({
      period: 'daily',
      thresholdPct: 100,
      spentUsd: 10,
      budgetUsd: 10,
      timestamp: Date.now(),
    });
    manager.start();
    await manager.stop();

    const sentEvents = (mockSendEvents.mock.calls[0] as unknown[])[0] as Array<
      Record<string, unknown>
    >;
    const budgetEvent = sentEvents.find((e) => e.eventType === 'AiBudgetWarning');
    expect(budgetEvent?.session_id).toBeUndefined();
  });

  it('toolCallToNrEvent: includes team_id when teamId is non-null', () => {
    const record = makeRecord();
    const event = toolCallToNrEvent(record, {
      developer: 'dev',
      appName: 'app',
      teamId: 'engineering',
    });
    expect(event.team_id).toBe('engineering');
  });

  it('toolCallToNrEvent: omits team_id when teamId is null', () => {
    const record = makeRecord();
    const event = toolCallToNrEvent(record, {
      developer: 'dev',
      appName: 'app',
      teamId: null,
    });
    expect(event.team_id).toBeUndefined();
  });

  it('toolCallToNrEvent: includes project_id when projectId is non-null', () => {
    const record = makeRecord();
    const event = toolCallToNrEvent(record, {
      developer: 'dev',
      appName: 'app',
      projectId: 'myorg/myrepo',
    });
    expect(event.project_id).toBe('myorg/myrepo');
  });

  it('toolCallToNrEvent: omits project_id when projectId is null', () => {
    const record = makeRecord();
    const event = toolCallToNrEvent(record, {
      developer: 'dev',
      appName: 'app',
      projectId: null,
    });
    expect(event.project_id).toBeUndefined();
  });

  it('toolCallToNrEvent: includes org_id when orgId is non-null', () => {
    const record = makeRecord();
    const event = toolCallToNrEvent(record, {
      developer: 'dev',
      appName: 'app',
      orgId: 'acme-corp',
    });
    expect(event.org_id).toBe('acme-corp');
  });

  it('toolCallToNrEvent: omits org_id when orgId is null', () => {
    const record = makeRecord();
    const event = toolCallToNrEvent(record, {
      developer: 'dev',
      appName: 'app',
      orgId: null,
    });
    expect(event.org_id).toBeUndefined();
  });
});
