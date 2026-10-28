import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { __resetLogLevelCache } from './shared/logger.js';
import { digestWebhookUrlOverride, loadMcpConfig } from './config.js';
import { resolveSecretCommand, SecretCommandError } from './secret-command.js';
import { detectCloudForwardingGap } from './transport/unforwarded-session-monitor.js';

const SECRET = 'test-user-api-key-0001';
const WEBHOOK = 'https://hooks.slack.com/services/T000/B000/abcdefSECRET';

const SECRET_ENV_VARS = [
  'NEW_RELIC_LICENSE_KEY',
  'NEW_RELIC_ACCOUNT_ID',
  'NEW_RELIC_API_KEY',
  'NEW_RELIC_AI_DIGEST_WEBHOOK_URL',
  'NR_AI_MODE',
] as const;

let tmpDir: string;
let savedEnv: NodeJS.ProcessEnv;
let logged: string[];

beforeEach(() => {
  savedEnv = { ...process.env };
  for (const name of SECRET_ENV_VARS) delete process.env[name];
  process.env.NEW_RELIC_AI_LOG_LEVEL = 'debug';
  __resetLogLevelCache();
  tmpDir = mkdtempSync(resolve(tmpdir(), 'nr-secret-cmd-'));
  logged = [];
  jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  });
  jest.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    logged.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  process.env = savedEnv;
  __resetLogLevelCache();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A node script in tmpDir, as an absolute-path argv. */
function script(name: string, source: string, ...args: string[]): string[] {
  const path = resolve(tmpDir, `${name}.mjs`);
  writeFileSync(path, source);
  return [process.execPath, path, ...args];
}

const printArg = (value: string): string[] =>
  script('print', 'process.stdout.write(process.argv[2] + "\\n");', value);

/** Prints a marker file when run, so a test can prove the command did not run. */
function trackedPrint(value: string): { argv: string[]; ranMarker: string } {
  const ranMarker = resolve(tmpDir, 'ran');
  const argv = script(
    'tracked',
    `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(ranMarker)}, '');
process.stdout.write(${JSON.stringify(value)} + '\\n');`,
  );
  return { argv, ranMarker };
}

function writeConfig(data: Record<string, unknown>): string {
  const path = resolve(tmpDir, 'config.json');
  writeFileSync(path, JSON.stringify(data));
  return path;
}

function failureOf(fn: () => unknown): SecretCommandError {
  try {
    fn();
  } catch (err) {
    if (err instanceof SecretCommandError) return err;
    throw err;
  }
  throw new Error('expected a SecretCommandError');
}

describe('resolveSecretCommand()', () => {
  it('returns stdout with exactly one trailing newline removed', () => {
    const argv = script('two-newlines', 'process.stdout.write("a b\\n\\n");');
    expect(resolveSecretCommand('licenseKey', argv)).toBe('a b\n');
    expect(resolveSecretCommand('licenseKey', printArg(SECRET))).toBe(SECRET);
  });

  it('runs without a shell, so metacharacters reach the command verbatim', () => {
    expect(resolveSecretCommand('nrApiKey', printArg('$HOME; echo pwned'))).toBe(
      '$HOME; echo pwned',
    );
  });

  it('strips injection-capable env vars from the child env', () => {
    process.env.NODE_OPTIONS = '--max-old-space-size=4096';
    process.env.PREFLIGHT_TEST_KEPT = 'kept';
    const argv = script(
      'env',
      'process.stdout.write(`${process.env.NODE_OPTIONS ?? "absent"} ${process.env.PREFLIGHT_TEST_KEPT}`);',
    );
    expect(resolveSecretCommand('licenseKey', argv)).toBe('absent kept');
  });

  it.each([
    ['relative path', ['node', '-e', '0'], 'not-absolute'],
    ['missing executable', ['/nonexistent/preflight-secret-helper'], 'not-runnable'],
  ] as const)('rejects a %s', (_label, argv, failure) => {
    const err = failureOf(() => resolveSecretCommand('licenseKey', argv));
    expect(err.failure).toBe(failure);
    expect(err.field).toBe('licenseKey');
  });

  it('reports a non-zero exit without the output it printed', () => {
    const argv = script(
      'fail',
      `process.stdout.write(${JSON.stringify(SECRET)}); process.stderr.write(${JSON.stringify(SECRET)}); process.exit(3);`,
    );
    const err = failureOf(() => resolveSecretCommand('nrApiKey', argv));
    expect(err.failure).toBe('non-zero-exit');
    expect(err.message).toBe(
      'Could not read nrApiKey from nrApiKeyCommand: the command exited with a non-zero status (3). ' +
        'Preflight does not show the command output; run the command yourself to see why it failed.',
    );
    expect(logged.join('\n')).not.toContain(SECRET);
  });

  it.each([
    ['empty', 'process.stdout.write("\\n");', 'empty-output'],
    ['whitespace-only', 'process.stdout.write("  \\n");', 'empty-output'],
    ['oversized', 'process.stdout.write("x".repeat(200 * 1024));', 'output-too-large'],
    ['signal-killed', 'process.kill(process.pid, "SIGKILL");', 'killed'],
  ] as const)('rejects %s output', (name, source, failure) => {
    const err = failureOf(() => resolveSecretCommand('digestWebhookUrl', script(name, source)));
    expect(err.failure).toBe(failure);
  });

  it('kills a command that runs past the timeout', () => {
    const argv = script('hang', 'setTimeout(() => {}, 60_000);');
    const err = failureOf(() => resolveSecretCommand('licenseKey', argv, 300));
    expect(err.failure).toBe('timeout');
    expect(err.message).toContain('licenseKeyCommand: the command timed out after 300ms');
  });
});

describe('loadMcpConfig() with *Command fields', () => {
  it('loads every secret from helper commands with none in the file', () => {
    const path = writeConfig({
      mode: 'cloud',
      accountId: '12345',
      licenseKeyCommand: printArg(SECRET),
      nrApiKeyCommand: script('api', 'process.stdout.write("test-user-api-key-0001\\n");'),
      digestWebhookUrlCommand: script('hook', `process.stdout.write(${JSON.stringify(WEBHOOK)});`),
    });

    const config = loadMcpConfig({ config: path });

    expect(config.licenseKey).toBe(SECRET);
    expect(config.nrApiKey).toBe('test-user-api-key-0001');
    expect(config.digestWebhookUrl).toBe(WEBHOOK);
    expect(config.tiers).toEqual([
      {
        name: 'default',
        destination: { type: 'nr', licenseKey: SECRET, accountId: '12345' },
        eventTypes: ['*'],
      },
    ]);
    expect(config.otlp.forwardHeaders).toEqual({ 'api-key': SECRET });
    expect(config.secretSources).toEqual({
      licenseKey: 'command',
      nrApiKey: 'command',
      digestWebhookUrl: 'command',
    });
    expect(digestWebhookUrlOverride(config)).toBe(WEBHOOK);
    expect(logged.join('\n')).not.toContain(SECRET);
    expect(logged.join('\n')).not.toContain(WEBHOOK);
  });

  it('leaves an explicit tiers array untouched', () => {
    const tiers = [
      {
        name: 'team',
        destination: { type: 'nr', licenseKey: 'lk-team', accountId: '67890' },
        eventTypes: ['*'],
      },
    ];
    const path = writeConfig({
      mode: 'cloud',
      accountId: '12345',
      licenseKeyCommand: printArg(SECRET),
      tiers,
    });

    expect(loadMcpConfig({ config: path }).tiers).toEqual(tiers);
  });

  it('fails config load naming the field, not the output', () => {
    const path = writeConfig({
      mode: 'cloud',
      accountId: '12345',
      licenseKeyCommand: script(
        'fail',
        `process.stdout.write(${JSON.stringify(SECRET)}); process.exit(1);`,
      ),
    });

    expect(() => loadMcpConfig({ config: path })).toThrow(
      'Could not read licenseKey from licenseKeyCommand: the command exited with a non-zero status (1).',
    );
    expect(() => loadMcpConfig({ config: path })).not.toThrow(SECRET);
    expect(logged.join('\n')).not.toContain(SECRET);
  });

  it('lets --local fall back to local mode when licenseKeyCommand fails', () => {
    const path = writeConfig({
      mode: 'cloud',
      accountId: '12345',
      licenseKeyCommand: script('fail', 'process.exit(1);'),
    });

    let thrown: unknown;
    try {
      loadMcpConfig({ config: path });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(SecretCommandError);
    expect((thrown as Error).message).toContain('Could not read licenseKey from licenseKeyCommand');
    expect(detectCloudForwardingGap(thrown)).toEqual({
      reason: 'secret-helper-failed',
      missingField: 'licenseKey',
      requestedMode: 'cloud',
    });
  });

  it('reads the file webhook URL when NEW_RELIC_AI_DIGEST_WEBHOOK_URL is blank', () => {
    process.env.NEW_RELIC_AI_DIGEST_WEBHOOK_URL = '';
    const path = writeConfig({ digestWebhookUrl: WEBHOOK });

    const config = loadMcpConfig({ config: path });

    expect(config.secretSources.digestWebhookUrl).toBe('file');
    expect(digestWebhookUrlOverride(config)).toBeUndefined();
  });

  it('runs digestWebhookUrlCommand when NEW_RELIC_AI_DIGEST_WEBHOOK_URL is blank', () => {
    process.env.NEW_RELIC_AI_DIGEST_WEBHOOK_URL = '';
    const path = writeConfig({ digestWebhookUrlCommand: printArg(WEBHOOK) });

    const config = loadMcpConfig({ config: path });

    expect(config.secretSources.digestWebhookUrl).toBe('command');
    expect(digestWebhookUrlOverride(config)).toBe(WEBHOOK);
  });

  it('runs licenseKeyCommand when NEW_RELIC_LICENSE_KEY is blank', () => {
    process.env.NEW_RELIC_LICENSE_KEY = '';
    const path = writeConfig({
      mode: 'cloud',
      accountId: '12345',
      licenseKeyCommand: printArg(SECRET),
    });

    const config = loadMcpConfig({ config: path });

    expect(config.licenseKey).toBe(SECRET);
    expect(config.secretSources.licenseKey).toBe('command');
  });

  it('runs licenseKeyCommand when NEW_RELIC_LICENSE_KEY is only whitespace', () => {
    process.env.NEW_RELIC_LICENSE_KEY = '  ';
    const path = writeConfig({
      mode: 'cloud',
      accountId: '12345',
      licenseKeyCommand: printArg(SECRET),
    });

    expect(loadMcpConfig({ config: path }).licenseKey).toBe(SECRET);
  });

  it('reads the file accountId when NEW_RELIC_ACCOUNT_ID is blank', () => {
    process.env.NEW_RELIC_ACCOUNT_ID = '';
    process.env.NEW_RELIC_LICENSE_KEY = 'env-license';
    const path = writeConfig({ mode: 'cloud', accountId: '12345' });

    expect(loadMcpConfig({ config: path }).accountId).toBe('12345');
  });

  it.each([
    ['nrApiKeyCommand', 'nrApiKey'],
    ['digestWebhookUrlCommand', 'digestWebhookUrl'],
  ] as const)('warns and continues when %s fails', (commandField, field) => {
    process.env.NEW_RELIC_LICENSE_KEY = 'env-license';
    const path = writeConfig({
      mode: 'cloud',
      accountId: '12345',
      [commandField]: script(
        'fail',
        `process.stdout.write(${JSON.stringify(SECRET)}); process.exit(1);`,
      ),
    });

    const config = loadMcpConfig({ config: path });

    expect(config.secretSources[field]).toBe('unset');
    expect(config[field]).toBeNull();
    expect(logged.join('\n')).toContain(`Could not read ${field} from ${commandField}`);
    expect(logged.join('\n')).not.toContain(SECRET);
  });

  it('does not run nrApiKeyCommand in local mode', () => {
    const { argv, ranMarker } = trackedPrint(SECRET);
    const path = writeConfig({ mode: 'local', nrApiKeyCommand: argv });

    const config = loadMcpConfig({ config: path });

    expect(config.nrApiKey).toBeNull();
    expect(config.secretSources.nrApiKey).toBe('unset');
    expect(() => writeFileSync(ranMarker, '', { flag: 'wx' })).not.toThrow();
  });

  it('reports sources without running any command when resolveSecrets is false', () => {
    const { argv, ranMarker } = trackedPrint(SECRET);
    const path = writeConfig({
      mode: 'cloud',
      accountId: '12345',
      licenseKeyCommand: argv,
      nrApiKeyCommand: argv,
      digestWebhookUrlCommand: argv,
    });

    const config = loadMcpConfig({ config: path }, { resolveSecrets: false });

    expect(config.secretSources).toEqual({
      licenseKey: 'command',
      nrApiKey: 'command',
      digestWebhookUrl: 'command',
    });
    expect(config.nrApiKey).toBeNull();
    expect(() => writeFileSync(ranMarker, '', { flag: 'wx' })).not.toThrow();
  });

  it('rejects a string command at schema validation, naming the field', () => {
    const path = writeConfig({ mode: 'local', nrApiKeyCommand: '/usr/bin/security -w' });
    expect(() => loadMcpConfig({ config: path })).toThrow(/nrApiKeyCommand/);
  });

  it('fails closed on a licenseKeyCommand with no explicit mode, without running it', () => {
    const { argv, ranMarker } = trackedPrint(SECRET);
    const path = writeConfig({ accountId: '12345', licenseKeyCommand: argv });

    expect(() => loadMcpConfig({ config: path })).toThrow('no explicit mode');
    expect(() => writeFileSync(ranMarker, '', { flag: 'wx' })).not.toThrow();
  });

  it('does not run licenseKeyCommand in local mode', () => {
    const { argv, ranMarker } = trackedPrint(SECRET);
    const path = writeConfig({ mode: 'local', licenseKeyCommand: argv });

    const config = loadMcpConfig({ config: path });

    expect(config.licenseKey).toBeUndefined();
    expect(config.secretSources.licenseKey).toBe('unset');
    expect(() => writeFileSync(ranMarker, '', { flag: 'wx' })).not.toThrow();
  });

  describe('precedence: env > command > file > unset', () => {
    it.each([
      // [env, command, file, expected value, expected source]
      ['env-value', 'cmd-value', 'file-value', 'env-value', 'env'],
      [undefined, 'cmd-value', 'file-value', 'cmd-value', 'command'],
      [undefined, undefined, 'file-value', 'file-value', 'file'],
      [undefined, undefined, undefined, null, 'unset'],
    ] as const)(
      'env=%s command=%s file=%s resolves nrApiKey to %s from %s',
      (env, command, file, value, source) => {
        if (env !== undefined) process.env.NEW_RELIC_API_KEY = env;
        process.env.NEW_RELIC_LICENSE_KEY = 'env-license';
        const path = writeConfig({
          mode: 'cloud',
          accountId: '12345',
          ...(command !== undefined && { nrApiKeyCommand: printArg(command) }),
          ...(file !== undefined && { nrApiKey: file }),
        });

        const config = loadMcpConfig({ config: path });

        expect(config.nrApiKey).toBe(value);
        expect(config.secretSources.nrApiKey).toBe(source);
      },
    );

    it('does not run the command when the env var supplies the value', () => {
      process.env.NEW_RELIC_LICENSE_KEY = 'env-license';
      const { argv, ranMarker } = trackedPrint(SECRET);
      const path = writeConfig({ mode: 'cloud', accountId: '12345', licenseKeyCommand: argv });

      const config = loadMcpConfig({ config: path });

      expect(config.licenseKey).toBe('env-license');
      expect(config.secretSources.licenseKey).toBe('env');
      expect(() => writeFileSync(ranMarker, '', { flag: 'wx' })).not.toThrow();
    });

    it('lets the file value through only when it is the winning source', () => {
      const path = writeConfig({ mode: 'local', digestWebhookUrl: WEBHOOK });
      const config = loadMcpConfig({ config: path });
      expect(config.secretSources.digestWebhookUrl).toBe('file');
      expect(digestWebhookUrlOverride(config)).toBeUndefined();
    });
  });
});
