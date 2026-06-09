#!/usr/bin/env node
import 'dotenv/config';

import { randomUUID } from 'node:crypto';
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
import { buildCostForecast } from './metrics/cost-forecast.js';
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
import { FeedbackCollector } from './tools/workflow-tools.js';
import { registerTools } from './tools/session-stats.js';
import type { ConfigSummary } from './tools/session-stats.js';
import { initMcpTracer } from './tracing/mcp-tracer.js';
import { SessionSpan } from './tracing/session-span.js';
import { TaskSpanTracker } from './tracing/task-span-tracker.js';
import { emitToolCallSpan } from './tracing/tool-call-span.js';
import type { CliOptions } from './types.js';

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

export function parseArgs(argv: string[]): CliOptions {
  const program = new Command();
  program
    .name('nr-ai-mcp-server')
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
  const options = parseArgs(process.argv);

  // Propagate --log-level into the env var that createLogger() reads.
  // Must be set before any subsystem loggers are constructed.
  process.env.NEW_RELIC_AI_LOG_LEVEL = options.logLevel;

  logger.info('Starting nr-ai-mcp-server', {
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

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down...');
    try {
      // Remove pidfile and port file early so status checks reflect shutdown promptly.
      if (options.local) {
        const { homedir: home } = await import('node:os');
        const { join: joinPath } = await import('node:path');
        const { unlinkSync } = await import('node:fs');
        const stateDir = joinPath(home(), '.nr-ai-observe');
        try {
          unlinkSync(joinPath(stateDir, 'daemon.pid'));
        } catch {
          /* already gone */
        }
        try {
          unlinkSync(joinPath(stateDir, 'daemon.port'));
        } catch {
          /* already gone */
        }
      }
      persistSession?.();
      if (config?.transport !== 'nr-events-api' && sessionTracker && taskDetector && sessionSpan) {
        taskSpanTracker?.closeAll();
        const stats = sessionTracker.getMetrics();
        const taskMetrics = taskDetector.getMetrics();
        sessionSpan.end(stats.toolCallCount, taskMetrics.totalTasksCompleted);
      }
      if (alertEvaluationInterval) clearInterval(alertEvaluationInterval);
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
    let sessionTraceId = randomUUID();
    if (options.stdio) {
      // Connect stdio FIRST so the MCP handshake can complete immediately.
      // Tools are registered after initialization; tool calls before that
      // will return MethodNotFound (which the SDK handles gracefully).
      mcpServer = createServer();
      await mcpServer.connectStdio();

      config = loadMcpConfig(options);
      // sessionTraceId already generated above; log it here once config is loaded
      logger.info('Session trace ID generated', { sessionTraceId });

      if (config.transport !== 'nr-events-api') {
        initMcpTracer();
      }
      sessionSpan = new SessionSpan(sessionTraceId, config.developer);
      taskSpanTracker = new TaskSpanTracker();
      if (config.transport !== 'nr-events-api') {
        sessionSpan.start();
      }

      if (!config.enabled) {
        logger.info('Server disabled via config — exiting');
        await mcpServer.close();
        process.exit(0);
      }
    } else {
      // --local: force local mode so config validation skips cloud credentials.
      process.env.NR_AI_MODE = 'local';
      config = loadMcpConfig(options);

      if (!config.enabled) {
        logger.info('Server disabled via config — exiting');
        process.exit(0);
      }
    }

    const localStore = new LocalStore(config.storagePath, config.hookBufferPath);
    localStore.initialize();

    if (config.retainSessionsDays !== null && config.retainSessionsDays > 0) {
      const { purgeOldSessions } = await import('./storage/retention.js');
      const purged = purgeOldSessions(config.storagePath, config.retainSessionsDays);
      if (purged > 0) {
        logger.info('Retention purge complete', { deletedSessionFiles: purged });
      }
    }

    sessionTracker = new SessionTracker();
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

    const { priorDailyCostUsd, priorWeeklyCostUsd } = computeHistoricalCosts(
      sessionStore,
      currentSessionId,
    );
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
          costForecast: () =>
            buildCostForecast(costTracker.getMetrics().sessionTotalCostUsd ?? 0, sessionStartMs),
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
        },
        alertEngine,
        alertLog,
      });
      let addr;
      try {
        addr = await dashboardServer.start();
      } catch (err) {
        // F-014: rewrap EADDRINUSE with an actionable hint pointing at the
        // env var that overrides the port. Other errors propagate untouched.
        if (
          err &&
          typeof err === 'object' &&
          'code' in err &&
          (err as { code?: string }).code === 'EADDRINUSE'
        ) {
          // Pick a sensible suggestion that always lands inside the valid
          // 1–65535 range. Adjacent ports usually work; if the user is at
          // the top of the range we wrap to 7778 (the documented default
          // alternative). 0 is also valid (ephemeral) but unhelpful as a
          // hint, so avoid suggesting it.
          const port = config.dashboard.port;
          const suggested = port < 65535 ? port + 1 : 7778;
          throw new Error(
            `Dashboard port ${port} is already in use. ` +
              `Set NR_AI_DASHBOARD_PORT to a different port (e.g. ${suggested}) ` +
              `or stop the process using port ${port}.`,
          );
        }
        throw err;
      }
      logger.info(`Dashboard ready at http://${addr.address}:${addr.port}`);

      // Write pidfile and port file so `nr-ai-observe status/stop` can find this process.
      if (options.local) {
        try {
          const { homedir: home } = await import('node:os');
          const { mkdirSync: mkStateDir, writeFileSync: writeState } = await import('node:fs');
          const stateDir = joinPath(home(), '.nr-ai-observe');
          mkStateDir(stateDir, { recursive: true, mode: 0o700 });
          writeState(joinPath(stateDir, 'daemon.pid'), String(process.pid), { mode: 0o600 });
          writeState(joinPath(stateDir, 'daemon.port'), String(addr.port), { mode: 0o600 });
        } catch {
          // Non-fatal — daemon management will fall back to other detection
        }
      }

      // F-013: openOnStart is declared in config but auto-open isn't
      // implemented in v1 — log a warning so a user who set it doesn't
      // assume the feature works silently.
      if (config.dashboard.openOnStart) {
        logger.warn(
          'dashboard.openOnStart is not implemented in v1; the dashboard URL is logged above. ' +
            'Open it manually in your browser.',
        );
      }
    }

    let capturedNrIngest: NrIngestManager | undefined;
    if (config.mode !== 'local') {
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

        liveBus.emit('tool-call', {
          id: record.id,
          tool: record.toolName,
          durationMs: record.durationMs ?? 0,
          costUsd: 0,
          ts: record.timestamp,
        });
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
          budgetTracker.updateCost(
            costMetrics.sessionTotalCostUsd,
            priorDailyCostUsd + costMetrics.sessionTotalCostUsd,
            priorWeeklyCostUsd + costMetrics.sessionTotalCostUsd,
          );
          const sessionForecast = buildCostForecast(
            costMetrics.sessionTotalCostUsd,
            sessionStartMs,
          );
          liveBus.emit('cost-update', {
            sessionTotalUsd: costMetrics.sessionTotalCostUsd,
            todayTotalUsd: priorDailyCostUsd + costMetrics.sessionTotalCostUsd,
            forecastEodUsd:
              sessionForecast.forecastEndOfDayUsd !== null
                ? priorDailyCostUsd + sessionForecast.forecastEndOfDayUsd
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
          const context = {
            sessionId: firstRecord?.sessionId ?? undefined,
            platform: typeof firstRecord?.platform === 'string' ? firstRecord.platform : undefined,
            taskId: task.taskId,
          };
          const { patterns } = antiPatternDetector.analyze(task.toolCalls);
          efficiencyScorer.computeScore(task, patterns);
          for (const pattern of patterns) {
            capturedNrIngest?.ingestAntiPattern(pattern, context);
            liveBus.emit('anti-pattern', {
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
          budgetTracker.updateCost(
            costMetrics.sessionTotalCostUsd,
            priorDailyCostUsd + costMetrics.sessionTotalCostUsd,
            priorWeeklyCostUsd + costMetrics.sessionTotalCostUsd,
          );
          const sessionForecast = buildCostForecast(
            costMetrics.sessionTotalCostUsd,
            sessionStartMs,
          );
          liveBus.emit('cost-update', {
            sessionTotalUsd: costMetrics.sessionTotalCostUsd,
            todayTotalUsd: priorDailyCostUsd + costMetrics.sessionTotalCostUsd,
            forecastEodUsd:
              sessionForecast.forecastEndOfDayUsd !== null
                ? priorDailyCostUsd + sessionForecast.forecastEndOfDayUsd
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
        sessionStore.saveSession(summary);
        weeklySummaryGenerator?.checkAndGenerateLastWeek();
        logger.info('Session saved', { sessionId: summary.sessionId });
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

      // Re-register tools with full dependencies (replaces empty handlers)
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

      process.stdin.once('end', () => {
        logger.info('stdin closed, shutting down');
        void shutdown();
      });
      // ECONNRESET/EPIPE surfaces as an 'error' event on stdin, not 'end'.
      // Without this handler the error propagates as an unhandled exception.
      process.stdin.on('error', (err) => {
        logger.warn('stdin error, shutting down', { error: String(err) });
        void shutdown();
      });
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

    const sessionTraceId = randomUUID();

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
    // Warn about cost.window rules with today/week period — v1.1's snapshot
    // collector only populates sessionUsd, so today/week rules always read 0
    // and never fire. Fires for both explicitly-configured AND defaulted
    // values (default is now 'session' per F-008, but if a rules.json sets
    // 'today' or 'week' explicitly, we still want the user to know it
    // silently no-ops). See F-008 in docs/CODE_REVIEW.md.
    for (const rule of valid) {
      if (rule.type === 'cost.window' && rule.costPeriod !== 'session') {
        logger.warn(
          `Rule '${rule.id}' uses costPeriod='${rule.costPeriod}', which is not implemented in v1.1. ` +
            `The rule will read 0 every cycle and never fire. ` +
            `Use costPeriod='session' until daily/weekly aggregation lands.`,
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
// Called once at session start; the current in-flight session is excluded so costs
// aren't double-counted with the live sessionTotalCostUsd on each tool call.
function computeHistoricalCosts(
  sessionStore: SessionStore,
  currentSessionId: string,
): { priorDailyCostUsd: number; priorWeeklyCostUsd: number } {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  let priorDailyCostUsd = 0;
  let priorWeeklyCostUsd = 0;
  try {
    const sessions = sessionStore.loadAllSessions({ since: weekAgo });
    for (const session of sessions) {
      if (session.sessionId === currentSessionId) continue;
      if (session.estimatedCostUsd === null) continue;
      const sessionDate = new Date(session.startTime).toISOString().slice(0, 10);
      if (sessionDate === todayStr) priorDailyCostUsd += session.estimatedCostUsd;
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
// Resolve symlinks so this also matches when invoked via the `nr-ai-mcp-server` bin link.
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
