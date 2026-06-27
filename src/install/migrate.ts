import {
  existsSync,
  renameSync,
  cpSync,
  rmSync,
  readSync,
  openSync,
  closeSync,
  readFileSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { DEFAULT_STORAGE_PATH } from '../config.js';
import type { PlatformTarget } from '../config.js';
import { readJsonFileStrict, writeJsonFile } from './json-utils.js';

function migrateWslMarker(): void {
  const markerPath = resolve(DEFAULT_STORAGE_PATH, '.wsl-mode');
  if (!existsSync(markerPath)) return;
  try {
    const raw = readFileSync(markerPath, 'utf8').trim();
    const platform = raw === 'windows' ? 'wsl-windows-cc' : raw === 'linux' ? 'wsl-linux-cc' : null;
    if (platform !== null) {
      const configPath = resolve(DEFAULT_STORAGE_PATH, 'config.json');
      // Use strict read: if config.json is malformed or unreadable (EBUSY, EPERM),
      // throw so the outer catch skips the write and leaves credentials intact.
      // ENOENT (file absent) still returns {} — safe to write a fresh config.
      const existing = readJsonFileStrict(configPath);
      // Skip the write if config.json already has a WSL platformTarget set by a
      // ≥1.0.4 install on this machine — that value reflects a deliberate WSL
      // mode choice and must not be overwritten by a stale marker.
      // 'native' is intentionally excluded: it can arrive via cross-machine
      // config copy (e.g. macOS → WSL) and must not suppress a real WSL marker.
      // Typed constants: TypeScript will error here if these drift from PlatformTarget.
      const wslWindowsCc: PlatformTarget = 'wsl-windows-cc';
      const wslLinuxCc: PlatformTarget = 'wsl-linux-cc';
      const alreadyMigrated =
        existing.platformTarget === wslWindowsCc || existing.platformTarget === wslLinuxCc;
      if (!alreadyMigrated) {
        // Pass DEFAULT_STORAGE_PATH as the allowed base so the symlink guard accepts
        // writes when the storage directory is symlinked outside HOME.
        writeJsonFile(configPath, { ...existing, platformTarget: platform }, DEFAULT_STORAGE_PATH);
      }
      // Delete marker after the rename is committed (or skipped). Wrapped in its own
      // catch so a failure here (e.g. WSL1 DrvFs read-only file attribute on .wsl-mode)
      // is handled inline rather than propagating to the outer catch — which would
      // exit the function without deleting the marker on the current call, but would
      // not cause re-migration loops because config.json is already correct.
      try {
        unlinkSync(markerPath);
      } catch {
        /* re-migration on next startup is idempotent */
      }
    } else {
      // Unrecognized marker content — cannot migrate, but deleting it prevents this
      // function from re-running on every startup (existsSync would fire each time).
      try {
        unlinkSync(markerPath);
      } catch {
        /* WSL1 DrvFs read-only attribute — re-run on next startup is harmless */
      }
    }
  } catch {
    // Non-fatal: next install falls back to filesystem detection.
  }
}

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
  migrateWslMarker();

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
