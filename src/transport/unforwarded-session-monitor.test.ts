import { describe, it, expect } from '@jest/globals';

import {
  UnforwardedSessionMonitor,
  detectCloudForwardingGap,
  type CloudForwardingGap,
} from './unforwarded-session-monitor.js';

const GAP: CloudForwardingGap = {
  reason: 'missing-license-key',
  missingField: 'licenseKey',
  requestedMode: 'both',
};

interface WarnCall {
  readonly message: string;
  readonly fields: Record<string, unknown>;
}

function makeMonitor(overrides: { maxTrackedSessions?: number; clock?: { t: number } } = {}): {
  monitor: UnforwardedSessionMonitor;
  warns: WarnCall[];
} {
  const warns: WarnCall[] = [];
  const clock = overrides.clock ?? { t: 1_000 };
  const monitor = new UnforwardedSessionMonitor({
    gap: GAP,
    maxTrackedSessions: overrides.maxTrackedSessions,
    warn: (message, fields) => warns.push({ message, fields }),
    now: () => clock.t,
  });
  return { monitor, warns };
}

describe('detectCloudForwardingGap', () => {
  it('parses a missing licenseKey error from loadMcpConfig', () => {
    const msg =
      "Missing required configuration: licenseKey (mode='both'). Set the NEW_RELIC_LICENSE_KEY environment variable or add \"licenseKey\" to /home/u/.newrelic-preflight/config.json, or switch to mode='local' to skip cloud transport.";
    expect(detectCloudForwardingGap(msg)).toEqual({
      reason: 'missing-license-key',
      missingField: 'licenseKey',
      requestedMode: 'both',
    });
  });

  it('parses a missing accountId error from loadMcpConfig', () => {
    const msg = "Missing required configuration: accountId (mode='cloud'). Set ...";
    expect(detectCloudForwardingGap(msg)).toEqual({
      reason: 'missing-account-id',
      missingField: 'accountId',
      requestedMode: 'cloud',
    });
  });

  it('returns null for unrelated config errors so --local rethrows them', () => {
    expect(detectCloudForwardingGap("Invalid NR_AI_MODE='x'.")).toBeNull();
    expect(
      detectCloudForwardingGap('Config has a licenseKey but no explicit mode. Telemetry...'),
    ).toBeNull();
  });
});

describe('UnforwardedSessionMonitor', () => {
  it('warns once per session, not once per tool call', () => {
    const { monitor, warns } = makeMonitor();
    monitor.recordToolCall('sess-a');
    monitor.recordToolCall('sess-a');
    monitor.recordToolCall('sess-b');
    monitor.recordToolCall('sess-a');

    expect(warns).toHaveLength(2);
    expect(warns.map((w) => w.fields.sessionId)).toEqual(['sess-a', 'sess-b']);
    expect(warns[0]!.fields).toMatchObject({
      reason: 'missing-license-key',
      requestedMode: 'both',
    });
  });

  it('snapshots per-session counts, most recently active first', () => {
    const clock = { t: 1_000 };
    const { monitor } = makeMonitor({ clock });
    monitor.recordToolCall('sess-a');
    clock.t = 2_000;
    monitor.recordToolCall('sess-b');
    clock.t = 3_000;
    monitor.recordToolCall('sess-a');

    const snap = monitor.getSnapshot();
    expect(snap).toMatchObject({
      reason: 'missing-license-key',
      requestedMode: 'both',
      count: 2,
      toolCalls: 3,
      untrackedToolCalls: 0,
      truncated: false,
    });
    expect(snap.sessions).toEqual([
      { sessionId: 'sess-a', toolCalls: 2, firstSeenMs: 1_000, lastSeenMs: 3_000 },
      { sessionId: 'sess-b', toolCalls: 1, firstSeenMs: 2_000, lastSeenMs: 2_000 },
    ]);
    expect(snap.hint).toMatch(/config file/);
  });

  it('counts a missing or malformed session id without an entry, warning once', () => {
    const { monitor, warns } = makeMonitor();
    monitor.recordToolCall(undefined);
    monitor.recordToolCall(null);
    monitor.recordToolCall('../../etc/passwd');

    const snap = monitor.getSnapshot();
    expect(snap.count).toBe(0);
    expect(snap.toolCalls).toBe(3);
    expect(snap.untrackedToolCalls).toBe(3);
    expect(snap.sessions).toEqual([]);
    expect(warns).toHaveLength(1);
  });

  it('evicts the least recently active session at the cap, so new losses still surface', () => {
    // The dashboard LaunchAgent runs for weeks: once the cap fills, a session
    // losing data right now must still be listed and warned about.
    const clock = { t: 1_000 };
    const { monitor, warns } = makeMonitor({ maxTrackedSessions: 2, clock });
    monitor.recordToolCall('sess-a');
    clock.t = 2_000;
    monitor.recordToolCall('sess-b');
    clock.t = 3_000;
    monitor.recordToolCall('sess-a');
    clock.t = 4_000;
    monitor.recordToolCall('sess-c');

    const snap = monitor.getSnapshot();
    expect(snap).toMatchObject({
      count: 2,
      evictedSessions: 1,
      toolCalls: 4,
      untrackedToolCalls: 0,
      truncated: false,
    });
    expect(snap.sessions.map((s) => s.sessionId)).toEqual(['sess-c', 'sess-a']);
    expect(warns.map((w) => w.fields.sessionId)).toEqual(['sess-a', 'sess-b', 'sess-c']);
  });

  it('warns again for a session seen after it was evicted', () => {
    const { monitor, warns } = makeMonitor({ maxTrackedSessions: 1 });
    monitor.recordToolCall('sess-a');
    monitor.recordToolCall('sess-b');
    monitor.recordToolCall('sess-a');

    expect(warns.map((w) => w.fields.sessionId)).toEqual(['sess-a', 'sess-b', 'sess-a']);
    expect(monitor.getSnapshot()).toMatchObject({ count: 1, evictedSessions: 2 });
  });

  it('lists at most 20 sessions and flags the rest as truncated', () => {
    const clock = { t: 0 };
    const { monitor } = makeMonitor({ clock });
    for (let i = 0; i < 25; i++) {
      clock.t = i;
      monitor.recordToolCall(`sess-${i}`);
    }
    const snap = monitor.getSnapshot();
    expect(snap.count).toBe(25);
    expect(snap.sessions).toHaveLength(20);
    expect(snap.sessions[0]!.sessionId).toBe('sess-24');
    expect(snap.truncated).toBe(true);
  });

  it('never carries credentials in the snapshot', () => {
    const { monitor } = makeMonitor();
    monitor.recordToolCall('sess-a');
    const json = JSON.stringify(monitor.getSnapshot());
    expect(json).not.toMatch(/licenseKey"\s*:/);
    expect(json).not.toMatch(/accountId"\s*:/);
    expect(Object.keys(monitor.getSnapshot()).sort()).toEqual(
      [
        'count',
        'evictedSessions',
        'hint',
        'reason',
        'requestedMode',
        'sessions',
        'toolCalls',
        'truncated',
        'untrackedToolCalls',
      ].sort(),
    );
  });
});
