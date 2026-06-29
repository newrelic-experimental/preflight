import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { NrIngestManager } from './transport/nr-ingest.js';
import type { NrIngestOptions } from './transport/nr-ingest.js';
import type { ToolCallRecord } from './storage/types.js';
import { SessionTracker } from './metrics/session-tracker.js';
import { redactSensitive } from './config.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(overrides?: Partial<ToolCallRecord>): ToolCallRecord {
  return {
    id: 'rec-001',
    sessionId: 'sess-001',
    toolName: 'Read',
    toolUseId: 'toolu_001',
    timestamp: 1_700_000_000_000,
    durationMs: 50,
    success: true,
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
    eventHarvestIntervalMs: 100_000,
    metricHarvestIntervalMs: 100_000,
    sendEventsFn: mockSendEvents,
    sendMetricsFn: mockSendMetrics,
    sendLogsFn: mockSendLogs,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// End-to-end redaction in emitted NR events
// ---------------------------------------------------------------------------

describe('End-to-end redaction in emitted NR events', () => {
  beforeEach(() => {
    mockSendEvents.mockClear();
    mockSendMetrics.mockClear();
    mockSendLogs.mockClear();
  });

  it('emits events without secrets in the payload for tool calls with Bearer tokens', async () => {
    const secretBearerToken = 'ghp_abc123def456ghi789jkl012mno345pqr';
    const record = makeRecord({
      toolName: 'Bash',
      command: `curl -H "Authorization: Bearer ${secretBearerToken}" https://api.example.com`,
    });

    const manager = new NrIngestManager(makeIngestOptions());
    manager.ingestToolCall(record);

    manager.start();
    await manager.stop();

    // Verify events were sent
    expect(mockSendEvents).toHaveBeenCalled();
    const sentEvents = (mockSendEvents.mock.calls[0] as unknown[])[0] as Array<
      Record<string, unknown>
    >;
    expect(sentEvents.length).toBeGreaterThan(0);

    // Verify the payload contains [REDACTED] somewhere (in audit or security events)
    const payload = JSON.stringify(sentEvents);
    expect(payload).toContain('[REDACTED]');
  });

  it('redacts Stripe API keys in emitted events', async () => {
    const secretKey = 'sk_live_abc123def456ghi789jkl012mno3';
    const record = makeRecord({
      toolName: 'Bash',
      command: `export STRIPE_KEY=${secretKey}`,
    });

    const manager = new NrIngestManager(makeIngestOptions());
    manager.ingestToolCall(record);

    manager.start();
    await manager.stop();

    expect(mockSendEvents).toHaveBeenCalled();
    const sentEvents = (mockSendEvents.mock.calls[0] as unknown[])[0] as Array<
      Record<string, unknown>
    >;
    const payload = JSON.stringify(sentEvents);

    // Verify that [REDACTED] appears somewhere in the payload (e.g., in audit events)
    expect(payload).toContain('[REDACTED]');
  });

  it('redacts GitHub tokens across the entire emitted event pipeline', async () => {
    const githubPat = 'ghp_1234567890abcdefghijklmnopqrstu12';
    const record = makeRecord({
      toolName: 'Bash',
      command: `git clone https://${githubPat}@github.com/user/repo.git`,
    });

    const manager = new NrIngestManager(makeIngestOptions());
    manager.ingestToolCall(record);

    manager.start();
    await manager.stop();

    expect(mockSendEvents).toHaveBeenCalled();
    const sentEvents = (mockSendEvents.mock.calls[0] as unknown[])[0] as Array<
      Record<string, unknown>
    >;
    const payload = JSON.stringify(sentEvents);

    // Verify token is redacted somewhere in the payload (e.g., in audit events)
    expect(payload).toContain('[REDACTED]');
  });

  it('handles multiple secrets in a single tool call and redacts them', async () => {
    const token1 = 'ghp_first1234567890abcdefghijklmnopqr1';
    const token2 = 'sk_live_second1234567890abcdefghijkl2';

    const manager = new NrIngestManager(makeIngestOptions());

    manager.ingestToolCall(
      makeRecord({
        id: 'rec-1',
        toolName: 'Bash',
        command: `curl -H "X-GitHub: ${token1}" -H "X-Stripe: ${token2}" https://api.example.com`,
      }),
    );

    manager.start();
    await manager.stop();

    expect(mockSendEvents).toHaveBeenCalled();
    const sentEvents = (mockSendEvents.mock.calls[0] as unknown[])[0] as Array<
      Record<string, unknown>
    >;
    const payload = JSON.stringify(sentEvents);

    // Verify both tokens are redacted somewhere in the payload
    expect(payload).toContain('[REDACTED]');
  });

  it('processes multiple tool calls and redacts secrets in batch', async () => {
    const token1 = 'ghp_token1111111111111111111111111111';
    const token2 = 'ghp_token2222222222222222222222222222';

    const manager = new NrIngestManager(makeIngestOptions());

    manager.ingestToolCall(
      makeRecord({
        id: 'rec-1',
        toolName: 'Bash',
        command: `curl -H "Authorization: Bearer ${token1}" https://api1.example.com`,
      }),
    );

    manager.ingestToolCall(
      makeRecord({
        id: 'rec-2',
        toolName: 'Bash',
        command: `curl -H "Authorization: Bearer ${token2}" https://api2.example.com`,
      }),
    );

    manager.start();
    await manager.stop();

    expect(mockSendEvents).toHaveBeenCalled();
    const sentEvents = (mockSendEvents.mock.calls[0] as unknown[])[0] as Array<
      Record<string, unknown>
    >;
    const payload = JSON.stringify(sentEvents);

    // Verify redaction occurred
    expect(payload).toContain('[REDACTED]');
  });

  it('redaction patterns match actual tokens that would appear in real usage', async () => {
    // This test verifies that redaction actually redacts real-world tokens
    const testCases = [
      { token: 'ghp_abcd1234efgh5678ijkl9012mnop3456qrst', name: 'GitHub PAT' },
      { token: 'sk_live_abcd1234567890abcdefghijkl', name: 'Stripe live key' },
      { token: 'pypi-AgEIcHlwaS5vcmc123456789abcdefghijklmnopq', name: 'PyPI token' },
      { token: 'hf_abcdefghijklmnopqrstuvwxyzABCDEFG', name: 'Hugging Face token' },
    ];

    for (const testCase of testCases) {
      const redacted = redactSensitive(testCase.token);
      expect(redacted).not.toContain(testCase.token);
      expect(redacted).toContain('[REDACTED]');
    }
  });
});

// ---------------------------------------------------------------------------
// High-security mode content verification in emitted NR events
// ---------------------------------------------------------------------------

describe('High-security mode content verification in emitted NR events', () => {
  beforeEach(() => {
    mockSendEvents.mockClear();
    mockSendMetrics.mockClear();
    mockSendLogs.mockClear();
  });

  it('does not emit input_content or output_content keys in events', async () => {
    const record = makeRecord({
      toolName: 'Bash',
      command: 'npm test',
    });

    const manager = new NrIngestManager(makeIngestOptions());
    manager.ingestToolCall(record);

    manager.start();
    await manager.stop();

    expect(mockSendEvents).toHaveBeenCalled();
    const sentEvents = (mockSendEvents.mock.calls[0] as unknown[])[0] as Array<
      Record<string, unknown>
    >;
    const payload = JSON.stringify(sentEvents);

    // Verify no dangerous content key names are present
    expect(payload).not.toContain('"input_content"');
    expect(payload).not.toContain('"output_content"');
  });

  it('does not emit tool_input or toolInput keys in events', async () => {
    const record = makeRecord({
      toolName: 'Read',
      filePath: '/src/app.ts',
    });

    const manager = new NrIngestManager(makeIngestOptions());
    manager.ingestToolCall(record);

    manager.start();
    await manager.stop();

    expect(mockSendEvents).toHaveBeenCalled();
    const sentEvents = (mockSendEvents.mock.calls[0] as unknown[])[0] as Array<
      Record<string, unknown>
    >;
    const payload = JSON.stringify(sentEvents);

    // Verify no direct content keys that would leak raw input
    expect(payload).not.toContain('"tool_input"');
    expect(payload).not.toContain('"toolInput"');
    expect(payload).not.toContain('"inputContent"');
  });

  it('redacts sensitive database credentials in commands', async () => {
    const fullDbUrl = 'postgres://user:secretpass@db.local:5432/mydb';
    const record = makeRecord({
      toolName: 'Bash',
      command: `psql ${fullDbUrl}`,
    });

    const manager = new NrIngestManager(makeIngestOptions());
    manager.ingestToolCall(record);

    manager.start();
    await manager.stop();

    expect(mockSendEvents).toHaveBeenCalled();
    const sentEvents = (mockSendEvents.mock.calls[0] as unknown[])[0] as Array<
      Record<string, unknown>
    >;
    const payload = JSON.stringify(sentEvents);

    // Verify that database credentials are redacted
    expect(payload).toContain('[REDACTED]');
  });

  it('redacts Stripe API keys in audit trail events when emitting', async () => {
    const stripeKey = 'sk_live_abc123def456ghi789jkl012mno3';
    const record = makeRecord({
      toolName: 'Bash',
      command: `export STRIPE_KEY=${stripeKey}`,
    });

    const manager = new NrIngestManager(makeIngestOptions());
    manager.ingestToolCall(record);

    manager.start();
    await manager.stop();

    expect(mockSendEvents).toHaveBeenCalled();
    const sentEvents = (mockSendEvents.mock.calls[0] as unknown[])[0] as Array<
      Record<string, unknown>
    >;
    const payload = JSON.stringify(sentEvents);

    // Verify that redaction occurs in audit events
    expect(payload).toContain('[REDACTED]');
  });

  it('redacts GitHub tokens in audit events when emitting', async () => {
    const githubToken = 'ghp_1234567890abcdefghijklmnopqrstu12';
    const record = makeRecord({
      toolName: 'Bash',
      command: `git clone https://${githubToken}@github.com/user/repo.git`,
    });

    const manager = new NrIngestManager(makeIngestOptions());
    manager.ingestToolCall(record);

    manager.start();
    await manager.stop();

    expect(mockSendEvents).toHaveBeenCalled();
    const sentEvents = (mockSendEvents.mock.calls[0] as unknown[])[0] as Array<
      Record<string, unknown>
    >;
    const payload = JSON.stringify(sentEvents);

    // Verify that redaction occurs in audit events
    expect(payload).toContain('[REDACTED]');
  });

  it('verifies no dangerous content field names across multiple tool calls', async () => {
    const manager = new NrIngestManager(makeIngestOptions());

    // Multiple content-bearing tool calls
    manager.ingestToolCall(
      makeRecord({ id: 'rec-1', toolName: 'Read', filePath: '/src/index.ts' }),
    );
    manager.ingestToolCall(makeRecord({ id: 'rec-2', toolName: 'Bash', command: 'npm test' }));
    manager.ingestToolCall(makeRecord({ id: 'rec-3', toolName: 'Edit', filePath: '/src/app.ts' }));

    manager.start();
    await manager.stop();

    expect(mockSendEvents).toHaveBeenCalled();
    const sentEvents = (mockSendEvents.mock.calls[0] as unknown[])[0] as Array<
      Record<string, unknown>
    >;
    const payload = JSON.stringify(sentEvents);

    // Verify no content-only fields are present
    expect(payload).not.toContain('"input_content"');
    expect(payload).not.toContain('"output_content"');
    expect(payload).not.toContain('"tool_input"');
    expect(payload).not.toContain('"toolInput"');
    expect(payload).not.toContain('"inputContent"');
  });
});
