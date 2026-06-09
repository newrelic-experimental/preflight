/**
 * CLI handlers for `nr-ai-observe install` and `nr-ai-observe uninstall`.
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
import {
  installSchedule,
  removeSchedule,
  getScheduleStatus,
  resolveBinaryPath,
} from './schedule.js';

const NR_CONFIG_DIR = resolve(homedir(), '.nr-ai-observe');
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
    execSync('which nr-ai-observe', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function printPathWarning(): void {
  print('\n⚠ nr-ai-observe is not on your PATH.');
  print('  Claude Code hooks will fail with "command not found" until this is resolved.');
  print('  Fix: run `npm link` in the project directory, or install globally:');
  print('    npm install -g nr-ai-mcp-server');
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
  const repoRoot = findRepoRoot();
  if (!repoRoot) {
    print(
      '✗ Could not locate the repo root. Run this command from within the cloned repo or after npm link.',
    );
    process.exit(1);
  }

  print(`Updating NR AI Coding Observability from ${repoRoot}...\n`);

  try {
    print('→ git pull');
    execFileSync('git', ['pull'], { cwd: repoRoot, stdio: 'inherit' });
    print('\n→ npm run build');
    execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'inherit' });
    print('\n✓ Update complete. Restart Claude Code to pick up the new version.');
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
      print(
        '✗ nr-ai-observe not found on PATH. Fix PATH then run: nr-ai-observe schedule --time HH:MM',
      );
      process.exit(1);
    }
    installSchedule(binaryPath, hour, minute);
    const hh = String(hour).padStart(2, '0');
    const mm = String(minute).padStart(2, '0');
    print(`✓ Daily auto-update scheduled for ${hh}:${mm}.`);
    print(`  Log: ${homedir()}/.nr-ai-observe/update.log`);
    return;
  }

  // No flags — show status.
  const status = getScheduleStatus();
  if (status.installed) {
    const hh = String(status.hour ?? 0).padStart(2, '0');
    const mm = String(status.minute ?? 0).padStart(2, '0');
    print(`Auto-update schedule: ${hh}:${mm} daily`);
    print(`  Binary: ${status.binaryPath ?? 'unknown'}`);
    print('  To change: nr-ai-observe schedule --time HH:MM');
    print('  To remove: nr-ai-observe schedule --disable');
  } else {
    print('No auto-update schedule installed.');
    print('  To enable: nr-ai-observe schedule --time 08:00');
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
  const scope = options.project ? 'project' : 'user';

  // Hooks go in settings.json
  const settingsPath = detectSettingsPath(scope);
  let mergedSettings: ReturnType<typeof mergeSettings>;
  try {
    const existingSettings = readJsonFile(settingsPath);
    mergedSettings = mergeSettings(existingSettings);
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
    mergedMcp = mergeMcpConfig(existingMcp);
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
  print('  - Added nr-ai-observability MCP server');

  if (options.licenseKey && options.accountId) {
    const config = generateNrConfig(options.licenseKey, options.accountId);
    writeJsonFile(NR_CONFIG_PATH, config as unknown as Record<string, unknown>);
    print(`\n✓ New Relic config written: ${NR_CONFIG_PATH}`);
  } else if (options.licenseKey || options.accountId) {
    print('\n⚠ Both --license-key and --account-id are required to save NR config. Skipped.');
  }

  if (verifyBinaryOnPath()) {
    print('\n✓ nr-ai-observe is on your PATH');
  } else {
    printPathWarning();
  }

  print('\nNext steps:');
  print('  1. Restart Claude Code');
  print('  2. Verify: ask Claude Code to call nr_observe_get_session_stats');
  print('');
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
}

// ---------------------------------------------------------------------------
// CLI program
// ---------------------------------------------------------------------------

export function createInstallProgram(): Command {
  const program = new Command();
  program.name('nr-ai-observe').description('New Relic AI observability for Claude Code');

  program
    .command('install')
    .description('Configure Claude Code hooks and MCP server for AI observability')
    .option('--license-key <key>', 'New Relic license key')
    .option('--account-id <id>', 'New Relic account ID')
    .option('--project', 'Write to project-level .claude/settings.json instead of user-level')
    .action(handleInstall);

  program
    .command('uninstall')
    .description('Remove nr-ai-observe hooks and MCP server from Claude Code settings')
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
    .command('start')
    .description('Start the dashboard daemon (auto-starts on login)')
    .option('-p, --port <number>', 'Dashboard port', '7777')
    .action(async (opts: { port: string }) => {
      try {
        const { startDaemon, installLaunchAgent, getDaemonStatus, pollHealth } =
          await import('./daemon.js');
        const port = parseInt(opts.port, 10);
        if (!Number.isFinite(port) || port < 1 || port > 65535) {
          print('Error: port must be a number between 1 and 65535');
          process.exitCode = 1;
          return;
        }
        print('Starting nr-ai-observe...');
        // On macOS, let launchd own the process lifecycle (restart-on-crash, login persistence).
        // installLaunchAgent + launchctl load starts the process — no need for startDaemon.
        if (process.platform === 'darwin') {
          installLaunchAgent(port, print);
          // launchctl load is asynchronous — poll until the health endpoint responds
          // before checking status, mirroring what startDaemon does on other platforms.
          await pollHealth(port, 3000);
        } else {
          await startDaemon({ port, log: print });
        }
        const status = await getDaemonStatus(port);
        if (status.running) {
          print(`  PID:        ${status.pid}`);
          print(`  Port:       ${status.port}`);
          print(`  Dashboard:  ${status.url}`);
          if (process.platform === 'darwin') {
            print(`  Auto-start: enabled (will start on login)`);
          }
        } else {
          print('  Daemon may still be starting — check with: nr-ai-observe status');
        }
      } catch (err) {
        print(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  program
    .command('stop')
    .description('Stop the dashboard daemon and remove auto-start')
    .action(async () => {
      try {
        const { stopDaemon, removeLaunchAgent } = await import('./daemon.js');
        print('Stopping nr-ai-observe...');
        // Remove LaunchAgent FIRST so launchd doesn't respawn after SIGTERM.
        removeLaunchAgent(print);
        await stopDaemon(print);
        print('Stopped.');
      } catch (err) {
        print(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  program
    .command('status')
    .description('Show daemon status')
    .action(async () => {
      try {
        const { getDaemonStatus, isLaunchAgentInstalled } = await import('./daemon.js');
        const status = await getDaemonStatus();
        const autoStart = isLaunchAgentInstalled();
        if (status.running) {
          print('nr-ai-observe is running');
          print(`  PID:        ${status.pid}`);
          print(`  Port:       ${status.port}`);
          if (status.uptime != null) {
            print(`  Uptime:     ${formatUptime(status.uptime)}`);
          }
          print(`  Dashboard:  ${status.url}`);
          print(`  Auto-start: ${autoStart ? 'enabled' : 'disabled'}`);
        } else {
          print('nr-ai-observe is not running');
          if (autoStart) {
            print('  Auto-start is configured but daemon is not running.');
            print('  Try: nr-ai-observe start');
          }
        }
      } catch (err) {
        print(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  program
    .command('serve')
    .description('Run the dashboard in the foreground (for debugging)')
    .option('-p, --port <number>', 'Dashboard port', '7777')
    .action(async (opts: { port: string }) => {
      try {
        const { startDaemon } = await import('./daemon.js');
        const port = parseInt(opts.port, 10);
        if (!Number.isFinite(port) || port < 1 || port > 65535) {
          print('Error: port must be a number between 1 and 65535');
          process.exitCode = 1;
          return;
        }
        await startDaemon({ port, foreground: true, log: print });
      } catch (err) {
        print(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  return program;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

export async function runInstallCli(argv: string[]): Promise<void> {
  const program = createInstallProgram();
  await program.parseAsync(['node', 'nr-ai-observe', ...argv]);
}
