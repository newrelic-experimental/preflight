/**
 * Cost Tracking — maintains running token counts and cost calculations.
 *
 * Two paths feed into the tracker:
 *   1. Self-reporting via the `nr_observe_report_tokens` MCP tool (primary)
 *   2. Estimation from hook input/output byte sizes (fallback)
 *
 * Cost calculation delegates to `calculateCost()` from the shared package.
 */

import type { TokenUsage, CostBreakdown, MetricAggregator } from '../shared/index.js';
import { calculateCost, createLogger } from '../shared/index.js';
import { localDateKey } from '../lib/date.js';
import type { SessionTracker } from './session-tracker.js';

const logger = createLogger('cost-tracker');

// ---------------------------------------------------------------------------
// Context types
// ---------------------------------------------------------------------------

/**
 * Optional context for `recordTokenUsage` / `accumulateTokens`. When
 * `timestampMs` is supplied (e.g. from a subagent JSONL entry's
 * `timestamp` field), it overrides `Date.now()` for both `costByDayUsd`
 * bucketing AND `firstActivityMsByDay` so cross-midnight subagent runs
 * attribute correctly. When omitted, the existing wall-clock behaviour
 * is preserved.
 *
 * `workflowRunId` and `agentId` are passed through to the per-run cost
 * map (`costByWorkflowRunId`) so the dashboard can show per-run spend
 * with day-keyed splits for runs that cross midnight.
 *
 * When `agentId` is provided, cost accumulates to `subagentCostUsd`;
 * otherwise it accumulates to `parentCostUsd`.
 *
 * Late-arrival rejection: a `timestampMs` more than 48h in the past is
 * dropped to prevent unbounded retroactive day-bucket mutation.
 */
export interface TokenRecordContext {
  readonly timestampMs?: number;
  readonly workflowRunId?: string | null;
  readonly agentId?: string;
}

/** @deprecated Use TokenRecordContext instead. */
export type CostAccumulationContext = TokenRecordContext;

const LATE_ARRIVAL_REJECTION_MS = 48 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CostMetrics {
  readonly sessionTotalCostUsd: number | null;
  readonly costByTask: null; // stub — task boundary detection is Phase 2.3
  readonly costByModel: Record<string, number>;
  readonly costPerLineOfCode: number | null;
  readonly costPerFileModified: number | null;
  readonly model: string | null;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalThinkingTokens: number;
  readonly totalCacheReadTokens: number;
  readonly totalCacheCreationTokens: number;
  readonly cacheHitRate: number | null;
  readonly totalCacheSavingsUsd: number;
  readonly reportCount: number;
  readonly estimationCount: number;
  readonly latestCostBreakdown: CostBreakdown | null;
  /** Cumulative cost attributed to subagent calls (ctx.agentId was set). */
  readonly subagentCostUsd: number;
  /** Cumulative cost attributed to the parent/orchestrator (ctx.agentId was absent). */
  readonly parentCostUsd: number;
  /**
   * Per-workflow-run cost split by local day.
   * Shape: `{ [runId]: { [dayKey]: usd } }`
   */
  readonly costByWorkflowRunId: Record<string, Record<string, number>>;
}

export interface SubagentMetrics {
  readonly subagentUsd: number;
  readonly parentUsd: number;
  readonly subagentSharePct: number;
  /**
   * Placeholder for Phase 3 reconciliation: the delta between total tokens
   * reported by a WorkflowRunEvent and the sum of per-subagent cost. null
   * until at least one workflow run has both totals available.
   */
  readonly reconciliationDeltaPct: number | null;
}

// ---------------------------------------------------------------------------
// CostTracker
// ---------------------------------------------------------------------------

export class CostTracker {
  private sessionTracker: SessionTracker | null;

  private totalCostUsd = 0;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalThinkingTokens = 0;
  private totalCacheReadTokens = 0;
  private totalCacheCreationTokens = 0;
  private totalCacheSavingsUsd = 0;
  private currentModel: string | null = null;
  private reportCount = 0;
  private estimationCount = 0;
  private latestCostBreakdown: CostBreakdown | null = null;
  private costByModel = new Map<string, number>();
  // Per-day cost attribution. Each token event is bucketed into the local-day
  // it was recorded in, so consumers asking "how much did this session spend
  // today" can get a real answer when a session crosses midnight. Without
  // this, dashboard "Today Spend" counts the entire session against today,
  // including tokens spent before midnight.
  private costByDayUsd = new Map<string, number>();
  private firstActivityMsByDay = new Map<string, number>();
  /**
   * Per-workflow-run cost attribution split by local-day so a run that crosses
   * midnight contributes to each day's bucket independently. Two-level map:
   * `costByWorkflowRunId.get(runId).get(dayKey) → usd`. Restart-resets to empty
   * (intentional: per-day totals remain correct even if run-level attribution
   * is lost across restarts).
   */
  private costByWorkflowRunId = new Map<string, Map<string, number>>();
  /** Per-day mutation counter so dashboards can invalidate cached day cards. */
  private lastMutationMsByDay = new Map<string, number>();
  /**
   * Subagent-attributed spend: accumulated when `ctx.agentId` is set.
   * Parent spend covers all other token reports.
   */
  private subagentCostUsd = 0;

  /** Subagent-attributed spend per local-day key, for a today-scoped KPI. */
  private subagentCostByDayUsd = new Map<string, number>();
  private parentCostUsd = 0;
  private totalLinesChanged = 0;

  constructor(sessionTracker?: SessionTracker) {
    this.sessionTracker = sessionTracker ?? null;
  }

  /**
   * Primary path: record exact token usage from self-reporting.
   *
   * The optional `ctx` argument lets the subagent watcher attribute tokens
   * to the actual JSONL `timestamp` (rather than `Date.now()`) so a run
   * that crosses midnight is bucketed correctly, AND to a `workflowRunId` /
   * `agentId` for per-run and subagent/parent cost attribution.
   */
  recordTokenUsage(usage: TokenUsage, model: string, ctx?: TokenRecordContext): CostBreakdown {
    this.reportCount++;
    return this.accumulateTokens(usage, model, ctx);
  }

  /**
   * Fallback path: estimate tokens from character counts.
   * Uses the heuristic: tokens ≈ characters / 4.
   */
  recordEstimatedTokens(inputChars: number, outputChars: number, model: string): CostBreakdown {
    const inputTokens = Math.round(inputChars / 4);
    const outputTokens = Math.round(outputChars / 4);
    const usage: TokenUsage = {
      inputTokens,
      outputTokens,
      thinkingTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: inputTokens + outputTokens,
    };

    this.estimationCount++;
    return this.accumulateTokens(usage, model);
  }

  private accumulateTokens(
    usage: TokenUsage,
    model: string,
    ctx?: TokenRecordContext,
  ): CostBreakdown {
    const breakdown = calculateCost(model, usage);
    const wallNowMs = Date.now();

    // Late-arrival rejection: a `ctx.timestampMs` more than 48h before now is
    // dropped from day buckets to bound retroactive mutation. Session-level
    // totals (totalCostUsd, subagentCostUsd, etc.) still accumulate because
    // they are session-scoped and the cost is real.
    const tsMs = ctx?.timestampMs ?? wallNowMs;
    const isLate =
      ctx?.timestampMs !== undefined && wallNowMs - ctx.timestampMs > LATE_ARRIVAL_REJECTION_MS;

    if (isLate) {
      logger.warn('Late-arrival token event dropped from day bucket', {
        timestampMs: ctx?.timestampMs,
        deltaMs: wallNowMs - (ctx?.timestampMs ?? wallNowMs),
      });
      // Still accumulate session-level totals, but skip day bucketing and
      // workflow-run maps.
      this.totalCostUsd += breakdown.totalUsd;
      this.totalInputTokens += usage.inputTokens;
      this.totalOutputTokens += usage.outputTokens;
      this.totalThinkingTokens += usage.thinkingTokens;
      this.totalCacheReadTokens += usage.cacheReadTokens;
      this.totalCacheCreationTokens += usage.cacheCreationTokens;
      this.currentModel = model;
      this.latestCostBreakdown = breakdown;
      this.costByModel.set(model, (this.costByModel.get(model) ?? 0) + breakdown.totalUsd);
      this.totalCacheSavingsUsd += breakdown.savingsFromCacheUsd;
      if (ctx?.agentId !== undefined) {
        this.subagentCostUsd += breakdown.totalUsd;
      } else {
        this.parentCostUsd += breakdown.totalUsd;
      }
      return breakdown;
    }

    this.totalCostUsd += breakdown.totalUsd;
    this.totalInputTokens += usage.inputTokens;
    this.totalOutputTokens += usage.outputTokens;
    this.totalThinkingTokens += usage.thinkingTokens;
    this.totalCacheReadTokens += usage.cacheReadTokens;
    this.totalCacheCreationTokens += usage.cacheCreationTokens;
    this.currentModel = model;
    this.latestCostBreakdown = breakdown;
    this.costByModel.set(model, (this.costByModel.get(model) ?? 0) + breakdown.totalUsd);
    this.totalCacheSavingsUsd += breakdown.savingsFromCacheUsd;

    // Subagent vs parent split
    if (ctx?.agentId !== undefined) {
      this.subagentCostUsd += breakdown.totalUsd;
    } else {
      this.parentCostUsd += breakdown.totalUsd;
    }

    // Day bucketing
    const dayKey = localDateKey(tsMs);
    this.costByDayUsd.set(dayKey, (this.costByDayUsd.get(dayKey) ?? 0) + breakdown.totalUsd);
    if (ctx?.agentId !== undefined) {
      this.subagentCostByDayUsd.set(
        dayKey,
        (this.subagentCostByDayUsd.get(dayKey) ?? 0) + breakdown.totalUsd,
      );
    }
    this.lastMutationMsByDay.set(dayKey, wallNowMs);
    const existingFirst = this.firstActivityMsByDay.get(dayKey);
    if (existingFirst === undefined || tsMs < existingFirst) {
      // Use earliest event timestamp for the day so cross-midnight burn-rate
      // denominators stay correct (NOT wall-clock arrival time).
      this.firstActivityMsByDay.set(dayKey, tsMs);
    }

    // Per-workflow-run day bucketing
    if (ctx?.workflowRunId) {
      const runMap = this.costByWorkflowRunId.get(ctx.workflowRunId) ?? new Map<string, number>();
      runMap.set(dayKey, (runMap.get(dayKey) ?? 0) + breakdown.totalUsd);
      this.costByWorkflowRunId.set(ctx.workflowRunId, runMap);
    }

    return breakdown;
  }

  private computeCacheHitRate(): number | null {
    const denominator =
      this.totalInputTokens + this.totalCacheReadTokens + this.totalCacheCreationTokens;
    if (denominator === 0) return null;
    if (this.totalCacheReadTokens === 0 && this.totalCacheCreationTokens === 0) return null;
    return this.totalCacheReadTokens / denominator;
  }

  /**
   * Cost spent during a specific local-time day, attributed at the moment
   * each token event was recorded. Used to fix the cross-midnight inflation
   * of "Today Spend" — when a session that started yesterday continues into
   * today, this returns only today's portion.
   */
  getCostForDay(dayKey: string): number {
    return this.costByDayUsd.get(dayKey) ?? 0;
  }

  /**
   * Subagent-attributed cost during a specific local-time day. Today-scoped
   * counterpart to getSubagentMetrics().subagentUsd (which is session-
   * cumulative) so the "subagent spend" KPI lines up with the day-bucketed
   * "spend today" total.
   */
  getSubagentCostForDay(dayKey: string): number {
    return this.subagentCostByDayUsd.get(dayKey) ?? 0;
  }

  /**
   * Epoch ms of the first token event recorded today (local time), or null
   * if no spend has been booked today. The forecast burn-rate denominator
   * should be (now - firstActivityToday), not (now - sessionStart) — the
   * latter dilutes the rate with idle hours from previous days when a
   * session spans midnight.
   */
  getFirstActivityMsForDay(dayKey: string): number | null {
    return this.firstActivityMsByDay.get(dayKey) ?? null;
  }

  /** Most recent wall-clock ms a per-day bucket was mutated (cache-key seed). */
  getLastMutationMsForDay(dayKey: string): number | null {
    return this.lastMutationMsByDay.get(dayKey) ?? null;
  }

  /**
   * Per-workflow-run total spend, summed across all day-keys this run
   * touched. Returns 0 for unknown runIds.
   */
  getCostForWorkflowRun(runId: string): number {
    const m = this.costByWorkflowRunId.get(runId);
    if (!m) return 0;
    let total = 0;
    for (const v of m.values()) total += v;
    return total;
  }

  /** Iterable view of every (runId, dayKey, usd) tuple — for dashboard joins. */
  *iterCostByWorkflowRun(): IterableIterator<{ runId: string; dayKey: string; usd: number }> {
    for (const [runId, m] of this.costByWorkflowRunId) {
      for (const [dayKey, usd] of m) {
        yield { runId, dayKey, usd };
      }
    }
  }

  /**
   * Subagent / parent cost split for the current session.
   *
   * `reconciliationDeltaPct` is a Phase 3 placeholder: it will compare the
   * total tokens reported by WorkflowRunEvent against the sum of per-subagent
   * cost to detect attribution gaps. Returns null until that data is available.
   */
  getSubagentMetrics(): SubagentMetrics {
    const total = this.subagentCostUsd + this.parentCostUsd;
    const subagentSharePct = total > 0 ? (this.subagentCostUsd / total) * 100 : 0;
    return {
      subagentUsd: this.subagentCostUsd,
      parentUsd: this.parentCostUsd,
      subagentSharePct,
      reconciliationDeltaPct: null,
    };
  }

  /**
   * Record lines of code changed (from Edit/Write tool data).
   */
  recordLinesChanged(lines: number): void {
    this.totalLinesChanged += lines;
  }

  getMetrics(): CostMetrics {
    const hasData = this.reportCount > 0 || this.estimationCount > 0;

    const uniqueFilesWritten = this.sessionTracker
      ? this.sessionTracker.getMetrics().uniqueFilesWritten
      : 0;

    // Serialise the two-level Map into a plain Record for JSON compatibility.
    const costByWorkflowRunId: Record<string, Record<string, number>> = {};
    for (const [runId, dayMap] of this.costByWorkflowRunId) {
      costByWorkflowRunId[runId] = Object.fromEntries(dayMap);
    }

    return {
      sessionTotalCostUsd: hasData ? this.totalCostUsd : null,
      costByTask: null,
      costByModel: Object.fromEntries(this.costByModel),
      costPerLineOfCode:
        hasData && this.totalLinesChanged > 0 ? this.totalCostUsd / this.totalLinesChanged : null,
      costPerFileModified:
        hasData && uniqueFilesWritten > 0 ? this.totalCostUsd / uniqueFilesWritten : null,
      model: this.currentModel,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      totalThinkingTokens: this.totalThinkingTokens,
      totalCacheReadTokens: this.totalCacheReadTokens,
      totalCacheCreationTokens: this.totalCacheCreationTokens,
      cacheHitRate: this.computeCacheHitRate(),
      totalCacheSavingsUsd: this.totalCacheSavingsUsd,
      reportCount: this.reportCount,
      estimationCount: this.estimationCount,
      latestCostBreakdown: this.latestCostBreakdown,
      subagentCostUsd: this.subagentCostUsd,
      parentCostUsd: this.parentCostUsd,
      costByWorkflowRunId,
    };
  }

  emitMetrics(aggregator: MetricAggregator): void {
    const attrs: Record<string, string | number> = {};
    if (this.currentModel) {
      attrs.model = this.currentModel;
    }

    aggregator.record('ai.cost.session_total_usd', this.totalCostUsd, attrs);
    aggregator.record('ai.cost.tokens_input', this.totalInputTokens, attrs);
    aggregator.record('ai.cost.tokens_output', this.totalOutputTokens, attrs);
    aggregator.record('ai.cost.tokens_thinking', this.totalThinkingTokens, attrs);
    aggregator.record('ai.cost.tokens_cache_read', this.totalCacheReadTokens, attrs);
    aggregator.record('ai.cost.tokens_cache_creation', this.totalCacheCreationTokens, attrs);
    aggregator.record('ai.cost.cache_savings_usd', this.totalCacheSavingsUsd, attrs);

    if (this.totalLinesChanged > 0) {
      aggregator.record(
        'ai.cost.cost_per_line_of_code',
        this.totalCostUsd / this.totalLinesChanged,
        attrs,
      );
    }

    if (this.sessionTracker) {
      const uniqueFilesWritten = this.sessionTracker.getMetrics().uniqueFilesWritten;
      if (uniqueFilesWritten > 0) {
        aggregator.record(
          'ai.cost.cost_per_file_modified',
          this.totalCostUsd / uniqueFilesWritten,
          attrs,
        );
      }
    }

    aggregator.record('ai.cost.report_count', this.reportCount, attrs);
    aggregator.record('ai.cost.estimation_count', this.estimationCount, attrs);
    aggregator.record('ai.cost.subagent_usd', this.subagentCostUsd, attrs);
    aggregator.record('ai.cost.parent_usd', this.parentCostUsd, attrs);
  }

  reset(): void {
    this.totalCostUsd = 0;
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.totalThinkingTokens = 0;
    this.totalCacheReadTokens = 0;
    this.totalCacheCreationTokens = 0;
    this.totalCacheSavingsUsd = 0;
    this.currentModel = null;
    this.reportCount = 0;
    this.estimationCount = 0;
    this.latestCostBreakdown = null;
    this.costByModel = new Map();
    this.costByDayUsd = new Map();
    this.subagentCostByDayUsd = new Map();
    this.firstActivityMsByDay = new Map();
    this.costByWorkflowRunId = new Map();
    this.lastMutationMsByDay = new Map();
    this.subagentCostUsd = 0;
    this.parentCostUsd = 0;
    this.totalLinesChanged = 0;
  }
}
