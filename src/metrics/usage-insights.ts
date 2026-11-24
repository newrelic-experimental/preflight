import type { FullSessionSummary } from '../storage/session-store.js';
import type { AttributionBucket, TokenBreakdown, UsdBreakdown } from '../storage/types.js';
import { localDateKey, localEndOfDay, localStartOfDay } from '../lib/date.js';
import {
  lastActivityMs,
  lastDaysWindow,
  windowedSessions,
  type ActivityWindow,
  type WindowShare,
} from '../storage/session-window.js';

/**
 * "What's contributing to your spend": independent characteristics of the
 * sessions in a window, each expressed as a share of total spend, plus share
 * tables by skill, subagent type, plugin, and loop. Spend (USD) is the single
 * denominator; tokens are reported alongside where known. Characteristics
 * overlap (a long session can also be subagent-heavy), so shares do not sum
 * to 100%.
 */

export type UsageInsightId =
  'high_context' | 'subagent_heavy' | 'long_sessions' | 'loops' | 'plugins';

export interface UsageShareRow {
  readonly key: string;
  readonly costUsd: number;
  readonly tokens: number;
  readonly count: number;
  /** Percentage of `UsageInsightsReport.totalCostUsd`, rounded to a whole number. */
  readonly sharePct: number;
  /** Summed across every contributing bucket that had one; absent when none did. */
  readonly breakdown?: TokenBreakdown;
  /** Dollars per `breakdown` category; absent when any contributing bucket with spend predates it, since a partial sum would understate the row. */
  readonly breakdownUsd?: UsdBreakdown;
}

export interface UsageInsight extends UsageShareRow {
  readonly id: UsageInsightId;
  readonly sessionCount: number;
  readonly headline: string;
  readonly advice: string;
}

export interface LoopRow {
  readonly sessionId: string;
  readonly sessionName: string | null;
  /** ScheduleWakeup calls + 1: the initial run plus every self-scheduled wakeup. */
  readonly runs: number;
  readonly tokens: number;
  readonly tokensPerRun: number;
  readonly costUsd: number;
  readonly lastRunMs: number;
}

/** One session's part of the window, in the shape History's KPIs, daily chart and Model performance read. */
export interface WindowSessionRow {
  readonly sessionId: string;
  readonly model: string | null;
  readonly estimatedCostUsd: number;
  /** In-window cost per local day, summing to `estimatedCostUsd`. */
  readonly costByDayUsd: Readonly<Record<string, number>>;
  readonly efficiencyScore: number | null;
  readonly toolSuccessRate: number | null;
  readonly antiPatterns: ReadonlyArray<{ readonly type: string }>;
  readonly toolBreakdown: Readonly<Record<string, number>>;
  readonly tokensInput: number;
  readonly tokensOutput: number;
  readonly tokensThinking: number;
  readonly tokensCacheRead: number;
  readonly tokensCacheCreation: number;
}

export interface UsageInsightsReport {
  readonly windowDays: number;
  readonly sessionCount: number;
  readonly totalCostUsd: number;
  readonly totalTokens: number;
  /** Sorted by share descending; zero-share insights are omitted. */
  readonly insights: readonly UsageInsight[];
  readonly skills: readonly UsageShareRow[];
  /** Distinct skills seen in the window, before capping `skills` to its top {@link TABLE_CAP} rows. */
  readonly skillsTotalCount: number;
  readonly subagents: readonly UsageShareRow[];
  /** Distinct subagent types seen in the window, before capping `subagents` to its top {@link TABLE_CAP} rows. */
  readonly subagentsTotalCount: number;
  readonly plugins: readonly UsageShareRow[];
  /** Distinct plugins seen in the window, before capping `plugins` to its top {@link TABLE_CAP} rows. */
  readonly pluginsTotalCount: number;
  readonly loops: readonly LoopRow[];
  /** Loop sessions seen in the window, before capping `loops` to its top {@link TABLE_CAP} rows. */
  readonly loopsTotalCount: number;
  /** Share of window spend that carries tool/skill attribution; null when no session has attribution. */
  readonly attributionRatePct: number | null;
  /** Every session in the window, with costs and tokens scaled to its in-window share. */
  readonly sessions: readonly WindowSessionRow[];
}

/**
 * Both windows keep every session with activity inside them and count only
 * its in-window share of cost and tokens. `rolling` (the default) is the last
 * `windowDays` local calendar days; `today` is the local calendar day of `nowMs`.
 */
export type UsageInsightsOptions =
  | { readonly selection?: 'rolling'; readonly nowMs: number; readonly windowDays: number }
  | { readonly selection: 'today'; readonly nowMs: number };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LONG_SESSION_MS = 8 * 60 * 60 * 1000;
/** A session counts as "subagent-heavy" once subagent cost reaches this share of its total. */
const SUBAGENT_HEAVY_SHARE = 0.25;
/** Every share table (skills/subagents/plugins/loops) is capped to its top N rows by cost. */
const TABLE_CAP = 10;

/**
 * Headline/advice copy for each insight, keyed by id so the per-session pass
 * below only ever computes numbers — no insight-specific string-building is
 * scattered through it. `plugins`' headline is the only one that depends on
 * more than its own percentage (it names the contributing plugin, or falls
 * back to the plural when more than one contributed).
 */
const INSIGHT_COPY: Record<
  UsageInsightId,
  { headline(pct: number, topPlugin: string | null): string; advice: string }
> = {
  high_context: {
    headline: (pct) => `${pct}% of your spend was at >150k context`,
    advice:
      'Longer sessions are more expensive even when cached. /compact mid-task, /clear when switching to new tasks.',
  },
  subagent_heavy: {
    headline: (pct) => `${pct}% of your spend came from subagent-heavy sessions`,
    advice:
      'Each subagent runs its own requests. Be deliberate about spawning them, and consider a cheaper model for simpler subagents.',
  },
  long_sessions: {
    headline: (pct) => `${pct}% of your spend came from sessions active for 8+ hours`,
    advice:
      'These are often background or loop sessions. Continuous usage adds up quickly, so make sure it is intentional.',
  },
  loops: {
    headline: (pct) => `${pct}% of your spend came from /loop sessions`,
    advice: 'Heavy loops can be scoped down or run with a cheaper model via skill frontmatter.',
  },
  plugins: {
    headline: (pct, topPlugin) =>
      topPlugin !== null
        ? `${pct}% of your spend came from the plugin "${topPlugin}"`
        : `${pct}% of your spend came from plugins`,
    advice:
      'Review what this plugin contributes; its agents, skills, and MCP tools all count toward your spend.',
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sharePct(costUsd: number, totalCostUsd: number): number {
  return totalCostUsd > 0 ? Math.round((costUsd / totalCostUsd) * 100) : 0;
}

function sessionTotalTokens(s: FullSessionSummary): number {
  return (
    s.tokensInput + s.tokensOutput + s.tokensCacheRead + s.tokensCacheCreation + s.tokensThinking
  );
}

/** Prefix before the first `:` in a plugin-namespaced skill/agent-type key (`pstack:unslop` -> `pstack`); null when the key carries no plugin prefix. */
function pluginPrefixOf(key: string): string | null {
  const idx = key.indexOf(':');
  return idx > 0 ? key.slice(0, idx) : null;
}

interface RowAccum {
  costUsd: number;
  tokens: number;
  count: number;
  breakdown?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
  breakdownUsd?: {
    inputUsd: number;
    outputUsd: number;
    cacheReadUsd: number;
    cacheCreationUsd: number;
  };
  /** A bucket with spend had no dollar split, so `breakdownUsd` would understate the row. */
  usdIncomplete?: true;
}

function addBreakdownUsd(existing: RowAccum, bucket: AttributionBucket, weight: number): void {
  if (!bucket.breakdownUsd) {
    if (bucket.costUsd > 0) existing.usdIncomplete = true;
    return;
  }
  const u = existing.breakdownUsd ?? {
    inputUsd: 0,
    outputUsd: 0,
    cacheReadUsd: 0,
    cacheCreationUsd: 0,
  };
  u.inputUsd += bucket.breakdownUsd.inputUsd * weight;
  u.outputUsd += bucket.breakdownUsd.outputUsd * weight;
  u.cacheReadUsd += bucket.breakdownUsd.cacheReadUsd * weight;
  u.cacheCreationUsd += bucket.breakdownUsd.cacheCreationUsd * weight;
  existing.breakdownUsd = u;
}

function scaleTokens(tokens: number, weight: number): number {
  return Math.round(tokens * weight);
}

function addBreakdown(existing: RowAccum, bucket: AttributionBucket, weight: number): void {
  if (!bucket.breakdown) return;
  const b = existing.breakdown ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  b.inputTokens += scaleTokens(bucket.breakdown.inputTokens, weight);
  b.outputTokens += scaleTokens(bucket.breakdown.outputTokens, weight);
  b.cacheReadTokens += scaleTokens(bucket.breakdown.cacheReadTokens, weight);
  b.cacheCreationTokens += scaleTokens(bucket.breakdown.cacheCreationTokens, weight);
  existing.breakdown = b;
}

function addToAccum(
  map: Map<string, RowAccum>,
  key: string,
  bucket: AttributionBucket,
  weight: number,
): void {
  let acc = map.get(key);
  if (!acc) {
    acc = { costUsd: 0, tokens: 0, count: 0 };
    map.set(key, acc);
  }
  acc.costUsd += bucket.costUsd * weight;
  acc.tokens += scaleTokens(bucket.tokens, weight);
  acc.count += bucket.count;
  addBreakdown(acc, bucket, weight);
  addBreakdownUsd(acc, bucket, weight);
}

/** Builds one share table (skills/subagents/plugins) from an accumulated per-key map: sorted by cost descending, capped to {@link TABLE_CAP}. */
function shareTable(rows: Map<string, RowAccum>, totalCostUsd: number): UsageShareRow[] {
  return [...rows.entries()]
    .map(([key, acc]) => ({
      key,
      costUsd: acc.costUsd,
      tokens: acc.tokens,
      count: acc.count,
      sharePct: sharePct(acc.costUsd, totalCostUsd),
      ...(acc.breakdown ? { breakdown: acc.breakdown } : {}),
      ...(acc.breakdownUsd && !acc.usdIncomplete ? { breakdownUsd: acc.breakdownUsd } : {}),
    }))
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, TABLE_CAP);
}

/** Latest timeline timestamp among `ScheduleWakeup` entries, or null when the session has no timeline or no such entry. */
function lastScheduleWakeupMs(s: FullSessionSummary): number | null {
  let max: number | null = null;
  for (const entry of s.timeline ?? []) {
    if (entry.toolName === 'ScheduleWakeup' && (max === null || entry.timestamp > max)) {
      max = entry.timestamp;
    }
  }
  return max;
}

function isLoopSession(s: FullSessionSummary, scheduleWakeupCount: number): boolean {
  return scheduleWakeupCount > 0 || 'loop' in (s.attribution?.buckets.skill ?? {});
}

function makeInsight(
  id: UsageInsightId,
  costUsd: number,
  tokens: number,
  sessionCount: number,
  totalCostUsd: number,
  topPlugin: string | null,
): UsageInsight | null {
  const pct = sharePct(costUsd, totalCostUsd);
  if (pct === 0) return null;
  const copy = INSIGHT_COPY[id];
  return {
    id,
    key: id,
    costUsd,
    tokens,
    count: sessionCount,
    sharePct: pct,
    sessionCount,
    headline: copy.headline(pct, topPlugin),
    advice: copy.advice,
  };
}

// ---------------------------------------------------------------------------
// computeUsageInsights
// ---------------------------------------------------------------------------

/** The span of time a report covers. */
export function usageInsightsWindow(opts: UsageInsightsOptions): ActivityWindow {
  if (opts.selection === 'today') {
    const startMs = localStartOfDay(opts.nowMs);
    return { startMs, endMs: localEndOfDay(startMs) };
  }
  return lastDaysWindow(opts.nowMs, opts.windowDays);
}

// Scales a session's in-window day costs to sum to `costUsd`. A session with
// no day map puts it all on its first day in the window.
function daysSummingTo(
  days: Readonly<Record<string, number>>,
  costUsd: number,
  firstDay: string,
): Readonly<Record<string, number>> {
  const sum = Object.values(days).reduce((a, b) => a + b, 0);
  if (sum <= 0) return { [firstDay]: costUsd };
  return Object.fromEntries(Object.entries(days).map(([day, usd]) => [day, (usd * costUsd) / sum]));
}

function windowSessionRow(
  s: FullSessionSummary,
  share: WindowShare,
  costUsd: number,
  w: ActivityWindow,
): WindowSessionRow {
  const scale = (n: number): number => scaleTokens(n, share.weight);
  return {
    sessionId: s.sessionId,
    model: s.model,
    estimatedCostUsd: costUsd,
    costByDayUsd: daysSummingTo(
      share.costByDayUsd,
      costUsd,
      localDateKey(Math.max(s.startTime, w.startMs)),
    ),
    efficiencyScore: s.efficiencyScore,
    toolSuccessRate: s.toolSuccessRate,
    antiPatterns: s.antiPatterns.map(({ type }) => ({ type })),
    toolBreakdown: Object.fromEntries(
      Object.entries(s.toolBreakdown)
        .map(([tool, n]) => [tool, scale(n)] as const)
        .filter(([, n]) => n > 0),
    ),
    tokensInput: scale(s.tokensInput),
    tokensOutput: scale(s.tokensOutput),
    tokensThinking: scale(s.tokensThinking),
    tokensCacheRead: scale(s.tokensCacheRead),
    tokensCacheCreation: scale(s.tokensCacheCreation),
  };
}

export function computeUsageInsights(
  sessions: readonly FullSessionSummary[],
  opts: UsageInsightsOptions,
): UsageInsightsReport {
  const activityWindow = usageInsightsWindow(opts);
  const windowSessions = windowedSessions(sessions, activityWindow);
  const rows: WindowSessionRow[] = [];

  let totalCostUsd = 0;
  let totalTokens = 0;

  const skillsAccum = new Map<string, RowAccum>();
  const subagentsAccum = new Map<string, RowAccum>();
  const pluginsAccum = new Map<string, RowAccum>();
  const pluginSessionIds = new Set<string>();
  const loopRows: LoopRow[] = [];

  let highContextCostUsd = 0;
  let highContextTokens = 0;
  let highContextSessions = 0;

  let subagentHeavyCostUsd = 0;
  let subagentHeavyTokens = 0;
  let subagentHeavySessions = 0;

  let longSessionsCostUsd = 0;
  let longSessionsTokens = 0;
  let longSessionsSessions = 0;

  let loopsCostUsd = 0;
  let loopsTokens = 0;
  let loopsSessions = 0;

  let attributedCostUsd = 0;
  let anyAttribution = false;

  // One per-session pass: every table and insight below is built from the
  // accumulators this loop fills, rather than re-scanning `windowSessions`
  // once per characteristic.
  for (const { session: s, share } of windowSessions) {
    const { weight } = share;
    const lifetimeCost = s.estimatedCostUsd ?? 0;
    const cost = lifetimeCost * weight;
    totalCostUsd += cost;
    rows.push(windowSessionRow(s, share, cost, activityWindow));
    const lifetimeTokens = sessionTotalTokens(s);
    const tokens = scaleTokens(lifetimeTokens, weight);
    totalTokens += tokens;

    const buckets = s.attribution?.buckets;
    if (s.attribution) {
      anyAttribution = true;
      let toolCostSum = 0;
      for (const bucket of Object.values(buckets?.tool ?? {})) toolCostSum += bucket.costUsd;
      attributedCostUsd += toolCostSum * weight;
    }

    for (const [key, bucket] of Object.entries(buckets?.skill ?? {})) {
      addToAccum(skillsAccum, key, bucket, weight);
      const prefix = pluginPrefixOf(key);
      if (prefix) {
        addToAccum(pluginsAccum, prefix, bucket, weight);
        pluginSessionIds.add(s.sessionId);
      }
    }
    for (const [key, bucket] of Object.entries(buckets?.subagent ?? {})) {
      addToAccum(subagentsAccum, key, bucket, weight);
      const prefix = pluginPrefixOf(key);
      if (prefix) {
        addToAccum(pluginsAccum, prefix, bucket, weight);
        pluginSessionIds.add(s.sessionId);
      }
    }

    const highContext = s.attribution?.highContextCostUsd ?? 0;
    if (highContext > 0) {
      highContextCostUsd += highContext * weight;
      highContextTokens += tokens;
      highContextSessions += 1;
    }

    if (lifetimeCost > 0 && s.subagentCostUsd >= SUBAGENT_HEAVY_SHARE * lifetimeCost) {
      subagentHeavyCostUsd += cost;
      subagentHeavyTokens += tokens;
      subagentHeavySessions += 1;
    }

    if (s.durationMs >= LONG_SESSION_MS) {
      longSessionsCostUsd += cost;
      longSessionsTokens += tokens;
      longSessionsSessions += 1;
    }

    const scheduleWakeupCount = s.toolBreakdown.ScheduleWakeup ?? 0;
    if (isLoopSession(s, scheduleWakeupCount)) {
      loopsCostUsd += cost;
      loopsTokens += tokens;
      loopsSessions += 1;
      const runs = scheduleWakeupCount + 1;
      loopRows.push({
        sessionId: s.sessionId,
        sessionName: s.sessionName,
        runs,
        tokens,
        tokensPerRun: Math.round(lifetimeTokens / runs),
        costUsd: cost,
        lastRunMs: lastScheduleWakeupMs(s) ?? lastActivityMs(s),
      });
    }
  }

  const pluginsCostUsd = [...pluginsAccum.values()].reduce((sum, a) => sum + a.costUsd, 0);
  const pluginsTokens = [...pluginsAccum.values()].reduce((sum, a) => sum + a.tokens, 0);
  const topPlugin = pluginsAccum.size === 1 ? [...pluginsAccum.keys()][0]! : null;

  const insights = (
    [
      {
        id: 'high_context',
        costUsd: highContextCostUsd,
        tokens: highContextTokens,
        sessionCount: highContextSessions,
      },
      {
        id: 'subagent_heavy',
        costUsd: subagentHeavyCostUsd,
        tokens: subagentHeavyTokens,
        sessionCount: subagentHeavySessions,
      },
      {
        id: 'long_sessions',
        costUsd: longSessionsCostUsd,
        tokens: longSessionsTokens,
        sessionCount: longSessionsSessions,
      },
      { id: 'loops', costUsd: loopsCostUsd, tokens: loopsTokens, sessionCount: loopsSessions },
      {
        id: 'plugins',
        costUsd: pluginsCostUsd,
        tokens: pluginsTokens,
        sessionCount: pluginSessionIds.size,
      },
    ] as const
  )
    .map((input) =>
      makeInsight(
        input.id,
        input.costUsd,
        input.tokens,
        input.sessionCount,
        totalCostUsd,
        topPlugin,
      ),
    )
    .filter((insight): insight is UsageInsight => insight !== null)
    .sort((a, b) => b.sharePct - a.sharePct);

  return {
    windowDays: opts.selection === 'today' ? 1 : opts.windowDays,
    sessionCount: windowSessions.length,
    totalCostUsd,
    totalTokens,
    insights,
    skills: shareTable(skillsAccum, totalCostUsd),
    skillsTotalCount: skillsAccum.size,
    subagents: shareTable(subagentsAccum, totalCostUsd),
    subagentsTotalCount: subagentsAccum.size,
    plugins: shareTable(pluginsAccum, totalCostUsd),
    pluginsTotalCount: pluginsAccum.size,
    loops: loopRows.sort((a, b) => b.costUsd - a.costUsd).slice(0, TABLE_CAP),
    loopsTotalCount: loopRows.length,
    attributionRatePct: anyAttribution ? sharePct(attributedCostUsd, totalCostUsd) : null,
    sessions: rows,
  };
}
