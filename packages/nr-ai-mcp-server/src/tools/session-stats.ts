/**
 * MCP tool handlers for session observability data.
 *
 * Registers two read-only tools:
 *   - nr_observe_get_session_stats  — current session metrics snapshot
 *   - nr_observe_get_session_timeline — recent tool call timeline
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import type { SessionTracker } from '../metrics/session-tracker.js';

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
// Registration
// ---------------------------------------------------------------------------

export function registerSessionTools(
  server: Server,
  sessionTracker: SessionTracker,
): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [SESSION_STATS_TOOL, SESSION_TIMELINE_TOOL],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    switch (name) {
      case 'nr_observe_get_session_stats':
        return handleGetSessionStats(sessionTracker);

      case 'nr_observe_get_session_timeline': {
        const lastN = (args as Record<string, unknown> | undefined)?.last_n;
        return handleGetSessionTimeline(
          sessionTracker,
          typeof lastN === 'number' ? lastN : 20,
        );
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  });
}
