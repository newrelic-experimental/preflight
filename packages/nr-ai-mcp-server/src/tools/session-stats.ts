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
import type { SessionTracker } from '../metrics/session-tracker.js';
import type { CostTracker } from '../metrics/cost-tracker.js';
import type { TaskDetector } from '../metrics/task-detector.js';
import type { AntiPatternDetector } from '../metrics/anti-patterns.js';
import type { EfficiencyScorer } from '../metrics/efficiency-score.js';
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

export function handleGetSessionStats(sessionTracker: SessionTracker) {
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

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    switch (name) {
      case 'nr_observe_get_session_stats':
        if (!sessionTracker) break;
        return handleGetSessionStats(sessionTracker);

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
        return handleGetEfficiencyScore(efficiencyScorer);

      case 'nr_observe_report_feedback': {
        if (!feedbackCollector) break;
        const feedbackArgs = args as unknown as {
          quality: 'good' | 'bad' | 'neutral';
          notes?: string;
          task_id?: string;
        };
        return handleReportFeedback(feedbackCollector, feedbackArgs);
      }
    }

    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  });
}
