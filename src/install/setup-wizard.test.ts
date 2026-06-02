import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { buildConfig, runSetupWizard, copyStarterAlertRules } from './setup-wizard.js';
import * as rlMod from 'node:readline/promises';
import * as fsMod from 'node:fs';

// ---------------------------------------------------------------------------
// Module-level mocks (hoisted above imports by jest at runtime).
// The buildConfig tests below are unaffected (pure function; no fs/readline).
// ---------------------------------------------------------------------------
jest.mock('node:readline/promises', () => ({ createInterface: jest.fn() }));
jest.mock('node:fs', () => ({
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
  existsSync: jest.fn(),
  copyFileSync: jest.fn(),
  chmodSync: jest.fn(),
}));
jest.mock('./cli.js', () => ({ runInstallCli: jest.fn() }));

// Typed handles to the mocked module functions.
const mockedFs = fsMod as unknown as {
  readFileSync: jest.Mock;
  writeFileSync: jest.Mock;
  mkdirSync: jest.Mock;
  existsSync: jest.Mock;
  copyFileSync: jest.Mock;
  chmodSync: jest.Mock;
};
const mockedRl = rlMod as unknown as { createInterface: jest.Mock };

// ---------------------------------------------------------------------------
// copyStarterAlertRules — Phase 4 task 24
// ---------------------------------------------------------------------------

describe('copyStarterAlertRules', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('copies the source file when destination does not exist', () => {
    mockedFs.existsSync.mockImplementation((p: unknown) => p === '/src/rules.json');
    mockedFs.copyFileSync.mockReturnValue(undefined);
    mockedFs.mkdirSync.mockReturnValue(undefined);
    mockedFs.chmodSync.mockReturnValue(undefined);

    const result = copyStarterAlertRules({
      sourcePath: '/src/rules.json',
      destPath: '/dest/alerts/rules.json',
    });

    expect(result.copied).toBe(true);
    expect(mockedFs.copyFileSync).toHaveBeenCalledWith(
      '/src/rules.json',
      '/dest/alerts/rules.json',
    );
  });

  it('skips when destination already exists', () => {
    mockedFs.existsSync.mockReturnValue(true);

    const result = copyStarterAlertRules({
      sourcePath: '/src/rules.json',
      destPath: '/dest/alerts/rules.json',
    });

    expect(result.copied).toBe(false);
    expect(result.reason).toBe('exists');
    expect(mockedFs.copyFileSync).not.toHaveBeenCalled();
  });

  it('creates the destination directory with 0o700 permissions', () => {
    mockedFs.existsSync.mockImplementation((p: unknown) => p === '/src/rules.json');
    mockedFs.copyFileSync.mockReturnValue(undefined);
    mockedFs.mkdirSync.mockReturnValue(undefined);
    mockedFs.chmodSync.mockReturnValue(undefined);

    copyStarterAlertRules({
      sourcePath: '/src/rules.json',
      destPath: '/dest/alerts/rules.json',
    });

    expect(mockedFs.mkdirSync).toHaveBeenCalledWith(
      '/dest/alerts',
      { recursive: true, mode: 0o700 },
    );
  });

  it('chmods the copied file to 0o600', () => {
    mockedFs.existsSync.mockImplementation((p: unknown) => p === '/src/rules.json');
    mockedFs.copyFileSync.mockReturnValue(undefined);
    mockedFs.mkdirSync.mockReturnValue(undefined);
    mockedFs.chmodSync.mockReturnValue(undefined);

    copyStarterAlertRules({
      sourcePath: '/src/rules.json',
      destPath: '/dest/alerts/rules.json',
    });

    expect(mockedFs.chmodSync).toHaveBeenCalledWith(
      '/dest/alerts/rules.json',
      0o600,
    );
  });

  it('returns a friendly reason when the source is missing', () => {
    mockedFs.existsSync.mockReturnValue(false);

    const result = copyStarterAlertRules({
      sourcePath: '/nope/does-not-exist.json',
      destPath: '/dest/alerts/rules.json',
    });

    expect(result.copied).toBe(false);
    expect(result.reason).toBe('source-missing');
    expect(mockedFs.copyFileSync).not.toHaveBeenCalled();
  });

  it('returns the error message when copyFileSync throws', () => {
    mockedFs.existsSync.mockImplementation((p: unknown) => p === '/src/rules.json');
    mockedFs.mkdirSync.mockReturnValue(undefined);
    mockedFs.copyFileSync.mockImplementation(() => {
      throw new Error('disk full');
    });

    const result = copyStarterAlertRules({
      sourcePath: '/src/rules.json',
      destPath: '/dest/alerts/rules.json',
    });

    expect(result.copied).toBe(false);
    expect(result.reason).toContain('disk full');
  });

  it('still reports success if chmod fails (Windows path)', () => {
    mockedFs.existsSync.mockImplementation((p: unknown) => p === '/src/rules.json');
    mockedFs.copyFileSync.mockReturnValue(undefined);
    mockedFs.mkdirSync.mockReturnValue(undefined);
    mockedFs.chmodSync.mockImplementation(() => {
      throw new Error('chmod ENOSYS');
    });

    const result = copyStarterAlertRules({
      sourcePath: '/src/rules.json',
      destPath: '/dest/alerts/rules.json',
    });

    expect(result.copied).toBe(true);
  });
});

describe('buildConfig', () => {
  it('merges new fields with existing config', () => {
    const result = buildConfig(
      { appName: 'my-app', existingField: 'keep-me' },
      { accountId: '12345', licenseKey: 'nrlic', developer: 'alice', teamId: null, projectId: null, sessionBudgetUsd: null },
    );
    expect(result.accountId).toBe('12345');
    expect(result.existingField).toBe('keep-me');
  });

  it('omits teamId when null', () => {
    const result = buildConfig(
      {},
      { accountId: '1', licenseKey: 'k', developer: 'd', teamId: null, projectId: null, sessionBudgetUsd: null },
    );
    expect(Object.keys(result)).not.toContain('teamId');
  });

  it('includes teamId when provided', () => {
    const result = buildConfig(
      {},
      { accountId: '1', licenseKey: 'k', developer: 'd', teamId: 'eng', projectId: null, sessionBudgetUsd: null },
    );
    expect(result.teamId).toBe('eng');
  });

  it('omits projectId when null', () => {
    const result = buildConfig(
      {},
      { accountId: '1', licenseKey: 'k', developer: 'd', teamId: null, projectId: null, sessionBudgetUsd: null },
    );
    expect(Object.keys(result)).not.toContain('projectId');
  });

  it('includes projectId when provided', () => {
    const result = buildConfig(
      {},
      { accountId: '1', licenseKey: 'k', developer: 'd', teamId: null, projectId: 'org/repo', sessionBudgetUsd: null },
    );
    expect(result.projectId).toBe('org/repo');
  });

  it('omits sessionBudgetUsd when null', () => {
    const result = buildConfig(
      {},
      { accountId: '1', licenseKey: 'k', developer: 'd', teamId: null, projectId: null, sessionBudgetUsd: null },
    );
    expect(Object.keys(result)).not.toContain('sessionBudgetUsd');
  });

  it('includes sessionBudgetUsd when provided', () => {
    const result = buildConfig(
      {},
      { accountId: '1', licenseKey: 'k', developer: 'd', teamId: null, projectId: null, sessionBudgetUsd: 5.0 },
    );
    expect(result.sessionBudgetUsd).toBe(5.0);
  });

  it('overwrites existing accountId with new value', () => {
    const result = buildConfig(
      { accountId: 'old', licenseKey: 'old-key' },
      { accountId: 'new', licenseKey: 'new-key', developer: 'd', teamId: null, projectId: null, sessionBudgetUsd: null },
    );
    expect(result.accountId).toBe('new');
    expect(result.licenseKey).toBe('new-key');
  });
});

// ---------------------------------------------------------------------------
// F-138: setup-wizard idempotency and env-detection tests
// ---------------------------------------------------------------------------
describe('F-138: setup-wizard idempotency and env-detection', () => {
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;
  let mockRl: { question: jest.Mock; close: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mockRl = { question: jest.fn(), close: jest.fn() };
    mockedRl.createInterface.mockReturnValue(mockRl);
    mockedFs.mkdirSync.mockReturnValue(undefined);
    mockedFs.writeFileSync.mockReturnValue(undefined);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  // Wires readline to answer prompts in sequence; defaults to '' (accept wizard default).
  // Wizard asks 8 questions: mode, accountId, licenseKey, developer, teamId, projectId,
  // sessionBudget, installHooks.
  function sequenceAnswers(...answers: (string | undefined)[]): void {
    let i = 0;
    mockRl.question.mockImplementation(async () => answers[i++] ?? '');
  }

  it('re-run with existing config preserves unrelated custom fields', async () => {
    const existingConfig = {
      accountId: '12345',
      licenseKey: 'NRLIC-existing',
      developer: 'alice',
      otlpEndpoint: 'https://otlp.example.com',  // not managed by wizard
      retainSessionsDays: 90,                      // not managed by wizard
    };
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(existingConfig));
    sequenceAnswers('', '', '', '', '', '', '', 'n');

    await runSetupWizard();

    expect(mockedFs.writeFileSync).toHaveBeenCalledTimes(1);
    const writtenJson = mockedFs.writeFileSync.mock.calls[0][1] as string;
    const written = JSON.parse(writtenJson) as Record<string, unknown>;
    expect(written.otlpEndpoint).toBe('https://otlp.example.com');
    expect(written.retainSessionsDays).toBe(90);
    expect(written.accountId).toBe('12345');
  });

  it('$USER env var auto-populates the developer name when existing config lacks one', async () => {
    const savedUser = process.env.USER;
    process.env.USER = 'Jane Doe';
    try {
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({ accountId: '99999', licenseKey: 'NRLIC-test' }),
      );
      sequenceAnswers('', '', '', '', '', '', '', 'n');

      await runSetupWizard();

      const writtenJson = mockedFs.writeFileSync.mock.calls[0][1] as string;
      const written = JSON.parse(writtenJson) as Record<string, unknown>;
      // normalizeDeveloperName('Jane Doe') → 'jane_doe'
      expect(written.developer).toBe('jane_doe');
    } finally {
      if (savedUser === undefined) delete process.env.USER;
      else process.env.USER = savedUser;
    }
  });

  it('cancellation (readline rejection) before writeFileSync leaves config untouched', async () => {
    mockedFs.readFileSync.mockReturnValue('{}');
    mockRl.question.mockImplementation(() => Promise.reject(new Error('readline closed')));

    await expect(runSetupWizard()).rejects.toThrow('readline closed');

    expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
  });

  it('malformed JSON in existing config does not crash the wizard', async () => {
    mockedFs.readFileSync.mockReturnValue('not-valid-json{{{');
    sequenceAnswers('', '12345', 'NRLIC-test', 'testdev', '', '', '', 'n');

    await runSetupWizard();

    expect(mockedFs.writeFileSync).toHaveBeenCalledTimes(1);
    const writtenJson = mockedFs.writeFileSync.mock.calls[0][1] as string;
    const written = JSON.parse(writtenJson) as Record<string, unknown>;
    expect(written.accountId).toBe('12345');
    expect(written.licenseKey).toBe('NRLIC-test');
  });
});

// ---------------------------------------------------------------------------
// Mode branch: cloud / local / both
// ---------------------------------------------------------------------------
describe('setupWizard mode branch', () => {
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;
  let mockRl: { question: jest.Mock; close: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mockRl = { question: jest.fn(), close: jest.fn() };
    mockedRl.createInterface.mockReturnValue(mockRl);
    mockedFs.mkdirSync.mockReturnValue(undefined);
    mockedFs.writeFileSync.mockReturnValue(undefined);
    mockedFs.readFileSync.mockReturnValue('{}');
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  function answers(...values: string[]): void {
    let i = 0;
    mockRl.question.mockImplementation(async () => values[i++] ?? '');
  }

  it("when mode='local' is chosen, does NOT prompt for licenseKey or accountId", async () => {
    // Order: mode, [skipped: accountId, licenseKey], developer, teamId, projectId,
    // sessionBudget, dashboardPort, copyStarterRules, installHooks
    answers('local', 'tester', '', '', '', '', 'n', 'n');

    await runSetupWizard();

    const promptMessages = mockRl.question.mock.calls.map((c) => String(c[0]).toLowerCase());
    expect(promptMessages.some((m) => m.includes('license'))).toBe(false);
    expect(promptMessages.some((m) => m.includes('account id'))).toBe(false);

    const writtenJson = mockedFs.writeFileSync.mock.calls[0][1] as string;
    const written = JSON.parse(writtenJson) as Record<string, unknown>;
    expect(written.mode).toBe('local');
    expect(written.licenseKey).toBeUndefined();
    expect(written.accountId).toBeUndefined();
  });

  it("when mode='local', persists dashboard config with chosen port", async () => {
    answers('local', 'tester', '', '', '', '8080', 'n', 'n');

    await runSetupWizard();

    const writtenJson = mockedFs.writeFileSync.mock.calls[0][1] as string;
    const written = JSON.parse(writtenJson) as Record<string, unknown>;
    expect(written.mode).toBe('local');
    expect(written.dashboard).toEqual({ port: 8080, host: '127.0.0.1', openOnStart: false });
  });

  it("when mode='both', prompts for credentials AND port", async () => {
    answers('both', '12345', 'NRLIC-test', 'tester', '', '', '', '7777', 'n', 'n');

    await runSetupWizard();

    const writtenJson = mockedFs.writeFileSync.mock.calls[0][1] as string;
    const written = JSON.parse(writtenJson) as Record<string, unknown>;
    expect(written.mode).toBe('both');
    expect(written.accountId).toBe('12345');
    expect(written.licenseKey).toBe('NRLIC-test');
    expect(written.dashboard).toEqual({ port: 7777, host: '127.0.0.1', openOnStart: false });
  });
});

// ---------------------------------------------------------------------------
// I11: Validation rejection paths
// ---------------------------------------------------------------------------
describe('setupWizard input validation', () => {
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;
  let consoleErrorSpy: ReturnType<typeof jest.spyOn>;
  let exitSpy: ReturnType<typeof jest.spyOn>;
  let mockRl: { question: jest.Mock; close: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`process.exit(${String(code)})`);
    });
    mockRl = { question: jest.fn(), close: jest.fn() };
    mockedRl.createInterface.mockReturnValue(mockRl);
    mockedFs.mkdirSync.mockReturnValue(undefined);
    mockedFs.writeFileSync.mockReturnValue(undefined);
    mockedFs.readFileSync.mockReturnValue('{}');
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  function answers(...values: string[]): void {
    let i = 0;
    mockRl.question.mockImplementation(async () => values[i++] ?? '');
  }

  it('rejects an account ID that is not 1–12 digits', async () => {
    // mode (default cloud), accountId, licenseKey, ...
    answers('', 'abc-123', 'NRLIC-test', 'tester', '', '', '', 'n');

    await expect(runSetupWizard()).rejects.toThrow('process.exit(1)');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid account ID'),
    );
    expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
  });

  it('rejects an account ID with more than 12 digits', async () => {
    answers('', '1234567890123', 'NRLIC-test', 'tester', '', '', '', 'n');

    await expect(runSetupWizard()).rejects.toThrow('process.exit(1)');

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid account ID'),
    );
    expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
  });

  it('rejects a missing license key when none is in existing config', async () => {
    answers('', '12345', '', 'tester', '', '', '', 'n');

    await expect(runSetupWizard()).rejects.toThrow('process.exit(1)');

    expect(consoleErrorSpy).toHaveBeenCalledWith('License key is required.');
    expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric session budget', async () => {
    answers('', '12345', 'NRLIC-test', 'tester', '', '', 'free', 'n');

    await expect(runSetupWizard()).rejects.toThrow('process.exit(1)');

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid session budget'),
    );
    expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
  });

  it('rejects a session budget of zero', async () => {
    answers('', '12345', 'NRLIC-test', 'tester', '', '', '0', 'n');

    await expect(runSetupWizard()).rejects.toThrow('process.exit(1)');

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid session budget'),
    );
    expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
  });

  it('rejects a negative session budget', async () => {
    answers('', '12345', 'NRLIC-test', 'tester', '', '', '-5', 'n');

    await expect(runSetupWizard()).rejects.toThrow('process.exit(1)');

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid session budget'),
    );
    expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
  });

  it('rejects a dashboard port of 0 in local mode', async () => {
    // mode=local, [no creds], developer, teamId, projectId, sessionBudget, dashboardPort
    answers('local', 'tester', '', '', '', '0', 'n');

    await expect(runSetupWizard()).rejects.toThrow('process.exit(1)');

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid port'),
    );
    expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
  });

  it('rejects a dashboard port of 65536 in local mode', async () => {
    answers('local', 'tester', '', '', '', '65536', 'n');

    await expect(runSetupWizard()).rejects.toThrow('process.exit(1)');

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid port'),
    );
    expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric dashboard port in both mode', async () => {
    answers('both', '12345', 'NRLIC-test', 'tester', '', '', '', 'eight-thousand', 'n');

    await expect(runSetupWizard()).rejects.toThrow('process.exit(1)');

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid port'),
    );
    expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
  });

  it('falls back to existing license key when prompt is blank', async () => {
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({ accountId: '12345', licenseKey: 'NRLIC-existing' }),
    );
    // accept all defaults — blank licenseKey should fall back to existing
    answers('', '', '', '', '', '', '', 'n');

    await runSetupWizard();

    const writtenJson = mockedFs.writeFileSync.mock.calls[0][1] as string;
    const written = JSON.parse(writtenJson) as Record<string, unknown>;
    expect(written.licenseKey).toBe('NRLIC-existing');
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
