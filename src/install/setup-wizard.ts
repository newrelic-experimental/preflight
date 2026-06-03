import { createInterface } from 'node:readline/promises';
import {
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
  copyFileSync,
  chmodSync,
} from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { normalizeDeveloperName } from '../config.js';
import { runInstallCli, verifyBinaryOnPath } from './cli.js';

const DEFAULT_STORAGE_PATH = resolve(homedir(), '.nr-ai-observe');
const CONFIG_PATH = resolve(DEFAULT_STORAGE_PATH, 'config.json');
const ALERT_RULES_DEST = resolve(DEFAULT_STORAGE_PATH, 'alerts', 'rules.json');

interface WizardLogger {
  warn(msg: string, meta?: object): void;
  info(msg: string, meta?: object): void;
}

/**
 * Resolve the path to the bundled `examples/local-alert-rules.json`. The
 * wizard ships from either `dist/install/` (when installed via npm) or
 * `src/install/` (when executed via `npx tsx`); both resolve to the repo
 * root by walking up two directories from the running script.
 *
 * Uses `process.argv[1]` rather than `__dirname` (which doesn't exist in
 * ESM) or `import.meta.url` (which trips Jest's TS module check). Same
 * pattern as `src/index.ts` for resolving the static dashboard dir.
 */
function defaultStarterRulesSource(): string {
  const scriptPath = process.argv[1] ?? process.cwd();
  return resolve(dirname(scriptPath), '..', '..', 'examples', 'local-alert-rules.json');
}

export interface CopyStarterAlertRulesOptions {
  /** Path to the source examples/local-alert-rules.json. */
  readonly sourcePath: string;
  /** Destination path (default: ~/.nr-ai-observe/alerts/rules.json). */
  readonly destPath: string;
  /** Optional logger; otherwise no-op. */
  readonly logger?: WizardLogger;
}

export interface CopyStarterAlertRulesResult {
  readonly copied: boolean;
  readonly reason?: string;
}

/**
 * Copy the bundled starter alert rules into the destination path. Idempotent:
 * if the destination already exists, the function leaves it alone (so a
 * user-edited rules file is never clobbered by a re-run of `setup`). The
 * destination directory is created with `0o700` if missing; the file is
 * written with `0o600`.
 */
export function copyStarterAlertRules(
  opts: CopyStarterAlertRulesOptions,
): CopyStarterAlertRulesResult {
  const { sourcePath, destPath, logger } = opts;
  if (existsSync(destPath)) {
    logger?.info('alerts: rules file already exists; skipping copy', {
      destPath,
    });
    return { copied: false, reason: 'exists' };
  }
  if (!existsSync(sourcePath)) {
    logger?.warn('alerts: starter rules source not found', { sourcePath });
    return { copied: false, reason: 'source-missing' };
  }
  try {
    mkdirSync(dirname(destPath), { recursive: true, mode: 0o700 });
    copyFileSync(sourcePath, destPath);
    // copyFileSync preserves permissions from source; force 0o600 so the
    // destination is locked-down regardless of what the source file had.
    try {
      chmodSync(destPath, 0o600);
    } catch {
      // Non-fatal — Windows may not honour chmod, etc.
    }
    logger?.info('alerts: copied starter rules', { sourcePath, destPath });
    return { copied: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger?.warn('alerts: copy failed', { sourcePath, destPath, error });
    return { copied: false, reason: error };
  }
}

function print(msg = ''): void {
  process.stdout.write(msg + '\n');
}

function loadExisting(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export type WizardMode = 'cloud' | 'local' | 'both';

export function buildConfig(
  existing: Record<string, unknown>,
  inputs: {
    accountId: string;
    licenseKey: string;
    developer: string;
    teamId: string | null;
    projectId: string | null;
    sessionBudgetUsd: number | null;
    mode?: WizardMode;
    dashboardPort?: number | null;
  },
): Record<string, unknown> {
  const mode = inputs.mode ?? 'cloud';
  const includeNrCreds = mode !== 'local';
  return {
    ...existing,
    ...(inputs.mode ? { mode } : {}),
    ...(includeNrCreds
      ? { accountId: inputs.accountId, licenseKey: inputs.licenseKey }
      : {}),
    developer: inputs.developer,
    ...(inputs.teamId ? { teamId: inputs.teamId } : {}),
    ...(inputs.projectId ? { projectId: inputs.projectId } : {}),
    ...(inputs.sessionBudgetUsd !== null ? { sessionBudgetUsd: inputs.sessionBudgetUsd } : {}),
    ...(inputs.dashboardPort != null
      ? { dashboard: { port: inputs.dashboardPort, host: '127.0.0.1', openOnStart: false } }
      : {}),
  };
}

function parseModeAnswer(raw: string, fallback: WizardMode): WizardMode {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === '' || trimmed === fallback) return fallback;
  if (trimmed === 'cloud' || trimmed === '1') return 'cloud';
  if (trimmed === 'local' || trimmed === '2') return 'local';
  if (trimmed === 'both' || trimmed === '3') return 'both';
  return fallback;
}

export async function runSetupWizard(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  print('\n=== NR AI Coding Observability Setup ===\n');
  print('This wizard will configure observability for your AI coding assistant.');
  print('Press Ctrl+C at any time to cancel.\n');

  const existing = loadExisting();

  // Step 0: Mode
  const existingMode =
    typeof existing.mode === 'string' &&
    (existing.mode === 'cloud' || existing.mode === 'local' || existing.mode === 'both')
      ? (existing.mode as WizardMode)
      : 'local';
  print('Modes:');
  print('  1) cloud — ship telemetry to New Relic');
  print('  2) local — keep all data on this machine, run a local dashboard (default)');
  print('  3) both  — ship to NR AND run the local dashboard');
  const modeRaw = await rl.question(`Which mode? [${existingMode}]: `);
  const mode = parseModeAnswer(modeRaw, existingMode);

  // Step 1+2: NR credentials (skip in local mode)
  let accountId = '';
  let licenseKey = '';
  if (mode !== 'local') {
    const existingAccountId = typeof existing.accountId === 'string' ? existing.accountId : '';
    const accountIdPrompt = existingAccountId
      ? `New Relic Account ID [${existingAccountId}]: `
      : 'New Relic Account ID: ';
    accountId = (await rl.question(accountIdPrompt)).trim();
    if (!accountId) accountId = existingAccountId;
    if (!/^\d{1,12}$/.test(accountId)) {
      console.error(`Invalid account ID: "${accountId}". Must be 1–12 digits.`);
      rl.close();
      process.exit(1);
    }

    const existingKey = typeof existing.licenseKey === 'string' ? '(already set)' : '';
    const keyPrompt = existingKey
      ? `New Relic License Key ${existingKey}: `
      : 'New Relic License Key (NEW_RELIC_LICENSE_KEY): ';
    licenseKey = (await rl.question(keyPrompt)).trim();
    if (!licenseKey && typeof existing.licenseKey === 'string') {
      licenseKey = existing.licenseKey;
    }
    if (!licenseKey) {
      console.error('License key is required.');
      rl.close();
      process.exit(1);
    }
  }

  // Step 3: Developer name
  const defaultDeveloper = typeof existing.developer === 'string'
    ? existing.developer
    : normalizeDeveloperName(process.env.USER ?? process.env.USERNAME ?? '');
  const rawInput = (await rl.question(`Developer name [${defaultDeveloper}]: `)).trim() || defaultDeveloper;
  const developer = normalizeDeveloperName(rawInput);
  if (developer !== rawInput) {
    print(`  → Normalized to: ${developer}`);
  }

  // Step 4: Optional fields
  const existingTeamId = typeof existing.teamId === 'string' ? existing.teamId : null;
  const teamIdAnswer = (await rl.question(`Team ID [${existingTeamId ?? 'optional'}]: `)).trim();
  const teamId = teamIdAnswer || existingTeamId;

  const existingProjectId = typeof existing.projectId === 'string' ? existing.projectId : null;
  const projectIdAnswer = (await rl.question(`Project ID [${existingProjectId ?? 'auto-detect from git'}]: `)).trim();
  const projectId = projectIdAnswer || existingProjectId;

  // Step 5: Budget caps
  const existingBudget = typeof existing.sessionBudgetUsd === 'number' ? String(existing.sessionBudgetUsd) : null;
  const sessionBudgetStr = (await rl.question(`Session budget USD [${existingBudget ?? 'no limit'}]: `)).trim() || (existingBudget ?? '');
  let sessionBudgetUsd: number | null = null;
  if (sessionBudgetStr) {
    const parsed = parseFloat(sessionBudgetStr);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.error(`Invalid session budget "${sessionBudgetStr}": must be a positive number.`);
      rl.close();
      process.exit(1);
    }
    sessionBudgetUsd = parsed;
  }

  // Step 5b: Dashboard port (local/both only)
  let dashboardPort: number | null = null;
  if (mode === 'local' || mode === 'both') {
    const existingDashboard =
      existing.dashboard && typeof existing.dashboard === 'object'
        ? (existing.dashboard as { port?: number })
        : null;
    const defaultPort = existingDashboard?.port ?? 7777;
    const portStr = (
      await rl.question(`Local dashboard port (loopback only) [${defaultPort}]: `)
    ).trim();
    if (portStr) {
      const parsed = parseInt(portStr, 10);
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 65536) {
        console.error(`Invalid port "${portStr}": must be 1–65535.`);
        rl.close();
        process.exit(1);
      }
      dashboardPort = parsed;
    } else {
      dashboardPort = defaultPort;
    }
  }

  // Write config
  const config = buildConfig(existing, {
    accountId,
    licenseKey,
    developer,
    teamId,
    projectId,
    sessionBudgetUsd,
    mode,
    dashboardPort,
  });

  mkdirSync(DEFAULT_STORAGE_PATH, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  print(`\nConfig written to ${CONFIG_PATH}`);

  // Step 5c: Starter alert rules (local + both modes only).
  // Default-yes prompt; copy is idempotent — re-running the wizard never
  // overwrites a user-edited rules file.
  if (mode === 'local' || mode === 'both') {
    const copyAnswer = (
      await rl.question(
        'Copy starter alert rules to ~/.nr-ai-observe/alerts/rules.json? [Y/n]: ',
      )
    ).trim().toLowerCase();
    if (copyAnswer !== 'n' && copyAnswer !== 'no') {
      const result = copyStarterAlertRules({
        sourcePath: defaultStarterRulesSource(),
        destPath: ALERT_RULES_DEST,
        logger: {
          warn: (msg) => print(`  ! ${msg}`),
          info: (msg) => print(`  → ${msg}`),
        },
      });
      if (result.copied) {
        print(`Starter alert rules copied to ${ALERT_RULES_DEST}`);
      } else if (result.reason === 'exists') {
        print(`Existing rules.json left in place (skipped — file exists).`);
      } else {
        print(`Could not copy starter rules: ${result.reason ?? 'unknown error'}`);
      }
    }
  }

  // Step 6: Hook install
  // Config is already written above; pass no credentials to install so it only
  // wires hooks and MCP without overwriting the config we just wrote.
  const installHooks = (await rl.question('\nInstall Claude Code hooks now? [Y/n]: ')).trim().toLowerCase();
  if (installHooks !== 'n') {
    print('\nRunning hook installer...');
    await runInstallCli(['install']);
    print('Hooks installed.');

    if (verifyBinaryOnPath()) {
      print('✓ nr-ai-observe is on your PATH');
    } else {
      print('\n⚠ nr-ai-observe is not on your PATH.');
      print('  Claude Code hooks will fail with "command not found" until this is resolved.');
      print('  Fix: run `npm link` in the project directory, or install globally:');
      print('    npm install -g nr-ai-mcp-server');
    }
  }

  // Step 7: Dashboard deploy — show manual command (deploy-dashboard.ts is not a library)
  if (mode !== 'local') {
    print('\nTo deploy dashboards, run:');
    print(`  NEW_RELIC_API_KEY=<NRAK-...> NEW_RELIC_ACCOUNT_ID=${accountId} npx tsx scripts/deploy-dashboard.ts --all`);
    print(`\nFor a personal dashboard pre-filtered to you:`);
    print(`  NEW_RELIC_API_KEY=<NRAK-...> NEW_RELIC_ACCOUNT_ID=${accountId} npx tsx scripts/deploy-dashboard.ts ai-coding-assistant-personal.json --developer ${developer}`);

    print(`\nFor personal alerts scoped to you:`);
    print(`  NEW_RELIC_API_KEY=<NRAK-...> NEW_RELIC_ACCOUNT_ID=${accountId} npx tsx scripts/deploy-alerts.ts --developer ${developer}`);
  } else {
    print(`\nLocal mode: open the dashboard at http://127.0.0.1:${dashboardPort ?? 7777} once Claude Code starts.`);
  }

  rl.close();

  // The MCP server is launched automatically by Claude Code based on the
  // .mcp.json entry written above — there is no manual start step. Telling
  // testers to run `nr-ai-mcp-server --stdio` themselves leads them to
  // start a second process that competes with the auto-launched one for
  // the buffer file lock and produces interleaved metrics.
  print('\n✓ Setup complete.');
  print('  Open Claude Code in a project — the MCP server starts automatically.');
  if (mode === 'local') {
    print(`  Metrics will appear at http://127.0.0.1:${dashboardPort ?? 7777} within ~30 seconds of your first tool call.`);
  } else {
    print('  Metrics will appear in your New Relic dashboard within a few minutes.');
  }
  print('');
}
