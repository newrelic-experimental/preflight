import * as fsMod from 'node:fs';
import * as rlMod from 'node:readline/promises';
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

import { buildConfig, runSetupWizard, copyStarterAlertRules } from './setup-wizard.js';
import * as scheduleMod from './schedule.js';
import * as keyValidator from './key-validator.js';
import * as cliMod from './cli.js';
import * as platformMod from './platform.js';

// ---------------------------------------------------------------------------
// Module-level mocks (hoisted above imports by jest at runtime).
// The buildConfig tests below are unaffected (pure function; no fs/readline).
// ---------------------------------------------------------------------------
jest.mock('node:readline/promises', () => ({ createInterface: jest.fn() }));
jest.mock('node:fs', () => ({
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  renameSync: jest.fn(),
  mkdirSync: jest.fn(),
  existsSync: jest.fn(),
  copyFileSync: jest.fn(),
  chmodSync: jest.fn(),
  realpathSync: jest.fn((p: unknown) => p),
}));
jest.mock('./cli.js', () => ({
  runInstallCli: jest.fn(),
  verifyBinaryOnPath: jest.fn(),
  findRepoRoot: jest.fn(() => null),
}));
jest.mock('./platform.js', () => ({
  isWsl: jest.fn(() => false),
  resolveWindowsHome: jest.fn(() => null),
}));
jest.mock('./key-validator.js', () => ({
  validateLicenseKey: jest.fn(),
  validateApiKey: jest.fn(),
  getEventsApiUrl: jest.fn(),
  getNerdgraphUrl: jest.fn(),
}));
jest.mock('./schedule.js', () => ({
  installSchedule: jest.fn(),
  removeSchedule: jest.fn(),
  getScheduleStatus: jest.fn(() => ({ installed: false })),
  resolveBinaryPath: jest.fn(() => null),
}));

// Typed handles to the mocked module functions.
const mockedKeyValidator = {
  validateLicenseKey: keyValidator.validateLicenseKey as jest.MockedFunction<
    typeof keyValidator.validateLicenseKey
  >,
  validateApiKey: keyValidator.validateApiKey as jest.MockedFunction<
    typeof keyValidator.validateApiKey
  >,
};
const mockedFs = fsMod as unknown as {
  readFileSync: jest.Mock;
  writeFileSync: jest.Mock;
  mkdirSync: jest.Mock;
  existsSync: jest.Mock;
  copyFileSync: jest.Mock;
  chmodSync: jest.Mock;
};
const mockedRl = rlMod as unknown as { createInterface: jest.Mock };
const mockedSchedule = scheduleMod as unknown as {
  installSchedule: jest.Mock;
  resolveBinaryPath: jest.Mock;
};
const mockedCli = cliMod as unknown as {
  runInstallCli: jest.Mock;
  verifyBinaryOnPath: jest.Mock;
};
const mockedPlatform = platformMod as unknown as {
  isWsl: jest.Mock;
  resolveWindowsHome: jest.Mock;
};

// ---------------------------------------------------------------------------
// copyStarterAlertRules
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

    expect(mockedFs.mkdirSync).toHaveBeenCalledWith('/dest/alerts', {
      recursive: true,
      mode: 0o700,
    });
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

    expect(mockedFs.chmodSync).toHaveBeenCalledWith('/dest/alerts/rules.json', 0o600);
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
      {
        accountId: '12345',
        licenseKey: 'nrlic',
        developer: 'alice',
        teamId: null,
        projectId: null,
        sessionBudgetUsd: null,
      },
    );
    expect(result.accountId).toBe('12345');
    expect(result.existingField).toBe('keep-me');
  });

  it('omits teamId when null', () => {
    const result = buildConfig(
      {},
      {
        accountId: '1',
        licenseKey: 'k',
        developer: 'd',
        teamId: null,
        projectId: null,
        sessionBudgetUsd: null,
      },
    );
    expect(Object.keys(result)).not.toContain('teamId');
  });

  it('includes teamId when provided', () => {
    const result = buildConfig(
      {},
      {
        accountId: '1',
        licenseKey: 'k',
        developer: 'd',
        teamId: 'eng',
        projectId: null,
        sessionBudgetUsd: null,
      },
    );
    expect(result.teamId).toBe('eng');
  });

  it('omits projectId when null', () => {
    const result = buildConfig(
      {},
      {
        accountId: '1',
        licenseKey: 'k',
        developer: 'd',
        teamId: null,
        projectId: null,
        sessionBudgetUsd: null,
      },
    );
    expect(Object.keys(result)).not.toContain('projectId');
  });

  it('includes projectId when provided', () => {
    const result = buildConfig(
      {},
      {
        accountId: '1',
        licenseKey: 'k',
        developer: 'd',
        teamId: null,
        projectId: 'org/repo',
        sessionBudgetUsd: null,
      },
    );
    expect(result.projectId).toBe('org/repo');
  });

  it('omits sessionBudgetUsd when null', () => {
    const result = buildConfig(
      {},
      {
        accountId: '1',
        licenseKey: 'k',
        developer: 'd',
        teamId: null,
        projectId: null,
        sessionBudgetUsd: null,
      },
    );
    expect(Object.keys(result)).not.toContain('sessionBudgetUsd');
  });

  it('includes sessionBudgetUsd when provided', () => {
    const result = buildConfig(
      {},
      {
        accountId: '1',
        licenseKey: 'k',
        developer: 'd',
        teamId: null,
        projectId: null,
        sessionBudgetUsd: 5.0,
      },
    );
    expect(result.sessionBudgetUsd).toBe(5.0);
  });

  it('overwrites existing accountId with new value', () => {
    const result = buildConfig(
      { accountId: 'old', licenseKey: 'old-key' },
      {
        accountId: 'new',
        licenseKey: 'new-key',
        developer: 'd',
        teamId: null,
        projectId: null,
        sessionBudgetUsd: null,
      },
    );
    expect(result.accountId).toBe('new');
    expect(result.licenseKey).toBe('new-key');
  });
});

// ---------------------------------------------------------------------------
// setup-wizard idempotency and env-detection tests
// ---------------------------------------------------------------------------
describe('setup-wizard idempotency and env-detection', () => {
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;
  let mockRl: { question: jest.Mock; close: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockRl = { question: jest.fn(), close: jest.fn() };
    mockedRl.createInterface.mockReturnValue(mockRl);
    mockedFs.mkdirSync.mockReturnValue(undefined);
    mockedFs.writeFileSync.mockReturnValue(undefined);
    mockedKeyValidator.validateLicenseKey.mockResolvedValue({ valid: true });
    mockedKeyValidator.validateApiKey.mockResolvedValue({ valid: true });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  // Wires readline to answer prompts in sequence; defaults to '' (accept wizard default).
  // Cloud/both mode order: mode, accountId, licenseKey, environment, nrApiKey, developer,
  //   teamId, projectId, sessionBudget, installHooks.
  // Local mode order: mode, developer, teamId, projectId, sessionBudget, dashboardPort,
  //   copyStarterRules, installHooks.
  function sequenceAnswers(...answers: (string | undefined)[]): void {
    let i = 0;
    mockRl.question.mockImplementation(async () => answers[i++] ?? '');
  }

  it('re-run with existing config preserves unrelated custom fields', async () => {
    const existingConfig = {
      accountId: '12345',
      licenseKey: 'NRLIC-existing',
      developer: 'alice',
      otlpEndpoint: 'https://otlp.example.com', // not managed by wizard
      retainSessionsDays: 90, // not managed by wizard
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

  // loadExisting() must validate via ConfigFileSchema and strip unknown top-level
  // keys, so wizard's later spread (`...existing`) doesn't perpetuate stale fields.
  // Recognized keys still pass through.
  it('strips unknown top-level keys from existing config', async () => {
    const existingConfig = {
      accountId: '12345',
      licenseKey: 'NRLIC-existing',
      developer: 'alice',
      // Unknown / removed keys — must NOT round-trip through buildConfig:
      legacyDeprecatedField: 'remove-me',
      futureField: { nested: true },
    };
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(existingConfig));
    sequenceAnswers('', '', '', '', '', '', '', 'n');

    await runSetupWizard();

    const writtenJson = mockedFs.writeFileSync.mock.calls[0][1] as string;
    const written = JSON.parse(writtenJson) as Record<string, unknown>;
    expect(Object.keys(written)).not.toContain('legacyDeprecatedField');
    expect(Object.keys(written)).not.toContain('futureField');
    // Recognized keys still survive.
    expect(written.accountId).toBe('12345');
    expect(written.licenseKey).toBe('NRLIC-existing');
  });

  // Validation failure on a recognized key (e.g. malformed type) logs a warning
  // and falls back to defaults rather than carrying bad data forward via the spread.
  it('falls back to defaults when recognized key has invalid value', async () => {
    const stderrWriteSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      // accountId must be a string; passing a number triggers safeParse failure.
      const badConfig = {
        accountId: 12345,
        licenseKey: 'NRLIC-existing',
      };
      mockedFs.readFileSync.mockReturnValue(JSON.stringify(badConfig));
      // mode=cloud, accountId, licenseKey, env, apiKey, developer, team, project, budget, hooks
      sequenceAnswers('cloud', '99999', 'NRLIC-new', '', '', 'newdev', '', '', '', 'n');

      await runSetupWizard();

      // Wizard wrote with the freshly-prompted values, not the bad ones.
      const writtenJson = mockedFs.writeFileSync.mock.calls[0][1] as string;
      const written = JSON.parse(writtenJson) as Record<string, unknown>;
      expect(written.accountId).toBe('99999');
      expect(written.licenseKey).toBe('NRLIC-new');

      // A warning was emitted to stderr.
      const stderrOutput = stderrWriteSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
      expect(stderrOutput).toMatch(/setup-wizard.*invalid values/i);
    } finally {
      stderrWriteSpy.mockRestore();
    }
  });

  it('malformed JSON in existing config does not crash the wizard', async () => {
    mockedFs.readFileSync.mockReturnValue('not-valid-json{{{');
    // Malformed config → no existing mode → defaults 'local'; force 'cloud' explicitly so
    // accountId/licenseKey prompts fire. Final 'n' skips Step 7 auto-update (macOS).
    // Order: mode, accountId, licenseKey, environment, nrApiKey, developer, teamId, projectId,
    //        sessionBudget, installHooks, autoUpdate
    sequenceAnswers('cloud', '12345', 'NRLIC-test', '', '', 'testdev', '', '', '', 'n', 'n');

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
    stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
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
    expect(promptMessages.some((m) => m.includes('license key —'))).toBe(false);
    // Check that the Account ID *field prompt* (starts with "account id —") did not appear.
    // The team label prompt contains "not your nr account id" but does not start with "account id".
    expect(promptMessages.some((m) => m.startsWith('account id —'))).toBe(false);

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
    answers('both', '12345', 'NRLIC-test', '', '', 'tester', '', '', '', '7777', 'n', 'n');

    await runSetupWizard();

    const writtenJson = mockedFs.writeFileSync.mock.calls[0][1] as string;
    const written = JSON.parse(writtenJson) as Record<string, unknown>;
    expect(written.mode).toBe('both');
    expect(written.accountId).toBe('12345');
    expect(written.licenseKey).toBe('NRLIC-test');
    expect(written.dashboard).toEqual({ port: 7777, host: '127.0.0.1', openOnStart: false });
  });

  // In cloud mode the wizard must not copy the starter alert rules — the alert
  // engine isn't constructed, so the on-disk rules file would be ignored and
  // would just clutter the user's home dir.
  it("when mode='cloud', does NOT copy starter alert rules", async () => {
    // Cloud mode skips the dashboardPort and copyStarterRules prompts,
    // so the answer sequence is shorter than the local/both flows.
    // Order: mode, accountId, licenseKey, environment, nrApiKey, developer, teamId, projectId,
    //        sessionBudget, installHooks
    answers('cloud', '12345', 'NRLIC-test', '', '', 'tester', '', '', '', 'n');

    await runSetupWizard();

    const writtenJson = mockedFs.writeFileSync.mock.calls[0][1] as string;
    const written = JSON.parse(writtenJson) as Record<string, unknown>;
    expect(written.mode).toBe('cloud');
    // The starter rules copy must not have run.
    expect(mockedFs.copyFileSync).not.toHaveBeenCalled();
    // And the user must not have been prompted about it.
    const promptMessages = mockRl.question.mock.calls.map((c) => String(c[0]).toLowerCase());
    expect(promptMessages.some((m) => m.includes('starter alert rules'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Validation rejection paths
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
    stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
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
    // Explicit 'cloud' mode so accountId/licenseKey prompts fire (default mode is 'local').
    answers('cloud', 'abc-123', 'NRLIC-test', 'tester', '', '', '', 'n');

    await expect(runSetupWizard()).rejects.toThrow('process.exit(1)');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid account ID'));
    expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
  });

  it('rejects an account ID with more than 12 digits', async () => {
    answers('cloud', '1234567890123', 'NRLIC-test', 'tester', '', '', '', 'n');

    await expect(runSetupWizard()).rejects.toThrow('process.exit(1)');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid account ID'));
    expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
  });

  it('rejects a missing license key when none is in existing config', async () => {
    answers('cloud', '12345', '', 'tester', '', '', '', 'n');

    await expect(runSetupWizard()).rejects.toThrow('process.exit(1)');

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'License key is required. Set NEW_RELIC_LICENSE_KEY or enter a value above.',
    );
    expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric session budget', async () => {
    answers('cloud', '12345', 'NRLIC-test', '', '', 'tester', '', '', 'free', 'n');

    await expect(runSetupWizard()).rejects.toThrow('process.exit(1)');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid session budget'));
    expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
  });

  it('rejects a session budget of zero', async () => {
    answers('cloud', '12345', 'NRLIC-test', '', '', 'tester', '', '', '0', 'n');

    await expect(runSetupWizard()).rejects.toThrow('process.exit(1)');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid session budget'));
    expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
  });

  it('rejects a negative session budget', async () => {
    answers('cloud', '12345', 'NRLIC-test', '', '', 'tester', '', '', '-5', 'n');

    await expect(runSetupWizard()).rejects.toThrow('process.exit(1)');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid session budget'));
    expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
  });

  it('rejects a dashboard port of 0 in local mode', async () => {
    // mode=local, [no creds], developer, teamId, projectId, sessionBudget, dashboardPort
    answers('local', 'tester', '', '', '', '0', 'n');

    await expect(runSetupWizard()).rejects.toThrow('process.exit(1)');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid port'));
    expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
  });

  it('rejects a dashboard port of 65536 in local mode', async () => {
    answers('local', 'tester', '', '', '', '65536', 'n');

    await expect(runSetupWizard()).rejects.toThrow('process.exit(1)');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid port'));
    expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric dashboard port in both mode', async () => {
    answers('both', '12345', 'NRLIC-test', '', '', 'tester', '', '', '', 'eight-thousand', 'n');

    await expect(runSetupWizard()).rejects.toThrow('process.exit(1)');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid port'));
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

  it('uses NEW_RELIC_LICENSE_KEY env var when prompt is blank and no file config', async () => {
    const origKey = process.env.NEW_RELIC_LICENSE_KEY;
    process.env.NEW_RELIC_LICENSE_KEY = 'NRLIC-from-env';
    try {
      // cloud, accountId, blank licenseKey (→ env var), env, blank apiKey, developer, ...
      answers('cloud', '12345', '', '', '', 'tester', '', '', '', 'n');
      await runSetupWizard();
      const written = JSON.parse(mockedFs.writeFileSync.mock.calls[0][1] as string) as Record<
        string,
        unknown
      >;
      expect(written.licenseKey).toBe('NRLIC-from-env');
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      if (origKey === undefined) delete process.env.NEW_RELIC_LICENSE_KEY;
      else process.env.NEW_RELIC_LICENSE_KEY = origKey;
    }
  });

  it('uses NEW_RELIC_ACCOUNT_ID env var when prompt is blank and no file config', async () => {
    const origId = process.env.NEW_RELIC_ACCOUNT_ID;
    process.env.NEW_RELIC_ACCOUNT_ID = '99999';
    try {
      // cloud, blank accountId (→ env var), licenseKey, env, apiKey, developer, ...
      answers('cloud', '', 'NRLIC-test', '', '', 'tester', '', '', '', 'n');
      await runSetupWizard();
      const written = JSON.parse(mockedFs.writeFileSync.mock.calls[0][1] as string) as Record<
        string,
        unknown
      >;
      expect(written.accountId).toBe('99999');
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      if (origId === undefined) delete process.env.NEW_RELIC_ACCOUNT_ID;
      else process.env.NEW_RELIC_ACCOUNT_ID = origId;
    }
  });

  it('uses NEW_RELIC_API_KEY env var when prompt is blank and no file config', async () => {
    const origApiKey = process.env.NEW_RELIC_API_KEY;
    process.env.NEW_RELIC_API_KEY = 'NRAK-from-env';
    try {
      // cloud, accountId, licenseKey, env, blank apiKey (→ env var), developer, ...
      answers('cloud', '12345', 'NRLIC-test', '', '', 'tester', '', '', '', 'n');
      await runSetupWizard();
      const written = JSON.parse(mockedFs.writeFileSync.mock.calls[0][1] as string) as Record<
        string,
        unknown
      >;
      expect(written.nrApiKey).toBe('NRAK-from-env');
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      if (origApiKey === undefined) delete process.env.NEW_RELIC_API_KEY;
      else process.env.NEW_RELIC_API_KEY = origApiKey;
    }
  });

  it('file config license key takes precedence over NEW_RELIC_LICENSE_KEY env var', async () => {
    const origKey = process.env.NEW_RELIC_LICENSE_KEY;
    process.env.NEW_RELIC_LICENSE_KEY = 'NRLIC-from-env';
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({ accountId: '12345', licenseKey: 'NRLIC-from-file' }),
    );
    try {
      answers('', '', '', '', '', '', '', 'n');
      await runSetupWizard();
      const written = JSON.parse(mockedFs.writeFileSync.mock.calls[0][1] as string) as Record<
        string,
        unknown
      >;
      expect(written.licenseKey).toBe('NRLIC-from-file');
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      if (origKey === undefined) delete process.env.NEW_RELIC_LICENSE_KEY;
      else process.env.NEW_RELIC_LICENSE_KEY = origKey;
    }
  });
});

// ---------------------------------------------------------------------------
// Auto-update wizard step
// ---------------------------------------------------------------------------
describe('setupWizard auto-update step', () => {
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;
  let mockRl: { question: jest.Mock; close: jest.Mock };
  const savedPlatform = process.platform;

  beforeEach(() => {
    jest.clearAllMocks();
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockRl = { question: jest.fn(), close: jest.fn() };
    mockedRl.createInterface.mockReturnValue(mockRl);
    mockedFs.mkdirSync.mockReturnValue(undefined);
    mockedFs.writeFileSync.mockReturnValue(undefined);
    mockedFs.readFileSync.mockReturnValue('{}');
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    Object.defineProperty(process, 'platform', { value: savedPlatform, configurable: true });
  });

  // Cloud mode answer order:
  // mode, accountId, licenseKey, environment, nrApiKey, developer, teamId, projectId,
  // sessionBudget, installHooks, autoUpdate, updateTime
  function cloudAnswers(...values: string[]): void {
    let i = 0;
    mockRl.question.mockImplementation(async () => values[i++] ?? '');
  }

  it('calls installSchedule with parsed hour and minute when user accepts', async () => {
    mockedSchedule.resolveBinaryPath.mockReturnValue('/usr/local/bin/preflight');
    cloudAnswers('cloud', '12345', 'NRLIC-test', '', '', 'dev', '', '', '', 'n', 'y', '09:00');

    await runSetupWizard();

    expect(mockedSchedule.installSchedule).toHaveBeenCalledWith('/usr/local/bin/preflight', 9, 0);
  });

  it('uses 08:00 as default time when user presses enter', async () => {
    mockedSchedule.resolveBinaryPath.mockReturnValue('/usr/local/bin/preflight');
    cloudAnswers('cloud', '12345', 'NRLIC-test', '', '', 'dev', '', '', '', 'n', 'y', '');

    await runSetupWizard();

    expect(mockedSchedule.installSchedule).toHaveBeenCalledWith('/usr/local/bin/preflight', 8, 0);
  });

  it('does not call installSchedule when user declines auto-update', async () => {
    cloudAnswers('cloud', '12345', 'NRLIC-test', '', '', 'dev', '', '', '', 'n', 'n');

    await runSetupWizard();

    expect(mockedSchedule.installSchedule).not.toHaveBeenCalled();
  });

  it('prints PATH warning and skips installSchedule when binary not on PATH', async () => {
    mockedSchedule.resolveBinaryPath.mockReturnValue(null);
    cloudAnswers('cloud', '12345', 'NRLIC-test', '', '', 'dev', '', '', '', 'n', 'y', '08:00');

    await runSetupWizard();

    expect(mockedSchedule.installSchedule).not.toHaveBeenCalled();
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('PATH');
  });

  it('skips auto-update step entirely on non-macOS', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    // No auto-update answers needed — step is skipped on non-macOS.
    cloudAnswers('cloud', '12345', 'NRLIC-test', '', '', 'dev', '', '', '', 'n');

    await runSetupWizard();

    expect(mockedSchedule.installSchedule).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// buildConfig — nrApiKey and collectorHost fields
// ---------------------------------------------------------------------------
describe('buildConfig nrApiKey and collectorHost', () => {
  const base = {
    accountId: '1',
    licenseKey: 'k',
    developer: 'd',
    teamId: null,
    projectId: null,
    sessionBudgetUsd: null,
  };

  it('omits nrApiKey when null', () => {
    const result = buildConfig({}, { ...base, nrApiKey: null });
    expect(Object.keys(result)).not.toContain('nrApiKey');
  });

  it('includes nrApiKey when provided', () => {
    const result = buildConfig({}, { ...base, nrApiKey: 'NRAK-abc' });
    expect(result.nrApiKey).toBe('NRAK-abc');
  });

  it('omits collectorHost when null (US default)', () => {
    const result = buildConfig({}, { ...base, collectorHost: null });
    expect(Object.keys(result)).not.toContain('collectorHost');
  });

  it('writes collectorHost eu when provided', () => {
    const result = buildConfig({}, { ...base, collectorHost: 'eu' });
    expect(result.collectorHost).toBe('eu');
  });
});

// ---------------------------------------------------------------------------
// Environment and NR API key wizard steps
// ---------------------------------------------------------------------------
describe('setupWizard environment and nrApiKey steps', () => {
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;
  let mockRl: { question: jest.Mock; close: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockRl = { question: jest.fn(), close: jest.fn() };
    mockedRl.createInterface.mockReturnValue(mockRl);
    mockedFs.mkdirSync.mockReturnValue(undefined);
    mockedFs.writeFileSync.mockReturnValue(undefined);
    mockedFs.readFileSync.mockReturnValue('{}');
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    // Prevent the test runner's real NEW_RELIC_API_KEY from bleeding in as a default
    delete process.env.NEW_RELIC_API_KEY;
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.NEW_RELIC_API_KEY;
  });

  function answers(...values: string[]): void {
    let i = 0;
    mockRl.question.mockImplementation(async () => values[i++] ?? '');
  }

  it('writes collectorHost eu when EU environment selected', async () => {
    // Order: mode, accountId, licenseKey, environment=eu, nrApiKey, developer,
    //        teamId, projectId, sessionBudget, installHooks
    answers('cloud', '12345', 'NRLIC-test', 'eu', '', 'tester', '', '', '', 'n');

    await runSetupWizard();

    const writtenJson = mockedFs.writeFileSync.mock.calls[0][1] as string;
    const written = JSON.parse(writtenJson) as Record<string, unknown>;
    expect(written.collectorHost).toBe('eu');
  });

  it('omits collectorHost when US environment selected', async () => {
    answers('cloud', '12345', 'NRLIC-test', 'us', '', 'tester', '', '', '', 'n');

    await runSetupWizard();

    const writtenJson = mockedFs.writeFileSync.mock.calls[0][1] as string;
    const written = JSON.parse(writtenJson) as Record<string, unknown>;
    expect(Object.keys(written)).not.toContain('collectorHost');
  });

  it('defaults to US when license key has no region prefix', async () => {
    // Blank environment answer → accepts auto-detected default (US for keys without known prefix)
    answers('cloud', '12345', 'NRLIC-test', '', '', 'tester', '', '', '', 'n');

    await runSetupWizard();

    const writtenJson = mockedFs.writeFileSync.mock.calls[0][1] as string;
    const written = JSON.parse(writtenJson) as Record<string, unknown>;
    expect(Object.keys(written)).not.toContain('collectorHost');
  });

  it('defaults to gov when license key starts with gov01', async () => {
    answers('cloud', '12345', 'gov01xx-license', '', '', 'tester', '', '', '', 'n');

    await runSetupWizard();

    const writtenJson = mockedFs.writeFileSync.mock.calls[0][1] as string;
    const written = JSON.parse(writtenJson) as Record<string, unknown>;
    expect(written.collectorHost).toBe('gov');
  });

  it('defaults to EU when license key starts with eu01', async () => {
    // Blank environment answer → accepts auto-detected default (EU from eu01 key prefix)
    answers('cloud', '12345', 'eu01xx-license', '', '', 'tester', '', '', '', 'n');

    await runSetupWizard();

    const writtenJson = mockedFs.writeFileSync.mock.calls[0][1] as string;
    const written = JSON.parse(writtenJson) as Record<string, unknown>;
    expect(written.collectorHost).toBe('eu');
  });

  it('writes collectorHost gov when FedRAMP selected', async () => {
    answers('cloud', '12345', 'NRLIC-test', 'gov', '', 'tester', '', '', '', 'n');

    await runSetupWizard();

    const writtenJson = mockedFs.writeFileSync.mock.calls[0][1] as string;
    const written = JSON.parse(writtenJson) as Record<string, unknown>;
    expect(written.collectorHost).toBe('gov');
  });

  it('includes --eu in deploy commands when EU is selected', async () => {
    answers('cloud', '12345', 'NRLIC-test', 'eu', '', 'tester', '', '', '', 'n');

    await runSetupWizard();

    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('--eu');
  });

  it('does not include --eu in deploy commands when US is selected', async () => {
    answers('cloud', '12345', 'NRLIC-test', 'us', '', 'tester', '', '', '', 'n');

    await runSetupWizard();

    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).not.toContain('--eu');
  });

  it('falls back to default env on unrecognized input', async () => {
    // Typo or garbage input should fall back to the default env
    answers('cloud', '12345', 'NRLIC-test', 'nope', '', 'tester', '', '', '', 'n');

    await runSetupWizard();

    const writtenJson = mockedFs.writeFileSync.mock.calls[0][1] as string;
    const written = JSON.parse(writtenJson) as Record<string, unknown>;
    // Default for a non-prefixed key is 'us', so collectorHost should be absent (null → omitted)
    expect(Object.keys(written)).not.toContain('collectorHost');
  });

  it('writes nrApiKey when provided', async () => {
    answers('cloud', '12345', 'NRLIC-test', '', 'NRAK-abc123', 'tester', '', '', '', 'n');

    await runSetupWizard();

    const writtenJson = mockedFs.writeFileSync.mock.calls[0][1] as string;
    const written = JSON.parse(writtenJson) as Record<string, unknown>;
    expect(written.nrApiKey).toBe('NRAK-abc123');
  });

  it('omits nrApiKey when blank and no existing value', async () => {
    answers('cloud', '12345', 'NRLIC-test', '', '', 'tester', '', '', '', 'n');

    await runSetupWizard();

    const writtenJson = mockedFs.writeFileSync.mock.calls[0][1] as string;
    const written = JSON.parse(writtenJson) as Record<string, unknown>;
    expect(Object.keys(written)).not.toContain('nrApiKey');
  });

  it('preserves existing nrApiKey when prompt is blank', async () => {
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({ accountId: '12345', licenseKey: 'NRLIC-existing', nrApiKey: 'NRAK-kept' }),
    );
    // Existing config has no mode → defaults to local, but force cloud here by providing
    // explicit mode answer so credential prompts fire. Blank nrApiKey → keep existing.
    answers('cloud', '', '', 'us', '', '', '', '', '', 'n');

    await runSetupWizard();

    const writtenJson = mockedFs.writeFileSync.mock.calls[0][1] as string;
    const written = JSON.parse(writtenJson) as Record<string, unknown>;
    expect(written.nrApiKey).toBe('NRAK-kept');
  });

  it('warns when eu01 license key is used with a non-EU environment', async () => {
    answers('cloud', '12345', 'eu01xx-license', 'us', '', 'tester', '', '', '', 'n');

    await runSetupWizard();

    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('EU key');
    expect(output).toContain('US');
  });

  it('warns when us01 license key is used with EU environment', async () => {
    answers('cloud', '12345', 'us01xx-license', 'eu', '', 'tester', '', '', '', 'n');

    await runSetupWizard();

    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('US key');
    expect(output).toContain('EU');
  });

  it('does not warn when license key prefix matches selected environment', async () => {
    answers('cloud', '12345', 'eu01xx-license', 'eu', '', 'tester', '', '', '', 'n');

    await runSetupWizard();

    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).not.toContain('⚠');
  });

  it('does not warn for legacy keys with no region prefix', async () => {
    answers('cloud', '12345', 'NRLIC-legacykey', 'us', '', 'tester', '', '', '', 'n');

    await runSetupWizard();

    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).not.toContain('⚠');
  });

  it('does not prompt for environment or nrApiKey in local mode', async () => {
    answers('local', 'tester', '', '', '', '', 'n', 'n');

    await runSetupWizard();

    const promptMessages = mockRl.question.mock.calls.map((c) => String(c[0]).toLowerCase());
    expect(promptMessages.some((m) => m.includes('environment'))).toBe(false);
    expect(promptMessages.some((m) => m.includes('api key'))).toBe(false);
  });

  it('prints ✓ when license key and API key are both valid', async () => {
    mockedKeyValidator.validateLicenseKey.mockResolvedValue({ valid: true });
    mockedKeyValidator.validateApiKey.mockResolvedValue({ valid: true, detail: 'dev@example.com' });
    answers('cloud', '12345', 'NRLIC-test', '', 'NRAK-abc', 'tester', '', '', '', 'n');

    await runSetupWizard();

    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('✓ License key: OK');
    expect(output).toContain('✓ API key: OK (dev@example.com)');
  });

  it('prints ✗ when license key is unauthorized', async () => {
    mockedKeyValidator.validateLicenseKey.mockResolvedValue({
      valid: false,
      reason: 'unauthorized',
    });
    answers('cloud', '12345', 'NRLIC-test', '', '', 'tester', '', '', '', 'n');

    await runSetupWizard();

    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('✗ License key: unauthorized');
  });

  it('prints ✗ when API key is unauthorized', async () => {
    mockedKeyValidator.validateApiKey.mockResolvedValue({ valid: false, reason: 'unauthorized' });
    answers('cloud', '12345', 'NRLIC-test', '', 'NRAK-bad', 'tester', '', '', '', 'n');

    await runSetupWizard();

    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('✗ API key: unauthorized');
  });

  it('prints ⚠ when license key check times out', async () => {
    mockedKeyValidator.validateLicenseKey.mockResolvedValue({
      valid: false,
      reason: 'timeout',
      detail: 'no response within 5000ms',
    });
    answers('cloud', '12345', 'NRLIC-test', '', '', 'tester', '', '', '', 'n');

    await runSetupWizard();

    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('⚠ License key: could not reach NR ingest API');
  });

  it('skips API key validation when no API key is set', async () => {
    answers('cloud', '12345', 'NRLIC-test', '', '', 'tester', '', '', '', 'n');

    await runSetupWizard();

    expect(mockedKeyValidator.validateApiKey).not.toHaveBeenCalled();
  });

  it('does not validate in local mode', async () => {
    answers('local', 'tester', '', '', '', '', 'n', 'n');

    await runSetupWizard();

    expect(mockedKeyValidator.validateLicenseKey).not.toHaveBeenCalled();
    expect(mockedKeyValidator.validateApiKey).not.toHaveBeenCalled();
  });

  it('uses email local-part from API key validation as default developer name', async () => {
    mockedKeyValidator.validateApiKey.mockResolvedValue({
      valid: true,
      detail: 'jane.smith@example.com',
    });
    // Developer name answer is blank → should fall back to email local-part
    answers('cloud', '12345', 'NRLIC-test', '', 'NRAK-abc', '', '', '', '', 'n');

    await runSetupWizard();

    const writtenJson = mockedFs.writeFileSync.mock.calls[0][1] as string;
    const written = JSON.parse(writtenJson) as Record<string, unknown>;
    expect(written.developer).toBe('jane_smith');
  });

  it('prefers existing developer name over email local-part', async () => {
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({ accountId: '12345', licenseKey: 'NRLIC-existing', developer: 'the_dev' }),
    );
    mockedKeyValidator.validateApiKey.mockResolvedValue({
      valid: true,
      detail: 'other@example.com',
    });
    answers('cloud', '', '', 'us', 'NRAK-abc', '', '', '', '', 'n');

    await runSetupWizard();

    const writtenJson = mockedFs.writeFileSync.mock.calls[0][1] as string;
    const written = JSON.parse(writtenJson) as Record<string, unknown>;
    expect(written.developer).toBe('the_dev');
  });

  it('shows license key hint in bracket format when already set', async () => {
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({ accountId: '12345', licenseKey: 'NRLIC-existing' }),
    );
    answers('cloud', '', '', 'us', '', 'tester', '', '', '', 'n');

    await runSetupWizard();

    const promptMessages = mockRl.question.mock.calls.map((c) => String(c[0]));
    const licensePrompt = promptMessages.find((m) => m.toLowerCase().includes('license key'));
    expect(licensePrompt).toContain('(already set)');
    expect(licensePrompt).toMatch(/\[.*\]/); // brackets
  });
});

// ---------------------------------------------------------------------------
// WSL CC-mode selection in the hook install step
// ---------------------------------------------------------------------------
describe('setupWizard WSL CC-mode selection', () => {
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;
  let mockRl: { question: jest.Mock; close: jest.Mock };
  const savedPlatform = process.platform;

  beforeEach(() => {
    jest.clearAllMocks();
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockRl = { question: jest.fn(), close: jest.fn() };
    mockedRl.createInterface.mockReturnValue(mockRl);
    mockedFs.mkdirSync.mockReturnValue(undefined);
    mockedFs.writeFileSync.mockReturnValue(undefined);
    mockedFs.readFileSync.mockReturnValue('{}');
    mockedKeyValidator.validateLicenseKey.mockResolvedValue({ valid: true });
    mockedKeyValidator.validateApiKey.mockResolvedValue({ valid: true });
    // Linux platform avoids the macOS-only daemon and schedule prompts.
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    mockedPlatform.isWsl.mockReturnValue(true);
    // Default: Windows home is resolvable (needed for wslChoice='1' tests).
    mockedPlatform.resolveWindowsHome.mockReturnValue('/mnt/c/Users/testuser');
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    Object.defineProperty(process, 'platform', { value: savedPlatform, configurable: true });
    mockedPlatform.isWsl.mockReturnValue(false);
    mockedPlatform.resolveWindowsHome.mockReturnValue(null);
  });

  // Answer order for cloud mode + WSL + installHooks='y':
  // mode, accountId, licenseKey, environment, nrApiKey, developer, teamId, projectId,
  // sessionBudget, installHooks='y', wslChoice
  function answers(...values: string[]): void {
    let i = 0;
    mockRl.question.mockImplementation(async () => values[i++] ?? '');
  }

  it("calls runInstallCli with ['install', '--windows-cc'] when wslChoice is '1'", async () => {
    answers('cloud', '12345', 'NRLIC-test', '', '', 'tester', '', '', '', 'y', '1');

    await runSetupWizard();

    expect(mockedCli.runInstallCli).toHaveBeenCalledWith(['install', '--windows-cc']);
  });

  it("calls runInstallCli with ['install', '--linux-cc'] when wslChoice is '2'", async () => {
    answers('cloud', '12345', 'NRLIC-test', '', '', 'tester', '', '', '', 'y', '2');

    await runSetupWizard();

    expect(mockedCli.runInstallCli).toHaveBeenCalledWith(['install', '--linux-cc']);
  });

  it("calls runInstallCli with ['install', '--linux-cc'] when wslChoice is empty (press Enter)", async () => {
    answers('cloud', '12345', 'NRLIC-test', '', '', 'tester', '', '', '', 'y', '');

    await runSetupWizard();

    expect(mockedCli.runInstallCli).toHaveBeenCalledWith(['install', '--linux-cc']);
  });

  it('skips hook install (does not fall back to --linux-cc) when wslChoice is 1 but Windows home cannot be resolved', async () => {
    mockedPlatform.resolveWindowsHome.mockReturnValue(null);
    answers('cloud', '12345', 'NRLIC-test', '', '', 'tester', '', '', '', 'y', '1');

    await runSetupWizard();

    // Must NOT install with --linux-cc — that would silently write wsl-linux-cc as the
    // saved platform, corrupting Windows CC intent on all future bare installs.
    expect(mockedCli.runInstallCli).not.toHaveBeenCalled();
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('Windows home directory could not be resolved');
    expect(output).toContain('preflight install --windows-cc');
  });

  it("defaults to --linux-cc and prints '3 attempts' message after 3 consecutive invalid inputs", async () => {
    answers('cloud', '12345', 'NRLIC-test', '', '', 'tester', '', '', '', 'y', 'x', 'x', 'x');

    await runSetupWizard();

    expect(mockedCli.runInstallCli).toHaveBeenCalledWith(['install', '--linux-cc']);
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('No valid choice entered after 3 attempts');
  });
});
