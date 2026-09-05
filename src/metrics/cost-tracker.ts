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
import type { Resettable } from './tracker-contracts.js';

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

const LATE_ARRIVAL_REJECTION_MS = 48 * 60 * 60 * 1000;

/**
 * Scales every dollar field of a `CostBreakdown` by `factor`, leaving token
 * counts and everything else untouched. Used to correct Preflight's own
 * list-price computation to an org's real contracted rate (see
 * `CostTrackerOptions.rateMultiplier`) — `calculateCost()` itself lives in
 * `src/shared/`, a vendored snapshot this repo must not edit, so the
 * correction is applied to its output here instead of inside it.
 */
function scaleCostBreakdown(breakdown: CostBreakdown, factor: number): CostBreakdown {
  return {
    inputUsd: breakdown.inputUsd * factor,
    outputUsd: breakdown.outputUsd * factor,
    thinkingUsd: breakdown.thinkingUsd * factor,
    cacheReadUsd: breakdown.cacheReadUsd * factor,
    cacheCreationUsd: breakdown.cacheCreationUsd * factor,
    totalUsd: breakdown.totalUsd * factor,
    savingsFromCacheUsd: breakdown.savingsFromCacheUsd * factor,
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CostMetrics {
  readonly sessionTotalCostUsd: number | null;
  readonly costByTask: null; // stub — task boundary detection is not yet implemented
  readonly costByModel: Record<string, number>;
  readonly costPerLineOfCode: number | null;
  readonly costPerFileModified: number | null;
  /**
   * Blended session cost rate: totalCostUsd / totalTokens (all types) * 1M.
   * ModelUsageTracker's per-model `costPerMillionTokens` uses the same
   * denominator, so the two are comparable.
   */
  readonly costPerMillionTokens: number | null;
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
  /**
   * Total cost bucketed by local-day key (`YYYY-MM-DD`). Each token event is
   * attributed to the day it was actually recorded in (by transcript
   * timestamp, not read time), so this is the authoritative "how much did this
   * session spend on day X" source. Persisted onto the session summary so the
   * dashboard's "Spend Today" can sum a session's real today-bucket instead of
   * pro-rating its lifetime `sessionTotalCostUsd` by a tool-call timeline —
   * which mis-attributes a resumed multi-day session's whole cumulative cost to
   * a single day when it has no timeline to pro-rate against.
   */
  readonly costByDayUsd: Record<string, number>;
  /** Subagent-attributed cost bucketed by local-day key; today-scoped
   * counterpart to `subagentCostUsd`. Same rationale as `costByDayUsd`. */
  readonly subagentCostByDayUsd: Record<string, number>;
  /**
   * The combined correction factor (`rateMultiplier` × the 1.1 data-residency
   * premium when configured — see `CostTrackerOptions`) applied to every
   * dollar figure above. `1` means no correction: every figure is Preflight's
   * own list-price computation, same as before this field existed. Surfaced
   * so a consumer (MCP tool response, dashboard) can label the numbers
   * accordingly instead of implying they match an invoice.
   */
  readonly costRateMultiplierApplied: number;
}

/**
 * Cumulative totals to seed into a freshly-constructed tracker, derived from
 * a previous process's last checkpoint for the SAME session — see
 * `seedFromPersisted()` for why this exists.
 */
export interface CostTrackerSeed {
  readonly totalCostUsd: number;
  readonly subagentCostUsd: number;
  readonly parentCostUsd: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalThinkingTokens: number;
  readonly totalCacheReadTokens: number;
  readonly totalCacheCreationTokens: number;
  readonly totalCacheSavingsUsd: number;
  readonly costByModel: Readonly<Record<string, number>>;
  /** Local-day key (see `localDateKey`) `dayCostUsd`/`daySubagentCostUsd` book against. */
  readonly dayKey: string;
  /** Portion of `totalCostUsd`/`subagentCostUsd` attributable to `dayKey` (see `todayPortionOfSessionCost`). */
  readonly dayCostUsd: number;
  readonly daySubagentCostUsd: number;
  /**
   * Per-workflow-run cost, split by local-day, from the persisted checkpoint
   * — see `seedFromPersisted()`'s doc comment for why this is seeded (unlike
   * `reset()`, which still clears this map for the unrelated "wrong session
   * id" correction case).
   */
  readonly costByWorkflowRunId: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

export interface SubagentMetrics {
  readonly subagentUsd: number;
  readonly parentUsd: number;
  readonly subagentSharePct: number;
  /**
   * Placeholder for future reconciliation: the delta between total tokens
   * reported by a WorkflowRunEvent and the sum of per-subagent cost. null
   * until at least one workflow run has both totals available.
   */
  readonly reconciliationDeltaPct: number | null;
}

// ---------------------------------------------------------------------------
// CostTracker
// ---------------------------------------------------------------------------

export class CostTracker implements Resettable {
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
   * `costByWorkflowRunId.get(runId).get(dayKey) → usd`. Restart-resets to
   * empty UNLESS `seedFromPersisted()` restores it from a persisted
   * checkpoint for this same session (see that method's doc comment).
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
  private readonly rateMultiplier: number;

  /**
   * @param sessionTracker Optional. When provided, `getMetrics().costPerFileModified`
   *   and the `ai.cost.cost_per_file_modified` metric are derived from its
   *   live `uniqueFilesWritten` count. Must track the same session as this
   *   CostTracker — if the two are reset independently (e.g. one on a
   *   session boundary and the other not), the ratio silently blends two
   *   different session histories.
   * @param options.rateMultiplier Combined correction factor for an org's
   *   contracted rate and/or the data-residency premium (see `src/config.ts`'s
   *   `costRateMultiplier`/`dataResidencyPremium` — this constructor takes
   *   their product, already resolved, not the two raw config fields).
   *   Validated at config load (`0 < x`); trusted as-is here. Defaults to `1`
   *   (no correction — list price, same as before this option existed).
   */
  constructor(sessionTracker?: SessionTracker, options?: { rateMultiplier?: number }) {
    this.sessionTracker = sessionTracker ?? null;
    this.rateMultiplier = options?.rateMultiplier ?? 1;
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
    const rawBreakdown = calculateCost(model, usage);
    const breakdown =
      this.rateMultiplier === 1
        ? rawBreakdown
        : scaleCostBreakdown(rawBreakdown, this.rateMultiplier);
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

  /**
   * Seeds cumulative totals from a previous process's last checkpoint for
   * this same session. Adds to current state rather than overwriting, so
   * callers must invoke this at most once per (re)adopted session id, before
   * any real activity for that id has been recorded here — see the call
   * sites in `index.ts` for the once-per-id guard.
   *
   * Restart data-loss fix: `ParentTranscriptWatcher`'s transcript-read cursor
   * is durably persisted across process restarts so a resumed session never
   * re-reads old transcript lines — but this tracker's totals are pure
   * in-memory state with no equivalent persistence. Without this seed, every
   * dollar/token attributed to lines a now-dead prior process already
   * consumed is silently and permanently lost the moment a session gets
   * paused and resumed (sleep, closing a terminal, `claude --resume`,
   * a crash) — the longer/more-interrupted the session, the worse the loss.
   *
   * `costByWorkflowRunId` IS seeded (additively, per run+day) — this used to
   * be the one dimension left to reset on restart, but `WorkflowStore`'s
   * `cost_unknown` flag (see its doc comment in `src/dashboard/workflow-store.ts`)
   * depends on `hasCostForWorkflowRun()` staying accurate across a restart
   * too, so it gets the same treatment as everything else here.
   */
  seedFromPersisted(seed: CostTrackerSeed): void {
    const hasAnyTotal =
      seed.totalCostUsd !== 0 ||
      seed.totalInputTokens !== 0 ||
      seed.totalOutputTokens !== 0 ||
      seed.totalThinkingTokens !== 0 ||
      seed.totalCacheReadTokens !== 0 ||
      seed.totalCacheCreationTokens !== 0;
    if (!hasAnyTotal) return;

    this.totalCostUsd += seed.totalCostUsd;
    this.subagentCostUsd += seed.subagentCostUsd;
    this.parentCostUsd += seed.parentCostUsd;
    this.totalInputTokens += seed.totalInputTokens;
    this.totalOutputTokens += seed.totalOutputTokens;
    this.totalThinkingTokens += seed.totalThinkingTokens;
    this.totalCacheReadTokens += seed.totalCacheReadTokens;
    this.totalCacheCreationTokens += seed.totalCacheCreationTokens;
    this.totalCacheSavingsUsd += seed.totalCacheSavingsUsd;
    this.reportCount += 1;

    for (const [model, usd] of Object.entries(seed.costByModel)) {
      this.costByModel.set(model, (this.costByModel.get(model) ?? 0) + usd);
    }

    if (seed.dayCostUsd !== 0) {
      this.costByDayUsd.set(
        seed.dayKey,
        (this.costByDayUsd.get(seed.dayKey) ?? 0) + seed.dayCostUsd,
      );
      this.lastMutationMsByDay.set(seed.dayKey, Date.now());
      const existingFirst = this.firstActivityMsByDay.get(seed.dayKey);
      if (existingFirst === undefined) {
        this.firstActivityMsByDay.set(seed.dayKey, Date.now());
      }
    }
    if (seed.daySubagentCostUsd !== 0) {
      this.subagentCostByDayUsd.set(
        seed.dayKey,
        (this.subagentCostByDayUsd.get(seed.dayKey) ?? 0) + seed.daySubagentCostUsd,
      );
    }

    for (const [runId, days] of Object.entries(seed.costByWorkflowRunId)) {
      const runMap = this.costByWorkflowRunId.get(runId) ?? new Map<string, number>();
      for (const [dayKey, usd] of Object.entries(days)) {
        runMap.set(dayKey, (runMap.get(dayKey) ?? 0) + usd);
      }
      this.costByWorkflowRunId.set(runId, runMap);
    }
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

  /**
   * Whether THIS process's live CostTracker has ever observed a token event
   * for `runId` at all, distinct from `getCostForWorkflowRun()` returning 0.
   * That 0 is ambiguous: it means either "confirmed $0 spend" or "this
   * process never personally observed this run's cost" — e.g. in a
   * `--local` standalone dashboard reading rollups from disk for a run a
   * different, concurrently-running `--stdio` process is the one actually
   * paying for. (A sequential process restart for the SAME session no
   * longer hits this ambiguity — `seedFromPersisted()` rehydrates
   * `costByWorkflowRunId` from the session's own last checkpoint.)
   * `WorkflowStore` uses this to distinguish the two so the "Workflow
   * spend" KPI can flag a total as partial instead of silently treating
   * "unknown" as "zero".
   */
  hasCostForWorkflowRun(runId: string): boolean {
    return this.costByWorkflowRunId.has(runId);
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
   * `reconciliationDeltaPct` is a placeholder: it will compare the
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

    const totalTokensAllTypes =
      this.totalInputTokens +
      this.totalOutputTokens +
      this.totalThinkingTokens +
      this.totalCacheReadTokens +
      this.totalCacheCreationTokens;

    return {
      sessionTotalCostUsd: hasData ? this.totalCostUsd : null,
      costByTask: null,
      costByModel: Object.fromEntries(this.costByModel),
      costPerLineOfCode:
        hasData && this.totalLinesChanged > 0 ? this.totalCostUsd / this.totalLinesChanged : null,
      costPerFileModified:
        hasData && uniqueFilesWritten > 0 ? this.totalCostUsd / uniqueFilesWritten : null,
      costPerMillionTokens:
        hasData && totalTokensAllTypes > 0
          ? (this.totalCostUsd / totalTokensAllTypes) * 1_000_000
          : null,
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
      costByDayUsd: Object.fromEntries(this.costByDayUsd),
      subagentCostByDayUsd: Object.fromEntries(this.subagentCostByDayUsd),
      costRateMultiplierApplied: this.rateMultiplier,
    };
  }

  emitMetrics(aggregator: MetricAggregator): void {
    const attrs: Record<string, string | number> = {};
    if (this.currentModel) {
      attrs.model = this.currentModel;
    }

    // Deliberately not emitted as its own NR metric: cost-per-million-tokens
    // is a pure ratio of session_total_usd and the tokens_* counts already
    // emitted below, so NRQL can compute it at query time
    // (sum(cost)/sum(tokens)*1e6) with full facet/time-window flexibility —
    // a pre-baked gauge scoped to today's attrs would be strictly less
    // flexible and adds ingest volume for no analytical benefit. It's still
    // computed locally (see getMetrics().costPerMillionTokens) for the MCP
    // tool responses and local dashboard, which have no NRQL alternative.
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

  reset(_sessionId: string): void {
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
