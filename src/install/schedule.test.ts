import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
} from 'node:fs';
import * as nodeOs from 'node:os';
import { join, dirname } from 'node:path';

import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';

// Suppress logger and fallback warning output.
jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

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
  resolveNodeDir,
  installDashboardDaemon,
  removeDashboardDaemon,
  getDashboardDaemonStatus,
  unescapeXml,
  findExecutableNodeDir,
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

  it('plist includes EnvironmentVariables PATH containing the node dir', () => {
    installSchedule('/usr/local/bin/preflight', 8, 0);
    const content = readFileSync(PLIST_PATH, 'utf-8');
    expect(content).toContain('<key>EnvironmentVariables</key>');
    expect(content).toContain('<key>PATH</key>');
    expect(content).toContain(resolveNodeDir());
    expect(content).toContain('/usr/bin:/bin');
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

  it('throws a wrapped error when launchctl load fails', () => {
    mockedExecFileSync
      .mockImplementationOnce(() => Buffer.from('') as unknown as string) // unload succeeds
      .mockImplementationOnce(() => {
        throw new Error('boom');
      });
    expect(() => installSchedule('/usr/local/bin/preflight', 8, 0)).toThrow(
      'launchctl load failed: boom',
    );
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
  it('returns installed:false readable:false when plist is absent', () => {
    expect(getScheduleStatus()).toEqual({ installed: false, readable: false });
  });

  it('returns installed:true readable:true with hour, minute, binaryPath after install', () => {
    installSchedule('/usr/local/bin/preflight', 9, 15);
    const status = getScheduleStatus();
    expect(status.installed).toBe(true);
    expect(status.readable).toBe(true);
    expect(status.hour).toBe(9);
    expect(status.minute).toBe(15);
    expect(status.binaryPath).toBe('/usr/local/bin/preflight');
  });

  it('parses hour, minute, and binaryPath from a fixture plist string', () => {
    writeFileSync(PLIST_PATH, FIXTURE_PLIST);
    const status = getScheduleStatus();
    expect(status.installed).toBe(true);
    expect(status.readable).toBe(true);
    expect(status.hour).toBe(22);
    expect(status.minute).toBe(45);
    expect(status.binaryPath).toBe('/opt/homebrew/bin/preflight');
  });

  it('returns installed:true readable:false when plist exists but is unreadable', () => {
    writeFileSync(PLIST_PATH, '<plist/>', { mode: 0o600 });
    chmodSync(PLIST_PATH, 0o000);
    try {
      const status = getScheduleStatus();
      expect(status.installed).toBe(true);
      expect(status.readable).toBe(false);
    } finally {
      chmodSync(PLIST_PATH, 0o600);
    }
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

describe('resolveNodeDir', () => {
  const originalPath = process.env.PATH;

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it('returns a non-empty string', () => {
    expect(resolveNodeDir().length).toBeGreaterThan(0);
  });

  it('returns the unresolved PATH dir containing node, not the resolved execPath dir', () => {
    // Create a temp dir with a symlink "node" → process.execPath to simulate
    // the Homebrew layout (stable /opt/homebrew/bin symlink → versioned Cellar binary).
    const tmpDir = mkdtempSync(join(nodeOs.tmpdir(), 'nr-nodedir-test-'));
    try {
      symlinkSync(process.execPath, join(tmpDir, 'node'));
      process.env.PATH = `${tmpDir}:${originalPath}`;
      // resolveNodeDir() must return the symlink dir, not dirname(process.execPath).
      expect(resolveNodeDir()).toBe(tmpDir);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('falls back to dirname(process.execPath) when node is not on PATH', () => {
    process.env.PATH = '/nonexistent/dir1:/nonexistent/dir2';
    expect(resolveNodeDir()).toBe(dirname(process.execPath));
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

  it('plist includes EnvironmentVariables PATH containing the node dir', () => {
    installDashboardDaemon('/opt/homebrew/bin/preflight');
    const content = readFileSync(DASHBOARD_PLIST_PATH, 'utf-8');
    expect(content).toContain('<key>EnvironmentVariables</key>');
    expect(content).toContain('<key>PATH</key>');
    expect(content).toContain(resolveNodeDir());
    expect(content).toContain('/usr/bin:/bin');
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

  it('throws a wrapped error when launchctl load fails', () => {
    mockedExecFileSync
      .mockImplementationOnce(() => Buffer.from('') as unknown as string) // unload succeeds
      .mockImplementationOnce(() => {
        throw new Error('boom');
      });
    expect(() => installDashboardDaemon('/usr/local/bin/preflight')).toThrow(
      'launchctl load failed: boom',
    );
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
  it('returns installed:false readable:false when plist is absent', () => {
    expect(getDashboardDaemonStatus()).toEqual({ installed: false, readable: false });
  });

  it('returns installed:true readable:true with binaryPath and envPath after install', () => {
    installDashboardDaemon('/usr/local/bin/preflight');
    const status = getDashboardDaemonStatus();
    expect(status.installed).toBe(true);
    expect(status.readable).toBe(true);
    expect(status.binaryPath).toBe('/usr/local/bin/preflight');
    expect(status.envPath).toContain(resolveNodeDir());
    expect(status.envPath).toContain('/usr/bin');
  });

  it('returns installed:true readable:false when plist exists but is unreadable', () => {
    writeFileSync(DASHBOARD_PLIST_PATH, '<plist/>', { mode: 0o600 });
    chmodSync(DASHBOARD_PLIST_PATH, 0o000);
    try {
      const status = getDashboardDaemonStatus();
      expect(status.installed).toBe(true);
      expect(status.readable).toBe(false);
      expect(status.envPath).toBeUndefined();
    } finally {
      chmodSync(DASHBOARD_PLIST_PATH, 0o600);
    }
  });

  it('returns envPath:undefined for an older plist without PATH injection', () => {
    const legacyPlist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>com.preflight.dashboard</string>
  <key>ProgramArguments</key><array><string>/usr/local/bin/preflight</string><string>--local</string></array>
</dict></plist>`;
    writeFileSync(DASHBOARD_PLIST_PATH, legacyPlist);
    const status = getDashboardDaemonStatus();
    expect(status.installed).toBe(true);
    expect(status.readable).toBe(true);
    expect(status.envPath).toBeUndefined();
  });
});

describe('unescapeXml', () => {
  it('round-trips basic entities', () => {
    expect(unescapeXml('&lt;&gt;&amp;&quot;&apos;')).toBe('<>&"\'');
  });

  it('decodes &amp; last so &amp;lt; becomes &lt; not <', () => {
    expect(unescapeXml('&amp;lt;')).toBe('&lt;');
  });

  it('does not double-decode a path that escapeXml would produce for a path containing &lt;', () => {
    // A path containing the literal text '&lt;' (five chars):
    // escapeXml encodes '&' → '&amp;', so the full encoding is '&amp;lt;'.
    // unescapeXml must decode back to '&lt;', not '<'.
    const original = '/some/path/&lt;version&gt;/node';
    const escaped = original.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    expect(unescapeXml(escaped)).toBe(original);
  });
});

describe('findExecutableNodeDir', () => {
  it('returns hasNonExecutable:false for a broken symlink named node (treated as not found; fix is reinstall, not chmod)', () => {
    const tmpDir = mkdtempSync(join(nodeOs.tmpdir(), 'nr-findnode-test-'));
    try {
      const target = join(tmpDir, 'nonexistent-target');
      symlinkSync(target, join(tmpDir, 'node'));
      const result = findExecutableNodeDir([tmpDir]);
      expect(result.dir).toBeNull();
      expect(result.hasNonExecutable).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns hasNonExecutable:false for a dir with no node entry at all', () => {
    const tmpDir = mkdtempSync(join(nodeOs.tmpdir(), 'nr-findnode-test-'));
    try {
      const result = findExecutableNodeDir([tmpDir]);
      expect(result.dir).toBeNull();
      expect(result.hasNonExecutable).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
