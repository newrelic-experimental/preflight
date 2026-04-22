import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { auditRecordToLogEntry, LogIngestManager } from './log-ingest.js';
import type { LogIngestOptions } from './log-ingest.js';
import type { AuditRecord } from '../security/audit-trail.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAuditRecord(overrides?: Partial<AuditRecord>): AuditRecord {
  return {
    timestamp: 1_700_000_000_000,
    sessionId: 'sess-001',
    action: 'FileRead',
    tool: 'Read',
    detail: 'Read /src/index.ts',
    developer: 'alice',
    ...overrides,
  };
}

const mockSendLogs = jest.fn<() => Promise<{ success: boolean; statusCode: number; retryCount: number }>>()
  .mockResolvedValue({ success: true, statusCode: 200, retryCount: 0 });

function makeLogIngestOptions(overrides?: Partial<LogIngestOptions>): LogIngestOptions {
  return {
    licenseKey: 'test-license-key',
    transportOptions: { accountId: '12345' },
    developer: 'test-dev',
    appName: 'test-app',
    logHarvestIntervalMs: 100_000, // long enough to not fire in tests
    sendLogsFn: mockSendLogs,
    ...overrides,
  };
}

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  mockSendLogs.mockClear();
});

afterEach(() => {
  stderrSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// auditRecordToLogEntry()
// ---------------------------------------------------------------------------

describe('auditRecordToLogEntry()', () => {
  it('converts a normal audit record to a log entry', () => {
    const record = makeAuditRecord();
    const entry = auditRecordToLogEntry(record, 'my-app');

    expect(entry.timestamp).toBe(1_700_000_000_000);
    expect(entry.message).toBe('Read /src/index.ts');
    expect(entry.attributes).toEqual({
      tool: 'Read',
      developer: 'alice',
      app_name: 'my-app',
      session_id: 'sess-001',
      'audit.action': 'FileRead',
      'audit.security_alert': false,
    });
  });

  it('includes security alert attributes when flagged', () => {
    const record = makeAuditRecord({
      action: 'BashCommand',
      tool: 'Bash',
      detail: 'Bash: rm -rf /tmp/build',
      command: 'rm -rf /tmp/build',
      securityAlert: {
        severity: 'critical',
        alertType: 'destructive_command',
        description: 'Destructive command detected: rm -rf /tmp/build',
      },
    });

    const entry = auditRecordToLogEntry(record, 'my-app');

    expect(entry.attributes!['audit.security_alert']).toBe(true);
    expect(entry.attributes!['audit.severity']).toBe('critical');
    expect(entry.attributes!['audit.alert_type']).toBe('destructive_command');
    expect(entry.attributes!['audit.command']).toBe('rm -rf /tmp/build');
  });

  it('omits session_id when null', () => {
    const record = makeAuditRecord({ sessionId: null });
    const entry = auditRecordToLogEntry(record, 'my-app');

    expect(entry.attributes).not.toHaveProperty('session_id');
  });
});

// ---------------------------------------------------------------------------
// LogIngestManager
// ---------------------------------------------------------------------------

describe('LogIngestManager', () => {
  it('buffers log entries and flushes on stop', async () => {
    const manager = new LogIngestManager(makeLogIngestOptions());

    manager.addAuditRecord(makeAuditRecord({ tool: 'Read', detail: 'Read /a.ts' }));
    manager.addAuditRecord(makeAuditRecord({ tool: 'Edit', detail: 'Edit /b.ts', action: 'FileEdit' }));

    manager.start();
    await manager.stop();

    expect(mockSendLogs).toHaveBeenCalledTimes(1);
    const sentLogs = (mockSendLogs.mock.calls[0] as unknown[])[0] as Array<Record<string, unknown>>;
    expect(sentLogs).toHaveLength(2);
    expect(sentLogs[0]!.message).toBe('Read /a.ts');
    expect(sentLogs[1]!.message).toBe('Edit /b.ts');
  });

  it('stop() triggers final flush', async () => {
    const manager = new LogIngestManager(makeLogIngestOptions());

    manager.addAuditRecord(makeAuditRecord());

    manager.start();
    await manager.stop();

    expect(mockSendLogs).toHaveBeenCalled();
  });

  it('sends multiple entries as a single batch', async () => {
    const manager = new LogIngestManager(makeLogIngestOptions());

    for (let i = 0; i < 15; i++) {
      manager.addAuditRecord(makeAuditRecord({ detail: `Entry ${i}` }));
    }

    manager.start();
    await manager.stop();

    expect(mockSendLogs).toHaveBeenCalledTimes(1);
    const sentLogs = (mockSendLogs.mock.calls[0] as unknown[])[0] as Array<Record<string, unknown>>;
    expect(sentLogs).toHaveLength(15);
  });

  it('re-queues batch when sendLogsFn returns failure', async () => {
    mockSendLogs
      .mockResolvedValueOnce({ success: false, statusCode: 500, retryCount: 0 })
      .mockResolvedValueOnce({ success: true, statusCode: 200, retryCount: 0 });

    const manager = new LogIngestManager(makeLogIngestOptions());
    manager.addAuditRecord(makeAuditRecord({ detail: 'important log' }));

    await manager.flush();
    expect(mockSendLogs).toHaveBeenCalledTimes(1);

    // Batch should be re-queued — flush again succeeds
    await manager.flush();
    expect(mockSendLogs).toHaveBeenCalledTimes(2);
    const sentLogs = (mockSendLogs.mock.calls[1] as unknown[])[0] as Array<Record<string, unknown>>;
    expect(sentLogs).toHaveLength(1);
    expect(sentLogs[0]!.message).toBe('important log');
  });

  it('re-queues batch when sendLogsFn throws', async () => {
    mockSendLogs
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockResolvedValueOnce({ success: true, statusCode: 200, retryCount: 0 });

    const manager = new LogIngestManager(makeLogIngestOptions());
    manager.addAuditRecord(makeAuditRecord({ detail: 'critical event' }));

    await manager.flush();
    expect(mockSendLogs).toHaveBeenCalledTimes(1);

    // Re-queued batch retries successfully
    await manager.flush();
    expect(mockSendLogs).toHaveBeenCalledTimes(2);
    const sentLogs = (mockSendLogs.mock.calls[1] as unknown[])[0] as Array<Record<string, unknown>>;
    expect(sentLogs).toHaveLength(1);
    expect(sentLogs[0]!.message).toBe('critical event');
  });

  it('caps buffer at maxBufferSize on overflow', async () => {
    mockSendLogs.mockResolvedValue({ success: false, statusCode: 500, retryCount: 0 });

    const manager = new LogIngestManager(makeLogIngestOptions());

    // Add entries well beyond the 1000 cap
    for (let i = 0; i < 1100; i++) {
      manager.addLog({ timestamp: Date.now(), message: `entry-${i}`, attributes: {} });
    }

    // Flush fails → re-queues, but cap should keep only 1000
    await manager.flush();

    // Now make send succeed and flush to verify capped buffer
    mockSendLogs.mockResolvedValue({ success: true, statusCode: 200, retryCount: 0 });
    await manager.flush();

    const sentLogs = (mockSendLogs.mock.calls[1] as unknown[])[0] as Array<Record<string, unknown>>;
    expect(sentLogs).toHaveLength(1000);
    // Newest entries (highest indices) should survive, oldest dropped
    const messages = sentLogs.map((l) => l.message as string);
    expect(messages).toContain('entry-1099');
    expect(messages).toContain('entry-1098');
    expect(messages).not.toContain('entry-0');
    expect(messages).not.toContain('entry-1');
  });
});
