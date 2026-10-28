import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export interface TargetUser {
  readonly name: string;
  readonly uid: number;
  readonly gid: number;
  readonly home: string;
}

type RunCommand = (file: string, args: string[]) => string;

const USER_NAME = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;

const runCommand: RunCommand = (file, args) =>
  execFileSync(file, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });

function parseDscl(output: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const split = line.indexOf(':');
    if (split > 0) fields[line.slice(0, split).trim()] = line.slice(split + 1).trim();
  }
  return fields;
}

/**
 * Looks a user up in the OS account database: `dscl` on macOS, `getent` on
 * Linux. Never trusts $HOME or $SUDO_USER, which describe the caller.
 */
export function lookupUser(
  name: string,
  platform: NodeJS.Platform = process.platform,
  run: RunCommand = runCommand,
): TargetUser {
  if (!USER_NAME.test(name)) throw new Error(`Invalid --target-user name: ${name}`);
  if (platform !== 'darwin' && platform !== 'linux') {
    throw new Error('--target-user is supported on macOS and Linux only.');
  }

  let uid: number;
  let gid: number;
  let home: string;
  try {
    if (platform === 'darwin') {
      const fields = parseDscl(
        run('dscl', [
          '.',
          '-read',
          `/Users/${name}`,
          'NFSHomeDirectory',
          'UniqueID',
          'PrimaryGroupID',
        ]),
      );
      uid = Number(fields.UniqueID);
      gid = Number(fields.PrimaryGroupID);
      home = fields.NFSHomeDirectory ?? '';
    } else {
      const [, , uidField, gidField, , homeField] = run('getent', ['passwd', name])
        .trim()
        .split(':');
      uid = Number(uidField);
      gid = Number(gidField);
      home = homeField ?? '';
    }
  } catch {
    throw new Error(`User not found: ${name}`);
  }

  if (!Number.isInteger(uid) || !Number.isInteger(gid)) {
    throw new Error(`User not found: ${name}`);
  }
  if (!isAbsolute(home) || !existsSync(home)) {
    throw new Error(`Home directory of ${name} does not exist: ${home || '(none)'}`);
  }
  return { name, uid, gid, home };
}

const VALUE_OPTIONS = ['--target-user', '--license-key', '--license-key-file', '--account-id'];

/** Drops the given value-taking options (`--opt value` and `--opt=value`) from argv. */
export function stripValueOptions(argv: readonly string[], names: readonly string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (names.includes(arg)) {
      i++;
    } else if (!names.some((n) => arg.startsWith(`${n}=`))) {
      kept.push(arg);
    }
  }
  return kept;
}

/**
 * Re-runs this CLI as `user` with that user's HOME, so every path the install
 * resolves and every file it creates belongs to them. Credentials travel in
 * the environment, not argv, so they stay out of `ps`.
 */
export function runInstallAsUser(
  user: TargetUser,
  argv: readonly string[],
  credentials: { licenseKey?: string; accountId?: string },
  spawn: typeof spawnSync = spawnSync,
): number {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: user.home,
    USER: user.name,
    LOGNAME: user.name,
  };
  if (credentials.licenseKey) env.NEW_RELIC_LICENSE_KEY = credentials.licenseKey;
  if (credentials.accountId) env.NEW_RELIC_ACCOUNT_ID = credentials.accountId;

  const result = spawn(process.execPath, stripValueOptions(argv, VALUE_OPTIONS), {
    uid: user.uid,
    gid: user.gid,
    env,
    cwd: user.home,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}
