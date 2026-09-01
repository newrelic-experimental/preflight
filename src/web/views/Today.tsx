import { useMemo, useState, useRef, useEffect } from 'react';
import type { JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Cell,
  ResponsiveContainer,
} from 'recharts';
import { useLocation } from 'wouter';
import { useLiveStore, useSubagentStats, type AlertEvent } from '../store/liveStore';
import { Kpi } from '../components/Kpi';
import { AnimatedCard } from '../components/AnimatedCard';
import { HourlyCostBlocks, type HourlyCostEntry } from '../components/HourlyCostBlocks';
import { EmptyState } from '../components/EmptyState';
import { SessionTrace } from '../components/SessionTrace';
import { WorkflowRunDetail } from '../components/WorkflowRunDetail';
import { SessionDetailDialog } from '../components/SessionDetailDialog';
import type { AgentSpan } from '../components/AgentSwimlanes';
import { ConcurrencyIndicator, type ConcurrencyData } from '../components/ConcurrencyIndicator';
import { ActivityHeatmap } from '../components/ActivityHeatmap';
import { GeoBanner } from '../components/GeoBanner';
import { ContextBar } from '../components/ContextBar';
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
  TodayAggregateResponse,
  ActivityHeatmapTodayResponse,
  LiveSessionEntry,
  NotFoundError,
  CacheHealthResponse,
  ObservabilityHealthResponse,
  qk,
  type SessionSubagentsResponse,
} from '../api/client';
import {
  fmtTimeOfDay,
  formatNumber,
  formatUsd,
  formatUsdOrDash,
  rateColor,
  scoreColor,
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
  readonly count?: number;
  readonly file?: string;
  readonly command?: string;
  readonly iterations?: number;
  readonly readCount?: number;
  readonly repeatCount?: number;
  readonly editCount?: number;
  readonly agentCount?: number;
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
    over_delegation: 'Handle more work directly instead of spawning sub-agents.',
  };

  const advice = topPatternType !== null ? (patternAdvice[topPatternType] ?? null) : null;
  return advice ?? 'Review anti-patterns to reduce repeated tool calls.';
}

interface SessionSummary {
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

const CHART_TICK_STYLE = { fill: 'var(--color-ink-muted)', fontSize: 10 };
const CHART_GRID_STROKE = 'var(--color-border-subtle)';
const CHART_TOOLTIP_STYLE = {
  background: 'var(--color-bg-elevated)',
  border: '1px solid var(--color-border-medium)',
  borderRadius: 8,
  fontSize: 12,
  color: 'var(--color-ink-base)',
};

// Mirrors History.tsx's toolFillColor — same tool-name-keyed palette, so a
// tool's color is consistent whether viewed here (by cost) or in the Top
// Tools panel (by call count).
function toolFillColor(toolName: string): string {
  if (toolName === 'Read') return 'var(--color-accent-blue)';
  if (toolName === 'Edit' || toolName === 'Write') return 'var(--color-accent-green)';
  if (toolName === 'Bash') return 'var(--color-accent-purple)';
  if (toolName === 'Agent') return 'var(--color-accent-teal)';
  return 'var(--color-ink-muted)';
}

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

  // Fallback source for the anti-pattern detail banner when neither the live
  // SSE store nor this process's own /api/anti-patterns has anything — the
  // pattern may have been detected by a different process, but its persisted
  // session record (already fetched for the KPI strip) still has it.
  const persistedAntiPatterns = useMemo(
    () => (todaySessions ?? []).flatMap((s) => s.antiPatterns ?? []),
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

  // The subagent KPI must source from the polled aggregate
  // endpoint, not the liveStore — the SSE frames that would populate
  // useSubagentStats are never emitted server-side, so subagentStats stays 0.
  // Take the larger of the API value and the live-tick value so SSE bursts
  // (if/when wired) still bump the KPI between aggregate refetches, while the
  // API remains the source of truth for the at-rest value via polling.
  const subagentUsd = Math.max(aggregate?.subagentUsd ?? 0, subagentStats.usd);
  const subagentTurns = Math.max(aggregate?.subagentTurnCount ?? 0, subagentStats.turns);
  // Distinguish "no data yet" (aggregate still loading and no live ticks) from
  // a genuine zero so the KPI shows the em-dash empty state instead of $0.00.
  const subagentHasData = aggregate !== undefined || subagentStats.turns > 0;
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
    effScore !== null && Number.isFinite(effScore) ? `${Math.round(effScore * 100)}%` : '—';
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
            <CostByToolPanel />
          </AnimatedCard>

          <AnimatedCard index={2}>
            <RecentAlertsPanel />
          </AnimatedCard>
        </>
      ) : (
        <>
          {healthApi?.watcherActive === false &&
            subagentTurns === 0 &&
            healthApi?.watcherDisabledReason !== 'mode_mismatch' && (
              <div className="rounded-lg border border-border-subtle bg-surface-5 px-4 py-3 text-sm text-ink-muted mb-4">
                Subagent cost tracking is disabled (
                <code className="font-mono text-xs">NR_AI_ENABLE_SUBAGENT_WATCHER=0</code>), so
                spend shown here excludes subagents. Unset that variable (it is on by default) and
                restart to see full spend.
              </div>
            )}
          {healthApi?.watcherActive === false &&
            subagentTurns === 0 &&
            healthApi?.watcherDisabledReason === 'mode_mismatch' && (
              <div className="rounded-lg border border-border-subtle bg-surface-5 px-4 py-3 text-sm text-ink-muted mb-4">
                This dashboard process isn&rsquo;t running its own subagent watcher — expected for a
                background <code className="font-mono text-xs">--local</code> dashboard (the watcher
                only auto-starts in <code className="font-mono text-xs">--stdio</code> mode). Spend
                shown here still includes subagent activity from other sessions, read from their
                persisted totals. To track subagents live from this process too, set{' '}
                <code className="font-mono text-xs">NR_AI_WATCHER_MODE=local</code> and restart.
              </div>
            )}
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
                  {...(!spendLoading
                    ? { animate: true, numericValue: todayTotal, format: formatUsd }
                    : {})}
                />
                <Kpi
                  label="subagent spend"
                  value={!subagentHasData ? '—' : formatUsd(subagentUsd)}
                  sub={`${subagentTurns} turns`}
                  {...(subagentHasData
                    ? { animate: true, numericValue: subagentUsd, format: formatUsd }
                    : {})}
                />
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
          </AnimatedCard>

          <AnimatedCard index={1} className="grid grid-cols-2 gap-3 mb-3">
            <ForecastEodCard
              todayTotal={forecastBreakdownTotalUsd}
              forecastEod={
                spendLoading
                  ? null
                  : (cost?.forecastEodUsd ??
                    aggregate?.forecastEndOfDayUsd ??
                    costApi?.forecast?.forecastEndOfDayUsd ??
                    null)
              }
              hourlySpend={hourlySpend}
              subagentUsd={forecastBreakdownSubagentUsd}
              forecastSessionEnd={costApi?.forecast?.forecastSessionEndUsd ?? null}
              forecastWeek={costApi?.forecast?.forecastEndOfWeekUsd ?? null}
              confidenceNote={costApi?.forecast?.confidenceNote ?? null}
            />
            {concurrency && concurrency.buckets && (
              <ConcurrencyIndicator
                current={concurrency.current}
                peak={concurrency.peak}
                allTimePeak={concurrency.allTimePeak}
                bucketSizeMs={concurrency.bucketSizeMs}
                startTimestamp={concurrency.startTimestamp}
                buckets={concurrency.buckets}
              />
            )}
          </AnimatedCard>

          {flagsCount > 0 && (
            <AnimatedCard index={2} className="mb-3">
              <Card padding="sm" tone="warning" className="text-xs">
                {antiPatterns.length > 0 ? (
                  <>
                    <Pill tone="warning" size="sm" className="mr-2">
                      {antiPatterns[0].type}
                    </Pill>
                    <span className="text-ink-muted">— </span>
                    <span>{antiPatterns[0].count}× on </span>
                    <code className="bg-surface-5 px-1 rounded">{antiPatterns[0].target}</code>
                    {/* Per-session pill so users can identify
                        which of N concurrent sessions triggered the alert. */}
                    {antiPatterns[0].sessionId && (
                      <Pill tone="neutral" size="sm" className="ml-2">
                        Session: {sessionPillLabel(antiPatterns[0].sessionId, liveSessions ?? [])}
                      </Pill>
                    )}
                  </>
                ) : apiAntiPatterns && apiAntiPatterns.length > 0 ? (
                  <>
                    <Pill tone="warning" size="sm" className="mr-2">
                      {apiAntiPatterns[0].type}
                    </Pill>
                    <span className="text-ink-muted">— </span>
                    <span>
                      {apiAntiPatterns[0].count ??
                        apiAntiPatterns[0].iterations ??
                        apiAntiPatterns[0].readCount ??
                        apiAntiPatterns[0].repeatCount ??
                        apiAntiPatterns[0].editCount ??
                        apiAntiPatterns[0].agentCount ??
                        '?'}
                      × on{' '}
                    </span>
                    <code className="bg-surface-5 px-1 rounded">
                      {apiAntiPatterns[0].file ?? apiAntiPatterns[0].command ?? 'unknown'}
                    </code>
                  </>
                ) : persistedAntiPatterns.length > 0 ? (
                  <>
                    <Pill tone="warning" size="sm" className="mr-2">
                      {persistedAntiPatterns[0].type}
                    </Pill>
                    <span className="text-ink-muted">— </span>
                    <span>
                      {persistedAntiPatterns[0].count ??
                        persistedAntiPatterns[0].iterations ??
                        persistedAntiPatterns[0].readCount ??
                        persistedAntiPatterns[0].repeatCount ??
                        persistedAntiPatterns[0].editCount ??
                        persistedAntiPatterns[0].agentCount ??
                        '?'}
                      × on{' '}
                    </span>
                    <code className="bg-surface-5 px-1 rounded">
                      {persistedAntiPatterns[0].file ??
                        persistedAntiPatterns[0].command ??
                        'unknown'}
                    </code>
                  </>
                ) : (
                  <span>{flagsCount} flag(s) detected today — details unavailable.</span>
                )}
              </Card>
            </AnimatedCard>
          )}

          <AnimatedCard index={3} className="grid grid-cols-3 gap-3 mb-3">
            <QualityProxyPanel />
            <ApiFailurePanel />
            <ToolSelectionPanel />
            <LatencyPanel aggregate={aggregate} />
            <ComputeWastePanel liveSessions={liveSessions ?? []} />
            <ModelUsagePanel />
            <CacheHealthPanel aggregate={aggregate} />
            <div className="col-span-3">
              <CostByToolPanel />
            </div>
          </AnimatedCard>

          <AnimatedCard index={4}>
            <LiveSessionPane sessions={todaySessions ?? []} liveSessions={liveSessions ?? []} />
          </AnimatedCard>

          {todayHeatmap && todayHeatmap.buckets?.length > 0 && (
            <AnimatedCard index={5} className="mb-3">
              <Card padding="sm">
                <div className="flex items-center gap-1.5 mb-2">
                  <Eyebrow>Activity Today</Eyebrow>
                  <InfoTooltip text="Tool-call activity in 15-minute blocks across today. Darker blocks mean more calls in that window." />
                </div>
                <ActivityHeatmap
                  variant="strip"
                  buckets={todayHeatmap.buckets}
                  maxCount={todayHeatmap.maxCount}
                  bucketSizeMs={todayHeatmap.bucketSizeMs}
                  startTimestamp={todayHeatmap.startTimestamp}
                  ariaLabel="Today's activity density in 15-minute blocks"
                />
              </Card>
            </AnimatedCard>
          )}

          <AnimatedCard index={6}>
            <RecentAlertsPanel />
          </AnimatedCard>
        </>
      )}
    </section>
  );
}

function CostByToolPanel(): JSX.Element {
  const { data, isError } = useQuery<TurnCostsResponse>({
    queryKey: qk.costPerTool,
    queryFn: () => fetchCostPerTool(),
    refetchInterval: QUALITY_REFETCH_MS,
    retry: false,
  });

  const tools = data?.costByToolType
    ? Object.entries(data.costByToolType)
        .filter(([, e]) => e.totalCost > 0)
        .sort((a, b) => b[1].totalCost - a[1].totalCost)
        .map(([tool, e]) => ({ tool, totalCost: e.totalCost, callCount: e.callCount }))
    : [];

  const lowAttribution = data != null && (data.attributionRate ?? 1) < 0.5;

  if (isError) {
    return (
      <Card padding="sm" className="h-full">
        <Eyebrow className="mb-2">Cost by Tool</Eyebrow>
        <EmptyState
          icon="radar"
          title="Cost attribution unavailable"
          subtitle="Start a Claude Code session to enable cost attribution."
        />
      </Card>
    );
  }

  if (!data) {
    return (
      <Card padding="sm" className="h-full">
        <Eyebrow className="mb-2">Cost by Tool</Eyebrow>
        <EmptyState
          icon="radar"
          title="No cost data yet"
          subtitle="Cost attribution appears after token data is recorded."
        />
      </Card>
    );
  }

  return (
    <Card padding="sm" className="h-full">
      <Eyebrow className="mb-2">Cost by Tool</Eyebrow>
      {tools.length === 0 ? (
        <EmptyState
          icon="radar"
          title="No cost data yet"
          subtitle="Cost attribution appears after token data is recorded."
        />
      ) : (
        <>
          <div className="min-w-0" style={{ height: `${Math.max(96, tools.length * 28 + 24)}px` }}>
            <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
              <BarChart data={tools} layout="vertical">
                <CartesianGrid stroke={CHART_GRID_STROKE} strokeDasharray="3 3" />
                <XAxis type="number" tick={CHART_TICK_STYLE} stroke={CHART_GRID_STROKE} unit="$" />
                <YAxis
                  type="category"
                  dataKey="tool"
                  tick={CHART_TICK_STYLE}
                  tickFormatter={(value: string) => {
                    const match = tools.find((t) => t.tool === value);
                    const label = shortToolName(value);
                    return match ? `${label} (${match.callCount})` : label;
                  }}
                  stroke={CHART_GRID_STROKE}
                  width={90}
                  interval={0}
                />
                <Tooltip
                  contentStyle={CHART_TOOLTIP_STYLE}
                  labelFormatter={(label) => shortToolName(String(label))}
                />
                <Bar dataKey="totalCost" name="Cost ($)" radius={[0, 3, 3, 0]}>
                  {tools.map((entry) => (
                    <Cell
                      key={entry.tool}
                      fill={toolFillColor(shortToolName(entry.tool))}
                      fillOpacity={0.8}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          {lowAttribution && (
            <div className="text-[10px] text-ink-muted italic mt-1">
              Based on {Math.round((data.attributionRate ?? 0) * 100)}% of session cost
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function QualityProxyPanel(): JSX.Element {
  const { data } = useQuery<QualityProxyMetrics>({
    queryKey: qk.qualityProxy,
    queryFn: fetchQualityProxy,
    refetchInterval: QUALITY_REFETCH_MS,
  });

  return (
    <Card padding="sm" className="h-full">
      <div className="flex items-center gap-1.5 mb-2">
        <Eyebrow>Quality</Eyebrow>
        <InfoTooltip text="Diff apply rate and test pass rate across today's sessions, plus how often you backtracked or self-corrected. Watch for the degrading flag if quality drops mid-session." />
      </div>
      {!data || data.totalSignals === 0 ? (
        <EmptyState
          icon="checkmark"
          title="Waiting for edits and test runs"
          subtitle="Quality metrics appear after editing files and running tests."
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <span className="text-ink-muted">Diff Apply </span>
              <span className={rateColor(data.diffApplyRate)}>
                {data.diffApplyRate !== null ? `${(data.diffApplyRate * 100).toFixed(0)}%` : '—'}
              </span>
            </div>
            <div>
              <span className="text-ink-muted">Test Pass </span>
              <span className={rateColor(data.testPassRate)}>
                {data.testPassRate !== null ? `${(data.testPassRate * 100).toFixed(0)}%` : '—'}
              </span>
            </div>
            <div>
              <span className="text-ink-muted">Backtracks </span>
              <span className={data.backtrackCount > 0 ? 'text-accent-amber' : ''}>
                {data.backtrackCount}
              </span>
            </div>
            <div>
              <span className="text-ink-muted">Self-corrections </span>
              <span className="text-ink-subtle">{data.selfCorrectionCount}</span>
            </div>
          </div>
          {data.degradationDetected && (
            <div className="text-accent-amber text-xs mt-2">&#9888; Quality degrading</div>
          )}
        </>
      )}
    </Card>
  );
}

function ApiFailurePanel(): JSX.Element {
  const { data } = useQuery<ApiFailureMetrics>({
    queryKey: qk.apiFailures,
    queryFn: fetchApiFailures,
    refetchInterval: QUALITY_REFETCH_MS,
  });

  const errorTypeEntries = data?.byErrorType
    ? Object.entries(data.byErrorType).filter(([, count]) => count > 0)
    : [];
  const throttleAlerts = data?.throttleAlerts ?? [];

  return (
    <Card padding="sm" className="h-full">
      <div className="flex items-center gap-1.5 mb-2">
        <Eyebrow>API Failures</Eyebrow>
        <InfoTooltip text="Turns that failed outright after Claude Code's own retries were exhausted, captured via its StopFailure hook." />
      </div>
      {!data || data.totalFailures === 0 ? (
        <EmptyState
          icon="radar"
          title="No API failures"
          subtitle="Reflects Claude Code's own StopFailure hook, not proxy-mode traffic."
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <span className="text-ink-muted">Total </span>
              <span className="text-accent-amber">{data.totalFailures}</span>
            </div>
            <div>
              <span className="text-ink-muted">Throttle alerts </span>
              <span className={throttleAlerts.length > 0 ? 'text-accent-amber' : ''}>
                {throttleAlerts.length}
              </span>
            </div>
          </div>
          {errorTypeEntries.length > 0 && (
            <div className="text-[10px] text-ink-subtle mt-1">
              {errorTypeEntries.map(([type, count]) => `${type}: ${count}`).join(', ')}
            </div>
          )}
          {throttleAlerts.length > 0 && (
            <div className="text-accent-amber text-xs mt-2">
              &#9888; Rate-limit throttling detected
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function ToolSelectionPanel(): JSX.Element {
  const { data } = useQuery<ToolSelectionMetrics>({
    queryKey: qk.toolSelectionScore,
    queryFn: fetchToolSelectionScore,
    refetchInterval: QUALITY_REFETCH_MS,
  });

  return (
    <Card padding="sm" className="h-full">
      <div className="flex items-center gap-1.5 mb-2">
        <Eyebrow>Tool Selection</Eyebrow>
        <InfoTooltip text="Scores how efficiently tools were chosen today: penalizes re-reading a file without editing it, retrying a failing call, or fetching output that's never used." />
      </div>
      {!data || Array.isArray(data) || data.totalCalls === 0 ? (
        <EmptyState
          icon="radar"
          title="Waiting for tool calls"
          subtitle="Start a Claude Code session to begin scoring. Reflects today's activity across all sessions."
        />
      ) : (
        <>
          <div className="flex items-baseline gap-2">
            <span className={`text-2xl font-semibold tabular-nums ${scoreColor(data.score)}`}>
              {data.score.toFixed(2)}
            </span>
            <span className="text-[10px] text-ink-muted">/ 1.0</span>
          </div>
          <div className="text-[10px] text-ink-muted mt-1">
            {data.penalizedCalls} of {data.totalCalls} calls penalized
          </div>
          {(data.redundantReadCount > 0 ||
            data.repeatedFailureCount > 0 ||
            data.unusedOutputCount > 0) && (
            <div className="text-[10px] text-ink-subtle mt-1 space-x-2">
              {data.redundantReadCount > 0 && <span>re-reads: {data.redundantReadCount}</span>}
              {data.repeatedFailureCount > 0 && (
                <span>repeat fails: {data.repeatedFailureCount}</span>
              )}
              {data.unusedOutputCount > 0 && <span>unused output: {data.unusedOutputCount}</span>}
            </div>
          )}
          <div className="text-[10px] text-ink-subtle/60 mt-2">
            Penalizes: reading the same file 3+ times without editing, repeated tool failures,
            fetching large outputs never referenced.
          </div>
        </>
      )}
    </Card>
  );
}

// --- Latency Panel ---

interface LatencyPercentiles {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly count: number;
}

function LatencyPanel({
  aggregate,
}: {
  aggregate: TodayAggregateResponse | undefined;
}): JSX.Element {
  const data = aggregate?.latency;

  // Guard `data.byTool` separately — the API can return `data` with `byTool`
  // missing (or `null`) when no tool calls have been recorded yet, and
  // `Object.entries(undefined)` throws. Surfaced widely in test runs where
  // mock fixtures returned `{}` and the crash bubbled up to unrelated tests.
  const topTools = data?.byTool
    ? Object.entries(data.byTool)
        .filter(
          (entry): entry is [string, LatencyPercentiles] => entry[1] !== null && entry[1].count > 0,
        )
        .sort((a, b) => b[1].p95 - a[1].p95)
        .slice(0, 4)
    : [];

  return (
    <Card padding="sm" className="h-full">
      <div className="flex items-center gap-1.5 mb-2">
        <Eyebrow>Latency (ms)</Eyebrow>
        <InfoTooltip text="How long tool calls took today — p50/p95/p99 across all calls, plus the slowest tools by p95." />
      </div>
      {!data || !data.overall ? (
        <EmptyState
          icon="clock"
          title="Waiting for tool calls"
          subtitle="Latency percentiles appear after tool calls complete."
        />
      ) : (
        <>
          <div className="flex gap-4 text-xs mb-2">
            <div>
              <span className="text-ink-muted">p50 </span>
              <span className="text-ink-base tabular-nums">{data.overall.p50}</span>
            </div>
            <div>
              <span className="text-ink-muted">p95 </span>
              <span className="text-ink-base tabular-nums">{data.overall.p95}</span>
            </div>
            <div>
              <span className="text-ink-muted">p99 </span>
              <span className="text-ink-base tabular-nums">{data.overall.p99}</span>
            </div>
          </div>
          {topTools.length > 0 && (
            <div className="space-y-1">
              {topTools.map(([tool, p]) => (
                <div key={tool} className="flex items-center gap-2 text-xs">
                  <span className="text-ink-muted truncate w-28 shrink-0">
                    {shortToolName(tool)}
                  </span>
                  <span className="tabular-nums text-ink-subtle">{p.p95}ms p95</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

// --- Model Usage Panel ---

interface ModelStats {
  readonly requestCount: number;
  readonly totalCostUsd: number;
  readonly costPerOutputToken: number | null;
  readonly costPerMillionTokens: number | null;
}

interface ModelUsageMetrics {
  readonly byModel: Readonly<Record<string, ModelStats>>;
  readonly mostUsedModel: string | null;
  readonly mostEfficientModel: string | null;
}

function ModelUsagePanel(): JSX.Element {
  const { data } = useQuery<ModelUsageMetrics>({
    queryKey: qk.modelUsage,
    queryFn: fetchModelUsage,
    refetchInterval: QUALITY_REFETCH_MS,
  });

  // Same shape-defensive guard as LatencyPanel — `data.byModel` can be
  // missing or null when no token events have been recorded yet.
  const models = data?.byModel
    ? Object.entries(data.byModel)
        .filter(([, s]) => s.requestCount > 0)
        .sort((a, b) => b[1].totalCostUsd - a[1].totalCostUsd)
        .slice(0, 4)
    : [];

  return (
    <Card padding="sm" className="h-full">
      <div className="flex items-center gap-1.5 mb-2">
        <Eyebrow>Model Usage</Eyebrow>
        <InfoTooltip text="Cost and request volume per model used today, combining this server's live usage with every other session's saved totals. The live slice resets if the server process restarts." />
      </div>
      {!data || models.length === 0 ? (
        <EmptyState
          icon="radar"
          title="No model data yet"
          subtitle="Start a Claude Code session to see model cost breakdown. Resets when the process restarts."
        />
      ) : (
        <div className="space-y-1.5">
          {models.map(([model, s]) => (
            <div key={model} className="flex items-center justify-between text-xs gap-2">
              <span className="text-ink-muted truncate">{model}</span>
              <div className="flex gap-3 shrink-0 tabular-nums">
                <span className="text-ink-subtle">{s.requestCount}req</span>
                <span className="text-ink-subtle">
                  {formatUsdOrDash(s.costPerMillionTokens)}/1M tok
                </span>
                <span className="text-ink-base">{formatUsd(s.totalCostUsd)}</span>
              </div>
            </div>
          ))}
          {data?.mostEfficientModel && (
            <div className="text-[10px] text-accent-green mt-1">
              Most efficient: {data.mostEfficientModel}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function cacheRecommendationText(
  status: 'no_cache_activity' | 'needs_attention' | 'can_improve' | 'excellent',
  hitRatePct: number | null,
): string {
  const pct = hitRatePct !== null ? `${hitRatePct}%` : null;
  if (status === 'excellent')
    return pct
      ? `Cache hit rate is ${pct}. Cache is well-structured.`
      : 'Cache is well-structured. No changes needed.';
  if (status === 'can_improve')
    return pct
      ? `Cache hit rate is ${pct}. Placing stable content before variable content in prompts could improve this.`
      : 'Place stable content before variable content in prompts to improve.';
  return pct
    ? `Cache hit rate is ${pct}. Restructuring your system prompt so stable context appears at the top could bring this above 60%.`
    : 'Restructure your system prompt so stable context appears at the top.';
}

function CacheHealthPanel({
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

  return (
    <Card padding="sm" className="h-full">
      <div className="flex items-center gap-1.5 mb-2">
        <Eyebrow>Cache Health</Eyebrow>
        <InfoTooltip text="Prompt cache hit rate today, with a suggestion for improving it — usually by moving stable context earlier in the prompt." />
      </div>
      {noActivity ? (
        <EmptyState
          icon="radar"
          title="No cache data yet"
          subtitle="Appears once token usage with cache reads is reported."
        />
      ) : (
        <>
          <div className="flex items-baseline gap-2 mb-1">
            <span
              className={`text-2xl font-semibold tabular-nums ${
                data.status === 'excellent'
                  ? 'text-accent-green'
                  : data.status === 'needs_attention'
                    ? 'text-accent-amber'
                    : 'text-ink-base'
              }`}
            >
              {data.cacheHitRatePct}%
            </span>
            <Pill tone={data.status === 'needs_attention' ? 'warning' : 'neutral'} size="sm">
              {data.status === 'excellent' ? 'excellent' : data.status.replace('_', ' ')}
            </Pill>
          </div>
          {data.totalSavingsUsd > 0 && (
            <div className="text-xs text-accent-green mb-1">
              ${data.totalSavingsUsd.toFixed(4)} saved
            </div>
          )}
          {trendData?.week_over_week_delta_pts != null &&
            trendData.week_over_week_delta_pts !== 0 && (
              <div
                className={`text-[10px] font-medium mb-1 ${
                  trendData.week_over_week_delta_pts > 0 ? 'text-accent-green' : 'text-accent-amber'
                }`}
              >
                {trendData.week_over_week_delta_pts > 0 ? '↑' : '↓'}
                {Math.abs(trendData.week_over_week_delta_pts)}pts vs last week
              </div>
            )}
          <div className="text-[10px] text-ink-subtle/70 leading-snug">
            {cacheRecommendationText(data.status, data.cacheHitRatePct)}
          </div>
        </>
      )}
    </Card>
  );
}

function ComputeWastePanel({
  liveSessions,
}: {
  liveSessions: LiveSessionEntry[];
}): JSX.Element | null {
  const { data, isPending } = useQuery<ComputeWasteApiResponse>({
    queryKey: qk.computeWaste,
    queryFn: fetchComputeWaste as () => Promise<ComputeWasteApiResponse>,
    retry: false,
  });
  const retryAlerts = useLiveStore((s) => s.retryAlerts);

  if (isPending || !data || typeof data.total_tokens_wasted !== 'number') return null;

  const latestRetryAlert = retryAlerts[retryAlerts.length - 1] ?? null;
  const topSession = data.by_session?.[0] ?? null;

  const statusColor =
    data.status === 'clean'
      ? 'text-accent-green'
      : data.status === 'moderate'
        ? 'text-accent-amber'
        : 'text-accent-red';

  const statusLabel =
    data.status === 'clean' ? 'clean' : data.status === 'moderate' ? 'moderate' : 'needs attention';

  const topOffender = data.breakdown[0] ?? null;

  return (
    <Card padding="sm" className="h-full">
      <div className="flex items-center gap-1.5 mb-2">
        <Eyebrow>Compute Waste</Eyebrow>
        <InfoTooltip text="Tokens wasted today on retried tool calls and anti-pattern activity (stuck loops, redundant reads, thrashing)." />
      </div>
      <div className={`text-lg font-semibold tabular-nums ${statusColor}`}>
        ~{data.total_tokens_wasted.toLocaleString()} wasted tokens
      </div>
      <Pill
        tone={
          data.status === 'clean' ? 'success' : data.status === 'moderate' ? 'warning' : 'danger'
        }
        size="sm"
        className="mt-1"
      >
        {statusLabel}
      </Pill>
      <div className="text-xs text-ink-muted mt-1">
        retry: ~{data.retry_tokens_wasted.toLocaleString()} · anti-pattern: ~
        {data.anti_pattern_tokens_wasted.toLocaleString()}
      </div>
      {topSession !== null && (
        <div className="text-[10px] text-ink-subtle/70 mt-0.5">
          top session: {sessionPillLabel(topSession.session_id, liveSessions)} (~
          {topSession.tokens_wasted.toLocaleString()})
        </div>
      )}
      {topOffender !== null && (
        <div className="text-[10px] font-medium text-accent-amber mb-1">
          {topOffender.type.replace(/_/g, ' ')} · ~{topOffender.tokens_wasted.toLocaleString()}{' '}
          tokens
        </div>
      )}
      {latestRetryAlert !== null && (
        <div className="text-[10px] mb-1">
          <Pill tone="warning" size="sm" className="mr-1">
            {latestRetryAlert.toolName}
          </Pill>
          <span className="text-ink-muted">retried {latestRetryAlert.occurrences}× </span>
          {latestRetryAlert.sessionId && (
            <Pill tone="neutral" size="sm" className="ml-1">
              Session: {sessionPillLabel(latestRetryAlert.sessionId, liveSessions)}
            </Pill>
          )}
        </div>
      )}
      <div className="text-[10px] text-ink-subtle/70 leading-snug">
        {computeWasteRecommendationText(data.status, topOffender?.type ?? null)}
      </div>
    </Card>
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
}

interface ReplaySegment {
  readonly type: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly severity: 'warning' | 'critical';
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
                      `${turnCosts.turns.length} turns · $${turnCosts.totalAttributedCost.toFixed(2)}`,
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

// Label resolver for the per-session pill on anti-pattern
// alerts. Falls back to the truncated session id when no friendly name is
// known yet — sessionName is only set after the live registry has seen a
// `cwd` from the first hook event.
function sessionPillLabel(sessionId: string, liveSessions: LiveSessionEntry[]): string {
  const match = liveSessions.find((ls) => ls.sessionId === sessionId);
  if (match?.sessionName) return match.sessionName;
  return sessionId.slice(0, 8);
}

function RecentAlertsPanel(): JSX.Element | null {
  // The query returns `null` when the endpoint is 404 (cloud mode — no
  // alert engine), so callers can render an empty / hidden state instead
  // of a permanent red error banner. retry: false avoids the 4× request
  // multiplier React Query would otherwise produce on every refetch.
  const { data, isLoading, error } = useQuery<readonly AlertEvent[] | null>({
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

  // Cloud mode (or alerts disabled) → endpoint 404 → null. Render nothing
  // so the panel doesn't claim there's an error when there isn't one.
  if (data === null) return null;

  const entries: readonly AlertEvent[] = data ?? [];
  // Defensive sort — `AlertLog.readRecent` already reverses the
  // last-N-lines slice before returning, so the API is newest-first today.
  // Sorting again is idempotent and pins the UI ordering against any future
  // refactor of `readRecent` that drops or reorders the .reverse() call.
  const sortedEntries = [...entries].sort((a, b) => b.firedAt - a.firedAt);

  return (
    <Card padding="sm">
      <div className="flex items-center gap-1.5 mb-2">
        <Eyebrow>Recent Alerts</Eyebrow>
        <InfoTooltip text="The most recent alert firings and resolutions from your configured alert rules, newest first." />
      </div>
      {isLoading && <EmptyState variant="loading" title="Loading..." />}
      {error && <div className="text-accent-red text-xs">Error loading recent alerts.</div>}
      {!isLoading && !error && sortedEntries.length === 0 && (
        <div className="text-ink-muted text-xs">No alerts in recent history.</div>
      )}
      {!isLoading && !error && sortedEntries.length > 0 && (
        <table className="w-full text-xs">
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
            {sortedEntries.slice(0, 50).map((a) => (
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
    </Card>
  );
}

function formatRelativeTime(ts: number): string {
  const now = Date.now();
  const diff = Math.max(0, now - ts);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
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

function ForecastEodCard({
  todayTotal,
  forecastEod,
  hourlySpend,
  subagentUsd = 0,
  forecastSessionEnd,
  forecastWeek,
  confidenceNote,
}: {
  todayTotal: number;
  forecastEod: number | null;
  hourlySpend: HourlyCostEntry[];
  subagentUsd?: number;
  forecastSessionEnd: number | null;
  forecastWeek: number | null;
  confidenceNote: string | null;
}): JSX.Element {
  const hasForecast = forecastEod !== null && Number.isFinite(forecastEod);
  const effectiveForecast = hasForecast ? Math.max(forecastEod, todayTotal) : 0;
  const delta = hasForecast ? effectiveForecast - todayTotal : 0;
  const pct = hasForecast && todayTotal > 0 ? (delta / todayTotal) * 100 : 0;
  const hasSpend = hourlySpend.some((h) => h.cost > 0);
  // The caller passes todayTotal/subagentUsd from the same source whenever
  // possible, so subagentUsd is normally guaranteed <= todayTotal. Clamp to 0
  // defensively anyway (the server clamps its own parentUsd the same way) for
  // the brief window before that shared source has resolved.
  const parentUsd = subagentUsd > 0 ? Math.max(0, todayTotal - subagentUsd) : 0;

  return (
    <Card padding="sm" className="mb-3 h-full">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Eyebrow>Forecast · End of Day</Eyebrow>
        <InfoTooltip text="Projects today's total spend by midnight, based on the spending trend so far this hour-by-hour." />
      </div>
      {hasForecast ? (
        <>
          <div className="flex items-baseline gap-3">
            <span className="text-lg font-semibold text-accent-cyan tabular-nums">
              {formatUsd(effectiveForecast)}
            </span>
            <span className="text-xs text-ink-muted tabular-nums">
              {delta > 0 ? (
                <>
                  +{formatUsd(delta)}
                  {todayTotal > 0 && ` (+${pct.toFixed(0)}%)`} from now
                </>
              ) : (
                <>on pace</>
              )}
            </span>
          </div>
          {hasSpend && (
            <div className="mt-2">
              <HourlyCostBlocks hours={hourlySpend} />
              {subagentUsd > 0 && (
                <div className="flex gap-3 mt-1 text-[10px] text-ink-muted tabular-nums">
                  <span>parent {formatUsd(parentUsd)}</span>
                  <span className="text-ink-subtle">·</span>
                  <span>subagent {formatUsd(subagentUsd)}</span>
                </div>
              )}
            </div>
          )}
          {(forecastSessionEnd !== null || forecastWeek !== null) && (
            <div className="grid grid-cols-2 gap-x-3 mt-2 pt-2 border-t border-border-subtle text-xs">
              {forecastSessionEnd !== null && (
                <div>
                  <div className="text-ink-muted">End of session</div>
                  <div className="font-mono tabular-nums">~${forecastSessionEnd.toFixed(2)}</div>
                </div>
              )}
              {forecastWeek !== null && (
                <div>
                  <div className="text-ink-muted">End of week</div>
                  <div className="font-mono tabular-nums">~${forecastWeek.toFixed(2)}</div>
                </div>
              )}
            </div>
          )}
          {confidenceNote && (
            <div className="text-[10px] text-ink-muted italic mt-1">{confidenceNote}</div>
          )}
        </>
      ) : (
        <div className="text-ink-muted text-xs">
          Insufficient data — forecast appears once burn rate stabilizes.
        </div>
      )}
    </Card>
  );
}
