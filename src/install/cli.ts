/**
 * CLI handlers for `nr-ai-observe install` and `nr-ai-observe uninstall`.
 *
 * Dynamically imported from collector-script.ts when argv[2] is install/uninstall,
 * so commander and other heavy deps are never loaded on the hot hook path.
 */

import { Command } from 'commander';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Install handler
// ---------------------------------------------------------------------------

function handleInstall(options: { licenseKey?: string; accountId?: string; project?: boolean }): void {
  const scope = options.project ? 'project' : 'user';

  // Hooks go in settings.json
  const settingsPath = detectSettingsPath(scope);
  const existingSettings = readJsonFile(settingsPath);
  const mergedSettings = mergeSettings(existingSettings);
  writeJsonFile(settingsPath, mergedSettings);

  // MCP server goes in .mcp.json
  const mcpPath = detectMcpConfigPath(scope);
  const existingMcp = readJsonFile(mcpPath);
  const mergedMcp = mergeMcpConfig(existingMcp);
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
    const existingSettings = readJsonFile(settingsPath);
    const cleanedSettings = removeSettings(existingSettings);
    writeJsonFile(settingsPath, cleanedSettings);
    print(`\n✓ Hooks removed: ${settingsPath}`);
  } else {
    print(`\nNo settings file found at ${settingsPath}. Skipping hooks.`);
  }

  // Remove MCP server from .mcp.json
  const mcpPath = detectMcpConfigPath(scope);
  if (existsSync(mcpPath)) {
    const existingMcp = readJsonFile(mcpPath);
    const cleanedMcp = removeMcpConfig(existingMcp);

    // If .mcp.json is now empty (no mcpServers key or empty object), leave it minimal
    writeJsonFile(mcpPath, cleanedMcp);
    print(`✓ MCP server removed: ${mcpPath}`);
  } else {
    print(`No MCP config found at ${mcpPath}. Skipping MCP server.`);
  }

  print('\nRestart Claude Code for changes to take effect.\n');
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
    .description('Interactive first-run setup: configure New Relic keys, install hooks, and deploy dashboards')
    .action(async () => {
      const { runSetupWizard } = await import('./setup-wizard.js');
      await runSetupWizard();
    });

  return program;
}

export async function runInstallCli(argv: string[]): Promise<void> {
  const program = createInstallProgram();
  await program.parseAsync(['node', 'nr-ai-observe', ...argv]);
}
