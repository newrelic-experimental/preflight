/**
 * CLI handlers for `preflight install` and `preflight uninstall`.
 *
 * Dynamically imported from collector-script.ts when argv[2] is install/uninstall,
 * so commander and other heavy deps are never loaded on the hot hook path.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, copyFileSync, realpathSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { Command } from 'commander';

import { createLogger } from '../shared/index.js';
import {
  mergeSettings,
  removeSettings,
  mergeMcpConfig,
  removeMcpConfig,
  detectSettingsPath,
  detectMcpConfigPath,
  generateNrConfig,
} from './install-helper.js';
import { isWsl, resolveWindowsHome } from './platform.js';
import {
  validateConfigFile,
  DEFAULT_STORAGE_PATH,
  ConfigFileSchema,
  loadMcpConfig,
} from '../config.js';
import type { PlatformTarget } from '../config.js';
import { migrateStoragePath } from './migrate.js';
import {
  installSchedule,
  removeSchedule,
  getScheduleStatus,
  installDashboardDaemon,
  removeDashboardDaemon,
  getDashboardDaemonStatus,
  resolveBinaryPath,
} from './schedule.js';
import { readJsonFileStrict, writeJsonFile, errMsg } from './json-utils.js';
import { LocalStore } from '../storage/index.js';

const logger = createLogger('cli');

const NR_CONFIG_PATH = resolve(DEFAULT_STORAGE_PATH, 'config.json');

// ---------------------------------------------------------------------------
// Platform persistence helpers — read/write platformTarget in config.json
// ---------------------------------------------------------------------------

function parsePlatformTarget(value: unknown): PlatformTarget | null {
  const result = ConfigFileSchema.shape.platformTarget.safeParse(value);
  return result.success && result.data !== undefined ? result.data : null;
}

function clearSavedPlatform(): void {
  try {
    if (!existsSync(NR_CONFIG_PATH)) return;
    const { platformTarget: _pt, ...rest } = readJsonFileStrict(NR_CONFIG_PATH);
    writeJsonFile(NR_CONFIG_PATH, rest, DEFAULT_STORAGE_PATH);
  } catch (err) {
    eprint(`\n⚠ Could not clear saved platform target: ${errMsg(err)}`);
    eprint(
      '  The next install may use the stale platform target. Fix the issue and re-run uninstall.',
    );
  }
}

// ---------------------------------------------------------------------------
// Platform resolution — single function, single place for all errors
// ---------------------------------------------------------------------------

function resolvePlatform(
  options: { windowsCc?: boolean; linuxCc?: boolean },
  savedPlatform: PlatformTarget | null,
): {
  platform: PlatformTarget;
  windowsHome: string | null;
} {
  if (options.windowsCc && options.linuxCc) {
    print('\n  ⚠ --windows-cc and --linux-cc are mutually exclusive. Pass only one.');
    process.exit(1);
  }
  if (options.windowsCc) {
    if (!isWsl()) {
      print('\n  ⚠ --windows-cc only works inside WSL — this machine is not running WSL.');
      print('  Run without --windows-cc to install normally.');
      process.exit(1);
    }
    const windowsHome = resolveWindowsHome();
    if (!windowsHome) {
      print('\n  ⚠ --windows-cc: Windows home directory could not be resolved.');
      print('  Check that WSL interop is enabled:');
      print('    wsl.exe --status');
      process.exit(1);
    }
    return { platform: 'wsl-windows-cc', windowsHome };
  }
  if (options.linuxCc) {
    if (!isWsl()) {
      print('\n  ⚠ --linux-cc only works inside WSL — this machine is not running WSL.');
      print('  Run without --linux-cc to install normally.');
      process.exit(1);
    }
    return { platform: 'wsl-linux-cc', windowsHome: null };
  }

  if (!isWsl()) return { platform: 'native', windowsHome: null };

  // WSL auto-detect: use the savedPlatform already read by handleInstall.
  // 'native' is excluded — it was written on a non-WSL machine and must not
  // suppress WSL-mode guidance or the --windows-cc hint below.
  if (savedPlatform && savedPlatform !== 'native') {
    if (savedPlatform === 'wsl-windows-cc') {
      const windowsHome = resolveWindowsHome();
      if (!windowsHome) {
        print(
          '\n  ⚠ Saved install target is Windows Claude Code but Windows home could not be resolved.',
        );
        print('  WSL interop may be disabled. Re-run with --windows-cc when interop is restored,');
        print('  or use --linux-cc to switch to Linux Claude Code mode permanently.');
        process.exit(1);
      }
      return { platform: 'wsl-windows-cc', windowsHome };
    }
    return { platform: savedPlatform, windowsHome: null };
  }

  // WSL: no prior state — default to Linux CC, inform user about the Windows option.
  print('\n  ℹ WSL detected with no prior install state. Defaulting to Linux Claude Code mode.');
  print('  If you are using the Windows Claude Code desktop app, re-run with --windows-cc:');
  print('    preflight install --windows-cc');
  return { platform: 'wsl-linux-cc', windowsHome: null };
}

function resolveInstallPaths(
  _platform: PlatformTarget,
  scope: 'user' | 'project',
  windowsHome: string | null,
): { settingsPath: string; mcpPath: string; allowedBase: string | undefined } {
  return {
    settingsPath: detectSettingsPath(scope, windowsHome),
    mcpPath: detectMcpConfigPath(scope, windowsHome),
    allowedBase: windowsHome ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// print helper
// ---------------------------------------------------------------------------

function print(msg = ''): void {
  process.stdout.write(msg + '\n');
}

function eprint(msg = ''): void {
  process.stderr.write(msg + '\n');
}

// ---------------------------------------------------------------------------
// PATH verification
// ---------------------------------------------------------------------------

export function verifyBinaryOnPath(): boolean {
  return resolveBinaryPath() !== null;
}

function printPathWarning(): void {
  print('\n⚠ preflight is not on your PATH.');
  print('  Claude Code hooks will fail with "command not found" until this is resolved.');
  print('  Fix: run `npm link` in the project directory, or install globally:');
  print('    npm install -g @newrelic/preflight');
  print('');
}

// ---------------------------------------------------------------------------
// Repo root discovery (for update command and setup wizard)
// ---------------------------------------------------------------------------

export function findRepoRoot(): string | null {
  try {
    let dir = dirname(realpathSync(process.argv[1]));
    while (true) {
      if (existsSync(join(dir, 'package.json'))) return dir;
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Update handler
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Liveness probe via signal 0 — mirrors `isPidAlive()` in
 * `src/storage/local-store.ts`. Duplicated rather than shared: it's ten
 * lines and the two files don't otherwise depend on each other.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Kill the given PID: SIGTERM, escalating to SIGKILL after a 2s grace period
 * if it hasn't exited (Windows terminates immediately on any signal, so the
 * grace period is a no-op there). Tolerates the process having already
 * exited between the caller's liveness check and this call (ESRCH).
 */
async function killProcessGracefully(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
  }
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await sleep(100);
  }
  if (isProcessAlive(pid)) {
    process.kill(pid, 'SIGKILL');
  }
}

/**
 * Kill the given process, then respawn it detached with its original
 * argv/cwd so it comes back up exactly as it was invoked.
 */
async function killAndRespawnLocalDashboard(proc: {
  pid: number;
  argv: string[];
  cwd: string;
}): Promise<void> {
  await killProcessGracefully(proc.pid);
  spawn(process.execPath, proc.argv, { cwd: proc.cwd, detached: true, stdio: 'ignore' }).unref();
}

/**
 * Reads the `version` field from `<repoRoot>/package.json` fresh off disk —
 * i.e. the version that was JUST built by the `npm run build` above, not the
 * one baked into this already-running process (this process's own `VERSION`
 * constant was captured at startup, before `git pull` ran, so it can't be
 * used here). Returns null on any read/parse failure, or if the field isn't
 * a string.
 */
function readLocalPackageVersion(repoRoot: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf-8')) as {
      version?: unknown;
    };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * Resolves the dashboard's configured host/port, or null if the config
 * can't be loaded (e.g. a cloud-mode config missing credentials). Callers
 * treat null as "skip verification" rather than a hard failure — restart
 * verification is a best-effort enhancement, never a new way for `update`
 * to fail.
 */
function getDashboardAddress(): { host: string; port: number } | null {
  try {
    const config = loadMcpConfig();
    return { host: config.dashboard.host, port: config.dashboard.port };
  } catch {
    return null;
  }
}

/**
 * Polls `GET /api/health` until it reports a healthy, current-version
 * response or `timeoutMs` elapses. Connection errors (server not listening
 * yet) and malformed responses are treated as "not yet" and retried, not as
 * failures. When `expectedVersion` is null, the version check is skipped —
 * any healthy response counts.
 */
async function waitForHealthyDashboard(
  host: string,
  port: number,
  expectedVersion: string | null,
  timeoutMs = 5000,
  intervalMs = 300,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://${host}:${port}/api/health`);
      if (res.ok) {
        const body = (await res.json()) as { ok?: unknown; version?: unknown };
        if (body.ok === true && (expectedVersion === null || body.version === expectedVersion)) {
          return true;
        }
      }
    } catch {
      // Not listening yet, or a malformed response — keep polling.
    }
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

/**
 * Shared verification glue for both restart paths. If the dashboard's
 * address can't be determined, verification is skipped silently and
 * `successMsg` is printed as before (today's behavior, preserved as a
 * fallback). Otherwise polls for a healthy, current-version response and
 * prints `successMsg`/`failMsg` accordingly.
 *
 * @returns true if the caller should stop here (verified, or skipped);
 *   false if verification explicitly failed and the caller should fall
 *   through to another restart path.
 */
async function verifyRestart(
  repoRoot: string,
  successMsg: string,
  failMsg: string,
): Promise<boolean> {
  const address = getDashboardAddress();
  if (!address) {
    print(successMsg);
    return true;
  }
  const expectedVersion = readLocalPackageVersion(repoRoot);
  const healthy = await waitForHealthyDashboard(address.host, address.port, expectedVersion);
  print(healthy ? successMsg : failMsg);
  return healthy;
}

/**
 * Called at the end of a successful `preflight update` build. Handles the
 * two restart-able cases (daemon and ad-hoc `--local`); `--stdio` (Claude
 * Code MCP sessions) is intentionally never touched here — killing one
 * mid-session would break in-flight tool calls, so it keeps the existing
 * static "Restart Claude Code" message printed unconditionally by the
 * caller.
 */
async function offerRestarts(repoRoot: string): Promise<void> {
  const daemonStatus = getDashboardDaemonStatus();
  let daemonHandled = false;
  if (daemonStatus.installed) {
    if (daemonStatus.readable && daemonStatus.binaryPath) {
      try {
        installDashboardDaemon(daemonStatus.binaryPath);
        daemonHandled = await verifyRestart(
          repoRoot,
          '\n✓ Restarted the dashboard daemon (launchctl unload/load).',
          '\n⚠ Dashboard daemon restarted but could not be verified as healthy — it may still be starting up, or may have failed silently. Check `launchctl list | grep com.preflight.dashboard` and `~/.newrelic-preflight/dashboard.log`.',
        );
      } catch (err) {
        print(`\n⚠ Could not restart the dashboard daemon: ${errMsg(err)}`);
        print(
          '  Run `launchctl unload`/`load` on it manually, or `preflight setup` to reinstall it.',
        );
      }
    } else {
      print('\n⚠ Dashboard daemon plist found but unreadable; restart it manually if needed.');
    }
    if (daemonHandled) return;
    print('\n  Checking for another running dashboard process instead...');
  }

  const localStore = new LocalStore(DEFAULT_STORAGE_PATH);
  const proc = localStore.getLiveLocalDashboardProcess();
  if (!proc) return;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let answer: string;
  try {
    answer = (await rl.question(`\nRestart the running dashboard (PID ${proc.pid})? [Y/n]: `))
      .trim()
      .toLowerCase();
  } finally {
    rl.close();
  }
  if (answer === 'n' || answer === 'no') return;

  try {
    await killAndRespawnLocalDashboard(proc);
    await verifyRestart(
      repoRoot,
      '✓ Dashboard restarted.',
      '⚠ Dashboard process respawned but could not be verified as healthy — check manually.',
    );
  } catch (err) {
    print(`⚠ Could not restart the dashboard automatically: ${errMsg(err)}`);
    print('  Run `preflight --local` to restart it manually.');
  }
}

function formatAge(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return `${totalHours}h`;
  const totalDays = Math.floor(totalHours / 24);
  return `${totalDays}d`;
}

/**
 * `preflight local` — lists every `--local` process preflight has
 * registered (see `LocalStore.registerLocalInstance()`), marking whichever
 * one currently owns the dashboard port. `--clean` additionally offers to
 * kill every live, non-owning entry (a single combined prompt, default
 * yes) — these are processes that lost the dashboard port race and have
 * been running headless ever since, with no other way to detect them
 * short of scanning the OS process table, which this feature deliberately
 * avoids.
 */
async function handleLocal(options: { clean?: boolean }): Promise<void> {
  const localStore = new LocalStore(DEFAULT_STORAGE_PATH);
  const deleted = localStore.gcDeadLocalInstances();
  if (deleted > 0) {
    print(`Cleaned up ${deleted} stale registry entr${deleted > 1 ? 'ies' : 'y'}.`);
    print();
  }

  const owner = localStore.getLiveLocalDashboardProcess();
  const instances = localStore.listLocalInstances().filter((i) => i.alive);

  if (instances.length === 0) {
    print('No --local processes running.');
    return;
  }

  print(`${instances.length} --local process(es) running:`);
  print();
  for (const inst of instances) {
    const status = inst.pid === owner?.pid ? 'dashboard owner' : 'idle';
    print(
      `  PID ${inst.pid}  (${status}, started ${formatAge(Date.now() - inst.startedAt)} ago)  ${inst.cwd}`,
    );
  }

  if (!options.clean) return;

  const orphans = instances.filter((i) => i.pid !== owner?.pid);
  if (orphans.length === 0) {
    print('\nNo orphaned processes to clean up.');
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let answer: string;
  try {
    answer = (
      await rl.question(
        `\nKill ${orphans.length} orphaned process${orphans.length > 1 ? 'es' : ''}? [Y/n]: `,
      )
    )
      .trim()
      .toLowerCase();
  } finally {
    rl.close();
  }
  if (answer === 'n' || answer === 'no') return;

  for (const orphan of orphans) {
    try {
      await killProcessGracefully(orphan.pid);
      localStore.unregisterLocalInstance(orphan.pid);
      print(`✓ Killed PID ${orphan.pid}.`);
    } catch (err) {
      print(`⚠ Could not kill PID ${orphan.pid}: ${errMsg(err)}`);
    }
  }
}

async function handleUpdate(): Promise<void> {
  migrateStoragePath();
  const repoRoot = findRepoRoot();
  if (!repoRoot) {
    print(
      '✗ Could not locate the repo root. Run this command from within the cloned repo or after npm link.',
    );
    process.exit(1);
  }

  let gitRoot!: string;
  try {
    gitRoot = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--show-toplevel'], {
      stdio: 'pipe',
      env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined },
    })
      .toString()
      .trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      print('✗ git is not installed or not found on PATH.');
      print('  Install git (https://git-scm.com) then retry: preflight update');
    } else {
      print('✗ preflight was installed via a package manager, not cloned from source.');
      print('  (If your .git directory is missing or corrupt, re-clone the repo instead.)');
      print('  To update, reinstall using your package manager, e.g.:');
      print('    npm install -g @newrelic/preflight@latest');
      print('    pnpm add -g @newrelic/preflight@latest');
    }
    process.exit(1);
  }
  // If repoRoot sits below a node_modules directory within the git tree,
  // preflight is installed as a dependency — not a source clone.
  // path.relative() normalises separators on all platforms (robust on Windows).
  if (relative(gitRoot, repoRoot).split(sep).includes('node_modules')) {
    print('✗ preflight was installed via a package manager, not cloned from source.');
    print('  To update, reinstall using your package manager, e.g.:');
    print('    npm install -g @newrelic/preflight@latest');
    print('    pnpm add -g @newrelic/preflight@latest');
    process.exit(1);
  }

  print(`Updating Preflight from ${repoRoot}...\n`);

  try {
    print('→ git pull');
    execFileSync('git', ['pull'], { cwd: repoRoot, stdio: 'inherit' });
  } catch {
    print('\n✗ git pull failed. Check the output above for details.');
    print('  If the output shows diverged branches and you have no local commits to keep,');
    print('  you can reset to the remote HEAD (replace <branch> with your default branch):');
    print(`    git -C "${repoRoot}" fetch origin`);
    print(`    git -C "${repoRoot}" reset --hard origin/<branch>`);
    print('  WARNING: reset --hard permanently discards any local commits not yet on origin.');
    process.exit(1);
  }

  try {
    print('\n→ npm run build');
    execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'inherit' });
    print('\n✓ Update complete.');
    print('  Restart Claude Code to pick up the new version.');
    print('  Run `preflight install` to update the MCP server key in ~/.mcp.json.');
  } catch {
    print('\n✗ Build failed. Check the output above for details.');
    process.exit(1);
  }

  try {
    await offerRestarts(repoRoot);
  } catch (err) {
    print(`\n⚠ Restart offer failed unexpectedly: ${errMsg(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Schedule handler
// ---------------------------------------------------------------------------

function handleSchedule(options: { time?: string; disable?: boolean }): void {
  if (process.platform !== 'darwin') {
    print('Auto-update scheduling is only supported on macOS.');
    process.exit(1);
  }

  if (options.disable) {
    try {
      const removed = removeSchedule();
      print(removed ? '✓ Auto-update schedule removed.' : 'No schedule was installed.');
    } catch (err) {
      eprint(`⚠ Could not remove schedule: ${errMsg(err)}`);
      process.exitCode = 1;
    }
    return;
  }

  if (options.time !== undefined) {
    const match = options.time.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) {
      print(`Invalid time format "${options.time}". Use HH:MM (e.g. 08:00).`);
      process.exit(1);
    }
    const hour = parseInt(match[1], 10);
    const minute = parseInt(match[2], 10);
    if (hour > 23 || minute > 59) {
      print(`Invalid time "${options.time}": hour must be 0–23, minute 0–59.`);
      process.exit(1);
    }
    const binaryPath = resolveBinaryPath();
    if (!binaryPath) {
      print('✗ preflight not found on PATH. Fix PATH then run: preflight schedule --time HH:MM');
      process.exit(1);
    }
    installSchedule(binaryPath, hour, minute);
    const hh = String(hour).padStart(2, '0');
    const mm = String(minute).padStart(2, '0');
    print(`✓ Daily auto-update scheduled for ${hh}:${mm}.`);
    print(`  Log: ${homedir()}/.newrelic-preflight/update.log`);
    return;
  }

  // No flags — show status.
  const status = getScheduleStatus();
  if (status.installed) {
    if (status.readable === false) {
      print(
        'Auto-update schedule: installed (plist unreadable — reinstall with: preflight schedule --time HH:MM)',
      );
    } else {
      const hh = String(status.hour ?? 0).padStart(2, '0');
      const mm = String(status.minute ?? 0).padStart(2, '0');
      print(`Auto-update schedule: ${hh}:${mm} daily`);
      print(`  Binary: ${status.binaryPath ?? 'unknown'}`);
    }
    print('  To change: preflight schedule --time HH:MM');
    print('  To remove: preflight schedule --disable');
  } else {
    print('No auto-update schedule installed.');
    print('  To enable: preflight schedule --time 08:00');
  }
}

// ---------------------------------------------------------------------------
// Install handler
// ---------------------------------------------------------------------------

function handleInstall(options: {
  licenseKey?: string;
  accountId?: string;
  project?: boolean;
  windowsCc?: boolean;
  linuxCc?: boolean;
}): void {
  migrateStoragePath(true);
  const scope = options.project ? 'project' : 'user';
  const binPath = resolveBinaryPath();
  const credentialsProvided = !!(options.licenseKey && options.accountId);
  const inWsl = isWsl();

  // Read config.json once. Serves two purposes:
  // (a) extract savedPlatform for resolvePlatform (needed on WSL auto-detect)
  // (b) preserve existing fields when writing back platformTarget + credentials
  // Fatal conditions: SyntaxError (can't safely write back to corrupt JSON),
  // WSL without explicit platform flag + any IO error (EACCES/EPERM could mask a
  //   saved wsl-windows-cc platform — explicit flags make savedPlatform irrelevant),
  // credentials provided + any IO error (can't preserve without knowing existing state).
  const explicitPlatform = !!(options.windowsCc || options.linuxCc);
  let existingNrConfig: Record<string, unknown> = {};
  let skipNrConfigWrite = false;
  try {
    // readJsonFileStrict returns {} on ENOENT; throws on IO errors or malformed JSON.
    existingNrConfig = readJsonFileStrict(NR_CONFIG_PATH);
  } catch (err) {
    const isSyntaxError = err instanceof SyntaxError;
    if (isSyntaxError || (inWsl && !explicitPlatform) || credentialsProvided) {
      eprint(`\n✗ Cannot read existing NR config to determine install target: ${errMsg(err)}`);
      eprint(
        isSyntaxError
          ? '  config.json contains invalid JSON — fix or delete it, then re-run install.'
          : '  Fix file permissions then re-run install.',
      );
      throw err;
    }
    eprint(`\n⚠ Could not read existing NR config to persist platform target: ${errMsg(err)}`);
    eprint('  Platform target not persisted — hook installation will continue. Re-run to save it.');
    skipNrConfigWrite = true;
  }

  const savedPlatform = parsePlatformTarget(existingNrConfig.platformTarget);
  const { platform, windowsHome } = resolvePlatform(options, savedPlatform);
  const { settingsPath, mcpPath, allowedBase } = resolveInstallPaths(platform, scope, windowsHome);

  let mergedSettings: ReturnType<typeof mergeSettings>;
  let mergedMcp: ReturnType<typeof mergeMcpConfig>;
  try {
    mergedSettings = mergeSettings(readJsonFileStrict(settingsPath), binPath, { platform });
    mergedMcp = mergeMcpConfig(readJsonFileStrict(mcpPath), binPath, { platform });
  } catch (err) {
    eprint(`\n✗ Failed to prepare config: ${errMsg(err)}`);
    throw err;
  }

  try {
    writeJsonFile(settingsPath, mergedSettings, allowedBase);
  } catch (err) {
    eprint(`\n✗ Failed to write hooks config (${settingsPath}): ${errMsg(err)}`);
    throw err;
  }
  try {
    writeJsonFile(mcpPath, mergedMcp, allowedBase);
  } catch (err) {
    eprint(`\n✗ Failed to write MCP config (${mcpPath}): ${errMsg(err)}`);
    throw err;
  }

  // Persist platformTarget (and credentials if provided) — only after both hook files written.
  let nrConfigWritten = false;
  if (!skipNrConfigWrite) {
    try {
      const nrConfig: Record<string, unknown> = { ...existingNrConfig, platformTarget: platform };
      if (credentialsProvided) {
        Object.assign(
          nrConfig,
          generateNrConfig(options.licenseKey as string, options.accountId as string),
        );
      }
      writeJsonFile(NR_CONFIG_PATH, nrConfig, DEFAULT_STORAGE_PATH);
      nrConfigWritten = credentialsProvided;
    } catch (err) {
      if (credentialsProvided) {
        eprint(`\n✗ Failed to save New Relic config: ${errMsg(err)}`);
        throw err;
      }
      eprint(`\n⚠ Could not persist platform target: ${errMsg(err)}`);
      eprint('  The next install will re-detect the target platform from scratch.');
    }
  }

  if (platform === 'wsl-windows-cc') {
    print('\n  ℹ Configured for Windows Claude Code (desktop app).');
    print(`  Hooks written to: ${settingsPath}`);
    print(`  MCP config written to: ${mcpPath}`);
    print('  Hook commands use wsl.exe -e so Windows Claude Code can invoke them.');
    print('  To switch to Linux Claude Code mode, re-run with --linux-cc:');
    print('    preflight install --linux-cc');
  } else if (platform === 'wsl-linux-cc') {
    print('\n  ℹ Configured for Linux Claude Code (npm in WSL).');
    print(`  Hooks written to: ${settingsPath}`);
    print('  To switch to Windows Claude Code mode, re-run with --windows-cc:');
    print('    preflight install --windows-cc');
  }

  print(`\n✓ Claude Code hooks updated: ${settingsPath}`);
  print('  - Added PreToolUse and PostToolUse hooks');
  print(`✓ MCP server registered: ${mcpPath}`);
  print('  - Added preflight MCP server');

  if (nrConfigWritten) {
    print(`\n✓ New Relic config written: ${NR_CONFIG_PATH}`);
  } else if (!credentialsProvided && (options.licenseKey || options.accountId)) {
    print('\n⚠ Both --license-key and --account-id are required to save NR config. Skipped.');
  }

  if (binPath !== null) {
    print('\n✓ preflight is on your PATH');
  } else {
    printPathWarning();
  }

  print('\nNext steps:');
  print('  1. Restart Claude Code');
  print('  2. Verify: ask Claude Code to call nr_observe_get_session_stats');
  print('');
  print('  Tip: if the MCP server fails to connect, run:');
  print('    preflight validate');
  print('  to check your config file for typos or unsupported fields.');
}

// ---------------------------------------------------------------------------
// Uninstall helpers
// ---------------------------------------------------------------------------

// Resolves which settings and MCP config paths to clean based on platform
// flags and the saved install target. Calls process.exit(1) on invalid
// flag combinations or unresolvable state.
function resolveUninstallPaths(options: {
  project?: boolean;
  windowsCc?: boolean;
  linuxCc?: boolean;
}): {
  settingsPathsToClean: Map<string, string | undefined>;
  mcpPathsToClean: Map<string, string | undefined>;
} {
  const scope = options.project ? 'project' : 'user';

  if (options.windowsCc && options.linuxCc) {
    print('\n  ⚠ --windows-cc and --linux-cc are mutually exclusive. Pass only one.');
    process.exit(1);
  }
  if (options.windowsCc && !isWsl()) {
    print('\n  ⚠ --windows-cc only works inside WSL — this machine is not running WSL.');
    print('  Run without --windows-cc to uninstall normally.');
    process.exit(1);
  }
  if (options.linuxCc && !isWsl()) {
    print('\n  ⚠ --linux-cc only works inside WSL — this machine is not running WSL.');
    print('  Run without --linux-cc to uninstall normally.');
    process.exit(1);
  }

  const wslEnv = isWsl();
  const windowsHome = wslEnv ? resolveWindowsHome() : null;

  if (options.windowsCc && windowsHome === null) {
    print('\n  ⚠ --windows-cc: Windows home directory could not be resolved.');
    print('  Nothing to uninstall for Windows Claude Code.');
    process.exit(1);
  }

  // For bare uninstall (no flags), read the saved platform so we only clean the
  // paths that were actually written during the matching install. Users who never
  // ran preflight ≥1.0.4 have no saved platform, so fall back to cleaning both
  // paths as a migration safety net.
  // If config.json is unreadable, fall back to cleaning both paths — over-cleaning
  // is safe, under-cleaning is not.
  let savedPlatform: PlatformTarget | null = null;
  if (!options.windowsCc && !options.linuxCc) {
    try {
      const config = readJsonFileStrict(NR_CONFIG_PATH);
      savedPlatform = parsePlatformTarget(config.platformTarget);
    } catch {
      /* unreadable config — clean both paths */
    }
  }

  let includeWindows: boolean;
  let includeLinux: boolean;
  if (options.windowsCc) {
    includeWindows = true;
    includeLinux = false;
  } else if (options.linuxCc) {
    includeWindows = false;
    includeLinux = true;
  } else if (savedPlatform === 'wsl-windows-cc') {
    if (!wslEnv) {
      // Not in WSL — Windows CC paths from a prior WSL install are unreachable on this machine
      // (e.g. config copied to macOS/Linux). Clean Linux-side paths and clear the stale target.
      includeWindows = false;
      includeLinux = true;
    } else if (windowsHome === null) {
      // In WSL but interop unavailable — cannot reach Windows-side hooks without windowsHome.
      // Exit with an actionable message rather than silently cleaning nothing and clearing the
      // saved platform (which would make the next bare install forget the user's Windows CC intent).
      print(
        '\n  ⚠ Saved install target is Windows Claude Code but Windows home could not be resolved.',
      );
      print('  WSL interop may be disabled. To uninstall:');
      print('    Re-enable WSL interop, then re-run: preflight uninstall');
      print('    Or clean Linux-side hooks only:       preflight uninstall --linux-cc');
      process.exit(1);
    } else {
      // Also clean Linux-side hooks — the user may have previously run --linux-cc and then
      // switched to --windows-cc without uninstalling first. Linux paths are always reachable.
      includeWindows = true;
      includeLinux = true;
    }
  } else if (savedPlatform === 'wsl-linux-cc') {
    // Clean Linux hooks. Also clean Windows hooks if reachable — the user may have
    // previously run --windows-cc and then switched to --linux-cc without uninstalling first.
    if (windowsHome !== null) {
      print('\n  ℹ Also removing Windows-side hooks (leftover from a prior --windows-cc install).');
    }
    includeWindows = windowsHome !== null;
    includeLinux = true;
  } else if (savedPlatform === 'native') {
    includeWindows = false;
    includeLinux = true;
  } else {
    // No saved platform (pre-1.0.4 install): clean both paths as a safety net.
    includeWindows = windowsHome !== null;
    includeLinux = true;
  }

  // Map value is the allowedBase for writeJsonFile's symlink guard.
  const settingsPathsToClean = new Map<string, string | undefined>();
  const mcpPathsToClean = new Map<string, string | undefined>();

  if (includeWindows && windowsHome) {
    settingsPathsToClean.set(detectSettingsPath(scope, windowsHome), windowsHome);
    mcpPathsToClean.set(detectMcpConfigPath(scope, windowsHome), windowsHome);
  }
  if (includeLinux) {
    settingsPathsToClean.set(detectSettingsPath(scope, null), undefined);
    mcpPathsToClean.set(detectMcpConfigPath(scope, null), undefined);
  }

  return { settingsPathsToClean, mcpPathsToClean };
}

// One removal operation's outcome. Every uninstall step produces exactly one of
// these; the messaging block at the end reasons over the collection rather than
// a set of ad-hoc boolean flags.
type RemovalResult = {
  readonly label: string;
  readonly removed: boolean;
  readonly error: Error | null;
  // True when Claude Code must restart to pick up the change (hooks / MCP config).
  // False for schedule / daemon — launchd applies those immediately.
  readonly requiresRestart: boolean;
};

// Backs up a config file then writes the transformed result. Returns whether
// the write succeeded and any error encountered — never throws.
function backupAndWrite(
  path: string,
  allowedBase: string | undefined,
  transform: (data: Record<string, unknown>) => Record<string, unknown>,
  errorLabel: string,
): { written: boolean; error: Error | null } {
  const backup = `${path}.backup-${Date.now()}`;
  try {
    const data = readJsonFileStrict(path);
    copyFileSync(path, backup);
    print(`  Backup saved: ${backup}`);
    writeJsonFile(path, transform(data), allowedBase);
    return { written: true, error: null };
  } catch (err) {
    // If copyFileSync and writeJsonFile both succeeded the backup is no longer
    // needed (the write path handles it). If copyFileSync succeeded but
    // writeJsonFile failed, the backup is the user's only recovery copy —
    // preserve it. If readJsonFileStrict failed, no backup was created and the
    // original is untouched, so there is nothing to recover.
    const error = err instanceof Error ? err : new Error(String(err));
    eprint(`\n✗ Failed to clean ${errorLabel} (${path}): ${errMsg(err)}`);
    process.exitCode = 1;
    return { written: false, error };
  }
}

// Removes preflight hooks and MCP config entries from the given paths.
// Returns a RemovalResult — never throws. Partial completion is possible:
// removed=true even when error is non-null if at least one file succeeded.
function removeClaudeCodeConfig(
  settingsPathsToClean: Map<string, string | undefined>,
  mcpPathsToClean: Map<string, string | undefined>,
): RemovalResult {
  let removed = false;
  let firstError: Error | null = null;

  let hadSettingsFile = false;
  for (const [settingsPath, allowedBase] of settingsPathsToClean) {
    if (!existsSync(settingsPath)) continue;
    hadSettingsFile = true;
    const { written, error } = backupAndWrite(
      settingsPath,
      allowedBase,
      removeSettings,
      'hooks config',
    );
    if (written) {
      removed = true;
      print(`✓ Hooks removed: ${settingsPath}`);
    } else {
      firstError ??= error;
    }
  }
  if (!hadSettingsFile) {
    print(
      `No settings file found at ${[...settingsPathsToClean.keys()].join(', ')}. Skipping hooks.`,
    );
  }

  let hadMcpFile = false;
  for (const [mcpPath, allowedBase] of mcpPathsToClean) {
    if (!existsSync(mcpPath)) continue;
    hadMcpFile = true;
    const { written, error } = backupAndWrite(mcpPath, allowedBase, removeMcpConfig, 'MCP config');
    if (written) {
      removed = true;
      print(`✓ MCP server removed: ${mcpPath}`);
    } else {
      firstError ??= error;
    }
  }
  if (!hadMcpFile) {
    print(`No MCP config found at ${[...mcpPathsToClean.keys()].join(', ')}. Skipping MCP server.`);
  }

  return { label: 'Claude Code config', removed, error: firstError, requiresRestart: true };
}

// Runs a single uninstall step. Returns a RemovalResult — never throws.
// process.exitCode is set to 1 and a warning is printed on error.
function runStep(label: string, requiresRestart: boolean, fn: () => boolean): RemovalResult {
  try {
    const removed = fn();
    return { label, removed, error: null, requiresRestart };
  } catch (err) {
    process.exitCode = 1;
    const error = err instanceof Error ? err : new Error(String(err));
    logger.warn('uninstall step failed', { label, error });
    eprint(`⚠ Could not remove ${label}: ${error.message}`);
    return { label, removed: false, error, requiresRestart };
  }
}

// Prompts the user for uninstall confirmation. Returns one of four outcomes.
async function promptConfirm(
  yes: boolean,
): Promise<'confirmed' | 'declined' | 'non-interactive' | 'stdin-closed'> {
  if (yes) return 'confirmed';
  if (process.stdin.isTTY !== true) return 'non-interactive';
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question('Continue? [y/N]: ')).trim().toLowerCase();
    return answer === 'y' || answer === 'yes' ? 'confirmed' : 'declined';
  } catch {
    return 'stdin-closed';
  } finally {
    rl.close();
  }
}

// Handles a promptConfirm result: prints cancellation message and sets
// exitCode=1 on any non-confirmed outcome. Returns true only when confirmed.
function handleConfirm(
  result: 'confirmed' | 'declined' | 'non-interactive' | 'stdin-closed',
): boolean {
  if (result === 'confirmed') return true;
  const message =
    result === 'non-interactive'
      ? 'Uninstall cancelled (non-interactive stdin — rerun with --yes to confirm).'
      : result === 'stdin-closed'
        ? 'Uninstall cancelled (stdin closed).'
        : 'Uninstall cancelled.';
  print(message);
  process.exitCode = 1;
  return false;
}

// ---------------------------------------------------------------------------
// Uninstall handler
// ---------------------------------------------------------------------------

async function handleUninstall(options: {
  project?: boolean;
  windowsCc?: boolean;
  linuxCc?: boolean;
  daemon?: boolean;
  yes?: boolean;
}): Promise<void> {
  // --daemon: targeted removal of just the background dashboard daemon plist.
  // Does not touch hooks, MCP config, schedules, or session history.
  if (options.daemon) {
    if (options.project || options.windowsCc || options.linuxCc) {
      print('  ⚠ --daemon cannot be combined with --project, --windows-cc, or --linux-cc.');
      print('  Use bare `preflight uninstall` to remove hooks and the daemon together.');
      process.exit(1);
    }
    const daemonStatus = getDashboardDaemonStatus();
    if (!daemonStatus.installed) {
      print('No background dashboard daemon installed — nothing to remove.');
      return;
    }
    print('preflight uninstall --daemon will remove the background dashboard daemon.\n');
    if (!handleConfirm(await promptConfirm(options.yes ?? false))) return;

    const step = runStep('background dashboard daemon', false, () => removeDashboardDaemon());
    if (step.error !== null) {
      print('\nUninstall incomplete — see errors above.\n');
      return;
    }
    if (!step.removed) {
      process.exitCode = 1;
      print('Background dashboard daemon already absent — nothing to remove.');
      return;
    }
    print('✓ Background dashboard daemon removed.');
    print('  The dashboard is now only available while Claude Code is running.');
    print('  To reinstall, run: preflight setup');
    return;
  }

  const { settingsPathsToClean, mcpPathsToClean } = resolveUninstallPaths(options);

  // Build a human-readable summary of what will change, then ask for
  // confirmation before touching anything.
  const changeSummary: string[] = [];
  let hadConfigFiles = false;
  for (const settingsPath of settingsPathsToClean.keys()) {
    if (existsSync(settingsPath)) {
      changeSummary.push(`  • Remove hooks from ${settingsPath}`);
      hadConfigFiles = true;
    }
  }
  for (const mcpPath of mcpPathsToClean.keys()) {
    if (existsSync(mcpPath)) {
      changeSummary.push(`  • Remove MCP server from ${mcpPath}`);
      hadConfigFiles = true;
    }
  }
  const scheduleStatus = getScheduleStatus();
  const daemonStatus = getDashboardDaemonStatus();
  if (scheduleStatus.installed) {
    const action = scheduleStatus.readable
      ? 'Unload and delete'
      : 'Remove (plist unreadable — label removal)';
    changeSummary.push(`  • ${action} auto-update schedule`);
  }
  if (daemonStatus.installed) {
    const action = daemonStatus.readable
      ? 'Unload and delete'
      : 'Remove (plist unreadable — label removal)';
    changeSummary.push(`  • ${action} background dashboard daemon`);
  }

  if (changeSummary.length === 0) {
    print('Nothing installed — no changes to make.');
    return;
  }

  print('preflight uninstall will make the following changes:\n');
  for (const line of changeSummary) print(line);
  print('');
  print(`  Your session history and config at ${DEFAULT_STORAGE_PATH} will NOT be deleted.`);
  print('');

  if (!handleConfirm(await promptConfirm(options.yes ?? false))) return;

  print('');

  const configStep = removeClaudeCodeConfig(settingsPathsToClean, mcpPathsToClean);
  if (options.windowsCc) {
    print('  To reinstall Windows Claude Code mode, re-run: preflight install --windows-cc');
  }

  const scheduleStep = runStep('auto-update schedule', false, () => {
    const removed = removeSchedule();
    if (removed) print('✓ Auto-update schedule removed');
    else if (scheduleStatus.installed) {
      // Plist vanished between status-check and removal (TOCTOU). Throw so
      // runStep captures this as an error and anyFailed reflects it.
      throw new Error(
        'Auto-update schedule already absent — may have been removed by another process',
      );
    }
    return removed;
  });

  const daemonStep = runStep('background dashboard daemon', false, () => {
    const removed = removeDashboardDaemon();
    if (removed) print('✓ Background dashboard daemon removed');
    else if (daemonStatus.installed) {
      // Plist vanished between status-check and removal (TOCTOU). Throw so
      // runStep captures this as an error and anyFailed reflects it — without
      // this, process.exitCode=1 and the success message are contradictory.
      throw new Error(
        'Background dashboard daemon already absent — may have been removed by another process',
      );
    }
    return removed;
  });

  const steps = [configStep, scheduleStep, daemonStep];
  const anyRemoved = steps.some((s) => s.removed);
  const anyFailed = steps.some((s) => s.error !== null);
  const requiresRestart = steps.some((s) => s.removed && s.requiresRestart);

  // Clear the saved platform record when hooks/MCP config was removed (even if
  // schedule/daemon cleanup also failed — those are independent). Also clear on
  // schedule/daemon-only removal when config files existed on disk at status-check
  // time: absent config files mean hooks were never written (or already manually
  // deleted) and the platform record should be preserved for a re-install attempt.
  // Skip on --linux-cc (sibling wsl-windows-cc record may still be in use).
  const shouldClearPlatform = configStep.removed || (anyRemoved && !anyFailed && hadConfigFiles);
  if (!options.linuxCc && shouldClearPlatform) {
    clearSavedPlatform();
  }

  if (requiresRestart) {
    if (anyFailed) {
      print(
        '\nRestart Claude Code to apply hook changes. Uninstall incomplete — see errors above.\n',
      );
    } else {
      print('\nRestart Claude Code for changes to take effect.\n');
    }
  } else if (anyRemoved) {
    // Schedule/daemon only — launchd unloaded immediately; no restart needed.
    print(anyFailed ? '\nUninstall incomplete — see errors above.\n' : '\nUninstall complete.\n');
  } else if (anyFailed) {
    print('\nUninstall incomplete — see errors above.\n');
  }
}

// ---------------------------------------------------------------------------
// Validate handler
// ---------------------------------------------------------------------------

function handleValidate(options: { config?: string }): void {
  const configPath = options.config ?? resolve(DEFAULT_STORAGE_PATH, 'config.json');
  print(`Validating ${configPath}...`);
  print('');

  const result = validateConfigFile(configPath);

  if (!result.fileExists) {
    print('No config file found at this path — defaults will apply.');
    print("Run 'preflight setup' to create one.");
    return;
  }

  if (result.errors.length === 0 && result.warnings.length === 0) {
    print('✓ Config is valid — no issues found.');
    return;
  }

  for (const err of result.errors) {
    print(`✗ Error: ${err}`);
  }
  for (const warn of result.warnings) {
    print(`⚠ Warning: ${warn}`);
  }

  print('');
  const parts: string[] = [];
  if (result.errors.length > 0)
    parts.push(`${result.errors.length} error${result.errors.length > 1 ? 's' : ''}`);
  if (result.warnings.length > 0)
    parts.push(`${result.warnings.length} warning${result.warnings.length > 1 ? 's' : ''}`);

  if (result.errors.length > 0) {
    print(`${parts.join(', ')}. Config is invalid — the MCP server will not start.`);
    print('Fix the errors above, then restart Claude Code.');
    process.exitCode = 1;
  } else {
    print(`${parts.join(', ')}. Config will load, but the flagged fields are silently ignored.`);
    print('Check the warnings above for possible typos.');
  }
}

// ---------------------------------------------------------------------------
// Doctor handler
// ---------------------------------------------------------------------------

async function handleDoctor(options: { config?: string }): Promise<void> {
  const { runDiagnostics } = await import('./diagnostics.js');
  const configPath = options.config ?? resolve(DEFAULT_STORAGE_PATH, 'config.json');

  const storagePath = process.env.NEW_RELIC_AI_MCP_STORAGE_PATH ?? undefined;
  print('Running diagnostics...');
  const checks = await runDiagnostics({ configPath, storagePath });

  const ICON: Record<string, string> = { ok: '✓', warn: '⚠', fail: '✗', skip: '-' };
  const COL = 22;

  for (const c of checks) {
    const icon = ICON[c.status] ?? '?';
    print(`${icon} ${c.check.padEnd(COL)} ${c.detail}`);
    if (c.fix && (c.status === 'fail' || c.status === 'warn')) {
      print(`  ${' '.repeat(COL)}Fix: ${c.fix}`);
    }
  }

  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;

  print('');
  if (fails === 0 && warns === 0) {
    print('✓ All checks passed.');
    return;
  }

  const parts: string[] = [];
  if (fails > 0) parts.push(`${fails} failure${fails > 1 ? 's' : ''}`);
  if (warns > 0) parts.push(`${warns} warning${warns > 1 ? 's' : ''}`);
  print(`${parts.join(', ')} found. Run the fix commands above, then restart.`);

  process.exitCode = fails > 0 ? 1 : 2;
}

// ---------------------------------------------------------------------------
// CLI program
// ---------------------------------------------------------------------------

export function createInstallProgram(): Command {
  const program = new Command();
  program.name('preflight').description('New Relic AI observability for Claude Code');

  program
    .command('install')
    .description('Configure Claude Code hooks and MCP server for AI observability')
    .option('--license-key <key>', 'New Relic license key')
    .option('--account-id <id>', 'New Relic account ID')
    .option('--project', 'Write to project-level .claude/settings.json instead of user-level')
    .option('--windows-cc', 'Target Windows Claude Code (desktop app) when running inside WSL')
    .option('--linux-cc', 'Target Linux Claude Code (npm in WSL) when running inside WSL')
    .action(handleInstall);

  program
    .command('uninstall')
    .description('Remove preflight hooks and MCP server from Claude Code settings')
    .option('--project', 'Remove from project-level .claude/settings.json instead of user-level')
    .option('--windows-cc', 'Remove Windows Claude Code hooks only (WSL only)')
    .option('--linux-cc', 'Remove Linux Claude Code hooks only (WSL only)')
    .option(
      '--daemon',
      'Remove only the background dashboard daemon (preserves hooks, MCP config, and session history)',
    )
    .option('--yes', 'Skip the confirmation prompt (useful for scripts and CI)')
    .action(handleUninstall);

  program
    .command('setup')
    .description(
      'Interactive first-run setup: configure New Relic keys, install hooks, and deploy dashboards',
    )
    .action(async () => {
      try {
        const { runSetupWizard } = await import('./setup-wizard.js');
        await runSetupWizard();
      } catch (err) {
        print(`\n✗ Setup failed: ${errMsg(err)}`);
        process.exitCode = 1;
      }
    });

  program
    .command('validate')
    .description('Check the config file for unknown fields, type errors, and typos')
    .option('--config <path>', 'Path to config file (default: ~/.newrelic-preflight/config.json)')
    .action(handleValidate);

  program
    .command('doctor')
    .description('Check configuration, hooks, daemon, and connectivity for common setup problems')
    .option('--config <path>', 'Path to config file (default: ~/.newrelic-preflight/config.json)')
    .action(handleDoctor);

  program
    .command('update')
    .description('Pull the latest changes and rebuild (git pull + npm run build)')
    .action(handleUpdate);

  program
    .command('schedule')
    .description('Configure daily auto-updates via launchd (macOS only)')
    .option('--time <HH:MM>', 'Set the daily update time (24-hour format, e.g. 08:00)')
    .option('--disable', 'Remove the auto-update schedule')
    .action(handleSchedule);

  program
    .command('local')
    .description('List running --local dashboard processes and clean up orphaned ones')
    .option(
      '--clean',
      'Kill orphaned --local processes after listing them (prompts for confirmation)',
    )
    .action(handleLocal);

  return program;
}

export async function runInstallCli(argv: string[]): Promise<void> {
  const program = createInstallProgram();
  await program.parseAsync(['node', 'preflight', ...argv]);
}
