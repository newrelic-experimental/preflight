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
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const PLIST_LABEL = 'com.preflight.update';
const DASHBOARD_PLIST_LABEL = 'com.preflight.dashboard';

function plistPath(): string {
  return resolve(homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);
}

function dashboardPlistPath(): string {
  return resolve(homedir(), 'Library', 'LaunchAgents', `${DASHBOARD_PLIST_LABEL}.plist`);
}

function updateLogPath(): string {
  return resolve(homedir(), '.newrelic-preflight', 'update.log');
}

function dashboardLogPath(): string {
  return resolve(homedir(), '.newrelic-preflight', 'dashboard.log');
}

function buildPlist(binaryPath: string, hour: number, minute: number): string {
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
  readonly hour?: number;
  readonly minute?: number;
  readonly binaryPath?: string;
}

export function installSchedule(binaryPath: string, hour: number, minute: number): void {
  const path = plistPath();
  mkdirSync(resolve(homedir(), 'Library', 'LaunchAgents'), { recursive: true, mode: 0o755 });
  writeFileSync(path, buildPlist(binaryPath, hour, minute), { mode: 0o600 });
  try {
    execFileSync('launchctl', ['unload', path], { stdio: 'pipe' });
  } catch {
    // Not yet loaded — that's fine.
  }
  try {
    execFileSync('launchctl', ['load', path], { stdio: 'pipe' });
  } catch (err) {
    throw new Error(`launchctl load failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function removeSchedule(): void {
  const path = plistPath();
  if (!existsSync(path)) return;
  try {
    execFileSync('launchctl', ['unload', path], { stdio: 'pipe' });
  } catch {
    // Already unloaded.
  }
  unlinkSync(path);
}

export function getScheduleStatus(): ScheduleStatus {
  const path = plistPath();
  if (!existsSync(path)) return { installed: false };
  try {
    const content = readFileSync(path, 'utf-8');
    const hourMatch = content.match(/<key>Hour<\/key>\s*<integer>(\d+)<\/integer>/);
    const minuteMatch = content.match(/<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/);
    const binaryMatch = content.match(
      /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/,
    );
    return {
      installed: true,
      hour: hourMatch ? parseInt(hourMatch[1], 10) : undefined,
      minute: minuteMatch ? parseInt(minuteMatch[1], 10) : undefined,
      binaryPath: binaryMatch ? binaryMatch[1] : undefined,
    };
  } catch {
    return { installed: false };
  }
}

function buildDashboardPlist(binaryPath: string): string {
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
  <key>KeepAlive</key>
  <true/>
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
  readonly binaryPath?: string;
}

export function installDashboardDaemon(binaryPath: string): void {
  const path = dashboardPlistPath();
  mkdirSync(resolve(homedir(), 'Library', 'LaunchAgents'), { recursive: true, mode: 0o755 });
  writeFileSync(path, buildDashboardPlist(binaryPath), { mode: 0o600 });
  try {
    execFileSync('launchctl', ['unload', path], { stdio: 'pipe' });
  } catch {
    // Not yet loaded — that's fine.
  }
  try {
    execFileSync('launchctl', ['load', path], { stdio: 'pipe' });
  } catch (err) {
    throw new Error(`launchctl load failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function removeDashboardDaemon(): void {
  const path = dashboardPlistPath();
  if (!existsSync(path)) return;
  try {
    execFileSync('launchctl', ['unload', path], { stdio: 'pipe' });
  } catch {
    // Already unloaded.
  }
  unlinkSync(path);
}

export function getDashboardDaemonStatus(): DashboardDaemonStatus {
  const path = dashboardPlistPath();
  if (!existsSync(path)) return { installed: false };
  try {
    const content = readFileSync(path, 'utf-8');
    const binaryMatch = content.match(
      /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/,
    );
    return {
      installed: true,
      binaryPath: binaryMatch ? binaryMatch[1] : undefined,
    };
  } catch {
    return { installed: false };
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
