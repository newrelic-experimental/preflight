import { createInterface } from 'node:readline/promises';
import {
  writeFileSync,
  renameSync,
  mkdirSync,
  readFileSync,
  existsSync,
  copyFileSync,
  chmodSync,
  realpathSync,
} from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { normalizeDeveloperName, ConfigFileSchema } from '../config.js';
import { migrateStoragePath } from './migrate.js';
import { runInstallCli, verifyBinaryOnPath } from './cli.js';
import { installSchedule, installDashboardDaemon, resolveBinaryPath } from './schedule.js';
import { validateLicenseKey, validateApiKey } from './key-validator.js';

const DEFAULT_STORAGE_PATH = resolve(homedir(), '.newrelic-preflight');
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
  const rawPath = process.argv[1] ?? process.cwd();
  const scriptPath = (() => {
    try {
      return realpathSync(rawPath);
    } catch {
      return rawPath;
    }
  })();
  return resolve(dirname(scriptPath), '..', '..', 'examples', 'local-alert-rules.json');
}

export interface CopyStarterAlertRulesOptions {
  /** Path to the source examples/local-alert-rules.json. */
  readonly sourcePath: string;
  /** Destination path (default: ~/.newrelic-preflight/alerts/rules.json). */
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return {};
  }
  // Validate via the same schema loadMcpConfig uses, then keep ONLY recognized
  // top-level keys. The schema is `.passthrough()` so safeParse won't strip
  // unknown keys for us; the explicit filter below makes sure the wizard's
  // later spread (`...existing` in buildConfig) doesn't perpetuate stale keys
  // back into the rewritten config file.
  const validation = ConfigFileSchema.safeParse(parsed);
  const knownKeys = new Set(Object.keys(ConfigFileSchema.shape));
  if (!validation.success) {
    // Recognized-key value is malformed (e.g. accountId is a number, not a
    // string). Log a warning and fall back to defaults — the wizard will
    // re-prompt for those fields rather than pre-fill bad data.
    const issues = validation.error.issues
      .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
      .join('; ');
    process.stderr.write(
      `[setup-wizard] Existing config has invalid values; ignoring: ${issues}\n`,
    );
    return {};
  }
  // Strip unknown keys from the validated object so they don't get spread
  // back into the rewritten config.
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(validation.data as Record<string, unknown>)) {
    if (knownKeys.has(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
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
    nrApiKey?: string | null;
    collectorHost?: string | null;
  },
): Record<string, unknown> {
  const mode = inputs.mode ?? 'cloud';
  const includeNrCreds = mode !== 'local';
  return {
    ...existing,
    ...(inputs.mode ? { mode } : {}),
    ...(includeNrCreds ? { accountId: inputs.accountId, licenseKey: inputs.licenseKey } : {}),
    developer: inputs.developer,
    ...(inputs.teamId ? { teamId: inputs.teamId } : {}),
    ...(inputs.projectId ? { projectId: inputs.projectId } : {}),
    ...(inputs.sessionBudgetUsd !== null ? { sessionBudgetUsd: inputs.sessionBudgetUsd } : {}),
    ...(inputs.dashboardPort != null
      ? { dashboard: { port: inputs.dashboardPort, host: '127.0.0.1', openOnStart: false } }
      : {}),
    ...(inputs.nrApiKey ? { nrApiKey: inputs.nrApiKey } : {}),
    ...(inputs.collectorHost ? { collectorHost: inputs.collectorHost } : {}),
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
  migrateStoragePath(true);
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    print('\n=== Preflight Setup ===\n');
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
    let collectorHost: string | null = null;
    let nrApiKey: string | null = null;
    let validatedEmail: string | null = null;
    if (mode !== 'local') {
      const envAccountId = process.env.NEW_RELIC_ACCOUNT_ID?.trim() ?? '';
      const existingAccountId = typeof existing.accountId === 'string' ? existing.accountId : '';
      const defaultAccountId = existingAccountId || envAccountId;
      const accountIdHint = existingAccountId
        ? existingAccountId
        : envAccountId
          ? '$NEW_RELIC_ACCOUNT_ID'
          : '';
      const accountIdPrompt = accountIdHint
        ? `Account ID — your NR account number, found in the NR One URL [${accountIdHint}]: `
        : 'Account ID — your NR account number, found in the NR One URL (required): ';
      accountId = (await rl.question(accountIdPrompt)).trim();
      if (!accountId) accountId = defaultAccountId;
      if (!/^\d{1,12}$/.test(accountId)) {
        const src =
          accountId === envAccountId && !existingAccountId
            ? ' (value from $NEW_RELIC_ACCOUNT_ID)'
            : '';
        console.error(`Invalid account ID: "${accountId}". Must be 1–12 digits.${src}`);
        rl.close();
        process.exit(1);
      }

      const envLicenseKey = process.env.NEW_RELIC_LICENSE_KEY?.trim() ?? '';
      const existingKey = typeof existing.licenseKey === 'string' ? existing.licenseKey : '';
      const defaultKey = existingKey || envLicenseKey;
      const keyHint = existingKey
        ? '(already set)'
        : envLicenseKey
          ? '$NEW_RELIC_LICENSE_KEY'
          : 'required';
      const keyPrompt = `License Key — authenticates telemetry ingest to your NR account [${keyHint}]: `;
      licenseKey = (await rl.question(keyPrompt)).trim();
      if (!licenseKey) licenseKey = defaultKey;
      if (!licenseKey) {
        console.error('License key is required. Set NEW_RELIC_LICENSE_KEY or enter a value above.');
        rl.close();
        process.exit(1);
      }

      // Step 2b: Environment / region
      const existingCollectorHost =
        typeof existing.collectorHost === 'string' ? existing.collectorHost : null;
      const keyLower = licenseKey.toLowerCase();
      const autoEnv = keyLower.startsWith('eu01')
        ? 'eu'
        : keyLower.startsWith('gov01')
          ? 'gov'
          : 'us';
      const defaultEnv = existingCollectorHost ?? autoEnv;
      print('Environment:');
      print('  1) US      — api.newrelic.com');
      print('  2) EU      — api.eu.newrelic.com');
      print('  3) FedRAMP — api.newrelic.com (FedRAMP/GovCloud)');
      const envRaw = (await rl.question(`Which environment? [${defaultEnv}]: `))
        .trim()
        .toLowerCase();
      const resolvedEnv =
        envRaw === '' || envRaw === defaultEnv
          ? defaultEnv
          : envRaw === '1' || envRaw === 'us'
            ? 'us'
            : envRaw === '2' || envRaw === 'eu'
              ? 'eu'
              : envRaw === '3' || envRaw === 'fedramp' || envRaw === 'gov'
                ? 'gov'
                : defaultEnv;
      collectorHost = resolvedEnv === 'us' ? null : resolvedEnv;

      // Warn if license key prefix contradicts selected environment.
      const keyRegion = keyLower.startsWith('eu01')
        ? 'eu'
        : keyLower.startsWith('gov01')
          ? 'gov'
          : keyLower.startsWith('us01')
            ? 'us'
            : null;
      if (keyRegion && keyRegion !== resolvedEnv) {
        print(
          `  ⚠ Your license key looks like a ${keyRegion.toUpperCase()} key but you selected ${resolvedEnv.toUpperCase()}. Verify this is intentional.`,
        );
      }

      // Step 2c: NR API key (optional)
      const envApiKey = process.env.NEW_RELIC_API_KEY?.trim() ?? '';
      const existingApiKey = typeof existing.nrApiKey === 'string' ? existing.nrApiKey : null;
      const defaultApiKey = existingApiKey ?? (envApiKey || null);
      const apiKeyHint = existingApiKey
        ? '(already set)'
        : envApiKey
          ? '$NEW_RELIC_API_KEY'
          : 'optional';
      const apiKeyRaw = (
        await rl.question(
          `API Key (NRAK-...) — for team queries and deploying dashboards/alerts [${apiKeyHint}]: `,
        )
      ).trim();
      if (apiKeyRaw) {
        nrApiKey = apiKeyRaw;
      } else if (defaultApiKey) {
        nrApiKey = defaultApiKey;
      }

      // Step 2d: Validate credentials
      print('\nValidating credentials...');
      const licenseResult = await validateLicenseKey({ licenseKey, accountId, collectorHost });
      if (licenseResult.valid) {
        print('  ✓ License key: OK');
      } else if (licenseResult.reason === 'unauthorized') {
        print('  ✗ License key: unauthorized — double-check your key and environment selection');
      } else if (licenseResult.reason === 'timeout' || licenseResult.reason === 'network') {
        print(
          `  ⚠ License key: could not reach NR ingest API (${licenseResult.detail ?? licenseResult.reason}) — check your network`,
        );
      } else {
        print(
          `  ⚠ License key: unexpected response (${licenseResult.detail ?? 'unknown'}) — proceeding anyway`,
        );
      }

      if (nrApiKey) {
        const apiResult = await validateApiKey({ nrApiKey, collectorHost });
        if (apiResult.valid) {
          validatedEmail = apiResult.detail ?? null;
          const who = validatedEmail ? ` (${validatedEmail})` : '';
          print(`  ✓ API key: OK${who}`);
        } else if (apiResult.reason === 'unauthorized') {
          print('  ✗ API key: unauthorized — double-check your NRAK key');
        } else if (apiResult.reason === 'timeout' || apiResult.reason === 'network') {
          print(
            `  ⚠ API key: could not reach NerdGraph (${apiResult.detail ?? apiResult.reason}) — check your network`,
          );
        } else {
          print(
            `  ⚠ API key: unexpected response (${apiResult.detail ?? 'unknown'}) — proceeding anyway`,
          );
        }
      }
    }

    print(
      '\n  ℹ  Telemetry note: this server sends events and metrics to your NR account — ingest costs',
    );
    print('     apply on paid plans. Monitor usage via NR One → Data Management → Data Ingestion.');

    // Step 3: Developer name — prefer existing config, then email local-part, then $USER
    const emailLocalPart = validatedEmail ? (validatedEmail.split('@')[0] ?? '') : '';
    const defaultDeveloper =
      typeof existing.developer === 'string'
        ? existing.developer
        : normalizeDeveloperName(emailLocalPart || process.env.USER || process.env.USERNAME || '');
    const rawInput =
      (
        await rl.question(
          `Developer name — stamped on every event so you can filter your own data [${defaultDeveloper}]: `,
        )
      ).trim() || defaultDeveloper;
    const developer = normalizeDeveloperName(rawInput);
    if (developer !== rawInput) {
      print(`  → Normalized to: ${developer}`);
    }

    // Step 4: Optional fields
    print('\n-- Optional fields (press Enter to skip any) --');
    const existingTeamId = typeof existing.teamId === 'string' ? existing.teamId : null;
    const teamIdAnswer = (
      await rl.question(
        `Team label — a slug you define, e.g. "platform-eng" (not your NR account ID) used for recording metrics [${existingTeamId ?? 'optional'}]: `,
      )
    ).trim();
    const teamId = teamIdAnswer || existingTeamId;

    const existingProjectId = typeof existing.projectId === 'string' ? existing.projectId : null;
    const projectIdAnswer = (
      await rl.question(
        `Project ID — labels all events by project for per-project filtering [${existingProjectId ?? 'optional, auto-detected from git'}]: `,
      )
    ).trim();
    const projectId = projectIdAnswer || existingProjectId;

    // Step 5: Budget caps
    const existingBudget =
      typeof existing.sessionBudgetUsd === 'number' ? String(existing.sessionBudgetUsd) : null;
    const sessionBudgetStr =
      (
        await rl.question(
          `Session budget USD — triggers a warning event when AI spend exceeds this per session [${existingBudget ?? 'no limit'}]: `,
        )
      ).trim() ||
      (existingBudget ?? '');
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
        await rl.question(
          `Dashboard port — open http://127.0.0.1:${defaultPort} in your browser to view metrics [${defaultPort}]: `,
        )
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
      nrApiKey,
      collectorHost,
    });

    mkdirSync(DEFAULT_STORAGE_PATH, { recursive: true, mode: 0o700 });
    const configTmp = CONFIG_PATH + '.tmp';
    writeFileSync(configTmp, JSON.stringify(config, null, 2), { mode: 0o600 });
    renameSync(configTmp, CONFIG_PATH);
    print(`\nConfig written to ${CONFIG_PATH}`);

    // Step 5c: Starter alert rules (local + both modes only).
    // Default-yes prompt; copy is idempotent — re-running the wizard never
    // overwrites a user-edited rules file.
    if (mode === 'local' || mode === 'both') {
      const copyAnswer = (
        await rl.question(
          'Copy starter alert rules to ~/.newrelic-preflight/alerts/rules.json? [Y/n]: ',
        )
      )
        .trim()
        .toLowerCase();
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
    const installHooks = (await rl.question('\nInstall Claude Code hooks now? [Y/n]: '))
      .trim()
      .toLowerCase();
    if (installHooks !== 'n') {
      print('\nRunning hook installer...');
      await runInstallCli(['install']);
      print('Hooks installed.');

      if (verifyBinaryOnPath()) {
        print('✓ preflight is on your PATH');
      } else {
        print('\n⚠ preflight is not on your PATH.');
        print('  Claude Code hooks will fail with "command not found" until this is resolved.');
        print('  Fix: run `npm link` in the project directory, or install globally:');
        print('    npm install -g @newrelic/preflight');
      }
    }

    // Step 6b: Always-on background dashboard daemon (local/both mode, macOS only)
    if ((mode === 'local' || mode === 'both') && process.platform === 'darwin') {
      const binaryPath = resolveBinaryPath();
      const daemonAnswer = (
        await rl.question(
          '\nInstall always-on background dashboard? Keeps the local dashboard running even when Claude Code is closed [Y/n]: ',
        )
      )
        .trim()
        .toLowerCase();
      if (daemonAnswer !== 'n' && daemonAnswer !== 'no') {
        if (binaryPath) {
          try {
            // installDashboardDaemon calls launchctl unload before load, so
            // it handles the upgrade case atomically — no need to remove first.
            // Removing before installing would leave the user with no daemon if
            // the install step fails.
            installDashboardDaemon(binaryPath);
            print(
              `✓ Background dashboard daemon installed — dashboard will be available at http://127.0.0.1:${dashboardPort ?? 7777} after login.`,
            );
            print(
              '  To stop: preflight uninstall  (or: launchctl unload ~/Library/LaunchAgents/com.preflight.dashboard.plist)',
            );
          } catch (err) {
            print(
              `⚠ Could not install dashboard daemon: ${err instanceof Error ? err.message : String(err)}`,
            );
            print('  You can start the dashboard manually at any time with: preflight --local');
          }
        } else {
          print('\n⚠ Cannot install dashboard daemon — preflight not found on PATH.');
          print(
            '  Fix PATH first, then run: preflight setup  (or start manually: preflight --local)',
          );
        }
      }
    }

    // Step 7: Auto-update schedule (macOS only)
    if (process.platform === 'darwin') {
      const enableUpdate = (await rl.question('\nEnable daily auto-updates? [Y/n]: '))
        .trim()
        .toLowerCase();
      if (enableUpdate !== 'n' && enableUpdate !== 'no') {
        const timeRaw = (await rl.question('Update time (24h HH:MM) [08:00]: ')).trim();
        const timeStr = timeRaw || '08:00';
        const match = timeStr.match(/^(\d{1,2}):(\d{2})$/);
        const parsedHour = match ? parseInt(match[1], 10) : -1;
        const parsedMinute = match ? parseInt(match[2], 10) : -1;
        const validTime =
          parsedHour >= 0 && parsedHour <= 23 && parsedMinute >= 0 && parsedMinute <= 59;
        const hour = validTime ? parsedHour : 8;
        const minute = validTime ? parsedMinute : 0;
        if (!validTime && timeStr !== '08:00') {
          print(`⚠ Invalid time "${timeStr}", using default 08:00.`);
        }
        const hh = String(hour).padStart(2, '0');
        const mm = String(minute).padStart(2, '0');
        const binaryPath = resolveBinaryPath();
        if (binaryPath) {
          try {
            installSchedule(binaryPath, hour, minute);
            print(`✓ Daily auto-update scheduled for ${hh}:${mm}`);
          } catch {
            print(`⚠ Could not register schedule — run: preflight schedule --time ${hh}:${mm}`);
          }
        } else {
          print('\n⚠ Cannot schedule — preflight not found on PATH.');
          print(`  Run preflight schedule --time ${hh}:${mm} after fixing PATH.`);
        }
      }
    }

    // Step 8: Dashboard deploy — show manual command
    if (mode !== 'local') {
      const regionFlag = collectorHost === 'eu' ? ' --eu' : '';
      // Mask the API key in printed commands — users copy these snippets to
      // terminals, docs, and chat messages, and the raw key could be captured.
      const apiKeyVar = nrApiKey
        ? `NEW_RELIC_API_KEY=${nrApiKey.slice(0, 8)}...`
        : 'NEW_RELIC_API_KEY=<NRAK-...>';
      print('\nTo deploy dashboards, run:');
      print(
        `  ${apiKeyVar} NEW_RELIC_ACCOUNT_ID=${accountId} preflight deploy-dashboards --all${regionFlag}`,
      );
      print(`\nFor a personal dashboard pre-filtered to you:`);
      print(
        `  ${apiKeyVar} NEW_RELIC_ACCOUNT_ID=${accountId} preflight deploy-dashboards ai-coding-assistant-personal.json --developer ${developer}${regionFlag}`,
      );

      print(`\nFor personal alerts scoped to you:`);
      print(
        `  ${apiKeyVar} NEW_RELIC_ACCOUNT_ID=${accountId} preflight deploy-alerts --developer ${developer}${regionFlag}`,
      );
    } else if (mode === 'local') {
      print(`\nLocal mode selected — dashboard and metrics will be available locally.`);
    }

    // The MCP server is launched automatically by Claude Code based on the
    // .mcp.json entry written above — there is no manual start step. Telling
    // users to run `preflight --stdio` themselves leads them to
    // start a second process that competes with the auto-launched one for
    // the buffer file lock and produces interleaved metrics.
    print('\n✓ Setup complete.');
    print('  Start a new Claude Code session — the MCP server and hooks are loaded at session');
    print('  start. If you ran this setup inside an existing session, exit and start a fresh one');
    print('  for the hooks to take effect.');
    if (mode !== 'cloud') {
      print(
        `  Dashboard is available at http://127.0.0.1:${dashboardPort ?? 7777} once Claude Code starts.`,
      );
      print(
        '  On first launch you will see only nr_observe_health and nr_observe_get_config until',
      );
      print('  the first tool call fires the hook — all tools appear automatically after that.');
    } else {
      print('  Metrics will appear in your New Relic dashboard within a few minutes.');
    }
    print('');
  } finally {
    rl.close();
  }
}
