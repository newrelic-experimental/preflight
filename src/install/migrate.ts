import { existsSync, renameSync, cpSync, rmSync, readSync, openSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { DEFAULT_STORAGE_PATH } from '../config.js';

function promptYesNo(question: string): boolean {
  process.stderr.write(question);
  // Open /dev/tty directly — Node.js sets fd 0 to O_NONBLOCK on TTY startup,
  // causing readSync(0,...) to return 0 immediately. A freshly opened fd blocks.
  const fd = openSync('/dev/tty', 'r');
  try {
    const buf = Buffer.alloc(256);
    const n = readSync(fd, buf, 0, buf.length, null);
    return buf.subarray(0, n).toString().trim().toLowerCase().startsWith('y');
  } finally {
    closeSync(fd);
  }
}

/**
 * One-time migration: rename ~/.nr-ai-observe → ~/.newrelic-preflight when the
 * new path doesn't exist yet. Safe to call from any entry point (install,
 * update, setup wizard, server startup). Runs silently on success; warns on
 * failure but never aborts the caller.
 *
 * Pass interactive=true from CLI entry points (install, setup wizard) to
 * prompt before merging when both paths exist. Non-interactive callers
 * (server startup, update) print a notice instead.
 */
export function migrateStoragePath(interactive = false): void {
  const oldPath = resolve(homedir(), '.nr-ai-observe');
  const newPath = DEFAULT_STORAGE_PATH;
  if (!existsSync(oldPath)) return;
  if (existsSync(newPath)) {
    // Both paths exist — newPath was likely created by `preflight install` or
    // server startup before migration ran.
    const hasOldContent =
      existsSync(resolve(oldPath, 'config.json')) ||
      existsSync(resolve(oldPath, 'sessions')) ||
      existsSync(resolve(oldPath, 'alerts')) ||
      existsSync(resolve(oldPath, 'weekly_summaries'));
    if (!hasOldContent) return;
    if (!interactive || !process.stdin.isTTY) {
      // Non-interactive or non-TTY stdin (server startup, launchd update, CI):
      // surface the notice so the user sees it next time they run `preflight install`.
      // Never prompt when stdin is not a TTY — readSync returns 0 on EOF rather
      // than throwing, which would produce a misleading "Migration skipped" message.
      process.stderr.write(
        `[preflight] Notice: found old data at ${oldPath} but ${newPath} already exists.\n` +
          `  Run \`preflight install\` in an interactive terminal to migrate your sessions, config, and alert rules.\n`,
      );
      return;
    }
    let confirmed = false;
    try {
      confirmed = promptYesNo(
        `[preflight] Found old storage data at ${oldPath}.\n` +
          `  Merge into ${newPath}? Existing files in the new location will not be overwritten. [y/N] `,
      );
    } catch {
      // Unexpected stdin error — treat as "no"
    }
    if (!confirmed) {
      process.stderr.write(
        `[preflight] Migration skipped. To migrate manually:\n` +
          `    cp -rn "${oldPath}/." "${newPath}/" || true\n` +
          `    rm -r "${oldPath}"\n`,
      );
      return;
    }
    try {
      cpSync(oldPath, newPath, { recursive: true, force: false, errorOnExist: false });
    } catch (err) {
      process.stderr.write(
        `[preflight] Could not merge storage directories. To migrate manually:\n` +
          `    cp -rn "${oldPath}/." "${newPath}/" || true\n` +
          `    rm -r "${oldPath}"\n` +
          `  Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return;
    }
    try {
      rmSync(oldPath, { recursive: true, force: true });
    } catch (err) {
      // Copy succeeded — data is safe in newPath. Only cleanup failed.
      process.stderr.write(
        `[preflight] Sessions merged into ${newPath} but old directory could not be removed.\n` +
          `  Safe to delete manually: rm -r "${oldPath}"\n` +
          `  Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return;
    }
    process.stderr.write(
      `[preflight] Merged storage directory:\n` +
        `  ${oldPath}\n` +
        `  → ${newPath}\n` +
        `  Your sessions, config, and alert rules have been moved automatically.\n`,
    );
    return;
  }
  try {
    renameSync(oldPath, newPath);
    process.stderr.write(
      `[preflight] Migrated storage directory:\n` +
        `  ${oldPath}\n` +
        `  → ${newPath}\n` +
        `  Your sessions, config, and alert rules have been moved automatically.\n`,
    );
  } catch (err) {
    // ENOENT means another preflight process already completed the migration
    // (oldPath is gone, newPath exists) — return silently.
    // ENOTEMPTY means newPath was created between our existsSync check and the
    // rename call (e.g. a concurrent `preflight install`). In that case oldPath
    // still exists with user data — fall through to the warning so the user
    // knows to merge manually.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' && existsSync(newPath)) {
      return;
    }
    process.stderr.write(
      `[preflight] Warning: could not migrate storage directory from ${oldPath} to ${newPath}.\n` +
        `  Please rename it manually, or set NEW_RELIC_AI_MCP_STORAGE_PATH to override.\n` +
        `  Error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}
