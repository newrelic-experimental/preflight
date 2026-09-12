import { useMemo, useState, useRef, useEffect } from 'react';
import type { JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import {
  useLiveStore,
  useSubagentStats,
  type AlertEvent,
  type AntiPatternEvent,
} from '../store/liveStore';
import { Kpi } from '../components/Kpi';
import { AnimatedCard } from '../components/AnimatedCard';
import { DiscreteBlockChart, type DiscreteBlockChartItem } from '../components/DiscreteBlockChart';
import { EmptyState } from '../components/EmptyState';
import { SessionTrace } from '../components/SessionTrace';
import { WorkflowRunDetail } from '../components/WorkflowRunDetail';
import { SessionDetailDialog } from '../components/SessionDetailDialog';
import type { AgentSpan } from '../components/AgentSwimlanes';
import type { ConcurrencyData } from '../components/ConcurrencyIndicator';
import { GeoBanner } from '../components/GeoBanner';
import { ContextBar } from '../components/ContextBar';
import { Panel } from '../components/ui/Panel';
import { HealthCard, type HealthCardRow, type HealthTone } from '../components/HealthCard';
import { ShareTable } from '../components/ShareTable';
import { UsageInsightsList } from '../components/UsageInsightsList';
import { AttentionList, type AttentionRow } from '../components/AttentionList';
import { Card, Eyebrow, InfoTooltip, LiveBadge, Pill } from '../components/ui';
import {
  fetchRecentAlerts,
  fetchCacheHealth,
  fetchCost,
  fetchCostPerTool,
  fetchSessionCurrent,
  fetchSessionsList,
  fetchSessionReplay,
  fetchSessionSubagents,
  fetchWorkflows,
  fetchAntiPatterns,
  fetchTurnCosts,
  type TurnCostsResponse,
  fetchDecisionTree,
  type DecisionTreeResponse,
  fetchContext,
  type ContextResponse,
  fetchContextComposition,
  type ContextCompositionResponse,
  fetchContextEfficiency,
  type ContextEfficiencyResponse,
  fetchComputeWaste,
  fetchQualityProxy,
  fetchApiFailures,
  type ApiFailureMetrics,
  fetchToolSelectionScore,
  fetchConcurrency,
  fetchActivityHeatmap,
  fetchModelUsage,
  fetchLiveSessions,
  fetchTodayAggregate,
  fetchObservabilityHealth,
  fetchUsageInsights,
  TodayAggregateResponse,
  ActivityHeatmapTodayResponse,
  LiveSessionEntry,
  NotFoundError,
  CacheHealthResponse,
  ObservabilityHealthResponse,
  qk,
  type SessionSubagentsResponse,
  type LatencyPercentiles,
  type UsageInsightsReport,
} from '../api/client';
import {
  fmtTimeOfDay,
  formatMs,
  formatNumber,
  formatPct,
  formatRelativeTime,
  formatTokensCompact,
  formatUsd,
  formatUsdOrDash,
  shortToolName,
} from '../lib/format';
import { isSameLocalDay, localStartOfDay, todayPortionRatio } from '../../lib/date.js';

const HEADER_TIMESTAMP_FORMAT = {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
} as const;

const RECENT_ALERTS_REFETCH_MS = 30_000;

const SEVERITY_DOT: Record<AlertEvent['severity'], string> = {
  info: 'text-ink-muted',
  warning: 'text-accent-amber',
  critical: 'text-accent-red',
};

interface CostApiResponse {
  readonly cost: { readonly sessionTotalCostUsd?: number | null; readonly model?: string | null };
  readonly forecast: {
    readonly forecastEndOfDayUsd?: number | null;
    readonly forecastEndOfWeekUsd?: number | null;
    readonly forecastSessionEndUsd?: number | null;
    readonly confidenceNote?: string | null;
  } | null;
  readonly sessionTodayUsd?: number | null;
}

// Minimal view of the /api/session/current payload.
interface SessionAntiPattern {
  readonly type: string;
  readonly sessionId?: string;
  readonly count?: number;
  readonly file?: string;
  readonly command?: string;
  readonly iterations?: number;
  readonly readCount?: number;
  readonly repeatCount?: number;
  readonly editCount?: number;
  readonly agentCount?: number;
}

// Reads whichever count-shaped field a given anti-pattern actually carries —
// the persisted/API shape varies by pattern type (readCount for re-reading,
// repeatCount for thrashing, etc.) with no single unified `count` field.
function resolveAntiPatternCount(ap: SessionAntiPattern): number {
  return (
    ap.count ??
    ap.iterations ??
    ap.readCount ??
    ap.repeatCount ??
    ap.editCount ??
    ap.agentCount ??
    0
  );
}

interface ComputeWasteApiResponse {
  readonly total_tokens_wasted: number;
  readonly retry_tokens_wasted: number;
  readonly anti_pattern_tokens_wasted: number;
  readonly breakdown: ReadonlyArray<{
    readonly type: string;
    readonly tokens_wasted: number;
    readonly instances: number;
  }>;
  readonly by_session?: ReadonlyArray<{
    readonly session_id: string;
    readonly tokens_wasted: number;
    readonly alert_count: number;
  }>;
  readonly status: 'clean' | 'moderate' | 'needs_attention';
}

function computeWasteRecommendationText(
  status: ComputeWasteApiResponse['status'],
  topPatternType: string | null,
): string {
  if (status === 'clean') return 'No compute waste detected this session.';

  const patternAdvice: Record<string, string> = {
    stuck_loop: 'Address the command output before re-running the same command.',
    re_reading: 'Read each file once and keep relevant sections in mind.',
    thrashing: 'Read the test failure output carefully before editing again.',
    blind_editing: 'Verify changes with tests between edit batches.',
    over_delegation:
      'Multiple sub-agent spawns failed or were interrupted — investigate why before retrying.',
  };

  const advice = topPatternType !== null ? (patternAdvice[topPatternType] ?? null) : null;
  return advice ?? 'Review anti-patterns to reduce repeated tool calls.';
}

export interface SessionSummary {
  readonly sessionId: string;
  readonly sessionName?: string | null;
  readonly startTime?: number;
  readonly endTime?: number;
  readonly durationMs?: number;
  readonly toolCallCount?: number;
  readonly estimatedCostUsd?: number | null;
  readonly antiPatterns?: SessionAntiPattern[];
  readonly model?: string | null;
  readonly toolSuccessRate?: number | null;
}

interface QualityProxyMetrics {
  readonly totalSignals: number;
  readonly diffApplyRate: number | null;
  readonly testPassRate: number | null;
  readonly backtrackCount: number;
  readonly selfCorrectionCount: number;
  readonly degradationDetected: boolean;
}

interface ToolSelectionOffender {
  readonly toolName: string;
  readonly reason: 'redundant_read' | 'repeated_failure' | 'unused_output';
  readonly penaltyScore: number;
  readonly detail: string;
}

interface ToolSelectionMetrics {
  readonly score: number;
  readonly totalCalls: number;
  readonly penalizedCalls: number;
  readonly redundantReadCount: number;
  readonly repeatedFailureCount: number;
  readonly unusedOutputCount: number;
  readonly worstOffenders: readonly ToolSelectionOffender[];
}

const QUALITY_REFETCH_MS = 10_000;

export function Today(): JSX.Element {
  const cost = useLiveStore((s) => s.cost);
  const antiPatterns = useLiveStore((s) => s.antiPatterns);
  const subagentStats = useSubagentStats();
  const { data: healthApi } = useQuery<ObservabilityHealthResponse>({
    queryKey: ['observability-health'],
    queryFn: fetchObservabilityHealth,
    refetchInterval: 30_000,
  });

  const { data: costApi, isPending: costPending } = useQuery<CostApiResponse>({
    queryKey: qk.cost,
    queryFn: fetchCost,
    refetchInterval: 10_000,
  });
  const { data: aggregate, isPending: aggregatePending } = useQuery<TodayAggregateResponse>({
    queryKey: qk.sessionsTodayAggregate,
    queryFn: fetchTodayAggregate,
    refetchInterval: 10_000,
  });
  const { data: todaySessions, isPending: sessionsPending } = useQuery<SessionSummary[]>({
    queryKey: qk.sessionsList(200),
    queryFn: () => fetchSessionsList(200),
    refetchInterval: 10_000,
  });
  const { data: apiAntiPatterns, isPending: antiPatternsPending } = useQuery<SessionAntiPattern[]>({
    queryKey: qk.antiPatterns,
    queryFn: fetchAntiPatterns,
  });
  const { data: concurrency, isPending: concurrencyPending } = useQuery<ConcurrencyData>({
    queryKey: qk.concurrency,
    queryFn: fetchConcurrency,
    refetchInterval: 10_000,
  });
  const { data: todayHeatmap, isPending: todayHeatmapPending } =
    useQuery<ActivityHeatmapTodayResponse>({
      queryKey: qk.activityHeatmap('today'),
      queryFn: () => fetchActivityHeatmap('today'),
      refetchInterval: 30_000,
    });
  // Live-session list — drives the selector default and the
  // "Session ended" badge logic when the selected session goes stale.
  const { data: liveSessions, isPending: liveSessionsPending } = useQuery<LiveSessionEntry[]>({
    queryKey: qk.sessionsLive,
    queryFn: fetchLiveSessions,
    refetchInterval: 10_000,
  });

  const persistedTodaySpend = useMemo(
    () => computeTodaySpend(todaySessions ?? []),
    [todaySessions],
  );
  const persistedTodayCalls = useMemo(
    () => computeTodayToolCalls(todaySessions ?? []),
    [todaySessions],
  );
  const persistedTodayFlags = useMemo(
    () => computeTodayFlags(todaySessions ?? []),
    [todaySessions],
  );
  const hourlySpend = useMemo(() => buildHourlySpend(todaySessions ?? []), [todaySessions]);

  // Fallback source for the attention panel's anti-pattern flags when
  // neither the live SSE store nor this process's own /api/anti-patterns has
  // anything — the pattern may have been detected by a different process,
  // but its persisted session record (already fetched for the KPI strip)
  // still has it.
  const persistedAntiPatterns = useMemo(
    () =>
      (todaySessions ?? []).flatMap((s) =>
        (s.antiPatterns ?? []).map((a) => ({ ...a, sessionId: s.sessionId })),
      ),
    [todaySessions],
  );

  // Prefer the cross-session aggregate when present; fall
  // back to the legacy persisted-sessions math during the loading window so
  // the KPIs don't blink to zero on first paint. Use Math.max (not `??`)
  // because the aggregate endpoint can legitimately return 0 when its
  // disk-only data sources see no events from today (e.g., the live
  // session's events are in the in-memory tool-call buffer of a different
  // MCP, not in any drained buffer-*.jsonl file). Matches the spend +
  // flags formulas just below. `costApi?.sessionTodayUsd` (the REST
  // fallback for this process's own today-scoped spend) is folded in
  // alongside the SSE and aggregate sources so the KPI reflects real spend
  // as soon as any one source resolves, instead of waiting on the first SSE
  // frame while the aggregate still legitimately reads 0.
  const calls = Math.max(aggregate?.toolCallCount ?? 0, persistedTodayCalls);
  const spendLoading =
    (costPending || sessionsPending || aggregatePending) &&
    !cost &&
    persistedTodaySpend === 0 &&
    aggregate === undefined;
  const todayTotal = Math.max(
    cost?.todayTotalUsd ?? 0,
    aggregate?.totalCostUsd ?? 0,
    persistedTodaySpend,
    costApi?.sessionTodayUsd ?? 0,
  );

  // Aggregate flags = anti-patterns from every live + persisted session today.
  // Falls back to the legacy persisted+live-session math during the loading
  // window. The `currentSessionFlags` line is preserved so SSE-driven
  // anti-pattern bursts still bump the KPI before the next aggregate refetch.
  const currentSessionFlags = Math.max(apiAntiPatterns?.length ?? 0, antiPatterns.length);
  const flagsCount = Math.max(
    aggregate?.antiPatternCount ?? 0,
    persistedTodayFlags + currentSessionFlags,
  );
  const forecastKpiUsd = spendLoading
    ? null
    : (aggregate?.forecastEndOfDayUsd ??
      cost?.forecastEodUsd ??
      costApi?.forecast?.forecastEndOfDayUsd ??
      null);

  // The subagent KPI must source from the polled aggregate
  // endpoint, not the liveStore — the SSE frames that would populate
  // useSubagentStats are never emitted server-side, so subagentStats stays 0.
  // Take the larger of the API value and the live-tick value so SSE bursts
  // (if/when wired) still bump the KPI between aggregate refetches, while the
  // API remains the source of truth for the at-rest value via polling.
  const subagentUsd = Math.max(aggregate?.subagentUsd ?? 0, subagentStats.usd);
  // Distinguish "no data yet" (aggregate still loading and no live ticks) from
  // a genuine zero so the KPI shows the em-dash empty state instead of $0.00.
  const subagentHasData = aggregate !== undefined || subagentStats.turns > 0;
  const subagentSub =
    subagentHasData && todayTotal > 0
      ? `${formatPct((subagentUsd / todayTotal) * 100)} of today`
      : undefined;
  // The watcher-off caveat only matters while this process has recorded no
  // subagent turns of its own — once it has, the KPI is clearly live.
  const watcherOff = healthApi?.watcherActive === false && subagentUsd === 0;
  // The Forecast card's parent/subagent breakdown must always sum to the
  // total it displays. aggregate.totalCostUsd and aggregate.subagentUsd come
  // from the same request and are guaranteed consistent (subagent cost is
  // already a subset of total cost by construction), whereas todayTotal and
  // subagentUsd above are each independently maxed across sources that don't
  // share that guarantee (e.g. a live SSE subagent tick can outrun a
  // stale-low SSE/aggregate total). Prefer the aggregate's own pair for the
  // breakdown, but only when the aggregate is actually the dominant source —
  // aggregate.totalCostUsd can legitimately read 0 while a fresher SSE/REST
  // source already knows about real spend (its disk-only sources see no
  // events from today yet), and switching to the aggregate pair in that case
  // would present a stale-zero breakdown under an already-higher KPI. When
  // the aggregate isn't dominant, fall back to the independently-maxed
  // page-wide values instead.
  const forecastBreakdownTotalUsd =
    aggregate && aggregate.totalCostUsd >= todayTotal ? aggregate.totalCostUsd : todayTotal;
  const forecastBreakdownSubagentUsd =
    aggregate && aggregate.totalCostUsd >= todayTotal ? (aggregate.subagentUsd ?? 0) : subagentUsd;
  // End-of-week projection, computed client-side from the same persisted
  // session list already fetched for the KPI strip — see buildWeekForecast.
  // Replaces the server's rate-based forecastEndOfWeekUsd (no longer shown).
  const weekForecast =
    forecastKpiUsd !== null
      ? buildWeekForecast(
          todaySessions ?? [],
          forecastKpiUsd,
          forecastBreakdownTotalUsd,
          Date.now(),
        )
      : null;
  const [headerTimestamp, setHeaderTimestamp] = useState(() =>
    new Date().toLocaleString(undefined, HEADER_TIMESTAMP_FORMAT),
  );
  // Tracks the local calendar day this component last observed. The same
  // 60s tick that refreshes the header clock also checks for a local-
  // midnight rollover and clears the SSE-derived cost/subagent snapshot when
  // one is detected — without this, a dashboard tab left open across
  // midnight with no new tool-call activity right away keeps rendering
  // yesterday's "Spend Today"/forecast/subagent numbers forever, since
  // setCost()/addSubagentTurn() only fire on a fresh server push and nothing
  // else invalidates the cached value.
  const lastSeenDayRef = useRef(Date.now());
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      setHeaderTimestamp(new Date(now).toLocaleString(undefined, HEADER_TIMESTAMP_FORMAT));
      if (!isSameLocalDay(now, lastSeenDayRef.current)) {
        lastSeenDayRef.current = now;
        useLiveStore.getState().handleDayRollover();
      }
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  const effScore = aggregate?.avgEfficiencyScore ?? null;
  const effDisplay =
    effScore !== null && Number.isFinite(effScore) ? formatPct(effScore * 100) : '—';
  const effSub =
    effScore === null
      ? 'needs more data'
      : Math.round(effScore * 100) >= 80
        ? 'strong session'
        : Math.round(effScore * 100) >= 50
          ? 'mixed signals'
          : 'needs attention';

  const noActivityToday =
    !spendLoading &&
    !aggregatePending &&
    !sessionsPending &&
    !antiPatternsPending &&
    !concurrencyPending &&
    !todayHeatmapPending &&
    !liveSessionsPending &&
    calls === 0 &&
    todayTotal === 0 &&
    flagsCount === 0;

  return (
    <section>
      <GeoBanner />
      <header className="flex items-baseline justify-between mb-4">
        <h1 className="text-xl font-semibold gradient-text">Today</h1>
        <span className="text-xs text-ink-muted">{headerTimestamp}</span>
      </header>

      {noActivityToday ? (
        <>
          <AnimatedCard index={0} className="glass-card p-8 mb-4">
            <EmptyState
              icon="code"
              title="No activity yet today"
              subtitle="Metrics will appear here once you start a coding session with Claude."
            />
          </AnimatedCard>

          <AnimatedCard index={1} className="mb-3">
            <SpendBreakdownPanel />
          </AnimatedCard>

          <AnimatedCard index={2} className="grid grid-cols-2 gap-3">
            <NeedsAttentionPanel
              antiPatterns={antiPatterns}
              apiAntiPatterns={apiAntiPatterns}
              persistedAntiPatterns={persistedAntiPatterns}
              flagsCount={flagsCount}
            />
            <ContributingTodayPanel />
          </AnimatedCard>
        </>
      ) : (
        <>
          <AnimatedCard index={0} className="mb-4">
            <Card padding="lg" tone="elevated" glow="green">
              <div className="grid grid-cols-5 gap-4">
                <Kpi
                  label="efficiency"
                  hero
                  value={effDisplay}
                  sub={effSub}
                  {...(effScore !== null
                    ? { animate: true, numericValue: Math.round(effScore * 100), suffix: '%' }
                    : {})}
                />
                <Kpi
                  label="spend today"
                  tone="good"
                  value={spendLoading ? '…' : formatUsd(todayTotal)}
                  sub={
                    forecastKpiUsd != null && forecastKpiUsd > todayTotal
                      ? `→ ${formatUsd(forecastKpiUsd)} by end of day`
                      : undefined
                  }
                  {...(!spendLoading
                    ? { animate: true, numericValue: todayTotal, format: formatUsd }
                    : {})}
                />
                <div className="relative">
                  <Kpi
                    label="subagent spend"
                    value={!subagentHasData ? '—' : formatUsd(subagentUsd)}
                    sub={subagentSub}
                    {...(subagentHasData
                      ? { animate: true, numericValue: subagentUsd, format: formatUsd }
                      : {})}
                  />
                  <span className="absolute top-0 right-1">
                    <InfoTooltip text="Cost from subagent (Task tool) invocations today. Combines this session's live tracking with other sessions' saved totals; some dashboard processes don't track subagents live." />
                  </span>
                </div>
                <Kpi label="tool calls" value={String(calls)} animate numericValue={calls} />
                <Kpi
                  label="flags"
                  tone={flagsCount > 0 ? 'warn' : 'neutral'}
                  value={String(flagsCount)}
                  animate
                  numericValue={flagsCount}
                />
              </div>
            </Card>
            {watcherOff && (
              <div className="mt-2 text-[10px] text-ink-muted">
                Subagent cost tracking is disabled (
                <code className="font-mono">NR_AI_ENABLE_SUBAGENT_WATCHER=0</code>), so spend shown
                here excludes subagents. Unset it and restart to see full spend.
              </div>
            )}
          </AnimatedCard>

          <AnimatedCard index={1} className="grid grid-cols-2 gap-3 mb-3">
            <NeedsAttentionPanel
              antiPatterns={antiPatterns}
              apiAntiPatterns={apiAntiPatterns}
              persistedAntiPatterns={persistedAntiPatterns}
              flagsCount={flagsCount}
            />
            <ContributingTodayPanel />
          </AnimatedCard>

          <AnimatedCard index={2} className="mb-3">
            <SpendBreakdownPanel />
          </AnimatedCard>

          <AnimatedCard index={3}>
            <LiveSessionPane sessions={todaySessions ?? []} liveSessions={liveSessions ?? []} />
          </AnimatedCard>

          <AnimatedCard index={4} className="grid grid-cols-3 gap-3 mb-3">
            <CacheHealthCard aggregate={aggregate} />
            <ToolSelectionCard />
            <QualityCard />
            <ComputeWasteCard liveSessions={liveSessions ?? []} />
            <LatencyCard aggregate={aggregate} />
            <ApiFailuresCard />
          </AnimatedCard>

          <AnimatedCard index={5} className="grid grid-cols-2 gap-3 items-start">
            <ForecastEodCard
              todayTotal={forecastBreakdownTotalUsd}
              forecastEod={forecastKpiUsd}
              subagentUsd={forecastBreakdownSubagentUsd}
              weekForecast={weekForecast}
            />
            <ActivityTodayPanel
              hourlySpend={hourlySpend}
              todayHeatmap={todayHeatmap}
              concurrency={concurrency}
            />
          </AnimatedCard>
        </>
      )}
    </section>
  );
}

// --- Needs Attention Panel ---

/**
 * One row per anti-pattern type. Persisted sessions can carry hundreds of
 * per-file flags for a day; the reader wants "Repeated reads ×187" with the
 * files and sessions behind it, not one pill per path.
 */
export interface RawAttentionFlag {
  readonly type: string;
  readonly count: number;
  readonly target?: string;
  readonly sessionId?: string;
}

export function aggregateAttentionFlags(raw: readonly RawAttentionFlag[]): readonly AttentionRow[] {
  const byType = new Map<
    string,
    { count: number; targets: Set<string>; sessionIds: Set<string> }
  >();
  for (const flag of raw) {
    const entry = byType.get(flag.type) ?? {
      count: 0,
      targets: new Set<string>(),
      sessionIds: new Set<string>(),
    };
    entry.count += flag.count;
    if (flag.target && flag.target !== 'unknown') entry.targets.add(flag.target);
    if (flag.sessionId) entry.sessionIds.add(flag.sessionId);
    byType.set(flag.type, entry);
  }
  return [...byType.entries()]
    .map(([type, { count, targets, sessionIds }]) => ({
      type,
      count,
      targets: [...targets],
      sessionIds: [...sessionIds],
    }))
    .sort((a, b) => b.count - a.count);
}

function NeedsAttentionPanel({
  antiPatterns,
  apiAntiPatterns,
  persistedAntiPatterns,
  flagsCount,
}: {
  antiPatterns: readonly AntiPatternEvent[];
  apiAntiPatterns: SessionAntiPattern[] | undefined;
  persistedAntiPatterns: SessionAntiPattern[];
  flagsCount: number;
}): JSX.Element {
  // The query returns `null` when the endpoint is 404 (cloud mode — no
  // alert engine), so the panel can fall back to flags-only instead of a
  // permanent red error banner. retry: false avoids the 4× request
  // multiplier React Query would otherwise produce on every refetch.
  const { data, error } = useQuery<readonly AlertEvent[] | null>({
    queryKey: qk.alertsRecent,
    queryFn: async () => {
      try {
        return await fetchRecentAlerts();
      } catch (err) {
        if (err instanceof NotFoundError) return null;
        throw err;
      }
    },
    refetchInterval: RECENT_ALERTS_REFETCH_MS,
    retry: false,
  });

  const entries: readonly AlertEvent[] = data ?? [];
  const sortedEntries = [...entries].sort((a, b) => b.firedAt - a.firedAt);
  const firingCount = sortedEntries.filter((a) => a.state === 'firing').length;

  // Same fallback priority the old banner used: prefer the live SSE list,
  // then this process's own /api/anti-patterns, then whatever's already
  // persisted in today's session records.
  const rawFlags: readonly RawAttentionFlag[] =
    antiPatterns.length > 0
      ? antiPatterns.map((a) => ({ type: a.type, count: a.count, target: a.target }))
      : apiAntiPatterns && apiAntiPatterns.length > 0
        ? apiAntiPatterns.map((a) => ({
            type: a.type,
            count: resolveAntiPatternCount(a),
            target: a.file ?? a.command ?? 'unknown',
          }))
        : persistedAntiPatterns.map((a) => ({
            type: a.type,
            count: resolveAntiPatternCount(a),
            target: a.file ?? a.command ?? 'unknown',
            sessionId: a.sessionId,
          }));
  const aggregated = aggregateAttentionFlags(rawFlags);
  // The Flags KPI counts flags this process never saw in detail (other
  // sessions' aggregate totals), so never contradict it with "nothing".
  const flags =
    aggregated.length === 0 && flagsCount > 0
      ? [{ type: 'anti_pattern_flags', count: flagsCount, targets: [], sessionIds: [] }]
      : aggregated;

  return (
    <Panel title="Needs attention">
      {error && (
        <div className="text-accent-red text-[11px] mb-2">Error loading recent alerts.</div>
      )}
      <AttentionList rows={flags} firingCount={firingCount} alertsHref="/alerts" />
      {sortedEntries.length > 0 && (
        <table className="w-full text-xs mt-3">
          <thead className="text-ink-muted">
            <tr>
              <th className="text-left pb-1">when</th>
              <th className="text-left pb-1">sev</th>
              <th className="text-left pb-1">rule</th>
              <th className="text-right pb-1">value / threshold</th>
              <th className="text-left pb-1 pl-2">state</th>
            </tr>
          </thead>
          <tbody>
            {sortedEntries.slice(0, 5).map((a) => (
              <tr key={`${a.id}-${a.firedAt}-${a.state}`} className="border-t border-border-subtle">
                <td className="py-1 text-ink-subtle tabular-nums whitespace-nowrap">
                  {formatRelativeTime(a.firedAt)}
                </td>
                <td className="py-1">
                  <span aria-hidden="true" className={SEVERITY_DOT[a.severity]}>
                    ●
                  </span>{' '}
                  <span className="text-ink-subtle uppercase tracking-wider text-[10px]">
                    {a.severity}
                  </span>
                </td>
                <td className="py-1">{a.title}</td>
                <td className="py-1 text-right tabular-nums">
                  {formatNumber(a.value)} / {formatNumber(a.threshold)}
                </td>
                <td
                  className={
                    'py-1 pl-2 ' + (a.state === 'firing' ? 'text-accent-amber' : 'text-ink-muted')
                  }
                >
                  {a.state}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

// --- Contributing Today Panel ---

function ContributingTodayPanel(): JSX.Element {
  const { data, isError } = useQuery<UsageInsightsReport>({
    queryKey: qk.usageInsights('today'),
    queryFn: () => fetchUsageInsights('today'),
    refetchInterval: QUALITY_REFETCH_MS,
  });

  if (isError) {
    return (
      <Panel title="What's contributing to today's spend" subtitle="Since midnight">
        <EmptyState variant="inline" title="Usage insights unavailable" />
      </Panel>
    );
  }

  return (
    <Panel title="What's contributing to today's spend" subtitle="Since midnight">
      <UsageInsightsList
        insights={data?.insights ?? []}
        emptyText="Nothing stands out yet today."
      />
    </Panel>
  );
}

// --- Spend Breakdown Panel ---

interface ModelStats {
  readonly requestCount: number;
  readonly totalCostUsd: number;
  readonly costPerMillionTokens: number | null;
}

interface ModelUsageMetrics {
  readonly byModel: Readonly<Record<string, ModelStats>>;
  readonly mostUsedModel: string | null;
}

interface ModelShareRow {
  readonly model: string;
  readonly requestCount: number;
  readonly costPerMillionTokens: number | null;
  readonly totalCostUsd: number;
  readonly sharePct: number;
}

interface ToolShareRow {
  readonly tool: string;
  readonly label: string;
  readonly calls: number;
  readonly costUsd: number;
  readonly sharePct: number;
}

interface SkillShareRow {
  readonly skill: string;
  readonly calls: number;
  readonly costUsd: number;
  readonly sharePct: number;
}

function SpendBreakdownPanel(): JSX.Element {
  const { data: costData, isError: costError } = useQuery<TurnCostsResponse>({
    queryKey: qk.costPerTool,
    queryFn: () => fetchCostPerTool(),
    refetchInterval: QUALITY_REFETCH_MS,
    retry: false,
  });
  // Same shape-defensive guard as the health cards below — `data.byModel`
  // can be missing or null when no token events have been recorded yet.
  const { data: modelData } = useQuery<ModelUsageMetrics>({
    queryKey: qk.modelUsage,
    queryFn: fetchModelUsage,
    refetchInterval: QUALITY_REFETCH_MS,
  });

  if (costError) {
    return (
      <Panel title="Where today's spend went">
        <EmptyState
          variant="inline"
          title="Cost attribution unavailable"
          subtitle="Start a Claude Code session to enable cost attribution."
        />
      </Panel>
    );
  }

  const models = modelData?.byModel
    ? Object.entries(modelData.byModel).filter(([, s]) => s.requestCount > 0)
    : [];
  const modelsTotalCost = models.reduce((sum, [, s]) => sum + s.totalCostUsd, 0);
  const modelRows: ModelShareRow[] = models.map(([model, s]) => ({
    model,
    requestCount: s.requestCount,
    costPerMillionTokens: s.costPerMillionTokens,
    totalCostUsd: s.totalCostUsd,
    sharePct: modelsTotalCost > 0 ? (s.totalCostUsd / modelsTotalCost) * 100 : 0,
  }));

  const tools = costData?.costByToolType
    ? Object.entries(costData.costByToolType).filter(([, e]) => e.totalCost > 0)
    : [];
  const toolsTotalCost = tools.reduce((sum, [, e]) => sum + e.totalCost, 0);
  const toolRows: ToolShareRow[] = tools.map(([tool, e]) => ({
    tool,
    label: shortToolName(tool),
    calls: e.callCount,
    costUsd: e.totalCost,
    sharePct: toolsTotalCost > 0 ? (e.totalCost / toolsTotalCost) * 100 : 0,
  }));

  const skills = costData?.costBySkill ? Object.entries(costData.costBySkill) : [];
  const skillsTotalCost = skills.reduce((sum, [, e]) => sum + e.totalCost, 0);
  const skillRows: SkillShareRow[] = skills.map(([skill, e]) => ({
    skill,
    calls: e.callCount,
    costUsd: e.totalCost,
    sharePct: skillsTotalCost > 0 ? (e.totalCost / skillsTotalCost) * 100 : 0,
  }));

  const attributionRate = costData?.attributionRate ?? 1;
  const lowAttribution = costData != null && attributionRate < 0.5;

  return (
    <Panel
      title="Where today's spend went"
      tooltip="How today's spend breaks down by model, tool, and skill."
      footnote={
        lowAttribution
          ? `Tool and skill shares are based on ${formatPct(attributionRate * 100)} of session cost`
          : undefined
      }
    >
      <div className="grid grid-cols-3 gap-4">
        <div>
          {modelRows.length === 0 ? (
            <>
              <Eyebrow className="mb-1.5">Models</Eyebrow>
              <EmptyState variant="inline" title="No model data yet" />
            </>
          ) : (
            <ShareTable<ModelShareRow>
              title="Models"
              rows={modelRows}
              rowKey={(row) => row.model}
              defaultSort={{ column: 4, direction: 'desc' }}
              columns={[
                {
                  header: 'Model',
                  align: 'left',
                  className: 'font-mono truncate max-w-[12rem]',
                  title: (row) => row.model,
                  cell: (row) => row.model,
                },
                {
                  header: 'Req',
                  align: 'right',
                  cell: (row) => row.requestCount,
                  sortValue: (row) => row.requestCount,
                },
                {
                  header: '$/1M tok',
                  align: 'right',
                  cell: (row) => formatUsdOrDash(row.costPerMillionTokens),
                  sortValue: (row) => row.costPerMillionTokens ?? 0,
                },
                {
                  header: 'Cost',
                  align: 'right',
                  cell: (row) => formatUsd(row.totalCostUsd),
                  sortValue: (row) => row.totalCostUsd,
                },
                {
                  header: 'Share',
                  align: 'right',
                  cell: (row) => formatPct(row.sharePct),
                  sortValue: (row) => row.sharePct,
                },
              ]}
            />
          )}
        </div>
        <div>
          {toolRows.length === 0 ? (
            <>
              <Eyebrow className="mb-1.5">Tools</Eyebrow>
              <EmptyState variant="inline" title="No tool data yet" />
            </>
          ) : (
            <ShareTable<ToolShareRow>
              title="Tools"
              rows={toolRows}
              rowKey={(row) => row.tool}
              defaultSort={{ column: 3, direction: 'desc' }}
              columns={[
                { header: 'Tool', align: 'left', cell: (row) => row.label },
                {
                  header: 'Calls',
                  align: 'right',
                  cell: (row) => row.calls,
                  sortValue: (row) => row.calls,
                },
                {
                  header: 'Cost',
                  align: 'right',
                  cell: (row) => formatUsd(row.costUsd),
                  sortValue: (row) => row.costUsd,
                },
                {
                  header: 'Share',
                  align: 'right',
                  cell: (row) => formatPct(row.sharePct),
                  sortValue: (row) => row.sharePct,
                },
              ]}
            />
          )}
        </div>
        <div>
          {skillRows.length === 0 ? (
            <>
              <Eyebrow className="mb-1.5">Skills</Eyebrow>
              <EmptyState variant="inline" title="No skill data yet" />
            </>
          ) : (
            <ShareTable<SkillShareRow>
              title="Skills"
              rows={skillRows}
              rowKey={(row) => row.skill}
              defaultSort={{ column: 3, direction: 'desc' }}
              columns={[
                { header: 'Skill', align: 'left', cell: (row) => row.skill },
                {
                  header: 'Calls',
                  align: 'right',
                  cell: (row) => row.calls,
                  sortValue: (row) => row.calls,
                },
                {
                  header: 'Cost',
                  align: 'right',
                  cell: (row) => formatUsd(row.costUsd),
                  sortValue: (row) => row.costUsd,
                },
                {
                  header: 'Share',
                  align: 'right',
                  cell: (row) => formatPct(row.sharePct),
                  sortValue: (row) => row.sharePct,
                },
              ]}
            />
          )}
        </div>
      </div>
    </Panel>
  );
}

// --- Health grid cards ---

function CacheHealthCard({
  aggregate,
}: {
  aggregate: TodayAggregateResponse | undefined;
}): JSX.Element {
  const { data: trendData } = useQuery<CacheHealthResponse>({
    queryKey: qk.cacheHealth,
    queryFn: fetchCacheHealth,
    refetchInterval: QUALITY_REFETCH_MS,
  });

  const data = aggregate?.cacheHealth;
  const noActivity = !data || data.status === 'no_cache_activity' || data.cacheHitRatePct == null;
  const tooltip =
    'Prompt cache hit rate today, with a suggestion for improving it — usually by moving stable context earlier in the prompt.';

  if (noActivity) {
    return (
      <HealthCard
        title="Cache Health"
        tooltip={tooltip}
        value="—"
        status={{ tone: 'neutral', label: 'no data' }}
        detail="Appears once token usage with cache reads is reported."
      />
    );
  }

  const tone: HealthTone =
    data.status === 'excellent' ? 'good' : data.status === 'can_improve' ? 'warn' : 'bad';
  const statusLabel = data.status === 'excellent' ? 'excellent' : data.status.replace('_', ' ');

  const rows: HealthCardRow[] = [
    { label: 'Cache read', value: formatTokensCompact(data.totalCacheReadTokens) },
    { label: 'Cache write', value: formatTokensCompact(data.totalCacheCreationTokens) },
  ];
  if (trendData?.week_over_week_delta_pts != null && trendData.week_over_week_delta_pts !== 0) {
    const delta = trendData.week_over_week_delta_pts;
    rows.push({ label: 'vs last week', value: `${delta > 0 ? '+' : ''}${delta}pts` });
  }

  return (
    <HealthCard
      title="Cache Health"
      tooltip={tooltip}
      value={formatPct(data.cacheHitRatePct)}
      status={{ tone, label: statusLabel }}
      detail={`${formatUsd(data.totalSavingsUsd)} saved today`}
      rows={rows}
    />
  );
}

function ToolSelectionCard(): JSX.Element {
  const { data } = useQuery<ToolSelectionMetrics>({
    queryKey: qk.toolSelectionScore,
    queryFn: fetchToolSelectionScore,
    refetchInterval: QUALITY_REFETCH_MS,
  });
  const tooltip =
    "Scores how efficiently tools were chosen today: penalizes re-reading a file without editing it, retrying a failing call, or fetching output that's never used.";

  if (!data || Array.isArray(data) || data.totalCalls === 0) {
    return (
      <HealthCard
        title="Tool Selection"
        tooltip={tooltip}
        value="—"
        status={{ tone: 'neutral', label: 'no data' }}
        detail="Waiting for tool calls."
      />
    );
  }

  const tone: HealthTone = data.score >= 0.9 ? 'good' : data.score >= 0.7 ? 'warn' : 'bad';
  const statusLabel = tone === 'good' ? 'good' : tone === 'warn' ? 'fair' : 'poor';

  return (
    <HealthCard
      title="Tool Selection"
      tooltip={tooltip}
      value={formatPct(data.score * 100)}
      status={{ tone, label: statusLabel }}
      detail={`${data.penalizedCalls} of ${data.totalCalls} calls penalized`}
      rows={[
        { label: 'Re-reads', value: String(data.redundantReadCount) },
        { label: 'Repeat fails', value: String(data.repeatedFailureCount) },
        { label: 'Unused output', value: String(data.unusedOutputCount) },
      ]}
    />
  );
}

function QualityCard(): JSX.Element {
  const { data } = useQuery<QualityProxyMetrics>({
    queryKey: qk.qualityProxy,
    queryFn: fetchQualityProxy,
    refetchInterval: QUALITY_REFETCH_MS,
  });
  const tooltip =
    "Diff apply rate and test pass rate across today's sessions, plus how often you backtracked or self-corrected. Watch for the degrading status if quality drops mid-session.";

  if (!data || data.totalSignals === 0) {
    return (
      <HealthCard
        title="Quality"
        tooltip={tooltip}
        value="—"
        status={{ tone: 'neutral', label: 'no data' }}
        detail="Waiting for edits and test runs."
      />
    );
  }

  const tone: HealthTone = data.degradationDetected ? 'bad' : 'good';

  return (
    <HealthCard
      title="Quality"
      tooltip={tooltip}
      value={data.diffApplyRate !== null ? formatPct(data.diffApplyRate * 100) : '—'}
      status={{ tone, label: data.degradationDetected ? 'degrading' : 'stable' }}
      rows={[
        {
          label: 'Test pass',
          value: data.testPassRate !== null ? formatPct(data.testPassRate * 100) : '—',
        },
        { label: 'Backtracks', value: String(data.backtrackCount) },
        { label: 'Self-corrections', value: String(data.selfCorrectionCount) },
      ]}
    />
  );
}

function ComputeWasteCard({ liveSessions }: { liveSessions: LiveSessionEntry[] }): JSX.Element {
  const { data, isPending } = useQuery<ComputeWasteApiResponse>({
    queryKey: qk.computeWaste,
    queryFn: fetchComputeWaste as () => Promise<ComputeWasteApiResponse>,
    retry: false,
  });
  const tooltip =
    'Tokens wasted today on retried tool calls and anti-pattern activity (stuck loops, redundant reads, thrashing).';

  if (isPending || !data || typeof data.total_tokens_wasted !== 'number') {
    return (
      <HealthCard
        title="Compute Waste"
        tooltip={tooltip}
        value="—"
        status={{ tone: 'neutral', label: 'no data' }}
        detail="No compute waste data yet."
      />
    );
  }

  const tone: HealthTone =
    data.status === 'clean' ? 'good' : data.status === 'moderate' ? 'warn' : 'bad';
  const statusLabel =
    data.status === 'clean' ? 'clean' : data.status === 'moderate' ? 'moderate' : 'needs attention';
  const topSession = data.by_session?.[0] ?? null;
  const topOffender = data.breakdown[0] ?? null;

  const rows: HealthCardRow[] = [
    { label: 'Retry', value: `~${formatTokensCompact(data.retry_tokens_wasted)}` },
    { label: 'Anti-pattern', value: `~${formatTokensCompact(data.anti_pattern_tokens_wasted)}` },
  ];
  if (topSession !== null) {
    rows.push({
      label: 'Top session',
      value: `${sessionPillLabel(topSession.session_id, liveSessions)} (~${formatTokensCompact(topSession.tokens_wasted)})`,
    });
  }

  return (
    <HealthCard
      title="Compute Waste"
      tooltip={tooltip}
      value={`~${formatTokensCompact(data.total_tokens_wasted)} tokens`}
      status={{ tone, label: statusLabel }}
      detail={computeWasteRecommendationText(data.status, topOffender?.type ?? null)}
      rows={rows}
    />
  );
}

function LatencyCard({
  aggregate,
}: {
  aggregate: TodayAggregateResponse | undefined;
}): JSX.Element {
  const data = aggregate?.latency;
  const tooltip =
    'How long tool calls took today — p50/p95/p99 across all calls, plus the slowest tools by p95.';

  if (!data || !data.overall) {
    return (
      <HealthCard
        title="Latency"
        tooltip={tooltip}
        value="—"
        status={{ tone: 'neutral', label: 'no data' }}
        detail="Waiting for tool calls."
      />
    );
  }

  // Guard `data.byTool` separately — the API can return `data` with `byTool`
  // missing (or `null`) when no tool calls have been recorded yet, and
  // `Object.entries(undefined)` throws.
  const topTools = data.byTool
    ? Object.entries(data.byTool)
        .filter(
          (entry): entry is [string, LatencyPercentiles] => entry[1] !== null && entry[1].count > 0,
        )
        .sort((a, b) => b[1].p95 - a[1].p95)
        .slice(0, 2)
    : [];

  const rows: HealthCardRow[] = [
    { label: 'p50', value: formatMs(data.overall.p50) },
    { label: 'p99', value: formatMs(data.overall.p99) },
    ...topTools.map(([tool, p]) => ({ label: shortToolName(tool), value: formatMs(p.p95) })),
  ];

  return (
    <HealthCard title="Latency" tooltip={tooltip} value={formatMs(data.overall.p95)} rows={rows} />
  );
}

function ApiFailuresCard(): JSX.Element {
  const { data } = useQuery<ApiFailureMetrics>({
    queryKey: qk.apiFailures,
    queryFn: fetchApiFailures,
    refetchInterval: QUALITY_REFETCH_MS,
  });
  const tooltip =
    "Turns that failed outright after Claude Code's own retries were exhausted, captured via its StopFailure hook.";

  const errorTypeEntries = data?.byErrorType
    ? Object.entries(data.byErrorType).filter(([, count]) => count > 0)
    : [];
  const count = data?.totalFailures ?? 0;
  const tone: HealthTone = count === 0 ? 'good' : 'bad';

  return (
    <HealthCard
      title="API Failures"
      tooltip={tooltip}
      value={String(count)}
      status={{ tone, label: count === 0 ? 'none' : 'failing' }}
      detail="Reflects Claude Code's StopFailure hook"
      rows={
        errorTypeEntries.length > 0
          ? errorTypeEntries.map(([type, c]) => ({ label: type, value: String(c) }))
          : undefined
      }
    />
  );
}

// --- Activity Today Panel ---

/**
 * Re-buckets a raw timestamped series into 24 hourly buckets (0..23) for
 * the local day containing `nowMs`. Lets Spend by hour (already hourly),
 * Tool calls (15-minute heatmap buckets) and Concurrent sessions (its own
 * bucket size) share one granularity so their charts scale identically.
 * Points outside the local day are dropped. `mode: 'max'` is for gauges
 * like concurrency, where summing sub-hour samples would double-count;
 * `'sum'` (the default) is for counts and costs.
 */
export function bucketByHour(
  points: ReadonlyArray<{ ts: number; value: number }>,
  nowMs: number,
  mode: 'sum' | 'max' = 'sum',
): number[] {
  const dayStart = localStartOfDay(nowMs);
  const dayEnd = dayStart + 86_400_000;
  const buckets = new Array<number>(24).fill(0);
  for (const { ts, value } of points) {
    if (ts < dayStart || ts >= dayEnd) continue;
    const hour = Math.min(23, Math.floor((ts - dayStart) / 3_600_000));
    buckets[hour] = mode === 'max' ? Math.max(buckets[hour]!, value) : buckets[hour]! + value;
  }
  return buckets;
}

// "10:00" — zero-padded 24-hour label for an hour index, the shared
// tooltip convention for all three Activity-today charts.
function hourOfDayLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

// "Peak 10:00 — 38 calls" / "No calls recorded yet." for an already
// hourly-bucketed count series.
function hourlyCountsCaption(counts: readonly number[], unit: string): string {
  const max = Math.max(0, ...counts);
  if (max === 0) return `No ${unit} recorded yet.`;
  const peakHour = counts.indexOf(max);
  return `Peak ${hourOfDayLabel(peakHour)} — ${max} ${unit}`;
}

function hourlySpendCaption(hours: readonly HourlyCostEntry[]): string {
  const max = hours.reduce((m, h) => Math.max(m, h.cost), 0);
  const peak = hours.find((h) => h.cost === max);
  if (!peak || max === 0) return 'No spend yet today.';
  return `Peak ${formatUsd(max)} at ${formatHourLabel(peak.hour)}`;
}

function ActivityTodayPanel({
  hourlySpend,
  todayHeatmap,
  concurrency,
}: {
  hourlySpend: readonly HourlyCostEntry[];
  todayHeatmap: ActivityHeatmapTodayResponse | undefined;
  concurrency: ConcurrencyData | undefined;
}): JSX.Element {
  const now = Date.now();
  const hasHourlySpend = hourlySpend.some((h) => h.cost > 0);
  const hasHeatmapData = (todayHeatmap?.buckets?.length ?? 0) > 0;
  const hasConcurrencyData = (concurrency?.buckets?.length ?? 0) > 0;

  const spendItems = hourlySpendToBlockItems(hourlySpend);

  const heatmapHourly = hasHeatmapData
    ? bucketByHour(
        todayHeatmap!.buckets.map((count, index) => ({
          ts: todayHeatmap!.startTimestamp + index * todayHeatmap!.bucketSizeMs,
          value: count,
        })),
        now,
      )
    : [];
  const heatmapItems: DiscreteBlockChartItem[] = heatmapHourly.map((count, hour) => ({
    count,
    tooltip: `${hourOfDayLabel(hour)} — ${count} calls`,
  }));

  const concurrencyHourly = hasConcurrencyData
    ? bucketByHour(
        concurrency!.buckets.map((b) => ({ ts: b.timestamp, value: b.count })),
        now,
        'max',
      )
    : [];
  const concurrencyItems: DiscreteBlockChartItem[] = concurrencyHourly.map((count, hour) => ({
    count,
    tooltip: `${hourOfDayLabel(hour)} — ${count} concurrent`,
  }));

  return (
    <Panel title="Activity today">
      <div className="grid grid-cols-3 gap-4">
        <div>
          <Eyebrow className="mb-1.5">Spend by hour</Eyebrow>
          <div className="h-[72px] flex items-end">
            {hasHourlySpend ? (
              <DiscreteBlockChart
                data={spendItems}
                levels={6}
                ariaLabel={describeHourlySpend(hourlySpend)}
              />
            ) : (
              <EmptyState variant="inline" title="No spend data yet" />
            )}
          </div>
          <p className="mt-1.5 text-[10px] text-ink-muted">{hourlySpendCaption(hourlySpend)}</p>
        </div>
        <div>
          <Eyebrow className="mb-1.5">Tool calls</Eyebrow>
          <div className="h-[72px] flex items-end">
            {hasHeatmapData ? (
              <DiscreteBlockChart
                data={heatmapItems}
                levels={6}
                ariaLabel="Today's activity density by hour"
              />
            ) : (
              <EmptyState variant="inline" title="No heatmap data yet" />
            )}
          </div>
          <p className="mt-1.5 text-[10px] text-ink-muted">
            {hourlyCountsCaption(heatmapHourly, 'calls')}
          </p>
        </div>
        <div>
          <Eyebrow className="mb-1.5">Concurrent sessions</Eyebrow>
          <div className="h-[72px] flex items-end">
            {hasConcurrencyData ? (
              <DiscreteBlockChart
                data={concurrencyItems}
                levels={6}
                ariaLabel={`Concurrency over time, peak ${concurrency?.peak ?? 0}`}
              />
            ) : (
              <EmptyState variant="inline" title="No session data yet" />
            )}
          </div>
          <p className="mt-1.5 text-[10px] text-ink-muted">
            now {concurrency?.current ?? 0} · peak {concurrency?.peak ?? 0}
          </p>
        </div>
      </div>
    </Panel>
  );
}

// --- Live Session Pane ---

interface ReplayTimelineEntry {
  readonly timestamp: number;
  readonly toolName: string;
  readonly durationMs: number | null;
  readonly success: boolean;
  readonly filePath?: string;
  readonly command?: string;
  readonly agentId?: string;
}

interface ReplaySegment {
  readonly type: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly severity: 'warning' | 'critical';
  readonly agentId?: string;
  readonly agentScoped?: boolean;
}

interface ReplayData {
  readonly sessionId: string;
  readonly timeline: ReplayTimelineEntry[];
  readonly segments?: ReplaySegment[];
}

const LIVE_TAIL_REFETCH_MS = 3_000;

function LiveSessionPane({
  sessions,
  liveSessions,
}: {
  sessions: SessionSummary[];
  liveSessions: LiveSessionEntry[];
}): JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // In-place workflow-run drawer (same pattern as the Sessions view) — opening
  // a run from the trace overlays the detail rather than navigating away.
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  // Decision-tree + turn-cost detail drawer — kept out of the fixed-height
  // trace pane itself so a busy session's failure/turn count never eats into
  // the trace's available vertical space.
  const [showDetail, setShowDetail] = useState(false);
  const [, navigate] = useLocation();
  const setActiveSession = useLiveStore((s) => s.setActiveSession);

  // Live-session ids from /api/sessions/live (already sorted
  // most-recently-active first by the server). Falls back to /api/session/
  // current's `liveSessions` array during the loading window so the pane
  // populates immediately on first paint instead of waiting an interval.
  const { data: current } = useQuery<{ sessionId: string; liveSessions?: string[] }>({
    queryKey: qk.sessionCurrent,
    queryFn: fetchSessionCurrent,
  });

  const liveSessionIds = useMemo(() => {
    const set = new Set<string>();
    for (const ls of liveSessions) set.add(ls.sessionId);
    if (set.size === 0) {
      // Fall back to the legacy session/current array while the live query
      // is still loading on first mount.
      if (current?.liveSessions?.length) {
        for (const id of current.liveSessions) set.add(id);
      } else if (current?.sessionId) {
        set.add(current.sessionId);
      }
    }
    return set;
  }, [liveSessions, current]);

  // Most-recently-active live session — sorted server-side. Falls back to the
  // first id in the liveSessionIds set when the API didn't supply ordering
  // (e.g. during the legacy fallback path).
  const mostRecentlyActiveId = liveSessions.length > 0 ? liveSessions[0]!.sessionId : null;
  const firstLiveId =
    mostRecentlyActiveId ?? (liveSessionIds.size > 0 ? [...liveSessionIds][0]! : null);
  const activeId = selectedId ?? firstLiveId;
  const isLive = activeId !== null && liveSessionIds.has(activeId);
  // "Session ended" badge — true when the user explicitly
  // selected a session that was previously live but is no longer in the live
  // set (e.g. the owning Claude Code window closed). We deliberately don't
  // auto-switch to a different session: that's jarring, and the user might be
  // mid-investigation. Instead we pin the selection and surface a badge.
  const sessionEnded = selectedId !== null && !liveSessionIds.has(selectedId);

  // Keep the global liveStore in sync with the local selector
  // so the rest of the dashboard (and any per-session caches) re-key when
  // the user switches. Empty deps + activeId in array — fires only on change.
  useEffect(() => {
    setActiveSession(activeId);
  }, [activeId, setActiveSession]);

  const { data: replay } = useQuery<ReplayData>({
    queryKey: activeId ? qk.sessionReplay(activeId) : ['replay', 'none'],
    queryFn: () => fetchSessionReplay(activeId!),
    enabled: activeId !== null,
    retry: false,
    refetchInterval: isLive ? LIVE_TAIL_REFETCH_MS : false,
  });

  // Subagent fan-out for the active session — same source as the Sessions view's
  // trace. Tolerates a malformed/array payload (no agents) so the live tail
  // still renders the parent lane.
  const { data: subagentData } = useQuery<SessionSubagentsResponse>({
    queryKey: activeId ? qk.sessionSubagents(activeId) : ['subagents', 'none'],
    queryFn: () => fetchSessionSubagents(activeId!),
    enabled: activeId !== null,
    retry: false,
    refetchInterval: isLive ? LIVE_TAIL_REFETCH_MS : false,
  });

  // Workflow runs → status lookup for the trace's per-group status icons.
  const { data: workflowsData } = useQuery({
    queryKey: qk.workflows,
    queryFn: fetchWorkflows,
    refetchInterval: isLive ? 10_000 : false,
  });

  // Decision-tree + per-turn cost detail — both trackers are live,
  // in-memory, process-scoped accumulators (no persistence), but are
  // filtered server-side to the selected session by passing
  // `activeId` through as `?sessionId=`, so the session-detail drawer below
  // always reflects the session actually selected in the trace pane above
  // it, not just whichever session this process last recorded.
  const { data: turnCosts } = useQuery<TurnCostsResponse>({
    queryKey: activeId ? ['turn-costs', activeId] : ['turn-costs'],
    queryFn: () => fetchTurnCosts(activeId ?? undefined),
    refetchInterval: 10_000,
  });
  const { data: decisionTree } = useQuery<DecisionTreeResponse>({
    queryKey: activeId ? ['decision-tree', activeId] : ['decision-tree'],
    queryFn: () => fetchDecisionTree(activeId ?? undefined),
    refetchInterval: 10_000,
  });
  // Mirrors ContextBar's own internal query for the same sessionId — using
  // the identical key (`['context', activeId]`) means TanStack Query dedupes
  // this to a single network request/shared cache entry, not a second fetch.
  const { data: contextData } = useQuery<ContextResponse>({
    queryKey: activeId ? ['context', activeId] : qk.context,
    queryFn: () => fetchContext(activeId ?? undefined),
    refetchInterval: 10_000,
    enabled: isLive && Boolean(activeId),
  });
  // Unlike turnCosts/decisionTree above, ContextCompositionTracker and
  // ContextWindowTracker (behind /api/context-efficiency) have no
  // per-session partitioning (only DecisionTracker/TurnCostAttributor are
  // partitioned) — these two remain live, in-memory,
  // current-process-only accumulators. SessionDetailDialog's header caveat
  // discloses this so the dialog doesn't imply these two sections are also
  // scoped to the selected session.
  const { data: contextComposition } = useQuery<ContextCompositionResponse>({
    queryKey: ['context-composition'],
    queryFn: fetchContextComposition,
    refetchInterval: 10_000,
  });
  const { data: contextEfficiency } = useQuery<ContextEfficiencyResponse>({
    queryKey: ['context-efficiency'],
    queryFn: fetchContextEfficiency,
    refetchInterval: 10_000,
  });

  const tailRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isLive && tailRef.current) {
      tailRef.current.scrollTop = tailRef.current.scrollHeight;
    }
  }, [replay?.timeline.length, isLive]);

  // Filter to sessions that count as "today", then merge in any live
  // sessions that haven't yet persisted to disk so the selector shows them
  // immediately (sort order is applied below, by last activity). A session
  // counts as "today" if it started today
  // OR is currently live OR had recent activity today (last activity within
  // RECENT_ACTIVITY_MS of now AND falling on today's calendar date).
  //
  // The recent-activity window matters because lastActivity = startTime +
  // durationMs naively: a session that started yesterday at 23:55 with
  // durationMs=10min has lastActivity=00:05 today and would be classified
  // "active today" — but the work was almost entirely yesterday. On a
  // busy day with 11+ today-started sessions, the slice(0, 10) below would
  // silently drop a real today-started session in favor of this stale entry.
  // Live sessions are always included regardless of the window — the
  // registry already enforces a 3-min staleness threshold upstream.
  // Limit to 10.
  const todaySessions = useMemo(() => {
    const RECENT_ACTIVITY_MS = 6 * 60 * 60 * 1000; // 6 hours
    const recentCutoff = Date.now() - RECENT_ACTIVITY_MS;
    const liveById = new Map<string, LiveSessionEntry>();
    for (const ls of liveSessions) liveById.set(ls.sessionId, ls);

    const byId = new Map<string, SessionSummary>();
    for (const s of sessions) {
      // Skip malformed entries — defensive against `[]`-style fixtures and
      // fetch mocks that may not include sessionId on every record.
      if (!s.sessionId) continue;
      const startedToday = s.startTime != null && isToday(s.startTime);
      const isLiveNow = liveById.has(s.sessionId);
      const lastActivity =
        s.startTime != null && s.durationMs != null ? s.startTime + s.durationMs : null;
      const recentlyActive =
        lastActivity != null && lastActivity >= recentCutoff && isToday(lastActivity);
      if (startedToday || isLiveNow || recentlyActive) byId.set(s.sessionId, s);
    }
    for (const ls of liveSessions) {
      if (!ls.sessionId) continue;
      if (!byId.has(ls.sessionId)) {
        byId.set(ls.sessionId, {
          sessionId: ls.sessionId,
          sessionName: ls.sessionName,
          startTime: ls.startTime,
          toolCallCount: 0,
          estimatedCostUsd: null,
        });
      }
    }
    // Sort by last activity so a long-running session whose start time has
    // dropped out of the top-N still surfaces while it's actively in use.
    // For live sessions the live registry's `lastActivity` is authoritative
    // (fresh per touch); for persisted ones fall back to `startTime +
    // durationMs`, then `startTime`.
    const lastActivityFor = (s: SessionSummary): number => {
      const live = liveById.get(s.sessionId);
      if (live) return live.lastActivity;
      if (s.startTime != null && s.durationMs != null) return s.startTime + s.durationMs;
      return s.startTime ?? 0;
    };
    return [...byId.values()].sort((a, b) => lastActivityFor(b) - lastActivityFor(a)).slice(0, 10);
  }, [sessions, liveSessions]);

  const timeline = useMemo<ReplayTimelineEntry[]>(() => replay?.timeline ?? [], [replay]);

  // Subagents for the active session (defensive against an empty/array payload).
  const traceAgents = useMemo<AgentSpan[]>(
    () => (Array.isArray(subagentData?.agents) ? subagentData!.agents : []),
    [subagentData],
  );

  // Shared window spanning the parent timeline + the subagent fan-out so the
  // SessionTrace parent lane and subagent lanes share one x-scale.
  const traceWindow = useMemo<{ startMs: number; endMs: number }>(() => {
    let startMs: number | null = null;
    let endMs: number | null = null;
    for (const e of timeline) {
      const end = e.timestamp + (e.durationMs ?? 50);
      if (startMs === null || e.timestamp < startMs) startMs = e.timestamp;
      if (endMs === null || end > endMs) endMs = end;
    }
    // Guard against the `{ startMs: 0, endMs: 0 }` sentinel returned when a
    // session has no subagent transcripts (Number.isFinite(0) is true, so a
    // naive finiteness check let the sentinel drag startMs down to epoch 0).
    // Mirrors the hasAgents guard in Sessions.tsx's SessionTraceSection.
    const hasAgents = (subagentData?.agents?.length ?? 0) > 0;
    const sub = hasAgents ? subagentData!.window : null;
    if (sub) {
      startMs = startMs === null ? sub.startMs : Math.min(startMs, sub.startMs);
      endMs = endMs === null ? sub.endMs : Math.max(endMs, sub.endMs);
    }
    if (startMs === null || endMs === null) return { startMs: 0, endMs: 1 };
    return { startMs, endMs: endMs > startMs ? endMs : startMs + 1 };
  }, [timeline, subagentData]);

  // runId → status for the trace's per-group status icons (this session only).
  const runStatusById = useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    if (Array.isArray(workflowsData)) {
      for (const run of workflowsData as ReadonlyArray<{
        runId?: string;
        parentSessionId?: string | null;
        status?: string;
      }>) {
        if (
          run &&
          typeof run.runId === 'string' &&
          typeof run.status === 'string' &&
          run.parentSessionId === activeId
        ) {
          map[run.runId] = run.status;
        }
      }
    }
    return map;
  }, [workflowsData, activeId]);

  return (
    <>
      <div
        className="glass-card mb-3 grid grid-cols-[220px_1fr] overflow-hidden"
        style={{ height: '320px' }}
      >
        {/* Session list */}
        <div className="border-r border-border-subtle flex flex-col overflow-hidden">
          <div className="flex items-center justify-between gap-1.5 p-2 border-b border-border-subtle shrink-0">
            <Eyebrow>Session Live Tail</Eyebrow>
            <InfoTooltip text="Today's sessions on the left; select one to stream its live tool-call trace on the right." />
          </div>
          <div className="overflow-auto flex-1">
            {todaySessions.map((s) => {
              const isSessionLive = liveSessionIds.has(s.sessionId);
              return (
                <button
                  key={s.sessionId}
                  type="button"
                  onClick={() => setSelectedId(s.sessionId)}
                  className={
                    'block w-full text-left p-2 border-b border-border-subtle text-xs transition-colors duration-150 hover:bg-surface-5 ' +
                    (activeId === s.sessionId ? 'bg-surface-5' : '')
                  }
                >
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-ink-base">
                      {s.sessionName || s.sessionId.slice(0, 8)}
                    </span>
                    {isSessionLive ? (
                      <LiveBadge label="live" size="sm" />
                    ) : (
                      <span
                        className="text-[10px] text-ink-muted"
                        title={s.startTime ? `Started ${fmtTimeOfDay(s.startTime)}` : undefined}
                      >
                        {s.startTime ? fmtTimeOfDay(s.startTime + (s.durationMs ?? 0)) : ''}
                      </span>
                    )}
                  </div>
                  <div className="flex gap-2 mt-0.5 text-[10px] text-ink-subtle">
                    <span>{s.toolCallCount ?? 0} calls</span>
                    {s.estimatedCostUsd != null && s.estimatedCostUsd > 0 ? (
                      <span>{formatUsd(s.estimatedCostUsd)}</span>
                    ) : (
                      <span>—</span>
                    )}
                  </div>
                </button>
              );
            })}
            {liveSessionIds.size === 0 && todaySessions.length === 0 && (
              <EmptyState
                icon="code"
                title="No sessions today"
                subtitle="Start coding with Claude to see sessions here."
              />
            )}
          </div>
        </div>

        {/* Live tail */}
        <div className="flex flex-col overflow-hidden">
          {activeId && (
            <div className="flex items-center justify-between px-2 py-1 border-b border-border-subtle shrink-0">
              <Eyebrow>Trace</Eyebrow>
              <div className="flex items-center gap-2">
                {/* "Session ended" badge — pinned to the selected
                  session even after it leaves the live set, so the user can
                  finish reviewing without an auto-switch. */}
                {sessionEnded && (
                  <span data-testid="session-ended-badge">
                    <Pill tone="neutral" size="sm" uppercase>
                      Session ended
                    </Pill>
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => navigate(`/sessions?id=${activeId}`)}
                  className="text-[10px] text-accent-cyan hover:underline transition-colors duration-150"
                >
                  full session &rarr;
                </button>
              </div>
            </div>
          )}
          <div ref={tailRef} className="overflow-auto flex-1 p-2">
            {!activeId && (
              <div className="text-ink-muted text-xs p-2">
                Select a session to view its timeline.
              </div>
            )}
            {activeId && timeline.length === 0 && traceAgents.length === 0 && (
              <EmptyState
                icon="timeline"
                title={isLive ? 'Waiting for tool calls' : 'No tool calls'}
                subtitle={
                  isLive
                    ? 'Tool calls will appear here in real time.'
                    : 'This session has no recorded tool calls.'
                }
              />
            )}
            {activeId && (timeline.length > 0 || traceAgents.length > 0) && (
              <SessionTrace
                key={activeId}
                sessionId={activeId}
                parentEntries={timeline}
                agents={traceAgents}
                window={traceWindow}
                runStatusById={runStatusById}
                parentSegments={replay?.segments ?? []}
                onSelectRun={(runId) => setOpenRunId(runId)}
              />
            )}
          </div>
          {/* Per-session ContextBar — pinned to the bottom of the tail so it
            shows for both Gantt and List view modes. Hidden when no session
            is selected or the selected session has ended (the context
            numbers would be stale and the SSE feed won't be updating). */}
          {isLive && activeId && (
            <div className="border-t border-bg-line px-3 py-2 shrink-0">
              <ContextBar sessionId={activeId} expandable={false} />
            </div>
          )}
          {/* `turnCosts?.turns?.length` (not `turnCosts && turnCosts.turns.length`)
            because unrelated tests' default fetch mocks resolve every
            unmatched endpoint (including this one) to `[]`, which has no
            `.turns` field — the plain-object shape only holds under the
            dedicated /api/turn-costs mock. */}
          {((decisionTree?.totalBranches ?? 0) > 0 ||
            (turnCosts?.turns?.length ?? 0) > 0 ||
            (contextData?.history?.length ?? 0) >= 2) && (
            <div className="border-t border-bg-line px-3 py-2 shrink-0">
              <button
                type="button"
                onClick={() => setShowDetail(true)}
                className="text-[10px] text-accent-cyan hover:underline transition-colors duration-150 text-left"
              >
                {(() => {
                  const parts: string[] = [];
                  if (decisionTree && decisionTree.totalBranches > 0) {
                    parts.push(`${decisionTree.longestFailureStreak} failure streak`);
                  }
                  if (turnCosts?.turns && turnCosts.turns.length > 0) {
                    parts.push(
                      `${turnCosts.turns.length} turns · ${formatUsd(turnCosts.totalAttributedCost)}`,
                    );
                  }
                  return parts.length > 0
                    ? `${parts.join(' · ')} — session detail →`
                    : 'session detail →';
                })()}
              </button>
            </div>
          )}
        </div>
      </div>
      {openRunId != null && (
        <WorkflowRunDetail runId={openRunId} onClose={() => setOpenRunId(null)} />
      )}
      {showDetail && (
        <SessionDetailDialog
          decisionTree={decisionTree}
          turnCosts={turnCosts}
          contextHistory={contextData?.history}
          contextWindow={contextData?.contextWindow}
          contextComposition={contextComposition}
          contextEfficiency={contextEfficiency}
          onClose={() => setShowDetail(false)}
        />
      )}
    </>
  );
}

// Label resolver for the compute-waste "top session" row. Falls back to the
// truncated session id when no friendly name is known yet — sessionName is
// only set after the live registry has seen a `cwd` from the first hook
// event.
function sessionPillLabel(sessionId: string, liveSessions: LiveSessionEntry[]): string {
  const match = liveSessions.find((ls) => ls.sessionId === sessionId);
  if (match?.sessionName) return match.sessionName;
  return sessionId.slice(0, 8);
}

// `isToday` is now `isSameLocalDay` from `src/lib/date.ts` — shared with the
// dashboard server so both surfaces draw the day boundary at the same moment.

const isToday = (ts: number): boolean => isSameLocalDay(ts);

/**
 * What fraction of a session's [startTime, end) window falls within today's
 * local day, for the more limited fields the dashboard list endpoint exposes
 * (no timeline — just startTime/endTime/durationMs). Delegates to the
 * shared `todayPortionRatio` (src/lib/date.ts) so this client-side estimate
 * uses the exact same elapsed-time-overlap math as the server's
 * `todayPortionOfSessionCost`, instead of reimplementing it here.
 *
 * Used to prorate every "how much of this session counts toward today"
 * metric consistently — cost, tool calls, and anti-pattern flags — so a
 * cross-midnight session contributes its today-portion everywhere, not just
 * for cost. Without this, `computeTodayToolCalls`/`computeTodayFlags` would
 * add a cross-midnight session's *entire lifetime* count once
 * `todayPortionOfSession(s) > 0`, rather than prorating the count itself.
 */
function todayOverlapRatio(s: SessionSummary): number {
  if (s.startTime == null) return 0;
  const end =
    typeof s.endTime === 'number'
      ? s.endTime
      : typeof s.durationMs === 'number'
        ? s.startTime + s.durationMs
        : Date.now(); // live session with no end info: assume still running
  return todayPortionRatio({ startTime: s.startTime, endTime: end });
}

/**
 * Today-portion of a session's cost. Mirrors the server-side
 * todayPortionOfSessionCost helper but with the more limited fields the
 * dashboard list endpoint exposes (no timeline). For sessions straddling
 * midnight, pro-rates by elapsed-time overlap with today's local day.
 *
 * Without this, "Spend Today" double-counts a session that started yesterday
 * but is still running — its full cost gets attributed to today.
 */
function todayPortionOfSession(s: SessionSummary): number {
  const cost = s.estimatedCostUsd;
  if (cost == null || cost <= 0) return 0;
  return cost * todayOverlapRatio(s);
}

function computeTodaySpend(sessions: SessionSummary[]): number {
  let total = 0;
  for (const s of sessions) total += todayPortionOfSession(s);
  return total;
}

function computeTodayToolCalls(sessions: SessionSummary[]): number {
  let total = 0;
  for (const s of sessions) {
    const ratio = todayOverlapRatio(s);
    if (ratio > 0) total += (s.toolCallCount ?? 0) * ratio;
  }
  return Math.round(total);
}

function computeTodayFlags(sessions: SessionSummary[]): number {
  let total = 0;
  for (const s of sessions) {
    const ratio = todayOverlapRatio(s);
    if (ratio > 0) total += (s.antiPatterns?.length ?? 0) * ratio;
  }
  return Math.round(total);
}

interface HourlyCostEntry {
  readonly hour: number; // 0..23
  readonly cost: number;
}

function formatHourLabel(hour: number): string {
  if (hour === 0) return '12am';
  if (hour < 12) return `${hour}am`;
  if (hour === 12) return '12pm';
  return `${hour - 12}pm`;
}

function describeHourlySpend(hours: readonly HourlyCostEntry[]): string {
  const total = hours.reduce((s, h) => s + h.cost, 0);
  const max = hours.reduce((m, h) => Math.max(m, h.cost), 0);
  const peak = hours.find((h) => h.cost === max);
  if (peak === undefined || max === 0) return 'Hourly spend today: no activity yet.';
  return `Hourly spend today: ${formatUsd(total)} total, peak ${formatUsd(max)} at ${formatHourLabel(peak.hour)}`;
}

function hourlySpendToBlockItems(hours: readonly HourlyCostEntry[]): DiscreteBlockChartItem[] {
  return hours.map((h) => ({
    count: h.cost,
    tooltip: `${hourOfDayLabel(h.hour)} — ${formatUsd(h.cost)}`,
  }));
}

function buildHourlySpend(sessions: SessionSummary[]): HourlyCostEntry[] {
  // The /api/sessions route always injects the live session with its current
  // in-memory cost (when not yet persisted) or returns the persisted entry
  // (when already on disk). Either way the live session is represented once in
  // `sessions`, so no separate currentSessionCost addition is needed — adding
  // it separately caused the live session's cost to be counted twice.
  const buckets = new Array<number>(24).fill(0);
  const dayStart = localStartOfDay();
  const dayEnd = dayStart + 86_400_000;

  for (const s of sessions) {
    if (!s.startTime || s.estimatedCostUsd == null || s.estimatedCostUsd <= 0) continue;
    const start = s.startTime;
    const end =
      typeof s.endTime === 'number'
        ? s.endTime
        : typeof s.durationMs === 'number'
          ? s.startTime + s.durationMs
          : Date.now();

    // Clamp the session's activity window to today's local day — a session
    // that started yesterday and is still running now contributes its
    // today-portion instead of being skipped entirely. A naive `continue`
    // on any session that didn't *start* today would hide the chart even
    // when `todayTotal > 0`.
    const clampedStart = Math.max(start, dayStart);
    const clampedEnd = Math.min(end, dayEnd);
    if (clampedEnd <= clampedStart) continue;

    const totalMs = Math.max(1, end - start);
    const todayShareMs = clampedEnd - clampedStart;
    const todayCost = s.estimatedCostUsd * (todayShareMs / totalMs);

    // Spread todayCost across every hour bucket the clamped window actually
    // touches, weighted by time-in-bucket — instead of dumping the whole
    // amount into the session's start hour, which would make a
    // multi-hour session appear as one artificial spike.
    let cursor = clampedStart;
    while (cursor < clampedEnd) {
      const cursorDate = new Date(cursor);
      const hour = cursorDate.getHours();
      const nextHour = new Date(cursorDate);
      nextHour.setMinutes(0, 0, 0);
      nextHour.setHours(hour + 1);
      const segmentEnd = Math.min(clampedEnd, nextHour.getTime());
      const segmentMs = segmentEnd - cursor;
      buckets[hour]! += todayCost * (segmentMs / todayShareMs);
      cursor = segmentEnd;
    }
  }
  return buckets.map((cost, hour) => ({ hour, cost }));
}

const MS_PER_DAY = 86_400_000;

/** Local midnight of the Monday starting the ISO week containing `nowMs`. */
function isoWeekMonday(nowMs: number): number {
  const todayStart = localStartOfDay(nowMs);
  const weekday = new Date(todayStart).getDay(); // 0 = Sunday .. 6 = Saturday
  const daysSinceMonday = weekday === 0 ? 6 : weekday - 1;
  return todayStart - daysSinceMonday * MS_PER_DAY;
}

/**
 * Projects end-of-week spend from the same basis as the end-of-day forecast:
 * `weekToDateExcludingToday + forecastEod + avgDailySpend * remainingFullDays`.
 *
 * `weekToDateExcludingToday` attributes each persisted session's full cost to
 * its local start day (rather than prorating cross-midnight sessions by
 * overlap, as `todayPortionOfSession` does) and sums the days from this
 * week's Monday up to, but excluding, today — sessions from a previous week
 * are excluded by the Monday floor. `forecastEod` is clamped to at least
 * `todayTotal` first (mirroring ForecastEodCard's own clamp) so the
 * projection never regresses below money already spent today.
 *
 * `avgDailySpend` divides that same numerator by the number of days elapsed
 * so far this week including today, then multiplies by the full days
 * remaining through Sunday — zero on a Sunday, since there are none left.
 * The result is never below the end-of-day figure it's built on.
 */
export function buildWeekForecast(
  sessions: readonly SessionSummary[],
  forecastEod: number,
  todayTotal: number,
  nowMs: number,
): number {
  const effectiveEod = Math.max(forecastEod, todayTotal);
  const todayStart = localStartOfDay(nowMs);
  const weekMonday = isoWeekMonday(nowMs);

  let weekToDateExcludingToday = 0;
  for (const s of sessions) {
    if (s.startTime == null || s.estimatedCostUsd == null || s.estimatedCostUsd <= 0) continue;
    if (s.startTime < weekMonday || s.startTime >= todayStart) continue;
    weekToDateExcludingToday += s.estimatedCostUsd;
  }

  const daysElapsedIncludingToday = Math.round((todayStart - weekMonday) / MS_PER_DAY) + 1;
  const weekday = new Date(todayStart).getDay();
  const remainingFullDays = weekday === 0 ? 0 : 7 - weekday;
  const avgDailySpend =
    (weekToDateExcludingToday + effectiveEod) / Math.max(1, daysElapsedIncludingToday);

  const endOfWeek = weekToDateExcludingToday + effectiveEod + avgDailySpend * remainingFullDays;
  return Math.max(endOfWeek, effectiveEod);
}

const FORECAST_TOOLTIP =
  "Projects today's total spend by midnight, based on the spending trend so far this hour-by-hour.";

function ForecastEodCard({
  todayTotal,
  forecastEod,
  subagentUsd = 0,
  weekForecast,
}: {
  todayTotal: number;
  forecastEod: number | null;
  subagentUsd?: number;
  weekForecast: number | null;
}): JSX.Element {
  const hasForecast = forecastEod !== null && Number.isFinite(forecastEod);

  if (!hasForecast) {
    return (
      <HealthCard
        title="Forecast · End of Day"
        tooltip={FORECAST_TOOLTIP}
        value="—"
        status={{ tone: 'neutral', label: 'no data' }}
        detail="Insufficient data — forecast appears once burn rate stabilizes."
      />
    );
  }

  const effectiveForecast = Math.max(forecastEod, todayTotal);
  const delta = effectiveForecast - todayTotal;
  // The caller passes todayTotal/subagentUsd from the same source whenever
  // possible, so subagentUsd is normally guaranteed <= todayTotal. Clamp to 0
  // defensively anyway (the server clamps its own parentUsd the same way) for
  // the brief window before that shared source has resolved.
  const parentUsd = subagentUsd > 0 ? Math.max(0, todayTotal - subagentUsd) : 0;

  const rows: HealthCardRow[] = [];
  if (subagentUsd > 0) {
    rows.push({ label: 'Parent', value: formatUsd(parentUsd) });
    rows.push({ label: 'Subagent', value: formatUsd(subagentUsd) });
  }
  if (weekForecast !== null) {
    rows.push({ label: 'End of week', value: formatUsd(weekForecast) });
  }

  return (
    <HealthCard
      title="Forecast · End of Day"
      tooltip={FORECAST_TOOLTIP}
      value={formatUsd(effectiveForecast)}
      detail={delta > 0 ? `${formatUsd(delta)} more than now` : 'on pace'}
      rows={rows}
    />
  );
}
