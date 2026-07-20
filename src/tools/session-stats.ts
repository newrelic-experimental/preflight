/**
 * `registerTools()` — the MCP server's main tool registry. Composes the
 * per-file `registerXTools(deps)` sets from `cost-tools.ts`, `workflow-tools.ts`,
 * `cross-session-tools.ts`, `analytics-tools.ts`, and `extended-analytics-tools.ts`
 * with this file's own "core" tools (health, config, install-hooks, session
 * stats/timeline, git efficiency, cost-per-tool, turn analysis) into the
 * server's single `tools/list`/`tools/call` handler pair — each tool is only
 * advertised when its backing tracker is present, per `tool-registry.ts`.
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from '../shared/index.js';
import { VERSION } from '../version.js';

const logger = createLogger('session-stats');
import type { SessionTracker } from '../metrics/session-tracker.js';
import type { CostTracker } from '../metrics/cost-tracker.js';
import type { BudgetTracker } from '../metrics/budget-tracker.js';
import type { TaskDetector } from '../metrics/task-detector.js';
import type { AntiPatternDetector } from '../metrics/anti-patterns.js';
import type { EfficiencyScorer } from '../metrics/efficiency-score.js';
import type { SessionStore } from '../storage/session-store.js';
import type { WeeklySummaryGenerator } from '../storage/weekly-summary.js';
import type { TrendAnalyzer } from '../metrics/trend-analyzer.js';
import type { CollaborationProfiler } from '../metrics/collaboration-profile.js';
import type { ClaudeMdTracker } from '../metrics/claudemd-tracker.js';
import type { CostPerOutcomeAnalyzer } from '../metrics/cost-per-outcome.js';
import type { RecommendationEngine } from '../metrics/recommendation-engine.js';
import { registerCostTools } from './cost-tools.js';
import { registerWorkflowTools } from './workflow-tools.js';
import type { FeedbackCollector } from './workflow-tools.js';
import { registerCrossSessionTools } from './cross-session-tools.js';
import type { ContextWindowTracker } from '../metrics/context-window-tracker.js';
import type { ContextTrackerRegistry } from '../metrics/context-tracker.js';
import type { LatencyTracker } from '../metrics/latency-tracker.js';
import type { TaskCompletionTracker } from '../metrics/task-completion-tracker.js';
import type { ModelUsageTracker } from '../metrics/model-usage-tracker.js';
import type { RetryDetector } from '../metrics/retry-detector.js';
import type { ContextCompositionTracker } from '../metrics/context-composition-tracker.js';
import type { LatencyDecompositionTracker } from '../metrics/latency-decomposition.js';
import type { DecisionTracker } from '../metrics/decision-tracker.js';
import type { InstructionDriftTracker } from '../metrics/instruction-drift-tracker.js';
import type { ToolSelectionScorer } from '../metrics/tool-selection-scorer.js';
import type { QualityProxyTracker } from '../metrics/quality-proxy-tracker.js';
import type { ApiFailureTracker } from '../metrics/api-failure-tracker.js';
import type { TurnCostAttributor } from '../metrics/turn-cost-attributor.js';
import type { TurnTracker } from '../metrics/turn-tracker.js';
import type { GitEfficiencyTracker } from '../metrics/git-efficiency-tracker.js';
import { registerAnalyticsTools } from './analytics-tools.js';
import { registerExtendedAnalyticsTools } from './extended-analytics-tools.js';
import {
  requireTracker,
  requireAvailable,
  buildToolSet,
  mergeToolSets,
  type RegisteredToolSet,
} from './tool-registry.js';

// ---------------------------------------------------------------------------
// Tool definitions (for tools/list)
// ---------------------------------------------------------------------------

const SESSION_STATS_TOOL = {
  name: 'nr_observe_get_session_stats',
  description:
    'Get current session observability metrics: tool call counts, success rates, file access stats, and duration summaries.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
  annotations: { readOnlyHint: true },
};

const HEALTH_TOOL = {
  name: 'nr_observe_health',
  description:
    'Check server health: version, uptime, session ID, and connection timestamp. Use when the MCP connection feels stale or tools are behaving unexpectedly.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
  annotations: { readOnlyHint: true },
};

const CONFIG_TOOL = {
  name: 'nr_observe_get_config',
  description:
    'Show the current server configuration (sensitive fields masked): mode, developer, account, region, storage path, dashboard URL, and config file location. Use to diagnose misconfiguration without exposing credentials.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
  annotations: { readOnlyHint: true },
};

const SESSION_TIMELINE_TOOL = {
  name: 'nr_observe_get_session_timeline',
  description:
    'Get an ordered list of recent tool calls with timestamps, names, durations, and success/failure status.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      last_n: {
        type: 'number',
        description: 'Number of most recent tool calls to return (default: 20)',
      },
    },
  },
  annotations: { readOnlyHint: true },
};

const COST_PER_TOOL_TOOL = {
  name: 'nr_observe_get_cost_per_tool',
  description:
    'Cost attribution per tool type — approximate, based on turn-level token correlation. Shows which tools cost the most and average cost per call.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
  annotations: { readOnlyHint: true },
};

const TURN_ANALYSIS_TOOL = {
  name: 'nr_observe_get_turn_analysis',
  description:
    'Conversation turn analysis — groups tool calls by AI response, shows parallelism and turn patterns.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
  annotations: { readOnlyHint: true },
};

const INSTALL_HOOKS_TOOL = {
  name: 'nr_observe_install_hooks',
  description:
    'Install PreToolUse and PostToolUse monitoring hooks into ~/.claude/settings.json. ' +
    'Call when nr_observe_health reports hooks_installed: false. ' +
    'Requires a Claude Code restart to activate monitoring.',
  inputSchema: { type: 'object' as const, properties: {} },
  annotations: { readOnlyHint: false },
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function handleGetSessionStats(sessionTracker: SessionTracker, sessionTraceId?: string) {
  const metrics = sessionTracker.getMetrics();

  // Compute average tool duration across all tools
  let totalDurationSum = 0;
  let totalDurationCount = 0;
  for (const stats of Object.values(metrics.toolDurationMsByTool)) {
    totalDurationSum += stats.sum;
    totalDurationCount += stats.count;
  }
  const avgToolDurationMs =
    totalDurationCount > 0 ? Math.round(totalDurationSum / totalDurationCount) : 0;

  const stats = {
    session_trace_id: sessionTraceId ?? null,
    session_id: metrics.sessionId,
    session_name: metrics.sessionName ?? null,
    session_duration_ms: metrics.sessionDurationMs,
    tool_calls: metrics.toolCallCount,
    tool_calls_by_type: metrics.toolCallCountByTool,
    success_rate: metrics.toolSuccessRate,
    failed_calls: metrics.toolErrorCount,
    unique_files_read: metrics.uniqueFilesRead,
    unique_files_modified: metrics.uniqueFilesWritten,
    bash_commands_run: metrics.bashCommandsRun,
    bash_calls_by_category: metrics.bashCallsByCategory,
    search_queries: metrics.searchQueries,
    avg_tool_duration_ms: avgToolDurationMs,
  };

  return {
    _stats: stats, // raw object for callers that need to merge without re-parsing
    content: [{ type: 'text' as const, text: JSON.stringify(stats, null, 2) }],
  };
}

export function handleGetSessionTimeline(sessionTracker: SessionTracker, lastN: number = 20) {
  const metrics = sessionTracker.getMetrics();
  const safeN = Math.max(1, Math.min(Math.floor(lastN), 10_000));
  const entries = metrics.toolCallTimeline.slice(-safeN);

  const timeline = entries.map((entry) => ({
    timestamp: new Date(entry.timestamp).toISOString(),
    tool: entry.toolName,
    duration_ms: entry.durationMs,
    success: entry.success,
  }));

  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ timeline }, null, 2) }],
  };
}

export function handleHealth(options: {
  sessionStartMs?: number;
  developer?: string;
  sessionId?: string;
  hooksInstalledFn?: () => boolean;
}): { content: [{ type: 'text'; text: string }] } {
  const nowMs = Date.now();
  const startMs = options.sessionStartMs ?? nowMs;

  const hooksInstalled =
    options.hooksInstalledFn !== undefined ? options.hooksInstalledFn() : undefined;

  const payload: Record<string, unknown> = {
    status: 'ok',
    version: VERSION,
    developer: options.developer ?? 'unknown',
    session_id: options.sessionId ?? null,
    connected_at: new Date(startMs).toISOString(),
    uptime_seconds: Math.round((nowMs - startMs) / 1000),
  };

  if (hooksInstalled !== undefined) {
    payload.hooks_installed = hooksInstalled;
    payload.setup_required = !hooksInstalled;
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// handleInstallHooks
// ---------------------------------------------------------------------------

export function handleInstallHooks(
  installer: (() => import('../install/headless-install.js').HeadlessInstallResult) | undefined,
): { content: [{ type: 'text'; text: string }]; isError?: true } {
  if (!installer) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ error: 'Hook installer not available in this server mode' }),
        },
      ],
      isError: true,
    };
  }

  const installResult = installer();
  let output: Record<string, unknown>;

  if (installResult.status === 'installed') {
    output = {
      status: 'installed',
      message: `Monitoring hooks installed at ${installResult.settingsPath}. Restart Claude Code to activate tool monitoring.`,
      settings_path: installResult.settingsPath,
    };
  } else if (installResult.status === 'already_installed') {
    output = {
      status: 'already_installed',
      message: 'Hooks are already installed. No changes made.',
      settings_path: installResult.settingsPath,
    };
  } else {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ status: 'error', message: installResult.message }, null, 2),
        },
      ],
      isError: true,
    };
  }

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
  };
}

// ---------------------------------------------------------------------------
// handleGetConfig
// ---------------------------------------------------------------------------

export interface ConfigSummary {
  readonly mode: string;
  readonly developer: string;
  readonly accountId: string | null;
  readonly licenseKeyMasked: string | null;
  readonly nrApiKeyMasked: string | null;
  readonly region: string;
  readonly storagePath: string;
  readonly dashboardUrl: string;
  readonly configFilePath: string;
}

export function handleGetConfig(configSummary: ConfigSummary): {
  content: [{ type: 'text'; text: string }];
} {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(configSummary, null, 2),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Git Efficiency tool definition
// ---------------------------------------------------------------------------

const GIT_EFFICIENCY_TOOL = {
  name: 'nr_observe_get_git_efficiency',
  description:
    'Get Git workflow efficiency metrics: merge conflicts, aborted operations, force pushes, stale branch detection, and actionable suggestions to reduce Git friction.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
  annotations: { readOnlyHint: true },
};

export function handleGetGitEfficiency(tracker: GitEfficiencyTracker): {
  content: [{ type: 'text'; text: string }];
} {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(tracker.getMetrics(), null, 2),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Registration options
// ---------------------------------------------------------------------------

export interface ToolRegistrationOptions {
  sessionTracker?: SessionTracker;
  costTracker?: CostTracker;
  budgetTracker?: BudgetTracker;
  taskDetector?: TaskDetector;
  antiPatternDetector?: AntiPatternDetector;
  efficiencyScorer?: EfficiencyScorer;
  feedbackCollector?: FeedbackCollector;
  sessionStore?: SessionStore;
  weeklySummaryGenerator?: WeeklySummaryGenerator;
  trendAnalyzer?: TrendAnalyzer;
  collaborationProfiler?: CollaborationProfiler;
  claudeMdTracker?: ClaudeMdTracker;
  costPerOutcomeAnalyzer?: CostPerOutcomeAnalyzer;
  recommendationEngine?: RecommendationEngine;
  contextWindowTracker?: ContextWindowTracker;
  contextTracker?: ContextTrackerRegistry;
  latencyTracker?: LatencyTracker;
  taskCompletionTracker?: TaskCompletionTracker;
  modelUsageTracker?: ModelUsageTracker;
  retryDetector?: RetryDetector;
  contextCompositionTracker?: ContextCompositionTracker;
  latencyDecompositionTracker?: LatencyDecompositionTracker;
  decisionTracker?: DecisionTracker;
  instructionDriftTracker?: InstructionDriftTracker;
  toolSelectionScorer?: ToolSelectionScorer;
  toolCallBuffer?: { getRecords(): readonly import('../storage/types.js').ToolCallRecord[] };
  qualityProxyTracker?: QualityProxyTracker;
  apiFailureTracker?: ApiFailureTracker;
  turnCostAttributor?: TurnCostAttributor;
  turnTracker?: TurnTracker;
  gitEfficiencyTracker?: GitEfficiencyTracker;
  sessionTraceId?: string;
  sessionStartMs?: number;
  accountId?: string;
  teamId?: string | null;
  projectId?: string | null;
  developer?: string;
  nrApiKey?: string | null;
  collectorHost?: string | null;
  configFilePath?: string;
  configSummary?: ConfigSummary;
  hooksInstalledFn?: () => boolean;
  headlessInstaller?: () => import('../install/headless-install.js').HeadlessInstallResult;
}

// ---------------------------------------------------------------------------
// Core tools — no natural sibling file (health, config, install-hooks,
// session stats/timeline, git efficiency, cost-per-tool, turn analysis)
// ---------------------------------------------------------------------------

function registerCoreTools(deps: ToolRegistrationOptions): RegisteredToolSet {
  return buildToolSet([
    {
      definition: HEALTH_TOOL,
      available: true,
      handle: () =>
        handleHealth({
          sessionStartMs: deps.sessionStartMs,
          developer: deps.developer,
          sessionId: deps.sessionTracker?.getMetrics().sessionId,
          hooksInstalledFn: deps.hooksInstalledFn,
        }),
    },
    {
      definition: INSTALL_HOOKS_TOOL,
      available: true,
      handle: () => handleInstallHooks(deps.headlessInstaller),
    },
    {
      definition: CONFIG_TOOL,
      available: !!deps.configSummary,
      handle: () => {
        const missing = requireAvailable(!!deps.configSummary, 'Config summary not available');
        if (missing) return missing;
        return handleGetConfig(deps.configSummary!);
      },
    },
    {
      definition: SESSION_STATS_TOOL,
      available: !!deps.sessionTracker,
      handle: () => {
        const check = requireTracker(deps.sessionTracker, 'SessionTracker');
        if (!check.ok) return check.result;
        const { _stats: stats } = handleGetSessionStats(check.value, deps.sessionTraceId);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  identity: {
                    developer: deps.developer ?? 'unknown',
                    teamId: deps.teamId ?? null,
                    projectId: deps.projectId ?? null,
                  },
                  ...stats,
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    },
    {
      definition: SESSION_TIMELINE_TOOL,
      available: !!deps.sessionTracker,
      handle: (args) => {
        const check = requireTracker(deps.sessionTracker, 'SessionTracker');
        if (!check.ok) return check.result;
        const lastN = args?.last_n;
        return handleGetSessionTimeline(check.value, typeof lastN === 'number' ? lastN : 20);
      },
    },
    {
      definition: GIT_EFFICIENCY_TOOL,
      available: !!deps.gitEfficiencyTracker,
      handle: () => {
        const check = requireTracker(deps.gitEfficiencyTracker, 'GitEfficiencyTracker');
        if (!check.ok) return check.result;
        return handleGetGitEfficiency(check.value);
      },
    },
    {
      definition: COST_PER_TOOL_TOOL,
      available: !!deps.turnCostAttributor,
      handle: () => {
        const check = requireTracker(deps.turnCostAttributor, 'TurnCostAttributor');
        if (!check.ok) return check.result;
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(check.value.getMetrics(), null, 2) },
          ],
        };
      },
    },
    {
      definition: TURN_ANALYSIS_TOOL,
      available: !!deps.turnTracker,
      handle: () => {
        const check = requireTracker(deps.turnTracker, 'TurnTracker');
        if (!check.ok) return check.result;
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(check.value.getMetrics(), null, 2) },
          ],
        };
      },
    },
  ]);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Pre-resolution stand-in: registers `tools/list` with just the health and
 * config tools, and a `tools/call` handler that returns a structured "session
 * not yet resolved" error for everything else. Replaced by `registerTools()`
 * once the Claude Code session_id is known.
 */
export function registerPendingTools(
  server: Server,
  options: {
    sessionStartMs?: number;
    developer?: string;
    configSummary?: ConfigSummary;
    hooksInstalledFn?: () => boolean;
    headlessInstaller?: () => import('../install/headless-install.js').HeadlessInstallResult;
  },
): void {
  const tools: Array<typeof HEALTH_TOOL | typeof INSTALL_HOOKS_TOOL> = [
    HEALTH_TOOL,
    INSTALL_HOOKS_TOOL,
  ];
  if (options.configSummary) tools.push(CONFIG_TOOL);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    if (name === 'nr_observe_health') {
      return handleHealth({
        sessionStartMs: options.sessionStartMs,
        developer: options.developer,
        sessionId: undefined,
        hooksInstalledFn: options.hooksInstalledFn,
      });
    }
    if (name === 'nr_observe_get_config' && options.configSummary) {
      return handleGetConfig(options.configSummary);
    }
    if (name === 'nr_observe_install_hooks') {
      return handleInstallHooks(options.headlessInstaller);
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            error: 'session_id not yet resolved',
            hint: 'Make any tool call (Bash, Read, etc.) to write the session breadcrumb. If only nr_observe_health and nr_observe_get_config are still visible after a tool call, exit and start a new Claude Code session — hooks installed during a running session do not take effect until a fresh start.',
          }),
        },
      ],
      isError: true,
    };
  });
}

export function registerTools(server: Server, options: ToolRegistrationOptions): void {
  const { tools, handlers } = mergeToolSets(
    registerCoreTools(options),
    registerCostTools(options),
    registerWorkflowTools(options),
    registerCrossSessionTools(options),
    registerAnalyticsTools(options),
    registerExtendedAnalyticsTools(options),
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    const handler = handlers[name];
    if (!handler) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }

    try {
      return await handler(args);
    } catch (err) {
      if (err instanceof McpError) throw err;
      logger.error('Tool handler threw unexpectedly', {
        tool: name,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
          },
        ],
        isError: true,
      };
    }
  });
}
