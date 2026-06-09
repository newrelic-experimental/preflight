import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the module under test
// ---------------------------------------------------------------------------

jest.mock('node:fs', () => ({
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
  existsSync: jest.fn(() => false),
  unlinkSync: jest.fn(),
  realpathSync: jest.fn((p: string) => p),
  openSync: jest.fn(() => 3),
  closeSync: jest.fn(),
}));

jest.mock('node:child_process', () => ({
  spawn: jest.fn(),
  execSync: jest.fn(),
  execFileSync: jest.fn(),
}));

const TEST_HOME = `/tmp/nr-daemon-test-${process.pid}`;
jest.mock('node:os', () => ({ homedir: () => TEST_HOME }));

import * as fs from 'node:fs';
import * as childProcess from 'node:child_process';
import {
  getPidfilePath,
  getLogPath,
  readPid,
  isRunning,
  getDaemonStatus,
  startDaemon,
  stopDaemon,
  installLaunchAgent,
  removeLaunchAgent,
  isLaunchAgentInstalled,
} from './daemon.js';

// Typed mock references for assertions — jest.Mock defaults to UnknownFunction
// (...args: unknown[]) => unknown in Jest 30, so these casts are type-safe.
const mockedReadFileSync = fs.readFileSync as jest.Mock;
const mockedWriteFileSync = fs.writeFileSync as jest.Mock;
const mockedMkdirSync = fs.mkdirSync as jest.Mock;
const mockedExistsSync = fs.existsSync as jest.Mock;
const mockedUnlinkSync = fs.unlinkSync as jest.Mock;
const mockedSpawn = childProcess.spawn as jest.Mock;
const _mockedExecSync = childProcess.execSync as jest.Mock;
const mockedExecFileSync = childProcess.execFileSync as jest.Mock;

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  jest.clearAllMocks();
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// getPidfilePath / getLogPath
// ---------------------------------------------------------------------------

describe('getPidfilePath', () => {
  it('returns path under home directory .nr-ai-observe', () => {
    const result = getPidfilePath();
    expect(result).toBe(`${TEST_HOME}/.nr-ai-observe/daemon.pid`);
  });
});

describe('getLogPath', () => {
  it('returns path under home directory .nr-ai-observe/logs', () => {
    const result = getLogPath();
    expect(result).toBe(`${TEST_HOME}/.nr-ai-observe/logs/daemon.log`);
  });
});

// ---------------------------------------------------------------------------
// readPid
// ---------------------------------------------------------------------------

describe('readPid', () => {
  it('returns null when pidfile does not exist', () => {
    mockedExistsSync.mockReturnValue(false);
    expect(readPid()).toBeNull();
  });

  it('returns null when pidfile contains non-numeric content', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('not-a-number\n');
    expect(readPid()).toBeNull();
  });

  it('returns null when pidfile is empty', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('');
    expect(readPid()).toBeNull();
  });

  it('returns PID number when pidfile contains valid PID', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('12345\n');
    expect(readPid()).toBe(12345);
  });

  it('returns PID number when pidfile contains PID without trailing newline', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('98765');
    expect(readPid()).toBe(98765);
  });

  it('returns null when readFileSync throws (e.g. permission denied)', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });
    expect(readPid()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isRunning
// ---------------------------------------------------------------------------

describe('isRunning', () => {
  let killSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
  });

  afterEach(() => {
    killSpy.mockRestore();
  });

  it('returns false when no pidfile exists', () => {
    mockedExistsSync.mockReturnValue(false);
    expect(isRunning()).toBe(false);
  });

  it('returns false when pidfile exists but process is dead (ESRCH)', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('12345');
    killSpy.mockImplementation(() => {
      const err = new Error('No such process') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });
    expect(isRunning()).toBe(false);
  });

  it('returns false when pidfile exists but process is dead (EPERM)', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('12345');
    killSpy.mockImplementation(() => {
      const err = new Error('Operation not permitted') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });
    // EPERM means the process exists but we lack permission — it IS running
    expect(isRunning()).toBe(true);
  });

  it('returns true when pidfile exists and process is alive (kill signal 0 succeeds)', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('12345');
    killSpy.mockImplementation(() => true);
    expect(isRunning()).toBe(true);
  });

  it('sends signal 0 to the PID from the pidfile', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('54321');
    killSpy.mockImplementation(() => true);
    isRunning();
    expect(killSpy).toHaveBeenCalledWith(54321, 0);
  });
});

// ---------------------------------------------------------------------------
// getDaemonStatus
// ---------------------------------------------------------------------------

describe('getDaemonStatus', () => {
  let killSpy: ReturnType<typeof jest.spyOn>;
  let fetchSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify({ ok: true, uptime: 3_600_000 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
  });

  afterEach(() => {
    killSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  it('returns { running: false } when not running', async () => {
    mockedExistsSync.mockReturnValue(false);
    const status = await getDaemonStatus();
    expect(status.running).toBe(false);
    expect(status.pid).toBeUndefined();
    expect(status.uptime).toBeUndefined();
  });

  it('returns full status with pid and uptime when running', async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('12345');
    killSpy.mockImplementation(() => true);

    const status = await getDaemonStatus(9111);
    expect(status.running).toBe(true);
    expect(status.pid).toBe(12345);
    expect(status.port).toBe(9111);
    expect(status.uptime).toBe(3600);
  });

  it('uses default port when none specified', async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('12345');
    killSpy.mockImplementation(() => true);

    await getDaemonStatus();
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('http://127.0.0.1:'),
      expect.anything(),
    );
  });

  it('returns running:true but no uptime when health check fails', async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('12345');
    killSpy.mockImplementation(() => true);
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

    const status = await getDaemonStatus();
    expect(status.running).toBe(true);
    expect(status.pid).toBe(12345);
    expect(status.uptime).toBeUndefined();
  });

  it('includes url in status when running', async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('12345');
    killSpy.mockImplementation(() => true);

    const status = await getDaemonStatus(4200);
    expect(status.url).toContain('4200');
  });
});

// ---------------------------------------------------------------------------
// startDaemon
// ---------------------------------------------------------------------------

describe('startDaemon', () => {
  let killSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
  });

  afterEach(() => {
    killSpy.mockRestore();
  });

  it('throws or warns if daemon is already running', async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('12345');
    killSpy.mockImplementation(() => true);

    await expect(startDaemon()).rejects.toThrow(/already running/i);
  });

  it('spawns a detached child process', async () => {
    // existsSync: false for pidfile, true for server script resolution
    mockedExistsSync.mockImplementation(
      (p: unknown) => typeof p === 'string' && p.endsWith('index.js'),
    );
    const fakeChild = {
      pid: 99999,
      unref: jest.fn(),
      on: jest.fn(),
      stdout: null,
      stderr: null,
    };
    mockedSpawn.mockReturnValue(fakeChild);

    await startDaemon({ port: 9222 });

    expect(mockedSpawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([expect.any(String)]),
      expect.objectContaining({
        detached: true,
        stdio: expect.anything(),
      }),
    );
  });

  it('unrefs the spawned child so parent can exit', async () => {
    mockedExistsSync.mockImplementation(
      (p: unknown) => typeof p === 'string' && p.endsWith('index.js'),
    );
    const fakeChild = {
      pid: 99999,
      unref: jest.fn(),
      on: jest.fn(),
      stdout: null,
      stderr: null,
    };
    mockedSpawn.mockReturnValue(fakeChild);

    await startDaemon();

    expect(fakeChild.unref).toHaveBeenCalled();
  });

  it('creates the log directory if it does not exist', async () => {
    mockedExistsSync.mockImplementation(
      (p: unknown) => typeof p === 'string' && p.endsWith('index.js'),
    );
    const fakeChild = {
      pid: 99999,
      unref: jest.fn(),
      on: jest.fn(),
      stdout: null,
      stderr: null,
    };
    mockedSpawn.mockReturnValue(fakeChild);

    await startDaemon();

    expect(mockedMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('logs'),
      expect.objectContaining({ recursive: true }),
    );
  });

  it('sets port in environment or arguments', async () => {
    mockedExistsSync.mockImplementation(
      (p: unknown) => typeof p === 'string' && p.endsWith('index.js'),
    );
    const fakeChild = {
      pid: 99999,
      unref: jest.fn(),
      on: jest.fn(),
      stdout: null,
      stderr: null,
    };
    mockedSpawn.mockReturnValue(fakeChild);

    await startDaemon({ port: 7777 });

    const spawnCall = mockedSpawn.mock.calls[0] as unknown[];
    const args = spawnCall[1] as string[];
    const opts = spawnCall[2] as { env?: Record<string, string> };

    // Port should appear in either args or env
    const hasPortInArgs = args.some((a) => a.includes('7777'));
    const hasPortInEnv = opts.env
      ? Object.values(opts.env).some((v) => String(v).includes('7777'))
      : false;
    expect(hasPortInArgs || hasPortInEnv).toBe(true);
  });

  it('writes pidfile with the spawned process PID', async () => {
    mockedExistsSync.mockImplementation(
      (p: unknown) => typeof p === 'string' && p.endsWith('index.js'),
    );
    const fakeChild = {
      pid: 42000,
      unref: jest.fn(),
      on: jest.fn(),
      stdout: null,
      stderr: null,
    };
    mockedSpawn.mockReturnValue(fakeChild);

    await startDaemon();

    expect(mockedWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining('daemon.pid'),
      '42000',
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// stopDaemon
// ---------------------------------------------------------------------------

describe('stopDaemon', () => {
  let killSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
  });

  afterEach(() => {
    killSpy.mockRestore();
  });

  it('does nothing if daemon is not running', async () => {
    mockedExistsSync.mockReturnValue(false);
    await expect(stopDaemon()).resolves.not.toThrow();
    expect(killSpy).not.toHaveBeenCalledWith(expect.any(Number), 'SIGTERM');
  });

  it('sends SIGTERM to running process', async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('12345');
    // First call (signal 0) — process is alive; subsequent calls succeed
    killSpy.mockImplementation(() => true);

    await stopDaemon();

    expect(killSpy).toHaveBeenCalledWith(12345, 'SIGTERM');
  });

  it('removes pidfile after stopping', async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('12345');
    killSpy.mockImplementation(() => true);

    await stopDaemon();

    expect(mockedUnlinkSync).toHaveBeenCalledWith(expect.stringContaining('daemon.pid'));
  });

  it('removes pidfile even when kill throws ESRCH (process already gone)', async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('12345');
    let callCount = 0;
    killSpy.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return true; // isRunning check (signal 0)
      const err = new Error('No such process') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });

    await stopDaemon();

    expect(mockedUnlinkSync).toHaveBeenCalledWith(expect.stringContaining('daemon.pid'));
  });
});

// ---------------------------------------------------------------------------
// installLaunchAgent
// ---------------------------------------------------------------------------

describe('installLaunchAgent', () => {
  it('generates valid plist XML content', () => {
    mockedExecFileSync.mockImplementation(() => Buffer.from(''));

    installLaunchAgent(9111);

    const writeCall = mockedWriteFileSync.mock.calls.find((c: unknown[]) =>
      String(c[0]).includes('LaunchAgents'),
    );
    expect(writeCall).toBeDefined();
    const plistContent = String(writeCall![1]);
    expect(plistContent).toContain('<?xml version="1.0"');
    expect(plistContent).toContain('<plist version="1.0">');
    expect(plistContent).toContain('com.nr-ai-observe.daemon');
    expect(plistContent).toContain('</plist>');
  });

  it('writes to correct LaunchAgents path', () => {
    mockedExecFileSync.mockImplementation(() => Buffer.from(''));

    installLaunchAgent();

    expect(mockedWriteFileSync).toHaveBeenCalledWith(
      `${TEST_HOME}/Library/LaunchAgents/com.nr-ai-observe.daemon.plist`,
      expect.any(String),
      expect.anything(),
    );
  });

  it('includes port in plist arguments or environment', () => {
    mockedExecFileSync.mockImplementation(() => Buffer.from(''));

    installLaunchAgent(8080);

    const writeCall = mockedWriteFileSync.mock.calls.find((c: unknown[]) =>
      String(c[0]).includes('LaunchAgents'),
    );
    const plistContent = String(writeCall![1]);
    expect(plistContent).toContain('8080');
  });

  it('calls launchctl load after writing plist', () => {
    mockedExecFileSync.mockImplementation(() => Buffer.from(''));

    installLaunchAgent();

    const calls = mockedExecFileSync.mock.calls.map((c: unknown[]) => c as unknown[]);
    const loadCall = calls.find(
      (c: unknown[]) =>
        String(c[0]) === 'launchctl' && Array.isArray(c[1]) && (c[1] as string[]).includes('load'),
    );
    expect(loadCall).toBeDefined();
  });

  it('creates LaunchAgents directory if missing', () => {
    mockedExecFileSync.mockImplementation(() => Buffer.from(''));

    installLaunchAgent();

    expect(mockedMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('LaunchAgents'),
      expect.objectContaining({ recursive: true }),
    );
  });

  it('does not throw when launchctl unload fails (not yet loaded)', () => {
    mockedExecFileSync.mockImplementation((cmd: unknown, args: unknown) => {
      if (Array.isArray(args) && args[0] === 'unload') {
        throw new Error('not loaded');
      }
      return Buffer.from('');
    });

    expect(() => installLaunchAgent()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// removeLaunchAgent
// ---------------------------------------------------------------------------

describe('removeLaunchAgent', () => {
  it('calls launchctl unload with the plist path', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedExecFileSync.mockImplementation(() => Buffer.from(''));

    removeLaunchAgent();

    const calls = mockedExecFileSync.mock.calls.map((c: unknown[]) => c as unknown[]);
    const unloadCall = calls.find(
      (c: unknown[]) =>
        String(c[0]) === 'launchctl' &&
        Array.isArray(c[1]) &&
        (c[1] as string[]).includes('unload'),
    );
    expect(unloadCall).toBeDefined();
  });

  it('removes the plist file', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedExecFileSync.mockImplementation(() => Buffer.from(''));

    removeLaunchAgent();

    expect(mockedUnlinkSync).toHaveBeenCalledWith(
      `${TEST_HOME}/Library/LaunchAgents/com.nr-ai-observe.daemon.plist`,
    );
  });

  it('handles case where plist does not exist (no-op)', () => {
    mockedExistsSync.mockReturnValue(false);

    expect(() => removeLaunchAgent()).not.toThrow();
    expect(mockedExecFileSync).not.toHaveBeenCalled();
    expect(mockedUnlinkSync).not.toHaveBeenCalled();
  });

  it('does not throw when launchctl unload fails', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('Could not find specified service');
    });

    expect(() => removeLaunchAgent()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// isLaunchAgentInstalled
// ---------------------------------------------------------------------------

describe('isLaunchAgentInstalled', () => {
  it('returns true when plist file exists', () => {
    mockedExistsSync.mockImplementation((path: unknown) => {
      return String(path).includes('com.nr-ai-observe.daemon.plist');
    });

    expect(isLaunchAgentInstalled()).toBe(true);
  });

  it('returns false when plist file does not exist', () => {
    mockedExistsSync.mockReturnValue(false);

    expect(isLaunchAgentInstalled()).toBe(false);
  });

  it('checks the correct plist path', () => {
    mockedExistsSync.mockReturnValue(false);

    isLaunchAgentInstalled();

    expect(mockedExistsSync).toHaveBeenCalledWith(
      `${TEST_HOME}/Library/LaunchAgents/com.nr-ai-observe.daemon.plist`,
    );
  });
});
