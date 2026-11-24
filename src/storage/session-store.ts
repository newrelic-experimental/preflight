/**
 * Session Persistence — enriched session summaries with data from all trackers.
 *
 * `FullSessionSummary` extends the minimal `SessionSummary` type with fields
 * aggregated from SessionTracker, CostTracker, TaskDetector, AntiPatternDetector,
 * and EfficiencyScorer.
 *
 * `SessionStore` wraps filesystem operations for saving and loading session files
 * with a `YYYY-MM-DD_sessionId.json` naming convention.
 *
 * `buildSessionSummary()` pulls getMetrics() from each tracker and aggregates
 * task-level data into a single FullSessionSummary.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { createLogger } from '../core/index.js';
import { renameIntoPlace } from './rename-into-place.js';
import { redactIdentifier, redactSensitive } from '../config.js';
import { stripRepoNameCredentials } from '../lib/git-remote.js';
import { isSyntheticSessionId, type SessionNameSource } from '../hooks/session-resolver.js';
import { GENERIC_MCP_PLATFORM_NAME } from '../platforms/generic-mcp-adapter.js';
import type {
  SessionSummary,
  ReplayTimelineEntry,
  SessionAttribution,
  AttributionFacet,
  AttributionBucket,
  TokenBreakdown,
  UsdBreakdown,
} from './types.js';
import type { SessionTracker } from '../metrics/session-tracker.js';
import type {
  CostTracker,
  CostMetrics,
  ByteEstimateLedger,
  EstimatedModelUsage,
  UnpricedModelUsage,
} from '../metrics/cost-tracker.js';
import {
  addCallUsageRecords,
  combineCallUsageByDay,
  mergeCallUsageMax,
  parseCallUsageByDay,
  parseCallUsageRecord,
  subtractCallUsage,
  type CallUsage,
  type CallUsageByDay,
} from '../metrics/call-usage.js';
import type {
  TurnCostAttributor,
  CostAttributionMetrics,
} from '../metrics/turn-cost-attributor.js';
import type { TaskDetector } from '../metrics/task-detector.js';
import type { AntiPatternDetector } from '../metrics/anti-patterns.js';
import type { EfficiencyScorer, EfficiencyScoreComponents } from '../metrics/efficiency-score.js';
import type { TranscriptMessageTracker } from '../metrics/transcript-message-tracker.js';
import type { SessionOutcomeRecord } from '../metrics/instruction-drift-tracker.js';
import type { AntiPattern } from '../metrics/anti-patterns.js';
import { parsePrRepo } from '../metrics/pr-ref.js';
import {
  ToolSelectionScorer,
  toToolSelectionSummary,
  type ToolSelectionSummary,
} from '../metrics/tool-selection-scorer.js';
import type { ModelUsageTracker, ModelBreakdownEntry } from '../metrics/model-usage-tracker.js';
import type { QualityProxyTracker } from '../metrics/quality-proxy-tracker.js';
import {
  type QualityProxyRawCounts,
  ZERO_QUALITY_PROXY_COUNTS,
} from '../metrics/quality-proxy-tracker.js';

const logger = createLogger('session-store');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One detected anti-pattern occurrence, persisted per incident rather than
 * grouped by type — the target (`file`/`command`) and the detector's own
 * per-incident occurrence count (`iterations`/`readCount`/etc., matching
 * `AntiPattern`) both survive the round-trip to disk.
 */
export interface PersistedAntiPattern {
  readonly type: string;
  readonly file?: string;
  readonly command?: string;
  readonly iterations?: number;
  readonly readCount?: number;
  readonly repeatCount?: number;
  readonly editCount?: number;
  readonly agentCount?: number;
}

/**
 * Maps detector-reported anti-pattern incidents into the persisted/API shape,
 * redacting `file`/`command` targets the same way other persisted fields are.
 */
export function toPersistedAntiPatterns(patterns: readonly AntiPattern[]): PersistedAntiPattern[] {
  return patterns.map((p) => ({
    type: p.type,
    file: p.file !== undefined ? redactSensitive(p.file) : undefined,
    command: p.command !== undefined ? redactSensitive(p.command) : undefined,
    iterations: p.iterations,
    readCount: p.readCount,
    repeatCount: p.repeatCount,
    editCount: p.editCount,
    agentCount: p.agentCount,
  }));
}

export interface FullSessionSummary extends SessionSummary {
  readonly sessionName: string | null;
  /** Which source produced `sessionName` (see SessionNameSource), or null. */
  readonly sessionNameSource: SessionNameSource | null;
  /**
   * The session's originating intent (first user prompt), redacted, or null.
   * SENSITIVE content: only ever non-null when recordContent was enabled at
   * capture time (force-disabled under highSecurity). See SessionMetrics.
   */
  readonly sessionIntent: string | null;
  readonly repoName: string | null;
  readonly model: string | null;
  readonly toolBreakdown: Record<string, number>;
  /** Invocation count per skill name, both Skill tool calls and slash commands. */
  readonly skillBreakdown: Record<string, number>;
  readonly filesRead: string[];
  readonly filesModified: string[];
  readonly linesAdded: number;
  readonly linesRemoved: number;
  readonly bashCommandCount: number;
  readonly testRunCount: number;
  readonly testPassCount: number;
  readonly buildRunCount: number;
  readonly buildPassCount: number;
  readonly estimatedCostUsd: number | null;
  /**
   * Portion of estimatedCostUsd attributed to subagent (ctx.agentId) calls —
   * see CostMetrics.subagentCostUsd. 0 for an older session summary written
   * before subagent cost was tracked, and for sessions with no subagent
   * activity.
   */
  readonly subagentCostUsd: number;
  /**
   * Total cost bucketed by local-day key (`YYYY-MM-DD`), mirrored from
   * `CostMetrics.costByDayUsd`. The dashboard's "Spend Today" aggregate sums
   * `costByDayUsd[todayKey]` across sessions — the authoritative today-figure —
   * instead of pro-rating `estimatedCostUsd` (a lifetime cumulative total) by a
   * tool-call timeline, which over-attributes a resumed multi-day session's
   * whole cost to one day. Optional: absent on a session summary written
   * before this field existed, which falls back to the timeline pro-rate
   * path in the aggregate route.
   */
  readonly costByDayUsd?: Record<string, number>;
  readonly firstActivityByDayMs?: Record<string, number>;
  /** Subagent-attributed cost by local-day key; today-scoped counterpart to
   * `subagentCostUsd`. Optional for the same backward-compat reason as
   * `costByDayUsd`. */
  readonly subagentCostByDayUsd?: Record<string, number>;
  /**
   * Calls priced at $0 because the model had no price, per model id. Absent
   * when every call was priced and on summaries written before this field.
   */
  readonly unpricedByModel?: Record<string, UnpricedModelUsage>;
  /** Calls priced from a sibling model; their cost is in the totals as an estimate. */
  readonly estimatedByModel?: Record<string, EstimatedModelUsage>;
  /**
   * `unpricedByModel` split by local day, like `costByDayUsd`, so a today-scoped
   * reader counts only that day's calls. Absent on summaries written before this
   * field; readers then fall back to the whole-session counts.
   */
  readonly unpricedByDay?: CallUsageByDay<UnpricedModelUsage>;
  /** `estimatedByModel` split by local day; see `unpricedByDay`. */
  readonly estimatedByDay?: CallUsageByDay<EstimatedModelUsage>;
  /**
   * Byte-estimated share of the cost and token totals that a real token report
   * has not yet replaced (see `ByteEstimateLedger`). Written all-zero once the
   * report arrives so it overwrites an earlier non-zero copy on merge.
   */
  readonly byteEstimates?: ByteEstimateLedger;
  /**
   * The totals above without the ledger. `mergeSummaries` max-merges these and
   * adds the latest ledger back, so a shrinking ledger never competes with
   * another writer's larger exact total. Absent on summaries written before
   * this field, where it is derived as total minus ledger.
   */
  readonly exactTotals?: ExactTotals;
  readonly tokensInput: number;
  readonly tokensOutput: number;
  readonly tokensThinking: number;
  readonly tokensCacheRead: number;
  readonly tokensCacheCreation: number;
  readonly selfReportCount?: number;
  readonly cacheSavingsUsd: number;
  readonly efficiencyScore: number | null;
  /**
   * Number of individual task scores that fed `efficiencyScore` at save
   * time — captured from `EfficiencyScorer.getSessionSampleCount()`, which
   * includes any weight seeded from an earlier restart's checkpoint (not
   * just fresh-this-process scores). Lets a resumed session re-seed a
   * weighted average via `EfficiencyScorer.seedFromPersisted()` instead of
   * losing every pre-restart task's contribution to it. Optional (unlike
   * most fields on this interface) so the many existing test factories
   * building `FullSessionSummary` literals don't all need updating for an
   * additive field — read with `?? 0` at the point of use. 0/absent for an
   * older session summary written before this field existed, and for
   * sessions with no scored tasks.
   */
  readonly efficiencyScoreSampleCount?: number;
  /**
   * Component breakdown backing `efficiencyScore` at save time, captured
   * from `EfficiencyScorer.getSessionAverage()?.components`. Persisted
   * alongside `efficiencyScoreSampleCount` so a re-seeded average's
   * component breakdown is exact, not just its top-level score. Optional
   * for the same reason as `efficiencyScoreSampleCount` above. null/absent
   * for an older session summary written before this field existed, and
   * for sessions with no scored tasks.
   */
  readonly efficiencyScoreComponents?: EfficiencyScoreComponents | null;
  readonly antiPatterns: PersistedAntiPattern[];
  readonly taskCount: number;
  readonly taskSuccessRate: number | null;
  readonly toolSuccessRate: number | null;
  readonly contextCompressions: number;
  readonly agentSpawns: number;
  readonly userMessages: number;
  readonly assistantMessages: number;
  readonly userCorrections: number;
  readonly outcome: string;
  readonly observerCompletedAt?: number;
  readonly platform?: string;
  readonly instructionPromptHash?: string | null;
  readonly timeline?: ReplayTimelineEntry[];
  /**
   * Tool-selection quality summary for this session, computed once at save
   * time from the full in-memory ToolCallRecord[] — the only point where
   * outputSizeBytes (needed for unused-output detection) is still available;
   * it is never persisted anywhere else, including `timeline` above. null
   * for an older session summary written before this field existed, and
   * for sessions with no tool calls.
   */
  readonly toolSelectionMetrics: ToolSelectionSummary | null;
  /**
   * Raw per-model token/cost counters for this session, keyed by model name.
   * Captured once at save time from ModelUsageTracker.getRawBreakdown(). Raw
   * counters only, no derived ratios — see ModelUsageTracker.combineBreakdowns
   * for why ratios are always recomputed at read time instead of persisted.
   * `{}` for an older session summary written before this field existed,
   * and for sessions with no token events.
   */
  readonly modelBreakdown: Readonly<Record<string, ModelBreakdownEntry>>;
  /** Spend sliced by tool, skill, and subagent type, plus high-context spend and API wait time. Absent on legacy files. */
  readonly attribution?: SessionAttribution;
  /**
   * Per-workflow-run cost, split by local-day, keyed by workflow_run_id then
   * day key — the exact shape `CostMetrics.costByWorkflowRunId` already
   * produces. Captured once at save time so a resumed session's per-run
   * spend survives a process restart (see CostTracker.seedFromPersisted()).
   * `{}` for an older session summary written before this field existed,
   * and for sessions with no workflow runs.
   */
  readonly costByWorkflowRunId: Record<string, Record<string, number>>;
  /**
   * Raw quality-proxy signal counts for this session, captured once at save
   * time from QualityProxyTracker.getRawCounts(). Raw counts only, no derived
   * rates — see combineQualityProxyRawCounts for why rates are always
   * recomputed at read time instead of persisted. All-zero
   * (ZERO_QUALITY_PROXY_COUNTS) for an older session summary written before
   * this field existed, and for sessions with no quality signals. Nested
   * (not top-level) specifically to avoid
   * colliding with the unrelated top-level testPassCount/testRunCount fields
   * above (total task test runs, not quality-proxy test signals).
   */
  readonly qualityProxy: QualityProxyRawCounts;
}

/**
 * The subset of a session summary that decides whether it represents real,
 * attributable work. Deliberately structural and all-optional so the three
 * callers can pass what they have: a full `FullSessionSummary`, a live
 * `LocalSessionRollup`, or the narrowed row shape the today-aggregate route
 * reads off disk.
 */
export interface AttributableActivity {
  readonly toolCallCount?: number;
  readonly subagentCostUsd?: number;
  readonly timeline?: ReadonlyArray<unknown>;
}

export interface RecordedUsage extends AttributableActivity {
  readonly selfReportCount?: number;
  readonly estimatedCostUsd?: number | null;
  readonly tokensInput?: number;
  readonly tokensOutput?: number;
  readonly tokensThinking?: number;
}

/**
 * Does this summary represent work we can attribute to a real session?
 *
 * The narrower of the two definitions of "not empty" for session
 * persistence; `hasRecordedUsage` is the wider and gates the writes. This one
 * is for the `/api/sessions/today/aggregate` route, which uses it to decide
 * which persisted rows may contribute a pro-rated cost when they carry no
 * per-day buckets. Callers must never re-implement either definition.
 *
 * Subagent spend counts as activity on purpose. A session whose parent process
 * died while its subagent transcripts were still being tailed has an empty
 * PARENT timeline and zero parent tool calls (subagent tool calls never appear
 * there) yet real dollars. Keying only on `toolCallCount` discards exactly the
 * sessions a `--local` watcher exists to rescue.
 *
 * A genuinely empty summary — no tool calls, no subagent dollars, no timeline
 * — is still false, which is what keeps the empty-clobber guard intact.
 */
export function hasAttributableActivity(s: AttributableActivity): boolean {
  return (
    (s.toolCallCount ?? 0) > 0 ||
    (s.subagentCostUsd ?? 0) > 0 ||
    (Array.isArray(s.timeline) && s.timeline.length > 0)
  );
}

/**
 * Did this session record anything worth a file on disk? Wider than
 * `hasAttributableActivity`: a chat-only session has no tool calls but real
 * cost and tokens, and must still be kept. A session with none of these is an
 * idle MCP process (a window that was opened and never used). It gates the
 * aggregator's summaries, every write `SessionStore.saveSession()` accepts,
 * the existing file an empty write must not clobber, and the History list in
 * `/api/sessions`.
 */
export function hasRecordedUsage(s: RecordedUsage): boolean {
  return (
    hasAttributableActivity(s) ||
    (s.estimatedCostUsd ?? 0) > 0 ||
    (s.selfReportCount ?? 0) > 0 ||
    (s.tokensInput ?? 0) + (s.tokensOutput ?? 0) + (s.tokensThinking ?? 0) > 0
  );
}

export interface SessionFileInfo {
  readonly filename: string;
  readonly sessionId: string;
  readonly date: string;
}

export interface ListSessionsOptions {
  since?: Date;
  developer?: string;
}

export interface LoadSessionsOptions extends ListSessionsOptions {
  /**
   * Also load files whose filename date is older than `since` when the file
   * was modified at or after this time. A resumed session keeps its original
   * start-date filename but is rewritten on every checkpoint, so mtime is the
   * cheap way to find it without parsing every file on disk.
   */
  includeModifiedSince?: Date;
}

// ---------------------------------------------------------------------------
// SessionStore
// ---------------------------------------------------------------------------

/**
 * Combine two views of the same session so neither writer can lose the other's
 * data. Counters take the max rather than the sum: the two processes observe
 * overlapping (not disjoint) slices of one session, so summing would inflate
 * and taking the incoming value alone would regress.
 */
/**
 * Merge two `SessionAttribution` snapshots facet-by-facet, key-by-key,
 * taking a field-wise max on each bucket's four numbers — the same
 * no-single-writer-loses-data rule as `modelBreakdown` above. `undefined`
 * on either side is treated as an empty attribution rather than short-
 * circuiting, so a session that only recently gained a `turnCostAttributor`
 * still merges cleanly against an earlier write that had none.
 */
function mergeTokenBreakdown(
  a: TokenBreakdown | undefined,
  b: TokenBreakdown | undefined,
): TokenBreakdown | undefined {
  if (!a && !b) return undefined;
  const maxNum = (x: number | undefined, y: number | undefined): number => Math.max(x ?? 0, y ?? 0);
  return {
    inputTokens: maxNum(a?.inputTokens, b?.inputTokens),
    outputTokens: maxNum(a?.outputTokens, b?.outputTokens),
    cacheReadTokens: maxNum(a?.cacheReadTokens, b?.cacheReadTokens),
    cacheCreationTokens: maxNum(a?.cacheCreationTokens, b?.cacheCreationTokens),
  };
}

function mergeUsdBreakdown(
  a: UsdBreakdown | undefined,
  b: UsdBreakdown | undefined,
): UsdBreakdown | undefined {
  if (!a && !b) return undefined;
  const maxNum = (x: number | undefined, y: number | undefined): number => Math.max(x ?? 0, y ?? 0);
  return {
    inputUsd: maxNum(a?.inputUsd, b?.inputUsd),
    outputUsd: maxNum(a?.outputUsd, b?.outputUsd),
    cacheReadUsd: maxNum(a?.cacheReadUsd, b?.cacheReadUsd),
    cacheCreationUsd: maxNum(a?.cacheCreationUsd, b?.cacheCreationUsd),
  };
}

function mergeAttribution(
  existing: SessionAttribution | undefined,
  incoming: SessionAttribution | undefined,
): SessionAttribution | undefined {
  if (!existing && !incoming) return undefined;
  const maxNum = (a: number | undefined, b: number | undefined): number => Math.max(a ?? 0, b ?? 0);
  const maxNullable = (
    a: number | null | undefined,
    b: number | null | undefined,
  ): number | null => (a == null && b == null ? null : Math.max(a ?? 0, b ?? 0));

  const a = existing ?? { buckets: {}, highContextCostUsd: 0, apiDurationMs: null };
  const b = incoming ?? { buckets: {}, highContextCostUsd: 0, apiDurationMs: null };
  const facets = new Set<AttributionFacet>([
    ...(Object.keys(a.buckets) as AttributionFacet[]),
    ...(Object.keys(b.buckets) as AttributionFacet[]),
  ]);
  const buckets: Partial<Record<AttributionFacet, Record<string, AttributionBucket>>> = {};
  for (const facet of facets) {
    const facetA = a.buckets[facet] ?? {};
    const facetB = b.buckets[facet] ?? {};
    const keys = new Set([...Object.keys(facetA), ...Object.keys(facetB)]);
    const merged: Record<string, AttributionBucket> = {};
    for (const key of keys) {
      const ba = facetA[key];
      const bb = facetB[key];
      const breakdown = mergeTokenBreakdown(ba?.breakdown, bb?.breakdown);
      // The larger `costUsd` wins the merge, so a dollar split is only valid when
      // the side that supplied it also has one; otherwise it would understate the bucket.
      const usdSideMissingLarger =
        (!ba?.breakdownUsd && (ba?.costUsd ?? 0) > (bb?.costUsd ?? 0)) ||
        (!bb?.breakdownUsd && (bb?.costUsd ?? 0) > (ba?.costUsd ?? 0));
      const breakdownUsd = usdSideMissingLarger
        ? undefined
        : mergeUsdBreakdown(ba?.breakdownUsd, bb?.breakdownUsd);
      merged[key] = {
        costUsd: maxNum(ba?.costUsd, bb?.costUsd),
        tokens: maxNum(ba?.tokens, bb?.tokens),
        count: maxNum(ba?.count, bb?.count),
        durationMs: maxNum(ba?.durationMs, bb?.durationMs),
        ...(breakdown ? { breakdown } : {}),
        ...(breakdownUsd ? { breakdownUsd } : {}),
      };
    }
    if (Object.keys(merged).length > 0) buckets[facet] = merged;
  }

  return {
    buckets,
    highContextCostUsd: maxNum(a.highContextCostUsd, b.highContextCostUsd),
    apiDurationMs: maxNullable(a.apiDurationMs, b.apiDurationMs),
  };
}

// Mirrors the cap SessionTracker/LocalSessionAggregator apply when building a
// timeline pre-merge — a merged timeline should not grow past what either
// side could have produced on its own.
const MAX_TIMELINE_ENTRIES = 10_000;

const legacyTimelineKey = (e: ReplayTimelineEntry): string => `${e.timestamp}:${e.toolName}`;

/**
 * Union two timelines instead of picking whichever is longer. A Claude Code
 * `--stdio` resume starts the new process with an empty in-memory timeline;
 * under longest-wins, every checkpoint the new process writes loses the merge
 * race to the old process's on-disk timeline until it outgrows it, silently
 * dropping entries from whichever side was shorter.
 *
 * An entry is identified by its `toolUseId`, so parallel calls to one tool
 * that share a millisecond all survive. Entries saved before the id existed
 * have none and fall back to `(timestamp, toolName)`. A legacy entry whose
 * `(timestamp, toolName)` an id-bearing entry also carries is the same call
 * recorded before the upgrade, so it is dropped rather than doubled.
 */
function mergeTimeline(
  existing: readonly ReplayTimelineEntry[] | undefined,
  incoming: readonly ReplayTimelineEntry[] | undefined,
): ReplayTimelineEntry[] | undefined {
  if (existing === undefined && incoming === undefined) return undefined;
  const all = [...(existing ?? []), ...(incoming ?? [])];
  const legacyKeysWithId = new Set(all.filter((e) => e.toolUseId).map(legacyTimelineKey));
  const byKey = new Map<string, ReplayTimelineEntry>();
  for (const entry of all) {
    if (entry.toolUseId) byKey.set(`id:${entry.toolUseId}`, entry);
    else if (!legacyKeysWithId.has(legacyTimelineKey(entry))) {
      byKey.set(legacyTimelineKey(entry), entry);
    }
  }
  const merged = [...byKey.values()].sort((a, b) => a.timestamp - b.timestamp);
  return merged.length > MAX_TIMELINE_ENTRIES
    ? merged.slice(merged.length - MAX_TIMELINE_ENTRIES)
    : merged;
}

/** The tool name of each call a saved timeline holds with a toolUseId, keyed by that id. */
export function savedToolNameByUseId(
  summary: Pick<FullSessionSummary, 'timeline'> | null | undefined,
): Map<string, string> {
  const byId = new Map<string, string>();
  for (const entry of summary?.timeline ?? []) {
    if (entry.toolUseId) byId.set(entry.toolUseId, entry.toolName);
  }
  return byId;
}

/** Exact-only (non-byte-estimated) share of the cost and token totals. */
export interface ExactTotals {
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costByDayUsd: Readonly<Record<string, number>>;
}

export type ExactTotalsSource = Pick<
  FullSessionSummary,
  'exactTotals' | 'byteEstimates' | 'estimatedCostUsd' | 'costByDayUsd'
> &
  Partial<Pick<FullSessionSummary, 'tokensInput' | 'tokensOutput'>>;

/**
 * `exactTotals` as stored, or derived as total minus ledger for a summary that
 * predates the field. A merged total cannot be split afterwards (the file does
 * not record which writer's figure won the max), so writers persist the split.
 */
export function exactTotalsOf(s: ExactTotalsSource): ExactTotals {
  if (s.exactTotals) return s.exactTotals;
  const ledger = s.byteEstimates;
  return {
    costUsd: Math.max(0, (s.estimatedCostUsd ?? 0) - (ledger?.costUsd ?? 0)),
    inputTokens: Math.max(0, (s.tokensInput ?? 0) - (ledger?.inputTokens ?? 0)),
    outputTokens: Math.max(0, (s.tokensOutput ?? 0) - (ledger?.outputTokens ?? 0)),
    costByDayUsd: subtractRecord(s.costByDayUsd ?? {}, ledger?.costByDayUsd ?? {}),
  };
}

/** Per-key `a + b` over the union of keys. */
function addRecord(
  a: Readonly<Record<string, number>>,
  b: Readonly<Record<string, number>>,
): Record<string, number> {
  const out: Record<string, number> = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v;
  return out;
}

/**
 * A day's first spend is only known when every side that spent that day
 * recorded it. A side with spend but no saved first spend (a file written
 * before the field existed) makes the other side's anchor a later guess, so
 * that day stays unanchored and readers fall back to the first tool call.
 */
function mergeFirstActivity(
  a: FullSessionSummary,
  b: FullSessionSummary,
): Record<string, number> | undefined {
  if (a.firstActivityByDayMs === undefined && b.firstActivityByDayMs === undefined) {
    return undefined;
  }
  const out: Record<string, number> = {};
  const take = (own: FullSessionSummary, other: FullSessionSummary): void => {
    for (const [day, ms] of Object.entries(own.firstActivityByDayMs ?? {})) {
      const otherSpentUnanchored =
        other.firstActivityByDayMs?.[day] === undefined && (other.costByDayUsd?.[day] ?? 0) > 0;
      if (otherSpentUnanchored) continue;
      out[day] = Math.min(out[day] ?? ms, ms);
    }
  };
  take(a, b);
  take(b, a);
  return out;
}

/** Per-key `a - b`, clamped at zero. */
function subtractRecord(
  a: Readonly<Record<string, number>>,
  b: Readonly<Record<string, number>>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(a)) out[k] = Math.max(0, v - (b[k] ?? 0));
  return out;
}

type CallUsageSide<T extends CallUsage> = readonly [
  total: Readonly<Record<string, T>> | undefined,
  ledger: Readonly<Record<string, T>> | undefined,
];

/**
 * Merges one session's call counts the way `mergeSummaries` merges its cost: the
 * exact share (total minus the writer's ledger) is max-merged and the merged
 * ledger is added back. A max over the estimate-laden totals would keep the
 * calls of byte estimates a real report has since replaced.
 */
function mergeCallUsageWithLedger<T extends CallUsage>(
  existing: CallUsageSide<T>,
  incoming: CallUsageSide<T>,
  mergedLedger: Readonly<Record<string, T>> | undefined,
): Record<string, T> | undefined {
  if (existing[0] === undefined && incoming[0] === undefined) return undefined;
  const exact = mergeCallUsageMax(
    subtractCallUsage(existing[0], existing[1]),
    subtractCallUsage(incoming[0], incoming[1]),
  );
  const merged = addCallUsageRecords(exact, mergedLedger);
  return Object.keys(merged).length > 0 ? merged : undefined;
}

type CallUsageByDaySide<T extends CallUsage> = readonly [
  byModel: Readonly<Record<string, T>> | undefined,
  total: Readonly<CallUsageByDay<T>> | undefined,
  ledger: Readonly<CallUsageByDay<T>> | undefined,
];

/**
 * True when `side` was written before day buckets (counts but no day split) and
 * holds calls `other`'s totals lack. No day can be named for those calls, so the
 * merged file keeps only whole-session counts, as a legacy file does. A resumed
 * session was seeded from its legacy file, so its own totals already cover it.
 */
function legacySideAddsCalls<T extends CallUsage>(
  [byModel, byDay]: CallUsageByDaySide<T>,
  other: Readonly<Record<string, T>> | undefined,
): boolean {
  if (byModel === undefined || byDay !== undefined) return false;
  return Object.entries(byModel).some(
    ([model, usage]) => usage.calls > (other?.[model]?.calls ?? 0),
  );
}

function mergeCallUsageByDayWithLedger<T extends CallUsage>(
  existing: CallUsageByDaySide<T>,
  incoming: CallUsageByDaySide<T>,
  mergedLedger: Readonly<CallUsageByDay<T>> | undefined,
): CallUsageByDay<T> | undefined {
  if (existing[1] === undefined && incoming[1] === undefined) return undefined;
  if (legacySideAddsCalls(existing, incoming[0]) || legacySideAddsCalls(incoming, existing[0]))
    return undefined;
  const exact = combineCallUsageByDay(
    combineCallUsageByDay(existing[1], existing[2], subtractCallUsage),
    combineCallUsageByDay(incoming[1], incoming[2], subtractCallUsage),
    mergeCallUsageMax,
  );
  return combineCallUsageByDay(exact, mergedLedger, addCallUsageRecords);
}

export function mergeSummaries(
  existing: FullSessionSummary,
  incoming: FullSessionSummary,
): FullSessionSummary {
  const maxNum = (a: unknown, b: unknown): number =>
    Math.max(typeof a === 'number' ? a : 0, typeof b === 'number' ? b : 0);
  const mergeCounts = (
    a: Record<string, number> = {},
    b: Record<string, number> = {},
  ): Record<string, number> => {
    const out: Record<string, number> = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = Math.max(out[k] ?? 0, v);
    return out;
  };
  const union = (a: string[] = [], b: string[] = []): string[] => [...new Set([...a, ...b])];
  // efficiencyScore/efficiencyScoreSampleCount/efficiencyScoreComponents must
  // always come from the SAME side, atomically — EfficiencyScorer.
  // seedFromPersisted() treats sampleCount as a weight multiplier
  // (score * sampleCount), not just a display field, so merging the three
  // independently (e.g. taking the newer score but the max sampleCount) can
  // attach a thin/unrelated sample count to a completely different score,
  // radically over- or under-weighting it on the next re-seed. When only one
  // side has a real score, that side wins outright (this is what makes an
  // unseeded write never erase a real prior score). When both do, the side
  // with the larger sampleCount wins — the more statistically meaningful one.
  const mergeEfficiencyScoreTriple = (
    existing: FullSessionSummary,
    incoming: FullSessionSummary,
  ): Pick<
    FullSessionSummary,
    'efficiencyScore' | 'efficiencyScoreSampleCount' | 'efficiencyScoreComponents'
  > => {
    const existingHasScore = existing.efficiencyScore !== null;
    const incomingHasScore = incoming.efficiencyScore !== null;
    const winner =
      existingHasScore && incomingHasScore
        ? (incoming.efficiencyScoreSampleCount ?? 0) >= (existing.efficiencyScoreSampleCount ?? 0)
          ? incoming
          : existing
        : incomingHasScore
          ? incoming
          : existing;
    return {
      efficiencyScore: winner.efficiencyScore,
      efficiencyScoreSampleCount: winner.efficiencyScoreSampleCount ?? 0,
      efficiencyScoreComponents: winner.efficiencyScoreComponents ?? null,
    };
  };
  /**
   * Per-key max, preserving absence. `mergeCounts` already takes the per-key
   * max; the wrapper exists because `{}` and `undefined` are DIFFERENT values
   * to the today-aggregate route (an absent map falls back to the timeline
   * pro-rate; a present-but-empty one reads as an authoritative $0), so two
   * bucket-less legacy summaries must merge to `undefined`, not to `{}`.
   */
  const mergeDayMap = (
    a: Record<string, number> | undefined,
    b: Record<string, number> | undefined,
  ): Record<string, number> | undefined =>
    a === undefined && b === undefined ? undefined : mergeCounts(a, b);
  // The ledger is latest-wins and shrinks when a real report replaces it, so
  // only the exact-only totals are max-merged; the merged ledger is added back
  // on top. A max over the estimate-laden totals would keep the stale estimate.
  const mergedLedger = incoming.byteEstimates ?? existing.byteEstimates;
  const existingExact = exactTotalsOf(existing);
  const incomingExact = exactTotalsOf(incoming);
  const exactTotals: ExactTotals = {
    costUsd: Math.max(existingExact.costUsd, incomingExact.costUsd),
    inputTokens: Math.max(existingExact.inputTokens, incomingExact.inputTokens),
    outputTokens: Math.max(existingExact.outputTokens, incomingExact.outputTokens),
    costByDayUsd: mergeCounts(existingExact.costByDayUsd, incomingExact.costByDayUsd),
  };
  const estimatedCostUsd =
    existing.estimatedCostUsd === null && incoming.estimatedCostUsd === null
      ? null
      : exactTotals.costUsd + (mergedLedger?.costUsd ?? 0);
  const costByDayUsd =
    existing.costByDayUsd === undefined && incoming.costByDayUsd === undefined
      ? undefined
      : addRecord(exactTotals.costByDayUsd, mergedLedger?.costByDayUsd ?? {});
  const subagentCostByDayUsd = mergeDayMap(
    existing.subagentCostByDayUsd,
    incoming.subagentCostByDayUsd,
  );
  const firstActivityByDayMs = mergeFirstActivity(existing, incoming);

  const unpricedByModel = mergeCallUsageWithLedger(
    [existing.unpricedByModel, existing.byteEstimates?.unpricedByModel],
    [incoming.unpricedByModel, incoming.byteEstimates?.unpricedByModel],
    mergedLedger?.unpricedByModel,
  );
  const estimatedByModel = mergeCallUsageWithLedger(
    [existing.estimatedByModel, existing.byteEstimates?.estimatedByModel],
    [incoming.estimatedByModel, incoming.byteEstimates?.estimatedByModel],
    mergedLedger?.estimatedByModel,
  );
  const unpricedByDay = mergeCallUsageByDayWithLedger(
    [existing.unpricedByModel, existing.unpricedByDay, existing.byteEstimates?.unpricedByDay],
    [incoming.unpricedByModel, incoming.unpricedByDay, incoming.byteEstimates?.unpricedByDay],
    mergedLedger?.unpricedByDay,
  );
  const estimatedByDay = mergeCallUsageByDayWithLedger(
    [existing.estimatedByModel, existing.estimatedByDay, existing.byteEstimates?.estimatedByDay],
    [incoming.estimatedByModel, incoming.estimatedByDay, incoming.byteEstimates?.estimatedByDay],
    mergedLedger?.estimatedByDay,
  );
  // Latest writer wins, not max: the ledger shrinks to zero when a real report
  // replaces it, and a max-merge would resurrect the stale estimate.
  const byteEstimates = mergedLedger;

  const mergeCostByWorkflowRunId = (
    a: Record<string, Record<string, number>> = {},
    b: Record<string, Record<string, number>> = {},
  ): Record<string, Record<string, number>> => {
    const out: Record<string, Record<string, number>> = { ...a };
    for (const [runId, dayCosts] of Object.entries(b)) {
      out[runId] = mergeCounts(out[runId], dayCosts);
    }
    return out;
  };

  const modelBreakdown: Record<string, ModelBreakdownEntry> = { ...existing.modelBreakdown };
  for (const [model, entry] of Object.entries(incoming.modelBreakdown ?? {})) {
    const prev = modelBreakdown[model];
    modelBreakdown[model] = prev
      ? {
          requestCount: Math.max(prev.requestCount, entry.requestCount),
          totalInputTokens: Math.max(prev.totalInputTokens, entry.totalInputTokens),
          totalOutputTokens: Math.max(prev.totalOutputTokens, entry.totalOutputTokens),
          totalCostUsd: Math.max(prev.totalCostUsd, entry.totalCostUsd),
          totalCacheReadTokens: Math.max(prev.totalCacheReadTokens, entry.totalCacheReadTokens),
          totalCacheCreationTokens: Math.max(
            prev.totalCacheCreationTokens,
            entry.totalCacheCreationTokens,
          ),
          totalThinkingTokens: Math.max(prev.totalThinkingTokens, entry.totalThinkingTokens),
        }
      : entry;
  }

  const qa = existing.qualityProxy ?? ZERO_QUALITY_PROXY_COUNTS;
  const qb = incoming.qualityProxy ?? ZERO_QUALITY_PROXY_COUNTS;
  const qualityProxy: QualityProxyRawCounts = {
    totalSignals: maxNum(qa.totalSignals, qb.totalSignals),
    diffApplyCleanCount: maxNum(qa.diffApplyCleanCount, qb.diffApplyCleanCount),
    diffFailCount: maxNum(qa.diffFailCount, qb.diffFailCount),
    testPassCount: maxNum(qa.testPassCount, qb.testPassCount),
    testFailCount: maxNum(qa.testFailCount, qb.testFailCount),
    backtrackCount: maxNum(qa.backtrackCount, qb.backtrackCount),
    selfCorrectionCount: maxNum(qa.selfCorrectionCount, qb.selfCorrectionCount),
  };

  // Keep whichever tool-selection score saw more of the session; it is scored
  // from an ordered record list that cannot be meaningfully merged field-wise.
  const toolSelectionMetrics =
    (incoming.toolSelectionMetrics?.totalCalls ?? 0) >=
    (existing.toolSelectionMetrics?.totalCalls ?? 0)
      ? (incoming.toolSelectionMetrics ?? existing.toolSelectionMetrics)
      : existing.toolSelectionMetrics;

  const timeline = mergeTimeline(existing.timeline, incoming.timeline);
  // An owner's completed yields only to an in-progress checkpoint stamped
  // after it: the aggregator stamps last activity and an engine stamps its
  // own wall clock, so either can pass a completion only on a real resume.
  const outcomeSource =
    existing.outcome === 'completed' &&
    existing.observerCompletedAt === undefined &&
    !(incoming.outcome === 'in progress' && incoming.endTime > existing.endTime)
      ? existing
      : incoming;

  const startTime = Math.min(
    existing.startTime || incoming.startTime,
    incoming.startTime || existing.startTime,
  );
  const endTime = maxNum(existing.endTime, incoming.endTime);
  const selfReportCount = maxNum(existing.selfReportCount, incoming.selfReportCount);

  return {
    ...existing,
    ...incoming,
    startTime,
    endTime,
    durationMs: Math.max(0, endTime - startTime),
    toolCallCount: maxNum(existing.toolCallCount, incoming.toolCallCount),
    sessionName: incoming.sessionName ?? existing.sessionName,
    // Tie the source to whichever name won above so a name/source desync can't
    // arise (incoming spreads a null source alongside a null name). The
    // in-process tracker already enforces the no-downgrade invariant on
    // `incoming`, so taking incoming's name+source when present is safe.
    sessionNameSource: incoming.sessionName
      ? incoming.sessionNameSource
      : existing.sessionNameSource,
    // Never clobber a previously-captured intent with a later intent-less write
    // (e.g. a checkpoint saved before the name/intent was resolved, or a run
    // with recordContent off).
    sessionIntent: incoming.sessionIntent ?? existing.sessionIntent,
    repoName: incoming.repoName ?? existing.repoName,
    model: incoming.model ?? existing.model,
    // A later generic-labeled checkpoint (e.g. an aggregator restarted
    // without env signals) must not clobber a real platform label.
    platform:
      incoming.platform && incoming.platform !== GENERIC_MCP_PLATFORM_NAME
        ? incoming.platform
        : (existing.platform ?? incoming.platform),
    instructionPromptHash: incoming.instructionPromptHash ?? existing.instructionPromptHash,
    toolBreakdown: mergeCounts(existing.toolBreakdown, incoming.toolBreakdown),
    skillBreakdown: mergeCounts(existing.skillBreakdown, incoming.skillBreakdown),
    filesRead: union(existing.filesRead, incoming.filesRead),
    filesModified: union(existing.filesModified, incoming.filesModified),
    linesAdded: maxNum(existing.linesAdded, incoming.linesAdded),
    linesRemoved: maxNum(existing.linesRemoved, incoming.linesRemoved),
    bashCommandCount: maxNum(existing.bashCommandCount, incoming.bashCommandCount),
    testRunCount: maxNum(existing.testRunCount, incoming.testRunCount),
    testPassCount: maxNum(existing.testPassCount, incoming.testPassCount),
    buildRunCount: maxNum(existing.buildRunCount, incoming.buildRunCount),
    buildPassCount: maxNum(existing.buildPassCount, incoming.buildPassCount),
    estimatedCostUsd,
    subagentCostUsd: maxNum(existing.subagentCostUsd, incoming.subagentCostUsd),
    ...(costByDayUsd !== undefined ? { costByDayUsd } : {}),
    ...(subagentCostByDayUsd !== undefined ? { subagentCostByDayUsd } : {}),
    ...(firstActivityByDayMs !== undefined ? { firstActivityByDayMs } : {}),
    unpricedByModel,
    estimatedByModel,
    unpricedByDay,
    estimatedByDay,
    ...(byteEstimates !== undefined ? { byteEstimates } : {}),
    exactTotals,
    tokensInput: exactTotals.inputTokens + (mergedLedger?.inputTokens ?? 0),
    tokensOutput: exactTotals.outputTokens + (mergedLedger?.outputTokens ?? 0),
    tokensThinking: maxNum(existing.tokensThinking, incoming.tokensThinking),
    ...(selfReportCount > 0 && { selfReportCount }),
    tokensCacheRead: maxNum(existing.tokensCacheRead, incoming.tokensCacheRead),
    tokensCacheCreation: maxNum(existing.tokensCacheCreation, incoming.tokensCacheCreation),
    cacheSavingsUsd: maxNum(existing.cacheSavingsUsd, incoming.cacheSavingsUsd),
    ...mergeEfficiencyScoreTriple(existing, incoming),
    costByWorkflowRunId: mergeCostByWorkflowRunId(
      existing.costByWorkflowRunId,
      incoming.costByWorkflowRunId,
    ),
    taskCount: maxNum(existing.taskCount, incoming.taskCount),
    taskSuccessRate: incoming.taskSuccessRate ?? existing.taskSuccessRate,
    toolSuccessRate: incoming.toolSuccessRate ?? existing.toolSuccessRate,
    contextCompressions: maxNum(existing.contextCompressions, incoming.contextCompressions),
    agentSpawns: maxNum(existing.agentSpawns, incoming.agentSpawns),
    userMessages: maxNum(existing.userMessages, incoming.userMessages),
    assistantMessages: maxNum(existing.assistantMessages, incoming.assistantMessages),
    userCorrections: maxNum(existing.userCorrections, incoming.userCorrections),
    antiPatterns:
      (incoming.antiPatterns?.length ?? 0) >= (existing.antiPatterns?.length ?? 0)
        ? incoming.antiPatterns
        : existing.antiPatterns,
    outcome: outcomeSource.outcome,
    observerCompletedAt: outcomeSource.observerCompletedAt,
    ...(timeline ? { timeline } : {}),
    toolSelectionMetrics,
    modelBreakdown,
    qualityProxy,
    attribution: mergeAttribution(existing.attribution, incoming.attribution),
  };
}

/** Whether two files' timelines hold one call, by the identity `mergeTimeline` dedupes on. */
function sharesTimelineEntry(x: FullSessionSummary, y: FullSessionSummary): boolean {
  const [a, b] = [x.timeline ?? [], y.timeline ?? []];
  const ids = new Set(a.flatMap((e) => (e.toolUseId ? [e.toolUseId] : [])));
  const keys = new Set(a.map(legacyTimelineKey));
  const keysWithoutId = new Set(a.filter((e) => !e.toolUseId).map(legacyTimelineKey));
  return b.some((e) =>
    e.toolUseId
      ? ids.has(e.toolUseId) || keysWithoutId.has(legacyTimelineKey(e))
      : keys.has(legacyTimelineKey(e)),
  );
}

/**
 * A file with more calls than its capped timeline shows has dropped some.
 * Trackers keep the newest entries, and files from older builds kept the first,
 * so the dropped ones lie before or after the kept ones. `other` may be among them if
 * it fits in that gap, on one side of the kept entries, inside `capped`'s span.
 */
function mayHoldDroppedEntries(capped: FullSessionSummary, other: FullSessionSummary): boolean {
  const kept = capped.timeline ?? [];
  const seen = other.timeline ?? [];
  if (kept.length < MAX_TIMELINE_ENTRIES || seen.length > capped.toolCallCount - kept.length) {
    return false;
  }
  return (
    (capped.startTime <= other.startTime && seen[seen.length - 1].timestamp < kept[0].timestamp) ||
    (other.endTime <= capped.endTime && seen[0].timestamp > kept[kept.length - 1].timestamp)
  );
}

/**
 * Files connected by shared activity, directly or through another file. Split files hold separate
 * activity and share no timeline entry; copies of one stretch share entries.
 */
function groupBySharedActivity(files: readonly FullSessionSummary[]): FullSessionSummary[][] {
  const ungrouped = new Set(files);
  const groups: FullSessionSummary[][] = [];
  for (const seed of files) {
    if (!ungrouped.delete(seed)) continue;
    const group = [seed];
    for (const member of group) {
      for (const other of ungrouped) {
        if (
          sharesTimelineEntry(member, other) ||
          mayHoldDroppedEntries(member, other) ||
          mayHoldDroppedEntries(other, member)
        ) {
          ungrouped.delete(other);
          group.push(other);
        }
      }
    }
    groups.push(group);
  }
  return groups;
}

/**
 * Oldest writer first. Contents break a tie on end time so a combine cannot
 * depend on the order files were listed.
 */
export function byWriteOrder(x: FullSessionSummary, y: FullSessionSummary): number {
  return x.endTime - y.endTime || JSON.stringify(x).localeCompare(JSON.stringify(y));
}

/**
 * Of two copies of one stretch, the one further along last. Calls and exact cost
 * only grow, so they hold even when an older build saved a superseded copy again.
 */
function byProgress(x: FullSessionSummary, y: FullSessionSummary): number {
  return (
    x.toolCallCount - y.toolCallCount ||
    exactTotalsOf(x).costUsd - exactTotalsOf(y).costUsd ||
    byWriteOrder(x, y)
  );
}

/**
 * Combine every file for one session id, of which there must be at least one. Copies of one stretch
 * share activity and max-merge, the copy further along last. Groups hold separate activity and add.
 * A file without a timeline has repeated another file's spend on real installs, so it max-merges
 * under the sum. No current writer drops a timeline it saves onto, so the sum is the latest state
 * and its ledger is kept.
 */
export function combineSessionFiles(files: readonly FullSessionSummary[]): FullSessionSummary {
  const separate = groupBySharedActivity(files.filter((f) => f.timeline?.length))
    .map((group) => group.sort(byProgress).reduce((acc, next) => mergeSummaries(acc, next)))
    .sort(byWriteOrder);
  const withoutTimeline = files.filter((f) => !f.timeline?.length).sort(byWriteOrder);
  const added = separate.length > 0 ? [separate.reduce((a, b) => addSummaries(a, b))] : [];
  return [...withoutTimeline, ...added].reduce((acc, next) => mergeSummaries(acc, next));
}

type SummaryField = keyof {
  [K in keyof FullSessionSummary as string extends K ? never : number extends K ? never : K]: 0;
};

/**
 * What a sum of separate activity takes from `mergeSummaries`: identity, the
 * time span and timeline, labels picked from one side, unions, the outcome, and
 * transcript message counts, since every process reads the transcript from its
 * first byte and so each file already counts the earlier files' messages.
 */
type Span = 'sessionId' | 'developer' | 'startTime' | 'endTime' | 'durationMs' | 'timeline';
type Labels = 'sessionName' | 'sessionNameSource' | 'sessionIntent' | 'repoName' | 'model';
type Picks = 'platform' | 'instructionPromptHash' | 'toolSelectionMetrics';
type Unions = 'filesRead' | 'filesModified' | 'firstActivityByDayMs';
type Outcome = 'outcome' | 'observerCompletedAt';
type TranscriptCounts = 'userMessages' | 'assistantMessages' | 'userCorrections';
type FromMerge = Span | Labels | Picks | Unions | Outcome | TranscriptCounts;

/** Every other field. A field added to the summary must be given a sum here. */
type AddedFields = { readonly [K in Exclude<SummaryField, FromMerge>]-?: FullSessionSummary[K] };

/** Sums two files holding separate activity, `b` the newer writer. */
export function addSummaries(a: FullSessionSummary, b: FullSessionSummary): FullSessionSummary {
  const merged = mergeSummaries(a, b);
  const ledger = addOptional(a.byteEstimates, b.byteEstimates, addLedgers);
  const [exactA, exactB] = [exactTotalsOf(a), exactTotalsOf(b)];
  const exactTotals: ExactTotals = {
    costUsd: exactA.costUsd + exactB.costUsd,
    inputTokens: exactA.inputTokens + exactB.inputTokens,
    outputTokens: exactA.outputTokens + exactB.outputTokens,
    costByDayUsd: addRecord(exactA.costByDayUsd, exactB.costByDayUsd),
  };
  const scores = addEfficiencyScores(a, b) ?? merged;
  const added: AddedFields = {
    toolCallCount: a.toolCallCount + b.toolCallCount,
    toolBreakdown: addRecord(a.toolBreakdown, b.toolBreakdown),
    skillBreakdown: addRecord(a.skillBreakdown, b.skillBreakdown),
    linesAdded: a.linesAdded + b.linesAdded,
    linesRemoved: a.linesRemoved + b.linesRemoved,
    bashCommandCount: a.bashCommandCount + b.bashCommandCount,
    testRunCount: a.testRunCount + b.testRunCount,
    testPassCount: a.testPassCount + b.testPassCount,
    buildRunCount: a.buildRunCount + b.buildRunCount,
    buildPassCount: a.buildPassCount + b.buildPassCount,
    estimatedCostUsd:
      a.estimatedCostUsd === null && b.estimatedCostUsd === null
        ? null
        : exactTotals.costUsd + (ledger?.costUsd ?? 0),
    subagentCostUsd: a.subagentCostUsd + b.subagentCostUsd,
    costByDayUsd:
      a.costByDayUsd === undefined && b.costByDayUsd === undefined
        ? undefined
        : addRecord(exactTotals.costByDayUsd, ledger?.costByDayUsd ?? {}),
    subagentCostByDayUsd: addOptional(a.subagentCostByDayUsd, b.subagentCostByDayUsd, addRecord),
    ...addCallUsageParts(a, b),
    byteEstimates: ledger,
    exactTotals,
    tokensInput: exactTotals.inputTokens + (ledger?.inputTokens ?? 0),
    tokensOutput: exactTotals.outputTokens + (ledger?.outputTokens ?? 0),
    tokensThinking: a.tokensThinking + b.tokensThinking,
    tokensCacheRead: a.tokensCacheRead + b.tokensCacheRead,
    tokensCacheCreation: a.tokensCacheCreation + b.tokensCacheCreation,
    selfReportCount: addOptional(a.selfReportCount, b.selfReportCount, (x, y) => x + y),
    cacheSavingsUsd: a.cacheSavingsUsd + b.cacheSavingsUsd,
    efficiencyScore: scores.efficiencyScore,
    efficiencyScoreSampleCount: scores.efficiencyScoreSampleCount,
    efficiencyScoreComponents: scores.efficiencyScoreComponents,
    antiPatterns: [...a.antiPatterns, ...b.antiPatterns],
    taskCount: a.taskCount + b.taskCount,
    taskSuccessRate: addedTaskSuccessRate(a, b),
    toolSuccessRate: weightedRate(
      a.toolSuccessRate,
      a.toolCallCount,
      b.toolSuccessRate,
      b.toolCallCount,
    ),
    contextCompressions: a.contextCompressions + b.contextCompressions,
    agentSpawns: a.agentSpawns + b.agentSpawns,
    costByWorkflowRunId: addEach(a.costByWorkflowRunId, b.costByWorkflowRunId, addRecord),
    modelBreakdown: addEach(a.modelBreakdown, b.modelBreakdown, addFields),
    qualityProxy: addFields(a.qualityProxy, b.qualityProxy),
    attribution: addOptional(a.attribution, b.attribution, addAttribution),
  };
  return { ...merged, ...added };
}

function addOptional<T>(a: T | undefined, b: T | undefined, add: (x: T, y: T) => T): T | undefined {
  return a !== undefined && b !== undefined ? add(a, b) : (a ?? b);
}

/** Per-key sum of two objects whose values are all numbers. */
function addFields<T extends { readonly [K in keyof T]: number }>(a: T, b: T): T {
  const out = { ...a } as Record<string, number>;
  for (const [key, value] of Object.entries(b) as [string, number][]) {
    out[key] = (out[key] ?? 0) + value;
  }
  return out as T;
}

/** Per-key `add` over the union of keys; a key on one side only is kept as it is. */
function addEach<T>(
  a: Readonly<Record<string, T>>,
  b: Readonly<Record<string, T>>,
  add: (x: T, y: T) => T,
): Record<string, T> {
  const out: Record<string, T> = { ...a };
  for (const [key, value] of Object.entries(b)) {
    out[key] = key in out ? add(out[key], value) : value;
  }
  return out;
}

type CallUsageField = 'unpricedByModel' | 'estimatedByModel' | 'unpricedByDay' | 'estimatedByDay';
type CallUsageParts = Pick<ByteEstimateLedger, CallUsageField>;
type AddedCallUsage = { readonly [K in CallUsageField]-?: CallUsageParts[K] };

/** The call counts a summary or a ledger holds, per model and per day. */
function addCallUsageParts(a: CallUsageParts, b: CallUsageParts): AddedCallUsage {
  return {
    unpricedByModel: addOptional(a.unpricedByModel, b.unpricedByModel, addCallUsageRecords),
    estimatedByModel: addOptional(a.estimatedByModel, b.estimatedByModel, addCallUsageRecords),
    unpricedByDay: addCallUsageByDay(
      [a.unpricedByModel, a.unpricedByDay, undefined],
      [b.unpricedByModel, b.unpricedByDay, undefined],
    ),
    estimatedByDay: addCallUsageByDay(
      [a.estimatedByModel, a.estimatedByDay, undefined],
      [b.estimatedByModel, b.estimatedByDay, undefined],
    ),
  };
}

/** Day buckets add, unless a file counted calls without them, which no day can be named for. */
function addCallUsageByDay<T extends CallUsage>(
  a: CallUsageByDaySide<T>,
  b: CallUsageByDaySide<T>,
): CallUsageByDay<T> | undefined {
  if (a[1] === undefined && b[1] === undefined) return undefined;
  if (legacySideAddsCalls(a, undefined) || legacySideAddsCalls(b, undefined)) return undefined;
  return combineCallUsageByDay(a[1], b[1], addCallUsageRecords);
}

function addLedgers(a: ByteEstimateLedger, b: ByteEstimateLedger): ByteEstimateLedger {
  return {
    costUsd: a.costUsd + b.costUsd,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costByModel: addRecord(a.costByModel, b.costByModel),
    costByDayUsd: addRecord(a.costByDayUsd, b.costByDayUsd),
    ...addCallUsageParts(a, b),
  };
}

function addAttribution(a: SessionAttribution, b: SessionAttribution): SessionAttribution {
  const buckets: Partial<Record<AttributionFacet, Record<string, AttributionBucket>>> = {};
  for (const facet of new Set([...Object.keys(a.buckets), ...Object.keys(b.buckets)])) {
    const key = facet as AttributionFacet;
    buckets[key] = addEach(a.buckets[key] ?? {}, b.buckets[key] ?? {}, addBucket);
  }
  return {
    buckets,
    highContextCostUsd: a.highContextCostUsd + b.highContextCostUsd,
    apiDurationMs:
      a.apiDurationMs === null && b.apiDurationMs === null
        ? null
        : (a.apiDurationMs ?? 0) + (b.apiDurationMs ?? 0),
  };
}

/** A side with tokens or cost but no split would leave the summed split short of the sum. */
function addBucket(x: AttributionBucket, y: AttributionBucket): AttributionBucket {
  const tokensCovered = (s: AttributionBucket) => s.breakdown !== undefined || s.tokens === 0;
  const breakdown =
    tokensCovered(x) && tokensCovered(y)
      ? addOptional(x.breakdown, y.breakdown, addFields)
      : undefined;
  const splitCoversCost = (s: AttributionBucket) => s.breakdownUsd !== undefined || s.costUsd === 0;
  const breakdownUsd =
    splitCoversCost(x) && splitCoversCost(y)
      ? addOptional(x.breakdownUsd, y.breakdownUsd, addFields)
      : undefined;
  return {
    costUsd: x.costUsd + y.costUsd,
    tokens: x.tokens + y.tokens,
    count: x.count + y.count,
    durationMs: x.durationMs + y.durationMs,
    ...(breakdown ? { breakdown } : {}),
    ...(breakdownUsd ? { breakdownUsd } : {}),
  };
}

type ScoreField = 'efficiencyScore' | 'efficiencyScoreSampleCount' | 'efficiencyScoreComponents';

/**
 * The sample-weighted average `EfficiencyScorer.seedFromPersisted()` would
 * build, or null when either side cannot be weighted.
 */
function addEfficiencyScores(
  a: FullSessionSummary,
  b: FullSessionSummary,
): Pick<FullSessionSummary, ScoreField> | null {
  const [countA, countB] = [a.efficiencyScoreSampleCount ?? 0, b.efficiencyScoreSampleCount ?? 0];
  const [partsA, partsB] = [a.efficiencyScoreComponents, b.efficiencyScoreComponents];
  if (a.efficiencyScore === null || b.efficiencyScore === null || !partsA || !partsB) {
    return null;
  }
  if (countA === 0 || countB === 0) return null;
  const avg = (x: number, y: number): number => (x * countA + y * countB) / (countA + countB);
  return {
    efficiencyScore: avg(a.efficiencyScore, b.efficiencyScore),
    efficiencyScoreSampleCount: countA + countB,
    efficiencyScoreComponents: {
      speed: avg(partsA.speed, partsB.speed),
      correctness: avg(partsA.correctness, partsB.correctness),
      autonomy: avg(partsA.autonomy, partsB.autonomy),
      firstAttemptQuality: avg(partsA.firstAttemptQuality, partsB.firstAttemptQuality),
    },
  };
}

/**
 * The rate is tests passed over tests run, rounded as `buildSessionSummary`
 * rounds it, so those counts rebuild it when both files ran tests.
 */
function addedTaskSuccessRate(a: FullSessionSummary, b: FullSessionSummary): number | null {
  if (a.testRunCount === 0 || b.testRunCount === 0) {
    return weightedRate(a.taskSuccessRate, a.taskCount, b.taskSuccessRate, b.taskCount);
  }
  const rate = (a.testPassCount + b.testPassCount) / (a.testRunCount + b.testRunCount);
  return Math.round(rate * 1000) / 1000;
}

function weightedRate(
  rateA: number | null,
  weightA: number,
  rateB: number | null,
  weightB: number,
): number | null {
  if (rateA === null || rateB === null) return rateA ?? rateB;
  if (weightA + weightB === 0) return (rateA + rateB) / 2;
  return (rateA * weightA + rateB * weightB) / (weightA + weightB);
}

export class SessionStore {
  private readonly sessionsDir: string;

  constructor(options: { storagePath: string }) {
    this.sessionsDir = join(options.storagePath, 'sessions');
  }

  getSessionsDir(): string {
    return this.sessionsDir;
  }

  /**
   * Returns null when nothing was written, else the file the write merged
   * against (`previous`, null for a new file).
   */
  saveSession(
    summary: FullSessionSummary,
  ): { readonly previous: FullSessionSummary | null } | null {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(summary.sessionId) || summary.sessionId === 'unknown') {
      logger.warn('Rejecting invalid sessionId for file path', { sessionId: summary.sessionId });
      return null;
    }

    if (!existsSync(this.sessionsDir)) {
      mkdirSync(this.sessionsDir, { recursive: true, mode: 0o700 });
    }

    // Look up any existing file for this sessionId BEFORE deciding the
    // filename — by sessionId alone, not by today's date-prefixed path. A
    // session can already have a file under an EARLIER date than this
    // write's own startTime computes (e.g. a `--local`/synthetic-owner
    // process rolling up a session it only started observing after a date
    // boundary — see LocalSessionAggregator). Deciding the filename from
    // `summary.startTime` alone before merging, then merging in whatever
    // file happens to share the sessionId regardless of date, wrote the
    // merged (inflated, since counters take the max) result to a NEW file
    // while leaving the OLD file on disk untouched — the session then
    // appeared twice in history with overlapping, double-counted totals.
    const { existing, filesRead } = this.loadSessionFiles(summary.sessionId);

    // Every MCP server process checkpoints every 30s, including windows that
    // never saw a tool call or a token. Writing those first-time files filled
    // history with model-less zero-activity rows that dragged down every
    // per-session average. An existing file is handled by the guard below.
    if (!existing && !hasRecordedUsage(summary)) {
      logger.debug('Skipping first write of a session with no recorded usage', {
        sessionId: summary.sessionId,
      });
      return null;
    }

    // A second process saving under the same sessionId (e.g. two MCP
    // servers both resumed/forked against one real session ID) would
    // otherwise silently overwrite the first save with no error.
    //
    // Guard the destructive case: a short-lived process that adopts an
    // existing session ID (resolved from the session-by-cwd breadcrumb) but
    // never observed any hook activity would replace a fully recorded session
    // with an all-zero summary, erasing tool calls, tokens and cost from the
    // dashboard on the next refresh. Never let an empty summary clobber a
    // non-empty one. A summary with cost or tokens but no tool calls, such as
    // a restarted dashboard's parent-only rollup, is not empty: it merges.
    let toWrite: FullSessionSummary = summary;
    if (existing) {
      if (hasRecordedUsage(existing) && !hasRecordedUsage(summary)) {
        logger.warn('Refusing to overwrite recorded session with an empty summary', {
          sessionId: summary.sessionId,
        });
        return null;
      }
      // Two processes legitimately share one session id: the CLI/editor
      // spawns an MCP engine that owns the session natively, while a
      // `--local` dashboard adopts the same id from the session-by-cwd
      // breadcrumb. Each sees only part of the picture — the engine has the
      // token/model events, the dashboard has the aggregated hook activity —
      // so plain last-write-wins let whichever wrote last erase the other's
      // data, which is how a fully recorded session could come back with
      // modelBreakdown {} and a lower toolCallCount. Merge non-destructively
      // instead: counters take the max (they only ever grow, so max never
      // regresses and never double-counts overlapping views).
      //
      // `existing` combines every split file for this id, and every writer
      // counts from that record: a resumed engine is seeded from it, and a
      // rollup adds its own calls to its count. A writer that never read it,
      // such as an older build, max-merges as it would into one file. It is
      // not classified like a sibling file: a resumed timeline restarts empty
      // and would look disjoint.
      toWrite = mergeSummaries(existing, summary);
    }

    // The filename is derived from the merged (earliest) startTime, not the
    // incoming write's own — mergeSummaries() takes Math.min() of the two,
    // so this is normally the existing file's own date; recomputing here
    // keeps the filename consistent with what's actually written.
    const startDate = new Date(toWrite.startTime);
    if (!isFinite(startDate.getTime())) {
      throw new Error(`Invalid startTime for session ${toWrite.sessionId}: ${toWrite.startTime}`);
    }
    const date = startDate.toISOString().slice(0, 10);
    const filename = `${date}_${toWrite.sessionId}.json`;
    const filepath = resolve(this.sessionsDir, filename);
    if (!filepath.startsWith(this.sessionsDir + sep)) {
      throw new Error(`Session path escaped storage directory: ${filepath}`);
    }

    const unparsedFilesReplaced = filesRead.filter(
      (file) => file.parsed.kind !== 'clean' && file.filepath === filepath,
    );

    // Write-then-rename so two processes saving the same session id can never
    // interleave bytes in the target file (the temp name does not end in .json,
    // so loaders never see it).
    const content = JSON.stringify(toWrite, null, 2) + '\n';
    const tmpPath = `${filepath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      try {
        writeFileSync(tmpPath, content, { mode: 0o600 });
        if (!unparsedFilesReplaced.every(copiedAsideUnchanged)) return null;
        renameIntoPlace(tmpPath, filepath, content);
      } finally {
        try {
          unlinkSync(tmpPath);
        } catch {
          // Renamed into place, or never written.
        }
      }
      // Every other file the record was combined from is now superseded. A
      // file rewritten since it was read holds data this write lacks, so it
      // stays for the next save to fold in. Superseded files are renamed, not
      // deleted: the add-vs-max choice is a heuristic, and a `*.merged` copy
      // (which loaders ignore) keeps those files' bytes. It cannot undo a wrong
      // combine alone, because the earliest file is overwritten by the combined
      // record and has no copy.
      for (const file of filesRead) {
        if (file.parsed.kind === 'unreadable' || file.filepath === filepath) continue;
        try {
          if (!readFileSync(file.filepath).equals(file.bytes)) continue;
          renameSync(file.filepath, `${file.filepath}.${Date.now()}.merged`);
        } catch (err) {
          logger.warn('Failed to set aside superseded session file after merge', {
            sessionId: toWrite.sessionId,
            stalePath: file.filepath,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      logger.debug('Session saved', { sessionId: toWrite.sessionId, filename });
      return { previous: existing };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('Failed to save session file', {
        sessionId: toWrite.sessionId,
        filename,
        error: message,
      });
      return null;
    }
  }

  /** Every readable file for the id, combined into one record (see combineSessionFiles). */
  loadSession(sessionId: string): FullSessionSummary | null {
    return this.loadSessionFiles(sessionId).existing;
  }

  /**
   * Like loadSession(), but also returns every file it read, so saveSession()
   * can set aside the ones the combined record supersedes.
   *
   * An unreadable file is skipped rather than ending the search: returning null
   * there made saveSession() treat the session as new and start a fresh file
   * on every later save.
   */
  private loadSessionFiles(sessionId: string): {
    readonly existing: FullSessionSummary | null;
    readonly filesRead: readonly SessionFileRead[];
  } {
    if (!existsSync(this.sessionsDir)) return { existing: null, filesRead: [] };

    const listFiles = () => this.listSessionFiles().filter((f) => f.sessionId === sessionId);
    const filesRead = this.readListedFiles(listFiles(), listFiles);
    const summaries = summariesIn(filesRead);
    return {
      existing: summaries.length > 0 ? combineSessionFiles(summaries) : null,
      filesRead,
    };
  }

  private listSessionFiles(): SessionFileInfo[] {
    return readdirSync(this.sessionsDir)
      .sort()
      .flatMap((file) => parseSessionFilename(file) ?? []);
  }

  /**
   * Reads the listed files. One that vanished after the listing was set aside
   * by a concurrent save, and the file that save wrote holds its activity, so
   * what was read so far must not be combined and saved over it. Reads a fresh
   * listing instead. A listing that does not change names a file that can never
   * be read, such as a dangling symlink, and that file is skipped.
   */
  private readListedFiles(
    listed: readonly SessionFileInfo[],
    relist: () => readonly SessionFileInfo[],
  ): SessionFileRead[] {
    const reads: SessionFileRead[] = [];
    let vanished = false;
    for (const { filename } of listed) {
      const filepath = resolve(this.sessionsDir, filename);
      try {
        const bytes = readFileSync(filepath);
        reads.push({
          filepath,
          bytes,
          parsed: parseSessionFile(bytes.toString('utf-8'), filepath),
        });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') vanished = true;
        else logger.warn('Failed to read session file', { file: filename });
      }
    }
    if (!vanished) return reads;

    const fresh = relist();
    if (
      fresh.length === listed.length &&
      fresh.every((f, i) => f.filename === listed[i].filename)
    ) {
      logger.warn('Skipping a listed session file that cannot be found', {
        sessionId: listed[0].sessionId,
      });
      return reads;
    }
    return this.readListedFiles(fresh, relist);
  }

  listSessions(options?: ListSessionsOptions): SessionFileInfo[] {
    if (!existsSync(this.sessionsDir)) return [];

    const sinceDate = options?.since ? formatDate(options.since) : null;
    const results: SessionFileInfo[] = [];

    for (const file of readdirSync(this.sessionsDir)) {
      if (!file.endsWith('.json')) continue;

      const parsed = parseSessionFilename(file);
      if (!parsed) continue;

      if (sinceDate && parsed.date < sinceDate) continue;

      if (options?.developer) {
        try {
          const summary = readSessionFile(join(this.sessionsDir, file));
          if (summary?.developer !== options.developer) continue;
        } catch {
          continue;
        }
      }

      results.push(parsed);
    }

    return results.sort(
      (a, b) => a.date.localeCompare(b.date) || a.sessionId.localeCompare(b.sessionId),
    );
  }

  loadAllSessions(options?: LoadSessionsOptions): FullSessionSummary[] {
    if (!existsSync(this.sessionsDir)) return [];

    const sinceDate = options?.since ? formatDate(options.since) : null;
    const modifiedSinceMs = options?.includeModifiedSince?.getTime() ?? null;
    const results: FullSessionSummary[] = [];

    const modifiedSince = (file: SessionFileInfo): boolean => {
      if (modifiedSinceMs === null) return false;
      try {
        return statSync(join(this.sessionsDir, file.filename)).mtimeMs >= modifiedSinceMs;
      } catch {
        return false;
      }
    };

    // A `since` load combines only the files in its window. Combining the whole
    // id would either pull a long session's lifetime totals into a recent
    // window or drop its recent activity because its first file is old.
    const inWindow = (file: SessionFileInfo): boolean =>
      !sinceDate || file.date >= sinceDate || modifiedSince(file);

    const filesById = new Map<string, SessionFileInfo[]>();
    for (const file of this.listSessionFiles().filter(inWindow)) {
      const group = filesById.get(file.sessionId);
      if (group) group.push(file);
      else filesById.set(file.sessionId, [file]);
    }

    for (const [sessionId, files] of filesById) {
      const relist = () =>
        this.listSessionFiles().filter((f) => f.sessionId === sessionId && inWindow(f));
      const summaries = summariesIn(this.readListedFiles(files, relist)).filter(
        (s) => !options?.developer || s.developer === options.developer,
      );
      if (summaries.length === 0) continue;
      const session = combineSessionFiles(summaries);

      // Synthetic session IDs (`local-*`, `proxy-*`, `pending-*`) are
      // MCP-internal bookkeeping from --local / proxy modes, never a real
      // Claude Code session. persistSession() in src/index.ts already
      // refuses to write new ones; any that still exist on disk are stale
      // artifacts from before that guard shipped. Filtering them here
      // means every consumer of this loader (and of loadTodaySessions() /
      // loadSessionsOverlappingToday(), which both delegate to it) gets
      // clean data without re-implementing the same check.
      if (isSyntheticSessionId(session.sessionId)) continue;

      results.push(session);
    }

    return results.sort((a, b) => a.startTime - b.startTime);
  }

  loadTodaySessions(): FullSessionSummary[] {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return this.loadAllSessions({ since: today });
  }

  /**
   * Sessions whose wall-clock spans today's local day at all — i.e. include
   * a session that started yesterday and ended this morning. The "today
   * spend" calculation needs these to attribute the today-portion of any
   * cross-midnight session, since `loadTodaySessions()` filters by file-name
   * date (= start date) and would silently drop them.
   *
   * Loads a 2-day window (yesterday + today's date prefixes) and filters by
   * endTime overlap with [startOfToday, now].
   */
  loadSessionsOverlappingToday(): FullSessionSummary[] {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today.getTime() - 86_400_000);
    const startOfToday = today.getTime();
    const all = this.loadAllSessions({ since: yesterday });
    // endTime=0 is the deserialisation default for sessions that crashed or
    // were written by an older build without the endTime field. Treat those as
    // "unknown end" and include them — they are already bounded to the 2-day
    // window by loadAllSessions({ since: yesterday }).
    return all.filter((s) => s.endTime === 0 || s.endTime >= startOfToday);
  }

  /**
   * `loadSessionsOverlappingToday()` plus resumed sessions that keep an older
   * start-date filename but have tool-call activity today. Files outside the
   * 2-day window are found by mtime (a checkpoint rewrites them) and kept only
   * when their timeline has an entry today. Callers must clamp each session's
   * activity to today, since a returned session can carry earlier days too.
   */
  loadSessionsWithActivityToday(): FullSessionSummary[] {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const startOfToday = today.getTime();
    const windowStart = startOfToday - 86_400_000;
    const all = this.loadAllSessions({
      since: new Date(windowStart),
      includeModifiedSince: today,
    });
    return all.filter((s) =>
      s.startTime >= windowStart
        ? s.endTime === 0 || s.endTime >= startOfToday
        : (s.timeline?.some((t) => t.timestamp >= startOfToday) ?? false),
    );
  }
}

// ---------------------------------------------------------------------------
// buildSessionSummary
// ---------------------------------------------------------------------------

export interface BuildSessionSummarySources {
  sessionTracker: SessionTracker;
  costTracker?: CostTracker;
  turnCostAttributor?: TurnCostAttributor;
  taskDetector?: TaskDetector;
  antiPatternDetector?: AntiPatternDetector;
  efficiencyScorer?: EfficiencyScorer;
  transcriptMessageTracker?: TranscriptMessageTracker;
  toolSelectionScorer?: ToolSelectionScorer;
  modelUsageTracker?: ModelUsageTracker;
  qualityProxyTracker?: QualityProxyTracker;
  developer: string;
  repoName?: string | null;
  /**
   * Session outcome to persist. Defaults to `'completed'`. Periodic mid-session
   * checkpoints MUST pass `'in progress'` so a live session is never persisted
   * (and then rendered) as completed — the dashboard detail route reads this
   * snapshot's outcome verbatim. Only the terminal (shutdown) save should write
   * `'completed'`.
   */
  outcome?: string;
  platform?: string;
  instructionPromptHash?: string | null;
  /**
   * Re-runs the agent attribution join on each tool call before the anti-pattern
   * and tool-selection analyses. By save time `SubagentWatcher` has tailed more
   * transcript than at hook intake, so more calls resolve to their subagent.
   */
  backfillRecord?: (
    record: import('../storage/types.js').ToolCallRecord,
  ) => import('../storage/types.js').ToolCallRecord;
}

function skillInvocationCounts(
  metrics: CostAttributionMetrics | undefined,
): Record<string, number> {
  if (!metrics) return {};
  const result: Record<string, number> = {};
  for (const [skillName, entry] of Object.entries(metrics.costBySkill)) {
    result[skillName] = entry.callCount;
  }
  return result;
}

/**
 * Assemble `SessionAttribution` from the turn attributor's tool/skill
 * buckets and the cost tracker's subagent/high-context/API-duration fields.
 * Facets with no entries are omitted entirely rather than persisted as `{}`.
 */
function buildAttribution(
  turnMetrics: CostAttributionMetrics | null,
  costMetrics: CostMetrics | null,
): SessionAttribution {
  const buckets: Partial<Record<AttributionFacet, Record<string, AttributionBucket>>> = {};

  if (turnMetrics) {
    const toolBuckets: Record<string, AttributionBucket> = {};
    for (const [tool, entry] of Object.entries(turnMetrics.costByToolType)) {
      const hasTokenSignal =
        entry.inputTokens > 0 ||
        entry.outputTokens > 0 ||
        entry.cacheReadTokens > 0 ||
        entry.cacheCreationTokens > 0;
      toolBuckets[tool] = {
        costUsd: entry.totalCost,
        tokens: entry.tokens,
        count: entry.callCount,
        durationMs: 0,
        ...(hasTokenSignal
          ? {
              breakdown: {
                inputTokens: entry.inputTokens,
                outputTokens: entry.outputTokens,
                cacheReadTokens: entry.cacheReadTokens,
                cacheCreationTokens: entry.cacheCreationTokens,
              },
            }
          : {}),
      };
    }
    if (Object.keys(toolBuckets).length > 0) buckets.tool = toolBuckets;

    const skillBuckets: Record<string, AttributionBucket> = {};
    for (const [skill, entry] of Object.entries(turnMetrics.costBySkill)) {
      skillBuckets[skill] = {
        costUsd: entry.totalCost,
        tokens: entry.tokens,
        count: entry.callCount,
        durationMs: entry.totalDurationMs,
        breakdown: {
          inputTokens: entry.inputTokens,
          outputTokens: entry.outputTokens,
          cacheReadTokens: entry.cacheReadTokens,
          cacheCreationTokens: entry.cacheCreationTokens,
        },
        ...(entry.breakdownUsd ? { breakdownUsd: entry.breakdownUsd } : {}),
      };
    }
    if (Object.keys(skillBuckets).length > 0) buckets.skill = skillBuckets;
  }

  const subagentBuckets = costMetrics?.subagentByAgentType;
  if (subagentBuckets && Object.keys(subagentBuckets).length > 0) {
    buckets.subagent = { ...subagentBuckets };
  }

  return {
    buckets,
    highContextCostUsd: costMetrics?.highContextCostUsd ?? 0,
    apiDurationMs: costMetrics?.apiDurationMs ?? null,
  };
}

export function buildSessionSummary(sources: BuildSessionSummarySources): FullSessionSummary {
  const {
    sessionTracker,
    costTracker,
    taskDetector,
    antiPatternDetector,
    efficiencyScorer,
    developer,
    backfillRecord,
  } = sources;

  const sessionMetrics = sessionTracker.getMetrics();
  const costMetrics = costTracker?.getMetrics() ?? null;
  const turnAttributionMetrics = sources.turnCostAttributor?.getMetrics() ?? null;
  const attribution =
    sources.costTracker || sources.turnCostAttributor
      ? buildAttribution(turnAttributionMetrics, costMetrics)
      : undefined;
  const taskMetrics = taskDetector?.getMetrics() ?? null;
  const transcriptMessageMetrics = sources.transcriptMessageTracker?.getMetrics();

  // Aggregate task-level data
  const allFilesRead = new Set<string>();
  const allFilesModified = new Set<string>();
  let totalLinesAdded = 0;
  let totalLinesRemoved = 0;
  let totalTestsRun = 0;
  let totalTestsPassed = 0;
  let totalBuildsRun = 0;
  let totalBuildsPassed = 0;
  let totalAgentSpawns = 0;
  const allToolCalls: import('../storage/types.js').ToolCallRecord[] = [];

  if (taskMetrics) {
    const allTasks = [...taskMetrics.completedTasks];
    const activeTask = taskDetector?.getCurrentTask();
    if (activeTask) allTasks.push(activeTask);

    for (const task of allTasks) {
      for (const f of task.filesRead) allFilesRead.add(f);
      for (const f of task.filesModified) allFilesModified.add(f);
      totalLinesAdded += task.linesAdded;
      totalLinesRemoved += task.linesRemoved;
      totalTestsRun += task.testsRun;
      totalTestsPassed += task.testsPassed;
      totalBuildsRun += task.buildRun;
      totalBuildsPassed += task.buildPassed;
      totalAgentSpawns += task.subAgentsSpawned;
      allToolCalls.push(...(backfillRecord ? task.toolCalls.map(backfillRecord) : task.toolCalls));
    }

    // Fold in pre-restart totals recovered by TaskDetector.seedFromPersisted()
    // — see TaskMetrics.seededAggregate's doc comment for why these can't be
    // represented as a synthetic entry in completedTasks above.
    if (taskMetrics.seededAggregate) {
      for (const f of taskMetrics.seededAggregate.filesRead) allFilesRead.add(f);
      for (const f of taskMetrics.seededAggregate.filesModified) allFilesModified.add(f);
      totalLinesAdded += taskMetrics.seededAggregate.linesAdded;
      totalLinesRemoved += taskMetrics.seededAggregate.linesRemoved;
      totalTestsRun += taskMetrics.seededAggregate.testsRun;
      totalTestsPassed += taskMetrics.seededAggregate.testsPassed;
      totalBuildsRun += taskMetrics.seededAggregate.buildRun;
      totalBuildsPassed += taskMetrics.seededAggregate.buildPassed;
      totalAgentSpawns += taskMetrics.seededAggregate.agentSpawns;
    }
  }

  // Anti-pattern analysis
  const antiPatternResults =
    antiPatternDetector && allToolCalls.length > 0
      ? antiPatternDetector.analyze(allToolCalls)
      : null;

  const antiPatterns: PersistedAntiPattern[] = antiPatternResults
    ? toPersistedAntiPatterns(antiPatternResults.patterns)
    : [];

  // Tool-selection quality: same allToolCalls used for anti-pattern analysis
  // above, still holding real outputSizeBytes at this point — see the
  // ToolSelectionSummary doc comment on FullSessionSummary for why this is
  // the only place that's true.
  const toolSelectionResult =
    sources.toolSelectionScorer && allToolCalls.length > 0
      ? toToolSelectionSummary(sources.toolSelectionScorer.scoreSession(allToolCalls))
      : null;

  // Efficiency score
  const efficiencyAvg = efficiencyScorer?.getSessionAverage() ?? null;

  // Task success rate: ratio of test passes to test runs across all tasks
  const taskSuccessRate =
    totalTestsRun > 0 ? Math.round((totalTestsPassed / totalTestsRun) * 1000) / 1000 : null;

  // Enriched timeline for session replay
  const timeline: ReplayTimelineEntry[] = allToolCalls.map((tc) => ({
    timestamp: tc.timestamp,
    toolUseId: tc.toolUseId || undefined,
    toolName: tc.toolName,
    durationMs: tc.durationMs,
    success: tc.success,
    filePath: tc.filePath ? redactSensitive(String(tc.filePath)) : undefined,
    command: tc.command ? redactSensitive(String(tc.command)) : undefined,
    cwd: tc.cwd ? redactSensitive(String(tc.cwd)) : undefined,
    isTestCommand: (tc.isTestCommand as boolean | undefined) || undefined,
    isBuildCommand: (tc.isBuildCommand as boolean | undefined) || undefined,
    isLintCommand: (tc.isLintCommand as boolean | undefined) || undefined,
    errorType: tc.errorType || undefined,
    skillName: tc.toolName === 'Skill' && tc.skillName ? tc.skillName : undefined,
    agentType: tc.toolName === 'Agent' && tc.agentType ? tc.agentType : undefined,
    createdPrNumber: tc.createdPrNumber,
    createdPrRepo: parsePrRepo(tc.createdPrRepo),
    mcpPrNumber: tc.mcpPrNumber,
    mcpPrRepo: tc.mcpPrRepo,
    runInBackground: tc.runInBackground === true || undefined,
  }));

  const now = Date.now();

  return {
    sessionId: sessionMetrics.sessionId,
    sessionName: sessionMetrics.sessionName ? redactSensitive(sessionMetrics.sessionName) : null,
    // Source is an enum label (not user content) — persisted unredacted.
    sessionNameSource: sessionMetrics.sessionNameSource ?? null,
    // Intent is SENSITIVE content; the tracker only holds a value when
    // recordContent was on, and it is already redacted there. Redact again
    // (idempotent) so persistence is safe regardless of caller.
    sessionIntent: sessionMetrics.sessionIntent
      ? redactSensitive(sessionMetrics.sessionIntent)
      : null,
    repoName: sources.repoName ? redactIdentifier(sources.repoName) : null,
    startTime: sessionMetrics.sessionStartTime,
    endTime: now,
    // Recalculate durationMs from wall-clock times rather than trusting the
    // tracker's accumulated value, which can lag if polling is infrequent.
    durationMs: now - sessionMetrics.sessionStartTime,
    toolCallCount: sessionMetrics.toolCallCount,
    developer,
    model: costMetrics?.model ?? null,
    toolBreakdown: { ...sessionMetrics.toolCallCountByTool },
    skillBreakdown: skillInvocationCounts(
      sources.turnCostAttributor?.getMetrics(sessionMetrics.sessionId),
    ),
    filesRead: [...allFilesRead].sort().map((f) => redactSensitive(f)),
    filesModified: [...allFilesModified].sort().map((f) => redactSensitive(f)),
    linesAdded: totalLinesAdded,
    linesRemoved: totalLinesRemoved,
    bashCommandCount: sessionMetrics.bashCommandsRun,
    testRunCount: totalTestsRun,
    testPassCount: totalTestsPassed,
    buildRunCount: totalBuildsRun,
    buildPassCount: totalBuildsPassed,
    estimatedCostUsd: costMetrics?.sessionTotalCostUsd ?? null,
    subagentCostUsd: costMetrics?.subagentCostUsd ?? 0,
    costByDayUsd: costMetrics?.costByDayUsd ?? {},
    ...(costMetrics && Object.keys(costMetrics.firstActivityByDayMs).length > 0
      ? { firstActivityByDayMs: costMetrics.firstActivityByDayMs }
      : {}),
    subagentCostByDayUsd: costMetrics?.subagentCostByDayUsd ?? {},
    // A day map rides with its counts even when empty (all late arrivals):
    // readers treat an absent one as a summary written before day buckets.
    ...(costMetrics && Object.keys(costMetrics.unpricedByModel).length > 0
      ? { unpricedByModel: costMetrics.unpricedByModel, unpricedByDay: costMetrics.unpricedByDay }
      : {}),
    ...(costMetrics && Object.keys(costMetrics.estimatedByModel).length > 0
      ? {
          estimatedByModel: costMetrics.estimatedByModel,
          estimatedByDay: costMetrics.estimatedByDay,
        }
      : {}),
    ...(costMetrics?.byteEstimates !== undefined
      ? { byteEstimates: costMetrics.byteEstimates }
      : {}),
    ...(costMetrics?.byteEstimates !== undefined
      ? {
          exactTotals: {
            costUsd: Math.max(
              0,
              (costMetrics.sessionTotalCostUsd ?? 0) - costMetrics.byteEstimates.costUsd,
            ),
            inputTokens: Math.max(
              0,
              costMetrics.totalInputTokens - costMetrics.byteEstimates.inputTokens,
            ),
            outputTokens: Math.max(
              0,
              costMetrics.totalOutputTokens - costMetrics.byteEstimates.outputTokens,
            ),
            costByDayUsd: subtractRecord(
              costMetrics.costByDayUsd,
              costMetrics.byteEstimates.costByDayUsd,
            ),
          },
        }
      : {}),
    tokensInput: costMetrics?.totalInputTokens ?? 0,
    tokensOutput: costMetrics?.totalOutputTokens ?? 0,
    tokensThinking: costMetrics?.totalThinkingTokens ?? 0,
    tokensCacheRead: costMetrics?.totalCacheReadTokens ?? 0,
    tokensCacheCreation: costMetrics?.totalCacheCreationTokens ?? 0,
    cacheSavingsUsd: costMetrics?.totalCacheSavingsUsd ?? 0,
    efficiencyScore: efficiencyAvg?.score ?? null,
    efficiencyScoreSampleCount: efficiencyScorer?.getSessionSampleCount() ?? 0,
    efficiencyScoreComponents: efficiencyAvg?.components ?? null,
    antiPatterns,
    taskCount: (taskMetrics?.totalTasksCompleted ?? 0) + (taskMetrics?.currentTaskActive ? 1 : 0),
    taskSuccessRate,
    toolSuccessRate: sessionMetrics.toolSuccessRate,
    contextCompressions: 0,
    agentSpawns: totalAgentSpawns,
    userMessages: transcriptMessageMetrics?.userMessages ?? 0,
    assistantMessages: transcriptMessageMetrics?.assistantMessages ?? 0,
    userCorrections: transcriptMessageMetrics?.userCorrections ?? 0,
    outcome: sources.outcome ?? 'completed',
    platform: sources.platform,
    instructionPromptHash: sources.instructionPromptHash ?? null,
    timeline: timeline.length > 0 ? timeline : undefined,
    toolSelectionMetrics: toolSelectionResult,
    modelBreakdown: sources.modelUsageTracker?.getRawBreakdown() ?? {},
    costByWorkflowRunId: costMetrics?.costByWorkflowRunId ?? {},
    qualityProxy: sources.qualityProxyTracker?.getRawCounts() ?? ZERO_QUALITY_PROXY_COUNTS,
    attribution,
  };
}

/**
 * Maps a persisted session summary into the shape InstructionDriftTracker
 * consumes, for both startup hydration (loadRecords) and shutdown recording
 * (recordSessionOutcome, which only uses the outcome fields and ignores
 * promptHash/timestamp). Returns null when the session never had a prompt
 * hash captured (no CLAUDE.md read that session, or the session predates
 * this field's introduction).
 */
export function sessionSummaryToDriftRecord(
  summary: FullSessionSummary,
): SessionOutcomeRecord | null {
  if (summary.instructionPromptHash === null || summary.instructionPromptHash === undefined) {
    return null;
  }

  return {
    sessionId: summary.sessionId,
    promptHash: summary.instructionPromptHash,
    timestamp: summary.endTime,
    successRate: summary.taskSuccessRate,
    totalTokens: summary.tokensInput + summary.tokensOutput,
    thrashingIncidents: summary.antiPatterns.filter((p) => p.type === 'thrashing').length,
    taskCount: summary.taskCount,
    avgEfficiency: summary.efficiencyScore,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The on-disk shape `deserializeFullSessionSummary` reads. Every field stays
 * `unknown` except the five that get `Array.isArray`/`typeof === 'object'`
 * checked before further processing below — those get just enough shape to
 * remove the inner cast that check's body previously needed, while every
 * runtime guard stays exactly as defensive as before (a legacy on-disk file
 * from an older build may not match this shape).
 */
interface SerializedFullSessionSummary {
  readonly sessionId?: unknown;
  readonly sessionName?: unknown;
  readonly sessionNameSource?: unknown;
  readonly sessionIntent?: unknown;
  readonly repoName?: unknown;
  readonly startTime?: unknown;
  readonly endTime?: unknown;
  readonly durationMs?: unknown;
  readonly toolCallCount?: unknown;
  readonly developer?: unknown;
  readonly model?: unknown;
  readonly toolBreakdown?: Record<string, unknown>;
  readonly skillBreakdown?: Record<string, unknown>;
  readonly filesRead?: unknown[];
  readonly filesModified?: unknown[];
  readonly linesAdded?: unknown;
  readonly linesRemoved?: unknown;
  readonly bashCommandCount?: unknown;
  readonly testRunCount?: unknown;
  readonly testPassCount?: unknown;
  readonly buildRunCount?: unknown;
  readonly buildPassCount?: unknown;
  readonly estimatedCostUsd?: unknown;
  readonly subagentCostUsd?: unknown;
  readonly costByDayUsd?: unknown;
  readonly firstActivityByDayMs?: unknown;
  readonly subagentCostByDayUsd?: unknown;
  readonly unpricedByModel?: unknown;
  readonly estimatedByModel?: unknown;
  readonly unpricedByDay?: unknown;
  readonly estimatedByDay?: unknown;
  readonly byteEstimates?: unknown;
  readonly exactTotals?: unknown;
  readonly tokensInput?: unknown;
  readonly tokensOutput?: unknown;
  readonly tokensThinking?: unknown;
  readonly tokensCacheRead?: unknown;
  readonly tokensCacheCreation?: unknown;
  readonly selfReportCount?: unknown;
  readonly cacheSavingsUsd?: unknown;
  readonly efficiencyScore?: unknown;
  readonly efficiencyScoreSampleCount?: unknown;
  readonly efficiencyScoreComponents?: Record<string, unknown>;
  readonly antiPatterns?: Array<Record<string, unknown>>;
  readonly taskCount?: unknown;
  readonly taskSuccessRate?: unknown;
  readonly toolSuccessRate?: unknown;
  readonly contextCompressions?: unknown;
  readonly agentSpawns?: unknown;
  readonly userMessages?: unknown;
  readonly assistantMessages?: unknown;
  readonly userCorrections?: unknown;
  readonly outcome?: unknown;
  readonly observerCompletedAt?: unknown;
  readonly platform?: unknown;
  readonly instructionPromptHash?: unknown;
  readonly timeline?: Array<Record<string, unknown>>;
  readonly toolSelectionMetrics?: unknown;
  readonly modelBreakdown?: Record<string, unknown>;
  readonly costByWorkflowRunId?: Record<string, unknown>;
  readonly qualityProxy?: Record<string, unknown>;
  readonly attribution?: Record<string, unknown>;
}

/**
 * Accept a breakdown only when all four fields are finite numbers; any other
 * shape is dropped (the bucket itself still parses, just without a
 * breakdown) rather than partially hydrated.
 */
function parseTokenBreakdown(raw: unknown): TokenBreakdown | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens } = r;
  if (
    typeof inputTokens === 'number' &&
    Number.isFinite(inputTokens) &&
    typeof outputTokens === 'number' &&
    Number.isFinite(outputTokens) &&
    typeof cacheReadTokens === 'number' &&
    Number.isFinite(cacheReadTokens) &&
    typeof cacheCreationTokens === 'number' &&
    Number.isFinite(cacheCreationTokens)
  ) {
    return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens };
  }
  return undefined;
}

/** Same all-or-nothing rule as {@link parseTokenBreakdown}, over the four dollar fields. */
function parseUsdBreakdown(raw: unknown): UsdBreakdown | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { inputUsd, outputUsd, cacheReadUsd, cacheCreationUsd } = raw as Record<string, unknown>;
  if (
    typeof inputUsd === 'number' &&
    Number.isFinite(inputUsd) &&
    typeof outputUsd === 'number' &&
    Number.isFinite(outputUsd) &&
    typeof cacheReadUsd === 'number' &&
    Number.isFinite(cacheReadUsd) &&
    typeof cacheCreationUsd === 'number' &&
    Number.isFinite(cacheCreationUsd)
  ) {
    return { inputUsd, outputUsd, cacheReadUsd, cacheCreationUsd };
  }
  return undefined;
}

/**
 * Accept a bucket only when all four core fields are finite numbers; any
 * other shape is dropped rather than partially hydrated. Used to parse each
 * key of every facet in an on-disk `SessionAttribution.buckets`. `breakdown`
 * is optional and validated separately — a malformed breakdown drops only
 * itself, never the bucket (see `parseTokenBreakdown`).
 */
function parseAttributionBucket(raw: unknown): AttributionBucket | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const { costUsd, tokens, count, durationMs } = r;
  if (
    typeof costUsd === 'number' &&
    Number.isFinite(costUsd) &&
    typeof tokens === 'number' &&
    Number.isFinite(tokens) &&
    typeof count === 'number' &&
    Number.isFinite(count) &&
    typeof durationMs === 'number' &&
    Number.isFinite(durationMs)
  ) {
    const breakdown = parseTokenBreakdown(r.breakdown);
    const breakdownUsd = parseUsdBreakdown(r.breakdownUsd);
    return {
      costUsd,
      tokens,
      count,
      durationMs,
      ...(breakdown ? { breakdown } : {}),
      ...(breakdownUsd ? { breakdownUsd } : {}),
    };
  }
  return undefined;
}

/**
 * Parse an on-disk `attribution` field. Returns undefined when the field is
 * absent or not an object (a legacy session summary written before this
 * field existed), so it loads unchanged. Invalid facet keys/buckets are
 * dropped individually rather than invalidating the whole field.
 */
function parseAttribution(raw: unknown): SessionAttribution | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const rawBuckets = r.buckets;
  const buckets: Partial<Record<AttributionFacet, Record<string, AttributionBucket>>> = {};
  if (typeof rawBuckets === 'object' && rawBuckets !== null) {
    for (const facet of ['tool', 'skill', 'subagent'] as const) {
      const facetRaw = (rawBuckets as Record<string, unknown>)[facet];
      if (typeof facetRaw !== 'object' || facetRaw === null) continue;
      const facetBuckets: Record<string, AttributionBucket> = {};
      for (const [key, bucketRaw] of Object.entries(facetRaw as Record<string, unknown>)) {
        const bucket = parseAttributionBucket(bucketRaw);
        if (bucket) facetBuckets[key] = bucket;
      }
      if (Object.keys(facetBuckets).length > 0) buckets[facet] = facetBuckets;
    }
  }
  return {
    buckets,
    highContextCostUsd:
      typeof r.highContextCostUsd === 'number' && Number.isFinite(r.highContextCostUsd)
        ? r.highContextCostUsd
        : 0,
    apiDurationMs:
      typeof r.apiDurationMs === 'number' && Number.isFinite(r.apiDurationMs)
        ? r.apiDurationMs
        : null,
  };
}

/**
 * Parse an untrusted value into a `Record<string, number>`, dropping any
 * non-finite or non-numeric entries. Used to hydrate the per-day cost maps
 * (`costByDayUsd` / `subagentCostByDayUsd`) from disk. Returns undefined when
 * the value is absent or not an object, so a session summary that predates
 * these keys leaves the field undefined and falls through to the aggregate
 * route's timeline pro-rate fallback.
 */
function parseNumberRecord(value: unknown): Record<string, number> | undefined {
  // Reject arrays too (typeof [] === 'object'): a corrupt `costByDayUsd: [5]`
  // must yield undefined so the aggregate route falls through to the timeline
  // pro-rate path, not a bogus `{ '0': 5 }` map that silently reads as $0 today.
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

const MAX_MODEL_ID_LENGTH = 256;

function parseByteEstimates(value: unknown): ByteEstimateLedger | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  const finite = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    costUsd: finite(obj.costUsd),
    inputTokens: finite(obj.inputTokens),
    outputTokens: finite(obj.outputTokens),
    costByModel: parseNumberRecord(obj.costByModel) ?? {},
    costByDayUsd: parseNumberRecord(obj.costByDayUsd) ?? {},
    unpricedByModel: parseUnpricedByModel(obj.unpricedByModel),
    estimatedByModel: parseEstimatedByModel(obj.estimatedByModel),
    unpricedByDay: parseCallUsageByDay<UnpricedModelUsage>(obj.unpricedByDay, parseUnpricedExtra),
    estimatedByDay: parseCallUsageByDay<EstimatedModelUsage>(
      obj.estimatedByDay,
      parseEstimatedExtra,
    ),
  };
}

function parseExactTotals(value: unknown): ExactTotals | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  const finite = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    costUsd: finite(obj.costUsd),
    inputTokens: finite(obj.inputTokens),
    outputTokens: finite(obj.outputTokens),
    costByDayUsd: parseNumberRecord(obj.costByDayUsd) ?? {},
  };
}

function parseUnpricedExtra(): Omit<UnpricedModelUsage, keyof CallUsage> {
  return {};
}

function parseEstimatedExtra({
  estimatedFrom,
}: Record<string, unknown>): Omit<EstimatedModelUsage, keyof CallUsage> | null {
  return typeof estimatedFrom === 'string' &&
    estimatedFrom.length > 0 &&
    estimatedFrom.length <= MAX_MODEL_ID_LENGTH
    ? { estimatedFrom }
    : null;
}

function parseUnpricedByModel(value: unknown): Record<string, UnpricedModelUsage> | undefined {
  return parseCallUsageRecord<UnpricedModelUsage>(value, parseUnpricedExtra);
}

function parseEstimatedByModel(value: unknown): Record<string, EstimatedModelUsage> | undefined {
  return parseCallUsageRecord<EstimatedModelUsage>(value, parseEstimatedExtra);
}

/**
 * Explicitly extract known fields from a raw session object (already parsed
 * from JSON) rather than blindly casting. Prevents untrusted keys from disk
 * being misinterpreted as typed properties. Exported for testing.
 */
export function deserializeFullSessionSummary(
  obj: SerializedFullSessionSummary,
): FullSessionSummary {
  const toolBreakdown = Object.create(null) as Record<string, number>;
  if (typeof obj.toolBreakdown === 'object' && obj.toolBreakdown !== null) {
    for (const [k, v] of Object.entries(obj.toolBreakdown)) {
      if (typeof v === 'number') toolBreakdown[k] = v;
    }
  }

  const skillBreakdown = Object.create(null) as Record<string, number>;
  if (typeof obj.skillBreakdown === 'object' && obj.skillBreakdown !== null) {
    for (const [k, v] of Object.entries(obj.skillBreakdown)) {
      if (typeof v === 'number') skillBreakdown[k] = v;
    }
  }

  // Legacy on-disk files only ever have the old `{type, count}` shape —
  // `count` meant "distinct entries of this type" and carried no target
  // info. Every downstream consumer (trend analysis, weekly summaries,
  // thrashing-incident counts) counts array entries rather than reading a
  // magnitude field, so a legacy entry is expanded back into `count`
  // separate rows of that type here, leaving `file`/`command`/etc.
  // undefined for those older records — that keeps "one array entry = one
  // incident" true for both legacy and current on-disk shapes.
  const antiPatterns: PersistedAntiPattern[] = [];
  if (Array.isArray(obj.antiPatterns)) {
    for (const ap of obj.antiPatterns) {
      if (typeof ap === 'object' && ap !== null) {
        const a = ap;
        if (typeof a.type !== 'string') continue;
        const hasMagnitudeField =
          typeof a.iterations === 'number' ||
          typeof a.readCount === 'number' ||
          typeof a.repeatCount === 'number' ||
          typeof a.editCount === 'number' ||
          typeof a.agentCount === 'number';
        if (!hasMagnitudeField && typeof a.count === 'number') {
          const legacyCount = Math.max(0, Math.trunc(a.count));
          for (let i = 0; i < legacyCount; i++) {
            antiPatterns.push({ type: a.type });
          }
          continue;
        }
        antiPatterns.push({
          type: a.type,
          file: typeof a.file === 'string' ? a.file : undefined,
          command: typeof a.command === 'string' ? a.command : undefined,
          iterations: typeof a.iterations === 'number' ? a.iterations : undefined,
          readCount: typeof a.readCount === 'number' ? a.readCount : undefined,
          repeatCount: typeof a.repeatCount === 'number' ? a.repeatCount : undefined,
          editCount: typeof a.editCount === 'number' ? a.editCount : undefined,
          agentCount: typeof a.agentCount === 'number' ? a.agentCount : undefined,
        });
      }
    }
  }

  const toolSelectionMetrics: ToolSelectionSummary | null = (() => {
    const t = obj.toolSelectionMetrics;
    if (typeof t !== 'object' || t === null) return null;
    const r = t as Record<string, unknown>;
    if (
      typeof r.score !== 'number' ||
      typeof r.totalCalls !== 'number' ||
      typeof r.penalizedCalls !== 'number' ||
      typeof r.redundantReadCount !== 'number' ||
      typeof r.repeatedFailureCount !== 'number' ||
      typeof r.unusedOutputCount !== 'number'
    ) {
      return null;
    }
    return {
      score: r.score,
      totalCalls: r.totalCalls,
      penalizedCalls: r.penalizedCalls,
      redundantReadCount: r.redundantReadCount,
      repeatedFailureCount: r.repeatedFailureCount,
      unusedOutputCount: r.unusedOutputCount,
    };
  })();

  const modelBreakdown: Record<string, ModelBreakdownEntry> = {};
  if (typeof obj.modelBreakdown === 'object' && obj.modelBreakdown !== null) {
    for (const [model, entry] of Object.entries(obj.modelBreakdown)) {
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as Record<string, unknown>;
      if (
        typeof e.requestCount === 'number' &&
        typeof e.totalInputTokens === 'number' &&
        typeof e.totalOutputTokens === 'number' &&
        typeof e.totalCostUsd === 'number'
      ) {
        modelBreakdown[model] = {
          requestCount: e.requestCount,
          totalInputTokens: e.totalInputTokens,
          totalOutputTokens: e.totalOutputTokens,
          totalCostUsd: e.totalCostUsd,
          totalCacheReadTokens:
            typeof e.totalCacheReadTokens === 'number' ? e.totalCacheReadTokens : 0,
          totalCacheCreationTokens:
            typeof e.totalCacheCreationTokens === 'number' ? e.totalCacheCreationTokens : 0,
          totalThinkingTokens:
            typeof e.totalThinkingTokens === 'number' ? e.totalThinkingTokens : 0,
        };
      }
    }
  }

  const costByWorkflowRunId: Record<string, Record<string, number>> = {};
  if (typeof obj.costByWorkflowRunId === 'object' && obj.costByWorkflowRunId !== null) {
    for (const [runId, dayMap] of Object.entries(obj.costByWorkflowRunId)) {
      if (typeof dayMap !== 'object' || dayMap === null) continue;
      const days: Record<string, number> = {};
      for (const [dayKey, usd] of Object.entries(dayMap)) {
        if (typeof usd === 'number') days[dayKey] = usd;
      }
      costByWorkflowRunId[runId] = days;
    }
  }

  const qualityProxy: QualityProxyRawCounts = (() => {
    const q = obj.qualityProxy;
    if (typeof q !== 'object' || q === null) return ZERO_QUALITY_PROXY_COUNTS;
    const r = q as Record<string, unknown>;
    if (
      typeof r.totalSignals !== 'number' ||
      typeof r.diffApplyCleanCount !== 'number' ||
      typeof r.diffFailCount !== 'number' ||
      typeof r.testPassCount !== 'number' ||
      typeof r.testFailCount !== 'number' ||
      typeof r.backtrackCount !== 'number' ||
      typeof r.selfCorrectionCount !== 'number'
    ) {
      return ZERO_QUALITY_PROXY_COUNTS;
    }
    return {
      totalSignals: r.totalSignals,
      diffApplyCleanCount: r.diffApplyCleanCount,
      diffFailCount: r.diffFailCount,
      testPassCount: r.testPassCount,
      testFailCount: r.testFailCount,
      backtrackCount: r.backtrackCount,
      selfCorrectionCount: r.selfCorrectionCount,
    };
  })();

  const efficiencyScoreComponents: EfficiencyScoreComponents | null = (() => {
    const c = obj.efficiencyScoreComponents;
    if (typeof c !== 'object' || c === null) return null;
    const r = c as Record<string, unknown>;
    if (
      typeof r.speed !== 'number' ||
      typeof r.correctness !== 'number' ||
      typeof r.autonomy !== 'number' ||
      typeof r.firstAttemptQuality !== 'number'
    ) {
      return null;
    }
    return {
      speed: r.speed,
      correctness: r.correctness,
      autonomy: r.autonomy,
      firstAttemptQuality: r.firstAttemptQuality,
    };
  })();

  return {
    sessionId:
      typeof obj.sessionId === 'string' && obj.sessionId.length > 0 ? obj.sessionId : 'unknown',
    sessionName: typeof obj.sessionName === 'string' ? obj.sessionName : null,
    sessionNameSource:
      obj.sessionNameSource === 'user' ||
      obj.sessionNameSource === 'ai-title' ||
      obj.sessionNameSource === 'auto' ||
      obj.sessionNameSource === 'cwd'
        ? obj.sessionNameSource
        : null,
    sessionIntent: typeof obj.sessionIntent === 'string' ? obj.sessionIntent : null,
    repoName: typeof obj.repoName === 'string' ? stripRepoNameCredentials(obj.repoName) : null,
    startTime: typeof obj.startTime === 'number' ? obj.startTime : 0,
    endTime: typeof obj.endTime === 'number' ? obj.endTime : 0,
    durationMs: typeof obj.durationMs === 'number' ? obj.durationMs : 0,
    toolCallCount: typeof obj.toolCallCount === 'number' ? obj.toolCallCount : 0,
    developer: typeof obj.developer === 'string' ? obj.developer : 'unknown',
    model: typeof obj.model === 'string' ? obj.model : null,
    toolBreakdown,
    skillBreakdown,
    filesRead: Array.isArray(obj.filesRead)
      ? obj.filesRead.filter((f): f is string => typeof f === 'string')
      : [],
    filesModified: Array.isArray(obj.filesModified)
      ? obj.filesModified.filter((f): f is string => typeof f === 'string')
      : [],
    linesAdded: typeof obj.linesAdded === 'number' ? obj.linesAdded : 0,
    linesRemoved: typeof obj.linesRemoved === 'number' ? obj.linesRemoved : 0,
    bashCommandCount: typeof obj.bashCommandCount === 'number' ? obj.bashCommandCount : 0,
    testRunCount: typeof obj.testRunCount === 'number' ? obj.testRunCount : 0,
    testPassCount: typeof obj.testPassCount === 'number' ? obj.testPassCount : 0,
    buildRunCount: typeof obj.buildRunCount === 'number' ? obj.buildRunCount : 0,
    buildPassCount: typeof obj.buildPassCount === 'number' ? obj.buildPassCount : 0,
    estimatedCostUsd: typeof obj.estimatedCostUsd === 'number' ? obj.estimatedCostUsd : null,
    subagentCostUsd: typeof obj.subagentCostUsd === 'number' ? obj.subagentCostUsd : 0,
    costByDayUsd: parseNumberRecord(obj.costByDayUsd),
    firstActivityByDayMs: parseNumberRecord(obj.firstActivityByDayMs),
    subagentCostByDayUsd: parseNumberRecord(obj.subagentCostByDayUsd),
    unpricedByModel: parseUnpricedByModel(obj.unpricedByModel),
    estimatedByModel: parseEstimatedByModel(obj.estimatedByModel),
    unpricedByDay: parseCallUsageByDay<UnpricedModelUsage>(obj.unpricedByDay, parseUnpricedExtra),
    estimatedByDay: parseCallUsageByDay<EstimatedModelUsage>(
      obj.estimatedByDay,
      parseEstimatedExtra,
    ),
    byteEstimates: parseByteEstimates(obj.byteEstimates),
    exactTotals: parseExactTotals(obj.exactTotals),
    tokensInput: typeof obj.tokensInput === 'number' ? obj.tokensInput : 0,
    tokensOutput: typeof obj.tokensOutput === 'number' ? obj.tokensOutput : 0,
    tokensThinking: typeof obj.tokensThinking === 'number' ? obj.tokensThinking : 0,
    tokensCacheRead: typeof obj.tokensCacheRead === 'number' ? obj.tokensCacheRead : 0,
    tokensCacheCreation: typeof obj.tokensCacheCreation === 'number' ? obj.tokensCacheCreation : 0,
    ...(typeof obj.selfReportCount === 'number' &&
      obj.selfReportCount > 0 && { selfReportCount: obj.selfReportCount }),
    cacheSavingsUsd: typeof obj.cacheSavingsUsd === 'number' ? obj.cacheSavingsUsd : 0,
    efficiencyScore: typeof obj.efficiencyScore === 'number' ? obj.efficiencyScore : null,
    efficiencyScoreSampleCount:
      typeof obj.efficiencyScoreSampleCount === 'number' ? obj.efficiencyScoreSampleCount : 0,
    efficiencyScoreComponents,
    antiPatterns,
    taskCount: typeof obj.taskCount === 'number' ? obj.taskCount : 0,
    taskSuccessRate: typeof obj.taskSuccessRate === 'number' ? obj.taskSuccessRate : null,
    toolSuccessRate: typeof obj.toolSuccessRate === 'number' ? obj.toolSuccessRate : null,
    contextCompressions: typeof obj.contextCompressions === 'number' ? obj.contextCompressions : 0,
    agentSpawns: typeof obj.agentSpawns === 'number' ? obj.agentSpawns : 0,
    userMessages: typeof obj.userMessages === 'number' ? obj.userMessages : 0,
    assistantMessages: typeof obj.assistantMessages === 'number' ? obj.assistantMessages : 0,
    userCorrections: typeof obj.userCorrections === 'number' ? obj.userCorrections : 0,
    outcome: typeof obj.outcome === 'string' ? obj.outcome : 'unknown',
    ...(typeof obj.observerCompletedAt === 'number' && {
      observerCompletedAt: obj.observerCompletedAt,
    }),
    platform: typeof obj.platform === 'string' ? obj.platform : undefined,
    instructionPromptHash:
      typeof obj.instructionPromptHash === 'string' ? obj.instructionPromptHash : null,
    timeline: Array.isArray(obj.timeline)
      ? obj.timeline
          .filter(
            (e): e is Record<string, unknown> =>
              typeof e === 'object' &&
              e !== null &&
              typeof e.timestamp === 'number' &&
              typeof e.toolName === 'string',
          )
          .map((e) => ({
            timestamp: e.timestamp as number,
            toolName: e.toolName as string,
            toolUseId: typeof e.toolUseId === 'string' ? e.toolUseId : undefined,
            durationMs: typeof e.durationMs === 'number' ? e.durationMs : null,
            success: typeof e.success === 'boolean' ? e.success : true,
            filePath: typeof e.filePath === 'string' ? e.filePath : undefined,
            command: typeof e.command === 'string' ? e.command : undefined,
            cwd: typeof e.cwd === 'string' ? e.cwd : undefined,
            isTestCommand: typeof e.isTestCommand === 'boolean' ? e.isTestCommand : undefined,
            isBuildCommand: typeof e.isBuildCommand === 'boolean' ? e.isBuildCommand : undefined,
            isLintCommand: typeof e.isLintCommand === 'boolean' ? e.isLintCommand : undefined,
            errorType: typeof e.errorType === 'string' ? e.errorType : undefined,
            skillName: typeof e.skillName === 'string' ? e.skillName : undefined,
            agentType: typeof e.agentType === 'string' ? e.agentType : undefined,
            createdPrNumber:
              typeof e.createdPrNumber === 'string' && /^\d{1,9}$/.test(e.createdPrNumber)
                ? e.createdPrNumber
                : undefined,
            createdPrRepo: parsePrRepo(e.createdPrRepo),
            mcpPrNumber:
              typeof e.mcpPrNumber === 'string' && /^\d{1,9}$/.test(e.mcpPrNumber)
                ? e.mcpPrNumber
                : undefined,
            mcpPrRepo:
              typeof e.mcpPrRepo === 'string' && /^[\w.-]{1,100}\/[\w.-]{1,100}$/.test(e.mcpPrRepo)
                ? e.mcpPrRepo
                : undefined,
            runInBackground: e.runInBackground === true || undefined,
          }))
      : undefined,
    toolSelectionMetrics,
    modelBreakdown,
    costByWorkflowRunId,
    qualityProxy,
    attribution: parseAttribution(obj.attribution),
  };
}

type ParsedSessionFile =
  | { readonly kind: 'clean' | 'recovered'; readonly summary: FullSessionSummary }
  | { readonly kind: 'unreadable' };

interface SessionFileRead {
  readonly filepath: string;
  readonly bytes: Buffer;
  readonly parsed: ParsedSessionFile;
}

const warnedKeys = new Set<string>();

function warnOnce(key: string, message: string, data: Record<string, unknown>): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  logger.warn(message, data);
}

function parseSessionFile(raw: string, filepath: string): ParsedSessionFile {
  const summary = parseSummary(raw);
  if (summary) return { kind: 'clean', summary };

  const first = firstTopLevelJsonDocument(raw);
  const recovered = first === null ? null : parseSummary(first);
  const file = basename(filepath);
  if (recovered) {
    warnOnce(`recovered:${filepath}`, 'Recovered first JSON document from corrupt session file', {
      file,
    });
    return { kind: 'recovered', summary: recovered };
  }
  warnOnce(`unreadable:${filepath}`, 'Failed to deserialize session file', { file });
  return { kind: 'unreadable' };
}

function summariesIn(files: readonly SessionFileRead[]): FullSessionSummary[] {
  return files.flatMap(({ parsed }) => (parsed.kind === 'unreadable' ? [] : [parsed.summary]));
}

function readSessionFile(filepath: string): FullSessionSummary | null {
  const parsed = parseSessionFile(readFileSync(filepath, 'utf-8'), filepath);
  return parsed.kind === 'unreadable' ? null : parsed.summary;
}

/**
 * Parse a raw session JSON string and extract known fields. Delegates field
 * extraction to `deserializeFullSessionSummary` to avoid duplication.
 */
function parseSummary(raw: string): FullSessionSummary | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  return deserializeFullSessionSummary(parsed as SerializedFullSessionSummary);
}

function copiedAsideUnchanged(file: SessionFileRead): boolean {
  const name = basename(file.filepath);
  try {
    if (!readFileSync(file.filepath).equals(file.bytes)) {
      logger.warn('Session file changed since it was read; skipping this save', { file: name });
      return false;
    }
    if (hasCorruptCopy(file)) return true;
    const suffix = `${Date.now()}.${process.pid}.${randomBytes(4).toString('hex')}`;
    writeFileSync(`${file.filepath}.${suffix}.corrupt`, file.bytes, {
      mode: 0o600,
      flag: 'wx',
    });
    return true;
  } catch (err) {
    logger.warn('Could not copy an unparsed session file aside; skipping this save', {
      file: name,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** True when a `.corrupt` copy of these exact bytes already sits beside the file. */
function hasCorruptCopy(file: SessionFileRead): boolean {
  const dir = dirname(file.filepath);
  const prefix = `${basename(file.filepath)}.`;
  return readdirSync(dir).some((entry) => {
    if (!entry.startsWith(prefix) || !entry.endsWith('.corrupt')) return false;
    try {
      return readFileSync(join(dir, entry)).equals(file.bytes);
    } catch {
      return false;
    }
  });
}

/** Returns the leading `{...}` of `raw` (string- and escape-aware), or null if it never closes. */
function firstTopLevelJsonDocument(raw: string): string | null {
  const start = raw.search(/\S/);
  if (start === -1 || raw[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}' && --depth === 0) {
      return raw.slice(start, i + 1);
    }
  }
  return null;
}

function parseSessionFilename(filename: string): SessionFileInfo | null {
  // Expected format: YYYY-MM-DD_sessionId.json
  const match = filename.match(/^(\d{4}-\d{2}-\d{2})_(.+)\.json$/);
  if (!match) return null;
  return {
    filename,
    date: match[1],
    sessionId: match[2],
  };
}
