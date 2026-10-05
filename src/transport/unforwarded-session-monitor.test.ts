import { describe, it, expect } from '@jest/globals';

import { MissingCloudCredentialError } from '../config.js';
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
  it('reads a missing licenseKey error from loadMcpConfig', () => {
    const err = new MissingCloudCredentialError('licenseKey', 'both', '/home/u/config.json');
    expect(detectCloudForwardingGap(err)).toEqual({
      reason: 'missing-license-key',
      missingField: 'licenseKey',
      requestedMode: 'both',
    });
  });

  it("reads a missing accountId error carried as the cause of loadConfigOrDie's wrapper", () => {
    const cause = new MissingCloudCredentialError('accountId', 'cloud', '/home/u/config.json');
    const wrapped = new Error(`${cause.message}\n\nRun 'preflight doctor' to diagnose.`, {
      cause,
    });
    expect(detectCloudForwardingGap(wrapped)).toEqual({
      reason: 'missing-account-id',
      missingField: 'accountId',
      requestedMode: 'cloud',
    });
  });

  it('returns null for any other error so --local rethrows it', () => {
    expect(detectCloudForwardingGap(new Error("Invalid NR_AI_MODE='x'."))).toBeNull();
    // Matching is by type: the same text on a plain Error is not a gap.
    expect(
      detectCloudForwardingGap(
        new Error("Missing required configuration: licenseKey (mode='both')"),
      ),
    ).toBeNull();
    expect(detectCloudForwardingGap('Missing required configuration: licenseKey')).toBeNull();
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
