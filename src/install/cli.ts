/**
 * CLI handlers for `preflight install` and `preflight uninstall`.
 *
 * Dynamically imported from collector-script.ts when argv[2] is install/uninstall,
 * so commander and other heavy deps are never loaded on the hot hook path.
 */

import { execSync, execFileSync } from 'node:child_process';
import { existsSync, copyFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { Command } from 'commander';

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
import { validateConfigFile, DEFAULT_STORAGE_PATH, ConfigFileSchema } from '../config.js';
import type { PlatformTarget } from '../config.js';
import { migrateStoragePath } from './migrate.js';
import {
  installSchedule,
  removeSchedule,
  getScheduleStatus,
  removeDashboardDaemon,
  getDashboardDaemonStatus,
  resolveBinaryPath,
} from './schedule.js';
import { readJsonFileStrict, writeJsonFile } from './json-utils.js';

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
    eprint(
      `\n⚠ Could not clear saved platform target: ${err instanceof Error ? err.message : String(err)}`,
    );
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
  try {
    execSync('which preflight', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
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

function handleUpdate(): void {
  migrateStoragePath();
  const repoRoot = findRepoRoot();
  if (!repoRoot) {
    print(
      '✗ Could not locate the repo root. Run this command from within the cloned repo or after npm link.',
    );
    process.exit(1);
  }

  print(`Updating Preflight from ${repoRoot}...\n`);

  try {
    print('→ git pull');
    execFileSync('git', ['pull'], { cwd: repoRoot, stdio: 'inherit' });
    print('\n→ npm run build');
    execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'inherit' });
    print('\n✓ Update complete.');
    print('  Restart Claude Code to pick up the new version.');
    print('  Run `preflight install` to update the MCP server key in ~/.mcp.json.');
  } catch {
    print('\n✗ Update failed. Check the output above for details.');
    process.exit(1);
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
    const wasInstalled = getScheduleStatus().installed;
    removeSchedule();
    print(wasInstalled ? '✓ Auto-update schedule removed.' : 'No schedule was installed.');
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
    const hh = String(status.hour ?? 0).padStart(2, '0');
    const mm = String(status.minute ?? 0).padStart(2, '0');
    print(`Auto-update schedule: ${hh}:${mm} daily`);
    print(`  Binary: ${status.binaryPath ?? 'unknown'}`);
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
      eprint(
        `\n✗ Cannot read existing NR config to determine install target: ${err instanceof Error ? err.message : String(err)}`,
      );
      eprint(
        isSyntaxError
          ? '  config.json contains invalid JSON — fix or delete it, then re-run install.'
          : '  Fix file permissions then re-run install.',
      );
      throw err;
    }
    eprint(
      `\n⚠ Could not read existing NR config to persist platform target: ${err instanceof Error ? err.message : String(err)}`,
    );
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
    eprint(`\n✗ Failed to prepare config: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }

  try {
    writeJsonFile(settingsPath, mergedSettings, allowedBase);
  } catch (err) {
    eprint(
      `\n✗ Failed to write hooks config (${settingsPath}): ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
  try {
    writeJsonFile(mcpPath, mergedMcp, allowedBase);
  } catch (err) {
    eprint(
      `\n✗ Failed to write MCP config (${mcpPath}): ${err instanceof Error ? err.message : String(err)}`,
    );
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
        eprint(
          `\n✗ Failed to save New Relic config: ${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      }
      eprint(
        `\n⚠ Could not persist platform target: ${err instanceof Error ? err.message : String(err)}`,
      );
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
// Uninstall handler
// ---------------------------------------------------------------------------

function handleUninstall(options: {
  project?: boolean;
  windowsCc?: boolean;
  linuxCc?: boolean;
}): void {
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

  print('');

  let settingsFound = false;
  for (const [settingsPath, allowedBase] of settingsPathsToClean) {
    if (existsSync(settingsPath)) {
      const backup = `${settingsPath}.backup-${Date.now()}`;
      copyFileSync(settingsPath, backup);
      print(`  Backup saved: ${backup}`);
      try {
        writeJsonFile(settingsPath, removeSettings(readJsonFileStrict(settingsPath)), allowedBase);
      } catch (err) {
        eprint(
          `\n✗ Failed to clean hooks config (${settingsPath}): ${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      }
      settingsFound = true;
      print(`✓ Hooks removed: ${settingsPath}`);
    }
  }
  if (!settingsFound) {
    print(
      `No settings file found at ${[...settingsPathsToClean.keys()].join(', ')}. Skipping hooks.`,
    );
  }

  let mcpFound = false;
  for (const [mcpPath, allowedBase] of mcpPathsToClean) {
    if (existsSync(mcpPath)) {
      const backup = `${mcpPath}.backup-${Date.now()}`;
      copyFileSync(mcpPath, backup);
      print(`  Backup saved: ${backup}`);
      try {
        writeJsonFile(mcpPath, removeMcpConfig(readJsonFileStrict(mcpPath)), allowedBase);
      } catch (err) {
        eprint(
          `\n✗ Failed to clean MCP config (${mcpPath}): ${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      }
      mcpFound = true;
      print(`✓ MCP server removed: ${mcpPath}`);
    }
  }
  if (!mcpFound) {
    print(`No MCP config found at ${[...mcpPathsToClean.keys()].join(', ')}. Skipping MCP server.`);
  }

  // Update persisted platform after cleanup.
  // --windows-cc or bare: clear savedPlatform so the next install re-detects from scratch.
  //   After --windows-cc uninstall, the user must pass --windows-cc again to reinstall
  //   Windows CC mode — re-detection has no heuristic for Windows CC intent.
  // --linux-cc: leave savedPlatform untouched — this only cleans Linux-side paths and must
  //   not destroy a wsl-windows-cc record that the user still intends to use.
  if (options.windowsCc) {
    print('  To reinstall Windows Claude Code mode, re-run: preflight install --windows-cc');
  }
  if (!options.linuxCc) {
    clearSavedPlatform();
  }

  print('\nRestart Claude Code for changes to take effect.\n');

  const scheduleWasInstalled = getScheduleStatus().installed;
  removeSchedule();
  if (scheduleWasInstalled) print('✓ Auto-update schedule removed');

  const daemonWasInstalled = getDashboardDaemonStatus().installed;
  removeDashboardDaemon();
  if (daemonWasInstalled) print('✓ Background dashboard daemon removed');
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
        print(`\n✗ Setup failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  program
    .command('validate')
    .description('Check the config file for unknown fields, type errors, and typos')
    .option('--config <path>', 'Path to config file (default: ~/.newrelic-preflight/config.json)')
    .action(handleValidate);

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

  return program;
}

export async function runInstallCli(argv: string[]): Promise<void> {
  const program = createInstallProgram();
  await program.parseAsync(['node', 'preflight', ...argv]);
}
