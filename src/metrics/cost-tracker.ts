/**
 * Cost Tracking — maintains running token counts and cost calculations.
 *
 * Two paths feed into the tracker:
 *   1. Self-reporting via the `nr_observe_report_tokens` MCP tool (primary)
 *   2. Estimation from hook input/output byte sizes (fallback)
 *
 * Cost calculation delegates to `calculateModelCost()` (pricing-overlay.ts), which normalizes the model id and wraps `calculateCost()`.
 */

import type { TokenUsage, CostBreakdown, MetricAggregator } from '../core/index.js';
import { createLogger } from '../core/index.js';
import { CallUsageBook, type CallUsageByDay } from './call-usage.js';
import { priceModelUsage } from './pricing-overlay.js';
import { localDateKey } from '../lib/date.js';
import type { SessionTracker } from './session-tracker.js';
import type { Resettable, SeedOrigin } from './tracker-contracts.js';
import { HIGH_CONTEXT_TOKENS } from '../storage/types.js';
import type { AttributionBucket } from '../storage/types.js';

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
  /**
   * Best-effort subagent type for this `agentId`, supplied by the caller from
   * the subagent transcript's `agent-<id>.meta.json` sidecar, the hook
   * envelope of one of that subagent's tool calls, or, failing those, the
   * parent's `Agent` tool call (see `SubagentAttributionIndex`). Absent when
   * none has been seen yet for this `agentId`.
   */
  readonly agentType?: string;
  /**
   * Time (ms) spent waiting on the model API for this turn, from
   * `ParentTranscriptWatcher`'s gap between the assistant transcript line
   * and the line before it (see `TokenHookEvent.responseMs`). Absent when
   * no transcript was observed for this token event. Accumulates into
   * `CostMetrics.apiDurationMs`, which stays `null` until the first
   * observation.
   */
  readonly responseMs?: number;
  /**
   * Set by `onTokenEvent`, i.e. by the usage watchers (the Claude Code
   * transcript watcher, `CopilotUsageWatcher`, `CopilotAppUsageWatcher`, and
   * the Copilot SDK extension), whose reports replay history and so cover the
   * turns the byte estimates stood in for. `CopilotAppUsageWatcher` skips an
   * over-threshold first-seen backlog, so its next delta can drop estimates
   * for turns that are never reported. A self-report
   * (`nr_observe_report_tokens`) describes one response and must leave the
   * estimates for earlier turns in place.
   */
  readonly replacesEstimates?: boolean;
}

const LATE_ARRIVAL_REJECTION_MS = 48 * 60 * 60 * 1000;

/**
 * Scales every dollar field of a `CostBreakdown` by `factor`, leaving token
 * counts and everything else untouched. Used to correct Preflight's own
 * list-price computation to an org's real contracted rate (see
 * `CostTrackerOptions.rateMultiplier`). It stays out of `calculateCost()`
 * because the dashboard API, the subagent timeline and `AiTurnCost` share
 * that function and report list price.
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

function subtractFromMap(target: Map<string, number>, amounts: ReadonlyMap<string, number>): void {
  for (const [key, usd] of amounts) {
    const remaining = (target.get(key) ?? 0) - usd;
    if (remaining > 1e-12) target.set(key, remaining);
    else target.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UnpricedModelUsage {
  readonly calls: number;
  /** input + output + thinking + cache-read + cache-creation tokens of the unpriced calls */
  readonly tokens: number;
}

export interface EstimatedModelUsage extends UnpricedModelUsage {
  /** Table id whose price stood in for this model's missing one. */
  readonly estimatedFrom: string;
}

/**
 * The part of the session total that came from byte-size estimates
 * (`recordEstimatedTokens`) rather than a real token report. Kept as its own
 * ledger so a transcript replay can take it back out: the same turns arrive
 * again as exact usage once the transcript watcher reads from byte 0. A
 * self-report (`nr_observe_report_tokens`) describes one response and leaves
 * the ledger in place.
 */
export interface ByteEstimateLedger {
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costByModel: Readonly<Record<string, number>>;
  readonly costByDayUsd: Readonly<Record<string, number>>;
  /**
   * The unpriced and estimated-price calls those estimates counted, so the
   * report that replaces them takes the counts back out with the cost. Absent
   * on a ledger written before they were kept.
   */
  readonly unpricedByModel?: Readonly<Record<string, UnpricedModelUsage>>;
  readonly estimatedByModel?: Readonly<Record<string, EstimatedModelUsage>>;
  readonly unpricedByDay?: Readonly<CallUsageByDay<UnpricedModelUsage>>;
  readonly estimatedByDay?: Readonly<CallUsageByDay<EstimatedModelUsage>>;
}

export interface CostMetrics {
  readonly sessionTotalCostUsd: number | null;
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
  /**
   * Byte-estimated share of the totals still awaiting a real report. Present
   * once any estimate has been recorded or seeded; all-zero after a real
   * report took the estimates back out, so a persisted copy is overwritten
   * rather than left stale.
   */
  readonly byteEstimates?: ByteEstimateLedger;
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
  readonly firstActivityByDayMs: Record<string, number>;
  /** Subagent-attributed cost bucketed by local-day key; today-scoped
   * counterpart to `subagentCostUsd`. Same rationale as `costByDayUsd`. */
  readonly subagentCostByDayUsd: Record<string, number>;
  /**
   * Calls whose model had no price (recorded as $0), keyed by the model id as
   * reported. Spend is understated by exactly these calls.
   */
  readonly unpricedByModel: Record<string, UnpricedModelUsage>;
  /**
   * Calls priced from a sibling model of the same family. Their cost is in the
   * totals but is an estimate.
   */
  readonly estimatedByModel: Record<string, EstimatedModelUsage>;
  /**
   * `unpricedByModel` split by the local day each call was recorded in, the way
   * `costByDayUsd` splits cost, so a consumer scoped to one day counts only that
   * day's calls. A late arrival counts in `unpricedByModel` but in no day.
   */
  readonly unpricedByDay: CallUsageByDay<UnpricedModelUsage>;
  /** `estimatedByModel` split by local day; see `unpricedByDay`. */
  readonly estimatedByDay: CallUsageByDay<EstimatedModelUsage>;
  /**
   * Subagent-attributed spend bucketed by `ctx.agentType` (best-effort — see
   * `TokenRecordContext.agentType`). Only token events whose `agentId` had a
   * known type when recorded land here; the rest are counted in
   * `subagentCostUsd` but not broken out by type. `count` is the number of
   * token events attributed to that agent type; `durationMs` is always 0 (no
   * per-call duration signal reaches this tracker). In-memory only — unlike
   * `costByModel`, this does NOT survive a process restart.
   */
  readonly subagentByAgentType: Record<string, AttributionBucket>;
  /**
   * Cumulative cost of every token event whose prompt (input + cache-read +
   * cache-creation tokens) exceeded {@link HIGH_CONTEXT_TOKENS}.
   */
  readonly highContextCostUsd: number;
  /**
   * Sum of every token event's `ctx.responseMs` (see `TokenRecordContext`) —
   * an estimate of cumulative time spent waiting on the model API. `null`
   * until the first token event that carries a `responseMs`.
   */
  readonly apiDurationMs: number | null;
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
  readonly dayFirstActivityMs?: number;
  /** When the persisted session began, so a restart keeps measuring the session's age from its real start. */
  readonly sessionStartMs?: number;
  /**
   * Per-workflow-run cost, split by local-day, from the persisted checkpoint
   * — see `seedFromPersisted()`'s doc comment for why this is seeded (unlike
   * `reset()`, which still clears this map for the unrelated "wrong session
   * id" correction case).
   */
  readonly costByWorkflowRunId: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly unpricedByModel?: Readonly<Record<string, UnpricedModelUsage>>;
  readonly estimatedByModel?: Readonly<Record<string, EstimatedModelUsage>>;
  /**
   * Absent on a checkpoint written before day buckets existed; its counts then
   * book to `legacyCallsDayKey`.
   */
  readonly unpricedByDay?: Readonly<CallUsageByDay<UnpricedModelUsage>>;
  readonly estimatedByDay?: Readonly<CallUsageByDay<EstimatedModelUsage>>;
  /** The checkpoint's own latest day, so a resumed legacy session's calls stay off today. Defaults to `dayKey`. */
  readonly legacyCallsDayKey?: string;
  /** Restored separately so the seed can tell exact tokens from estimated ones. See `ByteEstimateLedger`. */
  readonly byteEstimates?: ByteEstimateLedger;
  /**
   * False when the persisted exact share (`exactTotals`) is empty, so the
   * session held byte estimates only. Absent means an exact report happened:
   * summaries written before the exact/estimate split counted as reported.
   */
  readonly hadExactReport?: boolean;
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

interface PricedCall {
  readonly model: string;
  readonly usage: TokenUsage;
  readonly breakdown: CostBreakdown;
  readonly dayKey: string | null;
  readonly timestampMs: number;
  readonly agentId: string | undefined;
  readonly workflowRunId: string | null | undefined;
  readonly unpriced: UnpricedModelUsage | null;
  readonly estimated: EstimatedModelUsage | null;
  readonly isByteEstimate: boolean;
}

class CostBook {
  totalCostUsd = 0;
  totalInputTokens = 0;
  totalOutputTokens = 0;
  totalThinkingTokens = 0;
  totalCacheReadTokens = 0;
  totalCacheCreationTokens = 0;
  totalCacheSavingsUsd = 0;
  reportCount = 0;
  estimationCount = 0;
  subagentCostUsd = 0;
  parentCostUsd = 0;
  byteEstimateCostUsd = 0;
  byteEstimateInputTokens = 0;
  byteEstimateOutputTokens = 0;
  byteEstimateCostByModel = new Map<string, number>();
  byteEstimateCostByDay = new Map<string, number>();
  /** True once a ledger exists to report, even if a real report has since emptied it. */
  hasByteEstimateHistory = false;
  readonly costByModel = new Map<string, number>();
  readonly unpriced = new CallUsageBook<UnpricedModelUsage>();
  readonly estimated = new CallUsageBook<EstimatedModelUsage>();
  /** The share of `unpriced` and `estimated` that came from byte estimates. */
  readonly byteEstimateUnpriced = new CallUsageBook<UnpricedModelUsage>();
  readonly byteEstimateEstimated = new CallUsageBook<EstimatedModelUsage>();
  // Per-day cost attribution. Each token event is bucketed into the local-day
  // it was recorded in, so consumers asking "how much did this session spend
  // today" can get a real answer when a session crosses midnight. Without
  // this, dashboard "Today Spend" counts the entire session against today,
  // including tokens spent before midnight.
  readonly costByDayUsd = new Map<string, number>();
  /** Subagent-attributed spend per local-day key, for a today-scoped KPI. */
  readonly subagentCostByDayUsd = new Map<string, number>();
  readonly firstActivityMsByDay = new Map<string, number>();
  /** Days seeded with spend but no persisted first spend: the real first spend is unknown, so no anchor is saved. */
  readonly unanchoredDays = new Set<string>();
  /**
   * Per-workflow-run cost attribution split by local-day so a run that crosses
   * midnight contributes to each day's bucket independently. Two-level map:
   * `costByWorkflowRunId.get(runId).get(dayKey) → usd`.
   */
  readonly costByWorkflowRunId = new Map<string, Map<string, number>>();

  addCall(call: PricedCall): void {
    const { model, usage, breakdown, dayKey } = call;
    if (call.unpriced) {
      this.unpriced.add(model, dayKey, call.unpriced);
      if (call.isByteEstimate) this.byteEstimateUnpriced.add(model, dayKey, call.unpriced);
    } else if (call.estimated) {
      this.estimated.add(model, dayKey, call.estimated);
      if (call.isByteEstimate) this.byteEstimateEstimated.add(model, dayKey, call.estimated);
    }

    this.totalCostUsd += breakdown.totalUsd;
    this.totalInputTokens += usage.inputTokens;
    this.totalOutputTokens += usage.outputTokens;
    this.totalThinkingTokens += usage.thinkingTokens;
    this.totalCacheReadTokens += usage.cacheReadTokens;
    this.totalCacheCreationTokens += usage.cacheCreationTokens;
    this.costByModel.set(model, (this.costByModel.get(model) ?? 0) + breakdown.totalUsd);
    this.totalCacheSavingsUsd += breakdown.savingsFromCacheUsd;
    if (call.agentId !== undefined) {
      this.subagentCostUsd += breakdown.totalUsd;
    } else {
      this.parentCostUsd += breakdown.totalUsd;
    }
    if (dayKey === null) return;

    this.costByDayUsd.set(dayKey, (this.costByDayUsd.get(dayKey) ?? 0) + breakdown.totalUsd);
    if (call.agentId !== undefined) {
      this.subagentCostByDayUsd.set(
        dayKey,
        (this.subagentCostByDayUsd.get(dayKey) ?? 0) + breakdown.totalUsd,
      );
    }
    const existingFirst = this.firstActivityMsByDay.get(dayKey);
    if (
      breakdown.totalUsd > 0 &&
      !this.unanchoredDays.has(dayKey) &&
      (existingFirst === undefined || call.timestampMs < existingFirst)
    ) {
      // Use earliest event timestamp for the day so cross-midnight burn-rate
      // denominators stay correct (NOT wall-clock arrival time).
      this.firstActivityMsByDay.set(dayKey, call.timestampMs);
    }
    if (call.workflowRunId) {
      const runMap = this.costByWorkflowRunId.get(call.workflowRunId) ?? new Map<string, number>();
      runMap.set(dayKey, (runMap.get(dayKey) ?? 0) + breakdown.totalUsd);
      this.costByWorkflowRunId.set(call.workflowRunId, runMap);
    }
    if (!call.isByteEstimate) return;

    this.hasByteEstimateHistory = true;
    this.byteEstimateCostUsd += breakdown.totalUsd;
    this.byteEstimateInputTokens += usage.inputTokens;
    this.byteEstimateOutputTokens += usage.outputTokens;
    this.byteEstimateCostByModel.set(
      model,
      (this.byteEstimateCostByModel.get(model) ?? 0) + breakdown.totalUsd,
    );
    this.byteEstimateCostByDay.set(
      dayKey,
      (this.byteEstimateCostByDay.get(dayKey) ?? 0) + breakdown.totalUsd,
    );
  }

  cacheHitRate(): number | null {
    const denominator =
      this.totalInputTokens + this.totalCacheReadTokens + this.totalCacheCreationTokens;
    if (denominator === 0) return null;
    if (this.totalCacheReadTokens === 0 && this.totalCacheCreationTokens === 0) return null;
    return this.totalCacheReadTokens / denominator;
  }

  /**
   * Takes the byte-estimated share back out of the totals. Subtraction clamps
   * at zero because a seeded ledger can name a day or model the seeded totals
   * bucketed differently.
   */
  discardByteEstimates(): void {
    this.totalCostUsd = Math.max(0, this.totalCostUsd - this.byteEstimateCostUsd);
    this.parentCostUsd = Math.max(0, this.parentCostUsd - this.byteEstimateCostUsd);
    this.totalInputTokens = Math.max(0, this.totalInputTokens - this.byteEstimateInputTokens);
    this.totalOutputTokens = Math.max(0, this.totalOutputTokens - this.byteEstimateOutputTokens);
    subtractFromMap(this.costByModel, this.byteEstimateCostByModel);
    subtractFromMap(this.costByDayUsd, this.byteEstimateCostByDay);
    this.byteEstimateCostUsd = 0;
    this.byteEstimateInputTokens = 0;
    this.byteEstimateOutputTokens = 0;
    this.byteEstimateCostByModel = new Map();
    this.byteEstimateCostByDay = new Map();
    this.unpriced.subtract(this.byteEstimateUnpriced);
    this.estimated.subtract(this.byteEstimateEstimated);
    this.byteEstimateUnpriced.clear();
    this.byteEstimateEstimated.clear();
  }

  addSeed(seed: CostTrackerSeed): void {
    this.totalCostUsd += seed.totalCostUsd;
    this.subagentCostUsd += seed.subagentCostUsd;
    this.parentCostUsd += seed.parentCostUsd;
    this.totalInputTokens += seed.totalInputTokens;
    this.totalOutputTokens += seed.totalOutputTokens;
    this.totalThinkingTokens += seed.totalThinkingTokens;
    this.totalCacheReadTokens += seed.totalCacheReadTokens;
    this.totalCacheCreationTokens += seed.totalCacheCreationTokens;
    this.totalCacheSavingsUsd += seed.totalCacheSavingsUsd;
    if (seed.hadExactReport === false) this.estimationCount += 1;
    else this.reportCount += 1;
    const legacyCallsDayKey = seed.legacyCallsDayKey ?? seed.dayKey;
    if (seed.byteEstimates !== undefined) {
      this.hasByteEstimateHistory = true;
      this.byteEstimateCostUsd += seed.byteEstimates.costUsd;
      this.byteEstimateInputTokens += seed.byteEstimates.inputTokens;
      this.byteEstimateOutputTokens += seed.byteEstimates.outputTokens;
      for (const [model, usd] of Object.entries(seed.byteEstimates.costByModel)) {
        this.byteEstimateCostByModel.set(
          model,
          (this.byteEstimateCostByModel.get(model) ?? 0) + usd,
        );
      }
      for (const [day, usd] of Object.entries(seed.byteEstimates.costByDayUsd)) {
        this.byteEstimateCostByDay.set(day, (this.byteEstimateCostByDay.get(day) ?? 0) + usd);
        // The seed's own day cost already holds that day's estimates.
        if (day !== seed.dayKey) {
          this.costByDayUsd.set(day, (this.costByDayUsd.get(day) ?? 0) + usd);
        }
      }
      this.byteEstimateUnpriced.addRecords(
        seed.byteEstimates.unpricedByModel,
        seed.byteEstimates.unpricedByDay,
        legacyCallsDayKey,
      );
      this.byteEstimateEstimated.addRecords(
        seed.byteEstimates.estimatedByModel,
        seed.byteEstimates.estimatedByDay,
        legacyCallsDayKey,
      );
    }

    for (const [model, usd] of Object.entries(seed.costByModel)) {
      this.costByModel.set(model, (this.costByModel.get(model) ?? 0) + usd);
    }

    this.unpriced.addRecords(seed.unpricedByModel, seed.unpricedByDay, legacyCallsDayKey);
    this.estimated.addRecords(seed.estimatedByModel, seed.estimatedByDay, legacyCallsDayKey);

    if (seed.dayCostUsd !== 0) {
      this.costByDayUsd.set(
        seed.dayKey,
        (this.costByDayUsd.get(seed.dayKey) ?? 0) + seed.dayCostUsd,
      );
      if (seed.dayFirstActivityMs === undefined) {
        this.firstActivityMsByDay.delete(seed.dayKey);
        this.unanchoredDays.add(seed.dayKey);
      } else if (!this.unanchoredDays.has(seed.dayKey)) {
        const existingFirst = this.firstActivityMsByDay.get(seed.dayKey);
        if (existingFirst === undefined || seed.dayFirstActivityMs < existingFirst) {
          this.firstActivityMsByDay.set(seed.dayKey, seed.dayFirstActivityMs);
        }
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
}

// ---------------------------------------------------------------------------
// CostTracker
// ---------------------------------------------------------------------------

export class CostTracker implements Resettable {
  private sessionTracker: SessionTracker | null;

  private held = new CostBook();
  private own = new CostBook();
  private currentModel: string | null = null;
  private latestCostBreakdown: CostBreakdown | null = null;
  /** Earliest start among the persisted sessions seeded into this tracker, so spend carried over from before a restart is not spread over only the new process's age. */
  private seededSessionStartMs: number | null = null;
  /**
   * Per-workflow-run, per-subagent token total of the agent's latest turn
   * (all five token kinds), observed by this process. The on-disk run rollup
   * (`totalTokens`) is the sum of each agent's last turn, not of every turn,
   * so this keeps the same basis. Never persisted: a run restored by
   * `seedFromPersisted()` is recorded in `seededWorkflowRunIds` and reports no
   * tokens, because a partial live sum would read as a false reconciliation gap.
   */
  private lastTurnTokensByWorkflowRunId = new Map<string, Map<string, number>>();
  private seededWorkflowRunIds = new Set<string>();
  /** Per-day mutation counter so dashboards can invalidate cached day cards. */
  private lastMutationMsByDay = new Map<string, number>();
  /** Subagent-attributed spend per `ctx.agentType` — see `CostMetrics.subagentByAgentType`. */
  private subagentByAgentType = new Map<string, AttributionBucket>();
  /** See `CostMetrics.highContextCostUsd`. */
  private highContextCostUsd = 0;
  /** See `CostMetrics.apiDurationMs`; null until the first `ctx.responseMs` observation. */
  private apiDurationMs: number | null = null;
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
   * Prices a usage without recording it, applying this tracker's rate
   * multiplier. For events that belong to another session: the caller still
   * needs the dollar figure for that session's own rollup, but must not fold it
   * into this process-wide total.
   */
  priceUsage(usage: TokenUsage, model: string): CostBreakdown {
    const { breakdown } = priceModelUsage(model, usage);
    return this.rateMultiplier === 1
      ? breakdown
      : scaleCostBreakdown(breakdown, this.rateMultiplier);
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
    for (const book of this.books()) {
      book.reportCount++;
      if (ctx?.replacesEstimates === true && ctx.agentId === undefined) {
        book.discardByteEstimates();
      }
    }
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

    for (const book of this.books()) book.estimationCount++;
    return this.accumulateTokens(usage, model, { timestampMs: Date.now() }, true);
  }

  private books(): readonly CostBook[] {
    return [this.held, this.own];
  }

  /**
   * Shared by both the late-arrival and normal paths of `accumulateTokens`:
   * per-agent-type subagent bucketing, high-context spend, and API-duration
   * accumulation. All three are session-level totals like `subagentCostUsd`/
   * `parentCostUsd` above, so — like those — they still accumulate on a late
   * arrival even though day bucketing is skipped for one.
   */
  private recordAttributionSideEffects(
    usage: TokenUsage,
    ctx: TokenRecordContext | undefined,
    breakdown: CostBreakdown,
  ): void {
    if (ctx?.agentId !== undefined && ctx.agentType !== undefined) {
      const tokens =
        usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
      const existing = this.subagentByAgentType.get(ctx.agentType);
      const existingBreakdown = existing?.breakdown;
      const existingUsd = existing?.breakdownUsd;
      this.subagentByAgentType.set(ctx.agentType, {
        costUsd: (existing?.costUsd ?? 0) + breakdown.totalUsd,
        tokens: (existing?.tokens ?? 0) + tokens,
        count: (existing?.count ?? 0) + 1,
        durationMs: 0,
        breakdown: {
          inputTokens: (existingBreakdown?.inputTokens ?? 0) + usage.inputTokens,
          outputTokens: (existingBreakdown?.outputTokens ?? 0) + usage.outputTokens,
          cacheReadTokens: (existingBreakdown?.cacheReadTokens ?? 0) + usage.cacheReadTokens,
          cacheCreationTokens:
            (existingBreakdown?.cacheCreationTokens ?? 0) + usage.cacheCreationTokens,
        },
        breakdownUsd: {
          inputUsd: (existingUsd?.inputUsd ?? 0) + breakdown.inputUsd,
          outputUsd: (existingUsd?.outputUsd ?? 0) + breakdown.outputUsd,
          cacheReadUsd: (existingUsd?.cacheReadUsd ?? 0) + breakdown.cacheReadUsd,
          cacheCreationUsd: (existingUsd?.cacheCreationUsd ?? 0) + breakdown.cacheCreationUsd,
        },
      });
    }

    if (
      usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens >
      HIGH_CONTEXT_TOKENS
    ) {
      this.highContextCostUsd += breakdown.totalUsd;
    }

    if (ctx?.responseMs !== undefined) {
      this.apiDurationMs = (this.apiDurationMs ?? 0) + ctx.responseMs;
    }
  }

  private accumulateTokens(
    usage: TokenUsage,
    model: string,
    ctx?: TokenRecordContext,
    isByteEstimate = false,
  ): CostBreakdown {
    const { breakdown: rawBreakdown, resolution } = priceModelUsage(model, usage);
    const tokens =
      usage.inputTokens +
      usage.outputTokens +
      usage.thinkingTokens +
      usage.cacheReadTokens +
      usage.cacheCreationTokens;
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
    const dayKey = isLate ? null : localDateKey(tsMs);
    const counted = tokens > 0;
    const call: PricedCall = {
      model,
      usage,
      breakdown,
      dayKey,
      timestampMs: tsMs,
      agentId: ctx?.agentId,
      workflowRunId: ctx?.workflowRunId,
      unpriced: counted && resolution.kind === 'unpriced' ? { calls: 1, tokens } : null,
      estimated:
        counted && resolution.kind !== 'unpriced' && resolution.source === 'estimated'
          ? { calls: 1, tokens, estimatedFrom: resolution.estimatedFrom }
          : null,
      isByteEstimate,
    };
    for (const book of this.books()) book.addCall(call);
    this.currentModel = model;
    this.latestCostBreakdown = breakdown;
    this.recordAttributionSideEffects(usage, ctx, breakdown);

    if (dayKey === null) {
      logger.warn('Late-arrival token event dropped from day bucket', {
        timestampMs: ctx?.timestampMs,
        deltaMs: wallNowMs - (ctx?.timestampMs ?? wallNowMs),
      });
      return breakdown;
    }
    this.lastMutationMsByDay.set(dayKey, wallNowMs);
    if (ctx?.workflowRunId) {
      const agentTurns =
        this.lastTurnTokensByWorkflowRunId.get(ctx.workflowRunId) ?? new Map<string, number>();
      agentTurns.set(ctx.agentId ?? '', tokens);
      this.lastTurnTokensByWorkflowRunId.set(ctx.workflowRunId, agentTurns);
    }
    return breakdown;
  }

  /**
   * Seeds cumulative totals from a previous process's last checkpoint for
   * this same session. Adds to current state rather than overwriting, so
   * callers must invoke this at most once per (re)adopted session id, with
   * totals this tracker has not already counted — see
   * `rehydrateTrackersIfResumed` in `index.ts`.
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
   *
   * `getMetrics()` includes every seed. `getOwnMetrics()` includes only a
   * `drainedHere` one (see `SeedOrigin`).
   */
  seedFromPersisted(seed: CostTrackerSeed, origin: SeedOrigin = 'alreadySaved'): void {
    const hasAnyTotal =
      seed.totalCostUsd !== 0 ||
      seed.totalInputTokens !== 0 ||
      seed.totalOutputTokens !== 0 ||
      seed.totalThinkingTokens !== 0 ||
      seed.totalCacheReadTokens !== 0 ||
      seed.totalCacheCreationTokens !== 0;
    if (!hasAnyTotal) return;

    if (seed.sessionStartMs !== undefined && seed.sessionStartMs > 0) {
      this.seededSessionStartMs = Math.min(
        this.seededSessionStartMs ?? seed.sessionStartMs,
        seed.sessionStartMs,
      );
    }
    this.held.addSeed(seed);
    if (origin === 'drainedHere') this.own.addSeed(seed);
    if (seed.dayCostUsd !== 0) this.lastMutationMsByDay.set(seed.dayKey, Date.now());
    for (const runId of Object.keys(seed.costByWorkflowRunId)) this.seededWorkflowRunIds.add(runId);
  }

  /**
   * Cost spent during a specific local-time day, attributed at the moment
   * each token event was recorded. Used to fix the cross-midnight inflation
   * of "Today Spend" — when a session that started yesterday continues into
   * today, this returns only today's portion.
   */
  getCostForDay(dayKey: string): number {
    return this.held.costByDayUsd.get(dayKey) ?? 0;
  }

  /**
   * Subagent-attributed cost during a specific local-time day. Today-scoped
   * counterpart to getSubagentMetrics().subagentUsd (which is session-
   * cumulative) so the "subagent spend" KPI lines up with the day-bucketed
   * "spend today" total.
   */
  getSubagentCostForDay(dayKey: string): number {
    return this.held.subagentCostByDayUsd.get(dayKey) ?? 0;
  }

  /** Earlier of the process start and the saved session start, so a restart keeps the session's real age. */
  getSessionStartMs(processStartMs: number): number {
    return Math.min(processStartMs, this.seededSessionStartMs ?? processStartMs);
  }

  /**
   * Epoch ms of the first token event recorded today (local time), or null
   * if no spend has been booked today. The forecast burn-rate denominator
   * should be (now - firstActivityToday), not (now - sessionStart) — the
   * latter dilutes the rate with idle hours from previous days when a
   * session spans midnight.
   */
  getFirstActivityMsForDay(dayKey: string): number | null {
    return this.held.firstActivityMsByDay.get(dayKey) ?? null;
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
    const m = this.held.costByWorkflowRunId.get(runId);
    if (!m) return 0;
    let total = 0;
    for (const v of m.values()) total += v;
    return total;
  }

  /**
   * Per-workflow-run token total: each subagent's latest turn, summed. That is
   * the basis of the run rollup's `totalTokens`, so the two are comparable.
   * 0 when this process has not observed the run live (unknown, not zero).
   */
  getTokensForWorkflowRun(runId: string): number {
    if (this.seededWorkflowRunIds.has(runId)) return 0;
    let total = 0;
    for (const v of this.lastTurnTokensByWorkflowRunId.get(runId)?.values() ?? []) total += v;
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
    return this.held.costByWorkflowRunId.has(runId);
  }

  /** Iterable view of every (runId, dayKey, usd) tuple — for dashboard joins. */
  *iterCostByWorkflowRun(): IterableIterator<{ runId: string; dayKey: string; usd: number }> {
    for (const [runId, m] of this.held.costByWorkflowRunId) {
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
    const total = this.held.subagentCostUsd + this.held.parentCostUsd;
    const subagentSharePct = total > 0 ? (this.held.subagentCostUsd / total) * 100 : 0;
    return {
      subagentUsd: this.held.subagentCostUsd,
      parentUsd: this.held.parentCostUsd,
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

  /** Seeds plus own work. */
  getMetrics(): CostMetrics {
    return this.metricsOf(this.held);
  }

  /** Only what this process produced itself, plus any `drainedHere` seed. */
  getOwnMetrics(): CostMetrics {
    return this.metricsOf(this.own);
  }

  private metricsOf(book: CostBook): CostMetrics {
    const hasData = book.reportCount > 0 || book.estimationCount > 0;

    const uniqueFilesWritten = this.sessionTracker
      ? this.sessionTracker.getMetrics().uniqueFilesWritten
      : 0;

    // Serialise the two-level Map into a plain Record for JSON compatibility.
    const costByWorkflowRunId: Record<string, Record<string, number>> = {};
    for (const [runId, dayMap] of book.costByWorkflowRunId) {
      costByWorkflowRunId[runId] = Object.fromEntries(dayMap);
    }

    const totalTokensAllTypes =
      book.totalInputTokens +
      book.totalOutputTokens +
      book.totalThinkingTokens +
      book.totalCacheReadTokens +
      book.totalCacheCreationTokens;

    return {
      sessionTotalCostUsd: hasData ? book.totalCostUsd : null,
      costByModel: Object.fromEntries(book.costByModel),
      costPerLineOfCode:
        hasData && this.totalLinesChanged > 0 ? book.totalCostUsd / this.totalLinesChanged : null,
      costPerFileModified:
        hasData && uniqueFilesWritten > 0 ? book.totalCostUsd / uniqueFilesWritten : null,
      costPerMillionTokens:
        hasData && totalTokensAllTypes > 0
          ? (book.totalCostUsd / totalTokensAllTypes) * 1_000_000
          : null,
      model: this.currentModel,
      totalInputTokens: book.totalInputTokens,
      totalOutputTokens: book.totalOutputTokens,
      totalThinkingTokens: book.totalThinkingTokens,
      totalCacheReadTokens: book.totalCacheReadTokens,
      totalCacheCreationTokens: book.totalCacheCreationTokens,
      cacheHitRate: book.cacheHitRate(),
      totalCacheSavingsUsd: book.totalCacheSavingsUsd,
      reportCount: book.reportCount,
      estimationCount: book.estimationCount,
      ...(book.hasByteEstimateHistory && {
        byteEstimates: {
          costUsd: book.byteEstimateCostUsd,
          inputTokens: book.byteEstimateInputTokens,
          outputTokens: book.byteEstimateOutputTokens,
          costByModel: Object.fromEntries(book.byteEstimateCostByModel),
          costByDayUsd: Object.fromEntries(book.byteEstimateCostByDay),
          unpricedByModel: book.byteEstimateUnpriced.byModel(),
          estimatedByModel: book.byteEstimateEstimated.byModel(),
          unpricedByDay: book.byteEstimateUnpriced.byDay(),
          estimatedByDay: book.byteEstimateEstimated.byDay(),
        },
      }),
      latestCostBreakdown: this.latestCostBreakdown,
      subagentCostUsd: book.subagentCostUsd,
      parentCostUsd: book.parentCostUsd,
      costByWorkflowRunId,
      costByDayUsd: Object.fromEntries(book.costByDayUsd),
      firstActivityByDayMs: Object.fromEntries(book.firstActivityMsByDay),
      unpricedByModel: book.unpriced.byModel(),
      estimatedByModel: book.estimated.byModel(),
      unpricedByDay: book.unpriced.byDay(),
      estimatedByDay: book.estimated.byDay(),
      subagentCostByDayUsd: Object.fromEntries(book.subagentCostByDayUsd),
      subagentByAgentType: Object.fromEntries(this.subagentByAgentType),
      highContextCostUsd: this.highContextCostUsd,
      apiDurationMs: this.apiDurationMs,
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
    aggregator.record('ai.cost.session_total_usd', this.held.totalCostUsd, attrs);
    aggregator.record('ai.cost.tokens_input', this.held.totalInputTokens, attrs);
    aggregator.record('ai.cost.tokens_output', this.held.totalOutputTokens, attrs);
    aggregator.record('ai.cost.tokens_thinking', this.held.totalThinkingTokens, attrs);
    aggregator.record('ai.cost.tokens_cache_read', this.held.totalCacheReadTokens, attrs);
    aggregator.record('ai.cost.tokens_cache_creation', this.held.totalCacheCreationTokens, attrs);
    aggregator.record('ai.cost.cache_savings_usd', this.held.totalCacheSavingsUsd, attrs);

    if (this.totalLinesChanged > 0) {
      aggregator.record(
        'ai.cost.cost_per_line_of_code',
        this.held.totalCostUsd / this.totalLinesChanged,
        attrs,
      );
    }

    if (this.sessionTracker) {
      const uniqueFilesWritten = this.sessionTracker.getMetrics().uniqueFilesWritten;
      if (uniqueFilesWritten > 0) {
        aggregator.record(
          'ai.cost.cost_per_file_modified',
          this.held.totalCostUsd / uniqueFilesWritten,
          attrs,
        );
      }
    }

    aggregator.record('ai.cost.report_count', this.held.reportCount, attrs);
    aggregator.record('ai.cost.estimation_count', this.held.estimationCount, attrs);
    aggregator.record('ai.cost.subagent_usd', this.held.subagentCostUsd, attrs);
    aggregator.record('ai.cost.parent_usd', this.held.parentCostUsd, attrs);
    for (const [model, entry] of this.held.unpriced.entries()) {
      aggregator.record('ai.cost.unpriced_calls', entry.calls, { model });
    }
    for (const [model, entry] of this.held.estimated.entries()) {
      aggregator.record('ai.cost.estimated_calls', entry.calls, {
        model,
        estimatedFrom: entry.estimatedFrom,
      });
    }
  }

  reset(_sessionId: string): void {
    this.held = new CostBook();
    this.own = new CostBook();
    this.currentModel = null;
    this.latestCostBreakdown = null;
    this.subagentByAgentType = new Map();
    this.highContextCostUsd = 0;
    this.apiDurationMs = null;
    this.seededSessionStartMs = null;
    this.lastTurnTokensByWorkflowRunId = new Map();
    this.seededWorkflowRunIds = new Set();
    this.lastMutationMsByDay = new Map();
    this.totalLinesChanged = 0;
  }
}
