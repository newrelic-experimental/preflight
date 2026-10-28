import { spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';

import { createLogger } from './shared/index.js';
import { stripDangerousEnv } from './lib/child-env.js';

const logger = createLogger('secret-command');

export type SecretField = 'licenseKey' | 'nrApiKey' | 'digestWebhookUrl';

/** No CLI flag carries a secret today, so `cli` is not a possible source. */
export type SecretSource = 'env' | 'command' | 'file' | 'unset';
export type SecretSources = { readonly [F in SecretField]: SecretSource };

export type ResolvedSecret =
  | { readonly source: 'env' | 'file'; readonly value: string }
  // `value` is undefined only when the caller asked not to run commands.
  | { readonly source: 'command'; readonly value: string | undefined }
  | { readonly source: 'unset'; readonly value: undefined };

export type SecretCommandFailure =
  | 'not-absolute'
  | 'not-runnable'
  | 'timeout'
  | 'output-too-large'
  | 'killed'
  | 'non-zero-exit'
  | 'empty-output';

const FAILURE_MESSAGES: Readonly<Record<SecretCommandFailure, string>> = {
  'not-absolute': 'the first array element must be an absolute path to the executable',
  'not-runnable': 'the executable could not be started',
  timeout: 'the command timed out',
  'output-too-large': 'the command printed more output than a secret can be',
  killed: 'the command was killed by a signal',
  'non-zero-exit': 'the command exited with a non-zero status',
  'empty-output': 'the command printed nothing to stdout',
};

/**
 * Names the field and the failure class only. The command's stdout, stderr
 * and argv never appear in the message: stdout is the secret, and the other
 * two can carry pieces of it.
 */
export class SecretCommandError extends Error {
  readonly field: SecretField;
  readonly failure: SecretCommandFailure;
  readonly tier: string | undefined;

  constructor(field: SecretField, failure: SecretCommandFailure, extra = '', tier?: string) {
    const where = tier === undefined ? '' : ` for tier "${tier}"`;
    super(
      `Could not read ${field}${where} from ${field}Command: ${FAILURE_MESSAGES[failure]}${extra}. ` +
        'Preflight does not show the command output; run the command yourself to see why it failed.',
    );
    this.name = 'SecretCommandError';
    this.field = field;
    this.failure = failure;
    this.tier = tier;
  }
}

const SECRET_COMMAND_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * Runs `argv` (absolute executable path first) with no shell and a stripped env, and returns its stdout minus
 * one trailing newline. Throws SecretCommandError on any failure; a `tier`
 * is named in the error so a multi-account config says which key failed.
 */
export function resolveSecretCommand(
  field: SecretField,
  argv: readonly string[],
  timeoutMs = SECRET_COMMAND_TIMEOUT_MS,
  tier?: string,
): string {
  const fail = (failure: SecretCommandFailure, extra = ''): SecretCommandError =>
    new SecretCommandError(field, failure, extra, tier);
  const [executable, ...args] = argv;
  if (executable === undefined || !isAbsolute(executable)) {
    throw fail('not-absolute');
  }

  const { env, stripped } = stripDangerousEnv(process.env);
  if (stripped.length > 0) {
    logger.debug('Stripped injection-capable env vars from secret helper env', {
      field,
      tier,
      envNames: stripped,
    });
  }

  const result = spawnSync(executable, args, {
    shell: false,
    env,
    timeout: timeoutMs,
    maxBuffer: MAX_OUTPUT_BYTES,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ETIMEDOUT') throw fail('timeout', ` after ${timeoutMs}ms`);
    if (code === 'ENOBUFS') throw fail('output-too-large');
    throw fail('not-runnable', code ? ` (${code})` : '');
  }
  if (result.signal) throw fail('killed', ` (${result.signal})`);
  if (result.status !== 0) {
    throw fail('non-zero-exit', ` (${String(result.status)})`);
  }

  const output = result.stdout.replace(/\r?\n$/, '');
  if (output.trim() === '') throw fail('empty-output');
  return output;
}

type SecretInputs = {
  readonly env: string | undefined;
  readonly command: readonly string[] | undefined;
  readonly file: string | undefined;
};

/**
 * Whether any source would supply a non-empty value, without running the
 * command. Follows resolveSecret's precedence: a non-empty env var decides
 * alone, and a blank one is treated as unset.
 */
export function isSecretConfigured(sources: SecretInputs): boolean {
  if (sources.env?.trim()) return true;
  return sources.command !== undefined || Boolean(sources.file);
}

/**
 * Precedence: non-empty env var > helper command > plaintext file value. A
 * blank env var counts as unset, so it cannot shadow the other two. The
 * command runs only when no env var supplied the value. With `optional`, a failing
 * command is logged as a warning and the secret is treated as unset instead of
 * stopping startup; the plaintext value is not used as a fallback. With
 * `skipCommand`, a winning command is reported as the source but not run.
 */
export function resolveSecret(
  field: SecretField,
  sources: SecretInputs,
  options: { readonly optional?: boolean; readonly skipCommand?: boolean } = {},
): ResolvedSecret {
  if (sources.env?.trim()) return { source: 'env', value: sources.env };
  if (sources.command !== undefined) {
    if (sources.file !== undefined) {
      logger.warn(`Both ${field} and ${field}Command are set; using ${field}Command`, { field });
    }
    if (options.skipCommand) return { source: 'command', value: undefined };
    try {
      return { source: 'command', value: resolveSecretCommand(field, sources.command) };
    } catch (err) {
      if (!options.optional || !(err instanceof SecretCommandError)) throw err;
      logger.warn(`${err.message} Continuing without ${field}.`, { field, failure: err.failure });
      return { source: 'unset', value: undefined };
    }
  }
  if (sources.file !== undefined) return { source: 'file', value: sources.file };
  return { source: 'unset', value: undefined };
}
