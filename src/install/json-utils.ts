import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  renameSync,
  unlinkSync,
  realpathSync,
} from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

export function readJsonFile(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// Like readJsonFile but throws on IO errors (EBUSY, EPERM, etc.) and on
// malformed or non-object JSON rather than returning {}. Returns {} only for
// ENOENT (file absent). Use when the file is known to exist and its contents
// must be preserved.
export function readJsonFileStrict(path: string): Record<string, unknown> {
  try {
    const val: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      return val as Record<string, unknown>;
    }
    throw new SyntaxError(
      `Expected a JSON object but got ${Array.isArray(val) ? 'array' : typeof val}`,
    );
  } catch (err) {
    if (err instanceof SyntaxError) throw err;
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

export function writeJsonFile(
  path: string,
  data: Record<string, unknown>,
  additionalAllowedBase?: string,
): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  // Symlink guard: verify both the resolved parent directory AND the resolved
  // target file path are under HOME, cwd, or an explicitly allowed base (e.g.
  // the Windows home path under /mnt/c/... when writing from WSL).
  const resolvedDir = realpathSync(dir);
  const resolvedPath = existsSync(path) ? realpathSync(path) : resolve(resolvedDir, basename(path));
  const home = homedir();
  const cwd = process.cwd();
  // Resolve additionalAllowedBase so symlinked storage directories (e.g. ~/.newrelic-preflight
  // → /data/shared/preflight) are correctly matched against the resolved target path.
  const resolvedAllowedBase =
    additionalAllowedBase !== undefined
      ? (() => {
          try {
            return realpathSync(additionalAllowedBase);
          } catch (err) {
            // ENOENT: path doesn't exist yet (created by mkdirSync above on first write).
            // All other errors (EACCES, EPERM) propagate — a permission failure here
            // means the resolved base is unknown, which would defeat the symlink guard.
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') return additionalAllowedBase;
            throw err;
          }
        })()
      : undefined;
  const check = (p: string) =>
    p === home ||
    p.startsWith(home + sep) ||
    p === cwd ||
    p.startsWith(cwd + sep) ||
    (resolvedAllowedBase !== undefined &&
      (p === resolvedAllowedBase || p.startsWith(resolvedAllowedBase + sep)));
  if (!check(resolvedDir) || !check(resolvedPath)) {
    throw new Error(`Refusing to write outside HOME or project root: ${resolvedPath}`);
  }

  const tmp = path + '.tmp';
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    // Best-effort cleanup of the temp file — suppress secondary errors so the
    // original write/rename error is what propagates to the caller.
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* best-effort */
    }
    throw err;
  }
}
