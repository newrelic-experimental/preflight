import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import { dirname, resolve } from 'node:path';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Suppress logger output.
jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

// Mock all fs I/O so tests are hermetic.
jest.mock('node:fs', () => {
  const real = jest.requireActual<typeof import('node:fs')>('node:fs');
  return {
    ...real,
    existsSync: jest.fn(),
    readFileSync: jest.fn(),
    accessSync: jest.fn(),
    statSync: jest.fn(),
    constants: real.constants,
  };
});

// Point homedir at a stable test path.
jest.mock('node:os', () => {
  const real = jest.requireActual<typeof import('node:os')>('node:os');
  return { ...real, homedir: () => '/test-home', platform: jest.fn(() => 'darwin') };
});

// Stub schedule module.
jest.mock('./schedule.js', () => ({
  getDashboardDaemonStatus: jest.fn(() => ({ installed: false, readable: false })),
  resolveNodeDir: jest.fn(() => dirname(process.execPath)),
  findExecutableNodeDir: jest.fn(() => ({ dir: null, hasNonExecutable: false })),
}));

// Stub config module.
jest.mock('../config.js', () => ({
  validateConfigFile: jest.fn(() => ({
    fileExists: false,
    malformed: false,
    errors: [],
    warnings: [],
  })),
  DEFAULT_STORAGE_PATH: '/test-home/.newrelic-preflight',
}));

// Stub install-helper.
jest.mock('./install-helper.js', () => ({
  detectSettingsPath: jest.fn(() => '/test-home/.claude/settings.json'),
  NR_HOOK_RE: /preflight-collector"?\s+(?:pre|post)-tool/,
  entryContainsNrObserve: jest.fn((entry: unknown) => {
    // Replicate minimal logic for tests that construct real hook entries
    if (typeof entry !== 'object' || entry === null) return false;
    const obj = entry as Record<string, unknown>;
    const re = /preflight-collector"?\s+(?:pre|post)-tool/;
    if (Array.isArray(obj.hooks)) {
      return (obj.hooks as Array<Record<string, unknown>>).some(
        (h) => typeof h.command === 'string' && re.test(h.command),
      );
    }
    if (typeof obj.command === 'string') return re.test(obj.command);
    return false;
  }),
  entryHasAnyCommandHook: jest.fn((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return false;
    const obj = entry as Record<string, unknown>;
    if (Array.isArray(obj.hooks)) {
      return (obj.hooks as Array<Record<string, unknown>>).some(
        (h) => typeof h.command === 'string' && h.command !== '',
      );
    }
    if (typeof obj.command === 'string') return obj.command !== '';
    return false;
  }),
}));

// Stub platform module.
jest.mock('./platform.js', () => ({
  isWsl: jest.fn(() => false),
  resolveWindowsHome: jest.fn(() => null),
}));

// Stub global fetch.
const mockFetch = jest.fn<typeof fetch>();
global.fetch = mockFetch as unknown as typeof fetch;

import type { DiagnosticCheck } from './diagnostics.js';
import * as schedule from './schedule.js';
import * as config from '../config.js';
import * as installHelper from './install-helper.js';
import * as platform from './platform.js';

const mockedExistSync = nodeFs.existsSync as jest.Mock;
const mockedReadFileSync = nodeFs.readFileSync as jest.Mock;
const mockedAccessSync = nodeFs.accessSync as jest.Mock;
const mockedStatSync = nodeFs.statSync as jest.Mock;
const mockedPlatform = nodeOs.platform as jest.Mock;
const mockedGetDaemonStatus = schedule.getDashboardDaemonStatus as jest.Mock;
const mockedFindExecutableNodeDir = schedule.findExecutableNodeDir as jest.Mock;
const mockedValidateConfig = config.validateConfigFile as jest.Mock;
const mockedDetectSettingsPath = installHelper.detectSettingsPath as jest.Mock;
const mockedIsWsl = platform.isWsl as jest.Mock;

function makeOpts() {
  return {
    configPath: '/test-home/.newrelic-preflight/config.json',
    storagePath: '/test-home/.newrelic-preflight',
  };
}

describe('runDiagnostics', () => {
  let runDiagnostics: (opts?: {
    configPath?: string;
    storagePath?: string;
  }) => Promise<DiagnosticCheck[]>;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockedPlatform.mockReturnValue('darwin');
    mockedExistSync.mockReturnValue(false);
    mockedReadFileSync.mockReturnValue('{}');
    mockedAccessSync.mockImplementation(() => undefined);
    mockedGetDaemonStatus.mockReturnValue({ installed: false, readable: false });
    mockedValidateConfig.mockReturnValue({
      fileExists: false,
      malformed: false,
      errors: [],
      warnings: [],
    });
    mockedDetectSettingsPath.mockReturnValue('/test-home/.claude/settings.json');
    mockedIsWsl.mockReturnValue(false);
    mockFetch.mockResolvedValue({ ok: true } as Response);
    mockedStatSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    mockedFindExecutableNodeDir.mockReturnValue({ dir: null, hasNonExecutable: false });

    const mod = await import('./diagnostics.js');
    runDiagnostics = mod.runDiagnostics;
  });

  describe('Check 1: Config valid', () => {
    it('returns warn when config file does not exist', async () => {
      mockedValidateConfig.mockReturnValue({
        fileExists: false,
        malformed: false,
        errors: [],
        warnings: [],
      });
      const checks = await runDiagnostics(makeOpts());
      const c = checks.find((x) => x.check === 'Config valid')!;
      expect(c.status).toBe('warn');
      expect(c.fix).toBe('preflight setup');
    });

    it('returns fail when config has errors', async () => {
      mockedValidateConfig.mockReturnValue({
        fileExists: true,
        malformed: false,
        errors: ['mode: bad value'],
        warnings: [],
      });
      const checks = await runDiagnostics(makeOpts());
      const c = checks.find((x) => x.check === 'Config valid')!;
      expect(c.status).toBe('fail');
      expect(c.detail).toContain('mode: bad value');
    });

    it('returns warn when config has warnings only', async () => {
      mockedValidateConfig.mockReturnValue({
        fileExists: true,
        malformed: false,
        errors: [],
        warnings: ['Unknown key "foo"'],
      });
      const checks = await runDiagnostics(makeOpts());
      const c = checks.find((x) => x.check === 'Config valid')!;
      expect(c.status).toBe('warn');
    });

    it('returns ok when config is valid', async () => {
      mockedValidateConfig.mockReturnValue({
        fileExists: true,
        malformed: false,
        errors: [],
        warnings: [],
      });
      const checks = await runDiagnostics(makeOpts());
      const c = checks.find((x) => x.check === 'Config valid')!;
      expect(c.status).toBe('ok');
    });
  });

  describe('Check 2: Daemon installed', () => {
    it('returns skip on non-macOS', async () => {
      mockedPlatform.mockReturnValue('linux');
      const checks = await runDiagnostics(makeOpts());
      expect(checks.find((x) => x.check === 'Daemon installed')?.status).toBe('skip');
    });

    it('returns warn when daemon not installed', async () => {
      mockedGetDaemonStatus.mockReturnValue({ installed: false, readable: false });
      const checks = await runDiagnostics(makeOpts());
      expect(checks.find((x) => x.check === 'Daemon installed')?.status).toBe('warn');
    });

    it('returns ok when daemon is installed', async () => {
      mockedGetDaemonStatus.mockReturnValue({
        installed: true,
        readable: true,
        envPath: '/opt/homebrew/bin:/usr/bin',
      });
      mockedExistSync.mockReturnValue(true);
      const checks = await runDiagnostics(makeOpts());
      expect(checks.find((x) => x.check === 'Daemon installed')?.status).toBe('ok');
    });
  });

  describe('Check 3: Daemon node path', () => {
    it('returns skip when daemon not installed', async () => {
      mockedGetDaemonStatus.mockReturnValue({ installed: false, readable: false });
      const checks = await runDiagnostics(makeOpts());
      expect(checks.find((x) => x.check === 'Daemon node path')?.status).toBe('skip');
    });

    it('returns warn for Daemon installed and skip for Daemon node path when plist is unreadable', async () => {
      mockedGetDaemonStatus.mockReturnValue({ installed: true, readable: false });
      const checks = await runDiagnostics(makeOpts());
      const installed = checks.find((x) => x.check === 'Daemon installed')!;
      expect(installed.status).toBe('warn');
      expect(installed.detail).toContain('could not be read');
      const nodePath = checks.find((x) => x.check === 'Daemon node path')!;
      expect(nodePath.status).toBe('skip');
    });

    it('returns warn (not fail) when plist has no PATH key (older install without node-path injection)', async () => {
      mockedGetDaemonStatus.mockReturnValue({ installed: true, readable: true });
      const checks = await runDiagnostics(makeOpts());
      const c = checks.find((x) => x.check === 'Daemon node path')!;
      expect(c.status).toBe('warn');
      expect(c.detail).toContain('predates node-path injection');
    });

    it('returns ok when a node binary exists in plist PATH', async () => {
      const nodeDir = resolve(process.execPath, '..');
      mockedGetDaemonStatus.mockReturnValue({
        installed: true,
        readable: true,
        envPath: `${nodeDir}:/usr/bin`,
      });
      mockedFindExecutableNodeDir.mockReturnValue({ dir: nodeDir, hasNonExecutable: false });
      const checks = await runDiagnostics(makeOpts());
      expect(checks.find((x) => x.check === 'Daemon node path')?.status).toBe('ok');
    });

    it('returns fail when node dir is missing from plist PATH', async () => {
      mockedGetDaemonStatus.mockReturnValue({
        installed: true,
        readable: true,
        envPath: '/some/other/bin:/usr/bin',
      });
      const checks = await runDiagnostics(makeOpts());
      const c = checks.find((x) => x.check === 'Daemon node path')!;
      expect(c.status).toBe('fail');
      expect(c.detail).toContain('No executable');
    });

    it('returns fail with permissions message when node binary exists but is not executable', async () => {
      const nodeDir = resolve(process.execPath, '..');
      mockedGetDaemonStatus.mockReturnValue({
        installed: true,
        readable: true,
        envPath: `${nodeDir}:/usr/bin`,
      });
      mockedFindExecutableNodeDir.mockReturnValue({ dir: null, hasNonExecutable: true });
      const checks = await runDiagnostics(makeOpts());
      const c = checks.find((x) => x.check === 'Daemon node path')!;
      expect(c.status).toBe('fail');
      expect(c.detail).toContain('not executable');
    });

    it('returns ok when plist PATH dir has a trailing slash', async () => {
      const nodeDir = resolve(process.execPath, '..');
      mockedGetDaemonStatus.mockReturnValue({
        installed: true,
        readable: true,
        envPath: `${nodeDir}/:/usr/bin`,
      });
      mockedFindExecutableNodeDir.mockReturnValue({ dir: nodeDir, hasNonExecutable: false });
      const checks = await runDiagnostics(makeOpts());
      expect(checks.find((x) => x.check === 'Daemon node path')?.status).toBe('ok');
    });
  });

  describe('Check 4: Hooks wired', () => {
    it('returns fail when settings file does not exist', async () => {
      mockedExistSync.mockImplementation((p) => p !== '/test-home/.claude/settings.json');
      const checks = await runDiagnostics(makeOpts());
      const c = checks.find((x) => x.check === 'Hooks wired')!;
      expect(c.status).toBe('fail');
      expect(c.detail).toContain('Settings file not found');
    });

    it('returns fail when hooks are missing', async () => {
      mockedExistSync.mockImplementation((p) => p === '/test-home/.claude/settings.json');
      mockedReadFileSync.mockImplementation((p) => {
        if (p === '/test-home/.claude/settings.json') return JSON.stringify({ hooks: {} });
        return '{}';
      });
      const checks = await runDiagnostics(makeOpts());
      expect(checks.find((x) => x.check === 'Hooks wired')?.status).toBe('fail');
    });

    it('returns ok when both PreToolUse and PostToolUse hooks are present', async () => {
      const hookEntry = {
        matcher: '',
        hooks: [{ type: 'command', command: 'preflight-collector pre-tool' }],
      };
      const postEntry = {
        matcher: '',
        hooks: [{ type: 'command', command: 'preflight-collector post-tool' }],
      };
      mockedExistSync.mockImplementation((p) => p === '/test-home/.claude/settings.json');
      mockedReadFileSync.mockImplementation((p) => {
        if (p === '/test-home/.claude/settings.json')
          return JSON.stringify({ hooks: { PreToolUse: [hookEntry], PostToolUse: [postEntry] } });
        return '{}';
      });
      const checks = await runDiagnostics(makeOpts());
      expect(checks.find((x) => x.check === 'Hooks wired')?.status).toBe('ok');
    });

    it('includes malformed-file note when one path parses and another fails JSON.parse', async () => {
      mockedIsWsl.mockReturnValue(true);
      const winHome = '/mnt/c/Users/testuser';
      (platform.resolveWindowsHome as jest.Mock).mockReturnValue(winHome);
      const linuxPath = '/test-home/.claude/settings.json';
      const winPath = `${winHome}/.claude/settings.json`;
      mockedDetectSettingsPath.mockReturnValueOnce(linuxPath).mockReturnValueOnce(winPath);
      mockedExistSync.mockImplementation((p) => p === linuxPath || p === winPath);
      mockedReadFileSync.mockImplementation((p) => {
        if (p === linuxPath) throw new SyntaxError('Unexpected token');
        return JSON.stringify({ hooks: {} }); // winPath parses but has no hooks
      });
      const checks = await runDiagnostics(makeOpts());
      const c = checks.find((x) => x.check === 'Hooks wired')!;
      expect(c.status).toBe('fail');
      expect(c.detail).toContain(linuxPath);
      expect(c.detail).toContain('could not be parsed');
    });

    it('uses plural "files" and lists both paths when both settings files fail JSON.parse', async () => {
      mockedIsWsl.mockReturnValue(true);
      const winHome = '/mnt/c/Users/testuser';
      (platform.resolveWindowsHome as jest.Mock).mockReturnValue(winHome);
      const linuxPath = '/test-home/.claude/settings.json';
      const winPath = `${winHome}/.claude/settings.json`;
      mockedDetectSettingsPath.mockReturnValueOnce(linuxPath).mockReturnValueOnce(winPath);
      mockedExistSync.mockImplementation((p) => p === linuxPath || p === winPath);
      mockedReadFileSync.mockImplementation(() => {
        throw new SyntaxError('Unexpected token');
      });
      const checks = await runDiagnostics(makeOpts());
      const c = checks.find((x) => x.check === 'Hooks wired')!;
      expect(c.status).toBe('fail');
      expect(c.detail).toContain('files');
      expect(c.detail).toContain(linuxPath);
      expect(c.detail).toContain(winPath);
    });

    it('returns ok when hooks are on the Windows-side path (WSL)', async () => {
      mockedIsWsl.mockReturnValue(true);
      const winHome = '/mnt/c/Users/testuser';
      (platform.resolveWindowsHome as jest.Mock).mockReturnValue(winHome);
      mockedDetectSettingsPath
        .mockReturnValueOnce('/test-home/.claude/settings.json') // Linux path (no hooks)
        .mockReturnValueOnce(`${winHome}/.claude/settings.json`); // Windows path (has hooks)
      const hookEntry = {
        matcher: '',
        hooks: [{ type: 'command', command: 'preflight-collector pre-tool' }],
      };
      const postEntry = {
        matcher: '',
        hooks: [{ type: 'command', command: 'preflight-collector post-tool' }],
      };
      mockedExistSync.mockImplementation((p) => p === `${winHome}/.claude/settings.json`);
      mockedReadFileSync.mockImplementation((p) => {
        if (p === `${winHome}/.claude/settings.json`)
          return JSON.stringify({ hooks: { PreToolUse: [hookEntry], PostToolUse: [postEntry] } });
        return '{}';
      });
      const checks = await runDiagnostics(makeOpts());
      expect(checks.find((x) => x.check === 'Hooks wired')?.status).toBe('ok');
    });

    it('returns warn when both PreToolUse and PostToolUse have custom (non-NR) commands', async () => {
      const preEntry = {
        matcher: '',
        hooks: [{ type: 'command', command: '/home/user/wrapper.sh pre-tool' }],
      };
      const postEntry = {
        matcher: '',
        hooks: [{ type: 'command', command: '/home/user/wrapper.sh post-tool' }],
      };
      mockedExistSync.mockImplementation((p) => p === '/test-home/.claude/settings.json');
      mockedReadFileSync.mockImplementation((p) => {
        if (p === '/test-home/.claude/settings.json')
          return JSON.stringify({ hooks: { PreToolUse: [preEntry], PostToolUse: [postEntry] } });
        return '{}';
      });
      const checks = await runDiagnostics(makeOpts());
      const c = checks.find((x) => x.check === 'Hooks wired')!;
      expect(c.status).toBe('warn');
      expect(c.detail).toContain('custom hook command');
      expect(c.detail).toContain('preflight-collector');
      expect(c.fix).toBeDefined();
    });

    it('returns warn when one event has the NR hook and the other has a custom command', async () => {
      const preNrEntry = {
        matcher: '',
        hooks: [{ type: 'command', command: 'preflight-collector pre-tool' }],
      };
      const postCustomEntry = {
        matcher: '',
        hooks: [{ type: 'command', command: '/home/user/wrapper.sh post-tool' }],
      };
      mockedExistSync.mockImplementation((p) => p === '/test-home/.claude/settings.json');
      mockedReadFileSync.mockImplementation((p) => {
        if (p === '/test-home/.claude/settings.json')
          return JSON.stringify({
            hooks: { PreToolUse: [preNrEntry], PostToolUse: [postCustomEntry] },
          });
        return '{}';
      });
      const checks = await runDiagnostics(makeOpts());
      const c = checks.find((x) => x.check === 'Hooks wired')!;
      expect(c.status).toBe('warn');
      expect(c.detail).toContain('PostToolUse');
      expect(c.detail).toContain('custom hook command');
    });

    it('returns fail when one event has the NR hook and the other has no hook at all', async () => {
      // PostToolUse is completely absent — this is a misconfiguration, not a wrapper.
      const preNrEntry = {
        matcher: '',
        hooks: [{ type: 'command', command: 'preflight-collector pre-tool' }],
      };
      mockedExistSync.mockImplementation((p) => p === '/test-home/.claude/settings.json');
      mockedReadFileSync.mockImplementation((p) => {
        if (p === '/test-home/.claude/settings.json')
          return JSON.stringify({ hooks: { PreToolUse: [preNrEntry] } }); // PostToolUse absent
        return '{}';
      });
      const checks = await runDiagnostics(makeOpts());
      const c = checks.find((x) => x.check === 'Hooks wired')!;
      expect(c.status).toBe('fail');
      expect(c.detail).toContain('PostToolUse');
      expect(c.detail).not.toContain('warn');
    });
  });

  describe('Check 5: Storage writable', () => {
    it('returns fail when directory does not exist', async () => {
      mockedExistSync.mockImplementation((p) => p !== '/test-home/.newrelic-preflight');
      mockedAccessSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      const checks = await runDiagnostics(makeOpts());
      expect(checks.find((x) => x.check === 'Storage writable')?.status).toBe('fail');
    });

    it('returns fail when directory is not writable', async () => {
      mockedExistSync.mockReturnValue(true);
      mockedAccessSync.mockImplementation(() => {
        throw new Error('EACCES');
      });
      const checks = await runDiagnostics(makeOpts());
      expect(checks.find((x) => x.check === 'Storage writable')?.status).toBe('fail');
    });

    it('returns ok when directory is writable', async () => {
      mockedExistSync.mockReturnValue(true);
      mockedAccessSync.mockImplementation(() => undefined);
      const checks = await runDiagnostics(makeOpts());
      expect(checks.find((x) => x.check === 'Storage writable')?.status).toBe('ok');
    });
  });

  describe('Check 6: NR reachable', () => {
    beforeEach(() => {
      mockedValidateConfig.mockReturnValue({
        fileExists: true,
        malformed: false,
        mode: 'cloud',
        hasLicenseKey: true,
        errors: [],
        warnings: [],
      });
    });

    it('skips NR check when licenseKey is absent from config and env (prevents misleading ok when events would 403)', async () => {
      mockedValidateConfig.mockReturnValue({
        fileExists: true,
        malformed: false,
        mode: 'cloud',
        errors: [],
        warnings: [],
      });
      const origEnv = process.env.NEW_RELIC_LICENSE_KEY;
      delete process.env.NEW_RELIC_LICENSE_KEY;
      const checks = await runDiagnostics(makeOpts());
      process.env.NEW_RELIC_LICENSE_KEY = origEnv;
      const c = checks.find((x) => x.check === 'NR reachable')!;
      expect(c.status).toBe('skip');
      expect(c.detail).toContain('licenseKey not configured');
    });

    it('skips NR check when config file is absent (prevents misleading double-failure on first-time setup)', async () => {
      mockedValidateConfig.mockReturnValue({
        fileExists: false,
        malformed: false,
        errors: [],
        warnings: [],
      });
      const checks = await runDiagnostics(makeOpts());
      const c = checks.find((x) => x.check === 'NR reachable')!;
      expect(c.status).toBe('skip');
      expect(c.detail).toContain('no config file');
    });

    it('skips NR check when config.json has invalid JSON (prevents misleading fail alongside real config error)', async () => {
      mockedValidateConfig.mockReturnValue({
        fileExists: true,
        malformed: true,
        errors: ['invalid JSON'],
        warnings: [],
      });
      const checks = await runDiagnostics(makeOpts());
      const c = checks.find((x) => x.check === 'NR reachable')!;
      expect(c.status).toBe('skip');
      expect(c.detail).toContain('could not be parsed');
    });

    it('returns skip when mode is local', async () => {
      mockedValidateConfig.mockReturnValue({
        fileExists: true,
        malformed: false,
        mode: 'local',
        errors: [],
        warnings: [],
      });
      const checks = await runDiagnostics(makeOpts());
      expect(checks.find((x) => x.check === 'NR reachable')?.status).toBe('skip');
    });

    it('returns ok when fetch succeeds', async () => {
      mockFetch.mockResolvedValue({ ok: true } as Response);
      const checks = await runDiagnostics(makeOpts());
      expect(checks.find((x) => x.check === 'NR reachable')?.status).toBe('ok');
    });

    it('returns fail with network error message on fetch rejection', async () => {
      mockFetch.mockRejectedValue(new Error('network error'));
      const checks = await runDiagnostics(makeOpts());
      const c = checks.find((x) => x.check === 'NR reachable')!;
      expect(c.status).toBe('fail');
      expect(c.detail).toContain('Could not reach');
    });

    it('returns fail with timeout message on AbortError', async () => {
      const abortErr = new Error('aborted');
      abortErr.name = 'AbortError';
      mockFetch.mockRejectedValue(abortErr);
      const checks = await runDiagnostics(makeOpts());
      const c = checks.find((x) => x.check === 'NR reachable')!;
      expect(c.status).toBe('fail');
      expect(c.detail).toContain('timed out');
    });
  });

  it('returns exactly 6 checks on macOS', async () => {
    const checks = await runDiagnostics(makeOpts());
    expect(checks).toHaveLength(6);
  });
});
