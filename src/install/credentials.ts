import { readFileSync, statSync } from 'node:fs';

export interface CredentialInputs {
  readonly licenseKey?: string;
  readonly licenseKeyFile?: string;
  readonly accountId?: string;
}

export interface ResolvedCredentials {
  readonly licenseKey?: string;
  readonly accountId?: string;
  readonly warnings: readonly string[];
}

const GROUP_OR_WORLD_ACCESS = 0o077;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readKeyFile(path: string): { key: string; warning?: string } {
  let raw: string;
  let mode: number;
  try {
    mode = statSync(path).mode;
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown error';
    throw new Error(`Cannot read --license-key-file ${path} (${code}).`);
  }
  const key = raw.trim();
  if (!key) throw new Error(`--license-key-file ${path} is empty.`);
  const loose = process.platform !== 'win32' && (mode & GROUP_OR_WORLD_ACCESS) !== 0;
  return loose
    ? {
        key,
        warning: `${path} is readable by other users (mode ${(mode & 0o777).toString(8)}). Run: chmod 600 ${path}`,
      }
    : { key };
}

/**
 * Resolves the install credentials with the precedence flag > key file > env.
 * Errors name the file path and never its contents.
 */
export function resolveInstallCredentials(
  inputs: CredentialInputs,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedCredentials {
  const warnings: string[] = [];
  let licenseKey = nonEmpty(inputs.licenseKey);
  if (!licenseKey && inputs.licenseKeyFile) {
    const file = readKeyFile(inputs.licenseKeyFile);
    licenseKey = file.key;
    if (file.warning) warnings.push(file.warning);
  }
  licenseKey ??= nonEmpty(env.NEW_RELIC_LICENSE_KEY);
  const accountId = nonEmpty(inputs.accountId) ?? nonEmpty(env.NEW_RELIC_ACCOUNT_ID);
  return { licenseKey, accountId, warnings };
}
