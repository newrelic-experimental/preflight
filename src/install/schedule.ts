import { execFileSync } from 'node:child_process';
import {
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  accessSync,
  constants,
  unlinkSync,
  mkdirSync,
} from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { homedir } from 'node:os';

import { createLogger } from '../shared/index.js';
import { errMsg } from './json-utils.js';

const logger = createLogger('schedule');

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

const PLIST_LABEL = 'com.preflight.update';
const DASHBOARD_PLIST_LABEL = 'com.preflight.dashboard';

export function plistPath(): string {
  return resolve(homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);
}

export function dashboardPlistPath(): string {
  return resolve(homedir(), 'Library', 'LaunchAgents', `${DASHBOARD_PLIST_LABEL}.plist`);
}

function updateLogPath(): string {
  return resolve(homedir(), '.newrelic-preflight', 'update.log');
}

function dashboardLogPath(): string {
  return resolve(homedir(), '.newrelic-preflight', 'dashboard.log');
}

export interface FindExecutableNodeDirResult {
  readonly dir: string | null;
  /** True if a `node` binary was found in one of the dirs but lacked execute permission. */
  readonly hasNonExecutable: boolean;
}

// Scans dirs for an executable node binary. Checks both 'node' (standard) and
// 'nodejs' (Debian/Ubuntu package name). Returns the first matching dir and
// whether any non-executable candidates were seen (useful for actionable
// error messages when no match is found).
export function findExecutableNodeDir(dirs: string[]): FindExecutableNodeDirResult {
  let hasNonExecutable = false;
  for (const dir of dirs) {
    for (const name of ['node', 'nodejs']) {
      const candidate = join(dir, name);
      try {
        if (!statSync(candidate).isFile()) {
          // Not a file (directory, device node, etc.) — not a permission problem,
          // so don't set hasNonExecutable which would produce misleading chmod advice.
          continue;
        }
        try {
          accessSync(candidate, constants.X_OK);
          return { dir, hasNonExecutable: false };
        } catch {
          hasNonExecutable = true;
        }
      } catch {
        // statSync follows symlinks. Both a genuinely absent file and a broken symlink
        // (dangling after a node upgrade) throw ENOENT here. Treat both as not found —
        // the right fix for a dangling symlink is "reinstall node", which is what the
        // 'No executable node binary found' message in diagnostics already suggests.
      }
    }
  }
  return { dir: null, hasNonExecutable };
}

// Returns the directory containing the node binary running this process.
// Injected into launchd plists so the daemon can find node regardless of
// which version manager the user has.
//
// We walk PATH and return the directory of the first unresolved `node` match
// rather than dirname(process.execPath). process.execPath resolves symlinks,
// which on Homebrew gives the versioned Cellar path that `brew upgrade node`
// removes. Returning the unresolved PATH dir (e.g. /opt/homebrew/bin) gives
// a stable symlink that survives node upgrades without re-running setup.
// Note: nvm uses version-specific dirs (e.g. ~/.nvm/versions/node/v20/bin)
// that disappear after `nvm uninstall <version>` — run `preflight setup`
// again after switching nvm versions.
export function resolveNodeDir(): string {
  const pathDirs = (process.env.PATH ?? '').split(':').filter(Boolean);
  const { dir } = findExecutableNodeDir(pathDirs);
  if (dir !== null) return dir;
  const fallback = dirname(process.execPath);
  logger.warn(
    'No executable node binary found in PATH dirs; falling back to dirname(process.execPath) — this may be a versioned path that breaks after upgrades. Re-run preflight setup to fix.',
    { fallback },
  );
  // Also write a plain-text warning for interactive terminals: the logger.warn
  // above emits structured JSON which a terminal user cannot read without a log
  // viewer, so this gives the same message in human-readable form.
  process.stderr.write(
    `\nWarning: node binary not found in PATH — the daemon plist will use '${fallback}',\n` +
      `which may break after a node upgrade. Run 'preflight setup' again after updating node.\n\n`,
  );
  return fallback;
}

function buildPlist(binaryPath: string, hour: number, minute: number, nodeDir: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(binaryPath)}</string>
    <string>update</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(nodeDir)}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${hour}</integer>
    <key>Minute</key>
    <integer>${minute}</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(updateLogPath())}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(updateLogPath())}</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>`;
}

export interface ScheduleStatus {
  readonly installed: boolean;
  readonly readable: boolean;
  readonly hour?: number;
  readonly minute?: number;
  readonly binaryPath?: string;
}

export function installSchedule(binaryPath: string, hour: number, minute: number): void {
  const nodeDir = resolveNodeDir();
  const path = plistPath();
  mkdirSync(resolve(homedir(), 'Library', 'LaunchAgents'), { recursive: true, mode: 0o755 });
  writeFileSync(path, buildPlist(binaryPath, hour, minute, nodeDir), { mode: 0o600 });
  try {
    execFileSync('launchctl', ['unload', path], { stdio: 'pipe' });
  } catch {
    // Not yet loaded — that's fine.
  }
  try {
    execFileSync('launchctl', ['load', path], { stdio: 'pipe' });
  } catch (err) {
    throw new Error(`launchctl load failed: ${errMsg(err)}`);
  }
}

export function removeSchedule(): boolean {
  const path = plistPath();
  if (!existsSync(path)) return false;
  try {
    execFileSync('launchctl', ['unload', path], { stdio: 'pipe' });
  } catch {
    // Plist may be unreadable — remove by label so the job isn't orphaned in launchd.
    try {
      execFileSync('launchctl', ['remove', PLIST_LABEL], { stdio: 'pipe' });
    } catch {
      // Job was not loaded — fine.
    }
  }
  try {
    unlinkSync(path);
  } catch (err) {
    // The launchd job was removed above; the plist file is now an orphaned artifact
    // but harmless (launchctl will not auto-load it). Log the failure so the user
    // can clean it manually if desired, but report success so the uninstall can
    // proceed without trapping the user in a retry loop.
    logger.warn('schedule plist could not be deleted', { path, err: errMsg(err) });
  }
  return true;
}

export function getScheduleStatus(): ScheduleStatus {
  const path = plistPath();
  if (!existsSync(path)) return { installed: false, readable: false };
  try {
    const content = readFileSync(path, 'utf-8');
    const hourMatch = content.match(/<key>Hour<\/key>\s*<integer>(\d+)<\/integer>/);
    const minuteMatch = content.match(/<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/);
    const binaryMatch = content.match(
      /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/,
    );
    return {
      installed: true,
      readable: true,
      hour: hourMatch ? parseInt(hourMatch[1], 10) : undefined,
      minute: minuteMatch ? parseInt(minuteMatch[1], 10) : undefined,
      binaryPath: binaryMatch ? unescapeXml(binaryMatch[1]) : undefined,
    };
  } catch {
    return { installed: true, readable: false };
  }
}

function buildDashboardPlist(binaryPath: string, nodeDir: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DASHBOARD_PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(binaryPath)}</string>
    <string>--local</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(nodeDir)}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>300</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(dashboardLogPath())}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(dashboardLogPath())}</string>
</dict>
</plist>`;
}

export interface DashboardDaemonStatus {
  readonly installed: boolean;
  readonly readable: boolean;
  readonly binaryPath?: string;
  /** Decoded PATH value from the plist EnvironmentVariables. Absent on older plists that predate node-path injection. */
  readonly envPath?: string;
}

export function installDashboardDaemon(binaryPath: string): void {
  const nodeDir = resolveNodeDir();
  const path = dashboardPlistPath();
  mkdirSync(resolve(homedir(), 'Library', 'LaunchAgents'), { recursive: true, mode: 0o755 });
  writeFileSync(path, buildDashboardPlist(binaryPath, nodeDir), { mode: 0o600 });
  try {
    execFileSync('launchctl', ['unload', path], { stdio: 'pipe' });
  } catch {
    // Not yet loaded — that's fine.
  }
  try {
    execFileSync('launchctl', ['load', path], { stdio: 'pipe' });
  } catch (err) {
    throw new Error(`launchctl load failed: ${errMsg(err)}`);
  }
}

export function removeDashboardDaemon(): boolean {
  const path = dashboardPlistPath();
  if (!existsSync(path)) return false;
  try {
    execFileSync('launchctl', ['unload', path], { stdio: 'pipe' });
  } catch {
    // Plist may be unreadable — remove by label so the job isn't orphaned in launchd.
    try {
      execFileSync('launchctl', ['remove', DASHBOARD_PLIST_LABEL], { stdio: 'pipe' });
    } catch {
      // Job was not loaded — fine.
    }
  }
  try {
    unlinkSync(path);
  } catch (err) {
    // The launchd job was removed above; the plist file is now an orphaned artifact
    // but harmless (launchctl will not auto-load it). Log the failure so the user
    // can clean it manually if desired, but report success so the uninstall can
    // proceed without trapping the user in a retry loop.
    logger.warn('daemon plist could not be deleted', { path, err: errMsg(err) });
  }
  return true;
}

export function getDashboardDaemonStatus(): DashboardDaemonStatus {
  const path = dashboardPlistPath();
  if (!existsSync(path)) return { installed: false, readable: false };
  try {
    const content = readFileSync(path, 'utf-8');
    const binaryMatch = content.match(
      /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/,
    );
    const pathMatch = content.match(/<key>PATH<\/key>\s*<string>([^<]+)<\/string>/);
    return {
      installed: true,
      readable: true,
      binaryPath: binaryMatch ? unescapeXml(binaryMatch[1]) : undefined,
      envPath: pathMatch ? unescapeXml(pathMatch[1]) : undefined,
    };
  } catch {
    return { installed: true, readable: false };
  }
}

export function resolveBinaryPath(): string | null {
  // Walk PATH directly — avoids hardcoding the `which` location and is safe
  // for Nix/Homebrew installs where binaries live outside /usr/bin.
  const pathDirs = (process.env.PATH ?? '').split(':').filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = join(dir, 'preflight');
    try {
      if (statSync(candidate).isFile()) {
        accessSync(candidate, constants.X_OK);
        return candidate;
      }
    } catch {
      continue;
    }
  }
  return null;
}
