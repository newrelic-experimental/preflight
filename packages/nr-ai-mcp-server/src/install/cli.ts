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
  detectSettingsPath,
  generateNrConfig,
} from './install-helper.js';

const NR_CONFIG_DIR = resolve(homedir(), '.nr-ai-observe');
const NR_CONFIG_PATH = resolve(NR_CONFIG_DIR, 'config.json');

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
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Install handler
// ---------------------------------------------------------------------------

function handleInstall(options: { licenseKey?: string; accountId?: string; project?: boolean }): void {
  const scope = options.project ? 'project' : 'user';
  const settingsPath = detectSettingsPath(scope);

  const existing = readJsonFile(settingsPath);
  const merged = mergeSettings(existing);
  writeJsonFile(settingsPath, merged);

  console.log(`\n✓ Claude Code settings updated: ${settingsPath}`);
  console.log('  - Added PreToolUse and PostToolUse hooks');
  console.log('  - Added nr-ai-observability MCP server registration');

  if (options.licenseKey && options.accountId) {
    const config = generateNrConfig(options.licenseKey, options.accountId);
    writeJsonFile(NR_CONFIG_PATH, config as unknown as Record<string, unknown>);
    console.log(`\n✓ New Relic config written: ${NR_CONFIG_PATH}`);
  } else if (options.licenseKey || options.accountId) {
    console.log('\n⚠ Both --license-key and --account-id are required to save NR config. Skipped.');
  }

  console.log('\nNext steps:');
  console.log('  1. Restart Claude Code');
  console.log('  2. Verify: ask Claude Code to call nr_observe_get_session_stats');
  console.log('');
}

// ---------------------------------------------------------------------------
// Uninstall handler
// ---------------------------------------------------------------------------

function handleUninstall(options: { project?: boolean }): void {
  const scope = options.project ? 'project' : 'user';
  const settingsPath = detectSettingsPath(scope);

  if (!existsSync(settingsPath)) {
    console.log(`\nNo settings file found at ${settingsPath}. Nothing to remove.`);
    return;
  }

  const existing = readJsonFile(settingsPath);
  const cleaned = removeSettings(existing);
  writeJsonFile(settingsPath, cleaned);

  console.log(`\n✓ Claude Code settings updated: ${settingsPath}`);
  console.log('  - Removed nr-ai-observe hooks');
  console.log('  - Removed nr-ai-observability MCP server registration');
  console.log('\nRestart Claude Code for changes to take effect.\n');
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

  return program;
}

export async function runInstallCli(argv: string[]): Promise<void> {
  const program = createInstallProgram();
  await program.parseAsync(['node', 'nr-ai-observe', ...argv]);
}
