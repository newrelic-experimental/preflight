import { homedir } from 'node:os';
import { join } from 'node:path';
import * as fsMod from 'node:fs';
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

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
}));
jest.mock('./schedule.js', () => ({
  installSchedule: jest.fn(),
  removeSchedule: jest.fn(),
  getScheduleStatus: jest.fn(() => ({ installed: false })),
  installDashboardDaemon: jest.fn(),
  removeDashboardDaemon: jest.fn(),
  getDashboardDaemonStatus: jest.fn(() => ({ installed: false })),
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

import * as scheduleMod from './schedule.js';
import * as platformMod from './platform.js';
import { runInstallCli } from './cli.js';
import * as installHelperMod from './install-helper.js';

const mockedSchedule = scheduleMod as unknown as {
  installSchedule: jest.Mock;
  removeSchedule: jest.Mock;
  getScheduleStatus: jest.Mock;
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
    mockedSchedule.getScheduleStatus.mockReturnValue({ installed: false });
    await runInstallCli(['schedule']);
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('No auto-update schedule installed');
  });

  it('prints schedule time when already installed', async () => {
    mockedSchedule.getScheduleStatus.mockReturnValue({
      installed: true,
      hour: 9,
      minute: 30,
      binaryPath: '/usr/local/bin/preflight',
    });
    await runInstallCli(['schedule']);
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('09:30');
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
    mockedSchedule.getScheduleStatus.mockReturnValue({ installed: true });
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

  beforeEach(() => {
    jest.clearAllMocks();
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it('calls removeSchedule during uninstall', async () => {
    await runInstallCli(['uninstall']);
    expect(mockedSchedule.removeSchedule).toHaveBeenCalled();
  });

  it('prints removal confirmation when plist existed', async () => {
    mockedSchedule.getScheduleStatus.mockReturnValue({ installed: true });
    await runInstallCli(['uninstall']);
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('Auto-update schedule removed');
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
    mockedHelper.detectSettingsPath.mockReturnValue(`${homedir()}/.claude/settings.json`);
    mockedHelper.detectMcpConfigPath.mockReturnValue(`${homedir()}/.mcp.json`);
    mockedPlatform.isWsl.mockReturnValue(true);
    mockedPlatform.resolveWindowsHome.mockReturnValue(WINDOWS_HOME);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
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
    // Simulate that config.json exists (written by the prior --windows-cc install).
    mFs.existsSync.mockImplementation(
      (p: unknown) => String(p) === join(homedir(), '.newrelic-preflight', 'config.json'),
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
      (p: unknown) => String(p) === join(homedir(), '.newrelic-preflight', 'config.json'),
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
      (p: unknown) => String(p) === join(homedir(), '.newrelic-preflight', 'config.json'),
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
      (p: unknown) => String(p) === join(homedir(), '.newrelic-preflight', 'config.json'),
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
      (p: unknown) => String(p) === join(homedir(), '.newrelic-preflight', 'config.json'),
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
      (p: unknown) => String(p) === join(homedir(), '.newrelic-preflight', 'config.json'),
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

  // Bug fix: clearSavedPlatform used readJsonFile (lenient) which silently returns {}
  // on EACCES/EPERM, causing writeJsonFile to overwrite config.json with {} and wipe
  // licenseKey/accountId. Fix: use readJsonFileStrict — IO errors are non-fatal (caught
  // by the outer try/catch) and produce no write rather than a credential-destroying write.
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
