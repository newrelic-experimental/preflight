#!/usr/bin/env node
import 'dotenv/config';

import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { VERSION, createLogger } from './shared/index.js';
import { createServer } from './server.js';
import { loadMcpConfig, DEFAULT_STORAGE_PATH } from './config.js';
import { ProxyManager } from './proxy/index.js';
import { LocalStore } from './storage/index.js';
import { SessionStore, buildSessionSummary } from './storage/session-store.js';
import { WeeklySummaryGenerator } from './storage/weekly-summary.js';
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
import { ToolSelectionScorer } from './metrics/tool-selection-scorer.js';
import { QualityProxyTracker } from './metrics/quality-proxy-tracker.js';
import { ApiFailureTracker } from './metrics/api-failure-tracker.js';
import { LiveSessionRegistry } from './metrics/live-session-registry.js';
import { TurnCostAttributor } from './metrics/turn-cost-attributor.js';
import { TurnTracker } from './metrics/turn-tracker.js';
import { GitEfficiencyTracker } from './metrics/git-efficiency-tracker.js';
import { NrIngestManager } from './transport/nr-ingest.js';
import { AuditTrailManager } from './security/audit-trail.js';
import { LiveEventBus } from './dashboard/index.js';
import { DashboardServer } from './dashboard/dashboard-server.js';
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
 * Result of evaluating a dashboard-server start error.
 *
 * - kind: 'skip' — EADDRINUSE was observed; caller should drop the dashboard
 *   server reference and continue without binding. The `message` field is a
 *   human-readable INFO-level log line explaining the situation.
 * - kind: 'rethrow' — non-EADDRINUSE error (or non-error value); caller should
 *   re-throw `error` unchanged.
 */
export type DashboardStartFailure =
  | { kind: 'skip'; message: string }
  | { kind: 'rethrow'; error: unknown };

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

/**
 * Side-effects wired up once the dashboard HTTP server has bound the port.
 * Runs on the initial-bind success path and on the re-poll takeover path so
 * a headless MCP that later seizes the dashboard performs the same setup
 * (orphan GC, openOnStart warning) as one that bound on first try.
 *
 * Returns the orphan-GC interval handle so the shutdown path can clear it.
 */
export interface DashboardPostBindDeps {
  readonly localStore: LocalStore;
  readonly liveSessionRegistry: LiveSessionRegistry | undefined;
  readonly openOnStart: boolean;
}

export function setupDashboardPostBind(
  addr: { address: string; port: number },
  deps: DashboardPostBindDeps,
): NodeJS.Timeout {
  const log = createLogger('mcp-cli');
  log.info(`Dashboard ready at http://${addr.address}:${addr.port}`);

  // Only the dashboard owner runs orphan-buffer/breadcrumb GC — running it
  // from every MCP would race with itself and re-archive files repeatedly.
  // Run once at startup, then every 5 minutes. The interval is unref'd so
  // it doesn't keep the event loop alive.
  const { localStore, liveSessionRegistry } = deps;
  const runGc = (): void => {
    try {
      localStore.gcStaleBreadcrumbs();
      const live = localStore.getActiveSessionIdsFromHeartbeats();
      if (liveSessionRegistry) {
        for (const id of liveSessionRegistry.getLiveSessions()) live.add(id);
      }
      localStore.gcOrphanBuffers(live);
    } catch (err) {
      log.warn('GC pass failed', { error: String(err) });
    }
  };
  runGc();
  const interval = setInterval(runGc, 5 * 60 * 1000);
  interval.unref?.();

  // openOnStart is declared in config but auto-open isn't implemented
  // in v1 — log a warning so a user who set it doesn't assume the feature
  // works silently.
  if (deps.openOnStart) {
    log.warn(
      'dashboard.openOnStart is not implemented in v1; the dashboard URL is logged above. ' +
        'Open it manually in your browser.',
    );
  }

  return interval;
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
  readonly postBind: (addr: { address: string; port: number }) => NodeJS.Timeout;
  readonly onTakeover?: (gcInterval: NodeJS.Timeout) => void;
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
        const gcInterval = opts.postBind({ address: addr.address, port: addr.port });
        opts.onTakeover?.(gcInterval);
      } catch (err) {
        const decision = classifyDashboardStartError(err, opts.host, opts.port);
        if (decision.kind === 'rethrow') {
          // Non-EADDRINUSE failure (e.g. permissions) — stop polling. We
          // can't recover by retrying and we don't want to spam the log.
          clearInterval(interval);
          log.warn('Dashboard re-poll stopped after unexpected error', {
            error: String((decision as { error: unknown }).error),
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
] as const;
type SubcommandName = (typeof SUBCOMMAND_NAMES)[number];

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
  if (['install', 'uninstall', 'setup', 'validate', 'update', 'schedule'].includes(sub)) {
    const { runInstallCli } = await import('./install/cli.js');
    await runInstallCli(argv.slice(2));
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
  let persistSession: (() => void) | undefined;
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
  let gcInterval: NodeJS.Timeout | undefined;
  // When this MCP starts headless (EADDRINUSE skip), this interval retries
  // dashboardServer.start() periodically so we can take over if the current
  // owner exits. Cleared in the shutdown handler.
  let dashboardRepollInterval: NodeJS.Timeout | undefined;
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
      if (config?.transport !== 'nr-events-api' && sessionTracker && taskDetector && sessionSpan) {
        taskSpanTracker?.closeAll();
        const stats = sessionTracker.getMetrics();
        const taskMetrics = taskDetector.getMetrics();
        sessionSpan.end(stats.toolCallCount, taskMetrics.totalTasksCompleted);
      }
      if (alertEvaluationInterval) clearInterval(alertEvaluationInterval);
      if (gcInterval) clearInterval(gcInterval);
      if (dashboardRepollInterval) clearInterval(dashboardRepollInterval);
      // Remove this MCP's heartbeat so the next dashboard-owner GC pass
      // doesn't have to mtime-archive our buffer file.
      localStoreForShutdown?.removeHeartbeat();
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

      config = loadMcpConfig(options);

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
      if (config.transport !== 'nr-events-api') {
        initMcpTracer();
        sessionSpan = new SessionSpan(sessionTraceId, config.developer);
        taskSpanTracker = new TaskSpanTracker();
        if (!sessionTraceId.startsWith('pending-')) {
          sessionSpan.start();
        }
      }
    } else {
      // --local: force local mode so config validation skips cloud credentials.
      process.env.NR_AI_MODE = 'local';
      config = loadMcpConfig(options);

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

    // Every MCP writes its heartbeat once it has bound a session_id so the
    // dashboard owner's GC pass can tell which buffer files still have a live
    // owner. Removed in the shutdown handler below. Skipped during the
    // provisional window — the real heartbeat is written after resolution.
    if (options.stdio && !isProvisional) localStore.writeHeartbeat();
    localStoreForShutdown = localStore;

    // Migrate any pre-Fix-3 events from the legacy shared `buffer.jsonl` into
    // per-session files. Idempotent and a no-op on fresh installs.
    try {
      localStore.migrateLegacyBuffer();
    } catch (err) {
      logger.warn('Legacy buffer migration failed (continuing)', { error: String(err) });
    }

    if (config.retainSessionsDays !== null && config.retainSessionsDays > 0) {
      const { purgeOldSessions } = await import('./storage/retention.js');
      const purged = purgeOldSessions(config.storagePath, config.retainSessionsDays);
      if (purged > 0) {
        logger.info('Retention purge complete', { deletedSessionFiles: purged });
      }
    }

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
    // LatencyDecompositionTracker requires turn-level LLM vs tool timing that is
    // only available in proxy mode (where we see upstream response latency). In
    // stdio mode the data cannot be auto-populated so we skip instantiation.
    const latencyDecompositionTracker: LatencyDecompositionTracker | undefined = undefined;
    const decisionTracker = new DecisionTracker();
    const instructionDriftTracker = new InstructionDriftTracker();
    const toolSelectionScorer = new ToolSelectionScorer();
    const qualityProxyTracker = new QualityProxyTracker();
    const apiFailureTracker = new ApiFailureTracker();
    liveSessionRegistry = new LiveSessionRegistry();
    liveSessionRegistry.startSampling();
    const turnCostAttributor = new TurnCostAttributor();
    const turnTracker = new TurnTracker();
    const gitEfficiencyTracker = new GitEfficiencyTracker();

    const toolCallBuffer: import('./storage/types.js').ToolCallRecord[] = [];
    const toolCallBufferAccessor = {
      getRecords: () => toolCallBuffer as readonly import('./storage/types.js').ToolCallRecord[],
    };

    sessionStore = new SessionStore({ storagePath: config.storagePath });
    const currentSessionId = sessionTracker.getMetrics().sessionId;
    let currentRepoName: string | null = null;

    // Hydrate git efficiency tracker with today's prior sessions so the
    // dashboard shows all-day git activity, not just the current session.
    const todaySessions = sessionStore.loadTodaySessions();
    for (const session of todaySessions) {
      if (session.sessionId === currentSessionId) continue;
      if (session.timeline && session.timeline.length > 0) {
        gitEfficiencyTracker.replayTimeline(session.timeline);
      }
    }

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
    if (remoteResult.status === 0 && branchResult.status === 0) {
      const remoteUrl = remoteResult.stdout.trim();
      const branch = branchResult.stdout.trim();
      // Extract repo name from remote URL (handles both HTTPS and SSH)
      const repoMatch = remoteUrl.match(/[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
      const repoName = repoMatch ? repoMatch[1] : null;
      currentRepoName = repoName;
      gitEfficiencyTracker.hydrateRepoContext({
        repoName,
        branch: branch || null,
        remoteName: 'origin',
        defaultBranch: 'main',
      });
    }

    // Branch divergence from main — how far ahead/behind are we?
    const aheadResult = spawnSync('git', ['rev-list', '--count', 'origin/main..HEAD'], GIT_OPTS);
    const behindResult = spawnSync('git', ['rev-list', '--count', 'HEAD..origin/main'], GIT_OPTS);
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
    const claudeMdTracker = new ClaudeMdTracker({ sessionStore });
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
          // The dashboard owner reads every per-session buffer file in
          // read-only mode for the Today aggregate endpoint.
          // peekAllBuffers() returns HookEvent[] — widen at the boundary
          // so the dashboard tree stays decoupled from storage internals.
          localStore: {
            peekAllBuffers: () =>
              localStore.peekAllBuffers() as ReadonlyArray<{ readonly [key: string]: unknown }>,
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
      // ensures the two paths produce identical side effects (GC interval,
      // openOnStart warning, etc.).
      const postBindDeps: DashboardPostBindDeps = {
        localStore,
        liveSessionRegistry,
        openOnStart: config.dashboard.openOnStart,
      };
      const runPostBind = (boundAddr: { address: string; port: number }): NodeJS.Timeout =>
        setupDashboardPostBind(boundAddr, postBindDeps);

      if (addr) {
        gcInterval = runPostBind(addr);
      } else {
        // This MCP is headless. Schedule periodic re-bind attempts so it can
        // take over if the current dashboard owner exits. The interval is
        // unref'd and cleared by the shutdown handler.
        dashboardRepollInterval = startDashboardRepoll({
          dashboardServer,
          host: config.dashboard.host,
          port: config.dashboard.port,
          postBind: runPostBind,
          onTakeover: (handle) => {
            gcInterval = handle;
          },
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
      onRecord: (record) => {
        if (!config || !sessionTracker || !taskDetector) {
          logger.warn('onRecord called before full initialization; skipping');
          return;
        }

        // Capture active task ID before recordToolCall may close the current task
        const taskIdBeforeRecord =
          config.transport !== 'nr-events-api' ? taskDetector.getActiveTaskId() : null;

        sessionTracker.recordToolCall(record);
        taskDetector.recordToolCall(record);
        if (record.sessionId) {
          liveSessionRegistry!.touch(record.sessionId, record.cwd as string | undefined);
        }

        if (config.transport !== 'nr-events-api' && taskSpanTracker && sessionSpan) {
          // Emit tool call span — parent is the active task span (or session span if no task)
          const activeTaskId = taskDetector.getActiveTaskId();
          const parentCtx = taskIdBeforeRecord
            ? taskSpanTracker.getContext(taskIdBeforeRecord, sessionSpan.getContext())
            : sessionSpan.getContext();
          emitToolCallSpan(record, parentCtx, activeTaskId ?? undefined);

          // Open a task span if a new task was started by this record
          if (activeTaskId !== null && activeTaskId !== taskIdBeforeRecord) {
            taskSpanTracker.openTask(activeTaskId, record.toolName, sessionSpan.getContext());
          }
        }

        contextWindowTracker.recordToolCall(record);
        contextTracker.recordToolCall(record);
        latencyTracker.recordToolCall(record);
        retryDetector.recordToolCall(record);
        qualityProxyTracker.recordToolCall(record);
        const turnId = turnTracker.recordToolCall(record);
        const turnNumber = turnTracker.getCurrentTurnNumber();
        turnCostAttributor.recordToolCall(record, turnId);
        decisionTracker.recordToolCall(record);
        instructionDriftTracker.recordToolCall(record);
        gitEfficiencyTracker.recordToolCall(record);

        (record as Record<string, unknown>).turn_id = turnId;
        (record as Record<string, unknown>).turn_number = turnNumber;

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
          if (config.transport !== 'nr-events-api' && taskSpanTracker) {
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
    });

    persistSession = () => {
      if (!sessionStore || !sessionTracker || !taskDetector || !config) return;
      try {
        const summary = buildSessionSummary({
          sessionTracker,
          costTracker,
          taskDetector,
          antiPatternDetector,
          efficiencyScorer,
          developer: config.developer ?? 'unknown',
          repoName: currentRepoName,
        });
        // Skip persisting the synthetic session JSON written by --local /
        // proxy modes. These IDs (local-<ts>, proxy-<ts>) are MCP-internal
        // bookkeeping; they don't correspond to a real Claude Code session
        // and produce confusing `local-...` rows in the dashboard's history
        // view that have no useful content to show.
        const isSyntheticId = isSyntheticSessionId(summary.sessionId);
        if (isSyntheticId) {
          logger.info('Skipping synthetic session JSON persistence', {
            sessionId: summary.sessionId,
          });
        } else {
          sessionStore.saveSession(summary);
          weeklySummaryGenerator?.checkAndGenerateLastWeek();
          logger.info('Session saved', { sessionId: summary.sessionId });
        }
      } catch (err) {
        logger.warn('Failed to save session on shutdown', { error: String(err) });
      }
    };

    eventProcessor.start();
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
            if (config!.transport !== 'nr-events-api') {
              sessionSpan?.end(0, 0);
              // Close any task spans opened against the provisional tracker
              // (cross-session events can open them during Phase A) before
              // replacing it with a clean real-session instance.
              taskSpanTracker?.closeAll();
              sessionSpan = new SessionSpan(realId, config!.developer);
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
                turnCostAttributor,
                sessionTraceId: realId,
              });
              capturedNrIngest = nrIngest;
              nrIngest.start();
            }

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
    const config = loadMcpConfig(options);

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

    proxyManager = new ProxyManager({
      port: config.port,
      onToolCall: (record) => {
        logger.debug('Proxy tool call', {
          server: record.serverName,
          tool: record.toolName,
          durationMs: record.durationMs,
        });
      },
      onRequest: (record) => {
        logger.debug('Proxy request', {
          server: record.serverName,
          method: record.method,
          durationMs: record.durationMs,
        });
      },
      otlpReceiverEnabled: config.otlpReceiverEnabled,
      otlpReceiverPort: config.otlpReceiverPort,
      otlpReceiverBindAddress: config.otlpReceiverBindAddress,
      otlpForwardEndpoint: config.otlpForwardEndpoint,
      otlpForwardHeaders: config.otlpForwardHeaders,
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
