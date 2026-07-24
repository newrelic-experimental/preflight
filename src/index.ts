#!/usr/bin/env node
import 'dotenv/config';

import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { createLogger } from './shared/index.js';
import { VERSION } from './version.js';
import { createServer } from './server.js';
import { loadMcpConfig, DEFAULT_STORAGE_PATH } from './config.js';
import type { McpServerConfig } from './config.js';
import { ProxyManager } from './proxy/index.js';
import type { ProxyToolCallRecord, ProxyRequestRecord } from './proxy/index.js';
import { LocalStore } from './storage/index.js';
import type { ToolCallRecord } from './storage/types.js';
import {
  SessionStore,
  buildSessionSummary,
  sessionSummaryToDriftRecord,
} from './storage/session-store.js';
import { WeeklySummaryGenerator } from './storage/weekly-summary.js';
import { purgeOldSessions, purgeOldWeeklySummaries } from './storage/retention.js';
import { HookEventProcessor } from './hooks/index.js';
import { SessionTracker } from './metrics/session-tracker.js';
import { CostTracker } from './metrics/cost-tracker.js';
import { buildCostForecastFromInputs } from './metrics/cost-forecast.js';
import { BudgetTracker } from './metrics/budget-tracker.js';
import { TaskDetector } from './metrics/task-detector.js';
import { AntiPatternDetector } from './metrics/anti-patterns.js';
import { EfficiencyScorer } from './metrics/efficiency-score.js';
import { TrendAnalyzer } from './metrics/trend-analyzer.js';
import { CollaborationProfiler } from './metrics/collaboration-profile.js';
import { ClaudeMdTracker } from './metrics/claudemd-tracker.js';
import { createDefaultRegistry, GenericMcpAdapter } from './platforms/index.js';
import { CostPerOutcomeAnalyzer } from './metrics/cost-per-outcome.js';
import { PersonalCoach } from './metrics/personal-coach.js';
import { PromptFeedbackEngine } from './metrics/prompt-feedback.js';
import { RecommendationEngine } from './metrics/recommendation-engine.js';
import { ContextWindowTracker } from './metrics/context-window-tracker.js';
import { LatencyTracker } from './metrics/latency-tracker.js';
import { TaskCompletionTracker } from './metrics/task-completion-tracker.js';
import { ModelUsageTracker } from './metrics/model-usage-tracker.js';
import { RetryDetector } from './metrics/retry-detector.js';
import { ContextCompositionTracker } from './metrics/context-composition-tracker.js';
import { ContextTrackerRegistry } from './metrics/context-tracker.js';
import { LatencyDecompositionTracker } from './metrics/latency-decomposition.js';
import { DecisionTracker } from './metrics/decision-tracker.js';
import { InstructionDriftTracker } from './metrics/instruction-drift-tracker.js';
import type { SessionOutcomeRecord } from './metrics/instruction-drift-tracker.js';
import { ToolSelectionScorer } from './metrics/tool-selection-scorer.js';
import { QualityProxyTracker } from './metrics/quality-proxy-tracker.js';
import { ApiFailureTracker } from './metrics/api-failure-tracker.js';
import { LiveSessionRegistry } from './metrics/live-session-registry.js';
import { TurnCostAttributor } from './metrics/turn-cost-attributor.js';
import { TurnTracker } from './metrics/turn-tracker.js';
import {
  GitEfficiencyTracker,
  parseDefaultBranchFromSymbolicRef,
} from './metrics/git-efficiency-tracker.js';
import { TranscriptMessageTracker } from './metrics/transcript-message-tracker.js';
import { WorkflowRunTracker } from './metrics/workflow-run-tracker.js';
import { SubagentWatcher } from './hooks/subagent-watcher.js';
import { WorkflowWatcher } from './hooks/workflow-watcher.js';
import { WorkflowStore } from './dashboard/workflow-store.js';
import { SubagentTimelineStore } from './dashboard/subagent-timeline-store.js';
import { NrIngestManager } from './transport/nr-ingest.js';
import type { TokenUsage } from './shared/index.js';
import { AuditTrailManager } from './security/audit-trail.js';
import { LiveEventBus } from './dashboard/index.js';
import { DashboardServer } from './dashboard/dashboard-server.js';
import type { ObservabilityHealthSnapshot } from './dashboard/routes/api-handler.js';
import { LocalAlertEngine } from './alerts/local-alert-engine.js';
import { AlertSnapshotCollector } from './alerts/alert-snapshot-collector.js';
import { AlertLog } from './alerts/alert-log.js';
import { OsNotifier } from './alerts/os-notifier.js';
import { parseLocalAlertRules } from './alerts/local-alert-rule.js';
import { localDateKey, todayPortionOfSessionCost } from './lib/date.js';
import { FeedbackCollector } from './tools/workflow-tools.js';
import { registerTools, registerPendingTools } from './tools/session-stats.js';
import type { ConfigSummary } from './tools/session-stats.js';
import {
  resolveSessionId,
  resolveFromJobDir,
  resolveFromBreadcrumb,
  isSyntheticSessionId,
} from './hooks/session-resolver.js';
import { initMcpTracer } from './tracing/mcp-tracer.js';
import { SessionSpan } from './tracing/session-span.js';
import { TaskSpanTracker } from './tracing/task-span-tracker.js';
import { emitToolCallSpan } from './tracing/tool-call-span.js';
import type { CliOptions } from './types.js';
import { migrateStoragePath } from './install/migrate.js';

export { VERSION };
export { NrMcpServer, createServer } from './server.js';
export { loadMcpConfig, redactSensitive } from './config.js';
export type { McpServerConfig } from './config.js';
export { LocalStore } from './storage/index.js';
export type { HookEvent, SessionSummary, AuditEntry } from './storage/index.js';
export type { CliOptions, ServerOptions } from './types.js';
export { ProxyManager } from './proxy/index.js';
export type { ProxyToolCallRecord, ProxyRequestRecord, UpstreamConfig } from './proxy/index.js';
export {
  ClaudeCodeAdapter,
  CursorAdapter,
  WindsurfAdapter,
  CopilotAdapter,
  ZedAdapter,
  ContinueAdapter,
  AmazonQAdapter,
  parseCopilotUsageResponse,
  GenericMcpAdapter,
  validateReportToolCallInput,
  REPORT_TOOL_CALL_TOOL,
  REPORT_SESSION_START_TOOL,
  REPORT_SESSION_END_TOOL,
  PlatformRegistry,
  createDefaultRegistry,
} from './platforms/index.js';
export type {
  NormalizedToolCall,
  PlatformConfig,
  PlatformSessionMetadata,
  PlatformAdapter,
  ReportToolCallInput,
  ReportSessionStartInput,
  ReportSessionEndInput,
} from './platforms/index.js';

const logger = createLogger('mcp-cli');

// Show first-4 and last-4 chars of a credential. Guards against short values
// (e.g. test stubs) that would otherwise expose the full secret.
export function maskCredential(key: string): string {
  if (key.length <= 8) return '***';
  return key.slice(0, 4) + '...' + key.slice(-4);
}

/**
 * Wraps loadMcpConfig to append a diagnostic pointer on error.
 * Helps users troubleshoot configuration issues without requiring
 * manual diagnosis steps.
 */
function loadConfigOrDie(options: Partial<CliOptions>): Readonly<McpServerConfig> {
  try {
    return loadMcpConfig(options);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${msg}\n\nRun 'preflight doctor' to diagnose.`);
  }
}

/**
 * Structural subset of NrIngestManager consumed by the proxy-mode telemetry
 * callbacks. Declared separately (rather than importing the class type
 * directly into the callback signature) so tests can pass a plain object of
 * jest.fn()s without constructing a real NrIngestManager.
 */
type ProxyTelemetrySink = Pick<NrIngestManager, 'ingestToolCall' | 'ingestProxyRequest'>;

/**
 * Builds the ProxyManager onToolCall/onRequest callbacks for standalone proxy
 * mode. When nrIngest is undefined (proxy running with mode: 'local', i.e. no
 * cloud egress configured), the callbacks still log locally but do not
 * attempt telemetry ingestion.
 */
export function buildProxyTelemetryCallbacks(nrIngest: ProxyTelemetrySink | undefined): {
  onToolCall: (record: ProxyToolCallRecord) => void;
  onRequest: (record: ProxyRequestRecord) => void;
} {
  return {
    onToolCall: (record) => {
      logger.debug('Proxy tool call', {
        server: record.serverName,
        tool: record.toolName,
        durationMs: record.durationMs,
      });
      nrIngest?.ingestToolCall(record);
    },
    onRequest: (record) => {
      logger.debug('Proxy request', {
        server: record.serverName,
        method: record.method,
        durationMs: record.durationMs,
      });
      nrIngest?.ingestProxyRequest(record);
    },
  };
}

/**
 * Result of evaluating a dashboard-server start error.
 *
 * - kind: 'skip' — EADDRINUSE was observed; caller should drop the dashboard
 *   server reference and continue without binding. The `message` field is a
 *   human-readable INFO-level log line explaining the situation.
 * - kind: 'rethrow' — non-EADDRINUSE error (or non-error value); caller should
 *   re-throw `error` unchanged.
 */
export type DashboardStartFailure =
  { kind: 'skip'; message: string } | { kind: 'rethrow'; error: unknown };

/**
 * Decide how to handle a failure returned from `DashboardServer.start()`.
 *
 * When N concurrent `preflight --stdio` instances launch (one per
 * Claude Code session) only one can bind the dashboard port; the rest receive
 * EADDRINUSE. Rather than fataling the whole MCP server (which would render
 * the session's tools unusable in Claude Code's UI), we log an INFO line and
 * continue without the dashboard. Other errors still propagate.
 */
export function classifyDashboardStartError(
  err: unknown,
  host: string,
  port: number,
): DashboardStartFailure {
  if (
    err &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code?: string }).code === 'EADDRINUSE'
  ) {
    return {
      kind: 'skip',
      message:
        `Dashboard already owned by another preflight instance at ` +
        `http://${host}:${port}; continuing without dashboard.`,
    };
  }
  return { kind: 'rethrow', error: err };
}

/**
 * Default interval (ms) between dashboard re-bind attempts when this MCP
 * started in headless mode (EADDRINUSE skip). Overridable via
 * NR_AI_DASHBOARD_REPOLL_MS — kept simple to avoid threading a new config
 * field through the loader for what is essentially a knob for tests.
 */
export const DEFAULT_DASHBOARD_REPOLL_MS = 30_000;

export function getDashboardRepollIntervalMs(): number {
  const raw = process.env.NR_AI_DASHBOARD_REPOLL_MS;
  if (raw === undefined || raw === '') return DEFAULT_DASHBOARD_REPOLL_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_DASHBOARD_REPOLL_MS;
  return parsed;
}

const RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface RetentionSweepDeps {
  readonly storagePath: string;
  readonly retainSessionsDays: number | null;
}

/** Purge old session and weekly-summary files. No-op when retention is disabled. */
export function runRetentionSweep(deps: RetentionSweepDeps): void {
  if (deps.retainSessionsDays === null || deps.retainSessionsDays <= 0) return;
  const deletedSessionFiles = purgeOldSessions(deps.storagePath, deps.retainSessionsDays);
  const deletedWeeklySummaryFiles = purgeOldWeeklySummaries(
    deps.storagePath,
    deps.retainSessionsDays,
  );
  if (deletedSessionFiles > 0 || deletedWeeklySummaryFiles > 0) {
    logger.info('Retention purge complete', { deletedSessionFiles, deletedWeeklySummaryFiles });
  }
}

/**
 * Run the retention sweep once immediately, then every 6 hours. Runs in
 * every mode (cloud/local/both) — retention isn't gated on the dashboard
 * binding a port. Returns null (and schedules nothing) when
 * `retainSessionsDays` is disabled.
 */
export function startRetentionSweep(deps: RetentionSweepDeps): NodeJS.Timeout | null {
  if (deps.retainSessionsDays === null || deps.retainSessionsDays <= 0) return null;
  runRetentionSweep(deps);
  const interval = setInterval(() => runRetentionSweep(deps), RETENTION_SWEEP_INTERVAL_MS);
  interval.unref?.();
  return interval;
}

export interface MaintenanceGcDeps {
  readonly localStore: LocalStore;
  readonly liveSessionRegistry: LiveSessionRegistry | undefined;
}

/** Default cold-scan window for SubagentWatcher/WorkflowWatcher — mirrors DEFAULT_DISCOVERY_HOURS in subagent-watcher.ts. */
const WATCHER_DISCOVERY_HOURS_DEFAULT = 24;

/**
 * One orphan-buffer/breadcrumb/dead-instance/cursor-file GC pass.
 * `gcOrphanBuffers()` is rename-based, so concurrent processes each running
 * this independently just means an occasional benign "already moved"
 * warning — no leader election needed to call this from every process.
 */
export function runMaintenanceGcPass(deps: MaintenanceGcDeps): void {
  const log = createLogger('mcp-cli');
  const { localStore, liveSessionRegistry } = deps;
  try {
    localStore.gcStaleBreadcrumbs();
    localStore.gcDeadLocalInstances();
    const live = localStore.getActiveSessionIdsFromHeartbeats();
    if (liveSessionRegistry) {
      for (const id of liveSessionRegistry.getLiveSessions({ includeSynthetic: true })) {
        live.add(id);
      }
    }
    localStore.gcOrphanBuffers(live);
    const envHours = parseInt(process.env.NR_AI_WATCHER_DISCOVERY_HOURS ?? '', 10);
    const discoveryHours =
      Number.isFinite(envHours) && envHours > 0 ? envHours : WATCHER_DISCOVERY_HOURS_DEFAULT;
    localStore.gcWatcherCursors(live, discoveryHours);
  } catch (err) {
    log.warn('GC pass failed', { error: String(err) });
  }
}

/**
 * Run the maintenance GC pass immediately, then every 5 minutes. Called
 * unconditionally in every mode (cloud/local/both) — decoupled from whether
 * the `--local` dashboard wins its port bind.
 */
export function startMaintenanceGc(deps: MaintenanceGcDeps): NodeJS.Timeout {
  runMaintenanceGcPass(deps);
  const interval = setInterval(() => runMaintenanceGcPass(deps), 5 * 60 * 1000);
  interval.unref?.();
  return interval;
}

/**
 * Side-effects wired up once the dashboard HTTP server has bound the port.
 * Runs on the initial-bind success path and on the re-poll takeover path so
 * a headless MCP that later seizes the dashboard performs the same setup
 * (orphan GC, openOnStart warning) as one that bound on first try.
 *
 * Maintenance GC now runs independently of dashboard-bind status (see
 * `startMaintenanceGc()`), so this only handles the PID file and the
 * openOnStart warning.
 */
export interface DashboardPostBindDeps {
  readonly localStore: LocalStore;
  readonly openOnStart: boolean;
  /** True for `--local` mode — writes the local-dashboard PID file so `preflight update` can find and restart this process. Never true for `--stdio`. */
  readonly isLocalMode: boolean;
}

export function setupDashboardPostBind(
  addr: { address: string; port: number },
  deps: DashboardPostBindDeps,
): void {
  const log = createLogger('mcp-cli');
  log.info(`Dashboard ready at http://${addr.address}:${addr.port}`);

  if (deps.isLocalMode) {
    deps.localStore.writeLocalDashboardPid(process.argv.slice(1), process.cwd());
  }

  // openOnStart is declared in config but auto-open isn't implemented
  // in v1 — log a warning so a user who set it doesn't assume the feature
  // works silently.
  if (deps.openOnStart) {
    log.warn(
      'dashboard.openOnStart is not implemented in v1; the dashboard URL is logged above. ' +
        'Open it manually in your browser.',
    );
  }
}

/**
 * Schedule periodic re-bind attempts after a headless start (EADDRINUSE skip).
 *
 * The first MCP to launch wins port 7777 and serves the dashboard; the rest
 * run headless. If the owner exits while the headless MCPs are still alive,
 * the port is freed and nobody picks it up — the dashboard goes dead. This
 * re-poll closes that gap: every
 * `intervalMs` (default 30s) the headless MCP retries `start()`, and the
 * first one to succeed promotes itself to dashboard owner and runs the
 * post-bind setup (GC interval, etc.).
 *
 * The interval is unref'd so a process whose only remaining handle is this
 * timer can still exit cleanly when stdin closes (matters for stdio mode).
 */
export interface DashboardRepollOptions {
  readonly dashboardServer: DashboardServer;
  readonly host: string;
  readonly port: number;
  readonly intervalMs?: number;
  readonly postBind: (addr: { address: string; port: number }) => void;
  readonly logger?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

export function startDashboardRepoll(opts: DashboardRepollOptions): NodeJS.Timeout {
  const ms = opts.intervalMs ?? getDashboardRepollIntervalMs();
  const log = opts.logger ?? createLogger('mcp-cli');
  let inFlight = false;
  const interval = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const addr = await opts.dashboardServer.start();
        clearInterval(interval);
        log.info(
          `Dashboard ownership taken over at http://${addr.address}:${addr.port}; previous owner exited.`,
        );
        opts.postBind({ address: addr.address, port: addr.port });
      } catch (err) {
        const decision = classifyDashboardStartError(err, opts.host, opts.port);
        if (decision.kind === 'rethrow') {
          // Non-EADDRINUSE failure (e.g. permissions) — stop polling. We
          // can't recover by retrying and we don't want to spam the log.
          clearInterval(interval);
          log.warn('Dashboard re-poll stopped after unexpected error', {
            error: String(decision.error),
          });
        }
        // EADDRINUSE: port still owned — keep polling silently.
      } finally {
        inFlight = false;
      }
    })();
  }, ms);
  interval.unref?.();
  return interval;
}

/**
 * Subcommand names handled by `dispatchSubcommand` below. When `argv[2]` is one
 * of these, we route to a dedicated handler and bypass the flag-driven main()
 * path entirely. This lets users who installed via `npm install -g` invoke
 * `preflight deploy-dashboards [...]` and similar without cloning the
 * repo to run a `scripts/*.ts` file.
 */
const SUBCOMMAND_NAMES = [
  'deploy-dashboards',
  'deploy-alerts',
  'install',
  'uninstall',
  'setup',
  'validate',
  'update',
  'schedule',
  'doctor',
] as const;
type SubcommandName = (typeof SUBCOMMAND_NAMES)[number];

// Install-CLI subcommands — a subset of SUBCOMMAND_NAMES routed to runInstallCli.
// Derived from SUBCOMMAND_NAMES to ensure a single source of truth: deploy-*
// commands are excluded and handled by the commander path in dispatchSubcommand.
const INSTALL_CLI_SUBCOMMANDS = SUBCOMMAND_NAMES.filter(
  (s) => s !== 'deploy-dashboards' && s !== 'deploy-alerts',
) as readonly string[];

function isSubcommand(value: string | undefined): value is SubcommandName {
  return typeof value === 'string' && (SUBCOMMAND_NAMES as readonly string[]).includes(value);
}

/**
 * If argv[2] is a known subcommand, run it and return its exit code.
 * Otherwise return null so main() can continue with its flag-based dispatch.
 */
export async function dispatchSubcommand(argv: string[]): Promise<number | null> {
  const sub = argv[2];
  if (!isSubcommand(sub)) return null;

  // CLI subcommands (install/setup/etc.) delegate entirely to the install CLI.
  if (INSTALL_CLI_SUBCOMMANDS.includes(sub)) {
    const { runInstallCli } = await import('./install/cli.js');
    try {
      await runInstallCli(argv.slice(2));
    } catch {
      // Error message already printed by the action handler before throwing.
      return 1;
    }
    return typeof process.exitCode === 'number' ? process.exitCode : 0;
  }

  const program = new Command();
  program.name('preflight').version(VERSION);

  const subargs = ['node', 'preflight', ...argv.slice(2)];

  if (sub === 'deploy-dashboards') {
    program
      .command('deploy-dashboards')
      .description('Deploy AI Coding Assistant dashboards to a New Relic account')
      .option('--all', 'deploy all dashboard JSON files')
      .option('--update', 'update existing dashboards in-place (matched by name)')
      .option('--teardown', 'delete deployed dashboards (matched by name)')
      .option('--print', 'print dashboard JSON with accountIds filled in (no API key required)')
      .option('--eu', 'target the New Relic EU API')
      .option(
        '--developer <name>',
        'inject developer name into the dashboard "developer" variable default',
      )
      .argument(
        '[file]',
        'specific dashboard JSON file (defaults to ai-coding-assistant-overview.json)',
      )
      .action(async (file: string | undefined, opts: Record<string, unknown>) => {
        const { runDeployDashboards } = await import('./deploy/deploy-dashboards.js');
        const code = await runDeployDashboards({
          all: opts.all === true,
          update: opts.update === true,
          teardown: opts.teardown === true,
          print: opts.print === true,
          eu: opts.eu === true,
          developer: typeof opts.developer === 'string' ? opts.developer : null,
          file: file ?? null,
        });
        process.exitCode = code;
      });
  } else {
    program
      .command('deploy-alerts')
      .description('Deploy AI Coding Assistant alert conditions to a New Relic account')
      .option('--dry-run', 'print the policy + conditions that would be created and exit')
      .option('--teardown', 'delete the alert policy and all its conditions')
      .option('--update', 'sync conditions on an existing policy in place (matched by name)')
      .option('--eu', 'target the New Relic EU API')
      .option('--developer <name>', 'deploy a personal alert policy scoped to <name>')
      .action(async (opts: Record<string, unknown>) => {
        const { runDeployAlerts } = await import('./deploy/deploy-alerts.js');
        const code = await runDeployAlerts({
          dryRun: opts.dryRun === true,
          teardown: opts.teardown === true,
          update: opts.update === true,
          eu: opts.eu === true,
          developer: typeof opts.developer === 'string' ? opts.developer : null,
        });
        process.exitCode = code;
      });
  }

  await program.parseAsync(subargs);
  const code = process.exitCode;
  return typeof code === 'number' ? code : 0;
}

export function parseArgs(argv: string[]): CliOptions {
  const program = new Command();
  program
    .name('preflight')
    .description('New Relic MCP server for observing AI coding assistants')
    .version(VERSION)
    .option('-p, --port <number>', 'HTTP port for proxy mode', '9847')
    .option('-c, --config <path>', 'path to config file')
    .option('-l, --log-level <level>', 'log level (debug|info|warn|error)', 'info')
    .option('--stdio', 'use stdio transport (for Claude Code MCP connection)')
    .option('--local', 'start dashboard and event processor without MCP stdio transport')
    .option(
      '--validate',
      'validate config file and exit (combine with --config to check a specific file)',
    );

  program.parse(argv);
  const opts = program.opts();

  const parsed = parseInt(opts.port, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(
      `Invalid port "${opts.port as string}": must be an integer between 1 and 65535`,
    );
  }

  const stdio = opts.stdio ?? false;
  const local = opts.local ?? false;
  const validate = opts.validate ?? false;
  if (stdio && local) {
    throw new Error('--stdio and --local are mutually exclusive. Use one or the other.');
  }
  if (validate && (stdio || local)) {
    throw new Error('--validate is mutually exclusive with --stdio and --local.');
  }

  return {
    port: parsed,
    config: opts.config ?? null,
    logLevel: opts.logLevel as CliOptions['logLevel'],
    stdio,
    local,
    validate,
  };
}

async function main(): Promise<void> {
  // Subcommand dispatch (e.g. `preflight deploy-dashboards --all`)
  // happens before flag parsing — they don't share the option schema with the
  // server modes (--stdio / --local / --validate / proxy), and they exit
  // independently rather than booting the full pipeline.
  const subcommandExit = await dispatchSubcommand(process.argv);
  if (subcommandExit !== null) {
    process.exit(subcommandExit);
  }

  migrateStoragePath();

  const options = parseArgs(process.argv);

  // Propagate --log-level into the env var that createLogger() reads.
  // Must be set before any subsystem loggers are constructed.
  process.env.NEW_RELIC_AI_LOG_LEVEL = options.logLevel;

  logger.info('Starting preflight', {
    version: VERSION,
    stdio: options.stdio,
    port: options.port,
    logLevel: options.logLevel,
  });

  if (options.validate) {
    const configPath = options.config ?? resolve(DEFAULT_STORAGE_PATH, 'config.json');
    process.stdout.write(`Validating config: ${configPath}\n\n`);
    try {
      const cfg = loadMcpConfig(options);
      process.stdout.write(`  mode:       ${cfg.mode}\n`);
      process.stdout.write(`  developer:  ${cfg.developer}\n`);
      if (cfg.accountId) process.stdout.write(`  accountId:  ${cfg.accountId}\n`);
      if (cfg.licenseKey) process.stdout.write(`  licenseKey: ${maskCredential(cfg.licenseKey)}\n`);
      if (cfg.nrApiKey) process.stdout.write(`  nrApiKey:   ${maskCredential(cfg.nrApiKey)}\n`);
      process.stdout.write(`  region:     ${cfg.collectorHost ?? 'us'}\n`);
      process.stdout.write(`  storage:    ${cfg.storagePath}\n`);
      process.stdout.write(`  dashboard:  http://${cfg.dashboard.host}:${cfg.dashboard.port}\n`);
      process.stdout.write(`\nConfig is valid.\n`);
      process.exit(0);
    } catch (err) {
      process.stdout.write(`  error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.stdout.write(`\nConfig validation failed.\n`);
      process.exit(1);
    }
  }

  // Declare resource holders before any async work so the shutdown handler
  // safely cleans up whatever was initialized before a signal arrives.
  let mcpServer: import('./server.js').NrMcpServer | undefined;
  let eventProcessor: HookEventProcessor | undefined;
  let nrIngest: NrIngestManager | undefined;
  let proxyManager: ProxyManager | undefined;
  let sessionStore: SessionStore | undefined;
  let weeklySummaryGenerator: WeeklySummaryGenerator | undefined;
  let persistSession: ((opts?: { periodic?: boolean }) => void) | undefined;
  let config: import('./config.js').McpServerConfig | undefined;
  let sessionTracker: SessionTracker | undefined;
  let taskDetector: TaskDetector | undefined;
  let sessionSpan: SessionSpan | undefined;
  let taskSpanTracker: TaskSpanTracker | undefined;
  let dashboardServer: DashboardServer | undefined;
  let liveSessionRegistry: LiveSessionRegistry | undefined;
  let alertEvaluationInterval: NodeJS.Timeout | undefined;
  let alertRulesWatcher: import('node:fs').FSWatcher | undefined;
  let alertRulesWatchTimer: NodeJS.Timeout | undefined;
  let localStoreForShutdown: LocalStore | undefined;
  // Maintenance GC (orphan buffers/breadcrumbs/dead instances) and the
  // retention sweep (sessions/ + weekly_summaries/) both run in every mode,
  // independent of dashboard-bind status. Cleared in the shutdown handler.
  let maintenanceGcInterval: NodeJS.Timeout | undefined;
  let retentionInterval: NodeJS.Timeout | undefined;
  // Periodic local session-JSON flush so a non-clean exit (crash/SIGKILL)
  // loses at most one interval of session data — persistSession otherwise runs
  // only on clean shutdown. Cleared in the shutdown handler. Synthetic /
  // provisional ids (pending-/local-/proxy-) are skipped inside persistSession.
  let sessionPersistInterval: NodeJS.Timeout | undefined;
  // When this MCP starts headless (EADDRINUSE skip), this interval retries
  // dashboardServer.start() periodically so we can take over if the current
  // owner exits. Cleared in the shutdown handler.
  let dashboardRepollInterval: NodeJS.Timeout | undefined;
  // Watcher instances are declared here so the shutdown handler can stop them
  // regardless of which mode (stdio vs. local) is active.
  let activeSubagentWatcher: SubagentWatcher | null = null;
  let activeWorkflowWatcher: WorkflowWatcher | null = null;
  // Aborts the async resolveSessionId polling loop when shutdown fires so
  // the breadcrumb poll does not outlive the process.
  let sessionResolutionAbort: AbortController | undefined;

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Abort any in-progress session resolution so its polling loop exits
    // cleanly rather than continuing after process.exit() is called.
    sessionResolutionAbort?.abort();
    logger.info('Shutting down...');
    try {
      persistSession?.();
      if (
        config?.otlp?.transport !== 'nr-events-api' &&
        sessionTracker &&
        taskDetector &&
        sessionSpan
      ) {
        taskSpanTracker?.closeAll();
        const stats = sessionTracker.getMetrics();
        const taskMetrics = taskDetector.getMetrics();
        sessionSpan.end(stats.toolCallCount, taskMetrics.totalTasksCompleted);
      }
      if (alertEvaluationInterval) clearInterval(alertEvaluationInterval);
      if (maintenanceGcInterval) clearInterval(maintenanceGcInterval);
      if (retentionInterval) clearInterval(retentionInterval);
      if (dashboardRepollInterval) clearInterval(dashboardRepollInterval);
      if (sessionPersistInterval) clearInterval(sessionPersistInterval);
      // Remove this MCP's heartbeat so the next dashboard-owner GC pass
      // doesn't have to mtime-archive our buffer file.
      localStoreForShutdown?.removeHeartbeat();
      // If this was a --local process that won the dashboard port, remove
      // its PID file so `preflight update` doesn't try to restart a process
      // that's already exiting cleanly. No-op for --stdio and for --local
      // instances that never won the port (removeLocalDashboardPid() itself
      // also guards on pid ownership as a second layer of safety).
      if (options.local) localStoreForShutdown?.removeLocalDashboardPid();
      if (options.local) localStoreForShutdown?.unregisterLocalInstance();
      if (alertRulesWatchTimer) clearTimeout(alertRulesWatchTimer);
      if (alertRulesWatcher) {
        try {
          alertRulesWatcher.close();
        } catch {
          // ignore close errors during shutdown
        }
        alertRulesWatcher = undefined;
      }
      eventProcessor?.stop();
      activeSubagentWatcher?.stop();
      activeWorkflowWatcher?.stop();
      liveSessionRegistry?.stopSampling();
      // Use allSettled so a failure in one stop() doesn't prevent the others.
      const stopResults = await Promise.allSettled([
        dashboardServer ? dashboardServer.stop() : Promise.resolve(),
        nrIngest ? nrIngest.stop() : Promise.resolve(),
        mcpServer ? mcpServer.close() : Promise.resolve(),
        proxyManager ? proxyManager.stop() : Promise.resolve(),
      ]);
      for (const r of stopResults) {
        if (r.status === 'rejected') {
          logger.warn('Error stopping service during shutdown', { error: String(r.reason) });
        }
      }
    } catch (err) {
      logger.error('Error during shutdown cleanup', { error: String(err) });
    } finally {
      process.exit(0);
    }
  };

  const handleSignal = () => {
    shutdown().catch((err) => {
      process.stderr.write(`Shutdown error: ${String(err)}\n`);
      process.exit(1);
    });
  };
  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);

  if (options.stdio || options.local) {
    let sessionTraceId: string;
    if (options.stdio) {
      // Connect stdio FIRST so the MCP handshake can complete immediately.
      // Tools are registered after initialization; tool calls before that
      // will return MethodNotFound (which the SDK handles gracefully).
      mcpServer = createServer();
      await mcpServer.connectStdio();

      // Register stdin shutdown handlers immediately after connecting so that
      // shutdown() is called even if stdin closes during the session-ID
      // resolution window (before the handlers were previously registered).
      process.stdin.once('end', () => {
        logger.info('stdin closed, shutting down');
        void shutdown();
      });
      process.stdin.on('error', (err) => {
        logger.warn('stdin error, shutting down', { error: String(err) });
        void shutdown();
      });

      config = loadConfigOrDie(options);

      if (!config.enabled) {
        logger.info('Server disabled via config — exiting');
        await mcpServer.close();
        process.exit(0);
      }

      const synchronouslyResolved =
        resolveFromJobDir(process.env.CLAUDE_JOB_DIR ?? null) ??
        resolveFromBreadcrumb(config.storagePath, process.ppid);
      if (synchronouslyResolved) {
        sessionTraceId = synchronouslyResolved;
        logger.info('Session ID resolved synchronously', { sessionTraceId });
      } else {
        // Use a provisional ID so the shared section (including dashboard) can
        // start immediately. The real session ID is resolved asynchronously in
        // the tail section below after all shared infrastructure is ready.
        sessionTraceId = `pending-${Date.now()}`;
        logger.info(
          'Session ID not yet available; using provisional ID, dashboard will start early',
        );
      }

      // Create the span objects in Phase A so shutdown always has a valid
      // sessionSpan reference. For the provisional case (pending-{ts}), defer
      // start() to Phase B when the real session ID is known — starting here
      // would emit a ghost span with a placeholder ID to the OTLP backend.
      // SessionSpan.end() guards on started=false, so an unstarted provisional
      // span is a safe no-op on shutdown.
      if (config.otlp.transport !== 'nr-events-api') {
        initMcpTracer();
        const detectedPlatform = createDefaultRegistry().getActive().platformName;
        sessionSpan = new SessionSpan(sessionTraceId, config.developer, detectedPlatform);
        taskSpanTracker = new TaskSpanTracker();
        if (!sessionTraceId.startsWith('pending-')) {
          sessionSpan.start();
        }
      }
    } else {
      // --local: force local mode so config validation skips cloud credentials.
      process.env.NR_AI_MODE = 'local';
      config = loadConfigOrDie(options);

      if (!config.enabled) {
        logger.info('Server disabled via config — exiting');
        process.exit(0);
      }

      // --local has no owning Claude Code session — derive a deterministic
      // identifier so the rest of the codebase can rely on a non-empty
      // sessionTraceId without fabricating a UUID.
      sessionTraceId = `local-${Date.now()}`;
    }

    // Per-session buffer scoping: in --stdio mode the LocalStore is bound to
    // this MCP's resolved session_id so drainBuffer() only sees this session's
    // events. In --local mode (or the provisional window before session ID
    // resolution) we use an unscoped store that drains all session buffers.
    const isProvisional = options.stdio && sessionTraceId.startsWith('pending-');
    const localStore =
      options.stdio && !isProvisional
        ? new LocalStore(config.storagePath, sessionTraceId)
        : new LocalStore(config.storagePath);
    localStore.initialize();

    // Register every --local process in the instance registry, regardless
    // of whether it goes on to win the dashboard port bind — this is what
    // lets `preflight local`/`preflight doctor` see processes that lose the
    // EADDRINUSE race and would otherwise run headless with no visibility.
    if (options.local) {
      localStore.registerLocalInstance(process.argv.slice(1), process.cwd());
    }

    // Every MCP writes its heartbeat once it has bound a session_id so the
    // dashboard owner's GC pass can tell which buffer files still have a live
    // owner. Removed in the shutdown handler below. Skipped during the
    // provisional window — the real heartbeat is written after resolution.
    if (options.stdio && !isProvisional) localStore.writeHeartbeat();
    localStoreForShutdown = localStore;

    // Migrate any pre-existing events from the legacy shared `buffer.jsonl` into
    // per-session files. Idempotent and a no-op on fresh installs.
    try {
      localStore.migrateLegacyBuffer();
    } catch (err) {
      logger.warn('Legacy buffer migration failed (continuing)', { error: String(err) });
    }

    retentionInterval =
      startRetentionSweep({
        storagePath: config.storagePath,
        retainSessionsDays: config.retainSessionsDays,
      }) ?? undefined;

    sessionTracker = new SessionTracker(sessionTraceId);
    const costTracker = new CostTracker(sessionTracker);
    taskDetector = new TaskDetector({ costTracker });
    const antiPatternDetector = new AntiPatternDetector();
    const efficiencyScorer = new EfficiencyScorer();
    const feedbackCollector = new FeedbackCollector();

    const contextWindowTracker = new ContextWindowTracker();
    const latencyTracker = new LatencyTracker();
    const taskCompletionTracker = new TaskCompletionTracker();
    const modelUsageTracker = new ModelUsageTracker();
    const retryDetector = new RetryDetector();
    const contextCompositionTracker = new ContextCompositionTracker();
    const contextTracker = new ContextTrackerRegistry();
    // LatencyDecompositionTracker requires a true LLM-API-vs-tool-execution split.
    // Neither mode observes this: stdio hooks only see Claude Code's own tool
    // calls, and proxy mode's visible "upstream" latency is MCP-server latency
    // (see ApiFailureTracker's comment below), not model-API latency. There is
    // no turn-boundary hook (UserPromptSubmit/Stop) wired either, so even a
    // coarse tool-execution-vs-everything-else split isn't currently derivable.
    // Kept dormant; would need new hook wiring or an LLM-facing proxy to fix for real.
    const latencyDecompositionTracker: LatencyDecompositionTracker | undefined = undefined;
    const decisionTracker = new DecisionTracker({ recordContent: config.recordContent });
    const transcriptMessageTracker = new TranscriptMessageTracker();
    const instructionDriftTracker = new InstructionDriftTracker({
      instructionFilePaths: createDefaultRegistry().getActive().capabilities.instructionFilePaths,
    });
    const toolSelectionScorer = new ToolSelectionScorer();
    const qualityProxyTracker = new QualityProxyTracker();
    // ApiFailureTracker is instantiated but never fed: recordRequest()/recordFailure()
    // require visibility into model-API-level traffic (LLM provider rate limits,
    // timeouts, auth errors), which is not observable in either stdio mode (hooks
    // only see Claude Code's own tool calls) or proxy mode (which forwards to MCP
    // servers, not the model API). Kept dormant for a future LLM-facing proxy.
    const apiFailureTracker = new ApiFailureTracker();
    liveSessionRegistry = new LiveSessionRegistry();
    liveSessionRegistry.startSampling();
    // Unconditional in every mode — decoupled from whether the `--local`
    // dashboard wins its port bind (see startMaintenanceGc()'s doc comment).
    maintenanceGcInterval = startMaintenanceGc({ localStore, liveSessionRegistry });
    const turnCostAttributor = new TurnCostAttributor();
    const turnTracker = new TurnTracker();
    const gitEfficiencyTracker = new GitEfficiencyTracker();
    const workflowRunTracker = new WorkflowRunTracker();
    // Always constructed (cheap, stateless until a client calls one of its
    // report_* tools) so nr_observe_report_tool_call/_session_start/_session_end
    // are available on every --stdio connection, matching docs/ADAPTERS.md's
    // generic-mcp setup instructions.
    const genericMcpAdapter = new GenericMcpAdapter();

    // Read-only filesystem reader for `/api/workflows` routes.
    // Constructed eagerly (not just inside the dashboard block) so when only
    // the stdio MCP is running, the cost tracker still gets per-run lookups
    // when the watcher's reconciliation pass needs them.
    const workflowStoreInstance = new WorkflowStore({
      getCostForRun: (runId) => costTracker.getCostForWorkflowRun(runId),
    });

    // Per-session subagent timeline reader — backs the "agent fan-out"
    // swimlane chart (GET /api/sessions/:sessionId/subagents). On-demand,
    // bounded, and mtime-cached; reads the same subagent JSONL transcripts the
    // watcher tails, but only for the one session the dashboard asks about.
    const subagentTimelineInstance = new SubagentTimelineStore({});

    const toolCallBuffer: import('./storage/types.js').ToolCallRecord[] = [];
    const toolCallBufferAccessor = {
      getRecords: () => toolCallBuffer as readonly import('./storage/types.js').ToolCallRecord[],
    };

    sessionStore = new SessionStore({ storagePath: config.storagePath });
    const currentSessionId = sessionTracker.getMetrics().sessionId;
    let currentRepoName: string | null = null;

    // Hydrate git efficiency tracker with today's prior sessions so the
    // dashboard shows all-day git activity, not just the current session.
    const todaySessions = sessionStore.loadSessionsOverlappingToday();
    for (const session of todaySessions) {
      if (session.sessionId === currentSessionId) continue;
      if (session.timeline && session.timeline.length > 0) {
        gitEfficiencyTracker.replayTimeline(session.timeline);
      }
    }

    // Hydrate instruction-drift tracker with the last 7 days of prior
    // sessions so cross-session prompt-variant correlation has real data
    // from the moment this session starts (mirrors computeHistoricalCosts'
    // weekAgo window below). Sessions persisted before this field existed
    // have instructionPromptHash === null and are naturally excluded.
    const weekAgoForDrift = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const historicalDriftSessions = sessionStore.loadAllSessions({ since: weekAgoForDrift });
    const driftRecords: SessionOutcomeRecord[] = [];
    for (const session of historicalDriftSessions) {
      if (session.sessionId === currentSessionId) continue;
      const record = sessionSummaryToDriftRecord(session);
      if (record) driftRecords.push(record);
    }
    instructionDriftTracker.loadRecords(driftRecords);

    // Also hydrate from git log — commit commands often aren't captured by
    // tool hooks (Claude Code commits internally), so we read the actual
    // repo history to get an accurate commit count for today.
    // Each command is isolated so a slow/missing git or remote doesn't block
    // the others. Uses spawnSync (no shell) to avoid injection; stderr is
    // suppressed via stdio rather than shell redirection. Timeout 2s per call.
    const { spawnSync } = await import('node:child_process');
    const GIT_OPTS = {
      encoding: 'utf-8' as const,
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'],
    };

    // spawnSync with ENOENT doesn't throw — it returns { status: null, error: Error }.
    // The status === 0 guard handles unavailable-git without a try/catch.
    const todayStr = new Date().toISOString().slice(0, 10);
    const logResult = spawnSync(
      'git',
      ['log', `--since=${todayStr}T00:00:00Z`, '--format=%H %ct'],
      GIT_OPTS,
    );
    if (logResult.status === 0 && logResult.stdout !== null) {
      const commits = logResult.stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [hash, epochStr] = line.split(' ');
          return { hash: hash ?? '', timestamp: parseInt(epochStr ?? '0', 10) * 1000 };
        });
      gitEfficiencyTracker.hydrateGitLog(commits);
    }

    // Repo context for the dashboard header
    const remoteResult = spawnSync('git', ['remote', 'get-url', 'origin'], GIT_OPTS);
    const branchResult = spawnSync('git', ['branch', '--show-current'], GIT_OPTS);
    const remoteName = 'origin';
    let defaultBranch = 'main';
    if (remoteResult.status === 0 && branchResult.status === 0) {
      const remoteUrl = remoteResult.stdout.trim();
      const branch = branchResult.stdout.trim();
      // Extract repo name from remote URL (handles both HTTPS and SSH)
      const repoMatch = remoteUrl.match(/[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
      const repoName = repoMatch ? repoMatch[1] : null;
      currentRepoName = repoName;

      const symbolicRefResult = spawnSync(
        'git',
        ['symbolic-ref', '--short', `refs/remotes/${remoteName}/HEAD`],
        GIT_OPTS,
      );
      if (symbolicRefResult.status === 0) {
        defaultBranch = parseDefaultBranchFromSymbolicRef(symbolicRefResult.stdout, remoteName);
      }

      gitEfficiencyTracker.hydrateRepoContext({
        repoName,
        branch: branch || null,
        remoteName,
        defaultBranch,
      });
    }

    // Branch divergence from the real default branch — how far ahead/behind are we?
    const remoteDefaultBranch = `${remoteName}/${defaultBranch}`;
    const aheadResult = spawnSync(
      'git',
      ['rev-list', '--count', `${remoteDefaultBranch}..HEAD`],
      GIT_OPTS,
    );
    const behindResult = spawnSync(
      'git',
      ['rev-list', '--count', `HEAD..${remoteDefaultBranch}`],
      GIT_OPTS,
    );
    if (aheadResult.status === 0 && behindResult.status === 0) {
      const ahead = parseInt(aheadResult.stdout.trim(), 10);
      const behind = parseInt(behindResult.stdout.trim(), 10);
      if (!Number.isNaN(ahead) && !Number.isNaN(behind)) {
        gitEfficiencyTracker.hydrateBranchDivergence(ahead, behind);
      }
    }

    // Cached prior-cost baseline. Refreshed lazily so:
    //   - sessions persisted by other MCPs during this session land in totals
    //   - day rollover invalidates immediately (a long-running session past
    //     midnight previously kept yesterday-as-today bookkeeping forever
    //     because the baseline was computed once at startup)
    //   - cross-midnight prior sessions contribute only their today-portion
    //     (todayPortionOfSessionCost pro-rates by timeline overlap)
    //
    // Cache TTL is 30 s so the disk scan over ~/.newrelic-preflight/sessions/ runs
    // at most twice a minute even when cost-updates fire on every token event.
    const PRIOR_COST_CACHE_TTL_MS = 30_000;
    // Capture a non-null reference so the refresh closures don't have to
    // re-narrow `sessionStore: SessionStore | undefined` on every call.
    const sessionStoreForCostBaseline = sessionStore;
    const priorCostCache = {
      priorDailyCostUsd: 0,
      priorWeeklyCostUsd: 0,
      // Date key used to invalidate on day rollover even mid-TTL.
      lastDayKey: localDateKey(),
      lastRefreshMs: 0,
    };
    const refreshPriorCostBaseline = (): void => {
      const now = Date.now();
      const baseline = computeHistoricalCosts(sessionStoreForCostBaseline, currentSessionId, now);
      priorCostCache.priorDailyCostUsd = baseline.priorDailyCostUsd;
      priorCostCache.priorWeeklyCostUsd = baseline.priorWeeklyCostUsd;
      priorCostCache.lastDayKey = localDateKey(now);
      priorCostCache.lastRefreshMs = now;
    };
    const refreshPriorCostBaselineIfStale = (): void => {
      const now = Date.now();
      const dayChanged = priorCostCache.lastDayKey !== localDateKey(now);
      const expired = now - priorCostCache.lastRefreshMs > PRIOR_COST_CACHE_TTL_MS;
      if (dayChanged || expired) refreshPriorCostBaseline();
    };
    refreshPriorCostBaseline();
    weeklySummaryGenerator = new WeeklySummaryGenerator({
      storagePath: config.storagePath,
      sessionStore,
    });

    const trendAnalyzer = new TrendAnalyzer({ sessionStore });
    const collaborationProfiler = new CollaborationProfiler({ sessionStore });
    const activeInstructionFilePaths =
      createDefaultRegistry().getActive().capabilities.instructionFilePaths;
    const claudeMdTracker = new ClaudeMdTracker({
      sessionStore,
      instructionFilePaths: activeInstructionFilePaths,
    });
    const costPerOutcomeAnalyzer = new CostPerOutcomeAnalyzer();
    const personalCoach = new PersonalCoach(weeklySummaryGenerator, config.developer);
    const promptFeedbackEngine = new PromptFeedbackEngine({
      sessionStore,
      collaborationProfiler,
      claudeMdTracker,
    });
    const recommendationEngine = new RecommendationEngine({
      sessionStore,
      trendAnalyzer,
      collaborationProfiler,
      claudeMdTracker,
      promptFeedbackEngine,
      costPerOutcomeAnalyzer,
      taskDetector,
    });

    const sessionStartMs = Date.now();

    const liveBus = new LiveEventBus();

    const budgetTracker = new BudgetTracker({
      sessionBudgetUsd: config.sessionBudgetUsd,
      dailyBudgetUsd: config.dailyBudgetUsd,
      weeklyBudgetUsd: config.weeklyBudgetUsd,
    });

    // Construct AuditTrailManager once and share it across NrIngestManager and the
    // DashboardServer. In local mode there is no NrIngestManager, but the dashboard
    // and McpServer still need an audit log.
    const auditTrail = new AuditTrailManager({
      developer: config.developer,
      sessionId: sessionTraceId,
      localStore,
    });

    const dashboardEnabled = config.mode === 'local' || config.mode === 'both';
    let alertEngine: LocalAlertEngine | undefined;
    let alertSnapshotCollector: AlertSnapshotCollector | undefined;
    let alertLog: AlertLog | undefined;
    if (dashboardEnabled) {
      const { dirname, resolve: resolvePath, join: joinPath } = await import('node:path');
      // Resolve symlinks (e.g. npm link) before dirname so staticDir points
      // to the actual dist/ directory, not the symlink's parent.
      const entryScript = realpathSync(process.argv[1] ?? process.cwd());
      const here = dirname(entryScript);
      const staticDir = resolvePath(here, 'web');

      // Local alerts: construct engine + log + snapshot collector only when
      // alerts are enabled (default true outside cloud-only mode). Rules are
      // loaded from disk (config.alerts.rulesPath); fs.watch reloads them
      // when the file changes.
      if (config.alerts.enabled) {
        const osNotifier = new OsNotifier();
        alertEngine = new LocalAlertEngine({
          osNotifier,
          osNotificationsEnabled: config.alerts.osNotifications,
        });
        alertLog = new AlertLog({
          path: joinPath(config.storagePath, 'alerts', 'log.jsonl'),
        });
        // Adapter for EfficiencyScorer: collector wants a numeric score or
        // null. Internally use getSessionAverage() rather than adding a new
        // public method on the scorer.
        const efficiencyAdapter = {
          getCurrentScore: (): number | null => efficiencyScorer.getSessionAverage()?.score ?? null,
        };
        alertSnapshotCollector = new AlertSnapshotCollector({
          costTracker,
          // BudgetTracker carries the cumulative daily/weekly totals that
          // feed cost.window alert rules with `today`/`week` periods. Without
          // this dep those rules silently match against 0 forever.
          budgetTracker,
          efficiencyScorer: efficiencyAdapter,
          antiPatternDetector,
          latencyTracker,
        });
        const capturedAlertLog = alertLog;
        alertEngine.setOnAlert((event) => {
          liveBus.emit('alert', event);
          void capturedAlertLog.append(event);
        });

        // Initial rule load and fs.watch wiring. rulesPath is always a
        // resolved string after config load (validateRulesPath falls back
        // to the default when user input is invalid), so no null guard
        // is needed here.
        const rulesPath = config.alerts.rulesPath;
        loadAlertRulesFromDisk(alertEngine, rulesPath);
        try {
          const fs = await import('node:fs');
          // fs.watch on macOS fires twice (write + rename) for many editors;
          // debounce via a 200 ms timer. The watch handle is closed during
          // shutdown.
          alertRulesWatcher = fs.watch(rulesPath, { persistent: false }, () => {
            try {
              if (alertRulesWatchTimer) clearTimeout(alertRulesWatchTimer);
              alertRulesWatchTimer = setTimeout(() => {
                if (alertEngine) {
                  loadAlertRulesFromDisk(alertEngine, rulesPath);
                }
              }, 200);
              alertRulesWatchTimer.unref?.();
            } catch (err) {
              logger.warn('Alert rules watch handler errored', { error: String(err) });
            }
          });
          alertRulesWatcher.on('error', (err) => {
            logger.warn('Alert rules watcher errored', { error: String(err) });
          });
        } catch (err) {
          logger.warn('Could not start fs.watch on alert rules file', {
            rulesPath,
            error: String(err),
          });
        }

        // Periodic evaluation. The interval is unref'd so the Node event
        // loop can exit cleanly during shutdown / when stdin closes.
        const evaluationIntervalMs = config.alerts.evaluationIntervalSeconds * 1000;
        const capturedEngine = alertEngine;
        const capturedCollector = alertSnapshotCollector;
        alertEvaluationInterval = setInterval(() => {
          try {
            const nowTs = Date.now();
            const windows = capturedEngine.getRequiredWindows();
            const snapshot = capturedCollector.snapshot(nowTs, windows);
            capturedEngine.evaluate(snapshot, nowTs);
          } catch (err) {
            logger.warn('Alert evaluation tick failed', { error: String(err) });
          }
        }, evaluationIntervalMs);
        // Don't keep the process alive solely on this interval.
        alertEvaluationInterval.unref?.();
      }

      dashboardServer = new DashboardServer({
        port: config.dashboard.port,
        host: config.dashboard.host,
        bus: liveBus,
        staticDir,
        api: {
          sessionTracker,
          auditTrailManager: auditTrail,
          sessionStore,
          costTracker,
          costForecast: () => {
            const todayKey = localDateKey();
            return buildCostForecastFromInputs({
              sessionSpentUsd: costTracker.getMetrics().sessionTotalCostUsd ?? 0,
              sessionStartMs,
              dailySpentUsd: costTracker.getCostForDay(todayKey),
              dailyFirstActivityMs: costTracker.getFirstActivityMsForDay(todayKey),
            });
          },
          antiPatternDetector,
          weeklySummaryGenerator,
          budgetTracker,
          latencyTracker,
          personalCoach,
          trendAnalyzer,
          alertLog,
          taskDetector,
          efficiencyScorer,
          qualityProxyTracker,
          toolSelectionScorer,
          modelUsageTracker,
          toolCallBuffer: toolCallBufferAccessor,
          liveSessionRegistry,
          gitEfficiencyTracker,
          concurrencyTracker: liveSessionRegistry,
          contextTracker,
          config,
          configFilePath: options.config ?? resolve(DEFAULT_STORAGE_PATH, 'config.json'),
          // eventProcessor isn't assigned until after this object is built —
          // resolve lazily so the diagnostics route sees the real platform
          // once eventProcessor exists, not undefined forever.
          getActivePlatform: () => eventProcessor?.activePlatform,
          // The dashboard owner reads every per-session buffer file in
          // read-only mode for the Today aggregate endpoint.
          // peekAllBuffers() returns HookEvent[] — widen at the boundary
          // so the dashboard tree stays decoupled from storage internals.
          localStore: {
            peekAllBuffers: () =>
              localStore.peekAllBuffers() as unknown as ReadonlyArray<{
                readonly [key: string]: unknown;
              }>,
          },
          // Workflow store reads on-disk wf_*.json rollups so
          // the /api/workflows endpoints work even when the watcher is
          // disabled — dashboard surfaces are functional from day one.
          workflowStore: workflowStoreInstance,
          // Agent fan-out swimlane data for one session (on-demand, bounded,
          // mtime-cached). Wrapped so the dashboard tree only sees the single
          // method it needs.
          subagentTimeline: {
            getSubagentsForSession: (id: string) =>
              subagentTimelineInstance.getSubagentsForSession(id),
            getAgentCalls: (s: string, a: string) => subagentTimelineInstance.getAgentCalls(s, a),
            // Live-run fallback so GET /api/workflows/:runId serves a still-
            // running workflow (no rollup on disk yet) instead of 404ing.
            getRunLive: (runId: string) => subagentTimelineInstance.getRunLive(runId),
          },
          // Wire the observability-health snapshot so GET
          // /api/observability-health returns live watcher state instead of
          // always 503-ing, and /api/cost's `reconciliationDeltaPct` resolves
          // to a real value instead of always null. Read lazily at request time
          // via the `activeSubagentWatcher` binding (this `api` object is built
          // before the watcher is constructed, but getSnapshot only fires on an
          // HTTP request — long after startWatchers() has run).
          //
          // The SubagentWatcher does not expose a public health accessor today,
          // so we report the honest minimum: whether the watcher is active. When
          // it is disabled (binding null) we return a zeroed "disabled" snapshot
          // rather than throw, so the endpoint degrades gracefully. The 1h cost
          // self-check delta is not surfaced through a readable accessor yet, so
          // costSelfCheckDeltaPct is null (honest) — it leaves the dashboard's
          // reconciliation banner hidden until that plumbing lands.
          observabilityHealth: {
            getSnapshot: (): ObservabilityHealthSnapshot => {
              // Read live counters off the SubagentWatcher when it's running.
              // A null binding => watcher disabled (env flag off / wrong mode)
              // => a zeroed "disabled" snapshot. costSelfCheckDeltaPct stays
              // null until the 1h self-check is wired.
              const stats = activeSubagentWatcher?.getHealthStats();
              return {
                watcherActive: activeSubagentWatcher !== null,
                filesWatched: stats?.filesWatched ?? 0,
                parseErrors: stats?.parseErrors ?? 0,
                watcherDisabledByLock: stats?.watcherDisabledByLock ?? false,
                costSelfCheckDeltaPct: null,
              };
            },
          },
        },
        alertEngine,
        alertLog,
      });
      let addr: { address: string; port: number } | undefined;
      try {
        addr = await dashboardServer.start();
      } catch (err) {
        // Multi-instance launch: when several `preflight --stdio`
        // processes start at once (e.g. one per Claude Code session) only
        // the first can bind the dashboard port; the rest receive
        // EADDRINUSE. Treat that case as a graceful no-op so the MCP
        // session still serves stdio + tool handlers; other errors
        // propagate untouched.
        const decision = classifyDashboardStartError(
          err,
          config.dashboard.host,
          config.dashboard.port,
        );
        if (decision.kind === 'rethrow') {
          throw decision.error;
        }
        // In --local mode (e.g. a launchd daemon) EADDRINUSE means the port is
        // owned by a --stdio MCP instance. Instead of exiting fatally, poll
        // until the port is free and take over — same as the --stdio repoll
        // path. This lets the daemon coexist with active Claude Code sessions
        // and seamlessly reclaim the dashboard when sessions end.
        logger.info(decision.message);
        addr = undefined;
      }

      // Capture deps for the post-bind helper. Both the initial-bind path
      // and the re-poll takeover path call this; keeping the closure small
      // ensures the two paths produce identical side effects (PID file,
      // openOnStart warning, etc.). Maintenance GC is unconditional and
      // already running by this point — not part of this helper.
      const postBindDeps: DashboardPostBindDeps = {
        localStore,
        openOnStart: config.dashboard.openOnStart,
        isLocalMode: options.local,
      };
      const runPostBind = (boundAddr: { address: string; port: number }): void =>
        setupDashboardPostBind(boundAddr, postBindDeps);

      if (addr) {
        runPostBind(addr);
      } else {
        // This MCP is headless. Schedule periodic re-bind attempts so it can
        // take over if the current dashboard owner exits. The interval is
        // unref'd and cleared by the shutdown handler.
        dashboardRepollInterval = startDashboardRepoll({
          dashboardServer,
          host: config.dashboard.host,
          port: config.dashboard.port,
          postBind: runPostBind,
          logger,
        });
        // In --local mode the dashboard IS the process — the HTTP listener is
        // the only thing that keeps the event loop alive. When EADDRINUSE fires
        // the listener is never bound, so the repoll interval must be ref'd or
        // Node exits immediately before it ever fires. In --stdio mode stdin
        // acts as the keepalive, so leaving the interval unref'd is correct.
        if (options.local) {
          dashboardRepollInterval.ref?.();
        }
      }
    }

    let capturedNrIngest: NrIngestManager | undefined;
    if (config.mode !== 'local' && !isProvisional) {
      if (!config.licenseKey || !config.accountId) {
        throw new Error(
          'licenseKey and accountId must be defined. ' +
            'This should have been caught by config validation. ' +
            'Check that mode is not "local" or that cloud credentials are configured.',
        );
      }
      nrIngest = new NrIngestManager({
        licenseKey: config.licenseKey,
        transportOptions: {
          accountId: config.accountId,
          collectorHost: config.collectorHost,
        },
        developer: config.developer,
        appName: config.appName,
        teamId: config.teamId,
        projectId: config.projectId,
        orgId: config.orgId,
        sessionTracker,
        localStore,
        auditTrail,
        eventHarvestIntervalMs: config.harvestIntervalMs.events,
        metricHarvestIntervalMs: config.harvestIntervalMs.metrics,
        costTracker,
        efficiencyScorer,
        feedbackCollector,
        turnCostAttributor,
        sessionTraceId,
      });
      capturedNrIngest = nrIngest;
    }

    const capturedAlertEngine = alertEngine;
    const capturedAlertSnapshotCollector = alertSnapshotCollector;
    budgetTracker.setOnThreshold((event) => {
      capturedNrIngest?.ingestBudgetWarning(event);
      logger.warn('Budget threshold reached', {
        period: event.period,
        pct: event.thresholdPct,
        spentUsd: event.spentUsd.toFixed(4),
        budgetUsd: event.budgetUsd.toFixed(2),
      });
      // Route into the local alert engine so configured rules can fire.
      if (capturedAlertEngine) {
        capturedAlertEngine.evaluate(
          {
            timestamp: event.timestamp,
            cost: { sessionUsd: 0, todayUsd: 0, weekUsd: 0 },
            efficiency: { score: null },
            antiPatterns: [],
            latency: [],
            toolFailures: [],
            budgetThresholds: [
              {
                period: event.period,
                thresholdPct: event.thresholdPct,
                spentUsd: event.spentUsd,
                budgetUsd: event.budgetUsd,
              },
            ],
          },
          Date.now(),
        );
      }
    });
    eventProcessor = new HookEventProcessor({
      store: localStore,
      // --local mode and the provisional --stdio window own no specific Claude
      // Code session; drain every per-session buffer so the dashboard sees all
      // live sessions' events. After real session ID resolution the processor
      // is hot-swapped to the scoped store via replaceStore().
      drainAllSessions: !options.stdio || isProvisional,
      onRecord: (rawRecord) => {
        if (!config || !sessionTracker || !taskDetector) {
          logger.warn('onRecord called before full initialization; skipping');
          return;
        }

        // Capture active task ID before recordToolCall may close the current task
        const taskIdBeforeRecord =
          config.otlp.transport !== 'nr-events-api' ? taskDetector.getActiveTaskId() : null;

        sessionTracker.recordToolCall(rawRecord);
        taskDetector.recordToolCall(rawRecord);
        if (rawRecord.sessionId) {
          liveSessionRegistry!.touch(rawRecord.sessionId, rawRecord.cwd as string | undefined);
        }

        if (config.otlp.transport !== 'nr-events-api' && taskSpanTracker && sessionSpan) {
          // Emit tool call span — parent is the active task span (or session span if no task)
          const activeTaskId = taskDetector.getActiveTaskId();
          const parentCtx = taskIdBeforeRecord
            ? taskSpanTracker.getContext(taskIdBeforeRecord, sessionSpan.getContext())
            : sessionSpan.getContext();
          emitToolCallSpan(rawRecord, parentCtx, activeTaskId ?? undefined);

          // Open a task span if a new task was started by this record
          if (activeTaskId !== null && activeTaskId !== taskIdBeforeRecord) {
            taskSpanTracker.openTask(activeTaskId, rawRecord.toolName, sessionSpan.getContext());
          }
        }

        contextWindowTracker.recordToolCall(rawRecord);
        contextTracker.recordToolCall(rawRecord);
        latencyTracker.recordToolCall(rawRecord);
        retryDetector.recordToolCall(rawRecord);
        qualityProxyTracker.recordToolCall(rawRecord);
        const turnId = turnTracker.recordToolCall(rawRecord);
        const turnNumber = turnTracker.getCurrentTurnNumber();
        turnCostAttributor.recordToolCall(rawRecord, turnId);
        decisionTracker.recordToolCall(rawRecord);
        transcriptMessageTracker.observeTranscriptPath(
          rawRecord.transcriptPath as string | undefined,
        );
        instructionDriftTracker.recordToolCall(rawRecord);
        gitEfficiencyTracker.recordToolCall(rawRecord);

        const record: ToolCallRecord = { ...rawRecord, turn_id: turnId, turn_number: turnNumber };

        toolCallBuffer.push(record);

        // Record audit trail unconditionally so the local dashboard's Audit view
        // populates regardless of mode. NrIngestManager (when present) reuses the
        // returned AuditRecord rather than recording a second time.
        const auditRecord = auditTrail.recordToolCall(record);
        capturedNrIngest?.ingestToolCall(record, auditRecord);

        // SSE consumers filter by sessionId for the per-session live tail.
        // Records without a sessionId are legacy buffer entries that surfaced
        // during the migrateLegacyBuffer() window on first boot — skip the
        // live emit rather than fabricate a session by falling back to the
        // MCP's resolved sessionTraceId, which would re-introduce the
        // fictional-session-ID bug the session-ID resolver removed.
        if (record.sessionId) {
          liveBus.emit('tool-call', {
            id: record.id,
            sessionId: record.sessionId,
            tool: record.toolName,
            durationMs: record.durationMs ?? 0,
            costUsd: 0,
            ts: record.timestamp,
          });
        }
        // Push into the alert collector's rolling tool-call buffer so
        // tool.failure rules have data to evaluate against.
        capturedAlertSnapshotCollector?.recordToolCall({
          toolName: record.toolName,
          success: record.success,
          ts: record.timestamp,
        });

        // Fallback cost estimation from tool payload byte sizes.
        // Only fires when no exact token report has been received yet for this session,
        // to avoid double-counting with explicit nr_observe_report_tokens calls.
        const estimateBytes = (record.inputSizeBytes ?? 0) + (record.outputSizeBytes ?? 0);
        if (estimateBytes > 0 && costTracker.getMetrics().reportCount === 0) {
          // Prefer a model already learned from real token events over the config
          // default (which is just a guess). Falls back to config.model on cold start.
          const estimateModel = costTracker.getMetrics().model ?? config.model;
          costTracker.recordEstimatedTokens(
            record.inputSizeBytes ?? 0,
            record.outputSizeBytes ?? 0,
            estimateModel,
          );
        }

        const costMetrics = costTracker.getMetrics();
        if (costMetrics.sessionTotalCostUsd !== null) {
          refreshPriorCostBaselineIfStale();
          const todayKey = localDateKey();
          const sessionTodayUsd = costTracker.getCostForDay(todayKey);
          const dailyFirstActivityMs = costTracker.getFirstActivityMsForDay(todayKey);
          const todayTotalUsd = priorCostCache.priorDailyCostUsd + sessionTodayUsd;
          // Weekly total still uses session-total because the whole session
          // falls within the rolling 7-day window for the prior baseline.
          const weeklyTotalUsd =
            priorCostCache.priorWeeklyCostUsd + costMetrics.sessionTotalCostUsd;
          budgetTracker.updateCost(costMetrics.sessionTotalCostUsd, todayTotalUsd, weeklyTotalUsd);
          const sessionForecast = buildCostForecastFromInputs({
            sessionSpentUsd: costMetrics.sessionTotalCostUsd,
            sessionStartMs,
            dailySpentUsd: sessionTodayUsd,
            dailyFirstActivityMs,
          });
          liveBus.emit('cost-update', {
            // sessionId is always the resolved Claude Code session_id for
            // this MCP instance so cost totals can be attributed per-session.
            sessionId: sessionTraceId,
            sessionTotalUsd: costMetrics.sessionTotalCostUsd,
            todayTotalUsd,
            forecastEodUsd:
              sessionForecast.forecastEndOfDayUsd !== null
                ? priorCostCache.priorDailyCostUsd + sessionForecast.forecastEndOfDayUsd
                : null,
          });
        }

        // Emit any tasks that completed as a result of this record,
        // and detect anti-patterns across each completed task's tool calls
        for (const task of taskDetector.drainNewlyCompletedTasks()) {
          capturedNrIngest?.ingestCodingTask(task);
          taskCompletionTracker.recordTask(task);
          // Close the task span — this handles both signal-driven and idle-timer-driven closures
          if (config.otlp.transport !== 'nr-events-api' && taskSpanTracker) {
            taskSpanTracker.closeTask(task.taskId, task.toolCallCount);
          }
          const firstRecord = task.toolCalls[0];
          // sessionTraceId is the resolved Claude Code session_id and is
          // shared across the whole MCP, so we use it directly rather than
          // peeking at the first record's sessionId (which may be null).
          const context = {
            sessionId: sessionTraceId,
            platform: typeof firstRecord?.platform === 'string' ? firstRecord.platform : undefined,
            taskId: task.taskId,
          };
          const { patterns } = antiPatternDetector.analyze(task.toolCalls);
          efficiencyScorer.computeScore(task, patterns);
          for (const pattern of patterns) {
            capturedNrIngest?.ingestAntiPattern(pattern, context);
            liveBus.emit('anti-pattern', {
              // Tag with the originating session so the Today view can render
              // a "Session: <name>" pill on each alert row.
              sessionId: sessionTraceId,
              type: pattern.type,
              target: pattern.file ?? pattern.command ?? 'unknown',
              count:
                pattern.iterations ??
                pattern.readCount ??
                pattern.repeatCount ??
                pattern.editCount ??
                pattern.agentCount ??
                1,
            });
            // Mirror each detected pattern into the alert collector's
            // rolling buffer so antipattern.count rules have data.
            capturedAlertSnapshotCollector?.recordAntiPattern({
              type: pattern.type,
              ts: Date.now(),
            });
          }
        }
      },
      onTokenEvent: (tokenEvent) => {
        if (!costTracker || !config) return;
        turnCostAttributor.recordTokenEvent(tokenEvent);
        const usage = {
          inputTokens: tokenEvent.inputTokens,
          outputTokens: tokenEvent.outputTokens,
          thinkingTokens: 0,
          cacheReadTokens: tokenEvent.cacheReadTokens,
          cacheCreationTokens: tokenEvent.cacheCreationTokens,
          totalTokens: tokenEvent.inputTokens + tokenEvent.outputTokens,
        };
        const breakdown = costTracker.recordTokenUsage(usage, tokenEvent.model);
        modelUsageTracker.recordUsage(
          tokenEvent.model,
          tokenEvent.inputTokens,
          tokenEvent.outputTokens,
          breakdown.totalUsd,
        );
        contextCompositionTracker.recordTokenEvent(tokenEvent);

        const ctxSnapshot = contextTracker.recordTurn(tokenEvent);
        if (ctxSnapshot && tokenEvent.sessionId) {
          const sid = tokenEvent.sessionId;
          const ctxMetrics = contextTracker.getMetrics(sid);
          const ctxTopTools = ctxMetrics.toolContributions.slice(0, 5);
          liveBus.emit('context-update', {
            sessionId: sid,
            turnNumber: ctxSnapshot.turnNumber,
            totalTokens: ctxSnapshot.inputTokens,
            fillPercent: ctxSnapshot.fillPercent,
            // Carry the model-aware cap so the client renders "X / Y"
            // from a single source of truth — see ContextUpdateEvent
            // doc-comment for the rationale.
            contextWindow: ctxMetrics.contextWindow,
            breakdown: ctxSnapshot.breakdown,
            growth: {
              startTokens: ctxMetrics.growth.startTokens,
              currentTokens: ctxMetrics.growth.currentTokens,
              delta: ctxMetrics.growth.deltaTokens,
            },
            topTools: ctxTopTools.map((t) => ({
              tool: t.tool,
              estimatedTokens: t.estimatedTokens,
            })),
          });
          capturedNrIngest?.ingestContextSnapshot(ctxSnapshot, ctxTopTools);
        }

        const costMetrics = costTracker.getMetrics();
        if (costMetrics.sessionTotalCostUsd !== null) {
          refreshPriorCostBaselineIfStale();
          const todayKey = localDateKey();
          const sessionTodayUsd = costTracker.getCostForDay(todayKey);
          const dailyFirstActivityMs = costTracker.getFirstActivityMsForDay(todayKey);
          const todayTotalUsd = priorCostCache.priorDailyCostUsd + sessionTodayUsd;
          const weeklyTotalUsd =
            priorCostCache.priorWeeklyCostUsd + costMetrics.sessionTotalCostUsd;
          budgetTracker.updateCost(costMetrics.sessionTotalCostUsd, todayTotalUsd, weeklyTotalUsd);
          const sessionForecast = buildCostForecastFromInputs({
            sessionSpentUsd: costMetrics.sessionTotalCostUsd,
            sessionStartMs,
            dailySpentUsd: sessionTodayUsd,
            dailyFirstActivityMs,
          });
          liveBus.emit('cost-update', {
            // Same as the per-tool-call cost-update emission — tag with the
            // MCP's owning session_id for per-session attribution.
            sessionId: sessionTraceId,
            sessionTotalUsd: costMetrics.sessionTotalCostUsd,
            todayTotalUsd,
            forecastEodUsd:
              sessionForecast.forecastEndOfDayUsd !== null
                ? priorCostCache.priorDailyCostUsd + sessionForecast.forecastEndOfDayUsd
                : null,
          });
        }
      },
      // Feed each Agent-tool ToolCallRecord into the workflow tracker
      // so AiWorkflowRun events ship for `run_source='agent_tool'`.
      onWorkflowAgent: (record) => {
        workflowRunTracker.recordToolCall(record);
        // Drain immediately — recordToolCall already pushes the completed run
        // into the drainable queue, so each Agent call yields exactly one
        // AiWorkflowRun event with no harvest-tick latency.
        for (const run of workflowRunTracker.drainCompleted()) {
          capturedNrIngest?.ingestWorkflowRun(run);
        }
      },
      // Subagent JSONL transcripts are the only place per-agent
      // tokens (cache_read 91.5% of total!) are visible. Route through the
      // CostTracker with the entry's `timestamp_ms` as the `ctx.timestampMs`
      // override so cross-midnight runs bucket correctly, AND emit one
      // `AiSubagentTurn` event per turn for NR-side queryability.
      onSubagentTurn: (turn) => {
        if (!costTracker || !config) return;
        const usage: TokenUsage = {
          inputTokens: turn.inputTokens,
          outputTokens: turn.outputTokens,
          // Subagent reasoning tokens (extended thinking) live under
          // `output_tokens_details.reasoning_tokens`; map to `thinkingTokens`
          // so the existing `thinkingPerMTok` rate column charges correctly.
          thinkingTokens: turn.reasoningTokens,
          cacheReadTokens: turn.cacheReadTokens,
          cacheCreationTokens: turn.cacheCreationTokens,
          totalTokens:
            turn.inputTokens +
            turn.outputTokens +
            turn.reasoningTokens +
            turn.cacheReadTokens +
            turn.cacheCreationTokens,
        };
        const breakdown = costTracker.recordTokenUsage(usage, turn.model, {
          timestampMs: turn.timestampMs,
          workflowRunId: turn.workflowRunId,
          agentId: turn.agentId,
        });
        // Pricing miss → usd:null on the wire; we recompute here so
        // the breakdown view distinguishes "0 because pricing absent" from
        // "0 because the turn truly had zero cost".
        const usd = breakdown.totalUsd > 0 ? breakdown.totalUsd : null;
        capturedNrIngest?.ingestSubagentTurn({
          workflow_run_id: turn.workflowRunId,
          agent_id: turn.agentId,
          parent_session_id: turn.parentSessionId,
          message_id: turn.messageId,
          turn_uuid: turn.turnUuid,
          timestamp_ms: turn.timestampMs,
          model: turn.model,
          input_tokens: turn.inputTokens,
          output_tokens: turn.outputTokens,
          cache_creation_tokens: turn.cacheCreationTokens,
          cache_read_tokens: turn.cacheReadTokens,
          reasoning_tokens: turn.reasoningTokens,
          usd,
          stop_reason: turn.stopReason,
          schema_fingerprint: turn.schemaFingerprint,
        });
      },
      onObservabilityHealth: (health) => {
        capturedNrIngest?.ingestObservabilityHealth({
          timestamp: health.timestamp,
          watcher: health.watcher,
          files_watched: health.filesWatched,
          lines_read: health.linesRead,
          bytes_read: health.bytesRead,
          parse_errors: health.parseErrors,
          schema_drifts: health.schemaDrifts,
          last_error: health.lastError,
          ...(health.event ? { event: health.event } : {}),
          ...(health.dimension ? { dimension: health.dimension } : {}),
          ...(health.fingerprint ? { fingerprint: health.fingerprint } : {}),
          ...(health.workflowRunId ? { workflow_run_id: health.workflowRunId } : {}),
          ...(typeof health.costSelfCheckDeltaPct === 'number'
            ? { cost_self_check_delta_pct: health.costSelfCheckDeltaPct }
            : {}),
        });
      },
    });

    persistSession = (opts?: { periodic?: boolean }) => {
      if (!sessionStore || !sessionTracker || !taskDetector || !config) return;
      try {
        transcriptMessageTracker.refresh();
        const summary = buildSessionSummary({
          sessionTracker,
          costTracker,
          taskDetector,
          antiPatternDetector,
          efficiencyScorer,
          transcriptMessageTracker,
          developer: config.developer ?? 'unknown',
          repoName: currentRepoName,
          // A periodic checkpoint is a live, in-progress session — persisting it
          // as 'completed' makes the dashboard render a still-running session as
          // done. Only the terminal (shutdown) save marks it completed.
          outcome: opts?.periodic ? 'in progress' : 'completed',
          platform: eventProcessor?.activePlatform,
          instructionPromptHash: instructionDriftTracker.promptHash,
        });
        const driftRecord = sessionSummaryToDriftRecord(summary);
        if (driftRecord) {
          instructionDriftTracker.recordSessionOutcome(driftRecord);
        }
        // Skip persisting the synthetic session JSON written by --local /
        // proxy modes and the provisional pending-<ts> id. These IDs are
        // MCP-internal bookkeeping; they don't correspond to a real Claude
        // Code session and produce confusing rows in the dashboard history.
        // On the periodic path this is a silent no-op (no log spam while the
        // real session id is still being resolved).
        const isSyntheticId = isSyntheticSessionId(summary.sessionId);
        if (isSyntheticId) {
          if (!opts?.periodic) {
            logger.info('Skipping synthetic session JSON persistence', {
              sessionId: summary.sessionId,
            });
          }
          return;
        }
        sessionStore.saveSession(summary);
        // checkAndGenerateLastWeek() is idempotent (existsSync check before
        // any real work), so calling it on every periodic checkpoint too is
        // cheap — and necessary: it otherwise only ran on the clean-shutdown
        // path, so a SIGKILL (common in containers under memory pressure)
        // after a periodic write meant the weekly summary never ran for that
        // week at all.
        weeklySummaryGenerator?.checkAndGenerateLastWeek();
        if (opts?.periodic) {
          // Lightweight checkpoint: log at debug so the cadence stays quiet.
          logger.debug('Session checkpointed', { sessionId: summary.sessionId });
        } else {
          logger.info('Session saved', { sessionId: summary.sessionId });
        }
      } catch (err) {
        logger.warn('Failed to save session', { error: String(err) });
      }
    };

    eventProcessor.start();

    // Checkpoint the in-progress session to local JSON every 30s so a non-clean
    // exit (crash / SIGKILL) loses at most ~30s of data instead of the whole
    // session. persistSession() no-ops for synthetic / provisional ids, so this
    // is safe to arm immediately. unref'd so it never keeps the process alive.
    const SESSION_PERSIST_INTERVAL_MS = 30_000;
    sessionPersistInterval = setInterval(() => {
      try {
        persistSession?.({ periodic: true });
      } catch (err) {
        logger.warn('Periodic session persist failed', { error: String(err) });
      }
    }, SESSION_PERSIST_INTERVAL_MS);
    sessionPersistInterval.unref?.();

    // Single-mode rule: the watcher runs in `--stdio` mode by default.
    // Opt-in to watcher-in-dashboard via `NR_AI_WATCHER_MODE=local`.
    const watcherMode = (process.env['NR_AI_WATCHER_MODE'] ?? 'stdio').toLowerCase();
    const isStdioWatcher = options.stdio === true;
    const isLocalWatcher = !isStdioWatcher;
    const watcherShouldRun =
      (isStdioWatcher && (watcherMode === 'stdio' || watcherMode === '')) ||
      (isLocalWatcher && watcherMode === 'local');
    // The SubagentWatcher is the ONLY thing that feeds per-agent (subagent)
    // token cost into the CostTracker (via onSubagentTurn → subagentCostUsd).
    // With it off, a session's persisted/headline cost silently excludes ALL
    // subagent spend — which is the majority of agentic cost — so the dashboard
    // shows a per-session total far below the subagent breakdown rendered right
    // below it. It is therefore default-ON; set NR_AI_ENABLE_SUBAGENT_WATCHER=0
    // to opt out. In `--stdio` mode it is scoped to the parent session
    // (parentSessionId filter), so it only ever attributes that session's own
    // subagents — parent tokens (onTokenEvent, parent transcript) and subagent
    // tokens (onSubagentTurn, subagent transcripts) are disjoint, so there is no
    // double count. The WorkflowWatcher stays opt-in (NR_AI_ENABLE_WORKFLOW_WATCHER=1).
    const subagentWatcherEnabled = process.env['NR_AI_ENABLE_SUBAGENT_WATCHER'] !== '0';
    const workflowWatcherEnabled = process.env['NR_AI_ENABLE_WORKFLOW_WATCHER'] === '1';

    // Construct + start the watchers for a given session id. In `--stdio` mode
    // the watchers filter discovered transcript dirs by `parentSessionId`; in
    // `--local` mode they run unfiltered (parentSessionId: undefined). Shared by
    // the initial startup call below and the async re-point call in the
    // provisional-session path so both produce identical wiring — see
    // repointWatchersToRealSession below.
    const startWatchers = (watcherSessionId: string): void => {
      if (watcherShouldRun && subagentWatcherEnabled) {
        activeSubagentWatcher = new SubagentWatcher({
          storagePath: config!.storagePath,
          parentSessionId: isStdioWatcher ? watcherSessionId : undefined,
          // Runtime cost-self-check: a drift > 5% surfaces as an
          // `AiObservabilityHealth { event: 'cost_self_check' }` event. We
          // compare like-with-like from two INDEPENDENT code paths so a
          // regression in either is caught:
          //   - trackedUsd: subagent cost the live CostTracker accumulated from
          //     the onSubagentTurn feed (the headline/persisted path), and
          //   - groundTruthUsd: an independent re-parse of the same session's
          //     subagent transcripts via SubagentTimelineStore (the trace path).
          // Both dedup streaming-duplicate lines by message.id, so a healthy
          // system reads ~0%; any divergence (e.g. one path regressing on dedup
          // or pricing) shows up as a real, non-zero delta. Only meaningful in
          // --stdio mode, where the watcher is scoped to this one session.
          costSelfCheck: () => {
            const trackedUsd = costTracker.getSubagentMetrics().subagentUsd;
            let groundTruthUsd = trackedUsd;
            try {
              const tl = subagentTimelineInstance.getSubagentsForSession(watcherSessionId);
              groundTruthUsd = tl.agents.reduce((sum, a) => sum + (a.usd ?? 0), 0);
            } catch {
              // On any re-parse error fall back to trackedUsd → 0% delta (no
              // false alarm); the error is already surfaced via watcher health.
              groundTruthUsd = trackedUsd;
            }
            return { trackedUsd, groundTruthUsd };
          },
        });
        activeSubagentWatcher.start();
        logger.info('SubagentWatcher started', {
          mode: watcherMode,
          parentSessionId: isStdioWatcher ? watcherSessionId : null,
        });
      }
      if (watcherShouldRun && workflowWatcherEnabled) {
        activeWorkflowWatcher = new WorkflowWatcher({
          storagePath: config!.storagePath,
          parentSessionId: isStdioWatcher ? watcherSessionId : undefined,
          getCostForRun: (runId) => costTracker.getCostForWorkflowRun(runId),
        });
        activeWorkflowWatcher.setOnRun((run) => {
          capturedNrIngest?.ingestScriptWorkflowRun(run);
        });
        activeWorkflowWatcher.setOnHealth((health) => {
          capturedNrIngest?.ingestObservabilityHealth(health);
        });
        activeWorkflowWatcher.start();
        logger.info('WorkflowWatcher started', {
          mode: watcherMode,
          parentSessionId: isStdioWatcher ? watcherSessionId : null,
        });
      }
    };

    // Re-point the watchers from a provisional `pending-<ts>` session id to the
    // resolved real session id. Neither SubagentWatcher nor WorkflowWatcher
    // exposes a parentSessionId setter (the filter is `private readonly`), so we
    // stop the provisionally-scoped instance and reconstruct it scoped to the
    // real id — mirroring the eventProcessor.replaceStore() hot-swap. Only the
    // watchers that were actually started get rebuilt.
    const repointWatchersToRealSession = (realSessionId: string): void => {
      if (activeSubagentWatcher) {
        activeSubagentWatcher.stop();
        activeSubagentWatcher = null;
      }
      if (activeWorkflowWatcher) {
        activeWorkflowWatcher.stop();
        activeWorkflowWatcher = null;
      }
      startWatchers(realSessionId);
    };

    startWatchers(sessionTraceId);

    if (options.stdio) {
      // Wire audit trail into resource handlers (was undefined at createServer() time).
      // Same instance is shared with the DashboardServer and NrIngestManager so all
      // three see the same audit log.
      mcpServer!.auditTrailManager = auditTrail;

      if (isProvisional) {
        // Dashboard is already live. Register pending tools so the MCP can
        // respond to health/config requests while the real session ID resolves.
        const pendingConfigFilePath =
          options.config ?? resolve(DEFAULT_STORAGE_PATH, 'config.json');
        registerPendingTools(mcpServer!.server, {
          sessionStartMs: Date.now(),
          developer: config.developer,
          configSummary: {
            mode: config.mode,
            developer: config.developer,
            accountId: config.accountId ?? null,
            licenseKeyMasked: config.licenseKey ? maskCredential(config.licenseKey) : null,
            nrApiKeyMasked: config.nrApiKey ? maskCredential(config.nrApiKey) : null,
            region: config.collectorHost ?? 'us',
            storagePath: config.storagePath,
            dashboardUrl: `http://${config.dashboard.host}:${config.dashboard.port}`,
            configFilePath: pendingConfigFilePath,
          },
        });
        logger.info('Dashboard started early; awaiting session_id resolution (breadcrumb poll)');

        sessionResolutionAbort = new AbortController();
        void (async () => {
          try {
            const realId = await resolveSessionId({
              storagePath: config!.storagePath,
              signal: sessionResolutionAbort!.signal,
            });

            // Guard against a shutdown that fired while we were awaiting —
            // the signal is aborted but no exception was thrown (e.g. the
            // resolver returned successfully just before abort was set).
            if (sessionResolutionAbort?.signal.aborted) {
              logger.info('Session ID resolution aborted by shutdown (post-await guard)');
              return;
            }

            // Adopt the real session ID without clearing accumulated metrics.
            sessionTraceId = realId;
            sessionTracker!.adoptSessionId(realId);

            // Replace the provisional unscoped LocalStore with the session-scoped one.
            const realLocalStore = new LocalStore(config!.storagePath, realId);
            realLocalStore.initialize();
            realLocalStore.writeHeartbeat();
            localStoreForShutdown = realLocalStore;
            try {
              realLocalStore.migrateLegacyBuffer();
            } catch (err) {
              logger.warn('Legacy buffer migration failed (continuing)', { error: String(err) });
            }

            // Hot-swap the event processor to the scoped store so it only
            // drains this session's events going forward.
            eventProcessor!.replaceStore(realLocalStore, false);

            // Replace the provisional span with a real-ID span. End the
            // provisional one first (end() is a no-op if never started).
            // initMcpTracer() was already called in Phase A — skip it here.
            if (config!.otlp.transport !== 'nr-events-api') {
              sessionSpan?.end(0, 0);
              // Close any task spans opened against the provisional tracker
              // (cross-session events can open them during Phase A) before
              // replacing it with a clean real-session instance.
              taskSpanTracker?.closeAll();
              const detectedPlatform = createDefaultRegistry().getActive().platformName;
              sessionSpan = new SessionSpan(realId, config!.developer, detectedPlatform);
              taskSpanTracker = new TaskSpanTracker();
              sessionSpan.start();
            }

            // Complete NrIngest setup.
            if (config!.mode !== 'local') {
              if (!config!.licenseKey || !config!.accountId) {
                throw new Error(
                  'licenseKey and accountId must be defined for non-local mode. ' +
                    'This should have been caught by config validation.',
                );
              }
              nrIngest = new NrIngestManager({
                licenseKey: config!.licenseKey,
                transportOptions: {
                  accountId: config!.accountId,
                  collectorHost: config!.collectorHost,
                },
                developer: config!.developer,
                appName: config!.appName,
                teamId: config!.teamId,
                projectId: config!.projectId,
                orgId: config!.orgId,
                sessionTracker: sessionTracker!,
                localStore: realLocalStore,
                auditTrail,
                eventHarvestIntervalMs: config!.harvestIntervalMs.events,
                metricHarvestIntervalMs: config!.harvestIntervalMs.metrics,
                costTracker,
                efficiencyScorer,
                feedbackCollector,
                turnCostAttributor,
                sessionTraceId: realId,
              });
              capturedNrIngest = nrIngest;
              nrIngest.start();
            }

            // Re-point the subagent/workflow watchers from the provisional
            // `pending-<ts>` id to the resolved real session id. The watchers
            // were constructed in the startup block with the provisional id and
            // filter discovered transcript dirs by it; a `pending-*` id never
            // matches a real UUID session dir, so without this re-point they
            // capture nothing for the life of the process. Done after the
            // NrIngest reassignment above so the rebuilt WorkflowWatcher's
            // onRun/onHealth closures observe the live `capturedNrIngest`.
            // Guarded inside repoint: only watchers that were actually started
            // are stopped + reconstructed; if none ran this is a no-op.
            repointWatchersToRealSession(realId);

            // Register full tools, replacing the pending handlers.
            const configFilePath = options.config ?? resolve(DEFAULT_STORAGE_PATH, 'config.json');
            const configSummary: ConfigSummary = {
              mode: config!.mode,
              developer: config!.developer,
              accountId: config!.accountId ?? null,
              licenseKeyMasked: config!.licenseKey ? maskCredential(config!.licenseKey) : null,
              nrApiKeyMasked: config!.nrApiKey ? maskCredential(config!.nrApiKey) : null,
              region: config!.collectorHost ?? 'us',
              storagePath: config!.storagePath,
              dashboardUrl: `http://${config!.dashboard.host}:${config!.dashboard.port}`,
              configFilePath,
            };
            registerTools(mcpServer!.server, {
              sessionTracker: sessionTracker!,
              costTracker,
              budgetTracker,
              taskDetector: taskDetector!,
              antiPatternDetector,
              efficiencyScorer,
              feedbackCollector,
              sessionStore,
              weeklySummaryGenerator,
              trendAnalyzer,
              collaborationProfiler,
              claudeMdTracker,
              costPerOutcomeAnalyzer,
              recommendationEngine,
              contextWindowTracker,
              contextTracker,
              latencyTracker,
              taskCompletionTracker,
              modelUsageTracker,
              retryDetector,
              contextCompositionTracker,
              latencyDecompositionTracker,
              decisionTracker,
              instructionDriftTracker,
              toolSelectionScorer,
              toolCallBuffer: toolCallBufferAccessor,
              qualityProxyTracker,
              apiFailureTracker,
              turnCostAttributor,
              turnTracker,
              gitEfficiencyTracker,
              genericMcpAdapter,
              nrIngestManager: nrIngest,
              sessionTraceId: realId,
              sessionStartMs,
              accountId: config!.accountId,
              teamId: config!.teamId,
              projectId: config!.projectId,
              developer: config!.developer,
              nrApiKey: config!.nrApiKey,
              collectorHost: config!.collectorHost,
              configFilePath,
              configSummary,
            });

            logger.info('Session ID resolved, full initialization complete', {
              sessionTraceId: realId,
            });
          } catch (err) {
            // Use the signal's own aborted flag rather than matching the error
            // message string — robust against future changes to the throw site.
            if (sessionResolutionAbort?.signal.aborted) {
              logger.info('Session ID resolution aborted by shutdown');
              return;
            }
            logger.error('Session ID resolution failed; shutting down', { error: String(err) });
            await shutdown();
          }
        })();
      } else {
        // Session ID resolved synchronously — proceed as normal.
        const configFilePath = options.config ?? resolve(DEFAULT_STORAGE_PATH, 'config.json');
        const configSummary: ConfigSummary = {
          mode: config.mode,
          developer: config.developer,
          accountId: config.accountId ?? null,
          licenseKeyMasked: config.licenseKey ? maskCredential(config.licenseKey) : null,
          nrApiKeyMasked: config.nrApiKey ? maskCredential(config.nrApiKey) : null,
          region: config.collectorHost ?? 'us',
          storagePath: config.storagePath,
          dashboardUrl: `http://${config.dashboard.host}:${config.dashboard.port}`,
          configFilePath,
        };
        registerTools(mcpServer!.server, {
          sessionTracker,
          costTracker,
          budgetTracker,
          taskDetector,
          antiPatternDetector,
          efficiencyScorer,
          feedbackCollector,
          sessionStore,
          weeklySummaryGenerator,
          trendAnalyzer,
          collaborationProfiler,
          claudeMdTracker,
          costPerOutcomeAnalyzer,
          recommendationEngine,
          contextWindowTracker,
          contextTracker,
          latencyTracker,
          taskCompletionTracker,
          modelUsageTracker,
          retryDetector,
          contextCompositionTracker,
          latencyDecompositionTracker,
          decisionTracker,
          instructionDriftTracker,
          toolSelectionScorer,
          toolCallBuffer: toolCallBufferAccessor,
          qualityProxyTracker,
          apiFailureTracker,
          turnCostAttributor,
          turnTracker,
          gitEfficiencyTracker,
          genericMcpAdapter,
          nrIngestManager: nrIngest,
          sessionTraceId,
          sessionStartMs,
          accountId: config.accountId,
          teamId: config.teamId,
          projectId: config.projectId,
          developer: config.developer,
          nrApiKey: config.nrApiKey,
          collectorHost: config.collectorHost,
          configFilePath,
          configSummary,
        });

        nrIngest?.start();
        logger.info('Server running on stdio transport');
        // stdin 'end' and 'error' handlers are registered immediately after
        // connectStdio() above so shutdown fires even during session-ID resolution.
      }
    } else {
      logger.info('Server running in local dashboard mode (Ctrl+C to stop)');
      // DashboardServer HTTP listener keeps the process alive.
      // SIGINT/SIGTERM are handled by the global shutdown handler registered above.
    }
  } else {
    // Proxy mode: start HTTP proxy server that forwards to upstream MCP servers
    const config = loadConfigOrDie(options);

    if (!config.enabled) {
      logger.info('Server disabled via config — exiting');
      process.exit(0);
    }

    if (config.proxyUpstreams.length === 0) {
      logger.error(
        'No proxy upstreams configured. Either use --stdio for direct MCP mode ' +
          'or configure proxyUpstreams in the config file.',
      );
      process.exit(1);
    }

    // Proxy mode has no Claude Code session to resolve; use a deterministic
    // identifier instead of randomUUID so we don't fabricate something that
    // looks like a real session id.
    const sessionTraceId = `proxy-${Date.now()}`;

    // Mirror the --stdio/--local gate above: mode: 'local' means no cloud
    // egress by design, so no NrIngestManager is constructed and the proxy
    // callbacks stay local-log-only. For 'cloud'/'both', loadConfigOrDie()
    // has already guaranteed licenseKey/accountId are set (config.ts's
    // load-time validation), so this mirrors that guard rather than
    // re-deriving it.
    if (config.mode !== 'local') {
      if (!config.licenseKey || !config.accountId) {
        throw new Error(
          'licenseKey and accountId must be defined. ' +
            'This should have been caught by config validation. ' +
            'Check that mode is not "local" or that cloud credentials are configured.',
        );
      }
      // Unscoped LocalStore (mirrors --local mode) — proxy mode multiplexes
      // many concurrent clients, so there's no single session id to scope a
      // buffer file to. Passing it into NrIngestManager gives AuditTrailManager
      // a disk backing so the security audit log is actually persisted for
      // proxied traffic instead of silently living in memory only.
      const proxyLocalStore = new LocalStore(config.storagePath);
      proxyLocalStore.initialize();

      nrIngest = new NrIngestManager({
        licenseKey: config.licenseKey,
        transportOptions: {
          accountId: config.accountId,
          collectorHost: config.collectorHost,
        },
        developer: config.developer,
        appName: config.appName,
        teamId: config.teamId,
        projectId: config.projectId,
        orgId: config.orgId,
        sessionTracker: new SessionTracker(sessionTraceId),
        localStore: proxyLocalStore,
        eventHarvestIntervalMs: config.harvestIntervalMs.events,
        metricHarvestIntervalMs: config.harvestIntervalMs.metrics,
        sessionTraceId,
        // Proxy mode has no single coherent session — sessionTracker above is
        // never fed per-client activity, so the ai.session.* gauges would
        // otherwise report one process-wide fake session (e.g. a week-long
        // proxy process reporting duration_ms≈604800000 with file-activity
        // counts stuck at 0). Real per-client attribution instead flows
        // through ProxyToolCallRecord.sessionId (see ProxyManager.resolveSessionId).
        trackSessionGauges: false,
      });
      nrIngest.start();
    }

    const { onToolCall, onRequest } = buildProxyTelemetryCallbacks(nrIngest);

    proxyManager = new ProxyManager({
      port: config.port,
      onToolCall,
      onRequest,
      otlpReceiverEnabled: config.otlp.receiverEnabled,
      otlpReceiverPort: config.otlp.receiverPort,
      otlpReceiverBindAddress: config.otlp.receiverBindAddress,
      otlpForwardEndpoint: config.otlp.forwardEndpoint,
      otlpForwardHeaders: config.otlp.forwardHeaders,
      otlpEnrichmentAttributes: {
        'ai.session.id': sessionTraceId,
        'ai.developer': config.developer,
        ...(config.projectId && { 'ai.project_id': config.projectId }),
        ...(config.teamId && { 'ai.team_id': config.teamId }),
      },
    });

    for (const upstream of config.proxyUpstreams) {
      proxyManager.registerUpstream(upstream);
    }

    try {
      await proxyManager.start();
    } catch (err) {
      logger.error('Failed to start proxy server', { error: String(err) });
      await proxyManager.stop().catch(() => {});
      throw err;
    }
    logger.info('Proxy server running', {
      port: config.port,
      upstreams: proxyManager.getUpstreamNames(),
    });
  }
}

/**
 * Read the rules file from disk, validate it via `parseLocalAlertRules`,
 * and call `engine.loadRules()` with the valid subset. Invalid entries are
 * logged and skipped — one bad rule does not disable the engine. Failures
 * to read or parse the file (e.g. it doesn't exist on first boot, or is
 * mid-write during a watch reload) are non-fatal: the engine simply keeps
 * its previous rule set in that case.
 */
function loadAlertRulesFromDisk(engine: LocalAlertEngine, rulesPath: string): void {
  try {
    let raw: string;
    try {
      raw = readFileSync(rulesPath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.info('Alert rules file not found; engine running with no rules', { rulesPath });
        engine.loadRules([]);
        return;
      }
      throw err;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      logger.warn('Alert rules file has invalid JSON; keeping previous rules', {
        rulesPath,
        error: String(err),
      });
      return;
    }
    const { valid, invalid } = parseLocalAlertRules(json);
    if (invalid.length > 0) {
      logger.warn('Some alert rules failed validation', {
        invalidCount: invalid.length,
        validCount: valid.length,
      });
    }
    // Warn about cost.window rules with today/week period — the snapshot
    // collector only populates sessionUsd, so today/week rules always read 0
    // and never fire. Fires for both explicitly-configured AND defaulted
    // values (default is 'session' but if a rules.json sets
    // 'today' or 'week' explicitly, we still want the user to know it
    // silently no-ops).
    for (const rule of valid) {
      if (rule.type === 'cost.window' && rule.costPeriod !== 'session') {
        logger.warn(
          `Rule '${rule.id}' uses costPeriod='${rule.costPeriod}', which is not yet implemented. ` +
            `The rule will read 0 every cycle and never fire. ` +
            `Use costPeriod='session' until daily/weekly cost aggregation is supported.`,
        );
      }
    }
    engine.loadRules(valid);
    logger.info('Alert rules loaded', { rulesPath, count: valid.length });
  } catch (err) {
    logger.warn('Failed to load alert rules from disk', {
      rulesPath,
      error: String(err),
    });
  }
}

// Compute cost baselines from prior sessions for daily/weekly budget tracking.
//
// Called on every cost-update emission, not just at session start. Three reasons:
//   1) Sessions persisted by other MCP instances during this session need to
//      land in the daily/weekly totals.
//   2) Day rollover — a session running past midnight needs a refreshed
//      "today" baseline. Snapshotting at startup left long-running sessions
//      with stale yesterday-as-today bookkeeping forever.
//   3) Cross-midnight prior sessions need today-portion attribution, not
//      whole-session attribution by startTime. We use timeline-based
//      pro-rating via todayPortionOfSessionCost() so a session that ran
//      11pm→2am only contributes its 2-hour today slice to the daily total.
//
// The current in-flight session is excluded from the prior totals so we don't
// double-count with costTracker.getCostForDay(today) on the caller side.
function computeHistoricalCosts(
  sessionStore: SessionStore,
  currentSessionId: string,
  refTs: number = Date.now(),
): { priorDailyCostUsd: number; priorWeeklyCostUsd: number } {
  const weekAgo = new Date(refTs - 7 * 24 * 60 * 60 * 1000);
  let priorDailyCostUsd = 0;
  let priorWeeklyCostUsd = 0;
  try {
    const sessions = sessionStore.loadAllSessions({ since: weekAgo });
    for (const session of sessions) {
      if (session.sessionId === currentSessionId) continue;
      if (session.estimatedCostUsd === null) continue;
      priorDailyCostUsd += todayPortionOfSessionCost(session, refTs);
      priorWeeklyCostUsd += session.estimatedCostUsd;
    }
  } catch (err) {
    // Non-fatal: fall back to session-only costs if history is unreadable
    logger.warn('Failed to load historical costs — budget thresholds may be inaccurate', {
      error: String(err),
    });
  }
  return { priorDailyCostUsd, priorWeeklyCostUsd };
}

// Only run main() when executed directly (not when imported for testing).
// Resolve symlinks so this also matches when invoked via the `preflight` bin link.
const resolvedArgv1 = (() => {
  try {
    return realpathSync(process.argv[1]);
  } catch {
    return process.argv[1];
  }
})();
if (resolvedArgv1 && /index\.[jt]s$/.test(resolvedArgv1)) {
  main().catch((err: unknown) => {
    logger.error('Fatal error', { error: String(err) });
    process.exit(1);
  });
}
