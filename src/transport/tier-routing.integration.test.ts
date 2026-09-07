import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { NrIngestManager } from './nr-ingest.js';
import type { NrIngestOptions } from './nr-ingest.js';
import { validateTiers } from './tier-types.js';
import type { ResolvedTier } from './tier-types.js';
import type { ToolCallRecord } from '../storage/types.js';
import type { AiCodingTask } from '../metrics/task-detector.js';
import { SessionTracker } from '../metrics/session-tracker.js';
import type { NrEventData, TransportOptions, TransportResult } from '../shared/index.js';

// ---------------------------------------------------------------------------
// In-process, multi-scheduler integration proof
// ---------------------------------------------------------------------------
//
// Drives the real NrIngestManager with real HarvestScheduler instances (one
// per tier) and a fake transport keyed by licenseKey, so per-tier delivery,
// per-tier failure isolation, and the no-tiers backward-compat path are all
// observable without touching the network.

let stderrSpy: ReturnType<typeof jest.spyOn>;
let localDir: string;

beforeEach(() => {
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  localDir = mkdtempSync(resolve(tmpdir(), 'tier-routing-integration-'));
  // mockSendMetrics/mockSendLogs are module-level (shared across every test
  // in this file, unlike mockSendEvents which each test constructs fresh via
  // makeRecordingTransport()) — clear them so a prior test's calls can't make
  // a later assertion pass vacuously. Matches the convention in the sibling
  // nr-ingest.test.ts's own beforeEach.
  mockSendMetrics.mockClear();
  mockSendLogs.mockClear();
});

afterEach(() => {
  stderrSpy.mockRestore();
  rmSync(localDir, { recursive: true, force: true });
});

interface RecordedSend {
  readonly licenseKey: string;
  readonly accountId: string;
  readonly eventTypes: readonly string[];
}

/**
 * A fake sendEvents that records every batch by licenseKey and can be told to
 * fail permanently for one specific key — the "one unreachable NR account"
 * scenario from the spec's error-handling section.
 */
function makeRecordingTransport(failForLicenseKey?: string): {
  readonly sends: RecordedSend[];
  readonly sendEventsFn: (
    events: NrEventData[],
    licenseKey: string,
    options: TransportOptions,
  ) => Promise<TransportResult>;
} {
  const sends: RecordedSend[] = [];
  const sendEventsFn = async (
    events: NrEventData[],
    licenseKey: string,
    options: TransportOptions,
  ): Promise<TransportResult> => {
    sends.push({
      licenseKey,
      accountId: options.accountId,
      eventTypes: events.map((e) => String(e.eventType)),
    });
    if (licenseKey === failForLicenseKey) {
      // 500 is retryable — HarvestScheduler re-queues into THIS tier's own
      // retry buffer and must not touch any other tier's.
      return { success: false, statusCode: 500, retryCount: 0, error: 'simulated outage' };
    }
    return { success: true, statusCode: 200, retryCount: 0 };
  };
  return { sends, sendEventsFn };
}

const mockSendMetrics = jest
  .fn<() => Promise<TransportResult>>()
  .mockResolvedValue({ success: true, statusCode: 200, retryCount: 0 });
const mockSendLogs = jest
  .fn<() => Promise<TransportResult>>()
  .mockResolvedValue({ success: true, statusCode: 200, retryCount: 0 });

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

function makeTask(overrides?: Partial<AiCodingTask>): AiCodingTask {
  return {
    taskId: 'task-001',
    startTime: 1_700_000_000_000,
    endTime: 1_700_000_060_000,
    durationMs: 60_000,
    toolCallCount: 1,
    toolCallsByType: { Read: 1 },
    filesRead: ['/a.ts'],
    filesModified: [],
    linesChanged: 0,
    linesAdded: 0,
    linesRemoved: 0,
    bashCommandsRun: 0,
    testsRun: 0,
    testsPassed: 0,
    buildRun: 0,
    buildPassed: 0,
    estimatedCostUsd: 0.001,
    tokensUsed: 100,
    askedUserQuestions: 0,
    subAgentsSpawned: 0,
    toolCalls: [makeRecord()],
    ...overrides,
  };
}

function makeOptions(overrides?: Partial<NrIngestOptions>): NrIngestOptions {
  return {
    licenseKey: 'lk-personal',
    transportOptions: { accountId: '12345' },
    developer: 'test-dev',
    appName: 'test-app',
    sessionTracker: new SessionTracker('test-session'),
    eventHarvestIntervalMs: 100_000,
    metricHarvestIntervalMs: 100_000,
    sendMetricsFn: mockSendMetrics,
    sendLogsFn: mockSendLogs,
    ...overrides,
  };
}

function makeThreeTierConfig(): readonly ResolvedTier[] {
  return validateTiers([
    {
      name: 'personal',
      destination: { type: 'nr', licenseKey: 'lk-personal', accountId: '12345' },
      eventTypes: ['*'],
    },
    {
      name: 'team',
      destination: { type: 'nr', licenseKey: 'lk-team', accountId: '67890' },
      eventTypes: ['AiCodingTask', 'AiSubagentTurn'],
    },
    {
      name: 'org',
      destination: { type: 'local', path: localDir },
      eventTypes: ['AiCodingTask'],
    },
  ]);
}

describe('multi-tier fan-out (spec § Testing plan — N-scheduler fan-out)', () => {
  it('delivers one event to three destinations with per-tier credentials', async () => {
    const { sends, sendEventsFn } = makeRecordingTransport();
    const manager = new NrIngestManager(
      makeOptions({ tiers: makeThreeTierConfig(), sendEventsFn }),
    );

    manager.ingestCodingTask(makeTask({ taskId: 'fanout-1' }));
    manager.start();
    await manager.stop();

    const personal = sends.filter((s) => s.licenseKey === 'lk-personal');
    const team = sends.filter((s) => s.licenseKey === 'lk-team');
    expect(personal).toHaveLength(1);
    expect(personal[0].accountId).toBe('12345');
    expect(personal[0].eventTypes).toEqual(['AiCodingTask']);
    expect(team).toHaveLength(1);
    expect(team[0].accountId).toBe('67890');
    expect(team[0].eventTypes).toEqual(['AiCodingTask']);

    const jsonl = readFileSync(resolve(localDir, 'events-2023-11-14.jsonl'), 'utf-8')
      .trim()
      .split('\n');
    expect(jsonl).toHaveLength(1);
    expect(JSON.parse(jsonl[0]).task_id).toBe('fanout-1');
  });

  it('keeps a personal-only event out of the team tier and the local tier', async () => {
    const { sends, sendEventsFn } = makeRecordingTransport();
    const manager = new NrIngestManager(
      makeOptions({ tiers: makeThreeTierConfig(), sendEventsFn }),
    );

    manager.ingestToolCall(makeRecord({ toolName: 'Bash' }));
    manager.start();
    await manager.stop();

    const personalTypes = sends
      .filter((s) => s.licenseKey === 'lk-personal')
      .flatMap((s) => s.eventTypes);
    expect(personalTypes).toContain('AiToolCall');
    expect(personalTypes).toContain('AiAuditEvent');
    expect(sends.filter((s) => s.licenseKey === 'lk-team')).toHaveLength(0);
    expect(existsSync(resolve(localDir, 'events-2023-11-14.jsonl'))).toBe(false);
  });

  it('delivers to a healthy tier while another tier is completely unreachable', async () => {
    const { sends, sendEventsFn } = makeRecordingTransport('lk-team');
    const manager = new NrIngestManager(
      makeOptions({ tiers: makeThreeTierConfig(), sendEventsFn }),
    );

    manager.ingestCodingTask(makeTask({ taskId: 'isolation-1' }));
    manager.start();
    await manager.stop();

    const personal = sends.filter((s) => s.licenseKey === 'lk-personal');
    expect(personal).toHaveLength(1);
    expect(personal[0].eventTypes).toEqual(['AiCodingTask']);

    // The failing tier attempted its own send and got its own failure.
    expect(sends.filter((s) => s.licenseKey === 'lk-team')).toHaveLength(1);

    // The local tier is unaffected too.
    expect(existsSync(resolve(localDir, 'events-2023-11-14.jsonl'))).toBe(true);
  });

  it('does not re-send a healthy tier’s batch because another tier failed', async () => {
    const { sends, sendEventsFn } = makeRecordingTransport('lk-team');
    const manager = new NrIngestManager(
      makeOptions({ tiers: makeThreeTierConfig(), sendEventsFn }),
    );

    manager.ingestCodingTask(makeTask({ taskId: 'no-cross-requeue' }));
    manager.start();
    await manager.stop();

    // Exactly one attempt per tier for one event — no cross-tier requeue.
    expect(sends.filter((s) => s.licenseKey === 'lk-personal')).toHaveLength(1);
    const personalPayloads = sends
      .filter((s) => s.licenseKey === 'lk-personal')
      .flatMap((s) => s.eventTypes);
    expect(personalPayloads).toEqual(['AiCodingTask']);
  });

  it('does not let a failing secondary tier degrade getEventSendHealth()', async () => {
    const { sendEventsFn } = makeRecordingTransport('lk-team');
    const manager = new NrIngestManager(
      makeOptions({ tiers: makeThreeTierConfig(), sendEventsFn }),
    );

    manager.ingestCodingTask(makeTask());
    manager.start();
    await manager.stop();

    expect(manager.getEventSendHealth().consecutiveFailures).toBe(0);
    expect(manager.getEventSendHealth().lastSuccessAt).not.toBeNull();
  });

  it('does not let an unwritable local tier break the nr tiers', async () => {
    const { sends, sendEventsFn } = makeRecordingTransport();
    const tiers = validateTiers([
      {
        name: 'personal',
        destination: { type: 'nr', licenseKey: 'lk-personal', accountId: '12345' },
        eventTypes: ['*'],
      },
      {
        name: 'org',
        // A path under a file, so mkdir always fails.
        destination: { type: 'local', path: resolve(localDir, 'not-a-dir', 'deeper') },
        eventTypes: ['AiCodingTask'],
      },
    ]);
    rmSync(localDir, { recursive: true, force: true });
    const manager = new NrIngestManager(makeOptions({ tiers, sendEventsFn }));

    manager.ingestCodingTask(makeTask());
    manager.start();
    await manager.stop();

    expect(sends.filter((s) => s.licenseKey === 'lk-personal')).toHaveLength(1);
  });
});

describe('backward compatibility (spec § Testing plan — no tiers array)', () => {
  it('sends every event type to the single flat licenseKey/accountId', async () => {
    const { sends, sendEventsFn } = makeRecordingTransport();
    const manager = new NrIngestManager(makeOptions({ sendEventsFn }));

    manager.ingestToolCall(makeRecord());
    manager.ingestCodingTask(makeTask());
    manager.ingestBudgetWarning({
      timestamp: 1_700_000_000_000,
      period: 'session',
      thresholdPct: 80,
      spentUsd: 8,
      budgetUsd: 10,
    });
    manager.start();
    await manager.stop();

    expect(sends).toHaveLength(1);
    expect(sends[0].licenseKey).toBe('lk-personal');
    expect(sends[0].accountId).toBe('12345');
    expect([...sends[0].eventTypes].sort()).toEqual(
      ['AiAuditEvent', 'AiBudgetWarning', 'AiCodingTask', 'AiToolCall'].sort(),
    );
  });

  it('produces one scheduler named default, matching the existing single-account behavior', () => {
    const manager = new NrIngestManager(makeOptions());
    expect(manager.getTierNames()).toEqual(['default']);
    expect(manager.getPrimaryTierName()).toBe('default');
  });

  it('still sends metrics and logs on the flat credentials', async () => {
    const { sendEventsFn } = makeRecordingTransport();
    const manager = new NrIngestManager(makeOptions({ sendEventsFn }));

    manager.ingestToolCall(makeRecord({ durationMs: 120 }));
    manager.start();
    await manager.stop();

    expect(mockSendMetrics).toHaveBeenCalled();
    expect((mockSendMetrics.mock.calls[0] as unknown[])[1]).toBe('lk-personal');
    expect(mockSendLogs).toHaveBeenCalled();
    expect((mockSendLogs.mock.calls[0] as unknown[])[1]).toBe('lk-personal');
  });
});
