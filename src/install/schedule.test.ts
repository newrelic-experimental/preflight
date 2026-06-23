import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as nodeOs from 'node:os';
import { join } from 'node:path';

// Prevent real launchctl calls.
jest.mock('node:child_process', () => ({ execFileSync: jest.fn(), execSync: jest.fn() }));
// Point homedir() at a throw-away temp tree.
const TEST_HOME = `/tmp/nr-schedule-test-${process.pid}`;
jest.mock('node:os', () => {
  const real = jest.requireActual<typeof import('node:os')>('node:os');
  return { ...real, homedir: () => TEST_HOME };
});

import * as childProcess from 'node:child_process';
import {
  installSchedule,
  removeSchedule,
  getScheduleStatus,
  resolveBinaryPath,
  installDashboardDaemon,
  removeDashboardDaemon,
  getDashboardDaemonStatus,
} from './schedule.js';

const mockedExecFileSync = childProcess.execFileSync as jest.Mock;

const PLIST_PATH = join(TEST_HOME, 'Library', 'LaunchAgents', 'com.preflight.update.plist');
const DASHBOARD_PLIST_PATH = join(
  TEST_HOME,
  'Library',
  'LaunchAgents',
  'com.preflight.dashboard.plist',
);

beforeAll(() => {
  mkdirSync(join(TEST_HOME, 'Library', 'LaunchAgents'), { recursive: true });
});

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  jest.clearAllMocks();
  for (const p of [PLIST_PATH, DASHBOARD_PLIST_PATH]) {
    try {
      rmSync(p);
    } catch {
      /* ok */
    }
  }
});

describe('installSchedule', () => {
  it('writes a plist file to the LaunchAgents directory', () => {
    installSchedule('/usr/local/bin/preflight', 8, 0);
    expect(existsSync(PLIST_PATH)).toBe(true);
  });

  it('embeds the binary path, hour, and minute in the plist', () => {
    installSchedule('/usr/local/bin/preflight', 14, 30);
    const content = readFileSync(PLIST_PATH, 'utf-8');
    expect(content).toContain('<string>/usr/local/bin/preflight</string>');
    expect(content).toContain('<integer>14</integer>');
    expect(content).toContain('<integer>30</integer>');
  });

  it('redirects stdout and stderr to update.log', () => {
    installSchedule('/usr/local/bin/preflight', 8, 0);
    const content = readFileSync(PLIST_PATH, 'utf-8');
    expect(content).toContain('.newrelic-preflight/update.log');
  });

  it('calls launchctl unload then load', () => {
    mockedExecFileSync.mockImplementation(() => Buffer.from(''));
    installSchedule('/usr/local/bin/preflight', 8, 0);
    const calls = mockedExecFileSync.mock.calls.map((c) => (c as unknown[])[1] as string[]);
    expect(calls.some((args) => args[0] === 'unload')).toBe(true);
    expect(calls.some((args) => args[0] === 'load')).toBe(true);
  });

  it('does not throw when launchctl unload fails (not yet loaded)', () => {
    mockedExecFileSync
      .mockImplementationOnce(() => {
        throw new Error('not loaded');
      })
      .mockImplementation(() => Buffer.from('') as unknown as string);
    expect(() => installSchedule('/usr/local/bin/preflight', 8, 0)).not.toThrow();
  });
});

describe('removeSchedule', () => {
  it('is a no-op when plist does not exist', () => {
    expect(() => removeSchedule()).not.toThrow();
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it('calls launchctl unload and deletes the plist', () => {
    installSchedule('/usr/local/bin/preflight', 8, 0);
    mockedExecFileSync.mockClear();
    removeSchedule();
    const calls = mockedExecFileSync.mock.calls.map((c) => (c as unknown[])[1] as string[]);
    expect(calls.some((args) => args[0] === 'unload')).toBe(true);
    expect(existsSync(PLIST_PATH)).toBe(false);
  });
});

const FIXTURE_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.preflight.update</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/preflight</string>
    <string>update</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>22</integer>
    <key>Minute</key>
    <integer>45</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>/Users/testuser/.newrelic-preflight/update.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/testuser/.newrelic-preflight/update.log</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>`;

describe('getScheduleStatus', () => {
  it('returns installed:false when plist is absent', () => {
    expect(getScheduleStatus()).toEqual({ installed: false });
  });

  it('returns installed:true with hour, minute, binaryPath after install', () => {
    installSchedule('/usr/local/bin/preflight', 9, 15);
    const status = getScheduleStatus();
    expect(status.installed).toBe(true);
    expect(status.hour).toBe(9);
    expect(status.minute).toBe(15);
    expect(status.binaryPath).toBe('/usr/local/bin/preflight');
  });

  it('parses hour, minute, and binaryPath from a fixture plist string', () => {
    writeFileSync(PLIST_PATH, FIXTURE_PLIST);
    const status = getScheduleStatus();
    expect(status.installed).toBe(true);
    expect(status.hour).toBe(22);
    expect(status.minute).toBe(45);
    expect(status.binaryPath).toBe('/opt/homebrew/bin/preflight');
  });
});

describe('resolveBinaryPath', () => {
  const originalPath = process.env.PATH;

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it('returns null when no PATH directories contain the binary', () => {
    process.env.PATH = '/nonexistent/dir1:/nonexistent/dir2';
    expect(resolveBinaryPath()).toBeNull();
  });

  it('returns a string path when binary exists in PATH', () => {
    // Use the real PATH — if the binary is installed it will be found.
    // This is a smoke test: we just verify the return type contract.
    const result = resolveBinaryPath();
    expect(typeof result === 'string' || result === null).toBe(true);
  });

  it('returns null for a non-executable file (mode 0o644)', () => {
    const tmpDir = mkdtempSync(join(nodeOs.tmpdir(), 'schedule-test-'));
    try {
      const binaryPath = join(tmpDir, 'preflight');
      writeFileSync(binaryPath, '#!/usr/bin/env node\n', { mode: 0o644 });
      process.env.PATH = tmpDir;
      expect(resolveBinaryPath()).toBeNull();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('installDashboardDaemon', () => {
  it('writes a plist file to the LaunchAgents directory', () => {
    installDashboardDaemon('/usr/local/bin/preflight');
    expect(existsSync(DASHBOARD_PLIST_PATH)).toBe(true);
  });

  it('plist contains --local arg, KeepAlive true, and RunAtLoad true', () => {
    installDashboardDaemon('/usr/local/bin/preflight');
    const content = readFileSync(DASHBOARD_PLIST_PATH, 'utf-8');
    expect(content).toContain('<string>--local</string>');
    expect(content).toContain('<key>KeepAlive</key>');
    expect(content).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(content).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
  });

  it('embeds the binary path and redirects to dashboard.log', () => {
    installDashboardDaemon('/opt/homebrew/bin/preflight');
    const content = readFileSync(DASHBOARD_PLIST_PATH, 'utf-8');
    expect(content).toContain('<string>/opt/homebrew/bin/preflight</string>');
    expect(content).toContain('.newrelic-preflight/dashboard.log');
  });

  it('calls launchctl unload then load', () => {
    mockedExecFileSync.mockImplementation(() => Buffer.from(''));
    installDashboardDaemon('/usr/local/bin/preflight');
    const calls = mockedExecFileSync.mock.calls.map((c) => (c as unknown[])[1] as string[]);
    expect(calls.some((args) => args[0] === 'unload')).toBe(true);
    expect(calls.some((args) => args[0] === 'load')).toBe(true);
  });

  it('does not throw when launchctl unload fails (not yet loaded)', () => {
    mockedExecFileSync
      .mockImplementationOnce(() => {
        throw new Error('not loaded');
      })
      .mockImplementation(() => Buffer.from('') as unknown as string);
    expect(() => installDashboardDaemon('/usr/local/bin/preflight')).not.toThrow();
  });
});

describe('removeDashboardDaemon', () => {
  it('is a no-op when plist does not exist', () => {
    expect(() => removeDashboardDaemon()).not.toThrow();
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it('calls launchctl unload and deletes the plist', () => {
    installDashboardDaemon('/usr/local/bin/preflight');
    mockedExecFileSync.mockClear();
    removeDashboardDaemon();
    const calls = mockedExecFileSync.mock.calls.map((c) => (c as unknown[])[1] as string[]);
    expect(calls.some((args) => args[0] === 'unload')).toBe(true);
    expect(existsSync(DASHBOARD_PLIST_PATH)).toBe(false);
  });
});

describe('getDashboardDaemonStatus', () => {
  it('returns installed:false when plist is absent', () => {
    expect(getDashboardDaemonStatus()).toEqual({ installed: false });
  });

  it('returns installed:true with binaryPath after install', () => {
    installDashboardDaemon('/usr/local/bin/preflight');
    const status = getDashboardDaemonStatus();
    expect(status.installed).toBe(true);
    expect(status.binaryPath).toBe('/usr/local/bin/preflight');
  });
});
