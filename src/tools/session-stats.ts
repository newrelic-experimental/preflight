/**
 * MCP tool handlers for session observability and cost tracking.
 *
 * Registers tools based on which trackers are provided:
 *   - nr_observe_get_session_stats  — current session metrics snapshot
 *   - nr_observe_get_session_timeline — recent tool call timeline
 *   - nr_observe_report_tokens — self-report token usage for cost tracking
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
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
import {
  REPORT_TOKENS_TOOL,
  handleReportTokens,
  COST_BREAKDOWN_TOOL,
  handleGetCostBreakdown,
  BUDGET_STATUS_TOOL,
  COST_FORECAST_TOOL,
  handleGetBudgetStatus,
  handleGetCostForecast,
  PROMPT_CACHE_HEALTH_TOOL,
  handleGetPromptCacheHealth,
} from './cost-tools.js';
import {
  WORKFLOW_TRACE_TOOL,
  ANTI_PATTERNS_TOOL,
  EFFICIENCY_SCORE_TOOL,
  REPORT_FEEDBACK_TOOL,
  handleGetWorkflowTrace,
  handleGetAntiPatterns,
  handleGetEfficiencyScore,
  handleReportFeedback,
} from './workflow-tools.js';
import type { FeedbackCollector } from './workflow-tools.js';
import {
  SESSION_HISTORY_TOOL,
  WEEKLY_SUMMARY_TOOL,
  TRENDS_TOOL,
  COLLABORATION_PROFILE_TOOL,
  CLAUDEMD_IMPACT_TOOL,
  COST_PER_OUTCOME_TOOL,
  RECOMMENDATIONS_TOOL,
  PLATFORM_COMPARISON_TOOL,
  TEAM_SUMMARY_TOOL,
  SUBSCRIBE_DIGEST_TOOL,
  UNSUBSCRIBE_DIGEST_TOOL,
  SEND_DIGEST_TOOL,
  PERSONAL_INSIGHTS_TOOL,
  handleGetSessionHistory,
  handleGetWeeklySummary,
  handleGetTrends,
  handleGetCollaborationProfile,
  handleGetClaudeMdImpact,
  handleGetCostPerOutcome,
  handleGetRecommendations,
  handleGetPlatformComparison,
  handleGetTeamSummary,
  handleSubscribeDigest,
  handleUnsubscribeDigest,
  handleSendDigest,
  handleGetPersonalInsights,
} from './cross-session-tools.js';
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
import {
  CONTEXT_EFFICIENCY_TOOL,
  CONTEXT_TRACKING_TOOL,
  LATENCY_PERCENTILES_TOOL,
  TASK_COMPLETION_TOOL,
  MODEL_USAGE_TOOL,
  handleGetContextEfficiency,
  handleGetContextTracking,
  handleGetLatencyPercentiles,
  handleGetTaskCompletionRate,
  handleGetModelUsage,
} from './analytics-tools.js';
import {
  RETRY_ALERTS_TOOL,
  CONTEXT_COMPOSITION_TOOL,
  LATENCY_DECOMPOSITION_TOOL,
  DECISION_TREE_TOOL,
  INSTRUCTION_DRIFT_TOOL,
  TOOL_SELECTION_SCORE_TOOL,
  QUALITY_PROXY_TOOL,
  API_FAILURES_TOOL,
  handleGetRetryAlerts,
  handleGetContextComposition,
  handleGetLatencyDecomposition,
  handleGetDecisionTree,
  handleGetInstructionDrift,
  handleGetToolSelectionScore,
  handleGetQualityProxy,
  handleGetApiFailures,
} from './extended-analytics-tools.js';

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
// Input validation schemas
// ---------------------------------------------------------------------------

const TokenReportSchema = z.object({
  model: z.string().min(1),
  input_tokens: z.number().nonnegative(),
  output_tokens: z.number().nonnegative(),
  cache_creation_tokens: z.number().nonnegative().optional(),
  cache_read_tokens: z.number().nonnegative().optional(),
  thinking_tokens: z.number().nonnegative().optional(),
});

const FeedbackSchema = z.object({
  quality: z.enum(['good', 'bad', 'neutral']),
  task_id: z.string().optional(),
  notes: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * @deprecated Use `registerTools()` instead. Kept for backward compatibility.
 */
export function registerSessionTools(server: Server, sessionTracker: SessionTracker): void {
  registerTools(server, { sessionTracker: sessionTracker });
}

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
  const {
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
    qualityProxyTracker,
    apiFailureTracker,
    turnCostAttributor,
    turnTracker,
    gitEfficiencyTracker,
    sessionTraceId,
    sessionStartMs,
  } = options;

  // Build combined tool list
  const tools: (typeof SESSION_STATS_TOOL)[] = [HEALTH_TOOL];
  tools.push(INSTALL_HOOKS_TOOL);
  if (options.configSummary) {
    tools.push(CONFIG_TOOL);
  }
  if (sessionTracker) {
    tools.push(SESSION_STATS_TOOL, SESSION_TIMELINE_TOOL);
  }
  if (costTracker) {
    tools.push(REPORT_TOKENS_TOOL, COST_BREAKDOWN_TOOL, PROMPT_CACHE_HEALTH_TOOL);
  }
  if (budgetTracker) {
    tools.push(BUDGET_STATUS_TOOL);
  }
  if (costTracker && sessionStartMs !== undefined) {
    tools.push(COST_FORECAST_TOOL);
  }
  if (taskDetector) {
    tools.push(WORKFLOW_TRACE_TOOL);
  }
  if (antiPatternDetector && taskDetector) {
    tools.push(ANTI_PATTERNS_TOOL);
  }
  if (efficiencyScorer) {
    tools.push(EFFICIENCY_SCORE_TOOL);
  }
  if (feedbackCollector) {
    tools.push(REPORT_FEEDBACK_TOOL);
  }

  // Cross-session tools — each registered only when its specific dependencies exist
  if (sessionStore) {
    tools.push(SESSION_HISTORY_TOOL, PLATFORM_COMPARISON_TOOL);
  }
  if (weeklySummaryGenerator) {
    tools.push(WEEKLY_SUMMARY_TOOL);
  }
  if (trendAnalyzer) {
    tools.push(TRENDS_TOOL);
  }
  if (collaborationProfiler) {
    tools.push(COLLABORATION_PROFILE_TOOL);
  }
  if (claudeMdTracker) {
    tools.push(CLAUDEMD_IMPACT_TOOL);
  }
  if (costPerOutcomeAnalyzer && taskDetector) {
    tools.push(COST_PER_OUTCOME_TOOL);
  }
  if (recommendationEngine) {
    tools.push(RECOMMENDATIONS_TOOL);
  }
  if (options.teamId && options.nrApiKey) {
    tools.push(TEAM_SUMMARY_TOOL);
  }
  if (options.configFilePath) {
    tools.push(SUBSCRIBE_DIGEST_TOOL, UNSUBSCRIBE_DIGEST_TOOL);
  }
  if (options.configFilePath && weeklySummaryGenerator) {
    tools.push(SEND_DIGEST_TOOL);
  }
  if (weeklySummaryGenerator && options.developer) {
    tools.push(PERSONAL_INSIGHTS_TOOL);
  }

  if (contextWindowTracker) {
    tools.push(CONTEXT_EFFICIENCY_TOOL);
  }
  if (contextTracker) {
    tools.push(CONTEXT_TRACKING_TOOL);
  }
  if (latencyTracker) {
    tools.push(LATENCY_PERCENTILES_TOOL);
  }
  if (taskCompletionTracker) {
    tools.push(TASK_COMPLETION_TOOL);
  }
  if (modelUsageTracker) {
    tools.push(MODEL_USAGE_TOOL);
  }
  if (retryDetector) {
    tools.push(RETRY_ALERTS_TOOL);
  }
  if (contextCompositionTracker) {
    tools.push(CONTEXT_COMPOSITION_TOOL);
  }
  if (latencyDecompositionTracker) {
    tools.push(LATENCY_DECOMPOSITION_TOOL);
  }
  if (decisionTracker) {
    tools.push(DECISION_TREE_TOOL);
  }
  if (instructionDriftTracker) {
    tools.push(INSTRUCTION_DRIFT_TOOL);
  }
  if (toolSelectionScorer && options.toolCallBuffer) {
    tools.push(TOOL_SELECTION_SCORE_TOOL);
  }
  if (qualityProxyTracker) {
    tools.push(QUALITY_PROXY_TOOL);
  }
  if (apiFailureTracker) {
    tools.push(API_FAILURES_TOOL);
  }
  if (gitEfficiencyTracker) {
    tools.push(GIT_EFFICIENCY_TOOL);
  }
  if (turnCostAttributor) {
    tools.push(COST_PER_TOOL_TOOL);
  }
  if (turnTracker) {
    tools.push(TURN_ANALYSIS_TOOL);
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'nr_observe_health': {
          return handleHealth({
            sessionStartMs,
            developer: options.developer,
            sessionId: sessionTracker?.getMetrics().sessionId,
            hooksInstalledFn: options.hooksInstalledFn,
          });
        }

        case 'nr_observe_install_hooks': {
          return handleInstallHooks(options.headlessInstaller);
        }

        case 'nr_observe_get_config': {
          if (!options.configSummary) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error: 'Config summary not available' }),
                },
              ],
              isError: true,
            };
          }
          return handleGetConfig(options.configSummary);
        }

        case 'nr_observe_get_session_stats': {
          if (!sessionTracker) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error: 'SessionTracker not available' }),
                },
              ],
              isError: true,
            };
          }
          const result = handleGetSessionStats(sessionTracker, sessionTraceId);
          // Use the raw stats object directly to avoid a JSON parse/stringify round-trip.
          const stats = result._stats;
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  {
                    identity: {
                      developer: options.developer ?? 'unknown',
                      teamId: options.teamId ?? null,
                      projectId: options.projectId ?? null,
                    },
                    ...stats,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        case 'nr_observe_get_session_timeline': {
          if (!sessionTracker) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error: 'SessionTracker not available' }),
                },
              ],
              isError: true,
            };
          }
          const lastN = args?.last_n;
          return handleGetSessionTimeline(sessionTracker, typeof lastN === 'number' ? lastN : 20);
        }

        case 'nr_observe_report_tokens': {
          if (!costTracker) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error: 'CostTracker not available' }),
                },
              ],
              isError: true,
            };
          }
          try {
            const tokenReport = TokenReportSchema.parse(args);
            return handleReportTokens(costTracker, tokenReport, modelUsageTracker);
          } catch (err) {
            const message =
              err instanceof z.ZodError
                ? err.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')
                : String(err);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error: `Invalid token report: ${message}` }),
                },
              ],
              isError: true,
            };
          }
        }

        case 'nr_observe_get_cost_breakdown': {
          if (!costTracker) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error: 'CostTracker not available' }),
                },
              ],
              isError: true,
            };
          }
          return handleGetCostBreakdown(costTracker, taskDetector);
        }

        case 'nr_observe_get_prompt_cache_health': {
          if (!costTracker) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error: 'CostTracker not available' }),
                },
              ],
              isError: true,
            };
          }
          return handleGetPromptCacheHealth(costTracker);
        }

        case 'nr_observe_get_budget_status': {
          if (!budgetTracker) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error: 'BudgetTracker not available' }),
                },
              ],
              isError: true,
            };
          }
          return handleGetBudgetStatus(budgetTracker);
        }

        case 'nr_observe_get_cost_forecast': {
          if (!costTracker || sessionStartMs === undefined) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error: 'CostTracker or sessionStartMs not available' }),
                },
              ],
              isError: true,
            };
          }
          return handleGetCostForecast(costTracker, sessionStartMs);
        }

        case 'nr_observe_get_workflow_trace': {
          if (!taskDetector) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error: 'TaskDetector not available' }),
                },
              ],
              isError: true,
            };
          }
          const taskId = args?.task_id as string | undefined;
          return handleGetWorkflowTrace(
            taskDetector,
            antiPatternDetector,
            efficiencyScorer,
            taskId,
          );
        }

        case 'nr_observe_get_anti_patterns': {
          if (!antiPatternDetector || !taskDetector) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    error: 'AntiPatternDetector or TaskDetector not available',
                  }),
                },
              ],
              isError: true,
            };
          }
          return handleGetAntiPatterns(taskDetector, antiPatternDetector);
        }

        case 'nr_observe_get_efficiency_score': {
          if (!efficiencyScorer) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error: 'EfficiencyScorer not available' }),
                },
              ],
              isError: true,
            };
          }
          return handleGetEfficiencyScore(efficiencyScorer, taskDetector, antiPatternDetector);
        }

        case 'nr_observe_report_feedback': {
          if (!feedbackCollector) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error: 'FeedbackCollector not available' }),
                },
              ],
              isError: true,
            };
          }
          try {
            const feedbackArgs = FeedbackSchema.parse(args);
            return handleReportFeedback(feedbackCollector, feedbackArgs);
          } catch (err) {
            const message =
              err instanceof z.ZodError
                ? err.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')
                : String(err);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error: `Invalid feedback: ${message}` }),
                },
              ],
              isError: true,
            };
          }
        }

        case 'nr_observe_get_session_history': {
          if (!sessionStore) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error: 'SessionStore not available' }),
                },
              ],
              isError: true,
            };
          }
          const historyArgs: Record<string, unknown> = args ?? {};
          return handleGetSessionHistory(sessionStore, {
            since: historyArgs.since as string | undefined,
            developer: historyArgs.developer as string | undefined,
            limit: historyArgs.limit as number | undefined,
          });
        }

        case 'nr_observe_get_weekly_summary': {
          if (!weeklySummaryGenerator) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error: 'WeeklySummaryGenerator not available' }),
                },
              ],
              isError: true,
            };
          }
          const weekArgs: Record<string, unknown> = args ?? {};
          return handleGetWeeklySummary(weeklySummaryGenerator, {
            week: weekArgs.week as string | undefined,
          });
        }

        case 'nr_observe_get_trends': {
          if (!trendAnalyzer) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error: 'TrendAnalyzer not available' }),
                },
              ],
              isError: true,
            };
          }
          const trendArgs: Record<string, unknown> = args ?? {};
          return handleGetTrends(trendAnalyzer, {
            metric: trendArgs.metric as string | undefined,
            developer: trendArgs.developer as string | undefined,
            weeks: trendArgs.weeks as number | undefined,
          });
        }

        case 'nr_observe_get_collaboration_profile': {
          if (!collaborationProfiler) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error: 'CollaborationProfiler not available' }),
                },
              ],
              isError: true,
            };
          }
          const profileArgs: Record<string, unknown> = args ?? {};
          return handleGetCollaborationProfile(collaborationProfiler, {
            developer: profileArgs.developer as string | undefined,
          });
        }

        case 'nr_observe_get_claudemd_impact': {
          if (!claudeMdTracker) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error: 'ClaudeMdTracker not available' }),
                },
              ],
              isError: true,
            };
          }
          return handleGetClaudeMdImpact(claudeMdTracker);
        }

        case 'nr_observe_get_cost_per_outcome': {
          if (!costPerOutcomeAnalyzer || !taskDetector) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    error: 'CostPerOutcomeAnalyzer or TaskDetector not available',
                  }),
                },
              ],
              isError: true,
            };
          }
          const costArgs: Record<string, unknown> = args ?? {};
          return handleGetCostPerOutcome(costPerOutcomeAnalyzer, taskDetector, {
            since: costArgs.since as string | undefined,
          });
        }

        case 'nr_observe_get_recommendations': {
          if (!recommendationEngine) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error: 'RecommendationEngine not available' }),
                },
              ],
              isError: true,
            };
          }
          const recArgs: Record<string, unknown> = args ?? {};
          return handleGetRecommendations(recommendationEngine, {
            developer: recArgs.developer as string | undefined,
            topN: recArgs.topN as number | undefined,
          });
        }

        case 'nr_observe_get_platform_comparison': {
          if (!sessionStore) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error: 'SessionStore not available' }),
                },
              ],
              isError: true,
            };
          }
          const pcArgs: Record<string, unknown> = args ?? {};
          return handleGetPlatformComparison(sessionStore, {
            metric: pcArgs.metric as string | undefined,
            weeks: pcArgs.weeks as number | undefined,
          });
        }

        case 'nr_observe_get_team_summary': {
          if (!options.teamId || !options.nrApiKey) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error: 'teamId or nrApiKey not configured' }),
                },
              ],
              isError: true,
            };
          }
          const summaryArgs: Record<string, unknown> = args ?? {};
          return handleGetTeamSummary({
            teamId: options.teamId,
            accountId: options.accountId ?? '',
            nrApiKey: options.nrApiKey,
            collectorHost: options.collectorHost,
            since: summaryArgs.since as string | undefined,
          });
        }

        case 'nr_observe_subscribe_digest': {
          if (!options.configFilePath) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error: 'configFilePath not available' }),
                },
              ],
              isError: true,
            };
          }
          const digestArgs: Record<string, unknown> = args ?? {};
          return handleSubscribeDigest(
            typeof digestArgs.webhookUrl === 'string' ? digestArgs.webhookUrl : '',
            options.configFilePath,
          );
        }

        case 'nr_observe_unsubscribe_digest': {
          if (!options.configFilePath) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error: 'configFilePath not available' }),
                },
              ],
              isError: true,
            };
          }
          return handleUnsubscribeDigest(options.configFilePath);
        }

        case 'nr_observe_send_digest': {
          if (!options.configFilePath || !weeklySummaryGenerator) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    error: 'configFilePath or WeeklySummaryGenerator not available',
                  }),
                },
              ],
              isError: true,
            };
          }
          return handleSendDigest(weeklySummaryGenerator, options.configFilePath);
        }

        case 'nr_observe_get_personal_insights': {
          if (!weeklySummaryGenerator || !options.developer) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    error: 'WeeklySummaryGenerator or developer not available',
                  }),
                },
              ],
              isError: true,
            };
          }
          return handleGetPersonalInsights(weeklySummaryGenerator, options.developer);
        }

        case 'nr_observe_get_context_efficiency': {
          if (!contextWindowTracker) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error: 'ContextWindowTracker not available' }),
                },
              ],
              isError: true,
            };
          }
          return handleGetContextEfficiency(contextWindowTracker);
        }

        case 'nr_observe_get_context_tracking': {
          if (!contextTracker) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error: 'ContextTracker not available' }),
                },
              ],
              isError: true,
            };
          }
          return handleGetContextTracking(contextTracker);
        }

        case 'nr_observe_get_latency_percentiles': {
          if (!latencyTracker) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error: 'LatencyTracker not available' }),
                },
              ],
              isError: true,
            };
          }
          return handleGetLatencyPercentiles(latencyTracker);
        }

        case 'nr_observe_get_task_completion_rate': {
          if (!taskCompletionTracker) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error: 'TaskCompletionTracker not available' }),
                },
              ],
              isError: true,
            };
          }
          return handleGetTaskCompletionRate(taskCompletionTracker, taskDetector);
        }

        case 'nr_observe_get_model_usage': {
          if (!modelUsageTracker) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error: 'ModelUsageTracker not available' }),
                },
              ],
              isError: true,
            };
          }
          return handleGetModelUsage(modelUsageTracker);
        }

        case 'nr_observe_get_retry_alerts': {
          if (!retryDetector) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error: 'RetryDetector not available' }),
                },
              ],
              isError: true,
            };
          }
          return handleGetRetryAlerts(retryDetector);
        }

        case 'nr_observe_get_context_composition': {
          if (!contextCompositionTracker) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error: 'ContextCompositionTracker not available' }),
                },
              ],
              isError: true,
            };
          }
          return handleGetContextComposition(contextCompositionTracker);
        }

        case 'nr_observe_get_latency_decomposition': {
          if (!latencyDecompositionTracker) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    error: 'nr_observe_get_latency_decomposition is not currently functional',
                    note: "Preflight cannot observe a true LLM-API-vs-tool-execution split in either stdio or proxy mode -- see the comment above the tracker's instantiation in index.ts for the full explanation. This tool is intentionally not registered in tools/list.",
                  }),
                },
              ],
              isError: true,
            };
          }
          return handleGetLatencyDecomposition(latencyDecompositionTracker);
        }

        case 'nr_observe_get_decision_tree': {
          if (!decisionTracker) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error: 'DecisionTracker not available' }),
                },
              ],
              isError: true,
            };
          }
          const dtArgs: Record<string, unknown> = args ?? {};
          return handleGetDecisionTree(decisionTracker, dtArgs.post_mortem === true);
        }

        case 'nr_observe_get_instruction_drift': {
          if (!instructionDriftTracker) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error: 'InstructionDriftTracker not available' }),
                },
              ],
              isError: true,
            };
          }
          return handleGetInstructionDrift(instructionDriftTracker);
        }

        case 'nr_observe_get_tool_selection_score': {
          if (!toolSelectionScorer || !options.toolCallBuffer) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    error: 'ToolSelectionScorer or toolCallBuffer not available',
                  }),
                },
              ],
              isError: true,
            };
          }
          return handleGetToolSelectionScore(
            toolSelectionScorer,
            options.toolCallBuffer.getRecords(),
          );
        }

        case 'nr_observe_get_quality_proxy': {
          if (!qualityProxyTracker) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error: 'QualityProxyTracker not available' }),
                },
              ],
              isError: true,
            };
          }
          return handleGetQualityProxy(qualityProxyTracker);
        }

        case 'nr_observe_get_api_failures': {
          if (!apiFailureTracker) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error: 'ApiFailureTracker not available' }),
                },
              ],
              isError: true,
            };
          }
          return handleGetApiFailures(apiFailureTracker);
        }

        case 'nr_observe_get_cost_per_tool': {
          if (!turnCostAttributor) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error: 'TurnCostAttributor not available' }),
                },
              ],
              isError: true,
            };
          }
          const costMetrics = turnCostAttributor.getMetrics();
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(costMetrics, null, 2) }],
          };
        }

        case 'nr_observe_get_turn_analysis': {
          if (!turnTracker) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error: 'TurnTracker not available' }),
                },
              ],
              isError: true,
            };
          }
          const turnMetrics = turnTracker.getMetrics();
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(turnMetrics, null, 2) }],
          };
        }

        case 'nr_observe_get_git_efficiency': {
          if (!gitEfficiencyTracker) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error: 'GitEfficiencyTracker not available' }),
                },
              ],
              isError: true,
            };
          }
          return handleGetGitEfficiency(gitEfficiencyTracker);
        }

        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
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
