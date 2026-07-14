import { homedir } from 'node:os';
import { join } from 'node:path';
import * as fsMod from 'node:fs';
import * as childMod from 'node:child_process';

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

import type { DiagnosticCheck } from './diagnostics.js';
import * as diagnostics from './diagnostics.js';

jest.mock('node:fs', () => ({
  readFileSync: jest.fn(() => '{}'),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
  existsSync: jest.fn(() => false),
  renameSync: jest.fn(),
  unlinkSync: jest.fn(),
  copyFileSync: jest.fn(),
  realpathSync: jest.fn((p: unknown) => p),
}));
jest.mock('node:child_process', () => ({
  execSync: jest.fn(),
  execFileSync: jest.fn(),
  spawn: jest.fn(() => ({ unref: jest.fn() })),
}));
jest.mock('./diagnostics.js', () => ({
  runDiagnostics: jest.fn(async () => []),
}));
jest.mock('./schedule.js', () => ({
  installSchedule: jest.fn(),
  removeSchedule: jest.fn(() => false),
  getScheduleStatus: jest.fn(() => ({ installed: false, readable: false })),
  installDashboardDaemon: jest.fn(),
  removeDashboardDaemon: jest.fn(() => false),
  getDashboardDaemonStatus: jest.fn(() => ({ installed: false, readable: false })),
  resolveBinaryPath: jest.fn(() => '/usr/local/bin/preflight'),
}));
jest.mock('./install-helper.js', () => ({
  mergeSettings: jest.fn((s: unknown) => s),
  removeSettings: jest.fn((s: unknown) => s),
  mergeMcpConfig: jest.fn((s: unknown) => s),
  removeMcpConfig: jest.fn((s: unknown) => s),
  detectSettingsPath: jest.fn(() => '/tmp/settings.json'),
  detectMcpConfigPath: jest.fn(() => '/tmp/mcp.json'),
  generateNrConfig: jest.fn(() => ({})),
}));
jest.mock('./platform.js', () => ({
  isWsl: jest.fn(() => false),
  resolveWindowsHome: jest.fn(() => null),
}));
jest.mock('node:readline/promises', () => ({
  createInterface: jest.fn(() => ({
    question: jest.fn(async () => 'y'),
    close: jest.fn(),
  })),
}));
jest.mock('../storage/index.js', () => ({
  LocalStore: jest.fn().mockImplementation(() => ({
    getLiveLocalDashboardProcess: jest.fn(() => null),
    listLocalInstances: jest.fn(() => []),
    gcDeadLocalInstances: jest.fn(() => 0),
    unregisterLocalInstance: jest.fn(),
  })),
}));
jest.mock('../config.js', () => ({
  ...(jest.requireActual('../config.js') as object),
  loadMcpConfig: jest.fn(),
}));

import { LocalStore } from '../storage/index.js';
import * as scheduleMod from './schedule.js';
import * as platformMod from './platform.js';
import { runInstallCli } from './cli.js';
import * as installHelperMod from './install-helper.js';
import * as configMod from '../config.js';

const mockedRunDiagnostics = diagnostics.runDiagnostics as jest.MockedFunction<
  typeof diagnostics.runDiagnostics
>;

const mockedSchedule = scheduleMod as unknown as {
  installSchedule: jest.Mock;
  removeSchedule: jest.Mock;
  getScheduleStatus: jest.Mock;
  installDashboardDaemon: jest.Mock;
  getDashboardDaemonStatus: jest.Mock;
  resolveBinaryPath: jest.Mock;
};
const mockedPlatform = platformMod as unknown as {
  isWsl: jest.Mock;
  resolveWindowsHome: jest.Mock;
};
const mockedHelper = installHelperMod as unknown as {
  mergeSettings: jest.Mock;
  mergeMcpConfig: jest.Mock;
  detectSettingsPath: jest.Mock;
  detectMcpConfigPath: jest.Mock;
};
const mockedConfig = configMod as unknown as { loadMcpConfig: jest.Mock };

describe('schedule subcommand', () => {
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let exitSpy: ReturnType<typeof jest.spyOn>;
  const savedPlatform = process.platform;

  beforeEach(() => {
    jest.clearAllMocks();
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit(${String(code)})`);
      });
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
    Object.defineProperty(process, 'platform', { value: savedPlatform, configurable: true });
  });

  it('prints status when no flags given and no schedule installed', async () => {
    mockedSchedule.getScheduleStatus.mockReturnValue({ installed: false, readable: false });
    await runInstallCli(['schedule']);
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('No auto-update schedule installed');
  });

  it('prints schedule time when already installed', async () => {
    mockedSchedule.getScheduleStatus.mockReturnValue({
      installed: true,
      readable: true,
      hour: 9,
      minute: 30,
      binaryPath: '/usr/local/bin/preflight',
    });
    await runInstallCli(['schedule']);
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('09:30');
  });

  it('prints unreadable-plist message when schedule installed but plist unreadable', async () => {
    mockedSchedule.getScheduleStatus.mockReturnValue({ installed: true, readable: false });
    await runInstallCli(['schedule']);
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('plist unreadable');
    expect(output).toContain('reinstall');
  });

  it('installs schedule with --time 08:00', async () => {
    await runInstallCli(['schedule', '--time', '08:00']);
    expect(mockedSchedule.installSchedule).toHaveBeenCalledWith('/usr/local/bin/preflight', 8, 0);
  });

  it('replaces existing schedule without prompting when --time given', async () => {
    mockedSchedule.getScheduleStatus.mockReturnValue({ installed: true, hour: 8, minute: 0 });
    await runInstallCli(['schedule', '--time', '09:30']);
    expect(mockedSchedule.installSchedule).toHaveBeenCalledWith('/usr/local/bin/preflight', 9, 30);
  });

  it('exits 1 when --time format is invalid', async () => {
    await expect(runInstallCli(['schedule', '--time', 'not-a-time'])).rejects.toThrow(
      'process.exit(1)',
    );
    expect(mockedSchedule.installSchedule).not.toHaveBeenCalled();
  });

  it('exits 1 when hour > 23', async () => {
    await expect(runInstallCli(['schedule', '--time', '25:00'])).rejects.toThrow('process.exit(1)');
  });

  it('exits 1 when minute > 59', async () => {
    await expect(runInstallCli(['schedule', '--time', '08:60'])).rejects.toThrow('process.exit(1)');
  });

  it('exits 1 when binary not on PATH', async () => {
    mockedSchedule.resolveBinaryPath.mockReturnValue(null);
    await expect(runInstallCli(['schedule', '--time', '08:00'])).rejects.toThrow('process.exit(1)');
    expect(mockedSchedule.installSchedule).not.toHaveBeenCalled();
  });

  it('removes schedule with --disable', async () => {
    await runInstallCli(['schedule', '--disable']);
    expect(mockedSchedule.removeSchedule).toHaveBeenCalled();
  });

  it('prints confirmation when --disable and schedule was installed', async () => {
    mockedSchedule.removeSchedule.mockReturnValue(true);
    await runInstallCli(['schedule', '--disable']);
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('Auto-update schedule removed');
  });

  it('exits 1 on non-macOS', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    await expect(runInstallCli(['schedule'])).rejects.toThrow('process.exit(1)');
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('macOS');
  });
});

describe('uninstall calls removeSchedule', () => {
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let exitSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    jest.clearAllMocks();
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit(${String(code)})`);
      });
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    process.exitCode = undefined;
  });

  it('calls removeSchedule during uninstall', async () => {
    mockedSchedule.getScheduleStatus.mockReturnValue({ installed: true, readable: true });
    mockedSchedule.removeSchedule.mockReturnValue(true);
    await runInstallCli(['uninstall']);
    expect(mockedSchedule.removeSchedule).toHaveBeenCalled();
  });

  it('prints removal confirmation when plist existed', async () => {
    mockedSchedule.getScheduleStatus.mockReturnValue({ installed: true, readable: true });
    mockedSchedule.removeSchedule.mockReturnValue(true);
    await runInstallCli(['uninstall']);
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('Auto-update schedule removed');
  });

  it('--yes skips the readline confirmation prompt', async () => {
    // Must have something to remove so the confirmation block is reached.
    mockedSchedule.getScheduleStatus.mockReturnValue({
      installed: true,
      readable: true,
      hour: 8,
      minute: 0,
    });
    mockedSchedule.removeSchedule.mockReturnValue(true);
    const rlMod = await import('node:readline/promises');
    const createInterfaceMock = rlMod.createInterface as jest.Mock;
    createInterfaceMock.mockClear();
    await runInstallCli(['uninstall', '--yes']);
    expect(createInterfaceMock).not.toHaveBeenCalled();
  });

  it('cancels without readline when stdin is not a TTY', async () => {
    const rlMod = await import('node:readline/promises');
    const createInterfaceMock = rlMod.createInterface as jest.Mock;
    createInterfaceMock.mockClear();
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      await runInstallCli(['uninstall']);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: originalIsTTY,
        configurable: true,
      });
    }
    expect(createInterfaceMock).not.toHaveBeenCalled();
    expect(stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('')).toContain(
      'non-interactive stdin',
    );
  });

  it('cancels without readline when isTTY is undefined (indeterminate state)', async () => {
    const rlMod = await import('node:readline/promises');
    const createInterfaceMock = rlMod.createInterface as jest.Mock;
    createInterfaceMock.mockClear();
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    try {
      await runInstallCli(['uninstall']);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    }
    expect(createInterfaceMock).not.toHaveBeenCalled();
    expect(stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('')).toContain(
      'non-interactive stdin',
    );
  });

  it('user answers n at confirmation prompt → prints Uninstall cancelled with exitCode 1', async () => {
    // Need something installed so changeSummary is non-empty and the prompt is reached.
    mockedSchedule.getScheduleStatus.mockReturnValue({ installed: true, readable: true });
    const rlMod = await import('node:readline/promises');
    const createInterfaceMock = rlMod.createInterface as jest.Mock;
    // Use mockImplementationOnce so this override doesn't bleed into later describe blocks.
    createInterfaceMock.mockImplementationOnce(() => ({
      question: jest.fn(async () => 'n'),
      close: jest.fn(),
    }));

    await runInstallCli(['uninstall']);

    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('Uninstall cancelled.');
    expect(process.exitCode).toBe(1);
  });

  it('uninstall --daemon removes daemon plist and prints completion message', async () => {
    const mockedRemoveDaemon = (scheduleMod as unknown as { removeDashboardDaemon: jest.Mock })
      .removeDashboardDaemon;
    mockedRemoveDaemon.mockReturnValue(true);
    const mockedGetDaemonStatus = (
      scheduleMod as unknown as { getDashboardDaemonStatus: jest.Mock }
    ).getDashboardDaemonStatus;
    mockedGetDaemonStatus.mockReturnValue({ installed: true, readable: true });
    // Default readline mock returns 'y' — confirmation proceeds automatically.

    await runInstallCli(['uninstall', '--daemon']);

    expect(mockedRemoveDaemon).toHaveBeenCalled();
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('Background dashboard daemon removed');
    expect(output).toContain('dashboard is now only available while Claude Code is running');
  });

  it('uninstall --daemon --yes skips confirmation prompt', async () => {
    const mockedRemoveDaemon = (scheduleMod as unknown as { removeDashboardDaemon: jest.Mock })
      .removeDashboardDaemon;
    mockedRemoveDaemon.mockReturnValue(true);
    const mockedGetDaemonStatus = (
      scheduleMod as unknown as { getDashboardDaemonStatus: jest.Mock }
    ).getDashboardDaemonStatus;
    mockedGetDaemonStatus.mockReturnValue({ installed: true, readable: true });
    const rlMod = await import('node:readline/promises');
    const createInterfaceMock = rlMod.createInterface as jest.Mock;
    createInterfaceMock.mockClear();

    await runInstallCli(['uninstall', '--daemon', '--yes']);

    expect(createInterfaceMock).not.toHaveBeenCalled();
    expect(mockedRemoveDaemon).toHaveBeenCalled();
  });

  it('uninstall --daemon when plist absent during removal prints already-absent message and exits 1', async () => {
    // TOCTOU: daemon installed at status-check time, plist vanishes before removal call.
    const mockedGetDaemonStatus = (
      scheduleMod as unknown as { getDashboardDaemonStatus: jest.Mock }
    ).getDashboardDaemonStatus;
    mockedGetDaemonStatus.mockReturnValue({ installed: true, readable: true });
    const mockedRemoveDaemon = (scheduleMod as unknown as { removeDashboardDaemon: jest.Mock })
      .removeDashboardDaemon;
    mockedRemoveDaemon.mockReturnValue(false);

    await runInstallCli(['uninstall', '--daemon']);

    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('Background dashboard daemon already absent');
    expect(process.exitCode).toBe(1);
  });

  it('uninstall --daemon combined with --project exits 1 with flag conflict message', async () => {
    await expect(runInstallCli(['uninstall', '--daemon', '--project'])).rejects.toThrow(
      'process.exit(1)',
    );
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('--daemon cannot be combined');
  });
});

describe('platform resolution via install', () => {
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let exitSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    jest.clearAllMocks();
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit(${String(code)})`);
      });
    // Re-set return values reset by earlier tests (clearAllMocks doesn't undo mockReturnValue).
    mockedSchedule.resolveBinaryPath.mockReturnValue('/usr/local/bin/preflight');
    // Use HOME-based paths so writeJsonFile's symlink guard allows the writes.
    mockedHelper.detectSettingsPath.mockReturnValue(`${homedir()}/.claude/settings.json`);
    mockedHelper.detectMcpConfigPath.mockReturnValue(`${homedir()}/.mcp.json`);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('non-WSL install passes platform native to mergeSettings', async () => {
    mockedPlatform.isWsl.mockReturnValue(false);
    await runInstallCli(['install']);
    expect(mockedHelper.mergeSettings).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      platform: 'native',
    });
  });

  it('--windows-cc outside WSL exits 1 with clear message', async () => {
    mockedPlatform.isWsl.mockReturnValue(false);
    await expect(runInstallCli(['install', '--windows-cc'])).rejects.toThrow('process.exit(1)');
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('only works inside WSL');
  });

  it('--linux-cc outside WSL exits 1', async () => {
    mockedPlatform.isWsl.mockReturnValue(false);
    await expect(runInstallCli(['install', '--linux-cc'])).rejects.toThrow('process.exit(1)');
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('only works inside WSL');
  });

  it('--linux-cc on WSL passes platform wsl-linux-cc to mergeSettings', async () => {
    mockedPlatform.isWsl.mockReturnValue(true);
    await runInstallCli(['install', '--linux-cc']);
    expect(mockedHelper.mergeSettings).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      platform: 'wsl-linux-cc',
    });
  });

  it('--windows-cc with no resolvable Windows home exits 1', async () => {
    mockedPlatform.isWsl.mockReturnValue(true);
    mockedPlatform.resolveWindowsHome.mockReturnValue(null);
    await expect(runInstallCli(['install', '--windows-cc'])).rejects.toThrow('process.exit(1)');
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('Windows home directory could not be resolved');
  });

  it('--windows-cc on WSL with resolvable home passes platform wsl-windows-cc to mergeSettings', async () => {
    mockedPlatform.isWsl.mockReturnValue(true);
    mockedPlatform.resolveWindowsHome.mockReturnValue('/mnt/c/Users/test');
    await runInstallCli(['install', '--windows-cc']);
    expect(mockedHelper.mergeSettings).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      platform: 'wsl-windows-cc',
    });
  });

  it('both flags together exits 1', async () => {
    await expect(runInstallCli(['install', '--windows-cc', '--linux-cc'])).rejects.toThrow(
      'process.exit(1)',
    );
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('mutually exclusive');
  });

  it('WSL with no prior state defaults to Linux CC with info message', async () => {
    mockedPlatform.isWsl.mockReturnValue(true);
    mockedPlatform.resolveWindowsHome.mockReturnValue('/mnt/c/Users/test');
    // existsSync returns false by default — no settings.json, no config.json
    await runInstallCli(['install']);
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('Defaulting to Linux Claude Code mode');
    expect(mockedHelper.mergeSettings).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      platform: 'wsl-linux-cc',
    });
  });
});

describe('platform resolution via uninstall', () => {
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let exitSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    jest.clearAllMocks();
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit(${String(code)})`);
      });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
    process.exitCode = undefined;
  });

  it('--windows-cc outside WSL exits 1', async () => {
    mockedPlatform.isWsl.mockReturnValue(false);
    await expect(runInstallCli(['uninstall', '--windows-cc'])).rejects.toThrow('process.exit(1)');
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('only works inside WSL');
  });

  it('--linux-cc outside WSL exits 1', async () => {
    mockedPlatform.isWsl.mockReturnValue(false);
    await expect(runInstallCli(['uninstall', '--linux-cc'])).rejects.toThrow('process.exit(1)');
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('only works inside WSL');
  });

  it('--windows-cc and --linux-cc together exits 1', async () => {
    await expect(runInstallCli(['uninstall', '--windows-cc', '--linux-cc'])).rejects.toThrow(
      'process.exit(1)',
    );
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('mutually exclusive');
  });
});

// ---------------------------------------------------------------------------
// Platform transition matrix — install/uninstall sequences and savedPlatform
// ---------------------------------------------------------------------------

const WINDOWS_HOME = '/mnt/c/Users/test';

type MockedFs = {
  readFileSync: jest.Mock;
  writeFileSync: jest.Mock;
  existsSync: jest.Mock;
};

function findConfigWrite(mockedFs: MockedFs): Record<string, unknown> | null {
  const call = mockedFs.writeFileSync.mock.calls.find((c: unknown[]) =>
    String(c[0]).endsWith('config.json.tmp'),
  );
  return call ? (JSON.parse(String(call[1])) as Record<string, unknown>) : null;
}

describe('platform transition matrix', () => {
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let exitSpy: ReturnType<typeof jest.spyOn>;
  let mFs: MockedFs;

  beforeEach(() => {
    jest.clearAllMocks();
    mFs = fsMod as unknown as MockedFs;
    // Re-arm fs implementations: clearAllMocks() clears call records but not implementations,
    // so a test that sets a custom mock would bleed into the next test without these resets.
    (fsMod as unknown as { existsSync: jest.Mock }).existsSync.mockImplementation(() => false);
    mFs.readFileSync.mockImplementation(() => '{}');
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit(${String(code)})`);
      });
    mockedSchedule.resolveBinaryPath.mockReturnValue('/usr/local/bin/preflight');
    mockedSchedule.getScheduleStatus.mockReturnValue({ installed: false, readable: false });
    mockedSchedule.removeSchedule.mockReturnValue(false);
    // Re-arm daemon mocks — clearAllMocks() clears call records but not mockReturnValue
    // overrides, so tests that set installed:true would bleed into later tests and trigger
    // the TOCTOU throw path in handleUninstall, causing anyFailed=true.
    (
      scheduleMod as unknown as { getDashboardDaemonStatus: jest.Mock }
    ).getDashboardDaemonStatus.mockReturnValue({ installed: false, readable: false });
    (
      scheduleMod as unknown as { removeDashboardDaemon: jest.Mock }
    ).removeDashboardDaemon.mockReturnValue(false);
    mockedHelper.detectSettingsPath.mockReturnValue(`${homedir()}/.claude/settings.json`);
    mockedHelper.detectMcpConfigPath.mockReturnValue(`${homedir()}/.mcp.json`);
    mockedPlatform.isWsl.mockReturnValue(true);
    mockedPlatform.resolveWindowsHome.mockReturnValue(WINDOWS_HOME);
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    process.exitCode = undefined;
  });

  // After bare uninstall of a wsl-linux-cc user, the Windows settings.json still exists
  // on disk (removeSettings strips hooks but leaves the file). A bare re-install must
  // NOT use existsSync(settings.json) as evidence of Windows CC intent — it should
  // default to wsl-linux-cc (the safe default).
  it('bare install with no savedPlatform but Windows settings.json on disk defaults to wsl-linux-cc', async () => {
    mFs.readFileSync.mockReturnValue('{}'); // no savedPlatform
    mFs.existsSync.mockImplementation(
      (p: unknown) => String(p) === join(WINDOWS_HOME, '.claude', 'settings.json'),
    );

    await runInstallCli(['install']);

    const written = findConfigWrite(mFs);
    expect(written?.platformTarget).toBe('wsl-linux-cc');
  });

  // --linux-cc is a targeted "clean Linux paths" command — it must not touch the
  // saved platform, so a wsl-windows-cc record must survive the operation.
  it('--linux-cc uninstall does not erase savedPlatform when it was wsl-windows-cc', async () => {
    mFs.readFileSync.mockReturnValue(JSON.stringify({ platformTarget: 'wsl-windows-cc' }));

    await runInstallCli(['uninstall', '--linux-cc']);

    // Any write to config.json must preserve platformTarget (or there must be no write at all).
    const configWrites = mFs.writeFileSync.mock.calls.filter((c: unknown[]) =>
      String(c[0]).endsWith('config.json.tmp'),
    );
    const erasedPlatform = configWrites.some((c: unknown[]) => {
      const written = JSON.parse(String(c[1])) as Record<string, unknown>;
      return !('platformTarget' in written);
    });
    expect(erasedPlatform).toBe(false);
  });

  // --windows-cc uninstall clears savedPlatform (not writes wsl-linux-cc) so the
  // user's repair-cycle intent is preserved: they must explicitly pass --windows-cc
  // on reinstall, rather than having the wrong platform silently baked in.
  it('--windows-cc uninstall clears platformTarget and prints reinstall reminder', async () => {
    mockedHelper.detectSettingsPath.mockImplementation((_scope: unknown, wh: unknown) =>
      wh ? `${String(wh)}/.claude/settings.json` : `${homedir()}/.claude/settings.json`,
    );
    mockedHelper.detectMcpConfigPath.mockImplementation((_scope: unknown, wh: unknown) =>
      wh ? `${String(wh)}/.mcp.json` : `${homedir()}/.mcp.json`,
    );
    mFs.readFileSync.mockReturnValue(JSON.stringify({ platformTarget: 'wsl-windows-cc' }));
    // Simulate that config.json and the Windows-side settings file exist.
    mFs.existsSync.mockImplementation(
      (p: unknown) =>
        String(p) === join(homedir(), '.newrelic-preflight', 'config.json') ||
        String(p) === join(WINDOWS_HOME, '.claude', 'settings.json'),
    );

    await runInstallCli(['uninstall', '--windows-cc']);

    // clearSavedPlatform() strips platformTarget — next bare install re-detects from scratch.
    const written = findConfigWrite(mFs);
    expect(written).not.toBeNull();
    expect(written?.platformTarget).toBeUndefined();
    // Remind the user how to get Windows CC back after uninstall.
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('preflight install --windows-cc');
  });

  // Regression guard: bare uninstall of wsl-windows-cc must clear savedPlatform.
  it('bare uninstall of wsl-windows-cc clears platformTarget', async () => {
    mockedHelper.detectSettingsPath.mockImplementation((_scope: unknown, wh: unknown) =>
      wh ? `${String(wh)}/.claude/settings.json` : `${homedir()}/.claude/settings.json`,
    );
    mockedHelper.detectMcpConfigPath.mockImplementation((_scope: unknown, wh: unknown) =>
      wh ? `${String(wh)}/.mcp.json` : `${homedir()}/.mcp.json`,
    );
    mFs.readFileSync.mockReturnValue(JSON.stringify({ platformTarget: 'wsl-windows-cc' }));
    mFs.existsSync.mockImplementation(
      (p: unknown) =>
        String(p) === join(homedir(), '.newrelic-preflight', 'config.json') ||
        String(p) === join(WINDOWS_HOME, '.claude', 'settings.json'),
    );

    await runInstallCli(['uninstall']);

    const written = findConfigWrite(mFs);
    expect(written).not.toBeNull();
    expect(written?.platformTarget).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Install side: verify platformTarget persisted after each install variant
  // ---------------------------------------------------------------------------

  it('install --windows-cc persists platformTarget wsl-windows-cc', async () => {
    mFs.readFileSync.mockReturnValue('{}');

    await runInstallCli(['install', '--windows-cc']);

    const written = findConfigWrite(mFs);
    expect(written?.platformTarget).toBe('wsl-windows-cc');
  });

  it('install --linux-cc persists platformTarget wsl-linux-cc', async () => {
    mFs.readFileSync.mockReturnValue('{}');

    await runInstallCli(['install', '--linux-cc']);

    const written = findConfigWrite(mFs);
    expect(written?.platformTarget).toBe('wsl-linux-cc');
  });

  it('bare WSL install with savedPlatform wsl-linux-cc re-persists wsl-linux-cc', async () => {
    mFs.readFileSync.mockReturnValue(JSON.stringify({ platformTarget: 'wsl-linux-cc' }));

    await runInstallCli(['install']);

    const written = findConfigWrite(mFs);
    expect(written?.platformTarget).toBe('wsl-linux-cc');
  });

  it('bare non-WSL install persists platformTarget native', async () => {
    mockedPlatform.isWsl.mockReturnValue(false);
    mFs.readFileSync.mockReturnValue('{}');

    await runInstallCli(['install']);

    const written = findConfigWrite(mFs);
    expect(written?.platformTarget).toBe('native');
  });

  // Regression guard: a stale platformTarget='native' in config.json (written by a
  // prior non-WSL install) must not suppress the WSL-mode informational message or
  // bypass WSL detection. 'native' is not a valid WSL target and must be treated as
  // if no saved platform exists when isWsl() returns true.
  it('bare WSL install with stale savedPlatform native ignores saved value and defaults to wsl-linux-cc', async () => {
    mFs.readFileSync.mockReturnValue(JSON.stringify({ platformTarget: 'native' }));

    await runInstallCli(['install']);

    const written = findConfigWrite(mFs);
    expect(written?.platformTarget).toBe('wsl-linux-cc');
  });

  // ---------------------------------------------------------------------------
  // Remaining uninstall cases
  // ---------------------------------------------------------------------------

  it('--linux-cc uninstall with savedPlatform wsl-linux-cc does not erase savedPlatform', async () => {
    mFs.readFileSync.mockReturnValue(JSON.stringify({ platformTarget: 'wsl-linux-cc' }));

    await runInstallCli(['uninstall', '--linux-cc']);

    const configWrites = mFs.writeFileSync.mock.calls.filter((c: unknown[]) =>
      String(c[0]).endsWith('config.json.tmp'),
    );
    const erasedPlatform = configWrites.some((c: unknown[]) => {
      const written = JSON.parse(String(c[1])) as Record<string, unknown>;
      return !('platformTarget' in written);
    });
    expect(erasedPlatform).toBe(false);
  });

  it('bare non-WSL uninstall clears platformTarget', async () => {
    mockedPlatform.isWsl.mockReturnValue(false);
    mockedPlatform.resolveWindowsHome.mockReturnValue(null);
    mFs.readFileSync.mockReturnValue(JSON.stringify({ platformTarget: 'native' }));
    mFs.existsSync.mockImplementation(
      (p: unknown) =>
        String(p) === join(homedir(), '.newrelic-preflight', 'config.json') ||
        String(p) === `${homedir()}/.claude/settings.json`,
    );

    await runInstallCli(['uninstall']);

    const written = findConfigWrite(mFs);
    expect(written).not.toBeNull();
    expect(written?.platformTarget).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // A Windows CC user who runs --linux-cc uninstall (to clean stale Linux paths)
  // must get Windows CC back on the next bare install — savedPlatform is preserved.
  // ---------------------------------------------------------------------------

  it('install --windows-cc → uninstall --linux-cc → bare install still uses Windows CC', async () => {
    mFs.readFileSync.mockReturnValue('{}');

    // Install Windows CC
    await runInstallCli(['install', '--windows-cc']);

    // Simulate the state written above (config.json now has wsl-windows-cc)
    mFs.readFileSync.mockReturnValue(JSON.stringify({ platformTarget: 'wsl-windows-cc' }));

    // Uninstall --linux-cc — must not clear savedPlatform
    await runInstallCli(['uninstall', '--linux-cc']);

    // Bare install — savedPlatform is still wsl-windows-cc; must use Windows CC paths
    const mergeCallsBefore = mockedHelper.mergeSettings.mock.calls.length;
    await runInstallCli(['install']);

    const lastCall = mockedHelper.mergeSettings.mock.calls[mergeCallsBefore];
    expect(lastCall?.[2]).toEqual({ platform: 'wsl-windows-cc' });
  });

  // ---------------------------------------------------------------------------
  // Untested resolvePlatform branch: saved wsl-windows-cc + interop disabled
  // ---------------------------------------------------------------------------

  // Realistic scenario: user installed with --windows-cc, later disables WSL
  // interop, then tries to reinstall. Must exit with a clear message rather
  // than silently using the wrong platform.
  it('bare WSL install with savedPlatform wsl-windows-cc but no windowsHome exits 1', async () => {
    mockedPlatform.resolveWindowsHome.mockReturnValue(null);
    mFs.readFileSync.mockReturnValue(JSON.stringify({ platformTarget: 'wsl-windows-cc' }));

    await expect(runInstallCli(['install'])).rejects.toThrow('process.exit(1)');
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('Windows home could not be resolved');
  });

  // Standalone confirmation that the saved wsl-windows-cc path (with interop
  // available) uses Windows CC — the round-trip proves this indirectly, but a
  // direct test makes the coverage explicit.
  it('bare WSL install with savedPlatform wsl-windows-cc uses Windows CC paths', async () => {
    mFs.readFileSync.mockReturnValue(JSON.stringify({ platformTarget: 'wsl-windows-cc' }));

    await runInstallCli(['install']);

    expect(mockedHelper.mergeSettings).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      platform: 'wsl-windows-cc',
    });
    const written = findConfigWrite(mFs);
    expect(written?.platformTarget).toBe('wsl-windows-cc');
  });

  // ---------------------------------------------------------------------------
  // Untested handleUninstall branches
  // ---------------------------------------------------------------------------

  it('uninstall --windows-cc on WSL with no windowsHome exits 1', async () => {
    mockedPlatform.resolveWindowsHome.mockReturnValue(null);

    await expect(runInstallCli(['uninstall', '--windows-cc'])).rejects.toThrow('process.exit(1)');
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('Windows home directory could not be resolved');
  });

  it('bare uninstall with savedPlatform wsl-windows-cc but no windowsHome exits 1', async () => {
    mockedPlatform.resolveWindowsHome.mockReturnValue(null);
    mFs.readFileSync.mockReturnValue(JSON.stringify({ platformTarget: 'wsl-windows-cc' }));

    await expect(runInstallCli(['uninstall'])).rejects.toThrow('process.exit(1)');
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('Windows home could not be resolved');
  });

  // Regression guard: non-WSL machine with stale wsl-windows-cc in config.json must not
  // exit 1 with a "re-enable WSL interop" message — that message is impossible to action.
  // The fix: when !wslEnv, treat Windows CC paths as unreachable and clean Linux paths only.
  it('bare uninstall with stale savedPlatform wsl-windows-cc on non-WSL machine cleans Linux paths and succeeds', async () => {
    mockedPlatform.isWsl.mockReturnValue(false);
    mockedPlatform.resolveWindowsHome.mockReturnValue(null);
    mFs.readFileSync.mockReturnValue(JSON.stringify({ platformTarget: 'wsl-windows-cc' }));
    mFs.existsSync.mockImplementation(
      (p: unknown) => String(p) === join(homedir(), '.newrelic-preflight', 'config.json'),
    );

    // Must NOT exit 1 — user on a native machine with a stale cross-machine config.
    await runInstallCli(['uninstall']);

    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).not.toContain('WSL interop may be disabled');
    // Linux-side settings and MCP paths must be targeted (not Windows paths).
    expect(mockedHelper.detectSettingsPath).toHaveBeenCalledWith(expect.anything(), null);
    expect(mockedHelper.detectMcpConfigPath).toHaveBeenCalledWith(expect.anything(), null);
  });

  it('bare uninstall with savedPlatform wsl-linux-cc clears platformTarget and targets Windows paths', async () => {
    mFs.readFileSync.mockReturnValue(JSON.stringify({ platformTarget: 'wsl-linux-cc' }));
    mFs.existsSync.mockImplementation(
      (p: unknown) =>
        String(p) === join(homedir(), '.newrelic-preflight', 'config.json') ||
        String(p) === `${homedir()}/.claude/settings.json`,
    );
    mockedHelper.detectSettingsPath.mockImplementation((_scope: unknown, wh: unknown) =>
      wh ? `${String(wh)}/.claude/settings.json` : `${homedir()}/.claude/settings.json`,
    );
    mockedHelper.detectMcpConfigPath.mockImplementation((_scope: unknown, wh: unknown) =>
      wh ? `${String(wh)}/.mcp.json` : `${homedir()}/.mcp.json`,
    );

    await runInstallCli(['uninstall']);

    const written = findConfigWrite(mFs);
    expect(written).not.toBeNull();
    expect(written?.platformTarget).toBeUndefined();
    // wsl-linux-cc bare uninstall also cleans Windows-side hooks when interop is available
    // (a prior --windows-cc install may have left hooks there).
    expect(mockedHelper.detectSettingsPath).toHaveBeenCalledWith(expect.anything(), WINDOWS_HOME);
    expect(mockedHelper.detectSettingsPath).toHaveBeenCalledWith(expect.anything(), null);
  });

  // clearSavedPlatform must preserve unrelated config fields — if it
  // overwrote config.json with just '{}' the user's licenseKey/accountId
  // would be silently wiped on every uninstall.
  it('bare uninstall preserves non-platformTarget fields in config.json', async () => {
    mFs.readFileSync.mockReturnValue(
      JSON.stringify({
        platformTarget: 'wsl-linux-cc',
        licenseKey: 'NRLIC-test',
        accountId: '12345',
      }),
    );
    mFs.existsSync.mockImplementation(
      (p: unknown) =>
        String(p) === join(homedir(), '.newrelic-preflight', 'config.json') ||
        String(p) === `${homedir()}/.claude/settings.json`,
    );

    await runInstallCli(['uninstall']);

    const written = findConfigWrite(mFs);
    expect(written?.platformTarget).toBeUndefined();
    expect(written?.licenseKey).toBe('NRLIC-test');
    expect(written?.accountId).toBe('12345');
  });

  // Pre-1.0.4 install: no platformTarget in config — the else branch cleans
  // both paths as a safety net and clears whatever was there.
  it('bare uninstall with no savedPlatform (pre-1.0.4) clears config and cleans both paths', async () => {
    mFs.readFileSync.mockReturnValue('{}'); // no platformTarget
    mFs.existsSync.mockImplementation(
      (p: unknown) =>
        String(p) === join(homedir(), '.newrelic-preflight', 'config.json') ||
        String(p) === join(WINDOWS_HOME, '.claude', 'settings.json'),
    );
    mockedHelper.detectSettingsPath.mockImplementation((_scope: unknown, wh: unknown) =>
      wh ? `${String(wh)}/.claude/settings.json` : `${homedir()}/.claude/settings.json`,
    );
    mockedHelper.detectMcpConfigPath.mockImplementation((_scope: unknown, wh: unknown) =>
      wh ? `${String(wh)}/.mcp.json` : `${homedir()}/.mcp.json`,
    );

    await runInstallCli(['uninstall']);

    // clearSavedPlatform writes to config.json — even starting from '{}', it writes '{}'
    const written = findConfigWrite(mFs);
    expect(written).not.toBeNull();
    expect(written?.platformTarget).toBeUndefined();
    // Both Windows and Linux paths were targeted (includeWindows=true when windowsHome reachable)
    expect(mockedHelper.detectSettingsPath).toHaveBeenCalledWith(expect.anything(), WINDOWS_HOME);
    expect(mockedHelper.detectSettingsPath).toHaveBeenCalledWith(expect.anything(), null);
  });

  // A user who ran `preflight install --linux-cc` then `preflight install --windows-cc`
  // (without uninstalling first) has Linux-side hooks still on disk. A bare uninstall
  // must clean both Windows AND Linux paths so those stale hooks don't keep firing.
  it('bare uninstall with savedPlatform wsl-windows-cc also targets Linux-side paths', async () => {
    mFs.readFileSync.mockReturnValue(JSON.stringify({ platformTarget: 'wsl-windows-cc' }));
    mockedHelper.detectSettingsPath.mockImplementation((_scope: unknown, wh: unknown) =>
      wh ? `${String(wh)}/.claude/settings.json` : `${homedir()}/.claude/settings.json`,
    );
    mockedHelper.detectMcpConfigPath.mockImplementation((_scope: unknown, wh: unknown) =>
      wh ? `${String(wh)}/.mcp.json` : `${homedir()}/.mcp.json`,
    );

    await runInstallCli(['uninstall']);

    // Both Windows-side and Linux-side paths must be targeted (symmetric with the
    // wsl-linux-cc case which also cleans the opposite platform's leftover hooks).
    expect(mockedHelper.detectSettingsPath).toHaveBeenCalledWith(expect.anything(), WINDOWS_HOME);
    expect(mockedHelper.detectSettingsPath).toHaveBeenCalledWith(expect.anything(), null);
  });

  // When the MCP config write fails after the settings write succeeded, the error
  // message must name the MCP config path so the user can diagnose which file failed.
  it('MCP config write failure names the MCP config path in the error output', async () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mFs.readFileSync.mockReturnValue('{}');
    const writeFsMock = fsMod as unknown as { writeFileSync: jest.Mock };
    // Call 1: settingsPath.tmp (success), Call 2: mcpPath.tmp (failure)
    writeFsMock.writeFileSync
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error('EACCES: permission denied');
      });

    await expect(runInstallCli(['install'])).rejects.toThrow();

    const stderr = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    const mcpPath = mockedHelper.detectMcpConfigPath.mock.results[0]?.value as string;
    expect(stderr).toContain(mcpPath);
    expect(stderr).toContain('EACCES');
    stderrSpy.mockRestore();
  });

  // When credentials are explicitly provided and the NR config write fails, the
  // error must be fatal — the process must not exit 0 while silently discarding
  // the user's credentials.
  it('NR config write failure with credentials re-throws (fatal, not silent exit 0)', async () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mFs.readFileSync.mockReturnValue('{}');
    const writeFsMock = fsMod as unknown as { writeFileSync: jest.Mock };
    // Calls 1+2: settings and mcp writes succeed; call 3: config.json.tmp write fails.
    writeFsMock.writeFileSync
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error('EACCES: permission denied');
      });

    await expect(
      runInstallCli(['install', '--license-key', 'NRLIC-test', '--account-id', '12345']),
    ).rejects.toThrow();

    const stderr = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(stderr).toContain('Failed to save New Relic config');
    expect(stderr).toContain('EACCES');
    stderrSpy.mockRestore();
  });

  // Bare uninstall on a machine that never had preflight installed must not create
  // config.json from scratch (clearSavedPlatform must be a no-op when the file
  // does not exist).
  it('bare uninstall does not create config.json on a clean machine (no prior install)', async () => {
    // Default mock: existsSync returns false for everything — no files on disk.
    mFs.readFileSync.mockReturnValue('{}');

    await runInstallCli(['uninstall']);

    const configWrites = (
      fsMod as unknown as { writeFileSync: jest.Mock }
    ).writeFileSync.mock.calls.filter((c: unknown[]) => String(c[0]).endsWith('config.json.tmp'));
    expect(configWrites).toHaveLength(0);
  });

  it('bare uninstall on a clean machine prints "Nothing installed" and returns early', async () => {
    // Default mock: existsSync returns false for everything — no files on disk.
    mFs.readFileSync.mockReturnValue('{}');
    // Explicitly reset schedule/daemon mocks — clearAllMocks() doesn't reset mockReturnValue,
    // so a leaked installed:true from a prior describe would make changeSummary non-empty.
    mockedSchedule.getScheduleStatus.mockReturnValue({ installed: false, readable: false });
    (
      scheduleMod as unknown as { getDashboardDaemonStatus: jest.Mock }
    ).getDashboardDaemonStatus.mockReturnValue({ installed: false, readable: false });

    await runInstallCli(['uninstall']);

    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('Nothing installed — no changes to make.');
  });

  // When the platformTarget write fails and no credentials were provided (the common
  // case), the user must see a warning rather than a silent no-op so they know the
  // next install will re-detect the platform from scratch.
  it('platformTarget write failure without credentials prints a warning to stderr', async () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mFs.readFileSync.mockReturnValue('{}');
    const writeFsMock = fsMod as unknown as { writeFileSync: jest.Mock };
    // Calls 1+2 succeed (settings and mcp), call 3 fails (config.json.tmp for platformTarget)
    writeFsMock.writeFileSync
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error('EPERM: read-only file system');
      });

    await runInstallCli(['install']); // non-fatal — must not throw

    const stderr = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(stderr).toContain('Could not persist platform target');
    expect(stderr).toContain('re-detect');
    stderrSpy.mockRestore();
  });

  // Non-WSL machine: bare install (no credentials) + unreadable config.json: warn,
  // skip config write, but complete — hooks still installed. The EACCES fires at the
  // credentials read (second read), not in resolvePlatform, and is non-fatal when no
  // credentials are being written. On WSL, EACCES on config.json is always fatal because
  // it could mask a saved wsl-windows-cc platform (see 'WSL EACCES is fatal' test).
  it('bare install with unreadable config.json warns and skips config write (non-fatal)', async () => {
    mockedPlatform.isWsl.mockReturnValue(false); // non-WSL: EACCES fires at credentials read
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const configPath = join(homedir(), '.newrelic-preflight', 'config.json');
    mFs.readFileSync.mockImplementation((p: unknown) => {
      if (String(p) === configPath) {
        const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        throw err;
      }
      return '{}';
    });
    mFs.existsSync.mockImplementation((p: unknown) => String(p) === configPath);

    await runInstallCli(['install']); // must not throw

    const stderr = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(stderr).toContain('Could not read existing NR config');
    expect(stderr).toContain('EACCES');
    // No config.json write — credentials are safe.
    const configWrites = mFs.writeFileSync.mock.calls.filter((c: unknown[]) =>
      String(c[0]).endsWith('config.json.tmp'),
    );
    expect(configWrites).toHaveLength(0);
    stderrSpy.mockRestore();
  });

  // WSL + unreadable config.json is always fatal: a saved wsl-windows-cc platform
  // could be hiding behind the EACCES, and silently falling back to wsl-linux-cc would
  // silently destroy the user's Windows CC setup.
  it('WSL bare install with unreadable config.json is fatal (prevents silent wsl-windows-cc override)', async () => {
    // isWsl=true is the beforeEach default
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const configPath = join(homedir(), '.newrelic-preflight', 'config.json');
    mFs.readFileSync.mockImplementation((p: unknown) => {
      if (String(p) === configPath) {
        const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        throw err;
      }
      return '{}';
    });
    mFs.existsSync.mockImplementation((p: unknown) => String(p) === configPath);

    await expect(runInstallCli(['install'])).rejects.toThrow();

    const stderr = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(stderr).toContain('Fix file permissions');
    // Hooks must NOT be written — install aborted before hook write.
    const hookWrites = mFs.writeFileSync.mock.calls.filter(
      (c: unknown[]) =>
        String(c[0]).endsWith('settings.json.tmp') || String(c[0]).endsWith('.mcp.json.tmp'),
    );
    expect(hookWrites).toHaveLength(0);
    stderrSpy.mockRestore();
  });

  // Regression guard: WSL + explicit platform flag + EACCES must NOT be fatal when no
  // credentials are provided. The explicit flag makes savedPlatform irrelevant, so EACCES
  // only means we can't persist platformTarget — same as the non-fatal non-WSL path.
  it('WSL install with --windows-cc and unreadable config.json is non-fatal (explicit flag makes savedPlatform irrelevant)', async () => {
    // isWsl=true is the beforeEach default
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const configPath = join(homedir(), '.newrelic-preflight', 'config.json');
    mFs.readFileSync.mockImplementation((p: unknown) => {
      if (String(p) === configPath) {
        const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        throw err;
      }
      return '{}';
    });
    mFs.existsSync.mockImplementation((p: unknown) => String(p) === configPath);

    // Must not throw — explicit flag makes the saved platform irrelevant.
    await runInstallCli(['install', '--windows-cc']);

    const stderr = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(stderr).toContain('Could not read existing NR config');
    // No config.json write — platformTarget not persisted, but hooks were installed.
    const configWrites = mFs.writeFileSync.mock.calls.filter((c: unknown[]) =>
      String(c[0]).endsWith('config.json.tmp'),
    );
    expect(configWrites).toHaveLength(0);
    stderrSpy.mockRestore();
  });

  // Credentialed install + unreadable config.json is fatal: we cannot safely persist
  // credentials without knowing the existing file contents.
  it('credentialed install with unreadable config.json is fatal (prevents silent credential wipe)', async () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const configPath = join(homedir(), '.newrelic-preflight', 'config.json');
    mFs.readFileSync.mockImplementation((p: unknown) => {
      if (String(p) === configPath) {
        const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        throw err;
      }
      return '{}';
    });
    mFs.existsSync.mockImplementation((p: unknown) => String(p) === configPath);

    await expect(
      runInstallCli(['install', '--license-key', 'NRLIC-foo', '--account-id', '12345']),
    ).rejects.toThrow();

    const stderr = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(stderr).toContain('Cannot read existing NR config');
    expect(stderr).toContain('EACCES');
    stderrSpy.mockRestore();
  });

  // Regression test: clearSavedPlatform previously used a lenient JSON reader that
  // silently returned {} on EACCES/EPERM, causing writeJsonFile to overwrite
  // config.json with {} and wipe licenseKey/accountId. Fix: use readJsonFileStrict —
  // IO errors are non-fatal (caught by the outer try/catch) and produce no write
  // rather than a credential-destroying write.
  it('uninstall with unreadable config.json does not write {} (no credential wipe)', async () => {
    const configPath = join(homedir(), '.newrelic-preflight', 'config.json');
    mFs.existsSync.mockImplementation((p: unknown) => String(p) === configPath);
    mFs.readFileSync.mockImplementation((p: unknown) => {
      if (String(p) === configPath) {
        const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        throw err;
      }
      return '{}';
    });

    await runInstallCli(['uninstall']); // non-fatal — must not throw

    // clearSavedPlatform must not write anything when the read fails.
    const configWrites = mFs.writeFileSync.mock.calls.filter((c: unknown[]) =>
      String(c[0]).endsWith('config.json.tmp'),
    );
    expect(configWrites).toHaveLength(0);
  });

  // Bug fix: !nrConfigWriteFailed guard was suppressing the "Both required" hint when
  // a partial credential was passed AND the platformTarget write failed. Both messages
  // carry independent information and must both fire.
  it('partial credential + platformTarget write failure: "Both required" hint still prints', async () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mFs.readFileSync.mockReturnValue('{}');
    const writeFsMock = fsMod as unknown as { writeFileSync: jest.Mock };
    // Settings and MCP writes succeed; config.json.tmp write fails.
    writeFsMock.writeFileSync
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error('EPERM: read-only file system');
      });

    await runInstallCli(['install', '--license-key', 'NRLIC-partial']); // non-fatal

    const stdout = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(stdout).toContain('Both --license-key and --account-id are required');
    stderrSpy.mockRestore();
  });

  // Malformed config.json is always fatal: readJsonFileStrict throws SyntaxError at the
  // single config read at the top of handleInstall. The install cannot safely write back
  // to corrupt JSON and must abort — re-detection would overwrite unknown existing state.
  it('install with malformed config.json is fatal (SyntaxError cannot be auto-detected around)', async () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const configPath = join(homedir(), '.newrelic-preflight', 'config.json');
    mFs.readFileSync.mockImplementation((p: unknown) => {
      if (String(p) === configPath) return '{"licenseKey": "NRLIC-truncated';
      return '{}';
    });
    mFs.existsSync.mockImplementation((p: unknown) => String(p) === configPath);

    await expect(runInstallCli(['install'])).rejects.toThrow();

    const stderr = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(stderr).toContain('Cannot read existing NR config');
    expect(stderr).toContain('invalid JSON');
    stderrSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// preflight update
// ---------------------------------------------------------------------------

describe('preflight update', () => {
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let exitSpy: ReturnType<typeof jest.spyOn>;
  let fetchSpy: ReturnType<typeof jest.spyOn>;
  let mFs: { existsSync: jest.Mock; realpathSync: jest.Mock; readFileSync: jest.Mock };
  let mExec: { execFileSync: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();
    mFs = fsMod as unknown as {
      existsSync: jest.Mock;
      realpathSync: jest.Mock;
      readFileSync: jest.Mock;
    };
    mExec = childMod as unknown as { execFileSync: jest.Mock };
    // Reset implementations (clearAllMocks only clears call records, not implementations).
    mExec.execFileSync.mockReset();
    mFs.readFileSync.mockReturnValue('{}');
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit(${String(code)})`);
      });
    mFs.existsSync.mockImplementation(() => false);
    // Reset implementations set per-test (clearAllMocks only clears call records).
    (LocalStore as unknown as jest.Mock).mockImplementation(() => ({
      getLiveLocalDashboardProcess: jest.fn(() => null),
    }));
    const readlineMod = await import('node:readline/promises');
    (readlineMod.createInterface as unknown as jest.Mock).mockReturnValue({
      question: jest.fn(async () => 'y'),
      close: jest.fn(),
    });
    const childModForSpawn = await import('node:child_process');
    (childModForSpawn.spawn as unknown as jest.Mock).mockImplementation(() => ({
      unref: jest.fn(),
    }));
    // Default: config can't be loaded, so verification is skipped silently and
    // the pre-existing unconditional-success messages are preserved. Tests that
    // want to exercise real verification override this explicitly.
    mockedConfig.loadMcpConfig.mockImplementation(() => {
      throw new Error('no config file');
    });
    fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('fetch not mocked'));
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
    fetchSpy.mockRestore();
    process.exitCode = undefined;
    jest.useRealTimers();
  });

  function getOutput(): string {
    return stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
  }

  it('exits 1 with package-manager hint when not a git repository (npm global install)', async () => {
    mFs.realpathSync.mockReturnValue(
      '/usr/local/lib/node_modules/@newrelic/preflight/dist/index.js',
    );
    mFs.existsSync.mockImplementation(
      (p: unknown) => String(p) === '/usr/local/lib/node_modules/@newrelic/preflight/package.json',
    );
    mExec.execFileSync.mockImplementation((cmd: unknown) => {
      if (cmd === 'git') throw new Error('not a git repository');
    });
    await expect(runInstallCli(['update'])).rejects.toThrow('process.exit(1)');
    const output = getOutput();
    expect(output).toContain('package manager');
    expect(output).toContain('npm install -g @newrelic/preflight@latest');
  });

  it('exits 1 with package-manager hint when installed into node_modules (local npm install)', async () => {
    mFs.realpathSync.mockReturnValue(
      '/home/user/myproject/node_modules/@newrelic/preflight/dist/index.js',
    );
    mFs.existsSync.mockImplementation(
      (p: unknown) =>
        String(p) === '/home/user/myproject/node_modules/@newrelic/preflight/package.json',
    );
    // git root is the project root; repoRoot sits below node_modules in the tree
    mExec.execFileSync.mockImplementation((cmd: unknown, args: unknown) => {
      if (cmd === 'git' && (args as string[]).includes('--show-toplevel'))
        return '/home/user/myproject';
    });
    await expect(runInstallCli(['update'])).rejects.toThrow('process.exit(1)');
    const output = getOutput();
    expect(output).toContain('package manager');
    expect(output).toContain('npm install -g @newrelic/preflight@latest');
  });

  it('exits 1 with git-not-installed hint when git binary is absent', async () => {
    mFs.realpathSync.mockReturnValue('/home/user/projects/preflight/dist/index.js');
    mFs.existsSync.mockImplementation(
      (p: unknown) => String(p) === '/home/user/projects/preflight/package.json',
    );
    mExec.execFileSync.mockImplementation(() => {
      throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
    });
    await expect(runInstallCli(['update'])).rejects.toThrow('process.exit(1)');
    const output = getOutput();
    expect(output).toContain('git is not installed');
    expect(output).toContain('https://git-scm.com');
    expect(output).not.toContain('package manager');
  });

  it('proceeds with update when source clone is inside a path with a node_modules ancestor', async () => {
    mFs.realpathSync.mockReturnValue('/home/user/node_modules/preflight/dist/index.js');
    mFs.existsSync.mockImplementation(
      (p: unknown) => String(p) === '/home/user/node_modules/preflight/package.json',
    );
    // git root IS repoRoot — no node_modules in the relative path, so it is a source clone
    mExec.execFileSync.mockImplementation((cmd: unknown, args: unknown) => {
      if (cmd === 'git' && (args as string[]).includes('--show-toplevel'))
        return '/home/user/node_modules/preflight';
      return undefined;
    });
    await runInstallCli(['update']);
    const output = getOutput();
    expect(output).toContain('Update complete');
    expect(output).not.toContain('package manager');
    expect(mExec.execFileSync).toHaveBeenCalledWith(
      'git',
      ['pull'],
      expect.objectContaining({ cwd: '/home/user/node_modules/preflight' }),
    );
    expect(mExec.execFileSync).toHaveBeenCalledWith(
      'npm',
      ['run', 'build'],
      expect.objectContaining({ cwd: '/home/user/node_modules/preflight' }),
    );
  });

  it('exits 1 with diverged-branch hint when git pull fails', async () => {
    mFs.realpathSync.mockReturnValue('/home/user/projects/preflight/dist/index.js');
    mFs.existsSync.mockImplementation(
      (p: unknown) => String(p) === '/home/user/projects/preflight/package.json',
    );
    mExec.execFileSync.mockImplementation((cmd: unknown, args: unknown) => {
      const a = args as string[];
      if (cmd === 'git' && a.includes('--show-toplevel')) return '/home/user/projects/preflight';
      if (cmd === 'git' && a[0] === 'pull') throw new Error('fatal: divergent branches');
    });
    await expect(runInstallCli(['update'])).rejects.toThrow('process.exit(1)');
    const output = getOutput();
    expect(output).toContain('git pull failed');
    expect(output).toContain('diverged');
    expect(output).toContain('fetch origin');
    expect(output).toContain('reset --hard');
  });

  it('exits 1 with plain build error and no divergence hint when npm build fails', async () => {
    mFs.realpathSync.mockReturnValue('/home/user/projects/preflight/dist/index.js');
    mFs.existsSync.mockImplementation(
      (p: unknown) => String(p) === '/home/user/projects/preflight/package.json',
    );
    mExec.execFileSync.mockImplementation((cmd: unknown, args: unknown) => {
      const a = args as string[];
      if (cmd === 'git' && a.includes('--show-toplevel')) return '/home/user/projects/preflight';
      if (cmd === 'npm') throw new Error('Build failed');
    });
    await expect(runInstallCli(['update'])).rejects.toThrow('process.exit(1)');
    const output = getOutput();
    expect(output).toContain('Build failed');
    expect(output).not.toContain('diverged');
    expect(output).not.toContain('fetch origin');
    expect(
      (mExec.execFileSync.mock.calls as unknown[][]).filter(
        (c) => c[0] === 'git' && (c[1] as string[])[0] === 'pull',
      ),
    ).toHaveLength(1);
  });

  it('proceeds with update when package is a subdirectory of the git root (monorepo layout)', async () => {
    mFs.realpathSync.mockReturnValue('/repo/packages/preflight/dist/index.js');
    mFs.existsSync.mockImplementation(
      (p: unknown) => String(p) === '/repo/packages/preflight/package.json',
    );
    mExec.execFileSync.mockImplementation((cmd: unknown, args: unknown) => {
      if (cmd === 'git' && (args as string[]).includes('--show-toplevel')) return '/repo';
      return undefined;
    });
    await runInstallCli(['update']);
    const output = getOutput();
    expect(output).toContain('Update complete');
    expect(output).not.toContain('package manager');
    expect(mExec.execFileSync).toHaveBeenCalledWith(
      'git',
      ['pull'],
      expect.objectContaining({ cwd: '/repo/packages/preflight' }),
    );
    expect(mExec.execFileSync).toHaveBeenCalledWith(
      'npm',
      ['run', 'build'],
      expect.objectContaining({ cwd: '/repo/packages/preflight' }),
    );
  });

  function mockSuccessfulBuild(): void {
    mFs.realpathSync.mockReturnValue('/home/user/projects/preflight/dist/index.js');
    mFs.existsSync.mockImplementation(
      (p: unknown) => String(p) === '/home/user/projects/preflight/package.json',
    );
    mExec.execFileSync.mockImplementation((cmd: unknown, args: unknown) => {
      if (cmd === 'git' && (args as string[]).includes('--show-toplevel'))
        return '/home/user/projects/preflight';
      return undefined;
    });
  }

  it('auto-restarts the dashboard daemon with no prompt when installed, verifying it comes back healthy', async () => {
    mockSuccessfulBuild();
    mockedSchedule.getDashboardDaemonStatus.mockReturnValue({
      installed: true,
      readable: true,
      binaryPath: '/usr/local/bin/preflight',
    });
    mFs.readFileSync.mockReturnValue('{"version":"1.4.0"}');
    mockedConfig.loadMcpConfig.mockReturnValue({
      dashboard: { host: '127.0.0.1', port: 7777 },
    });
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, version: '1.4.0' }),
    } as unknown as Response);
    await runInstallCli(['update']);
    expect(mockedSchedule.installDashboardDaemon).toHaveBeenCalledWith('/usr/local/bin/preflight');
    const output = getOutput();
    expect(output).toContain('Restarted the dashboard daemon');
    expect(output).not.toContain('could not be verified');
  });

  it('skips verification silently and keeps the success message when config cannot be loaded', async () => {
    mockSuccessfulBuild();
    mockedSchedule.getDashboardDaemonStatus.mockReturnValue({
      installed: true,
      readable: true,
      binaryPath: '/usr/local/bin/preflight',
    });
    // loadMcpConfig throws by default in this suite's beforeEach — no override needed.
    await runInstallCli(['update']);
    const output = getOutput();
    expect(output).toContain('Restarted the dashboard daemon');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('warns without restarting when the daemon plist exists but is unreadable', async () => {
    mockSuccessfulBuild();
    mockedSchedule.getDashboardDaemonStatus.mockReturnValue({ installed: true, readable: false });
    await runInstallCli(['update']);
    expect(mockedSchedule.installDashboardDaemon).not.toHaveBeenCalled();
    const output = getOutput();
    expect(output).toContain('unreadable');
  });

  it('does nothing further when no daemon and no live ad-hoc process are found', async () => {
    mockSuccessfulBuild();
    mockedSchedule.getDashboardDaemonStatus.mockReturnValue({ installed: false, readable: false });
    await runInstallCli(['update']);
    const output = getOutput();
    expect(output).not.toContain('Restart the running dashboard');
  });

  it('prompts default-yes and kills+respawns the ad-hoc process on accept', async () => {
    mockSuccessfulBuild();
    mockedSchedule.getDashboardDaemonStatus.mockReturnValue({ installed: false, readable: false });
    (LocalStore as unknown as jest.Mock).mockImplementation(() => ({
      getLiveLocalDashboardProcess: jest.fn(() => ({
        pid: 4242,
        argv: ['/repo/dist/index.js', '--local'],
        cwd: '/repo',
      })),
    }));
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    });
    const childMod2 = await import('node:child_process');
    const spawnMock = childMod2.spawn as unknown as jest.Mock;
    await runInstallCli(['update']);
    expect(killSpy).toHaveBeenCalledWith(4242, 'SIGTERM');
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      ['/repo/dist/index.js', '--local'],
      expect.objectContaining({ cwd: '/repo', detached: true }),
    );
    const output = getOutput();
    expect(output).toContain('Dashboard restarted');
    killSpy.mockRestore();
  });

  it('does not kill the ad-hoc process when the user declines the prompt', async () => {
    mockSuccessfulBuild();
    mockedSchedule.getDashboardDaemonStatus.mockReturnValue({ installed: false, readable: false });
    (LocalStore as unknown as jest.Mock).mockImplementation(() => ({
      getLiveLocalDashboardProcess: jest.fn(() => ({
        pid: 4242,
        argv: ['/repo/dist/index.js', '--local'],
        cwd: '/repo',
      })),
    }));
    const readlineMod = await import('node:readline/promises');
    (readlineMod.createInterface as unknown as jest.Mock).mockReturnValue({
      question: jest.fn(async () => 'n'),
      close: jest.fn(),
    });
    const killSpy = jest.spyOn(process, 'kill');
    await runInstallCli(['update']);
    expect(killSpy).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it('does not report "Build failed" or exit(1) when the restart-offer prompt rejects', async () => {
    mockSuccessfulBuild();
    mockedSchedule.getDashboardDaemonStatus.mockReturnValue({ installed: false, readable: false });
    (LocalStore as unknown as jest.Mock).mockImplementation(() => ({
      getLiveLocalDashboardProcess: jest.fn(() => ({
        pid: 4242,
        argv: ['/repo/dist/index.js', '--local'],
        cwd: '/repo',
      })),
    }));
    const readlineMod = await import('node:readline/promises');
    (readlineMod.createInterface as unknown as jest.Mock).mockReturnValue({
      question: jest.fn(async () => {
        throw new Error('stdin stream error');
      }),
      close: jest.fn(),
    });
    // Build succeeded and completed normally; only the restart-offer prompt failed.
    await runInstallCli(['update']);
    const output = getOutput();
    expect(output).toContain('Update complete');
    expect(output).not.toContain('Build failed');
    expect(output).toContain('Restart offer failed unexpectedly');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('falls through to the ad-hoc check when the daemon restart cannot be verified as healthy', async () => {
    mockSuccessfulBuild();
    mockedSchedule.getDashboardDaemonStatus.mockReturnValue({
      installed: true,
      readable: true,
      binaryPath: '/usr/local/bin/preflight',
    });
    mockedConfig.loadMcpConfig.mockReturnValue({
      dashboard: { host: '127.0.0.1', port: 7777 },
    });
    fetchSpy.mockRejectedValue(new Error('connection refused'));
    (LocalStore as unknown as jest.Mock).mockImplementation(() => ({
      getLiveLocalDashboardProcess: jest.fn(() => ({
        pid: 4242,
        argv: ['/repo/dist/index.js', '--local'],
        cwd: '/repo',
      })),
    }));
    const childMod2 = await import('node:child_process');
    const spawnMock = childMod2.spawn as unknown as jest.Mock;
    const readlineMod = await import('node:readline/promises');
    const questionMock = jest.fn(async (_prompt: string) => 'y');
    (readlineMod.createInterface as unknown as jest.Mock).mockReturnValue({
      question: questionMock,
      close: jest.fn(),
    });

    jest.useFakeTimers();
    const updatePromise = runInstallCli(['update']);
    // Two verification passes (daemon, then ad-hoc), 5s timeout each — advance
    // past both in one jump.
    await jest.advanceTimersByTimeAsync(11_000);
    await updatePromise;
    jest.useRealTimers();

    const output = getOutput();
    expect(output).toContain('could not be verified as healthy');
    expect(output).toContain('Checking for another running dashboard process instead');
    // The ad-hoc prompt text is passed to the (mocked) readline `question()`
    // call rather than written to stdout directly, so assert on the call
    // args to confirm the fallthrough actually reached the ad-hoc path.
    expect(questionMock).toHaveBeenCalledWith(
      expect.stringContaining('Restart the running dashboard (PID 4242)'),
    );
    expect(spawnMock).toHaveBeenCalled();
    expect(output).not.toContain('✓ Restarted the dashboard daemon');
  });

  it('prints a warning instead of a false success when the ad-hoc respawn cannot be verified as healthy', async () => {
    mockSuccessfulBuild();
    mockedSchedule.getDashboardDaemonStatus.mockReturnValue({ installed: false, readable: false });
    mockedConfig.loadMcpConfig.mockReturnValue({
      dashboard: { host: '127.0.0.1', port: 7777 },
    });
    fetchSpy.mockRejectedValue(new Error('connection refused'));
    (LocalStore as unknown as jest.Mock).mockImplementation(() => ({
      getLiveLocalDashboardProcess: jest.fn(() => ({
        pid: 4242,
        argv: ['/repo/dist/index.js', '--local'],
        cwd: '/repo',
      })),
    }));
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    });

    jest.useFakeTimers();
    const updatePromise = runInstallCli(['update']);
    await jest.advanceTimersByTimeAsync(6_000);
    await updatePromise;
    jest.useRealTimers();

    const output = getOutput();
    expect(output).toContain('could not be verified as healthy');
    expect(output).not.toContain('✓ Dashboard restarted.');
    killSpy.mockRestore();
  });

  it('prints both warnings and does not crash when the daemon is unverified and no ad-hoc process exists', async () => {
    mockSuccessfulBuild();
    mockedSchedule.getDashboardDaemonStatus.mockReturnValue({
      installed: true,
      readable: true,
      binaryPath: '/usr/local/bin/preflight',
    });
    mockedConfig.loadMcpConfig.mockReturnValue({
      dashboard: { host: '127.0.0.1', port: 7777 },
    });
    fetchSpy.mockRejectedValue(new Error('connection refused'));
    // LocalStore default (from beforeEach) already returns null — no live ad-hoc process.

    jest.useFakeTimers();
    const updatePromise = runInstallCli(['update']);
    await jest.advanceTimersByTimeAsync(6_000);
    await updatePromise;
    jest.useRealTimers();

    const output = getOutput();
    expect(output).toContain('could not be verified as healthy');
    expect(output).toContain('Checking for another running dashboard process instead');
    expect(output).not.toContain('Restart the running dashboard');
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// preflight local
// ---------------------------------------------------------------------------

describe('preflight local', () => {
  let stdoutSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(async () => {
    jest.clearAllMocks();
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    (LocalStore as unknown as jest.Mock).mockImplementation(() => ({
      getLiveLocalDashboardProcess: jest.fn(() => null),
      listLocalInstances: jest.fn(() => []),
      gcDeadLocalInstances: jest.fn(() => 0),
      unregisterLocalInstance: jest.fn(),
    }));
    const readlineMod = await import('node:readline/promises');
    (readlineMod.createInterface as unknown as jest.Mock).mockReturnValue({
      question: jest.fn(async () => 'y'),
      close: jest.fn(),
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  function getOutput(): string {
    return stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
  }

  it('prints "No --local processes running" when the registry is empty', async () => {
    await runInstallCli(['local']);
    expect(getOutput()).toContain('No --local processes running');
  });

  it('cleans up dead entries silently before listing', async () => {
    (LocalStore as unknown as jest.Mock).mockImplementation(() => ({
      getLiveLocalDashboardProcess: jest.fn(() => null),
      listLocalInstances: jest.fn(() => []),
      gcDeadLocalInstances: jest.fn(() => 2),
      unregisterLocalInstance: jest.fn(),
    }));
    await runInstallCli(['local']);
    expect(getOutput()).toContain('Cleaned up 2 stale registry entries');
  });

  it('lists live instances and marks the dashboard owner', async () => {
    (LocalStore as unknown as jest.Mock).mockImplementation(() => ({
      getLiveLocalDashboardProcess: jest.fn(() => ({ pid: 100, argv: [], cwd: '/owner' })),
      listLocalInstances: jest.fn(() => [
        { pid: 100, argv: [], cwd: '/owner', startedAt: Date.now() - 1000, alive: true },
        { pid: 200, argv: [], cwd: '/orphan', startedAt: Date.now() - 2000, alive: true },
      ]),
      gcDeadLocalInstances: jest.fn(() => 0),
      unregisterLocalInstance: jest.fn(),
    }));
    await runInstallCli(['local']);
    const output = getOutput();
    expect(output).toContain('2 --local process(es) running');
    expect(output).toContain('PID 100');
    expect(output).toContain('dashboard owner');
    expect(output).toContain('PID 200');
    expect(output).toContain('idle');
  });

  it('does not prompt or kill when --clean is omitted, even with orphans present', async () => {
    (LocalStore as unknown as jest.Mock).mockImplementation(() => ({
      getLiveLocalDashboardProcess: jest.fn(() => null),
      listLocalInstances: jest.fn(() => [
        { pid: 200, argv: [], cwd: '/orphan', startedAt: Date.now(), alive: true },
      ]),
      gcDeadLocalInstances: jest.fn(() => 0),
      unregisterLocalInstance: jest.fn(),
    }));
    const killSpy = jest.spyOn(process, 'kill');
    await runInstallCli(['local']);
    expect(killSpy).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it('--clean prompts default-yes and kills+unregisters every orphan on accept', async () => {
    const unregisterLocalInstance = jest.fn();
    (LocalStore as unknown as jest.Mock).mockImplementation(() => ({
      getLiveLocalDashboardProcess: jest.fn(() => ({ pid: 100, argv: [], cwd: '/owner' })),
      listLocalInstances: jest.fn(() => [
        { pid: 100, argv: [], cwd: '/owner', startedAt: Date.now(), alive: true },
        { pid: 200, argv: [], cwd: '/orphan-a', startedAt: Date.now(), alive: true },
        { pid: 201, argv: [], cwd: '/orphan-b', startedAt: Date.now(), alive: true },
      ]),
      gcDeadLocalInstances: jest.fn(() => 0),
      unregisterLocalInstance,
    }));
    const readlineMod = await import('node:readline/promises');
    const questionMock = jest.fn(async (_prompt: string) => 'y');
    (readlineMod.createInterface as unknown as jest.Mock).mockReturnValue({
      question: questionMock,
      close: jest.fn(),
    });
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    });
    await runInstallCli(['local', '--clean']);
    expect(killSpy).toHaveBeenCalledWith(200, 'SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(201, 'SIGTERM');
    expect(unregisterLocalInstance).toHaveBeenCalledWith(200);
    expect(unregisterLocalInstance).toHaveBeenCalledWith(201);
    // The confirmation prompt text is passed as the argument to the (mocked)
    // readline `question()` call rather than written to stdout directly —
    // real readline writes it to the output stream itself, which this bare
    // mock doesn't replicate. Same pattern used by the `preflight update`
    // ad-hoc-restart prompt tests above.
    expect(questionMock).toHaveBeenCalledWith(
      expect.stringContaining('Kill 2 orphaned processes?'),
    );
    const output = getOutput();
    expect(output).toContain('Killed PID 200');
    expect(output).toContain('Killed PID 201');
    killSpy.mockRestore();
  });

  it('escalates to SIGKILL when the orphaned process does not exit within the grace period', async () => {
    (LocalStore as unknown as jest.Mock).mockImplementation(() => ({
      getLiveLocalDashboardProcess: jest.fn(() => null),
      listLocalInstances: jest.fn(() => [
        { pid: 200, argv: [], cwd: '/orphan', startedAt: Date.now(), alive: true },
      ]),
      gcDeadLocalInstances: jest.fn(() => 0),
      unregisterLocalInstance: jest.fn(),
    }));
    const readlineMod = await import('node:readline/promises');
    (readlineMod.createInterface as unknown as jest.Mock).mockReturnValue({
      question: jest.fn(async () => 'y'),
      close: jest.fn(),
    });
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);

    jest.useFakeTimers();
    const runPromise = runInstallCli(['local', '--clean']);
    await jest.advanceTimersByTimeAsync(2100); // past the 2s grace-period loop
    await runPromise;
    jest.useRealTimers();

    expect(killSpy).toHaveBeenCalledWith(200, 'SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(200, 'SIGKILL');
    killSpy.mockRestore();
  });

  it('does not escalate to SIGKILL when the process exits before the grace period ends', async () => {
    (LocalStore as unknown as jest.Mock).mockImplementation(() => ({
      getLiveLocalDashboardProcess: jest.fn(() => null),
      listLocalInstances: jest.fn(() => [
        { pid: 200, argv: [], cwd: '/orphan', startedAt: Date.now(), alive: true },
      ]),
      gcDeadLocalInstances: jest.fn(() => 0),
      unregisterLocalInstance: jest.fn(),
    }));
    const readlineMod = await import('node:readline/promises');
    (readlineMod.createInterface as unknown as jest.Mock).mockReturnValue({
      question: jest.fn(async () => 'y'),
      close: jest.fn(),
    });
    let probeCount = 0;
    const killSpy = jest.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 0) {
        probeCount++;
        if (probeCount >= 2) {
          throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); // dead from the 2nd probe on
        }
        return true; // alive on the first probe
      }
      return true; // SIGTERM succeeds
    });

    jest.useFakeTimers();
    const runPromise = runInstallCli(['local', '--clean']);
    await jest.advanceTimersByTimeAsync(2100);
    await runPromise;
    jest.useRealTimers();

    expect(killSpy).toHaveBeenCalledWith(200, 'SIGTERM');
    expect(killSpy).not.toHaveBeenCalledWith(200, 'SIGKILL');
    killSpy.mockRestore();
  });

  it('--clean does not kill anything when the user declines', async () => {
    const readlineMod = await import('node:readline/promises');
    (readlineMod.createInterface as unknown as jest.Mock).mockReturnValue({
      question: jest.fn(async () => 'n'),
      close: jest.fn(),
    });
    (LocalStore as unknown as jest.Mock).mockImplementation(() => ({
      getLiveLocalDashboardProcess: jest.fn(() => null),
      listLocalInstances: jest.fn(() => [
        { pid: 200, argv: [], cwd: '/orphan', startedAt: Date.now(), alive: true },
      ]),
      gcDeadLocalInstances: jest.fn(() => 0),
      unregisterLocalInstance: jest.fn(),
    }));
    const killSpy = jest.spyOn(process, 'kill');
    await runInstallCli(['local', '--clean']);
    expect(killSpy).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it('--clean prints "No orphaned processes" when every live instance is the owner', async () => {
    (LocalStore as unknown as jest.Mock).mockImplementation(() => ({
      getLiveLocalDashboardProcess: jest.fn(() => ({ pid: 100, argv: [], cwd: '/owner' })),
      listLocalInstances: jest.fn(() => [
        { pid: 100, argv: [], cwd: '/owner', startedAt: Date.now(), alive: true },
      ]),
      gcDeadLocalInstances: jest.fn(() => 0),
      unregisterLocalInstance: jest.fn(),
    }));
    const killSpy = jest.spyOn(process, 'kill');
    await runInstallCli(['local', '--clean']);
    expect(getOutput()).toContain('No orphaned processes to clean up');
    expect(killSpy).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// preflight doctor
// ---------------------------------------------------------------------------

describe('preflight doctor', () => {
  let output: string[];
  beforeEach(() => {
    output = [];
    jest.spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    jest.clearAllMocks();
    // Re-arm the mock after clearAllMocks resets implementations.
    mockedRunDiagnostics.mockResolvedValue([]);
  });

  afterEach(() => {
    process.exitCode = undefined;
    jest.restoreAllMocks();
  });

  function makeCheck(overrides: Partial<DiagnosticCheck>): DiagnosticCheck {
    return {
      check: 'Config valid',
      status: 'ok',
      detail: 'Config loaded',
      ...overrides,
    };
  }

  it('prints "All checks passed" and exits 0 when all checks pass', async () => {
    mockedRunDiagnostics.mockResolvedValue([makeCheck({ status: 'ok' })]);
    const { createInstallProgram } = await import('./cli.js');
    const prog = createInstallProgram();
    await prog.parseAsync(['node', 'preflight', 'doctor']);
    expect(output.join('')).toContain('All checks passed');
    expect(process.exitCode).toBeFalsy();
  });

  it('sets exit code 1 when a check fails', async () => {
    mockedRunDiagnostics.mockResolvedValue([
      makeCheck({ status: 'fail', detail: 'bad', fix: 'preflight install' }),
    ]);
    const { createInstallProgram } = await import('./cli.js');
    const prog = createInstallProgram();
    await prog.parseAsync(['node', 'preflight', 'doctor']);
    expect(process.exitCode).toBe(1);
  });

  it('sets exit code 2 when only warnings', async () => {
    mockedRunDiagnostics.mockResolvedValue([makeCheck({ status: 'warn', detail: 'mild' })]);
    const { createInstallProgram } = await import('./cli.js');
    const prog = createInstallProgram();
    await prog.parseAsync(['node', 'preflight', 'doctor']);
    expect(process.exitCode).toBe(2);
  });

  it('prints fix instructions for failing checks', async () => {
    mockedRunDiagnostics.mockResolvedValue([
      makeCheck({
        check: 'Hooks wired',
        status: 'fail',
        detail: 'missing',
        fix: 'preflight install',
      }),
    ]);
    const { createInstallProgram } = await import('./cli.js');
    const prog = createInstallProgram();
    await prog.parseAsync(['node', 'preflight', 'doctor']);
    expect(output.join('')).toContain('preflight install');
  });

  it('prints skip checks with a dash', async () => {
    mockedRunDiagnostics.mockResolvedValue([makeCheck({ status: 'skip', detail: 'macOS only' })]);
    const { createInstallProgram } = await import('./cli.js');
    const prog = createInstallProgram();
    await prog.parseAsync(['node', 'preflight', 'doctor']);
    expect(output.join('')).toContain('-');
  });

  it('sets exit code 2 (not 1) when daemon is not installed', async () => {
    mockedRunDiagnostics.mockResolvedValue([
      makeCheck({
        check: 'Daemon installed',
        status: 'warn',
        detail: 'com.preflight.dashboard.plist not found',
        fix: 'preflight setup',
      }),
    ]);
    const { createInstallProgram } = await import('./cli.js');
    const prog = createInstallProgram();
    await prog.parseAsync(['node', 'preflight', 'doctor']);
    expect(process.exitCode).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// preflight validate
// ---------------------------------------------------------------------------

describe('preflight validate', () => {
  let output: string[];
  const mockedFsForValidate = fsMod as unknown as {
    existsSync: jest.Mock;
    readFileSync: jest.Mock;
  };

  beforeEach(() => {
    output = [];
    jest.spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    jest.clearAllMocks();
  });

  afterEach(() => {
    process.exitCode = undefined;
    jest.restoreAllMocks();
  });

  it('reports no config file found when the config path does not exist', async () => {
    mockedFsForValidate.existsSync.mockReturnValue(false);
    const { createInstallProgram } = await import('./cli.js');
    const prog = createInstallProgram();
    await prog.parseAsync(['node', 'preflight', 'validate']);
    expect(output.join('')).toContain('No config file found');
    expect(process.exitCode).toBeFalsy();
  });

  it('reports valid with no issues for a clean config', async () => {
    mockedFsForValidate.existsSync.mockReturnValue(true);
    mockedFsForValidate.readFileSync.mockReturnValue(
      JSON.stringify({ licenseKey: 'NRLIC-test', accountId: '12345' }),
    );
    const { createInstallProgram } = await import('./cli.js');
    const prog = createInstallProgram();
    await prog.parseAsync(['node', 'preflight', 'validate']);
    expect(output.join('')).toContain('Config is valid');
    expect(process.exitCode).toBeFalsy();
  });

  it('prints warnings and does not set an exit code for an unknown key', async () => {
    mockedFsForValidate.existsSync.mockReturnValue(true);
    mockedFsForValidate.readFileSync.mockReturnValue(JSON.stringify({ licenseKye: 'typo' }));
    const { createInstallProgram } = await import('./cli.js');
    const prog = createInstallProgram();
    await prog.parseAsync(['node', 'preflight', 'validate']);
    const joined = output.join('');
    expect(joined).toContain('Warning');
    expect(joined).toContain('1 warning');
    expect(process.exitCode).toBeFalsy();
  });

  it('prints errors and sets exit code 1 for invalid JSON', async () => {
    mockedFsForValidate.existsSync.mockReturnValue(true);
    mockedFsForValidate.readFileSync.mockReturnValue('{not valid json');
    const { createInstallProgram } = await import('./cli.js');
    const prog = createInstallProgram();
    await prog.parseAsync(['node', 'preflight', 'validate']);
    const joined = output.join('');
    expect(joined).toContain('Error');
    expect(joined).toContain('Config is invalid');
    expect(process.exitCode).toBe(1);
  });

  it('respects the --config flag for the file path', async () => {
    mockedFsForValidate.existsSync.mockImplementation(
      (p: unknown) => String(p) === '/custom/path/config.json',
    );
    mockedFsForValidate.readFileSync.mockReturnValue(JSON.stringify({ licenseKey: 'NRLIC-x' }));
    const { createInstallProgram } = await import('./cli.js');
    const prog = createInstallProgram();
    await prog.parseAsync([
      'node',
      'preflight',
      'validate',
      '--config',
      '/custom/path/config.json',
    ]);
    expect(output.join('')).toContain('/custom/path/config.json');
    expect(output.join('')).toContain('Config is valid');
  });
});
