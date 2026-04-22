/**
 * MCP tool handlers for cost tracking.
 *
 * Defines:
 *   - `nr_observe_report_tokens` — self-report token usage for cost tracking
 *   - `nr_observe_get_cost_breakdown` — session cost breakdown by task
 */

import type { CostTracker } from '../metrics/cost-tracker.js';
import type { TaskDetector } from '../metrics/task-detector.js';
import type { TokenUsage } from '@nr-ai-observatory/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TokenReport {
  input_tokens: number;
  output_tokens: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  model: string;
}

// ---------------------------------------------------------------------------
// Tool definitions (for tools/list)
// ---------------------------------------------------------------------------

export const REPORT_TOKENS_TOOL = {
  name: 'nr_observe_report_tokens',
  description:
    'Report token usage for cost tracking. Call periodically to enable accurate cost metrics. ' +
    'Provide the model name and token counts from the most recent API response.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      input_tokens: { type: 'number', description: 'Number of input/prompt tokens' },
      output_tokens: { type: 'number', description: 'Number of output/completion tokens' },
      thinking_tokens: { type: 'number', description: 'Number of thinking/reasoning tokens (optional)' },
      cache_read_tokens: { type: 'number', description: 'Number of cache read tokens (optional)' },
      cache_creation_tokens: { type: 'number', description: 'Number of cache creation tokens (optional)' },
      model: { type: 'string', description: 'Model identifier (e.g. claude-sonnet-4-20250514)' },
    },
    required: ['input_tokens', 'output_tokens', 'model'],
  },
  annotations: { readOnlyHint: true },
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function handleReportTokens(costTracker: CostTracker, args: TokenReport) {
  const usage: TokenUsage = {
    inputTokens: args.input_tokens,
    outputTokens: args.output_tokens,
    thinkingTokens: args.thinking_tokens ?? 0,
    cacheReadTokens: args.cache_read_tokens ?? 0,
    cacheCreationTokens: args.cache_creation_tokens ?? 0,
    totalTokens:
      args.input_tokens +
      args.output_tokens +
      (args.thinking_tokens ?? 0) +
      (args.cache_read_tokens ?? 0) +
      (args.cache_creation_tokens ?? 0),
  };

  const breakdown = costTracker.recordTokenUsage(usage, args.model);
  const metrics = costTracker.getMetrics();

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            recorded: true,
            cost_this_report_usd: breakdown.totalUsd,
            session_total_cost_usd: metrics.sessionTotalCostUsd,
            model: args.model,
          },
          null,
          2,
        ),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Cost Breakdown tool
// ---------------------------------------------------------------------------

export const COST_BREAKDOWN_TOOL = {
  name: 'nr_observe_get_cost_breakdown',
  description:
    'Get a breakdown of session costs by task, model, and efficiency metrics like cost per line of code.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
  annotations: { readOnlyHint: true },
};

export function handleGetCostBreakdown(
  costTracker: CostTracker,
  taskDetector?: TaskDetector,
) {
  const metrics = costTracker.getMetrics();

  const byTask = taskDetector
    ? taskDetector.getCompletedTasks().map((task) => ({
        task_id: task.taskId,
        cost_usd: task.estimatedCostUsd,
        tokens_used: task.tokensUsed,
      }))
    : [];

  const result = {
    total_usd: metrics.sessionTotalCostUsd ?? 0,
    by_model: metrics.costByModel,
    by_task: byTask,
    cost_per_line_of_code: metrics.costPerLineOfCode,
    cost_per_file_modified: metrics.costPerFileModified,
    tokens: {
      input: metrics.totalInputTokens,
      output: metrics.totalOutputTokens,
      thinking: metrics.totalThinkingTokens,
    },
  };

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
