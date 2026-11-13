/**
 * Usage ledger — one session's model usage, keyed by the id of the API call
 * it came from. Every cost and token total a session reports is computed from
 * this map, so recording a call twice, seeding a restarted process twice, or
 * merging two writers' copies of a session can only count each call once: an
 * id already present adds nothing, and two copies merge as a union.
 *
 * Ids are the API's own response id wherever the source has one: the Anthropic
 * message id from a parent or subagent transcript, Copilot's `responseId`, the
 * Copilot SDK's `apiCallId`, or the `request_id` a self-report passes. Three
 * kinds are synthesized:
 *
 *   - `copilot-app:<session>#<epoch>:<from>-<to>`: the Copilot app only
 *     exposes cumulative counters, so a delta is named by the range of the
 *     four counters (input.output.cached.reasoning) it covers. A recorder
 *     counts only the part of a range past what the ledger already covers
 *     (see `claim`), and a union keeps one set of non-overlapping ranges.
 *   - `est:<process>:<n>`: a byte-size estimate. It is provisional: it stands in
 *     for the model turn that will read the tool payload, and is retired once
 *     the ledger holds an exact parent report from a replaying watcher at or
 *     after its timestamp. Retirement is decided when totals are computed, so
 *     whichever writer holds the exact report, the union retires the estimate.
 *   - `anon:<process>:<n>`: a usage recorded without any id. Unique, so it is
 *     never deduplicated, but survives restarts and merges as one entry.
 *
 * Session files written before the ledger existed carry only totals. Those
 * load as `base`, an aggregate that merges by per-field max (the old rule),
 * with their unreplaced byte estimates as provisional `legacy-est:<day>`
 * entries. See `usageLedgerOf` in session-store.ts.
 */

import type { TokenUsage } from '../shared/index.js';

import { localDateKey } from '../lib/date.js';
import { HIGH_CONTEXT_TOKENS } from '../storage/types.js';
import type { AttributionBucket } from '../storage/types.js';
import { addCallUsage } from './call-usage.js';

export interface UnpricedModelUsage {
  readonly calls: number;
  /** input + output + thinking + cache-read + cache-creation tokens of the unpriced calls */
  readonly tokens: number;
}

export interface EstimatedModelUsage extends UnpricedModelUsage {
  /** Table id whose price stood in for this model's missing one. */
  readonly estimatedFrom: string;
}

/** The byte-estimated share of a session's totals that no exact report has replaced yet. */
export interface ByteEstimateLedger {
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costByModel: Readonly<Record<string, number>>;
  readonly costByDayUsd: Readonly<Record<string, number>>;
  /**
   * The unpriced and estimated-price calls those estimates counted. Written by
   * the Preflight releases between per-day call counts and the usage ledger, so
   * a merge of two such files can take them out with the estimates. The ledger
   * derives them from its own entries instead.
   */
  readonly unpricedByModel?: Readonly<Record<string, UnpricedModelUsage>>;
  readonly estimatedByModel?: Readonly<Record<string, EstimatedModelUsage>>;
  readonly unpricedByDay?: Readonly<CallUsageByDay<UnpricedModelUsage>>;
  readonly estimatedByDay?: Readonly<CallUsageByDay<EstimatedModelUsage>>;
}

/** How a usage's model was priced: absent when it had a price of its own. */
export type PricingMark = { readonly kind: 'unpriced' } | { readonly estimatedFrom: string };

export interface UsageEntry {
  readonly id: string;
  /** A byte-size estimate (see the module comment). */
  readonly provisional: boolean;
  /**
   * An exact parent report from a watcher that replays history: it retires
   * provisional entries at or before its timestamp. Self-reports and subagent
   * turns do not.
   */
  readonly replaces: boolean;
  readonly ts: number;
  /** Local-day bucket; null for a late arrival kept out of the day buckets. */
  readonly day: string | null;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly thinkingTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  /** Priced when recorded, rate multiplier applied. */
  readonly costUsd: number;
  readonly cacheSavingsUsd: number;
  readonly agentId?: string;
  readonly agentType?: string;
  readonly workflowRunId?: string;
  readonly pricing?: PricingMark;
  /**
   * Unpriced and estimated-price calls this entry stands for, replacing the
   * one call `pricing` would count. Only an entry recovered from a pre-ledger
   * byte-estimate total carries it: that total covered several calls.
   */
  readonly calls?: EntryCalls;
  /** In memory only: not persisted. */
  readonly responseMs?: number;
}

export interface EntryCalls {
  readonly unpriced?: Readonly<Record<string, UnpricedModelUsage>>;
  readonly estimated?: Readonly<Record<string, EstimatedModelUsage>>;
}

/** Every additive cost figure of a session. */
export interface CostTotals {
  readonly costUsd: number;
  readonly subagentCostUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly thinkingTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly cacheSavingsUsd: number;
  readonly costByModel: Readonly<Record<string, number>>;
  readonly costByDayUsd: Readonly<Record<string, number>>;
  readonly subagentCostByDayUsd: Readonly<Record<string, number>>;
  readonly costByWorkflowRunId: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly unpricedByModel: Readonly<Record<string, UnpricedModelUsage>>;
  readonly estimatedByModel: Readonly<Record<string, EstimatedModelUsage>>;
  /**
   * `unpricedByModel` split by the local day each call was recorded in, like
   * `costByDayUsd`. A late arrival counts in `unpricedByModel` but in no day.
   */
  readonly unpricedByDay: Readonly<CallUsageByDay<UnpricedModelUsage>>;
  /** `estimatedByModel` split by local day; see `unpricedByDay`. */
  readonly estimatedByDay: Readonly<CallUsageByDay<EstimatedModelUsage>>;
}

/** Call usage per local-day key, then per model: `{ [dayKey]: { [model]: usage } }`. */
export type CallUsageByDay<T extends UnpricedModelUsage> = Record<string, Record<string, T>>;

export const ZERO_TOTALS: CostTotals = {
  costUsd: 0,
  subagentCostUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  thinkingTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  cacheSavingsUsd: 0,
  costByModel: {},
  costByDayUsd: {},
  subagentCostByDayUsd: {},
  costByWorkflowRunId: {},
  unpricedByModel: {},
  estimatedByModel: {},
  unpricedByDay: {},
  estimatedByDay: {},
};

/** The ledger's totals: `base` plus every exact entry and every live estimate. */
export interface UsageFold {
  readonly totals: CostTotals;
  /** Live estimates only. Present once any estimate was ever recorded. */
  readonly byteEstimates?: ByteEstimateLedger;
  readonly highContextCostUsd: number;
  readonly apiDurationMs: number | null;
  readonly subagentByAgentType: Readonly<Record<string, AttributionBucket>>;
  /** Exact entries, or a base with any usage in it. */
  readonly hasExact: boolean;
}

const EPSILON = 1e-9;
const SCALAR_KEYS = [
  'costUsd',
  'subagentCostUsd',
  'inputTokens',
  'outputTokens',
  'thinkingTokens',
  'cacheReadTokens',
  'cacheCreationTokens',
  'cacheSavingsUsd',
] as const;
const DAY_MAP_KEYS = ['costByModel', 'costByDayUsd', 'subagentCostByDayUsd'] as const;
const COPILOT_APP_RANGE =
  /^copilot-app:(.+):(\d+)\.(\d+)\.(\d+)\.(\d+)-(\d+)\.(\d+)\.(\d+)\.(\d+)$/;

function tokensOf(e: UsageEntry): number {
  return (
    e.inputTokens + e.outputTokens + e.thinkingTokens + e.cacheReadTokens + e.cacheCreationTokens
  );
}

/**
 * Which of two entries for one id to keep. Deterministic and order-free, so a
 * union is the same whichever side it starts from: the one with more tokens
 * (a transcript line re-read after its usage grew), then the exact one, then
 * the one that replaces estimates, and so on down to the one that knows more
 * of the call's attribution.
 */
function preferred(a: UsageEntry, b: UsageEntry): UsageEntry {
  const ta = tokensOf(a);
  const tb = tokensOf(b);
  if (ta !== tb) return ta > tb ? a : b;
  if (a.provisional !== b.provisional) return a.provisional ? b : a;
  if (a.replaces !== b.replaces) return a.replaces ? a : b;
  if (a.costUsd !== b.costUsd) return a.costUsd > b.costUsd ? a : b;
  // One writer recorded the call late and another did not: out of the day
  // buckets wins, whichever copy arrived first.
  if (a.day !== b.day) return a.day === null ? a : b.day === null ? b : a.day < b.day ? a : b;
  // One writer knew the call's workflow run or agent type and another did not.
  const ra = Number(a.workflowRunId !== undefined) + Number(a.agentType !== undefined);
  const rb = Number(b.workflowRunId !== undefined) + Number(b.agentType !== undefined);
  if (ra !== rb) return ra > rb ? a : b;
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  return ja <= jb ? a : b;
}

/** The unpriced and estimated-price calls an entry counts. */
function callsOf(e: UsageEntry, tokens: number): Required<EntryCalls> {
  if (e.calls) return { unpriced: e.calls.unpriced ?? {}, estimated: e.calls.estimated ?? {} };
  if (tokens === 0 || !e.pricing) return { unpriced: {}, estimated: {} };
  if ('kind' in e.pricing) return { unpriced: { [e.model]: { calls: 1, tokens } }, estimated: {} };
  return {
    unpriced: {},
    estimated: { [e.model]: { calls: 1, tokens, estimatedFrom: e.pricing.estimatedFrom } },
  };
}

/** The Copilot app's four cumulative token counters at one poll. */
export interface CopilotAppCounters {
  readonly input: number;
  readonly output: number;
  readonly cached: number;
  readonly reasoning: number;
}

const countersKey = (c: CopilotAppCounters): string =>
  `${c.input}.${c.output}.${c.cached}.${c.reasoning}`;

/** The usage id of the Copilot app's growth from `from` to `to` within one counter epoch. */
export function copilotAppRangeId(
  sessionId: string,
  epoch: number,
  from: CopilotAppCounters,
  to: CopilotAppCounters,
): string {
  return `copilot-app:${sessionId}#${epoch}:${countersKey(from)}-${countersKey(to)}`;
}

/**
 * The token usage the app's counters grew by. Its input counter is taken as
 * cache-inclusive (see copilot-app-usage-watcher.ts); reasoning tokens have no
 * TokenUsage field and are not counted.
 */
export function copilotAppRangeUsage(from: CopilotAppCounters, to: CopilotAppCounters): TokenUsage {
  const cached = Math.max(0, to.cached - from.cached);
  const inputTokens = Math.max(0, to.input - from.input - cached);
  const outputTokens = Math.max(0, to.output - from.output);
  return {
    inputTokens,
    outputTokens,
    thinkingTokens: 0,
    cacheReadTokens: cached,
    cacheCreationTokens: 0,
    totalTokens: inputTokens + outputTokens + cached,
  };
}

/** All the tokens a usage counts. */
export function tokenCount(u: TokenUsage): number {
  return (
    u.inputTokens + u.outputTokens + u.thinkingTokens + u.cacheReadTokens + u.cacheCreationTokens
  );
}

interface CounterRange {
  readonly id: string;
  readonly scope: string;
  /** Counter sums: the app's counters only grow within an epoch, so sums order the points. */
  readonly from: number;
  readonly to: number;
  readonly toCounters: CopilotAppCounters;
}

function rangeOf(id: string): CounterRange | null {
  const m = COPILOT_APP_RANGE.exec(id);
  if (!m) return null;
  const n = m.slice(2).map(Number);
  const counters = (i: number): CopilotAppCounters => ({
    input: n[i]!,
    output: n[i + 1]!,
    cached: n[i + 2]!,
    reasoning: n[i + 3]!,
  });
  const sum = (c: CopilotAppCounters): number => c.input + c.output + c.cached + c.reasoning;
  const toCounters = counters(4);
  return { id, scope: m[1]!, from: sum(counters(0)), to: sum(toCounters), toCounters };
}

/** Ranges ordered for a union: by start, the longest first, then by id. */
function compareRanges(a: CounterRange, b: CounterRange): number {
  return a.from - b.from || b.to - a.to || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function addTo(map: Map<string, number>, key: string, usd: number): void {
  map.set(key, (map.get(key) ?? 0) + usd);
}

function dayRecords<T>(days: Map<string, Map<string, T>>): Record<string, Record<string, T>> {
  return Object.fromEntries(
    [...days].map(([day, perModel]) => [day, Object.fromEntries(perModel)]),
  );
}

function recordOf(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries(map);
}

function mapRecord(
  a: Readonly<Record<string, number>>,
  b: Readonly<Record<string, number>>,
  op: (x: number, y: number) => number,
  keepZero: boolean,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const v = op(a[k] ?? 0, b[k] ?? 0);
    if (v > 1e-12 || (keepZero && v >= 0)) out[k] = v;
  }
  return out;
}

function mapCallUsage<T extends UnpricedModelUsage>(
  a: Readonly<Record<string, T>>,
  b: Readonly<Record<string, T>>,
  op: (x: number, y: number) => number,
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[k];
    const y = b[k];
    const calls = op(x?.calls ?? 0, y?.calls ?? 0);
    const tokens = op(x?.tokens ?? 0, y?.tokens ?? 0);
    if (calls > 0 || tokens > 0) out[k] = { ...(x ?? y)!, ...(y ?? {}), calls, tokens };
  }
  return out;
}

function mapCallUsageByDay<T extends UnpricedModelUsage>(
  a: Readonly<CallUsageByDay<T>>,
  b: Readonly<CallUsageByDay<T>>,
  op: (x: number, y: number) => number,
): CallUsageByDay<T> {
  const out: CallUsageByDay<T> = {};
  for (const day of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const perModel = mapCallUsage(a[day] ?? {}, b[day] ?? {}, op);
    if (Object.keys(perModel).length > 0) out[day] = perModel;
  }
  return out;
}

function combineTotals(
  a: CostTotals,
  b: CostTotals,
  op: (x: number, y: number) => number,
  keepZero = true,
) {
  const out: Record<string, unknown> = {};
  for (const k of SCALAR_KEYS) out[k] = op(a[k], b[k]);
  for (const k of DAY_MAP_KEYS) out[k] = mapRecord(a[k], b[k], op, keepZero);
  const runs: Record<string, Record<string, number>> = {};
  for (const run of new Set([
    ...Object.keys(a.costByWorkflowRunId),
    ...Object.keys(b.costByWorkflowRunId),
  ])) {
    const days = mapRecord(
      a.costByWorkflowRunId[run] ?? {},
      b.costByWorkflowRunId[run] ?? {},
      op,
      keepZero,
    );
    if (Object.keys(days).length > 0) runs[run] = days;
  }
  out.costByWorkflowRunId = runs;
  out.unpricedByModel = mapCallUsage(a.unpricedByModel, b.unpricedByModel, op);
  out.estimatedByModel = mapCallUsage(a.estimatedByModel, b.estimatedByModel, op);
  out.unpricedByDay = mapCallUsageByDay(a.unpricedByDay, b.unpricedByDay, op);
  out.estimatedByDay = mapCallUsageByDay(a.estimatedByDay, b.estimatedByDay, op);
  return out as unknown as CostTotals;
}

export const addTotals = (a: CostTotals, b: CostTotals): CostTotals =>
  combineTotals(a, b, (x, y) => x + y);
export const maxTotals = (a: CostTotals, b: CostTotals): CostTotals =>
  combineTotals(a, b, Math.max);
/** Per-field `a - b`, clamped at zero. */
export const subtractTotals = (a: CostTotals, b: CostTotals): CostTotals =>
  combineTotals(a, b, (x, y) => Math.max(0, x - y), false);

export function isZeroTotals(t: CostTotals): boolean {
  return (
    SCALAR_KEYS.every((k) => Math.abs(t[k]) <= EPSILON) &&
    DAY_MAP_KEYS.every((k) => Object.keys(t[k]).length === 0) &&
    Object.keys(t.costByWorkflowRunId).length === 0 &&
    Object.keys(t.unpricedByModel).length === 0 &&
    Object.keys(t.estimatedByModel).length === 0 &&
    Object.keys(t.unpricedByDay).length === 0 &&
    Object.keys(t.estimatedByDay).length === 0
  );
}

/**
 * Computes the totals of `entries` on top of `base`. An estimate is live
 * unless an entry that replaces estimates is at or after it.
 */
export function foldUsage(
  entries: Iterable<UsageEntry>,
  base: CostTotals = ZERO_TOTALS,
  opts?: { readonly exactOnly?: boolean },
): UsageFold {
  const list = [...entries];
  let retireUpTo = -Infinity;
  for (const e of list) if (e.replaces && !e.provisional && e.ts > retireUpTo) retireUpTo = e.ts;

  const scalars = {
    costUsd: 0,
    subagentCostUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cacheSavingsUsd: 0,
  };
  const costByModel = new Map<string, number>();
  const costByDayUsd = new Map<string, number>();
  const subagentCostByDayUsd = new Map<string, number>();
  const runs = new Map<string, Map<string, number>>();
  const unpricedByModel = new Map<string, UnpricedModelUsage>();
  const estimatedByModel = new Map<string, EstimatedModelUsage>();
  const unpricedByDay = new Map<string, Map<string, UnpricedModelUsage>>();
  const estimatedByDay = new Map<string, Map<string, EstimatedModelUsage>>();
  const dayBook = <T extends UnpricedModelUsage>(
    days: Map<string, Map<string, T>>,
    day: string,
  ): Map<string, T> => {
    let perModel = days.get(day);
    if (!perModel) {
      perModel = new Map();
      days.set(day, perModel);
    }
    return perModel;
  };
  const byAgentType = new Map<string, AttributionBucket>();
  const est = { costUsd: 0, inputTokens: 0, outputTokens: 0 };
  const estByModel = new Map<string, number>();
  const estByDay = new Map<string, number>();
  const estUnpriced = new Map<string, UnpricedModelUsage>();
  const estEstimated = new Map<string, EstimatedModelUsage>();
  const estUnpricedByDay = new Map<string, Map<string, UnpricedModelUsage>>();
  const estEstimatedByDay = new Map<string, Map<string, EstimatedModelUsage>>();
  let sawEstimate = false;
  let hasExact = !isZeroTotals(base);
  let highContextCostUsd = 0;
  let apiDurationMs: number | null = null;

  for (const e of list) {
    if (e.provisional) {
      sawEstimate = true;
      if (opts?.exactOnly || e.ts <= retireUpTo) continue;
      est.costUsd += e.costUsd;
      est.inputTokens += e.inputTokens;
      est.outputTokens += e.outputTokens;
      addTo(estByModel, e.model, e.costUsd);
      if (e.day !== null) addTo(estByDay, e.day, e.costUsd);
    } else {
      hasExact = true;
    }
    scalars.costUsd += e.costUsd;
    scalars.inputTokens += e.inputTokens;
    scalars.outputTokens += e.outputTokens;
    scalars.thinkingTokens += e.thinkingTokens;
    scalars.cacheReadTokens += e.cacheReadTokens;
    scalars.cacheCreationTokens += e.cacheCreationTokens;
    scalars.cacheSavingsUsd += e.cacheSavingsUsd;
    addTo(costByModel, e.model, e.costUsd);
    const subagent = e.agentId !== undefined;
    if (subagent) scalars.subagentCostUsd += e.costUsd;
    if (e.day !== null) {
      addTo(costByDayUsd, e.day, e.costUsd);
      if (subagent) addTo(subagentCostByDayUsd, e.day, e.costUsd);
      if (e.workflowRunId) {
        const days = runs.get(e.workflowRunId) ?? new Map<string, number>();
        addTo(days, e.day, e.costUsd);
        runs.set(e.workflowRunId, days);
      }
    }
    const tokens = tokensOf(e);
    const { unpriced, estimated } = callsOf(e, tokens);
    for (const [model, call] of Object.entries(unpriced)) {
      addCallUsage(unpricedByModel, model, call);
      if (e.day !== null) addCallUsage(dayBook(unpricedByDay, e.day), model, call);
      if (e.provisional) {
        addCallUsage(estUnpriced, model, call);
        if (e.day !== null) addCallUsage(dayBook(estUnpricedByDay, e.day), model, call);
      }
    }
    for (const [model, call] of Object.entries(estimated)) {
      addCallUsage(estimatedByModel, model, call);
      if (e.day !== null) addCallUsage(dayBook(estimatedByDay, e.day), model, call);
      if (e.provisional) {
        addCallUsage(estEstimated, model, call);
        if (e.day !== null) addCallUsage(dayBook(estEstimatedByDay, e.day), model, call);
      }
    }
    if (e.inputTokens + e.cacheReadTokens + e.cacheCreationTokens > HIGH_CONTEXT_TOKENS) {
      highContextCostUsd += e.costUsd;
    }
    if (e.responseMs !== undefined) apiDurationMs = (apiDurationMs ?? 0) + e.responseMs;
    if (subagent && e.agentType !== undefined) {
      const prior = byAgentType.get(e.agentType);
      byAgentType.set(e.agentType, {
        costUsd: (prior?.costUsd ?? 0) + e.costUsd,
        tokens: (prior?.tokens ?? 0) + tokens - e.thinkingTokens,
        count: (prior?.count ?? 0) + 1,
        durationMs: 0,
        breakdown: {
          inputTokens: (prior?.breakdown?.inputTokens ?? 0) + e.inputTokens,
          outputTokens: (prior?.breakdown?.outputTokens ?? 0) + e.outputTokens,
          cacheReadTokens: (prior?.breakdown?.cacheReadTokens ?? 0) + e.cacheReadTokens,
          cacheCreationTokens: (prior?.breakdown?.cacheCreationTokens ?? 0) + e.cacheCreationTokens,
        },
      });
    }
  }

  const costByWorkflowRunId: Record<string, Record<string, number>> = {};
  for (const [run, days] of runs) costByWorkflowRunId[run] = recordOf(days);
  const own: CostTotals = {
    ...scalars,
    costByModel: recordOf(costByModel),
    costByDayUsd: recordOf(costByDayUsd),
    subagentCostByDayUsd: recordOf(subagentCostByDayUsd),
    costByWorkflowRunId,
    unpricedByModel: Object.fromEntries(unpricedByModel),
    estimatedByModel: Object.fromEntries(estimatedByModel),
    unpricedByDay: dayRecords(unpricedByDay),
    estimatedByDay: dayRecords(estimatedByDay),
  };
  return {
    totals: isZeroTotals(base) ? own : addTotals(base, own),
    ...(sawEstimate && {
      byteEstimates: {
        ...est,
        costByModel: recordOf(estByModel),
        costByDayUsd: recordOf(estByDay),
        unpricedByModel: Object.fromEntries(estUnpriced),
        estimatedByModel: Object.fromEntries(estEstimated),
        unpricedByDay: dayRecords(estUnpricedByDay),
        estimatedByDay: dayRecords(estEstimatedByDay),
      },
    }),
    highContextCostUsd,
    apiDurationMs,
    subagentByAgentType: Object.fromEntries(byAgentType),
    hasExact,
  };
}

/**
 * Whether `entry` can be added to an existing fold without recomputing it: an
 * exact report that cannot retire a live estimate. Anything else (an estimate,
 * or a replaying report while estimates are live) recomputes from scratch.
 */
function appendsCleanly(fold: UsageFold, entry: UsageEntry): boolean {
  if (entry.provisional) return false;
  const est = fold.byteEstimates;
  const liveEstimates =
    est !== undefined && (est.costUsd > 0 || est.inputTokens > 0 || est.outputTokens > 0);
  return !(entry.replaces && liveEstimates);
}

function addToFold(fold: UsageFold, entry: UsageEntry): UsageFold {
  const one = foldUsage([entry]);
  const byAgentType: Record<string, AttributionBucket> = { ...fold.subagentByAgentType };
  for (const [type, b] of Object.entries(one.subagentByAgentType)) {
    const prior = byAgentType[type];
    byAgentType[type] = prior
      ? {
          costUsd: prior.costUsd + b.costUsd,
          tokens: prior.tokens + b.tokens,
          count: prior.count + b.count,
          durationMs: 0,
          breakdown: {
            inputTokens: (prior.breakdown?.inputTokens ?? 0) + (b.breakdown?.inputTokens ?? 0),
            outputTokens: (prior.breakdown?.outputTokens ?? 0) + (b.breakdown?.outputTokens ?? 0),
            cacheReadTokens:
              (prior.breakdown?.cacheReadTokens ?? 0) + (b.breakdown?.cacheReadTokens ?? 0),
            cacheCreationTokens:
              (prior.breakdown?.cacheCreationTokens ?? 0) + (b.breakdown?.cacheCreationTokens ?? 0),
          },
        }
      : b;
  }
  return {
    totals: addTotals(fold.totals, one.totals),
    ...(fold.byteEstimates !== undefined && { byteEstimates: fold.byteEstimates }),
    highContextCostUsd: fold.highContextCostUsd + one.highContextCostUsd,
    apiDurationMs:
      fold.apiDurationMs === null && one.apiDurationMs === null
        ? null
        : (fold.apiDurationMs ?? 0) + (one.apiDurationMs ?? 0),
    subagentByAgentType: byAgentType,
    hasExact: true,
  };
}

/** A session's usage entries plus the legacy aggregate they sit on. */
export class UsageLedger {
  private readonly entries = new Map<string, UsageEntry>();
  /** Copilot app ranges per counter scope, sorted and non-overlapping. */
  private readonly ranges = new Map<string, CounterRange[]>();
  private base: CostTotals = ZERO_TOTALS;
  private cache: UsageFold | null = null;

  /**
   * The part of a usage this ledger does not already hold. A Copilot app range
   * that reaches past the ranges it overlaps comes back as the uncovered tail
   * (a re-read after a crash or a lost cursor, once the app has grown), with
   * the tail's own id and tokens; one that does not is null. Any other usage
   * comes back unchanged: `insert` dedupes it by id.
   */
  claim(id: string, usage: TokenUsage): { readonly id: string; readonly usage: TokenUsage } | null {
    if (this.entries.has(id)) return { id, usage };
    const range = rangeOf(id);
    if (!range) return { id, usage };
    const held = this.overlapping(range);
    if (held.length === 0) return { id, usage };
    const last = held[held.length - 1]!;
    if (last.to >= range.to) return null;
    const tailId = `copilot-app:${range.scope}:${countersKey(last.toCounters)}-${countersKey(range.toCounters)}`;
    return { id: tailId, usage: copilotAppRangeUsage(last.toCounters, range.toCounters) };
  }

  /**
   * Adds `entry`. Returns false when its id was already present (the entry
   * kept is the `preferred` of the two) or it is a Copilot app range that
   * overlaps one already present, so the caller knows the call was counted.
   * Recorders pass a range through `claim` first.
   */
  insert(entry: UsageEntry): boolean {
    const existing = this.entries.get(entry.id);
    if (existing) {
      const keep = preferred(existing, entry);
      if (keep !== existing) {
        this.entries.set(entry.id, keep);
        this.cache = null;
      }
      return false;
    }
    const range = rangeOf(entry.id);
    if (range) {
      if (this.overlapping(range).length > 0) return false;
      this.addRange(range);
    }
    this.entries.set(entry.id, entry);
    this.cache =
      this.cache && appendsCleanly(this.cache, entry) ? addToFold(this.cache, entry) : null;
    return true;
  }

  /**
   * Union with another copy of this session's ledger. Idempotent, and the
   * same whichever copy goes first: where the two copies hold overlapping
   * Copilot app ranges (each counted the app's growth without the other's
   * lines), the scope keeps the ranges `compareRanges` picks from both.
   */
  union(entries: Iterable<UsageEntry>, base: CostTotals = ZERO_TOTALS): void {
    const incoming = new Map<string, UsageEntry[]>();
    for (const e of entries) {
      const range = this.entries.has(e.id) ? null : rangeOf(e.id);
      if (!range) this.insert(e);
      else if (this.overlapping(range).length === 0 && !incoming.has(range.scope)) {
        this.insert(e);
      } else {
        const list = incoming.get(range.scope) ?? [];
        list.push(e);
        incoming.set(range.scope, list);
      }
    }
    for (const [scope, list] of incoming) this.rebuildScope(scope, list);
    if (!isZeroTotals(base)) {
      this.base = maxTotals(this.base, base);
      this.cache = null;
    }
  }

  /** Re-picks one scope's ranges from the ones held and `extra`, by `compareRanges`. */
  private rebuildScope(scope: string, extra: readonly UsageEntry[]): void {
    const candidates = new Map<string, UsageEntry>();
    for (const r of this.ranges.get(scope) ?? []) candidates.set(r.id, this.entries.get(r.id)!);
    for (const e of extra) {
      const held = candidates.get(e.id);
      candidates.set(e.id, held ? preferred(held, e) : e);
    }
    const sorted = [...candidates.keys()].map((id) => rangeOf(id)!).sort(compareRanges);
    const kept: CounterRange[] = [];
    for (const r of sorted) {
      const last = kept[kept.length - 1];
      if (!last || r.from >= last.to) kept.push(r);
    }
    for (const r of this.ranges.get(scope) ?? []) this.entries.delete(r.id);
    kept.sort((a, b) => a.from - b.from);
    this.ranges.set(scope, kept);
    for (const r of kept) this.entries.set(r.id, candidates.get(r.id)!);
    this.cache = null;
  }

  /** The held ranges in `range`'s scope that overlap it, in order. */
  private overlapping(range: CounterRange): CounterRange[] {
    const list = this.ranges.get(range.scope);
    if (!list) return [];
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid]!.to <= range.from) lo = mid + 1;
      else hi = mid;
    }
    const out: CounterRange[] = [];
    for (let i = lo; i < list.length && list[i]!.from < range.to; i++) out.push(list[i]!);
    return out;
  }

  private addRange(range: CounterRange): void {
    const list = this.ranges.get(range.scope);
    if (!list) {
      this.ranges.set(range.scope, [range]);
      return;
    }
    let i = list.length;
    while (i > 0 && list[i - 1]!.from > range.from) i--;
    list.splice(i, 0, range);
  }

  /** Adds an aggregate that is not part of any other copy of the ledger. */
  addToBase(totals: CostTotals): void {
    if (isZeroTotals(totals)) return;
    this.base = addTotals(this.base, totals);
    this.cache = null;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Whether any exact report came from a watcher that replays history. */
  hasReplayingEntry(): boolean {
    for (const e of this.entries.values()) if (e.replaces && !e.provisional) return true;
    return false;
  }

  values(): IterableIterator<UsageEntry> {
    return this.entries.values();
  }

  getBase(): CostTotals {
    return this.base;
  }

  fold(): UsageFold {
    this.cache ??= foldUsage(this.entries.values(), this.base);
    return this.cache;
  }

  isEmpty(): boolean {
    return this.entries.size === 0 && isZeroTotals(this.base);
  }

  toPersisted(): PersistedUsageLedger {
    return encodeUsageLedger(this.entries.values(), this.base);
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * The ledger as written to a session file. Each entry is a compact JSON tuple
 * held as a string, so the file's pretty-printing gives one line per entry,
 * and a loader that only needs the totals never parses them. Tuple fields, in
 * order: id, flags (1 provisional, 2 replaces), ts, day, model index, input,
 * output, thinking, cache read, cache creation, USD, cache savings USD,
 * agentId, agentType, workflowRunId, pricing (`u`, or `e:<table id>`).
 * Trailing nulls are dropped.
 */
export interface PersistedUsageLedger {
  readonly v: 1;
  readonly models: readonly string[];
  readonly entries: readonly string[];
  readonly base?: CostTotals;
}

const MAX_ID = 256;
const MAX_ENTRIES = 200_000;

export function encodeUsageLedger(
  entries: Iterable<UsageEntry>,
  base: CostTotals = ZERO_TOTALS,
): PersistedUsageLedger {
  const models: string[] = [];
  const modelIndex = new Map<string, number>();
  const encoded: string[] = [];
  for (const e of entries) {
    let idx = modelIndex.get(e.model);
    if (idx === undefined) {
      idx = models.length;
      models.push(e.model);
      modelIndex.set(e.model, idx);
    }
    const pricing = !e.pricing ? null : 'kind' in e.pricing ? 'u' : `e:${e.pricing.estimatedFrom}`;
    const tuple: unknown[] = [
      e.id,
      (e.provisional ? 1 : 0) | (e.replaces ? 2 : 0),
      e.ts,
      e.day,
      idx,
      e.inputTokens,
      e.outputTokens,
      e.thinkingTokens,
      e.cacheReadTokens,
      e.cacheCreationTokens,
      e.costUsd,
      e.cacheSavingsUsd,
      e.agentId ?? null,
      e.agentType ?? null,
      e.workflowRunId ?? null,
      pricing,
      e.calls ?? null,
    ];
    while (tuple.length > 0 && tuple[tuple.length - 1] === null) tuple.pop();
    encoded.push(JSON.stringify(tuple));
  }
  return {
    v: 1,
    models,
    entries: encoded,
    ...(!isZeroTotals(base) && { base }),
  };
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isOptString = (v: unknown, max: number): v is string | null | undefined =>
  v === undefined || v === null || (typeof v === 'string' && v.length > 0 && v.length <= max);

function decodeEntry(raw: string, models: readonly string[]): UsageEntry | null {
  let t: unknown;
  try {
    t = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(t)) return null;
  const [
    id,
    flags,
    ts,
    day,
    modelIdx,
    i,
    o,
    th,
    cr,
    cc,
    usd,
    sav,
    agentId,
    agentType,
    run,
    pr,
    ec,
  ] = t as unknown[];
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID) return null;
  if (typeof flags !== 'number' || !Number.isInteger(flags) || flags < 0 || flags > 3) return null;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null;
  if (day !== null && (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day))) return null;
  if (typeof modelIdx !== 'number' || !Number.isInteger(modelIdx)) return null;
  const model = models[modelIdx];
  if (typeof model !== 'string') return null;
  if (![i, o, th, cr, cc, usd, sav].every(isCount)) return null;
  if (!isOptString(agentId, MAX_ID) || !isOptString(agentType, MAX_ID)) return null;
  if (!isOptString(run, MAX_ID) || !isOptString(pr, MAX_ID)) return null;
  let pricing: PricingMark | undefined;
  if (pr === 'u') pricing = { kind: 'unpriced' };
  else if (typeof pr === 'string' && pr.startsWith('e:') && pr.length > 2) {
    pricing = { estimatedFrom: pr.slice(2) };
  }
  const calls = parseEntryCalls(ec);
  return {
    id,
    provisional: (flags & 1) !== 0,
    replaces: (flags & 2) !== 0,
    ts,
    day,
    model,
    inputTokens: i as number,
    outputTokens: o as number,
    thinkingTokens: th as number,
    cacheReadTokens: cr as number,
    cacheCreationTokens: cc as number,
    costUsd: usd as number,
    cacheSavingsUsd: sav as number,
    ...(agentId ? { agentId } : {}),
    ...(agentType ? { agentType } : {}),
    ...(run ? { workflowRunId: run } : {}),
    ...(pricing && { pricing }),
    ...(calls && { calls }),
  };
}

function parseEntryCalls(v: unknown): EntryCalls | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const unpriced = Object.fromEntries(
    Object.entries(parseCallUsage(o.unpriced, false)).map(([k, e]) => [
      k,
      { calls: e.calls, tokens: e.tokens },
    ]),
  );
  const estimated = parseCallUsage(o.estimated, true);
  const has = (r: object): boolean => Object.keys(r).length > 0;
  if (!has(unpriced) && !has(estimated)) return undefined;
  return { ...(has(unpriced) && { unpriced }), ...(has(estimated) && { estimated }) };
}

export function decodeUsageLedger(ledger: PersistedUsageLedger): {
  readonly entries: UsageEntry[];
  readonly base: CostTotals;
} {
  const entries: UsageEntry[] = [];
  for (const raw of ledger.entries) {
    const e = decodeEntry(raw, ledger.models);
    if (e) entries.push(e);
  }
  return { entries, base: ledger.base ?? ZERO_TOTALS };
}

function parseNumberRecord(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return out;
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) if (isCount(n)) out[k] = n;
  return out;
}

function parseCallUsage(v: unknown, estimated: boolean): Record<string, EstimatedModelUsage> {
  const out: Record<string, EstimatedModelUsage> = {};
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return out;
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const e = raw as Record<string, unknown>;
    if (!isCount(e.calls) || !isCount(e.tokens)) continue;
    if (estimated && typeof e.estimatedFrom !== 'string') continue;
    out[k] = {
      calls: e.calls,
      tokens: e.tokens,
      estimatedFrom: estimated ? (e.estimatedFrom as string) : '',
    };
  }
  return out;
}

function parseCallUsageByDay(v: unknown, estimated: boolean): CallUsageByDay<EstimatedModelUsage> {
  const out: CallUsageByDay<EstimatedModelUsage> = {};
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return out;
  for (const [day, perModel] of Object.entries(v as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const parsed = parseCallUsage(perModel, estimated);
    if (Object.keys(parsed).length === 0) continue;
    out[day] = estimated
      ? parsed
      : (Object.fromEntries(
          Object.entries(parsed).map(([k, e]) => [k, { calls: e.calls, tokens: e.tokens }]),
        ) as CallUsageByDay<EstimatedModelUsage>[string]);
  }
  return out;
}

function parseCostTotals(v: unknown): CostTotals | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of SCALAR_KEYS) out[k] = isCount(o[k]) ? o[k] : 0;
  for (const k of DAY_MAP_KEYS) out[k] = parseNumberRecord(o[k]);
  const runs: Record<string, Record<string, number>> = {};
  if (typeof o.costByWorkflowRunId === 'object' && o.costByWorkflowRunId !== null) {
    for (const [run, days] of Object.entries(o.costByWorkflowRunId as Record<string, unknown>)) {
      runs[run] = parseNumberRecord(days);
    }
  }
  out.costByWorkflowRunId = runs;
  out.unpricedByModel = Object.fromEntries(
    Object.entries(parseCallUsage(o.unpricedByModel, false)).map(([k, e]) => [
      k,
      { calls: e.calls, tokens: e.tokens },
    ]),
  );
  out.estimatedByModel = parseCallUsage(o.estimatedByModel, true);
  out.unpricedByDay = parseCallUsageByDay(o.unpricedByDay, false);
  out.estimatedByDay = parseCallUsageByDay(o.estimatedByDay, true);
  return out as unknown as CostTotals;
}

/** Validates an untrusted persisted ledger. Entries are decoded lazily, by `decodeUsageLedger`. */
export function parsePersistedUsageLedger(v: unknown): PersistedUsageLedger | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (o.v !== 1 || !Array.isArray(o.models) || !Array.isArray(o.entries)) return undefined;
  if (!o.models.every((m) => typeof m === 'string' && m.length <= MAX_ID)) return undefined;
  const entries = o.entries
    .slice(0, MAX_ENTRIES)
    .filter((e): e is string => typeof e === 'string' && e.length <= 4096);
  const base = parseCostTotals(o.base);
  return {
    v: 1,
    models: o.models as string[],
    entries,
    ...(base && !isZeroTotals(base) && { base }),
  };
}

/**
 * A usage recorded more than this long after its own timestamp is a late
 * arrival: it counts in the session totals but in no day bucket, so a backlog
 * read days later cannot rewrite an old day's spend.
 */
export const LATE_ARRIVAL_MS = 48 * 60 * 60 * 1000;

/** The local-day key of `ts`, or null when it is a late arrival at `nowMs`. */
export function dayOf(ts: number, nowMs: number, lateAfterMs = LATE_ARRIVAL_MS): string | null {
  return nowMs - ts > lateAfterMs ? null : localDateKey(ts);
}
