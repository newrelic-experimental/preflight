import { readFileSync, statSync } from 'node:fs';

export interface CredentialInputs {
  readonly licenseKey?: string;
  readonly licenseKeyFile?: string;
  readonly accountId?: string;
  /** When true, a stored key or `licenseKeyCommand` exists and ambient env must not replace it. */
  readonly hasStoredCredentials?: boolean;
}

export interface ResolvedCredentials {
  readonly licenseKey?: string;
  readonly accountId?: string;
  readonly licenseKeySource?: 'flag' | 'file' | 'env';
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
 * The env fallback is skipped when `hasStoredCredentials` is set, unless the key came from
 * a flag or file (an explicit replacement, which may take its account ID from the env), because
 * NEW_RELIC_* is commonly present in a shell for unrelated tools (APM agents,
 * the newrelic CLI) and must not silently overwrite a stored key.
 * Errors name the file path and never its contents.
 */
export function resolveInstallCredentials(
  inputs: CredentialInputs,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedCredentials {
  const warnings: string[] = [];
  let licenseKey = nonEmpty(inputs.licenseKey);
  let licenseKeySource: ResolvedCredentials['licenseKeySource'] = licenseKey ? 'flag' : undefined;
  if (!licenseKey && inputs.licenseKeyFile) {
    const file = readKeyFile(inputs.licenseKeyFile);
    licenseKey = file.key;
    licenseKeySource = 'file';
    if (file.warning) warnings.push(file.warning);
  }
  if (!licenseKey && !inputs.hasStoredCredentials) {
    licenseKey = nonEmpty(env.NEW_RELIC_LICENSE_KEY);
    if (licenseKey) licenseKeySource = 'env';
  }
  const envAllowed =
    !inputs.hasStoredCredentials || licenseKeySource === 'flag' || licenseKeySource === 'file';
  const accountId =
    nonEmpty(inputs.accountId) ?? (envAllowed ? nonEmpty(env.NEW_RELIC_ACCOUNT_ID) : undefined);
  return { licenseKey, accountId, licenseKeySource, warnings };
}
