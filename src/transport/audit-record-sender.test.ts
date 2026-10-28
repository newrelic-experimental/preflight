import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

import type { McpServerConfig } from '../config.js';
import { SessionTracker } from '../metrics/session-tracker.js';
import type { AuditRecord } from '../security/audit-trail.js';
import { nrIngestOptionsFromConfig, sendAuditRecord } from './audit-record-sender.js';
import { NrIngestManager } from './nr-ingest.js';

const ok = { success: true, statusCode: 200, retryCount: 0 };
const sendEventsFn = jest.fn<() => Promise<typeof ok>>().mockResolvedValue(ok);
const sendMetricsFn = jest.fn<() => Promise<typeof ok>>().mockResolvedValue(ok);
const sendLogsFn = jest.fn<() => Promise<typeof ok>>().mockResolvedValue(ok);
const transport = { sendEventsFn, sendMetricsFn, sendLogsFn };

function makeConfig(mode: McpServerConfig['mode']): McpServerConfig {
  return {
    mode,
    licenseKey: 'test-license-key',
    accountId: '12345',
    collectorHost: null,
    developer: 'dev',
    appName: 'preflight-test',
    teamId: null,
    projectId: null,
    orgId: null,
    repoUrl: null,
    companionMode: false,
    tiers: [],
    harvestIntervalMs: { events: 100_000, metrics: 100_000 },
  } as unknown as McpServerConfig;
}

const installRecord: AuditRecord = {
  id: 'audit-install-1',
  timestamp: 1_700_000_000_000,
  sessionId: null,
  action: 'HookInstall',
  tool: 'nr_observe_install_hooks',
  detail: 'HookInstall: /home/dev/.claude/settings.json',
  developer: 'dev',
};

function sentEvents(): Array<Record<string, unknown>> {
  return sendEventsFn.mock.calls.flatMap(
    (call) => (call as unknown[])[0] as Array<Record<string, unknown>>,
  );
}

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  sendEventsFn.mockClear();
  sendMetricsFn.mockClear();
  sendLogsFn.mockClear();
});

afterEach(() => {
  stderrSpy.mockRestore();
});

describe('nrIngestOptionsFromConfig()', () => {
  it('carries tiers, credentials and harvest intervals from config', () => {
    const tiers = [
      {
        name: 'personal',
        destination: { type: 'nr', licenseKey: 'lk-personal', accountId: '777' },
        eventTypes: ['*'],
      },
    ];
    const config = { ...makeConfig('cloud'), tiers } as unknown as McpServerConfig;

    expect(nrIngestOptionsFromConfig(config)).toEqual({
      licenseKey: 'test-license-key',
      transportOptions: { accountId: '12345', collectorHost: null },
      developer: 'dev',
      appName: 'preflight-test',
      teamId: null,
      projectId: null,
      orgId: null,
      repoUrl: null,
      companionMode: false,
      tiers,
      eventHarvestIntervalMs: 100_000,
      metricHarvestIntervalMs: 100_000,
    });
  });

  it('throws when cloud credentials are missing', () => {
    const config = { ...makeConfig('cloud'), licenseKey: undefined } as McpServerConfig;
    expect(() => nrIngestOptionsFromConfig(config)).toThrow(
      'licenseKey and accountId must be defined',
    );
  });
});

describe('sendAuditRecord()', () => {
  it('sends and flushes through a one-shot manager when no live manager exists', async () => {
    await sendAuditRecord(installRecord, {
      config: makeConfig('cloud'),
      liveIngest: undefined,
      sessionTraceId: 'pending-1700000000000',
      overrides: transport,
    });

    expect(sentEvents()).toEqual([
      {
        eventType: 'AiAuditEvent',
        event_version: 1,
        timestamp: 1_700_000_000,
        action: 'HookInstall',
        tool: 'nr_observe_install_hooks',
        detail: 'HookInstall: /home/dev/.claude/settings.json',
        developer: 'dev',
        'audit.security_alert': false,
      },
    ]);
    expect(sendLogsFn).toHaveBeenCalledTimes(1);
  });

  it('sends through the live manager when it is running, without a one-shot flush', async () => {
    const live = new NrIngestManager({
      licenseKey: 'test-license-key',
      transportOptions: { accountId: '12345' },
      developer: 'dev',
      appName: 'preflight-test',
      sessionTracker: new SessionTracker('sess-live'),
      sessionTraceId: 'sess-live',
      eventHarvestIntervalMs: 100_000,
      metricHarvestIntervalMs: 100_000,
      ...transport,
    });
    live.start();

    await sendAuditRecord(installRecord, {
      config: makeConfig('cloud'),
      liveIngest: live,
      sessionTraceId: 'sess-live',
      overrides: transport,
    });
    expect(sendEventsFn).not.toHaveBeenCalled();

    await live.stop();
    expect(sentEvents().map((e) => [e.eventType, e.action, e.session_id])).toEqual([
      ['AiAuditEvent', 'HookInstall', 'sess-live'],
    ]);
  });

  it('sends nothing in local mode', async () => {
    await sendAuditRecord(installRecord, {
      config: makeConfig('local'),
      liveIngest: undefined,
      sessionTraceId: 'pending-1700000000000',
      overrides: transport,
    });

    expect(sendEventsFn).not.toHaveBeenCalled();
    expect(sendLogsFn).not.toHaveBeenCalled();
  });
});
