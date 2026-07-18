/**
 * MCP tool handlers for cost tracking.
 *
 * Defines:
 *   - `nr_observe_report_tokens` — self-report token usage for cost tracking
 *   - `nr_observe_get_cost_breakdown` — session cost breakdown by task
 */

import type { CostTracker } from '../metrics/cost-tracker.js';
import type { TaskDetector } from '../metrics/task-detector.js';
import type { BudgetTracker } from '../metrics/budget-tracker.js';
import type { ModelUsageTracker } from '../metrics/model-usage-tracker.js';
import { buildCostForecastFromInputs } from '../metrics/cost-forecast.js';
import { localDateKey } from '../lib/date.js';
import type { TokenUsage } from '../shared/index.js';

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
      thinking_tokens: {
        type: 'number',
        description: 'Number of thinking/reasoning tokens (optional)',
      },
      cache_read_tokens: { type: 'number', description: 'Number of cache read tokens (optional)' },
      cache_creation_tokens: {
        type: 'number',
        description: 'Number of cache creation tokens (optional)',
      },
      model: { type: 'string', description: 'Model identifier (e.g. claude-sonnet-4-20250514)' },
    },
    required: ['input_tokens', 'output_tokens', 'model'],
  },
  annotations: { readOnlyHint: false },
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const MAX_TOKENS = 10_000_000;
const clampToken = (v: number): number => {
  if (!Number.isFinite(v)) return 0;
  return Math.min(Math.max(0, Math.floor(v)), MAX_TOKENS);
};

export function handleReportTokens(
  costTracker: CostTracker,
  args: TokenReport,
  modelUsageTracker?: ModelUsageTracker,
) {
  const inputTokens = clampToken(args.input_tokens);
  const outputTokens = clampToken(args.output_tokens);
  const thinkingTokens = clampToken(args.thinking_tokens ?? 0);
  const cacheReadTokens = clampToken(args.cache_read_tokens ?? 0);
  const cacheCreationTokens = clampToken(args.cache_creation_tokens ?? 0);
  const safeModel = typeof args.model === 'string' ? args.model.slice(0, 256) : 'unknown';

  if (!/^[a-zA-Z0-9._:-]+$/.test(safeModel)) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            error: 'invalid_model_name',
            message: `Model name contains invalid characters: ${safeModel}. Allowed: alphanumerics, dots, underscores, colons, hyphens.`,
          }),
        },
      ],
      isError: true,
    };
  }

  const usage: TokenUsage = {
    inputTokens,
    outputTokens,
    thinkingTokens,
    cacheReadTokens,
    cacheCreationTokens,
    // Cache tokens are billed separately and excluded from totalTokens to match Anthropic dashboard conventions
    totalTokens: inputTokens + outputTokens + thinkingTokens,
  };

  const breakdown = costTracker.recordTokenUsage(usage, safeModel);
  modelUsageTracker?.recordUsage(safeModel, inputTokens, outputTokens, breakdown.totalUsd);
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
            model: safeModel,
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

export function handleGetCostBreakdown(costTracker: CostTracker, taskDetector?: TaskDetector) {
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
    cost_per_million_tokens: metrics.costPerMillionTokens,
    tokens: {
      input: metrics.totalInputTokens,
      output: metrics.totalOutputTokens,
      thinking: metrics.totalThinkingTokens,
      cache_read: metrics.totalCacheReadTokens,
      cache_creation: metrics.totalCacheCreationTokens,
    },
  };

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}

// ---------------------------------------------------------------------------
// Budget Status tool
// ---------------------------------------------------------------------------

export const BUDGET_STATUS_TOOL = {
  name: 'nr_observe_get_budget_status',
  description:
    'Get current AI spend vs. configured budget caps (session, daily, weekly). Returns remaining budget, % used, and any threshold alerts fired this session.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
  annotations: { readOnlyHint: true },
};

// ---------------------------------------------------------------------------
// Cost Forecast tool
// ---------------------------------------------------------------------------

export const COST_FORECAST_TOOL = {
  name: 'nr_observe_get_cost_forecast',
  description:
    'Project AI spending forward based on current session rate. Returns forecast cost for end-of-day, end-of-week, and end-of-session (8h), with a confidence note.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
  annotations: { readOnlyHint: true },
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function handleGetBudgetStatus(budgetTracker: BudgetTracker): {
  content: Array<{ type: 'text'; text: string }>;
} {
  const status = budgetTracker.getStatus();
  return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
}

export function handleGetCostForecast(
  costTracker: CostTracker,
  sessionStartMs: number,
): { content: Array<{ type: 'text'; text: string }> } {
  const metrics = costTracker.getMetrics();
  const todayKey = localDateKey();
  const forecast = buildCostForecastFromInputs({
    sessionSpentUsd: metrics.sessionTotalCostUsd ?? 0,
    sessionStartMs,
    dailySpentUsd: costTracker.getCostForDay(todayKey),
    dailyFirstActivityMs: costTracker.getFirstActivityMsForDay(todayKey),
  });
  return { content: [{ type: 'text', text: JSON.stringify(forecast, null, 2) }] };
}

// ---------------------------------------------------------------------------
// Prompt Cache Health tool
// ---------------------------------------------------------------------------

export const PROMPT_CACHE_HEALTH_TOOL = {
  name: 'nr_observe_get_prompt_cache_health',
  description:
    'Get prompt cache health: hit rate, savings, and a concrete recommendation for improving cache efficiency. ' +
    'A high hit rate means more context is being served cheaply from cache rather than priced as fresh input.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
  annotations: { readOnlyHint: true },
};

type CacheStatus = 'no_cache_activity' | 'needs_attention' | 'can_improve' | 'excellent';

function cacheRecommendation(status: CacheStatus, hitRatePct: number | null): string {
  if (status === 'no_cache_activity') {
    return 'No cache activity detected. This model or session may not support prompt caching, or cache_read_tokens have not been reported yet.';
  }
  if (status === 'excellent') {
    return `Cache health is excellent (${hitRatePct}%). Your prompt structure is well-optimised for caching. No changes needed.`;
  }
  if (status === 'can_improve') {
    return (
      `Cache hit rate is ${hitRatePct}%. To improve: place stable content (CLAUDE.md rules, recurring file reads) ` +
      'before variable content (user messages, dynamic tool results) in your prompts.'
    );
  }
  return (
    `Cache hit rate is ${hitRatePct}%. Significant improvement possible: restructure your system prompt so stable ` +
    'context appears at the very top, before any variable content. Each cache miss at full input price that could ' +
    'have been a cheap cache read represents avoidable spend.'
  );
}

export function handleGetPromptCacheHealth(costTracker: CostTracker): {
  content: Array<{ type: 'text'; text: string }>;
} {
  const metrics = costTracker.getMetrics();
  const { cacheHitRate, totalCacheReadTokens, totalCacheCreationTokens, totalCacheSavingsUsd } =
    metrics;

  let status: CacheStatus;
  let hitRatePct: number | null = null;

  if (cacheHitRate === null) {
    status = 'no_cache_activity';
  } else {
    hitRatePct = Math.round(cacheHitRate * 100);
    if (hitRatePct >= 60) {
      status = 'excellent';
    } else if (hitRatePct >= 30) {
      status = 'can_improve';
    } else {
      status = 'needs_attention';
    }
  }

  const result = {
    status,
    cache_hit_rate_pct: hitRatePct,
    total_cache_read_tokens: totalCacheReadTokens,
    total_cache_creation_tokens: totalCacheCreationTokens,
    total_savings_usd: totalCacheSavingsUsd,
    recommendation: cacheRecommendation(status, hitRatePct),
    data_quality: metrics.reportCount > 0 ? 'self_reported' : 'estimated',
  };

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
