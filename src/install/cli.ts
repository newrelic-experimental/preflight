/**
 * CLI handlers for `preflight install` and `preflight uninstall`.
 *
 * Dynamically imported from collector-script.ts when argv[2] is install/uninstall,
 * so commander and other heavy deps are never loaded on the hot hook path.
 */

import { Command } from 'commander';
import { execSync, execFileSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  renameSync,
  unlinkSync,
  copyFileSync,
  realpathSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import {
  mergeSettings,
  removeSettings,
  mergeMcpConfig,
  removeMcpConfig,
  detectSettingsPath,
  detectMcpConfigPath,
  generateNrConfig,
} from './install-helper.js';
import { validateConfigFile, DEFAULT_STORAGE_PATH } from '../config.js';
import { migrateStoragePath } from './migrate.js';
import {
  installSchedule,
  removeSchedule,
  getScheduleStatus,
  removeDashboardDaemon,
  getDashboardDaemonStatus,
  resolveBinaryPath,
} from './schedule.js';

const NR_CONFIG_DIR = resolve(homedir(), '.newrelic-preflight');
const NR_CONFIG_PATH = resolve(NR_CONFIG_DIR, 'config.json');

function print(msg = ''): void {
  process.stdout.write(msg + '\n');
}

// ---------------------------------------------------------------------------
// File I/O helpers
// ---------------------------------------------------------------------------

function readJsonFile(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeJsonFile(path: string, data: Record<string, unknown>): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  // Symlink guard: verify both the resolved parent directory AND the resolved
  // target file path are under HOME or cwd. Checking only the directory misses
  // the case where the file itself (e.g. settings.json) is a symlink pointing
  // outside HOME (e.g. to /etc/cron.d/evil).
  const resolvedDir = realpathSync(dir);
  const resolvedPath = existsSync(path) ? realpathSync(path) : resolve(resolvedDir, basename(path));
  const home = homedir();
  const cwd = process.cwd();
  const check = (p: string) =>
    p === home || p.startsWith(home + sep) || p === cwd || p.startsWith(cwd + sep);
  if (!check(resolvedDir) || !check(resolvedPath)) {
    throw new Error(`Refusing to write outside HOME or project root: ${resolvedPath}`);
  }

  const tmp = path + '.tmp';
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, path);
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
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
// Repo root discovery (for update command)
// ---------------------------------------------------------------------------

function findRepoRoot(): string | null {
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
}): void {
  migrateStoragePath(true);
  const scope = options.project ? 'project' : 'user';

  // Resolve the full binary path at install time so hooks work in non-login
  // shells (e.g. /bin/sh) that don't inherit NVM/nix/Homebrew PATH entries.
  const binPath = resolveBinaryPath();

  // Hooks go in settings.json
  const settingsPath = detectSettingsPath(scope);
  let mergedSettings: ReturnType<typeof mergeSettings>;
  try {
    const existingSettings = readJsonFile(settingsPath);
    mergedSettings = mergeSettings(existingSettings, binPath);
  } catch (err) {
    console.error(
      `✗ Failed to update ${settingsPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
  writeJsonFile(settingsPath, mergedSettings);

  // MCP server goes in .mcp.json
  const mcpPath = detectMcpConfigPath(scope);
  let mergedMcp: ReturnType<typeof mergeMcpConfig>;
  try {
    const existingMcp = readJsonFile(mcpPath);
    mergedMcp = mergeMcpConfig(existingMcp, binPath);
  } catch (err) {
    console.error(
      `✗ Failed to update ${mcpPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
  writeJsonFile(mcpPath, mergedMcp);

  print(`\n✓ Claude Code hooks updated: ${settingsPath}`);
  print('  - Added PreToolUse and PostToolUse hooks');
  print(`✓ MCP server registered: ${mcpPath}`);
  print('  - Added preflight MCP server');

  if (options.licenseKey && options.accountId) {
    const config = generateNrConfig(options.licenseKey, options.accountId);
    writeJsonFile(NR_CONFIG_PATH, config as unknown as Record<string, unknown>);
    print(`\n✓ New Relic config written: ${NR_CONFIG_PATH}`);
  } else if (options.licenseKey || options.accountId) {
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

function handleUninstall(options: { project?: boolean }): void {
  const scope = options.project ? 'project' : 'user';

  // Remove hooks from settings.json
  const settingsPath = detectSettingsPath(scope);
  if (existsSync(settingsPath)) {
    const settingsBackup = `${settingsPath}.backup-${Date.now()}`;
    copyFileSync(settingsPath, settingsBackup);
    print(`\n  Backup saved: ${settingsBackup}`);
    const existingSettings = readJsonFile(settingsPath);
    const cleanedSettings = removeSettings(existingSettings);
    writeJsonFile(settingsPath, cleanedSettings);
    print(`✓ Hooks removed: ${settingsPath}`);
  } else {
    print(`\nNo settings file found at ${settingsPath}. Skipping hooks.`);
  }

  // Remove MCP server from .mcp.json
  const mcpPath = detectMcpConfigPath(scope);
  if (existsSync(mcpPath)) {
    const mcpBackup = `${mcpPath}.backup-${Date.now()}`;
    copyFileSync(mcpPath, mcpBackup);
    print(`  Backup saved: ${mcpBackup}`);
    const existingMcp = readJsonFile(mcpPath);
    const cleanedMcp = removeMcpConfig(existingMcp);

    // If .mcp.json is now empty (no mcpServers key or empty object), leave it minimal
    writeJsonFile(mcpPath, cleanedMcp);
    print(`✓ MCP server removed: ${mcpPath}`);
  } else {
    print(`No MCP config found at ${mcpPath}. Skipping MCP server.`);
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
    .action(handleInstall);

  program
    .command('uninstall')
    .description('Remove preflight hooks and MCP server from Claude Code settings')
    .option('--project', 'Remove from project-level .claude/settings.json instead of user-level')
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
