#!/usr/bin/env node
import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { VERSION, createLogger } from './shared/index.js';
import { createServer } from './server.js';
import { loadMcpConfig } from './config.js';
import { ProxyManager } from './proxy/index.js';
import { LocalStore } from './storage/index.js';
import { SessionStore, buildSessionSummary } from './storage/session-store.js';
import { WeeklySummaryGenerator } from './storage/weekly-summary.js';
import { HookEventProcessor } from './hooks/index.js';
import { SessionTracker } from './metrics/session-tracker.js';
import { CostTracker } from './metrics/cost-tracker.js';
import { BudgetTracker } from './metrics/budget-tracker.js';
import { TaskDetector } from './metrics/task-detector.js';
import { AntiPatternDetector } from './metrics/anti-patterns.js';
import { EfficiencyScorer } from './metrics/efficiency-score.js';
import { TrendAnalyzer } from './metrics/trend-analyzer.js';
import { CollaborationProfiler } from './metrics/collaboration-profile.js';
import { ClaudeMdTracker } from './metrics/claudemd-tracker.js';
import { CostPerOutcomeAnalyzer } from './metrics/cost-per-outcome.js';
import { PromptFeedbackEngine } from './metrics/prompt-feedback.js';
import { RecommendationEngine } from './metrics/recommendation-engine.js';
import { ContextWindowTracker } from './metrics/context-window-tracker.js';
import { LatencyTracker } from './metrics/latency-tracker.js';
import { TaskCompletionTracker } from './metrics/task-completion-tracker.js';
import { ModelUsageTracker } from './metrics/model-usage-tracker.js';
import { NrIngestManager } from './transport/nr-ingest.js';
import { FeedbackCollector } from './tools/workflow-tools.js';
import { registerTools } from './tools/session-stats.js';
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

export function parseArgs(argv: string[]): CliOptions {
  const program = new Command();
  program
    .name('nr-ai-mcp-server')
    .description('New Relic MCP server for observing AI coding assistants')
    .version(VERSION)
    .option('-p, --port <number>', 'HTTP port for proxy mode', '9847')
    .option('-c, --config <path>', 'path to config file')
    .option('-l, --log-level <level>', 'log level (debug|info|warn|error)', 'info')
    .option('--stdio', 'use stdio transport (for Claude Code MCP connection)');

  program.parse(argv);
  const opts = program.opts();

  const parsed = parseInt(opts.port, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid port "${opts.port as string}": must be an integer between 1 and 65535`);
  }

  return {
    port: parsed,
    config: opts.config ?? null,
    logLevel: opts.logLevel as CliOptions['logLevel'],
    stdio: opts.stdio ?? false,
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

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down...');
    try {
      persistSession?.();
      if (config?.transport !== 'nr-events-api' && sessionTracker && taskDetector && sessionSpan) {
        taskSpanTracker?.closeAll();
        const stats = sessionTracker.getMetrics();
        const taskMetrics = taskDetector.getMetrics();
        sessionSpan.end(stats.toolCallCount, taskMetrics.totalTasksCompleted);
      }
      eventProcessor?.stop();
      if (nrIngest) await nrIngest.stop();
      if (mcpServer) await mcpServer.close();
      if (proxyManager) await proxyManager.stop();
    } catch (err) {
      logger.error('Error during shutdown cleanup', { error: String(err) });
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (options.stdio) {
    // Connect stdio FIRST so the MCP handshake can complete immediately.
    // Tools are registered after initialization; tool calls before that
    // will return MethodNotFound (which the SDK handles gracefully).
    mcpServer = createServer();
    await mcpServer.connectStdio();

    config = loadMcpConfig(options);
    const sessionTraceId = randomUUID();
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

    sessionStore = new SessionStore({ storagePath: config.storagePath });
    const currentSessionId = sessionTracker.getMetrics().sessionId;
    const { priorDailyCostUsd, priorWeeklyCostUsd } = computeHistoricalCosts(sessionStore, currentSessionId);
    weeklySummaryGenerator = new WeeklySummaryGenerator({
      storagePath: config.storagePath,
      sessionStore,
    });

    const trendAnalyzer = new TrendAnalyzer({ sessionStore });
    const collaborationProfiler = new CollaborationProfiler({ sessionStore });
    const claudeMdTracker = new ClaudeMdTracker({ sessionStore });
    const costPerOutcomeAnalyzer = new CostPerOutcomeAnalyzer();
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

    const budgetTracker = new BudgetTracker({
      sessionBudgetUsd: config.sessionBudgetUsd,
      dailyBudgetUsd: config.dailyBudgetUsd,
      weeklyBudgetUsd: config.weeklyBudgetUsd,
    });

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
      eventHarvestIntervalMs: config.harvestIntervalMs.events,
      metricHarvestIntervalMs: config.harvestIntervalMs.metrics,
      costTracker,
      efficiencyScorer,
      sessionTraceId,
    });

    const capturedNrIngest = nrIngest;

    budgetTracker.setOnThreshold((event) => {
      capturedNrIngest.ingestBudgetWarning(event);
      logger.warn('Budget threshold reached', {
        period: event.period,
        pct: event.thresholdPct,
        spentUsd: event.spentUsd.toFixed(4),
        budgetUsd: event.budgetUsd.toFixed(2),
      });
    });
    eventProcessor = new HookEventProcessor({
      store: localStore,
      onRecord: (record) => {
        if (!config || !sessionTracker || !taskDetector) {
          logger.warn('onRecord called before full initialization; skipping');
          return;
        }

        // Capture active task ID before recordToolCall may close the current task
        const taskIdBeforeRecord = config.transport !== 'nr-events-api'
          ? taskDetector.getActiveTaskId()
          : null;

        sessionTracker.recordToolCall(record);
        taskDetector.recordToolCall(record);

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
        latencyTracker.recordToolCall(record);
        capturedNrIngest.ingestToolCall(record);

        // Fallback cost estimation from tool payload byte sizes.
        // Only fires when no exact token report has been received yet for this session,
        // to avoid double-counting with explicit nr_observe_report_tokens calls.
        const estimateBytes = (record.inputSizeBytes ?? 0) + (record.outputSizeBytes ?? 0);
        if (estimateBytes > 0 && costTracker.getMetrics().reportCount === 0) {
          costTracker.recordEstimatedTokens(
            record.inputSizeBytes ?? 0,
            record.outputSizeBytes ?? 0,
            config.model,
          );
        }

        const costMetrics = costTracker.getMetrics();
        if (costMetrics.sessionTotalCostUsd !== null) {
          budgetTracker.updateCost(
            costMetrics.sessionTotalCostUsd,
            priorDailyCostUsd + costMetrics.sessionTotalCostUsd,
            priorWeeklyCostUsd + costMetrics.sessionTotalCostUsd,
          );
        }

        // Emit any tasks that completed as a result of this record,
        // and detect anti-patterns across each completed task's tool calls
        for (const task of taskDetector.drainNewlyCompletedTasks()) {
          capturedNrIngest.ingestCodingTask(task);
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
            capturedNrIngest.ingestAntiPattern(pattern, context);
          }
        }
      },
    });

    // Wire audit trail into resource handlers (was undefined at createServer() time)
    mcpServer.auditTrailManager = nrIngest.auditTrail;

    // Re-register tools with full dependencies (replaces empty handlers)
    registerTools(mcpServer.server, {
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
      latencyTracker,
      taskCompletionTracker,
      modelUsageTracker,
      sessionTraceId,
      sessionStartMs,
      accountId: config.accountId,
      teamId: config.teamId,
      projectId: config.projectId,
      developer: config.developer,
      nrApiKey: config.nrApiKey,
      collectorHost: config.collectorHost,
      configFilePath: resolve(config.storagePath, 'config.json'),
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
        });
        sessionStore.saveSession(summary);
        weeklySummaryGenerator?.checkAndGenerateLastWeek();
        logger.info('Session saved', { sessionId: summary.sessionId });
      } catch (err) {
        logger.warn('Failed to save session on shutdown', { error: String(err) });
      }
    };

    eventProcessor.start();
    nrIngest.start();
    logger.info('Server running on stdio transport');

    process.stdin.once('end', () => {
      logger.info('stdin closed, shutting down');
      void shutdown();
    });
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

    await proxyManager.start();
    logger.info('Proxy server running', { port: config.port, upstreams: proxyManager.getUpstreamNames() });
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
  } catch {
    // Non-fatal: fall back to session-only costs if history is unreadable
  }
  return { priorDailyCostUsd, priorWeeklyCostUsd };
}

// Only run main() when executed directly (not when imported for testing).
// Resolve symlinks so this also matches when invoked via the `nr-ai-mcp-server` bin link.
import { realpathSync } from 'node:fs';
const resolvedArgv1 = (() => {
  try { return realpathSync(process.argv[1]); } catch { return process.argv[1]; }
})();
if (resolvedArgv1 && /index\.[jt]s$/.test(resolvedArgv1)) {
  main().catch((err: unknown) => {
    logger.error('Fatal error', { error: String(err) });
    process.exit(1);
  });
}
