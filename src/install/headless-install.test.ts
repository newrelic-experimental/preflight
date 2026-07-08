import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { jest } from '@jest/globals';

// Mock schedule.ts so resolveBinaryPath is injectable
jest.mock('./schedule.js', () => ({
  resolveBinaryPath: jest.fn<typeof import('./schedule.js').resolveBinaryPath>(),
}));

import { resolveBinaryPath } from './schedule.js';
import { writeJsonFile, readJsonFileStrict } from './json-utils.js';
import { installHooksHeadless } from './headless-install.js';

const mockResolveBinaryPath = resolveBinaryPath as jest.MockedFunction<typeof resolveBinaryPath>;

describe('installHooksHeadless()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'headless-install-test-'));
    mockResolveBinaryPath.mockReturnValue(null); // bare-name install by default
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('creates settings.json with hooks when file does not exist', () => {
    const settingsPath = join(tmpDir, 'settings.json');
    const result = installHooksHeadless({ _settingsPathOverride: settingsPath });

    expect(result.status).toBe('installed');
    if (result.status === 'installed') {
      expect(result.settingsPath).toBe(settingsPath);
    }

    const written = readJsonFileStrict(settingsPath);
    expect(typeof (written.hooks as Record<string, unknown>)?.PreToolUse).toBe('object');
  });

  it('adds hooks to existing settings.json that has no hooks', () => {
    const settingsPath = join(tmpDir, 'settings.json');
    writeJsonFile(settingsPath, { permissions: { allow: [] } }, tmpDir);

    const result = installHooksHeadless({ _settingsPathOverride: settingsPath });
    expect(result.status).toBe('installed');
  });

  it('returns already_installed when hooks are already present', () => {
    const settingsPath = join(tmpDir, 'settings.json');
    const pre = [
      { matcher: '', hooks: [{ type: 'command', command: 'preflight-collector pre-tool' }] },
    ];
    const post = [
      { matcher: '', hooks: [{ type: 'command', command: 'preflight-collector post-tool' }] },
    ];
    writeJsonFile(settingsPath, { hooks: { PreToolUse: pre, PostToolUse: post } }, tmpDir);

    const result = installHooksHeadless({ _settingsPathOverride: settingsPath });
    expect(result.status).toBe('already_installed');
  });

  it('returns error when settings directory is not writable', () => {
    // Point at a non-existent deep path to trigger write failure
    const settingsPath = '/nonexistent/deeply/nested/settings.json';
    const result = installHooksHeadless({ _settingsPathOverride: settingsPath });
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.message.length).toBeGreaterThan(0);
    }
  });
});
