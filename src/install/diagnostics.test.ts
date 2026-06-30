import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import { resolve } from 'node:path';

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
  getDashboardDaemonStatus: jest.fn(() => ({ installed: false })),
}));

// Stub config module.
jest.mock('../config.js', () => ({
  validateConfigFile: jest.fn(() => ({ fileExists: false, errors: [], warnings: [] })),
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
const mockedPlatform = nodeOs.platform as jest.Mock;
const mockedGetDaemonStatus = schedule.getDashboardDaemonStatus as jest.Mock;
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
    mockedGetDaemonStatus.mockReturnValue({ installed: false });
    mockedValidateConfig.mockReturnValue({ fileExists: false, errors: [], warnings: [] });
    mockedDetectSettingsPath.mockReturnValue('/test-home/.claude/settings.json');
    mockedIsWsl.mockReturnValue(false);
    mockFetch.mockResolvedValue({ ok: true } as Response);

    const mod = await import('./diagnostics.js');
    runDiagnostics = mod.runDiagnostics;
  });

  describe('Check 1: Config valid', () => {
    it('returns warn when config file does not exist', async () => {
      mockedValidateConfig.mockReturnValue({ fileExists: false, errors: [], warnings: [] });
      const checks = await runDiagnostics(makeOpts());
      const c = checks.find((x) => x.check === 'Config valid')!;
      expect(c.status).toBe('warn');
      expect(c.fix).toBe('preflight setup');
    });

    it('returns fail when config has errors', async () => {
      mockedValidateConfig.mockReturnValue({
        fileExists: true,
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
        errors: [],
        warnings: ['Unknown key "foo"'],
      });
      const checks = await runDiagnostics(makeOpts());
      const c = checks.find((x) => x.check === 'Config valid')!;
      expect(c.status).toBe('warn');
    });

    it('returns ok when config is valid', async () => {
      mockedValidateConfig.mockReturnValue({ fileExists: true, errors: [], warnings: [] });
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

    it('returns fail when daemon not installed', async () => {
      mockedGetDaemonStatus.mockReturnValue({ installed: false });
      const checks = await runDiagnostics(makeOpts());
      expect(checks.find((x) => x.check === 'Daemon installed')?.status).toBe('fail');
    });

    it('returns ok when daemon is installed', async () => {
      mockedGetDaemonStatus.mockReturnValue({ installed: true });
      mockedExistSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(
        '<key>PATH</key><string>/opt/homebrew/bin:/usr/bin</string>',
      );
      const checks = await runDiagnostics(makeOpts());
      expect(checks.find((x) => x.check === 'Daemon installed')?.status).toBe('ok');
    });
  });

  describe('Check 3: Daemon node path', () => {
    it('returns skip when daemon not installed', async () => {
      mockedGetDaemonStatus.mockReturnValue({ installed: false });
      const checks = await runDiagnostics(makeOpts());
      expect(checks.find((x) => x.check === 'Daemon node path')?.status).toBe('skip');
    });

    it('returns ok when node dir is in plist PATH', async () => {
      const nodeDir = resolve(process.execPath, '..');
      mockedGetDaemonStatus.mockReturnValue({ installed: true });
      mockedExistSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(`<key>PATH</key><string>${nodeDir}:/usr/bin</string>`);
      const checks = await runDiagnostics(makeOpts());
      expect(checks.find((x) => x.check === 'Daemon node path')?.status).toBe('ok');
    });

    it('returns fail when node dir is missing from plist PATH', async () => {
      mockedGetDaemonStatus.mockReturnValue({ installed: true });
      mockedExistSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(
        '<key>PATH</key><string>/some/other/bin:/usr/bin</string>',
      );
      const checks = await runDiagnostics(makeOpts());
      expect(checks.find((x) => x.check === 'Daemon node path')?.status).toBe('fail');
    });

    it('returns ok when node dir has trailing slash in plist PATH', async () => {
      const nodeDir = resolve(process.execPath, '..');
      mockedGetDaemonStatus.mockReturnValue({ installed: true });
      mockedExistSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(`<key>PATH</key><string>${nodeDir}/:/usr/bin</string>`);
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
    it('returns skip when mode is local', async () => {
      mockedValidateConfig.mockReturnValue({ fileExists: true, errors: [], warnings: [] });
      mockedReadFileSync.mockImplementation((p) => {
        if (String(p).endsWith('config.json')) return JSON.stringify({ mode: 'local' });
        return '{}';
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
