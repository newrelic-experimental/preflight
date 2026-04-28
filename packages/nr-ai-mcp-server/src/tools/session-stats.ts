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
import { createLogger } from '@nr-ai-observatory/shared';

const logger = createLogger('session-stats');
import type { SessionTracker } from '../metrics/session-tracker.js';
import type { CostTracker } from '../metrics/cost-tracker.js';
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
import { REPORT_TOKENS_TOOL, handleReportTokens, COST_BREAKDOWN_TOOL, handleGetCostBreakdown } from './cost-tools.js';
import type { TokenReport } from './cost-tools.js';
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
  handleGetSessionHistory,
  handleGetWeeklySummary,
  handleGetTrends,
  handleGetCollaborationProfile,
  handleGetClaudeMdImpact,
  handleGetCostPerOutcome,
  handleGetRecommendations,
  handleGetPlatformComparison,
} from './cross-session-tools.js';

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
  sessionTraceId?: string;
}

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
    sessionTraceId,
  } = options;

  // Build combined tool list
  const tools: typeof SESSION_STATS_TOOL[] = [];
  if (sessionTracker) {
    tools.push(SESSION_STATS_TOOL, SESSION_TIMELINE_TOOL);
  }
  if (costTracker) {
    tools.push(REPORT_TOKENS_TOOL, COST_BREAKDOWN_TOOL);
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

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
    switch (name) {
      case 'nr_observe_get_session_stats':
        if (!sessionTracker) break;
        return handleGetSessionStats(sessionTracker, sessionTraceId);

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
        return handleReportTokens(costTracker, args as unknown as TokenReport);

      case 'nr_observe_get_cost_breakdown':
        if (!costTracker) break;
        return handleGetCostBreakdown(costTracker, taskDetector);

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
        const feedbackArgs = args as unknown as {
          quality: 'good' | 'bad' | 'neutral';
          notes?: string;
          task_id?: string;
        };
        return handleReportFeedback(feedbackCollector, feedbackArgs);
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
