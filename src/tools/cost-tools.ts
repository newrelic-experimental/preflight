/**
 * MCP tool handlers for cost tracking.
 *
 * Defines:
 *   - `nr_observe_report_tokens` — self-report token usage for cost tracking
 *   - `nr_observe_get_cost_breakdown` — session cost breakdown by task
 *   - `nr_observe_get_budget_status` — spend vs. configured budget caps
 *   - `nr_observe_get_cost_forecast` — projected spend for day/week/session
 *   - `nr_observe_get_prompt_cache_health` — cache hit rate and recommendation
 */

import { z } from 'zod';

import type { CostTracker } from '../metrics/cost-tracker.js';
import type { TaskDetector } from '../metrics/task-detector.js';
import type { BudgetTracker } from '../metrics/budget-tracker.js';
import type { ModelUsageTracker } from '../metrics/model-usage-tracker.js';
import type { SessionResumeTracker } from '../metrics/session-resume-tracker.js';
import { buildCostForecastFromInputs } from '../metrics/cost-forecast.js';
import { localDateKey } from '../lib/date.js';
import { resolvePricing } from '../metrics/pricing-overlay.js';
import type { TokenUsage } from '../shared/index.js';
import {
  errorResult,
  requireTracker,
  requireAvailable,
  buildToolSet,
  type RegisteredToolSet,
  type ToolCallResult,
  type ToolDefinition,
} from './tool-registry.js';
import { mcpArgumentsHash } from '../hooks/collector-script.js';
import type { HookEventProcessor } from '../hooks/event-processor.js';
import { isSyntheticSessionId } from '../hooks/session-resolver.js';
import { isSavableSessionId } from '../storage/session-store.js';
import type { PreHookEvent } from '../storage/types.js';

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

const TokenReportSchema = z.object({
  model: z.string().min(1),
  input_tokens: z.number().nonnegative(),
  output_tokens: z.number().nonnegative(),
  cache_creation_tokens: z.number().nonnegative().optional(),
  cache_read_tokens: z.number().nonnegative().optional(),
  thinking_tokens: z.number().nonnegative().optional(),
});

const MAX_TOKENS = 10_000_000;
const clampToken = (v: number): number => {
  if (!Number.isFinite(v)) return 0;
  return Math.min(Math.max(0, Math.floor(v)), MAX_TOKENS);
};

function jsonResult(body: object): ToolCallResult {
  return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
}

function invalidTokenReport(err: unknown): ToolCallResult {
  const message =
    err instanceof z.ZodError
      ? err.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')
      : String(err);
  return errorResult(`Invalid token report: ${message}`);
}

type ParsedTokenReport =
  | { readonly ok: true; readonly usage: TokenUsage; readonly model: string }
  | { readonly ok: false; readonly result: ToolCallResult };

function parseTokenReport(args: TokenReport): ParsedTokenReport {
  const inputTokens = clampToken(args.input_tokens);
  const outputTokens = clampToken(args.output_tokens);
  const thinkingTokens = clampToken(args.thinking_tokens ?? 0);
  const cacheReadTokens = clampToken(args.cache_read_tokens ?? 0);
  const cacheCreationTokens = clampToken(args.cache_creation_tokens ?? 0);
  const safeModel = typeof args.model === 'string' ? args.model.slice(0, 256) : 'unknown';

  if (!/^[a-zA-Z0-9._:-]+$/.test(safeModel)) {
    return {
      ok: false,
      result: errorResult(
        'invalid_model_name',
        `Model name contains invalid characters: ${safeModel}. Allowed: alphanumerics, dots, underscores, colons, hyphens.`,
      ),
    };
  }

  return {
    ok: true,
    model: safeModel,
    usage: {
      inputTokens,
      outputTokens,
      thinkingTokens,
      cacheReadTokens,
      cacheCreationTokens,
      // Cache tokens are billed separately and excluded from totalTokens to match Anthropic dashboard conventions
      totalTokens: inputTokens + outputTokens + thinkingTokens,
    },
  };
}

export function handleReportTokens(
  costTracker: CostTracker,
  args: TokenReport,
  modelUsageTracker?: ModelUsageTracker,
) {
  const parsed = parseTokenReport(args);
  if (!parsed.ok) return parsed.result;
  const { usage, model } = parsed;

  const breakdown = costTracker.recordTokenUsage(usage, model);
  modelUsageTracker?.recordUsage(model, usage, breakdown.totalUsd);
  const metrics = costTracker.getMetrics();

  return jsonResult({
    recorded: true,
    cost_this_report_usd: breakdown.totalUsd,
    session_total_cost_usd: metrics.sessionTotalCostUsd,
    model,
  });
}

export function conversationReportTokensTool(conversationIdField: string): ToolDefinition {
  return {
    ...REPORT_TOKENS_TOOL,
    description:
      'Report token usage for cost tracking. This server serves several chats and works out ' +
      'which one made this call, so you do not need to pass conversation_id. If you pass it, it ' +
      `must be this chat's ${conversationIdField}; an id Preflight cannot confirm is rejected. ` +
      'Provide the model name and token counts from the most recent API response.',
    inputSchema: {
      ...REPORT_TOKENS_TOOL.inputSchema,
      properties: {
        conversation_id: {
          type: 'string',
          description: `Optional. This chat's ${conversationIdField}.`,
        },
        ...REPORT_TOKENS_TOOL.inputSchema.properties,
      },
    },
  };
}

export type ConversationTokenRecorder = (
  conversationId: string,
  usage: TokenUsage,
  model: string,
) => { readonly costUsd: number; readonly conversationTotalCostUsd: number };

export interface ConversationReports {
  readonly tool: ToolDefinition;
  readonly record: ConversationTokenRecorder;
  readonly matchReportCall: (args: Record<string, unknown>) => Promise<readonly string[]>;
  readonly hasSeen: (conversationId: string) => boolean;
}

const ANTIGRAVITY_CONVERSATION_META = 'antigravity.google/conversation_id';

const CONVERSATION_REJECTIONS = {
  invalid_conversation_id:
    'conversation_id must be 1-128 letters, digits, underscores or hyphens, and not "unknown". ' +
    'Leave it out and Preflight finds the conversation itself.',
  conversation_ambiguous:
    'Several conversations made this exact report at once, so Preflight cannot tell which one ' +
    'this is. Nothing was recorded.',
  conversation_id_mismatch:
    'conversation_id does not match the conversation that made this call. Leave it out. ' +
    'Nothing was recorded.',
  conversation_unknown:
    'Preflight could not confirm which conversation made this call, so nothing was recorded. ' +
    'It finds the conversation from its hook events, so check that Preflight hooks are installed.',
} as const;

function isConversationId(id: unknown): id is string {
  return typeof id === 'string' && isSavableSessionId(id) && !isSyntheticSessionId(id);
}

async function resolveReportConversation(
  reports: ConversationReports,
  args: Record<string, unknown>,
  meta: Record<string, unknown> | undefined,
): Promise<{ conversationId: string } | { rejection: keyof typeof CONVERSATION_REJECTIONS }> {
  const claimed = args.conversation_id;
  if (claimed !== undefined && !isConversationId(claimed)) {
    return { rejection: 'invalid_conversation_id' };
  }
  const stamped = meta?.[ANTIGRAVITY_CONVERSATION_META];
  const observed =
    isConversationId(stamped) && reports.hasSeen(stamped)
      ? [stamped]
      : await reports.matchReportCall(args);
  if (observed.length > 1) return { rejection: 'conversation_ambiguous' };
  const [conversationId] = observed;
  if (conversationId !== undefined) {
    return claimed === undefined || claimed === conversationId
      ? { conversationId }
      : { rejection: 'conversation_id_mismatch' };
  }
  return claimed !== undefined && reports.hasSeen(claimed)
    ? { conversationId: claimed }
    : { rejection: 'conversation_unknown' };
}

export async function handleReportConversationTokens(
  reports: ConversationReports,
  args: Record<string, unknown> | undefined,
  meta?: Record<string, unknown>,
): Promise<ToolCallResult> {
  const conversation = await resolveReportConversation(reports, args ?? {}, meta);
  if ('rejection' in conversation) {
    return errorResult(conversation.rejection, CONVERSATION_REJECTIONS[conversation.rejection]);
  }
  const report = TokenReportSchema.safeParse(args);
  if (!report.success) return invalidTokenReport(report.error);
  const parsed = parseTokenReport(report.data);
  if (!parsed.ok) return parsed.result;

  const { conversationId } = conversation;
  const { costUsd, conversationTotalCostUsd } = reports.record(
    conversationId,
    parsed.usage,
    parsed.model,
  );
  return jsonResult({
    recorded: true,
    conversation_id: conversationId,
    cost_this_report_usd: costUsd,
    conversation_total_cost_usd: conversationTotalCostUsd,
    model: parsed.model,
  });
}

const REPORT_CALL_WAIT = { waitMs: 2000, pollMs: 50 };

function isReportToolName(tool: string): boolean {
  const name = REPORT_TOKENS_TOOL.name;
  if (!tool.endsWith(name)) return false;
  const prefix = tool.slice(0, -name.length);
  return prefix === '' || /[_:./-]$/.test(prefix);
}

/**
 * Cursor's `beforeMCPExecution` and Windsurf's `pre_mcp_tool_use` can block
 * the call, so both clients finish the hook before sending the `tools/call`.
 */
export function reportCallMatcher(
  hooks: Pick<HookEventProcessor, 'poll' | 'pendingPreEvents'>,
  timing = REPORT_CALL_WAIT,
): ConversationReports['matchReportCall'] {
  const claimed = new WeakSet<PreHookEvent>();
  return async (args) => {
    const inputHash = mcpArgumentsHash(args);
    const deadline = Date.now() + timing.waitMs;
    for (;;) {
      hooks.poll();
      const matches = hooks
        .pendingPreEvents()
        .filter(
          (event) =>
            !claimed.has(event) &&
            event.inputHash === inputHash &&
            isReportToolName(event.tool) &&
            isConversationId(event.sessionId),
        );
      if (matches.length > 0 || Date.now() >= deadline) {
        const conversations = [...new Set(matches.map((event) => event.sessionId as string))];
        if (conversations.length === 1) claimed.add(matches[0]!);
        return conversations;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, timing.pollMs));
    }
  };
}

// ---------------------------------------------------------------------------
// Cost Breakdown tool
// ---------------------------------------------------------------------------

export const COST_BREAKDOWN_TOOL = {
  name: 'nr_observe_get_cost_breakdown',
  description:
    "Get a breakdown of session costs by task, model, and efficiency metrics like cost per line of code. Cost figures are Preflight's own list-price estimate unless costRateMultiplier/dataResidencyPremium are configured for an org's contracted rate — see rate_multiplier_applied in the response.",
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
    by_agent_type: Object.fromEntries(
      Object.entries(metrics.subagentByAgentType).map(([agentType, bucket]) => [
        agentType,
        bucket.costUsd,
      ]),
    ),
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
    // 1 unless costRateMultiplier/dataResidencyPremium are configured — see
    // CostMetrics.costRateMultiplierApplied. A value other than 1 means every
    // dollar figure above reflects that correction, not Preflight's default
    // list-price computation, which is still only an estimate either way.
    rate_multiplier_applied: metrics.costRateMultiplierApplied,
    unpriced_by_model: metrics.unpricedByModel,
    unpriced_models: Object.keys(metrics.costByModel).filter((model) => !resolvePricing(model)),
    estimated_by_model: metrics.estimatedByModel,
  };

  return jsonResult(result);
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
    'Project AI spending forward based on current session rate. Returns forecast cost for end-of-day, end-of-week, and end-of-session (8h), with a confidence note. ' +
    "When this session was resumed after being stale, also includes resumeContext: Claude Code's own report of how long it had been and its estimated cost to re-warm the prompt cache — context for a cost spike the rate-based forecast alone would not explain.",
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
  return jsonResult(status);
}

export function handleGetCostForecast(
  costTracker: CostTracker,
  sessionStartMs: number,
  sessionResumeTracker?: SessionResumeTracker,
): { content: Array<{ type: 'text'; text: string }> } {
  const metrics = costTracker.getMetrics();
  const todayKey = localDateKey();
  const forecast = buildCostForecastFromInputs({
    sessionSpentUsd: metrics.sessionTotalCostUsd ?? 0,
    sessionStartMs,
    dailySpentUsd: costTracker.getCostForDay(todayKey),
    dailyFirstActivityMs: costTracker.getFirstActivityMsForDay(todayKey),
  });
  // resumeContext rides alongside the forecast as extra informational JSON —
  // the forecast math itself (buildCostForecastFromInputs) is untouched, so
  // this can never perturb its well-tested rate/confidence calculations.
  const response = sessionResumeTracker
    ? { ...forecast, resumeContext: sessionResumeTracker.getMetrics() }
    : forecast;
  return jsonResult(response);
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
      `Cache hit rate is ${hitRatePct}%. To improve: place stable content (instruction file rules, recurring file reads) ` +
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

  return jsonResult(result);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export interface CostToolsDeps {
  costTracker?: CostTracker;
  budgetTracker?: BudgetTracker;
  taskDetector?: TaskDetector;
  modelUsageTracker?: ModelUsageTracker;
  sessionResumeTracker?: SessionResumeTracker;
  sessionStartMs?: number;
}

export function registerCostTools(deps: CostToolsDeps): RegisteredToolSet {
  return buildToolSet([
    {
      definition: REPORT_TOKENS_TOOL,
      available: !!deps.costTracker,
      handle: (args) => {
        const check = requireTracker(deps.costTracker, 'CostTracker');
        if (!check.ok) return check.result;
        try {
          const tokenReport = TokenReportSchema.parse(args);
          return handleReportTokens(check.value, tokenReport, deps.modelUsageTracker);
        } catch (err) {
          return invalidTokenReport(err);
        }
      },
    },
    {
      definition: COST_BREAKDOWN_TOOL,
      available: !!deps.costTracker,
      handle: () => {
        const check = requireTracker(deps.costTracker, 'CostTracker');
        if (!check.ok) return check.result;
        return handleGetCostBreakdown(check.value, deps.taskDetector);
      },
    },
    {
      definition: PROMPT_CACHE_HEALTH_TOOL,
      available: !!deps.costTracker,
      handle: () => {
        const check = requireTracker(deps.costTracker, 'CostTracker');
        if (!check.ok) return check.result;
        return handleGetPromptCacheHealth(check.value);
      },
    },
    {
      definition: BUDGET_STATUS_TOOL,
      available: !!deps.budgetTracker,
      handle: () => {
        const check = requireTracker(deps.budgetTracker, 'BudgetTracker');
        if (!check.ok) return check.result;
        return handleGetBudgetStatus(check.value);
      },
    },
    {
      definition: COST_FORECAST_TOOL,
      available: !!deps.costTracker && deps.sessionStartMs !== undefined,
      handle: () => {
        const missing = requireAvailable(
          !!deps.costTracker && deps.sessionStartMs !== undefined,
          'CostTracker or sessionStartMs not available',
        );
        if (missing) return missing;
        return handleGetCostForecast(
          deps.costTracker!,
          deps.sessionStartMs!,
          deps.sessionResumeTracker,
        );
      },
    },
  ]);
}
