/**
 * Daemon lifecycle management for the nr-ai-observe server.
 *
 * Provides start/stop/status commands for running the server in the background.
 * On macOS, integrates with launchd for auto-start on login and restart-on-crash.
 * On Linux, manages the process directly via pidfile.
 */

import { spawn, execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';

import { createLogger } from '../shared/index.js';
import { DANGEROUS_ENV_KEYS as BASE_DANGEROUS_ENV_KEYS } from '../proxy/upstream-stdio.js';
import { resolveBinaryPath } from './schedule.js';

const logger = createLogger('daemon');

const DEFAULT_PORT = 7777;
const STATE_DIR = resolve(homedir(), '.nr-ai-observe');
const LOG_DIR = resolve(STATE_DIR, 'logs');
const PLIST_LABEL = 'com.nr-ai-observe.daemon';
const PLIST_PATH = resolve(homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);
const HEALTH_TIMEOUT_MS = 3000;
const STOP_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 200;

// ELECTRON_RUN_AS_NODE can make Node behave as an Electron main process, so
// strip it in addition to the base set used by the proxy upstream.
const DAEMON_DANGEROUS_ENV_KEYS = new Set([...BASE_DANGEROUS_ENV_KEYS, 'ELECTRON_RUN_AS_NODE']);

function sanitizeEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const clean = { ...env };
  for (const key of DAEMON_DANGEROUS_ENV_KEYS) {
    delete clean[key];
  }
  return clean;
}

export interface DaemonStatus {
  readonly running: boolean;
  readonly pid?: number;
  readonly port: number;
  readonly uptime?: number; // seconds
  readonly url?: string;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function getPidfilePath(): string {
  return resolve(STATE_DIR, 'daemon.pid');
}

export function getPortFilePath(): string {
  return resolve(STATE_DIR, 'daemon.port');
}

export function getLogPath(): string {
  return resolve(LOG_DIR, 'daemon.log');
}

// ---------------------------------------------------------------------------
// PID helpers
// ---------------------------------------------------------------------------

export function readPid(): number | null {
  const pidfile = getPidfilePath();
  if (!existsSync(pidfile)) return null;
  try {
    const content = readFileSync(pidfile, 'utf-8').trim();
    const pid = parseInt(content, 10);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return pid;
  } catch {
    return null;
  }
}

function readPort(): number | null {
  try {
    const content = readFileSync(getPortFilePath(), 'utf-8').trim();
    const port = parseInt(content, 10);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
    return port;
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'EPERM') {
      return true;
    }
    return false;
  }
}

function isOurProcess(pid: number): boolean {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return true;
  try {
    const output = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return (
      output.includes('--local') ||
      output.includes('nr-ai-mcp-server') ||
      output.includes('nr-ai-observe') ||
      output.includes('index.js')
    );
  } catch {
    return true;
  }
}

export function isRunning(): boolean {
  const pid = readPid();
  if (pid === null) return false;
  return processAlive(pid);
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export async function getDaemonStatus(port?: number): Promise<DaemonStatus> {
  const effectivePort = port ?? readPort() ?? DEFAULT_PORT;
  const pid = readPid();
  const alive = pid !== null && processAlive(pid);

  if (!alive) {
    return { running: false, port: effectivePort };
  }

  const url = `http://127.0.0.1:${effectivePort}`;
  let uptime: number | undefined;

  try {
    const response = await fetchHealth(effectivePort);
    if (response.ok) {
      uptime = response.uptime;
    }
  } catch {
    // Process is alive but health endpoint unreachable — still report as running.
  }

  return {
    running: true,
    pid: pid ?? undefined,
    port: effectivePort,
    uptime,
    url,
  };
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export async function startDaemon(opts?: {
  port?: number;
  foreground?: boolean;
  log?: (msg: string) => void;
}): Promise<void> {
  const effectivePort = opts?.port ?? DEFAULT_PORT;
  const log = opts?.log ?? (() => {});

  // Guard against stale pidfiles: only refuse to start if the PID is alive
  // AND belongs to our process. A recycled PID from an unrelated process
  // would otherwise cause a permanent "already running" deadlock.
  const existingPid = readPid();
  if (existingPid !== null && processAlive(existingPid)) {
    if (isOurProcess(existingPid)) {
      throw new Error(
        `Daemon already running (PID ${existingPid}). Stop it first with: nr-ai-observe stop`,
      );
    }
    // Stale pidfile — a different process now owns this PID.
    logger.warn('Stale pidfile detected (PID belongs to another process) — cleaning up', {
      pid: existingPid,
    });
    cleanupPidfile();
    cleanupPortFile();
  }

  mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });

  const serverScript = resolveServerScript();
  if (serverScript === null) {
    throw new Error(
      'Cannot find nr-ai-mcp-server binary or dist/index.js. ' +
        'Ensure the package is built (npm run build) and/or installed globally.',
    );
  }

  if (opts?.foreground) {
    log(
      `Starting in foreground on port ${effectivePort}...\n` +
        `  ${process.execPath} ${serverScript} --local\n` +
        `  Press Ctrl+C to stop.\n`,
    );
    try {
      execFileSync(process.execPath, [serverScript, '--local'], {
        stdio: 'inherit',
        env: sanitizeEnv({
          ...process.env,
          NR_AI_DASHBOARD_PORT: String(effectivePort),
          NR_AI_MODE: 'local',
        }),
      });
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'status' in err) {
        process.exitCode = (err as { status: number }).status ?? 1;
      }
    }
    return;
  }

  // Spawn detached background process
  const logPath = getLogPath();
  const logFd = openSync(logPath, 'a', 0o600);

  const child = spawn(process.execPath, [serverScript, '--local'], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: sanitizeEnv({
      ...process.env,
      NR_AI_DASHBOARD_PORT: String(effectivePort),
      NR_AI_MODE: 'local',
    }),
  });

  closeSync(logFd);

  const pid = child.pid;
  if (pid === undefined) {
    throw new Error('Failed to spawn daemon process — no PID returned.');
  }

  const stateDir = dirname(getPidfilePath());
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(getPidfilePath(), String(pid), { mode: 0o600 });
  writeFileSync(getPortFilePath(), String(effectivePort), { mode: 0o600 });

  child.unref();

  const started = await pollHealth(effectivePort, HEALTH_TIMEOUT_MS);

  if (started) {
    log(
      `Daemon started (PID ${pid}) listening on http://127.0.0.1:${effectivePort}\n` +
        `  Logs: ${logPath}\n`,
    );
  } else {
    log(
      `Daemon spawned (PID ${pid}) but health endpoint not yet responding.\n` +
        `  It may still be starting. Check logs: ${logPath}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------

export async function stopDaemon(log?: (msg: string) => void): Promise<void> {
  const emit = log ?? (() => {});
  const pid = readPid();

  if (pid === null || !processAlive(pid)) {
    emit('Daemon is not running.\n');
    cleanupPidfile();
    cleanupPortFile();
    return;
  }

  if (!isOurProcess(pid)) {
    logger.warn('PID in pidfile does not appear to be nr-ai-observe — removing stale pidfile', {
      pid,
    });
    cleanupPidfile();
    cleanupPortFile();
    emit('Removed stale pidfile (process is not nr-ai-observe).\n');
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    emit('Daemon is not running (signal failed).\n');
    cleanupPidfile();
    cleanupPortFile();
    return;
  }

  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) {
      cleanupPidfile();
      cleanupPortFile();
      emit(`Daemon stopped (was PID ${pid}).\n`);
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  logger.warn('Daemon did not exit gracefully, sending SIGKILL', { pid });
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already dead between checks
  }

  await sleep(POLL_INTERVAL_MS);
  cleanupPidfile();
  cleanupPortFile();
  emit(`Daemon force-killed (was PID ${pid}).\n`);
}

// ---------------------------------------------------------------------------
// LaunchAgent management
// ---------------------------------------------------------------------------

export function installLaunchAgent(port?: number, log?: (msg: string) => void): void {
  if (process.platform !== 'darwin') {
    logger.info('LaunchAgent is macOS-only — skipping on this platform');
    return;
  }
  const emit = log ?? (() => {});
  const effectivePort = port ?? DEFAULT_PORT;
  const serverScript = resolveServerScript();
  if (serverScript === null) {
    throw new Error('Cannot find nr-ai-mcp-server entry point. Ensure the package is built.');
  }

  const plistContent = buildDaemonPlist(serverScript, effectivePort);

  mkdirSync(dirname(PLIST_PATH), { recursive: true, mode: 0o755 });

  if (existsSync(PLIST_PATH)) {
    try {
      execFileSync('launchctl', ['unload', PLIST_PATH], { stdio: 'pipe' });
    } catch {
      // Not loaded — fine.
    }
  }

  writeFileSync(PLIST_PATH, plistContent, { mode: 0o600 });

  try {
    execFileSync('launchctl', ['load', PLIST_PATH], { stdio: 'pipe' });
  } catch (err: unknown) {
    throw new Error(`launchctl load failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Persist the port so `status` can probe the right address without requiring
  // the caller to pass --port each time.
  const stateDir = dirname(getPidfilePath());
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(getPortFilePath(), String(effectivePort), { mode: 0o600 });
  } catch {
    // Non-fatal — status will fall back to DEFAULT_PORT.
  }

  emit(
    `LaunchAgent installed: ${PLIST_PATH}\n` +
      `  The daemon will start automatically on login and restart if it crashes.\n` +
      `  Port: ${effectivePort}\n`,
  );
}

export function removeLaunchAgent(log?: (msg: string) => void): void {
  if (process.platform !== 'darwin') return;
  const emit = log ?? (() => {});
  if (!existsSync(PLIST_PATH)) {
    emit('LaunchAgent not installed.\n');
    return;
  }

  try {
    execFileSync('launchctl', ['unload', PLIST_PATH], { stdio: 'pipe' });
  } catch {
    // Already unloaded — fine.
  }

  unlinkSync(PLIST_PATH);
  cleanupPortFile();
  emit(`LaunchAgent removed: ${PLIST_PATH}\n`);
}

export function isLaunchAgentInstalled(): boolean {
  return existsSync(PLIST_PATH);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function cleanupPidfile(): void {
  try {
    unlinkSync(getPidfilePath());
  } catch {
    // Best effort — file may already be gone.
  }
}

function cleanupPortFile(): void {
  try {
    unlinkSync(getPortFilePath());
  } catch {
    // Best effort — file may already be gone.
  }
}

function resolveServerScript(): string | null {
  // Strategy 1: Find the globally installed binary via PATH and resolve to its
  // actual entry point (the built dist/index.js).
  const binary = resolveBinaryPath();
  if (binary) {
    // The binary is a thin shell shim or symlink pointing to dist/index.js.
    // Try to resolve it to the real path.
    try {
      const realBin = realpathSync(binary);
      // If the resolved path ends with index.js, use it directly.
      if (realBin.endsWith('.js')) return realBin;
      // Otherwise, look for dist/index.js relative to the binary's package.
      const pkgDir = dirname(dirname(realBin));
      const candidate = resolve(pkgDir, 'dist', 'index.js');
      if (existsSync(candidate)) return candidate;
    } catch {
      // Fall through to next strategy.
    }
  }

  // Strategy 2: Resolve dist/index.js relative to the running script.
  // Uses process.argv[1] instead of import.meta.url to avoid Jest TS issues.
  // In the built output, this file lives at dist/install/daemon.js, so
  // dist/index.js is at ../index.js relative to this file.
  try {
    const scriptPath = realpathSync(process.argv[1] ?? '');
    const thisDir = dirname(scriptPath);
    const localCandidate = resolve(thisDir, '..', 'index.js');
    if (existsSync(localCandidate)) return localCandidate;
  } catch {
    // Fall through — process.argv[1] may be unavailable
  }

  // Strategy 3: Check common global install locations
  const globalCandidates = [
    resolve(homedir(), '.npm-global', 'lib', 'node_modules', 'nr-ai-observe', 'dist', 'index.js'),
    resolve('/usr', 'local', 'lib', 'node_modules', 'nr-ai-observe', 'dist', 'index.js'),
  ];
  for (const candidate of globalCandidates) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

interface HealthResponse {
  readonly ok: boolean;
  readonly uptime?: number; // seconds
}

async function fetchHealth(port: number): Promise<HealthResponse> {
  const url = `http://127.0.0.1:${port}/api/health`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (response.ok) {
      const body = (await response.json()) as Record<string, unknown>;
      // /api/health returns uptime in milliseconds; convert to seconds.
      const uptime = typeof body.uptime === 'number' ? body.uptime / 1000 : undefined;
      return { ok: true, uptime };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

export async function pollHealth(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fetchHealth(port);
    if (result.ok) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildDaemonPlist(serverScript: string, port: number): string {
  const logPath = getLogPath();
  const nodePath = process.execPath;
  const envPath = process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(serverScript)}</string>
    <string>--local</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(envPath)}</string>
    <key>NR_AI_DASHBOARD_PORT</key>
    <string>${port}</string>
    <key>NR_AI_MODE</key>
    <string>local</string>
  </dict>
</dict>
</plist>`;
}
