import { useMemo, useState, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { useLiveStore, type AlertEvent } from '../store/liveStore';
import { Kpi } from '../components/Kpi';
import { AnimatedCard } from '../components/AnimatedCard';
import { HourlyCostBlocks, type HourlyCostEntry } from '../components/HourlyCostBlocks';
import { EmptyState } from '../components/EmptyState';
import { GanttTimeline } from '../components/GanttTimeline';
import { ConcurrencyIndicator, type ConcurrencyData } from '../components/ConcurrencyIndicator';
import { ActivityHeatmap } from '../components/ActivityHeatmap';
import { GeoBanner } from '../components/GeoBanner';
import { ContextBar } from '../components/ContextBar';
import { Card, Eyebrow, LiveBadge, Pill, Tabs } from '../components/ui';
import {
  fetchRecentAlerts,
  fetchCost,
  fetchSessionCurrent,
  fetchSessionsList,
  fetchSessionReplay,
  fetchAntiPatterns,
  fetchQualityProxy,
  fetchToolSelectionScore,
  fetchConcurrency,
  fetchActivityHeatmap,
  fetchLatency,
  fetchModelUsage,
  fetchLiveSessions,
  fetchTodayAggregate,
  NotFoundError,
  qk,
} from '../api/client';
import {
  fmtElapsed,
  fmtTimeOfDay,
  formatNumber,
  rateColor,
  scoreColor,
  shortToolName,
} from '../lib/format';
import { isSameLocalDay, localStartOfDay } from '../../lib/date.js';

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
  readonly forecast: { readonly forecastEndOfDayUsd?: number | null } | null;
  readonly sessionTodayUsd?: number | null;
}

interface HeatmapApiResponse {
  readonly buckets: number[];
  readonly bucketSizeMs: number;
  readonly startTimestamp: number;
  readonly maxCount: number;
}

// Minimal view of the /api/session/current payload. F-050 added efficiencyScore.
interface SessionCurrentApiResponse {
  readonly efficiencyScore?: number | null;
  readonly toolSuccessRate?: number | null;
  readonly toolErrorCount?: number;
  readonly toolCallCount?: number;
}

interface SessionAntiPattern {
  readonly type: string;
  readonly count?: number;
  readonly file?: string;
  readonly command?: string;
  readonly iterations?: number;
  readonly readCount?: number;
  readonly repeatCount?: number;
  readonly editCount?: number;
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

// Task #17 (D3): cross-session aggregate KPI shape returned by
// /api/sessions/today/aggregate. The dashboard owner reads every per-session
// buffer file plus persisted today sessions to produce one global view.
interface TodayAggregateApiResponse {
  readonly toolCallCount: number;
  readonly totalCostUsd: number;
  readonly antiPatternCount: number;
  readonly avgDurationMs: number;
  readonly sessionCount: number;
  readonly sparkline: {
    readonly startTimestamp: number;
    readonly bucketSizeMs: number;
    readonly points: readonly number[];
  };
}

// Task #17 (D3): /api/sessions/live response — currently-live sessions sorted
// most-recently-active first.
interface LiveSessionApiEntry {
  readonly sessionId: string;
  readonly sessionName: string | null;
  readonly startTime: number;
  readonly lastActivity: number;
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

  const { data: costApi, isPending: costPending } = useQuery<CostApiResponse>({
    queryKey: qk.cost,
    queryFn: () => fetchCost() as Promise<CostApiResponse>,
  });
  // Task #17 (D3): the dashboard owner's session_current is arbitrary across
  // N concurrent sessions, so we keep the call only for the efficiencyScore
  // KPI (which is local to whichever MCP holds the dashboard). All other
  // KPIs now derive from the aggregate endpoint, which fans out across every
  // per-session buffer + persisted session.
  const { data: sessionCurrent } = useQuery<SessionCurrentApiResponse>({
    queryKey: qk.sessionCurrent,
    queryFn: () => fetchSessionCurrent() as Promise<SessionCurrentApiResponse>,
    refetchInterval: 10_000,
  });
  const { data: aggregate, isPending: aggregatePending } = useQuery<TodayAggregateApiResponse>({
    queryKey: qk.sessionsTodayAggregate,
    queryFn: () => fetchTodayAggregate() as Promise<TodayAggregateApiResponse>,
    refetchInterval: 10_000,
  });
  const { data: todaySessions, isPending: sessionsPending } = useQuery<SessionSummary[]>({
    queryKey: qk.sessionsList(200),
    queryFn: () => fetchSessionsList(200) as Promise<SessionSummary[]>,
    refetchInterval: 10_000,
  });
  const { data: apiAntiPatterns, isPending: antiPatternsPending } = useQuery<SessionAntiPattern[]>({
    queryKey: qk.antiPatterns,
    queryFn: () => fetchAntiPatterns() as Promise<SessionAntiPattern[]>,
  });
  const { data: concurrency } = useQuery<ConcurrencyData>({
    queryKey: qk.concurrency,
    queryFn: () => fetchConcurrency() as Promise<ConcurrencyData>,
    refetchInterval: 10_000,
  });
  const { data: todayHeatmap } = useQuery<HeatmapApiResponse>({
    queryKey: qk.activityHeatmap('today'),
    queryFn: () => fetchActivityHeatmap('today') as Promise<HeatmapApiResponse>,
    refetchInterval: 30_000,
  });
  // Task #17 (D3): live-session list — drives the selector default and the
  // "Session ended" badge logic when the selected session goes stale.
  const { data: liveSessions } = useQuery<LiveSessionApiEntry[]>({
    queryKey: qk.sessionsLive,
    queryFn: () => fetchLiveSessions() as Promise<LiveSessionApiEntry[]>,
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

  // Task #17 (D3): prefer the cross-session aggregate when present; fall
  // back to the legacy persisted-sessions math during the loading window so
  // the KPIs don't blink to zero on first paint. Use Math.max (not `??`)
  // because the aggregate endpoint can legitimately return 0 when its
  // disk-only data sources see no events from today (e.g., the live
  // session's events are in the in-memory tool-call buffer of a different
  // MCP, not in any drained buffer-*.jsonl file). Matches the spend +
  // flags formulas just below.
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
  const [headerTimestamp, setHeaderTimestamp] = useState(() =>
    new Date().toLocaleString(undefined, HEADER_TIMESTAMP_FORMAT),
  );
  useEffect(() => {
    const id = setInterval(
      () => setHeaderTimestamp(new Date().toLocaleString(undefined, HEADER_TIMESTAMP_FORMAT)),
      60_000,
    );
    return () => clearInterval(id);
  }, []);

  const effScore = sessionCurrent?.efficiencyScore ?? null;
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

          <AnimatedCard index={1}>
            <RecentAlertsPanel />
          </AnimatedCard>
        </>
      ) : (
        <>
          <AnimatedCard index={0} className="mb-4">
            <Card padding="lg" tone="elevated" glow="green">
              <div className="grid grid-cols-4 gap-4">
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
                  tone="accent"
                  value={spendLoading ? '…' : `$${todayTotal.toFixed(2)}`}
                  {...(!spendLoading
                    ? { animate: true, numericValue: todayTotal, prefix: '$', decimals: 2 }
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
              todayTotal={todayTotal}
              forecastEod={
                spendLoading
                  ? null
                  : (cost?.forecastEodUsd ??
                    (costApi?.forecast?.forecastEndOfDayUsd != null
                      ? todayTotal +
                        costApi.forecast.forecastEndOfDayUsd -
                        (costApi.sessionTodayUsd ?? 0)
                      : null))
              }
              hourlySpend={hourlySpend}
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

          {flagsCount > 0 &&
            (antiPatterns.length > 0 || (apiAntiPatterns && apiAntiPatterns.length > 0)) && (
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
                      {/* Task #17 (D3): per-session pill so users can identify
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
                          '?'}
                        × on{' '}
                      </span>
                      <code className="bg-surface-5 px-1 rounded">
                        {apiAntiPatterns[0].file ?? apiAntiPatterns[0].command ?? 'unknown'}
                      </code>
                    </>
                  ) : null}
                </Card>
              </AnimatedCard>
            )}

          <AnimatedCard index={3} className="grid grid-cols-2 gap-3 mb-3">
            <QualityProxyPanel />
            <ToolSelectionPanel />
            <LatencyPanel />
            <ModelUsagePanel />
          </AnimatedCard>

          <AnimatedCard index={4}>
            <LiveSessionPane sessions={todaySessions ?? []} liveSessions={liveSessions ?? []} />
          </AnimatedCard>

          {todayHeatmap && todayHeatmap.buckets?.length > 0 && (
            <AnimatedCard index={5} className="mb-3">
              <Card padding="sm">
                <Eyebrow className="mb-2">Activity Today</Eyebrow>
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

function QualityProxyPanel(): JSX.Element {
  const { data } = useQuery<QualityProxyMetrics>({
    queryKey: qk.qualityProxy,
    queryFn: () => fetchQualityProxy() as Promise<QualityProxyMetrics>,
    refetchInterval: QUALITY_REFETCH_MS,
  });

  return (
    <Card padding="sm" className="h-full">
      <Eyebrow className="mb-2">Quality</Eyebrow>
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

function ToolSelectionPanel(): JSX.Element {
  const { data } = useQuery<ToolSelectionMetrics>({
    queryKey: qk.toolSelectionScore,
    queryFn: () => fetchToolSelectionScore() as Promise<ToolSelectionMetrics>,
    refetchInterval: QUALITY_REFETCH_MS,
  });

  return (
    <Card padding="sm" className="h-full">
      <Eyebrow className="mb-2">Tool Selection</Eyebrow>
      {!data || Array.isArray(data) || data.totalCalls === 0 ? (
        <EmptyState
          icon="radar"
          title="Waiting for tool calls"
          subtitle="Tool selection scoring begins after tool calls arrive."
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

interface LatencyMetrics {
  readonly overall: LatencyPercentiles | null;
  readonly byTool: Readonly<Record<string, LatencyPercentiles | null>>;
  readonly slowestCalls: ReadonlyArray<{ toolName: string; durationMs: number }>;
}

function LatencyPanel(): JSX.Element {
  const { data } = useQuery<LatencyMetrics>({
    queryKey: qk.latency,
    queryFn: () => fetchLatency() as Promise<LatencyMetrics>,
    refetchInterval: QUALITY_REFETCH_MS,
  });

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
      <Eyebrow className="mb-2">Latency (ms)</Eyebrow>
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
}

interface ModelUsageMetrics {
  readonly byModel: Readonly<Record<string, ModelStats>>;
  readonly mostUsedModel: string | null;
  readonly mostEfficientModel: string | null;
}

function ModelUsagePanel(): JSX.Element {
  const { data } = useQuery<ModelUsageMetrics>({
    queryKey: qk.modelUsage,
    queryFn: () => fetchModelUsage() as Promise<ModelUsageMetrics>,
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
      <Eyebrow className="mb-2">Model Usage</Eyebrow>
      {!data || models.length === 0 ? (
        <EmptyState
          icon="radar"
          title="No model data yet"
          subtitle="Model cost breakdown appears after tool calls with token data."
        />
      ) : (
        <div className="space-y-1.5">
          {models.map(([model, s]) => (
            <div key={model} className="flex items-center justify-between text-xs gap-2">
              <span className="text-ink-muted truncate">{model}</span>
              <div className="flex gap-3 shrink-0 tabular-nums">
                <span className="text-ink-subtle">{s.requestCount}req</span>
                <span className="text-ink-base">${s.totalCostUsd.toFixed(4)}</span>
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

const TOOL_ICONS: Record<string, string> = {
  Read: '\u{1F4C4}',
  Edit: '\u{270F}\u{FE0F}',
  Write: '\u{1F4DD}',
  Bash: '\u{26A1}',
  Agent: '\u{1F916}',
  AskUserQuestion: '\u{1F4AC}',
  TaskCreate: '\u{1F4CB}',
  TaskUpdate: '\u{2705}',
};

const LIVE_TAIL_REFETCH_MS = 3_000;

function LiveSessionPane({
  sessions,
  liveSessions,
}: {
  sessions: SessionSummary[];
  liveSessions: LiveSessionApiEntry[];
}): JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'gantt' | 'list'>('list');
  const [, navigate] = useLocation();
  const setActiveSession = useLiveStore((s) => s.setActiveSession);

  // Task #17 (D3): live-session ids from /api/sessions/live (already sorted
  // most-recently-active first by the server). Falls back to /api/session/
  // current's `liveSessions` array during the loading window so the pane
  // populates immediately on first paint instead of waiting an interval.
  const { data: current } = useQuery<{ sessionId: string; liveSessions?: string[] }>({
    queryKey: qk.sessionCurrent,
    queryFn: () => fetchSessionCurrent() as Promise<{ sessionId: string; liveSessions?: string[] }>,
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
  // Task #17 (D3): "Session ended" badge — true when the user explicitly
  // selected a session that was previously live but is no longer in the live
  // set (e.g. the owning Claude Code window closed). We deliberately don't
  // auto-switch to a different session: that's jarring, and the user might be
  // mid-investigation. Instead we pin the selection and surface a badge.
  const sessionEnded = selectedId !== null && !liveSessionIds.has(selectedId);

  // Task #17 (D3): keep the global liveStore in sync with the local selector
  // so the rest of the dashboard (and any per-session caches) re-key when
  // the user switches. Empty deps + activeId in array — fires only on change.
  useEffect(() => {
    setActiveSession(activeId);
  }, [activeId, setActiveSession]);

  const { data: replay } = useQuery<ReplayData>({
    queryKey: activeId ? qk.sessionReplay(activeId) : ['replay', 'none'],
    queryFn: () => fetchSessionReplay(activeId!) as Promise<ReplayData>,
    enabled: activeId !== null,
    retry: false,
    refetchInterval: isLive ? LIVE_TAIL_REFETCH_MS : false,
  });

  const tailRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isLive && tailRef.current) {
      tailRef.current.scrollTop = tailRef.current.scrollHeight;
    }
  }, [replay?.timeline.length, isLive]);

  // Sort today's sessions by startTime descending (newest first), then merge
  // in any live sessions that haven't yet persisted to disk so the selector
  // shows them immediately. A session counts as "today" if it started today
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
    const liveById = new Map<string, LiveSessionApiEntry>();
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

  const timeline = replay?.timeline ?? [];
  const firstTs = timeline.length > 0 ? timeline[0]!.timestamp : 0;

  return (
    <div
      className="glass-card mb-3 grid grid-cols-[220px_1fr] overflow-hidden"
      style={{ height: '320px' }}
    >
      {/* Session list */}
      <div className="border-r border-border-subtle overflow-auto">
        <Eyebrow className="p-2 border-b border-border-subtle">Session Live Tail</Eyebrow>
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
                  <span>${s.estimatedCostUsd.toFixed(2)}</span>
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

      {/* Live tail */}
      <div className="flex flex-col overflow-hidden">
        {activeId && (
          <div className="flex items-center justify-between px-2 py-1 border-b border-border-subtle shrink-0">
            <Tabs
              value={viewMode}
              onChange={setViewMode}
              size="sm"
              tone="green"
              ariaLabel="Timeline view mode"
              options={[
                { value: 'gantt', label: 'Gantt' },
                { value: 'list', label: 'List' },
              ]}
            />
            <div className="flex items-center gap-2">
              {/* Task #17 (D3): "Session ended" badge — pinned to the selected
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
            <div className="text-ink-muted text-xs p-2">Select a session to view its timeline.</div>
          )}
          {activeId && timeline.length === 0 && (
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
          {timeline.length > 0 && viewMode === 'gantt' && (
            <GanttTimeline entries={timeline} segments={replay?.segments ?? []} />
          )}
          {timeline.length > 0 && viewMode === 'list' && (
            <div className="flex flex-col">
              {timeline.map((entry, idx) => {
                const elapsed = entry.timestamp - firstTs;
                return (
                  <div
                    key={`${idx}-${entry.timestamp}`}
                    className="flex items-center gap-1.5 px-1 py-0.5 text-xs border-b border-border-subtle/50 last:border-b-0"
                  >
                    <span className="w-10 text-ink-muted tabular-nums text-[11px] shrink-0">
                      +{fmtElapsed(elapsed)}
                    </span>
                    <span className="w-4 text-center text-[11px]" aria-hidden="true">
                      {TOOL_ICONS[entry.toolName] ?? '\u{00B7}'}
                    </span>
                    <span
                      className="w-28 truncate font-medium text-ink-base text-[11px]"
                      title={entry.toolName}
                    >
                      {shortToolName(entry.toolName)}
                    </span>
                    <span
                      className="flex-1 truncate font-mono text-ink-subtle text-[10px]"
                      title={entry.filePath ?? entry.command ?? ''}
                    >
                      {entry.filePath ?? entry.command ?? ''}
                    </span>
                    <span className="w-12 text-right tabular-nums text-ink-muted text-[10px]">
                      {entry.durationMs != null ? `${entry.durationMs}ms` : ''}
                    </span>
                    <span
                      className={`w-3 text-center text-[10px] ${entry.success ? 'text-accent-green' : 'text-accent-red'}`}
                    >
                      {entry.success ? '\u{2713}' : '\u{2717}'}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {/* Per-session ContextBar — pinned to the bottom of the tail so it
            shows for both Gantt and List view modes. Hidden when no session
            is selected or the selected session has ended (the context
            numbers would be stale and the SSE feed won't be updating). */}
        {isLive && activeId && (
          <div className="border-t border-bg-line px-3 py-2 shrink-0">
            <ContextBar sessionId={activeId} />
          </div>
        )}
      </div>
    </div>
  );
}

// Task #17 (D3): label resolver for the per-session pill on anti-pattern
// alerts. Falls back to the truncated session id when no friendly name is
// known yet — sessionName is only set after the live registry has seen a
// `cwd` from the first hook event.
function sessionPillLabel(sessionId: string, liveSessions: LiveSessionApiEntry[]): string {
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
        return (await fetchRecentAlerts()) as readonly AlertEvent[];
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
  // F-016: defensive sort — `AlertLog.readRecent` already reverses the
  // last-N-lines slice before returning, so the API is newest-first today.
  // Sorting again is idempotent and pins the UI ordering against any future
  // refactor of `readRecent` that drops or reorders the .reverse() call.
  const sortedEntries = [...entries].sort((a, b) => b.firedAt - a.firedAt);

  return (
    <Card padding="sm">
      <Eyebrow className="mb-2">Recent Alerts</Eyebrow>
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
  if (s.startTime == null) return 0;

  const dayStart = localStartOfDay();
  const dayEnd = dayStart + 86_400_000;

  const start = s.startTime;
  const end =
    typeof s.endTime === 'number'
      ? s.endTime
      : typeof s.durationMs === 'number'
        ? s.startTime + s.durationMs
        : Date.now(); // live session with no end info: assume still running

  if (end < dayStart) return 0;
  if (start >= dayEnd) return 0;

  if (start >= dayStart && end < dayEnd) return cost;

  const overlapMs = Math.min(end, dayEnd) - Math.max(start, dayStart);
  const totalMs = Math.max(1, end - start);
  return cost * (overlapMs / totalMs);
}

function computeTodaySpend(sessions: SessionSummary[]): number {
  let total = 0;
  for (const s of sessions) total += todayPortionOfSession(s);
  return total;
}

function computeTodayToolCalls(sessions: SessionSummary[]): number {
  let total = 0;
  for (const s of sessions) {
    // isToday fast-path includes sessions that started today regardless of cost
    // (cost may be null before token data arrives). todayPortionOfSession > 0
    // additionally picks up cross-midnight sessions with non-null cost.
    if ((s.startTime && isToday(s.startTime)) || todayPortionOfSession(s) > 0) {
      total += s.toolCallCount ?? 0;
    }
  }
  return total;
}

function computeTodayFlags(sessions: SessionSummary[]): number {
  let total = 0;
  for (const s of sessions) {
    if ((s.startTime && isToday(s.startTime)) || todayPortionOfSession(s) > 0) {
      total += s.antiPatterns?.length ?? 0;
    }
  }
  return total;
}

function buildHourlySpend(sessions: SessionSummary[]): HourlyCostEntry[] {
  // The /api/sessions route always injects the live session with its current
  // in-memory cost (when not yet persisted) or returns the persisted entry
  // (when already on disk). Either way the live session is represented once in
  // `sessions`, so no separate currentSessionCost addition is needed — adding
  // it separately caused the live session's cost to be counted twice.
  const buckets = new Array<number>(24).fill(0);
  for (const s of sessions) {
    if (!s.startTime || !isToday(s.startTime) || s.estimatedCostUsd == null) continue;
    const hour = new Date(s.startTime).getHours();
    buckets[hour]! += s.estimatedCostUsd;
  }
  return buckets.map((cost, hour) => ({ hour, cost }));
}

function ForecastEodCard({
  todayTotal,
  forecastEod,
  hourlySpend,
}: {
  todayTotal: number;
  forecastEod: number | null;
  hourlySpend: HourlyCostEntry[];
}): JSX.Element {
  const hasForecast = forecastEod !== null && Number.isFinite(forecastEod);
  const effectiveForecast = hasForecast ? Math.max(forecastEod, todayTotal) : 0;
  const delta = hasForecast ? effectiveForecast - todayTotal : 0;
  const pct = hasForecast && todayTotal > 0 ? (delta / todayTotal) * 100 : 0;
  const hasSpend = hourlySpend.some((h) => h.cost > 0);

  return (
    <Card padding="sm" className="mb-3 h-full">
      <Eyebrow className="mb-1.5">Forecast · End of Day</Eyebrow>
      {hasForecast ? (
        <>
          <div className="flex items-baseline gap-3">
            <span className="text-lg font-semibold text-accent-cyan tabular-nums">
              ${effectiveForecast.toFixed(2)}
            </span>
            <span className="text-xs text-ink-muted tabular-nums">
              {delta > 0 ? (
                <>
                  +${delta.toFixed(2)}
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
            </div>
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
