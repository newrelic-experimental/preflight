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
import type { LatencyTracker } from '../metrics/latency-tracker.js';
import type { TaskCompletionTracker } from '../metrics/task-completion-tracker.js';
import type { ModelUsageTracker } from '../metrics/model-usage-tracker.js';
import {
  CONTEXT_EFFICIENCY_TOOL,
  LATENCY_PERCENTILES_TOOL,
  TASK_COMPLETION_TOOL,
  MODEL_USAGE_TOOL,
  handleGetContextEfficiency,
  handleGetLatencyPercentiles,
  handleGetTaskCompletionRate,
  handleGetModelUsage,
} from './analytics-tools.js';

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
  const avgToolDurationMs = totalDurationCount > 0
    ? Math.round(totalDurationSum / totalDurationCount)
    : 0;

  const stats = {
    session_trace_id: sessionTraceId ?? null,
    session_id: metrics.sessionId,
    session_duration_ms: metrics.sessionDurationMs,
    tool_calls: metrics.toolCallCount,
    tool_calls_by_type: metrics.toolCallCountByTool,
    success_rate: metrics.toolSuccessRate,
    failed_calls: metrics.toolErrorCount,
    unique_files_read: metrics.uniqueFilesRead,
    unique_files_modified: metrics.uniqueFilesWritten,
    bash_commands_run: metrics.bashCommandsRun,
    search_queries: metrics.searchQueries,
    avg_tool_duration_ms: avgToolDurationMs,
  };

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(stats, null, 2) }],
  };
}

export function handleGetSessionTimeline(
  sessionTracker: SessionTracker,
  lastN: number = 20,
) {
  const metrics = sessionTracker.getMetrics();
  const entries = metrics.toolCallTimeline.slice(-lastN);

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
  latencyTracker?: LatencyTracker;
  taskCompletionTracker?: TaskCompletionTracker;
  modelUsageTracker?: ModelUsageTracker;
  sessionTraceId?: string;
  sessionStartMs?: number;
  accountId?: string;
  teamId?: string | null;
  projectId?: string | null;
  developer?: string;
  nrApiKey?: string | null;
  collectorHost?: string | null;
  configFilePath?: string;
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
export function registerSessionTools(
  server: Server,
  sessionTracker: SessionTracker,
): void {
  registerTools(server, { sessionTracker });
}

export function registerTools(
  server: Server,
  options: ToolRegistrationOptions,
): void {
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
    latencyTracker,
    taskCompletionTracker,
    modelUsageTracker,
    sessionTraceId,
    sessionStartMs,
  } = options;

  // Build combined tool list
  const tools: typeof SESSION_STATS_TOOL[] = [];
  if (sessionTracker) {
    tools.push(SESSION_STATS_TOOL, SESSION_TIMELINE_TOOL);
  }
  if (costTracker) {
    tools.push(REPORT_TOKENS_TOOL, COST_BREAKDOWN_TOOL);
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
  if (latencyTracker) {
    tools.push(LATENCY_PERCENTILES_TOOL);
  }
  if (taskCompletionTracker) {
    tools.push(TASK_COMPLETION_TOOL);
  }
  if (modelUsageTracker) {
    tools.push(MODEL_USAGE_TOOL);
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
    switch (name) {
      case 'nr_observe_get_session_stats': {
        if (!sessionTracker) break;
        const result = handleGetSessionStats(sessionTracker, sessionTraceId);
        const stats = JSON.parse(result.content[0].text as string) as Record<string, unknown>;
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              identity: {
                developer: options.developer ?? 'unknown',
                teamId: options.teamId ?? null,
                projectId: options.projectId ?? null,
              },
              ...stats,
            }, null, 2),
          }],
        };
      }

      case 'nr_observe_get_session_timeline': {
        if (!sessionTracker) break;
        const lastN = (args as Record<string, unknown> | undefined)?.last_n;
        return handleGetSessionTimeline(
          sessionTracker,
          typeof lastN === 'number' ? lastN : 20,
        );
      }

      case 'nr_observe_report_tokens':
        if (!costTracker) break;
        try {
          const tokenReport = TokenReportSchema.parse(args);
          return handleReportTokens(costTracker, tokenReport, modelUsageTracker);
        } catch (err) {
          const message = err instanceof z.ZodError
            ? err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')
            : String(err);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: `Invalid token report: ${message}` }) }],
            isError: true,
          };
        }

      case 'nr_observe_get_cost_breakdown':
        if (!costTracker) break;
        return handleGetCostBreakdown(costTracker, taskDetector);

      case 'nr_observe_get_budget_status':
        if (!budgetTracker) break;
        return handleGetBudgetStatus(budgetTracker);

      case 'nr_observe_get_cost_forecast':
        if (!costTracker || sessionStartMs === undefined) break;
        return handleGetCostForecast(costTracker, sessionStartMs);

      case 'nr_observe_get_workflow_trace': {
        if (!taskDetector) break;
        const taskId = (args as Record<string, unknown> | undefined)?.task_id as string | undefined;
        return handleGetWorkflowTrace(taskDetector, antiPatternDetector, efficiencyScorer, taskId);
      }

      case 'nr_observe_get_anti_patterns':
        if (!antiPatternDetector || !taskDetector) break;
        return handleGetAntiPatterns(taskDetector, antiPatternDetector);

      case 'nr_observe_get_efficiency_score':
        if (!efficiencyScorer) break;
        return handleGetEfficiencyScore(efficiencyScorer, taskDetector, antiPatternDetector);

      case 'nr_observe_report_feedback': {
        if (!feedbackCollector) break;
        try {
          const feedbackArgs = FeedbackSchema.parse(args);
          return handleReportFeedback(feedbackCollector, feedbackArgs);
        } catch (err) {
          const message = err instanceof z.ZodError
            ? err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')
            : String(err);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: `Invalid feedback: ${message}` }) }],
            isError: true,
          };
        }
      }

      // Cross-session tools
      case 'nr_observe_get_session_history': {
        if (!sessionStore) break;
        const historyArgs = (args ?? {}) as Record<string, unknown>;
        return handleGetSessionHistory(sessionStore, {
          since: historyArgs.since as string | undefined,
          developer: historyArgs.developer as string | undefined,
          limit: historyArgs.limit as number | undefined,
        });
      }

      case 'nr_observe_get_weekly_summary': {
        if (!weeklySummaryGenerator) break;
        const weekArgs = (args ?? {}) as Record<string, unknown>;
        return handleGetWeeklySummary(weeklySummaryGenerator, {
          week: weekArgs.week as string | undefined,
        });
      }

      case 'nr_observe_get_trends': {
        if (!trendAnalyzer) break;
        const trendArgs = (args ?? {}) as Record<string, unknown>;
        return handleGetTrends(trendAnalyzer, {
          metric: trendArgs.metric as string | undefined,
          developer: trendArgs.developer as string | undefined,
          weeks: trendArgs.weeks as number | undefined,
        });
      }

      case 'nr_observe_get_collaboration_profile': {
        if (!collaborationProfiler) break;
        const profileArgs = (args ?? {}) as Record<string, unknown>;
        return handleGetCollaborationProfile(collaborationProfiler, {
          developer: profileArgs.developer as string | undefined,
        });
      }

      case 'nr_observe_get_claudemd_impact':
        if (!claudeMdTracker) break;
        return handleGetClaudeMdImpact(claudeMdTracker);

      case 'nr_observe_get_cost_per_outcome': {
        if (!costPerOutcomeAnalyzer || !taskDetector) break;
        const costArgs = (args ?? {}) as Record<string, unknown>;
        return handleGetCostPerOutcome(costPerOutcomeAnalyzer, taskDetector, {
          since: costArgs.since as string | undefined,
        });
      }

      case 'nr_observe_get_recommendations': {
        if (!recommendationEngine) break;
        const recArgs = (args ?? {}) as Record<string, unknown>;
        return handleGetRecommendations(recommendationEngine, {
          developer: recArgs.developer as string | undefined,
          topN: recArgs.topN as number | undefined,
        });
      }

      case 'nr_observe_get_platform_comparison': {
        if (!sessionStore) break;
        const pcArgs = (args ?? {}) as Record<string, unknown>;
        return handleGetPlatformComparison(sessionStore, {
          metric: pcArgs.metric as string | undefined,
          weeks: pcArgs.weeks as number | undefined,
        });
      }

      case 'nr_observe_get_team_summary': {
        if (!options.teamId || !options.nrApiKey) break;
        const summaryArgs = (args ?? {}) as Record<string, unknown>;
        return handleGetTeamSummary({
          teamId: options.teamId,
          accountId: options.accountId ?? '',
          nrApiKey: options.nrApiKey,
          collectorHost: options.collectorHost,
          since: summaryArgs.since as string | undefined,
        });
      }

      case 'nr_observe_subscribe_digest': {
        if (!options.configFilePath) break;
        const digestArgs = (args ?? {}) as Record<string, unknown>;
        return handleSubscribeDigest(
          typeof digestArgs.webhookUrl === 'string' ? digestArgs.webhookUrl : '',
          options.configFilePath,
        );
      }

      case 'nr_observe_unsubscribe_digest': {
        if (!options.configFilePath) break;
        return handleUnsubscribeDigest(options.configFilePath);
      }

      case 'nr_observe_send_digest': {
        if (!options.configFilePath || !weeklySummaryGenerator) break;
        return handleSendDigest(weeklySummaryGenerator, options.configFilePath);
      }

      case 'nr_observe_get_personal_insights':
        if (!weeklySummaryGenerator || !options.developer) break;
        return handleGetPersonalInsights(weeklySummaryGenerator, options.developer);

      case 'nr_observe_get_context_efficiency':
        if (!contextWindowTracker) break;
        return handleGetContextEfficiency(contextWindowTracker);

      case 'nr_observe_get_latency_percentiles':
        if (!latencyTracker) break;
        return handleGetLatencyPercentiles(latencyTracker);

      case 'nr_observe_get_task_completion_rate':
        if (!taskCompletionTracker) break;
        return handleGetTaskCompletionRate(taskCompletionTracker, taskDetector);

      case 'nr_observe_get_model_usage':
        if (!modelUsageTracker) break;
        return handleGetModelUsage(modelUsageTracker);
    }

    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    } catch (err) {
      if (err instanceof McpError) throw err;
      logger.error('Tool handler threw unexpectedly', {
        tool: name,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }],
        isError: true,
      };
    }
  });
}
