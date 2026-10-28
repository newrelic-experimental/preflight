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
import { mergeSettings } from './install-helper.js';
import { installHooksHeadless, createHeadlessInstaller } from './headless-install.js';
import { existsSync } from 'node:fs';
import { AuditTrailManager } from '../security/audit-trail.js';

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

  it('refuses by default and writes nothing when allowHeadlessInstall is not set', () => {
    const settingsPath = join(tmpDir, 'settings.json');
    const result = installHooksHeadless({ _settingsPathOverride: settingsPath });

    expect(result.status).toBe('disabled');
    if (result.status === 'disabled') {
      expect(result.message).toContain('preflight install');
      expect(result.message).toContain('allowHeadlessInstall');
    }
    expect(existsSync(settingsPath)).toBe(false);
  });

  it('refuses and leaves an existing settings.json byte-identical when the flag is false', () => {
    const settingsPath = join(tmpDir, 'settings.json');
    writeJsonFile(settingsPath, { permissions: { allow: [] } }, tmpDir);
    const before = readJsonFileStrict(settingsPath);

    const result = installHooksHeadless({
      allowHeadlessInstall: false,
      _settingsPathOverride: settingsPath,
    });

    expect(result.status).toBe('disabled');
    expect(readJsonFileStrict(settingsPath)).toEqual(before);
  });

  it('creates settings.json with hooks when file does not exist', () => {
    const settingsPath = join(tmpDir, 'settings.json');
    const result = installHooksHeadless({
      allowHeadlessInstall: true,
      _settingsPathOverride: settingsPath,
    });

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

    const result = installHooksHeadless({
      allowHeadlessInstall: true,
      _settingsPathOverride: settingsPath,
    });
    expect(result.status).toBe('installed');
  });

  it('returns already_installed when all four hooks are already present', () => {
    const settingsPath = join(tmpDir, 'settings.json');
    writeJsonFile(settingsPath, mergeSettings({}), tmpDir);

    const result = installHooksHeadless({
      allowHeadlessInstall: true,
      _settingsPathOverride: settingsPath,
    });
    expect(result.status).toBe('already_installed');
  });

  it('returns already_installed and writes nothing when project-scope hooks exist', () => {
    const settingsPath = join(tmpDir, 'settings.json');
    const projectSettingsPath = join(tmpDir, 'project-settings.json');
    writeJsonFile(projectSettingsPath, mergeSettings({}), tmpDir);

    const result = installHooksHeadless({
      allowHeadlessInstall: true,
      _settingsPathOverride: settingsPath,
      _projectSettingsPathOverride: projectSettingsPath,
    });

    expect(result).toEqual({ status: 'already_installed', settingsPath: projectSettingsPath });
    expect(existsSync(settingsPath)).toBe(false);
  });

  it('installs at user scope when the project settings have no Preflight hooks', () => {
    const settingsPath = join(tmpDir, 'settings.json');
    const projectSettingsPath = join(tmpDir, 'project-settings.json');
    writeJsonFile(projectSettingsPath, { permissions: { allow: [] } }, tmpDir);

    const result = installHooksHeadless({
      allowHeadlessInstall: true,
      _settingsPathOverride: settingsPath,
      _projectSettingsPathOverride: projectSettingsPath,
    });

    expect(result).toEqual({ status: 'installed', settingsPath });
  });

  it('upgrades a pre/post-only install by adding the permission hooks', () => {
    const settingsPath = join(tmpDir, 'settings.json');
    const pre = [
      { matcher: '', hooks: [{ type: 'command', command: 'preflight-collector pre-tool' }] },
    ];
    const post = [
      { matcher: '', hooks: [{ type: 'command', command: 'preflight-collector post-tool' }] },
    ];
    writeJsonFile(settingsPath, { hooks: { PreToolUse: pre, PostToolUse: post } }, tmpDir);

    const result = installHooksHeadless({
      allowHeadlessInstall: true,
      _settingsPathOverride: settingsPath,
    });
    expect(result.status).toBe('installed');

    const written = readJsonFileStrict(settingsPath);
    const hooks = written.hooks as Record<string, unknown[]>;
    expect(hooks.PermissionRequest).toHaveLength(1);
    expect(hooks.PermissionDenied).toHaveLength(1);
  });

  it('returns error when settings directory is not writable', () => {
    // Point at a non-existent deep path to trigger write failure
    const settingsPath = '/nonexistent/deeply/nested/settings.json';
    const result = installHooksHeadless({
      allowHeadlessInstall: true,
      _settingsPathOverride: settingsPath,
    });
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.message.length).toBeGreaterThan(0);
    }
  });
});

describe('createHeadlessInstaller()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'headless-installer-test-'));
    mockResolveBinaryPath.mockReturnValue(null);
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  function hookInstallEntries(audit: AuditTrailManager) {
    return audit.getAuditLog().filter((r) => r.action === 'HookInstall');
  }

  it('refuses without writing settings or an audit entry when the flag is off', () => {
    const settingsPath = join(tmpDir, 'settings.json');
    const audit = new AuditTrailManager({ developer: 'dev', sessionId: 'sess-off' });
    const installer = createHeadlessInstaller({
      allowHeadlessInstall: false,
      getAuditTrail: () => audit,
      _settingsPathOverride: settingsPath,
    });

    const result = installer();

    expect(result.status).toBe('disabled');
    expect(existsSync(settingsPath)).toBe(false);
    expect(hookInstallEntries(audit)).toHaveLength(0);
  });

  it('installs hooks and records one HookInstall audit entry when the flag is on', () => {
    const settingsPath = join(tmpDir, 'settings.json');
    const audit = new AuditTrailManager({ developer: 'dev', sessionId: 'sess-on' });
    const installer = createHeadlessInstaller({
      allowHeadlessInstall: true,
      getAuditTrail: () => audit,
      _settingsPathOverride: settingsPath,
    });

    const result = installer();

    expect(result.status).toBe('installed');
    const entries = hookInstallEntries(audit);
    expect(entries).toHaveLength(1);
    expect(entries[0].tool).toBe('nr_observe_install_hooks');
    expect(entries[0].detail).toBe(`HookInstall: ${settingsPath}`);
    expect(entries[0].sessionId).toBe('sess-on');
  });

  it('hands the HookInstall audit record to onAuditRecord', () => {
    const settingsPath = join(tmpDir, 'settings.json');
    const audit = new AuditTrailManager({ developer: 'dev', sessionId: 'sess-nr' });
    const sent: string[] = [];
    const installer = createHeadlessInstaller({
      allowHeadlessInstall: true,
      getAuditTrail: () => audit,
      onAuditRecord: (record) => sent.push(`${record.action} ${record.detail}`),
      _settingsPathOverride: settingsPath,
    });

    installer();

    expect(sent).toEqual([`HookInstall HookInstall: ${settingsPath}`]);
  });

  it.each([
    [
      'onAuditRecord throws',
      (audit: AuditTrailManager) => ({
        getAuditTrail: () => audit,
        onAuditRecord: () => {
          throw new Error('ingest down');
        },
      }),
    ],
    [
      'the audit trail throws',
      () => ({
        getAuditTrail: (): AuditTrailManager | undefined => {
          throw new Error('audit store gone');
        },
      }),
    ],
  ])('still reports installed when %s', (_label, makeOptions) => {
    const settingsPath = join(tmpDir, 'settings.json');
    const audit = new AuditTrailManager({ developer: 'dev', sessionId: 'sess-guard' });
    const installer = createHeadlessInstaller({
      allowHeadlessInstall: true,
      _settingsPathOverride: settingsPath,
      ...makeOptions(audit),
    });

    expect(installer()).toEqual({ status: 'installed', settingsPath });
    expect(existsSync(settingsPath)).toBe(true);
  });

  it('writes no audit entry when hooks are already installed', () => {
    const settingsPath = join(tmpDir, 'settings.json');
    writeJsonFile(settingsPath, mergeSettings({}), tmpDir);
    const audit = new AuditTrailManager({ developer: 'dev', sessionId: 'sess-noop' });
    const installer = createHeadlessInstaller({
      allowHeadlessInstall: true,
      getAuditTrail: () => audit,
      _settingsPathOverride: settingsPath,
    });

    const result = installer();

    expect(result.status).toBe('already_installed');
    expect(hookInstallEntries(audit)).toHaveLength(0);
  });

  it('does not throw when no audit trail is available', () => {
    const settingsPath = join(tmpDir, 'settings.json');
    const installer = createHeadlessInstaller({
      allowHeadlessInstall: true,
      getAuditTrail: () => undefined,
      _settingsPathOverride: settingsPath,
    });

    expect(installer().status).toBe('installed');
  });
});
