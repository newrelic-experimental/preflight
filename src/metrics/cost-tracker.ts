/**
 * Cost Tracking — maintains running token counts and cost calculations.
 *
 * Three paths feed into the tracker, all into one `UsageLedger` keyed by each
 * API call's id (see usage-ledger.ts):
 *   1. Token reports from the transcript, Copilot and subagent watchers
 *   2. Self-reporting via the `nr_observe_report_tokens` MCP tool
 *   3. Estimation from hook input/output byte sizes (fallback)
 *
 * Cost calculation delegates to `calculateModelCost()` (pricing-overlay.ts), which normalizes the model id and wraps the shared `calculateCost()`.
 */

import { randomUUID } from 'node:crypto';

import type { TokenUsage, CostBreakdown, MetricAggregator } from '../shared/index.js';
import { createLogger } from '../shared/index.js';

import { priceModelUsage } from './pricing-overlay.js';
import { localDateKey } from '../lib/date.js';
import type { SessionTracker } from './session-tracker.js';
import type { Resettable } from './tracker-contracts.js';
import type { AttributionBucket } from '../storage/types.js';
import {
  LATE_ARRIVAL_MS,
  UsageLedger,
  ZERO_TOTALS,
  dayOf,
  foldUsage,
  isZeroTotals,
  subtractTotals,
} from './usage-ledger.js';
import type {
  ByteEstimateLedger,
  CallUsageByDay,
  CostTotals,
  EntryCalls,
  EstimatedModelUsage,
  PersistedUsageLedger,
  PricingMark,
  UnpricedModelUsage,
  UsageEntry,
} from './usage-ledger.js';

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
  /**
   * The API call's own id (Anthropic message id, Copilot `responseId`, Copilot
   * SDK `apiCallId`, a self-report's `request_id`). A usage whose id is
   * already in the ledger adds nothing. Omitted, the usage gets an id of its
   * own and is never deduplicated. See `UsageLedger`.
   */
  readonly usageId?: string;
}

const LATE_ARRIVAL_REJECTION_MS = LATE_ARRIVAL_MS;

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

export type { UnpricedModelUsage, EstimatedModelUsage, ByteEstimateLedger, CallUsageByDay };

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
   * once any estimate has been recorded or seeded; all-zero once real reports
   * retired every estimate.
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
   * per-call duration signal reaches this tracker). Survives a restart for
   * the calls whose usage-ledger entries carry their agent type.
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
  /**
   * The persisted usage ledger (see `usageLedgerOf` in session-store.ts). When
   * present it is what gets seeded, as a union, and the flat totals above are
   * ignored: seeding the same ledger twice changes nothing.
   */
  readonly ledger?: { readonly entries: readonly UsageEntry[]; readonly base: CostTotals };
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

/** What `recordUsage` did with a usage. */
export interface RecordedUsage {
  readonly breakdown: CostBreakdown;
  /** False when the call's id was already in the ledger, so nothing was added. */
  readonly recorded: boolean;
  /** The usage priced: the part of a Copilot app range the ledger did not already hold, else all of it. */
  readonly usage: TokenUsage;
}

/**
 * Every total this tracker reports is computed from its `UsageLedger`: a map
 * from each API call's id to its usage. See usage-ledger.ts for why.
 */
export class CostTracker implements Resettable {
  private sessionTracker: SessionTracker | null;

  private ledger = new UsageLedger();
  /** Unique per tracker, so ids it synthesizes never collide with another process's. */
  private readonly instanceId = randomUUID().slice(0, 8);
  private synthesizedSeq = 0;
  private currentModel: string | null = null;
  private reportCount = 0;
  private estimationCount = 0;
  private latestCostBreakdown: CostBreakdown | null = null;
  private firstActivityMsByDay = new Map<string, number>();
  /** Days seeded with spend but no persisted first spend: the real first spend is unknown, so no anchor is saved. */
  private unanchoredDays = new Set<string>();
  /** Per-day mutation counter so dashboards can invalidate cached day cards. */
  private lastMutationMsByDay = new Map<string, number>();
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
    return this.price(usage, model).breakdown;
  }

  private price(
    usage: TokenUsage,
    model: string,
  ): { breakdown: CostBreakdown; pricing: PricingMark | undefined } {
    const { breakdown: raw, resolution } = priceModelUsage(model, usage);
    const breakdown =
      this.rateMultiplier === 1 ? raw : scaleCostBreakdown(raw, this.rateMultiplier);
    const pricing: PricingMark | undefined =
      resolution.kind === 'unpriced'
        ? { kind: 'unpriced' }
        : resolution.source === 'estimated'
          ? { estimatedFrom: resolution.estimatedFrom }
          : undefined;
    return { breakdown, pricing };
  }

  private synthesizeId(kind: 'anon' | 'est'): string {
    return `${kind}:${this.instanceId}:${++this.synthesizedSeq}`;
  }

  /**
   * Primary path: record exact token usage from a watcher or a self-report.
   * Returns this usage's price whether or not its id was new; use
   * `recordUsage` to learn which.
   *
   * The optional `ctx` argument lets the subagent watcher attribute tokens
   * to the actual JSONL `timestamp` (rather than `Date.now()`) so a run
   * that crosses midnight is bucketed correctly, AND to a `workflowRunId` /
   * `agentId` for per-run and subagent/parent cost attribution.
   */
  recordTokenUsage(usage: TokenUsage, model: string, ctx?: TokenRecordContext): CostBreakdown {
    return this.recordUsage(usage, model, ctx).breakdown;
  }

  recordUsage(whole: TokenUsage, model: string, ctx?: TokenRecordContext): RecordedUsage {
    // A Copilot app range may reach past what the ledger holds: only the
    // uncovered tail is new, so that tail is what gets priced and recorded.
    const claim = ctx?.usageId === undefined ? null : this.ledger.claim(ctx.usageId, whole);
    if (ctx?.usageId !== undefined && !claim) {
      return { breakdown: this.price(whole, model).breakdown, recorded: false, usage: whole };
    }
    const usage = claim?.usage ?? whole;
    const { breakdown, pricing } = this.price(usage, model);
    const wallNowMs = Date.now();
    const ts = ctx?.timestampMs ?? wallNowMs;
    const day = dayOf(ts, wallNowMs, LATE_ARRIVAL_REJECTION_MS);
    if (day === null) {
      logger.warn('Late-arrival token event dropped from day bucket', {
        timestampMs: ts,
        deltaMs: wallNowMs - ts,
      });
    }
    const id = claim?.id ?? this.synthesizeId('anon');
    const recorded = this.ledger.insert({
      id,
      provisional: false,
      replaces: ctx?.replacesEstimates === true && ctx.agentId === undefined,
      ts,
      day,
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      thinkingTokens: usage.thinkingTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      costUsd: breakdown.totalUsd,
      cacheSavingsUsd: breakdown.savingsFromCacheUsd,
      ...(ctx?.agentId !== undefined && { agentId: ctx.agentId }),
      ...(ctx?.agentId !== undefined &&
        ctx.agentType !== undefined && { agentType: ctx.agentType }),
      ...(ctx?.workflowRunId && day !== null && { workflowRunId: ctx.workflowRunId }),
      ...(pricing && { pricing }),
      ...(ctx?.responseMs !== undefined && { responseMs: ctx.responseMs }),
    });
    if (recorded) {
      this.reportCount++;
      this.noteActivity(day, ts, wallNowMs, breakdown.totalUsd);
      this.currentModel = model;
      this.latestCostBreakdown = breakdown;
    }
    return { breakdown, recorded, usage };
  }

  /** Whether an exact report from a watcher that replays history is in the ledger. */
  hasReplayingUsage(): boolean {
    return this.ledger.hasReplayingEntry();
  }

  /**
   * Fallback path: estimate tokens from character counts.
   * Uses the heuristic: tokens ≈ characters / 4. The estimate is provisional:
   * the next exact parent report from a replaying watcher retires it (see
   * usage-ledger.ts).
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
    const { breakdown, pricing } = this.price(usage, model);
    const nowMs = Date.now();
    const day = localDateKey(nowMs);
    this.ledger.insert({
      id: this.synthesizeId('est'),
      provisional: true,
      replaces: false,
      ts: nowMs,
      day,
      model,
      inputTokens,
      outputTokens,
      thinkingTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: breakdown.totalUsd,
      cacheSavingsUsd: breakdown.savingsFromCacheUsd,
      ...(pricing && { pricing }),
    });
    this.estimationCount++;
    this.noteActivity(day, nowMs, nowMs, breakdown.totalUsd);
    this.currentModel = model;
    this.latestCostBreakdown = breakdown;
    return breakdown;
  }

  /**
   * Marks a day as mutated and, for a usage that cost something, keeps the
   * day's first spend: the earliest event timestamp (not wall-clock arrival),
   * so cross-midnight burn-rate denominators stay correct. A day seeded with
   * spend but no saved first spend stays unanchored.
   */
  private noteActivity(day: string | null, ts: number, wallNowMs: number, usd: number): void {
    if (day === null) return;
    this.lastMutationMsByDay.set(day, wallNowMs);
    if (usd <= 0 || this.unanchoredDays.has(day)) return;
    const existingFirst = this.firstActivityMsByDay.get(day);
    if (existingFirst === undefined || ts < existingFirst) this.firstActivityMsByDay.set(day, ts);
  }

  /** Applies the seeded day's saved first spend, or leaves the day unanchored when there is none. */
  private seedDayAnchor(seed: CostTrackerSeed, daySpent: boolean, nowMs: number): void {
    if (!daySpent) return;
    this.lastMutationMsByDay.set(seed.dayKey, nowMs);
    if (seed.dayFirstActivityMs === undefined) {
      this.firstActivityMsByDay.delete(seed.dayKey);
      this.unanchoredDays.add(seed.dayKey);
      return;
    }
    // A seed without a saved first spend already left the day unanchored.
    if (this.unanchoredDays.has(seed.dayKey)) return;
    const existingFirst = this.firstActivityMsByDay.get(seed.dayKey);
    if (existingFirst === undefined || seed.dayFirstActivityMs < existingFirst) {
      this.firstActivityMsByDay.set(seed.dayKey, seed.dayFirstActivityMs);
    }
  }

  /**
   * Seeds a previous process's last checkpoint for this same session.
   *
   * Restart data-loss fix: `ParentTranscriptWatcher`'s transcript-read cursor
   * is durably persisted across process restarts so a resumed session never
   * re-reads old transcript lines — but this tracker's totals are in-memory
   * state. Without this seed, every dollar/token attributed to lines a
   * now-dead prior process already consumed is lost the moment a session
   * gets paused and resumed (sleep, closing a terminal, `claude --resume`,
   * a crash).
   *
   * A seed carrying a ledger is folded in as a union, so seeding it twice, or
   * seeding a checkpoint that holds calls this process already counted,
   * changes nothing. A seed without one (a hand-built seed) adds its totals.
   */
  seedFromPersisted(seed: CostTrackerSeed): void {
    const nowMs = Date.now();
    if (seed.ledger) {
      const { entries, base } = seed.ledger;
      if (entries.length === 0 && isZeroTotals(base)) return;
      const before = this.ledger.size;
      this.ledger.union(entries, base);
      if (this.ledger.size === before && isZeroTotals(base)) return;
      // Entries carry their own timestamps; only a pre-ledger base's spend
      // on the seeded day needs the saved first spend.
      for (const e of entries) this.noteActivity(e.day, e.ts, nowMs, e.costUsd);
      this.seedDayAnchor(seed, (base.costByDayUsd[seed.dayKey] ?? 0) > 0, nowMs);
    } else {
      const hasAnyTotal =
        seed.totalCostUsd !== 0 ||
        seed.totalInputTokens !== 0 ||
        seed.totalOutputTokens !== 0 ||
        seed.totalThinkingTokens !== 0 ||
        seed.totalCacheReadTokens !== 0 ||
        seed.totalCacheCreationTokens !== 0;
      if (!hasAnyTotal) return;
      this.seedFlatTotals(seed, nowMs);
    }
    if (seed.hadExactReport === false) this.estimationCount += 1;
    else this.reportCount += 1;
  }

  private seedFlatTotals(seed: CostTrackerSeed, nowMs: number): void {
    const est = seed.byteEstimates;
    const legacyDay = seed.legacyCallsDayKey ?? seed.dayKey;
    const base: CostTotals = {
      costUsd: Math.max(0, seed.totalCostUsd - (est?.costUsd ?? 0)),
      subagentCostUsd: seed.subagentCostUsd,
      inputTokens: Math.max(0, seed.totalInputTokens - (est?.inputTokens ?? 0)),
      outputTokens: Math.max(0, seed.totalOutputTokens - (est?.outputTokens ?? 0)),
      thinkingTokens: seed.totalThinkingTokens,
      cacheReadTokens: seed.totalCacheReadTokens,
      cacheCreationTokens: seed.totalCacheCreationTokens,
      cacheSavingsUsd: seed.totalCacheSavingsUsd,
      costByModel: subtractRecord(seed.costByModel, est?.costByModel ?? {}),
      costByDayUsd:
        seed.dayCostUsd !== 0
          ? {
              [seed.dayKey]: Math.max(0, seed.dayCostUsd - (est?.costByDayUsd[seed.dayKey] ?? 0)),
            }
          : {},
      subagentCostByDayUsd:
        seed.daySubagentCostUsd !== 0 ? { [seed.dayKey]: seed.daySubagentCostUsd } : {},
      costByWorkflowRunId: seed.costByWorkflowRunId,
      unpricedByModel: seed.unpricedByModel ?? {},
      estimatedByModel: seed.estimatedByModel ?? {},
      // A seed with no day split books its calls to its own latest day.
      unpricedByDay:
        seed.unpricedByDay ??
        (seed.unpricedByModel ? { [legacyDay]: { ...seed.unpricedByModel } } : {}),
      estimatedByDay:
        seed.estimatedByDay ??
        (seed.estimatedByModel ? { [legacyDay]: { ...seed.estimatedByModel } } : {}),
    };
    const estimates = est === undefined ? [] : legacyEstimateEntries(est, nowMs, this.instanceId);
    this.ledger.addToBase(withoutEstimateCalls(base, estimates));
    for (const e of estimates) this.ledger.insert(e);
    this.seedDayAnchor(seed, seed.dayCostUsd !== 0, nowMs);
  }

  private computeCacheHitRate(t: CostTotals): number | null {
    const denominator = t.inputTokens + t.cacheReadTokens + t.cacheCreationTokens;
    if (denominator === 0) return null;
    if (t.cacheReadTokens === 0 && t.cacheCreationTokens === 0) return null;
    return t.cacheReadTokens / denominator;
  }

  /** The ledger as written to a session file. */
  getUsageLedger(): PersistedUsageLedger | undefined {
    return this.ledger.isEmpty() ? undefined : this.ledger.toPersisted();
  }

  /**
   * Cost spent during a specific local-time day, attributed at the moment
   * each token event was recorded. Used to fix the cross-midnight inflation
   * of "Today Spend" — when a session that started yesterday continues into
   * today, this returns only today's portion.
   */
  getCostForDay(dayKey: string): number {
    return this.ledger.fold().totals.costByDayUsd[dayKey] ?? 0;
  }

  /**
   * Subagent-attributed cost during a specific local-time day. Today-scoped
   * counterpart to getSubagentMetrics().subagentUsd (which is session-
   * cumulative) so the "subagent spend" KPI lines up with the day-bucketed
   * "spend today" total.
   */
  getSubagentCostForDay(dayKey: string): number {
    return this.ledger.fold().totals.subagentCostByDayUsd[dayKey] ?? 0;
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
    const m = this.ledger.fold().totals.costByWorkflowRunId[runId];
    if (!m) return 0;
    let total = 0;
    for (const v of Object.values(m)) total += v;
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
    if (runId in this.ledger.getBase().costByWorkflowRunId) return true;
    for (const e of this.ledger.values()) if (e.workflowRunId === runId) return true;
    return false;
  }

  /** Iterable view of every (runId, dayKey, usd) tuple — for dashboard joins. */
  *iterCostByWorkflowRun(): IterableIterator<{ runId: string; dayKey: string; usd: number }> {
    for (const [runId, m] of Object.entries(this.ledger.fold().totals.costByWorkflowRunId)) {
      for (const [dayKey, usd] of Object.entries(m)) {
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
    const t = this.ledger.fold().totals;
    const subagentUsd = t.subagentCostUsd;
    const parentUsd = Math.max(0, t.costUsd - t.subagentCostUsd);
    const total = subagentUsd + parentUsd;
    return {
      subagentUsd,
      parentUsd,
      subagentSharePct: total > 0 ? (subagentUsd / total) * 100 : 0,
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
    const fold = this.ledger.fold();
    const t = fold.totals;

    const uniqueFilesWritten = this.sessionTracker
      ? this.sessionTracker.getMetrics().uniqueFilesWritten
      : 0;

    const costByWorkflowRunId: Record<string, Record<string, number>> = {};
    for (const [runId, days] of Object.entries(t.costByWorkflowRunId)) {
      costByWorkflowRunId[runId] = { ...days };
    }

    const totalTokensAllTypes =
      t.inputTokens + t.outputTokens + t.thinkingTokens + t.cacheReadTokens + t.cacheCreationTokens;

    return {
      sessionTotalCostUsd: hasData ? t.costUsd : null,
      costByModel: { ...t.costByModel },
      costPerLineOfCode:
        hasData && this.totalLinesChanged > 0 ? t.costUsd / this.totalLinesChanged : null,
      costPerFileModified:
        hasData && uniqueFilesWritten > 0 ? t.costUsd / uniqueFilesWritten : null,
      costPerMillionTokens:
        hasData && totalTokensAllTypes > 0 ? (t.costUsd / totalTokensAllTypes) * 1_000_000 : null,
      model: this.currentModel,
      totalInputTokens: t.inputTokens,
      totalOutputTokens: t.outputTokens,
      totalThinkingTokens: t.thinkingTokens,
      totalCacheReadTokens: t.cacheReadTokens,
      totalCacheCreationTokens: t.cacheCreationTokens,
      cacheHitRate: this.computeCacheHitRate(t),
      totalCacheSavingsUsd: t.cacheSavingsUsd,
      reportCount: this.reportCount,
      estimationCount: this.estimationCount,
      ...(fold.byteEstimates !== undefined && {
        byteEstimates: {
          ...fold.byteEstimates,
          costByModel: { ...fold.byteEstimates.costByModel },
          costByDayUsd: { ...fold.byteEstimates.costByDayUsd },
        },
      }),
      latestCostBreakdown: this.latestCostBreakdown,
      subagentCostUsd: t.subagentCostUsd,
      parentCostUsd: Math.max(0, t.costUsd - t.subagentCostUsd),
      costByWorkflowRunId,
      costByDayUsd: { ...t.costByDayUsd },
      firstActivityByDayMs: Object.fromEntries(this.firstActivityMsByDay),
      unpricedByModel: { ...t.unpricedByModel },
      estimatedByModel: { ...t.estimatedByModel },
      unpricedByDay: copyByDay(t.unpricedByDay),
      estimatedByDay: copyByDay(t.estimatedByDay),
      subagentCostByDayUsd: { ...t.subagentCostByDayUsd },
      subagentByAgentType: { ...fold.subagentByAgentType },
      highContextCostUsd: fold.highContextCostUsd,
      apiDurationMs: fold.apiDurationMs,
      costRateMultiplierApplied: this.rateMultiplier,
    };
  }

  emitMetrics(aggregator: MetricAggregator): void {
    const attrs: Record<string, string | number> = {};
    if (this.currentModel) {
      attrs.model = this.currentModel;
    }
    const m = this.getMetrics();
    const totalCostUsd = m.sessionTotalCostUsd ?? 0;

    // Deliberately not emitted as its own NR metric: cost-per-million-tokens
    // is a pure ratio of session_total_usd and the tokens_* counts already
    // emitted below, so NRQL can compute it at query time
    // (sum(cost)/sum(tokens)*1e6) with full facet/time-window flexibility —
    // a pre-baked gauge scoped to today's attrs would be strictly less
    // flexible and adds ingest volume for no analytical benefit. It's still
    // computed locally (see getMetrics().costPerMillionTokens) for the MCP
    // tool responses and local dashboard, which have no NRQL alternative.
    aggregator.record('ai.cost.session_total_usd', totalCostUsd, attrs);
    aggregator.record('ai.cost.tokens_input', m.totalInputTokens, attrs);
    aggregator.record('ai.cost.tokens_output', m.totalOutputTokens, attrs);
    aggregator.record('ai.cost.tokens_thinking', m.totalThinkingTokens, attrs);
    aggregator.record('ai.cost.tokens_cache_read', m.totalCacheReadTokens, attrs);
    aggregator.record('ai.cost.tokens_cache_creation', m.totalCacheCreationTokens, attrs);
    aggregator.record('ai.cost.cache_savings_usd', m.totalCacheSavingsUsd, attrs);

    if (this.totalLinesChanged > 0) {
      aggregator.record(
        'ai.cost.cost_per_line_of_code',
        totalCostUsd / this.totalLinesChanged,
        attrs,
      );
    }

    if (this.sessionTracker) {
      const uniqueFilesWritten = this.sessionTracker.getMetrics().uniqueFilesWritten;
      if (uniqueFilesWritten > 0) {
        aggregator.record(
          'ai.cost.cost_per_file_modified',
          totalCostUsd / uniqueFilesWritten,
          attrs,
        );
      }
    }

    aggregator.record('ai.cost.report_count', this.reportCount, attrs);
    aggregator.record('ai.cost.estimation_count', this.estimationCount, attrs);
    aggregator.record('ai.cost.subagent_usd', m.subagentCostUsd, attrs);
    aggregator.record('ai.cost.parent_usd', m.parentCostUsd, attrs);
    for (const [model, entry] of Object.entries(m.unpricedByModel)) {
      aggregator.record('ai.cost.unpriced_calls', entry.calls, { model });
    }
    for (const [model, entry] of Object.entries(m.estimatedByModel)) {
      aggregator.record('ai.cost.estimated_calls', entry.calls, {
        model,
        estimatedFrom: entry.estimatedFrom,
      });
    }
  }

  reset(_sessionId: string): void {
    this.ledger = new UsageLedger();
    this.currentModel = null;
    this.reportCount = 0;
    this.estimationCount = 0;
    this.latestCostBreakdown = null;
    this.firstActivityMsByDay = new Map();
    this.unanchoredDays = new Set();
    this.lastMutationMsByDay = new Map();
    this.totalLinesChanged = 0;
  }
}

function copyByDay<T>(
  byDay: Readonly<Record<string, Readonly<Record<string, T>>>>,
): Record<string, Record<string, T>> {
  return Object.fromEntries(Object.entries(byDay).map(([day, m]) => [day, { ...m }]));
}

/** Per-key `a - b`, clamped at zero. */
function subtractRecord(
  a: Readonly<Record<string, number>>,
  b: Readonly<Record<string, number>>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(a)) {
    const left = v - (b[k] ?? 0);
    if (left > 1e-12) out[k] = left;
  }
  return out;
}

/**
 * Provisional entries for a summary's byte-estimate ledger written before the
 * usage ledger existed: one per day, timestamped `ts`, so the next exact
 * report retires them. The ledger has no per-entry split of model and day, so
 * each day's entry carries the ledger's costliest model and a share of its
 * tokens in proportion to that day's cost. The unpriced and estimated-price
 * calls the estimates counted ride on the entry of their day (`calls`); calls
 * with no day split ride on the last entry.
 */
export function legacyEstimateEntries(
  est: ByteEstimateLedger,
  ts: number,
  scope = 'legacy',
): UsageEntry[] {
  const callsByDay = new Map<string, EntryCalls>();
  const addCalls = (day: string, key: 'unpriced' | 'estimated', perModel: object): void => {
    if (Object.keys(perModel).length === 0) return;
    callsByDay.set(day, { ...callsByDay.get(day), [key]: perModel });
  };
  for (const [day, perModel] of Object.entries(est.unpricedByDay ?? {})) {
    addCalls(day, 'unpriced', perModel);
  }
  for (const [day, perModel] of Object.entries(est.estimatedByDay ?? {})) {
    addCalls(day, 'estimated', perModel);
  }
  const hasCalls =
    Object.keys(est.unpricedByModel ?? {}).length > 0 ||
    Object.keys(est.estimatedByModel ?? {}).length > 0;
  if (est.costUsd <= 0 && est.inputTokens <= 0 && est.outputTokens <= 0 && !hasCalls) return [];
  const model = Object.entries(est.costByModel).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown';
  const costDays = new Map(Object.entries(est.costByDayUsd).filter(([, usd]) => usd > 0));
  const dayKeys = [...new Set([...costDays.keys(), ...callsByDay.keys()])].sort();
  if (dayKeys.length === 0) dayKeys.push(localDateKey(ts));
  const lastDay = dayKeys[dayKeys.length - 1]!;
  if (est.unpricedByDay === undefined && est.unpricedByModel) {
    addCalls(lastDay, 'unpriced', est.unpricedByModel);
  }
  if (est.estimatedByDay === undefined && est.estimatedByModel) {
    addCalls(lastDay, 'estimated', est.estimatedByModel);
  }
  const totalUsd = [...costDays.values()].reduce((sum, usd) => sum + usd, 0);
  let inputLeft = est.inputTokens;
  let outputLeft = est.outputTokens;
  return dayKeys.map((day) => {
    const last = day === lastDay;
    const usd = costDays.get(day) ?? (costDays.size === 0 && last ? est.costUsd : 0);
    const share = totalUsd > 0 ? usd / totalUsd : last ? 1 : 0;
    const inputTokens = last ? inputLeft : Math.round(est.inputTokens * share);
    const outputTokens = last ? outputLeft : Math.round(est.outputTokens * share);
    inputLeft -= inputTokens;
    outputLeft -= outputTokens;
    const calls = callsByDay.get(day);
    return {
      id: `legacy-est:${scope === 'legacy' ? '' : `${scope}:`}${day}`,
      provisional: true,
      replaces: false,
      ts,
      day,
      model,
      inputTokens: Math.max(0, inputTokens),
      outputTokens: Math.max(0, outputTokens),
      thinkingTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: usd,
      cacheSavingsUsd: 0,
      ...(calls && { calls }),
    };
  });
}

/**
 * `base` without the unpriced and estimated-price calls `estimates` stand for:
 * a pre-ledger total counted the estimates' calls, which now ride on the
 * provisional entries so they retire with them.
 */
export function withoutEstimateCalls(
  base: CostTotals,
  estimates: readonly UsageEntry[],
): CostTotals {
  if (!estimates.some((e) => e.calls)) return base;
  const calls = foldUsage(estimates).totals;
  const rest = subtractTotals(base, {
    ...ZERO_TOTALS,
    unpricedByModel: calls.unpricedByModel,
    estimatedByModel: calls.estimatedByModel,
    unpricedByDay: calls.unpricedByDay,
    estimatedByDay: calls.estimatedByDay,
  });
  return {
    ...base,
    unpricedByModel: rest.unpricedByModel,
    estimatedByModel: rest.estimatedByModel,
    unpricedByDay: rest.unpricedByDay,
    estimatedByDay: rest.estimatedByDay,
  };
}
