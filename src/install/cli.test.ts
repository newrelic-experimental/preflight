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

import * as scheduleMod from './schedule.js';
import { runInstallCli } from './cli.js';

const mockedSchedule = scheduleMod as unknown as {
  installSchedule: jest.Mock;
  removeSchedule: jest.Mock;
  getScheduleStatus: jest.Mock;
  resolveBinaryPath: jest.Mock;
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
