import { useMemo, useState, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { useLiveStore, type AlertEvent } from '../store/liveStore';
import { Kpi } from '../components/Kpi';
import { AnimatedCard } from '../components/AnimatedCard';
import { Sparkline } from '../components/Sparkline';
import { EmptyState } from '../components/EmptyState';
import { GanttTimeline } from '../components/GanttTimeline';
import { ConcurrencyIndicator, type ConcurrencyData } from '../components/ConcurrencyIndicator';
import { ActivityHeatmap } from '../components/ActivityHeatmap';
import { GeoBanner } from '../components/GeoBanner';
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
  NotFoundError,
  qk,
} from '../api/client';
import { formatNumber, shortToolName } from '../lib/format';

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
}

interface HeatmapApiResponse {
  readonly buckets: number[];
  readonly bucketSizeMs: number;
  readonly startTimestamp: number;
  readonly maxCount: number;
}

// Minimal view of the /api/session/current payload. F-050 added
// efficiencyScore; the model-health card consumes toolSuccessRate +
// toolCallCount + toolErrorCount from the same endpoint.
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

  const { data: costApi, isPending: costPending } = useQuery<CostApiResponse>({
    queryKey: qk.cost,
    queryFn: () => fetchCost() as Promise<CostApiResponse>,
  });
  const { data: sessionCurrent } = useQuery<SessionCurrentApiResponse>({
    queryKey: qk.sessionCurrent,
    queryFn: () => fetchSessionCurrent() as Promise<SessionCurrentApiResponse>,
    refetchInterval: 10_000,
  });
  const { data: todaySessions, isPending: sessionsPending } = useQuery<SessionSummary[]>({
    queryKey: qk.sessionsList(200),
    queryFn: () => fetchSessionsList(200) as Promise<SessionSummary[]>,
  });
  const { data: apiAntiPatterns } = useQuery<SessionAntiPattern[]>({
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

  const modelHealth = useMemo(
    () =>
      computeModelHealth(
        costApi?.cost?.model ?? null,
        sessionCurrent?.toolSuccessRate ?? null,
        sessionCurrent?.toolErrorCount ?? 0,
        todaySessions ?? [],
      ),
    [
      costApi?.cost?.model,
      sessionCurrent?.toolSuccessRate,
      sessionCurrent?.toolErrorCount,
      todaySessions,
    ],
  );

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

  const calls = persistedTodayCalls;
  const spendLoading = (costPending || sessionsPending) && !cost && persistedTodaySpend === 0;
  // The sessions list API already includes the live session with its current
  // cost, so persistedTodaySpend covers all sessions including the active one.
  // Take the max of SSE-pushed total (which may be more current) vs. the REST
  // sum to handle startup lag in either direction.
  const todayTotal = Math.max(cost?.todayTotalUsd ?? 0, persistedTodaySpend);

  const currentSessionFlags = Math.max(apiAntiPatterns?.length ?? 0, antiPatterns.length);
  const flagsCount = persistedTodayFlags + currentSessionFlags;
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

  return (
    <section>
      <GeoBanner />
      <header className="flex items-baseline justify-between mb-4">
        <h1 className="text-xl font-semibold gradient-text">Today</h1>
        <span className="text-xs text-ink-muted">{headerTimestamp}</span>
      </header>

      <AnimatedCard index={0} className="glass-card glow-green p-5 mb-4">
        <div className="grid grid-cols-4 gap-6">
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
      </AnimatedCard>

      <AnimatedCard index={1}>
        <ModelHealthCard health={modelHealth} />
      </AnimatedCard>

      <AnimatedCard index={2} className="grid grid-cols-2 gap-3 mb-3">
        <ForecastEodCard
          todayTotal={todayTotal}
          forecastEod={
            spendLoading
              ? null
              : (cost?.forecastEodUsd ??
                (costApi?.forecast?.forecastEndOfDayUsd != null
                  ? persistedTodaySpend + costApi.forecast.forecastEndOfDayUsd
                  : null))
          }
          spendPoints={buildSpendSparkline(
            todaySessions ?? [],
            costApi?.cost?.sessionTotalCostUsd ?? 0,
          )}
        />
        {concurrency && (
          <ConcurrencyIndicator
            current={concurrency.current}
            peak={concurrency.peak}
            timeSeries={concurrency.timeSeries}
          />
        )}
      </AnimatedCard>

      {flagsCount > 0 &&
        (antiPatterns.length > 0 || (apiAntiPatterns && apiAntiPatterns.length > 0)) && (
          <AnimatedCard index={3} className="mb-3 glass-card border-accent-amber/40 p-2.5 text-xs">
            {antiPatterns.length > 0 ? (
              <>
                <span className="text-accent-amber font-semibold">⚠ {antiPatterns[0].type}</span>
                <span className="text-ink-muted"> — </span>
                <span>{antiPatterns[0].count}× on </span>
                <code className="bg-bg-line px-1 rounded">{antiPatterns[0].target}</code>
              </>
            ) : apiAntiPatterns && apiAntiPatterns.length > 0 ? (
              <>
                <span className="text-accent-amber font-semibold">⚠ {apiAntiPatterns[0].type}</span>
                <span className="text-ink-muted"> — </span>
                <span>
                  {apiAntiPatterns[0].count ??
                    apiAntiPatterns[0].iterations ??
                    apiAntiPatterns[0].readCount ??
                    '?'}
                  × on{' '}
                </span>
                <code className="bg-bg-line px-1 rounded">
                  {apiAntiPatterns[0].file ?? apiAntiPatterns[0].command ?? 'unknown'}
                </code>
              </>
            ) : null}
          </AnimatedCard>
        )}

      <AnimatedCard index={4} className="grid grid-cols-2 gap-3 mb-3">
        <QualityProxyPanel />
        <ToolSelectionPanel />
      </AnimatedCard>

      <AnimatedCard index={5}>
        <LiveSessionPane sessions={todaySessions ?? []} />
      </AnimatedCard>

      {todayHeatmap && todayHeatmap.buckets.length > 0 && (
        <AnimatedCard index={6} className="glass-card p-3 mb-3">
          <div className="text-[10px] text-ink-muted uppercase tracking-wider mb-2">
            activity · today
          </div>
          <ActivityHeatmap
            variant="strip"
            buckets={todayHeatmap.buckets}
            maxCount={todayHeatmap.maxCount}
            bucketSizeMs={todayHeatmap.bucketSizeMs}
            startTimestamp={todayHeatmap.startTimestamp}
            ariaLabel="Today's activity density in 15-minute blocks"
          />
        </AnimatedCard>
      )}

      <AnimatedCard index={7}>
        <RecentAlertsPanel />
      </AnimatedCard>
    </section>
  );
}

function rateColor(rate: number | null, goodThreshold = 0.8, warnThreshold = 0.5): string {
  if (rate === null) return 'text-ink-muted';
  if (rate >= goodThreshold) return 'text-green-400';
  if (rate >= warnThreshold) return 'text-amber-400';
  return 'text-red-400';
}

function QualityProxyPanel(): JSX.Element {
  const { data } = useQuery<QualityProxyMetrics>({
    queryKey: qk.qualityProxy,
    queryFn: () => fetchQualityProxy() as Promise<QualityProxyMetrics>,
    refetchInterval: QUALITY_REFETCH_MS,
  });

  return (
    <div className="glass-card p-3">
      <div className="text-[10px] text-ink-muted uppercase tracking-wider mb-2">
        Today · Session Quality
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
              <span className={data.backtrackCount > 0 ? 'text-amber-400' : ''}>
                {data.backtrackCount}
              </span>
            </div>
            <div>
              <span className="text-ink-muted">Self-corrections </span>
              <span className="text-ink-subtle">{data.selfCorrectionCount}</span>
            </div>
          </div>
          {data.degradationDetected && (
            <div className="text-amber-400 text-xs mt-2">&#9888; Quality degrading</div>
          )}
        </>
      )}
    </div>
  );
}

function scoreColor(score: number): string {
  if (score >= 0.8) return 'text-accent-cyan';
  if (score >= 0.5) return 'text-amber-400';
  return 'text-red-400';
}

function ToolSelectionPanel(): JSX.Element {
  const { data } = useQuery<ToolSelectionMetrics>({
    queryKey: qk.toolSelectionScore,
    queryFn: () => fetchToolSelectionScore() as Promise<ToolSelectionMetrics>,
    refetchInterval: QUALITY_REFETCH_MS,
  });

  return (
    <div className="glass-card p-3">
      <div className="text-[10px] text-ink-muted uppercase tracking-wider mb-2">
        Today · Tool Selection
      </div>
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
          <div className="text-[9px] text-ink-subtle/60 mt-2">
            Penalizes: reading the same file 3+ times without editing, repeated tool failures,
            fetching large outputs never referenced.
          </div>
        </>
      )}
    </div>
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

function fmtElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

function LiveSessionPane({ sessions }: { sessions: SessionSummary[] }): JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'gantt' | 'list'>('list');
  const [, navigate] = useLocation();

  const { data: current } = useQuery<{ sessionId: string; liveSessions?: string[] }>({
    queryKey: qk.sessionCurrent,
    queryFn: () => fetchSessionCurrent() as Promise<{ sessionId: string; liveSessions?: string[] }>,
  });

  const liveSessionIds = useMemo(() => {
    const set = new Set<string>();
    if (current?.liveSessions?.length) {
      for (const id of current.liveSessions) set.add(id);
    } else if (current?.sessionId) {
      set.add(current.sessionId);
    }
    return set;
  }, [current]);

  const firstLiveId = liveSessionIds.size > 0 ? [...liveSessionIds][0]! : null;
  const activeId = selectedId ?? firstLiveId;
  const isLive = activeId !== null && liveSessionIds.has(activeId);

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

  // Sort today's sessions by startTime descending (newest first), limit to 10
  const todaySessions = useMemo(() => {
    return sessions
      .filter((s) => s.startTime && isToday(s.startTime))
      .sort((a, b) => (b.startTime ?? 0) - (a.startTime ?? 0))
      .slice(0, 10);
  }, [sessions]);

  const timeline = replay?.timeline ?? [];
  const firstTs = timeline.length > 0 ? timeline[0]!.timestamp : 0;

  return (
    <div
      className="glass-card mb-3 grid grid-cols-[220px_1fr] overflow-hidden"
      style={{ height: '320px' }}
    >
      {/* Session list */}
      <div className="border-r border-bg-line overflow-auto">
        <div className="text-[10px] text-ink-muted uppercase tracking-wider p-2 border-b border-bg-line">
          session live tail
        </div>
        {todaySessions.map((s) => {
          const isSessionLive = liveSessionIds.has(s.sessionId);
          return (
            <button
              key={s.sessionId}
              type="button"
              onClick={() => setSelectedId(s.sessionId)}
              className={
                'block w-full text-left p-2 border-b border-bg-line text-xs hover:bg-bg-line ' +
                (activeId === s.sessionId ? 'bg-bg-line' : '')
              }
            >
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-ink-base">
                  {s.sessionName || s.sessionId.slice(0, 8)}
                </span>
                {isSessionLive ? (
                  <span className="inline-flex items-center gap-0.5 bg-accent-cyan/20 text-accent-cyan text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded">
                    <span className="w-1.5 h-1.5 rounded-full bg-accent-cyan animate-pulse" />
                    live
                  </span>
                ) : (
                  <span className="text-[10px] text-ink-muted">
                    {s.startTime ? fmtTime(s.startTime) : ''}
                  </span>
                )}
              </div>
              <div className="flex gap-2 mt-0.5 text-[10px] text-ink-subtle">
                <span>${(s.estimatedCostUsd ?? 0).toFixed(2)}</span>
                <span>{s.toolCallCount ?? 0} calls</span>
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
          <div className="flex items-center justify-between px-2 py-1 border-b border-bg-line shrink-0">
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => setViewMode('gantt')}
                className={`px-2 py-0.5 rounded-lg text-[10px] ${viewMode === 'gantt' ? 'bg-accent-green/20 text-accent-green font-medium' : 'text-ink-muted hover:text-ink-base'}`}
              >
                Gantt
              </button>
              <button
                type="button"
                onClick={() => setViewMode('list')}
                className={`px-2 py-0.5 rounded-lg text-[10px] ${viewMode === 'list' ? 'bg-accent-green/20 text-accent-green font-medium' : 'text-ink-muted hover:text-ink-base'}`}
              >
                List
              </button>
            </div>
            <button
              type="button"
              onClick={() => navigate(`/sessions?id=${activeId}`)}
              className="text-[10px] text-accent-cyan hover:underline"
            >
              full session &rarr;
            </button>
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
                    className="flex items-center gap-1.5 px-1 py-0.5 text-xs border-b border-bg-line/50 last:border-b-0"
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
                      className="flex-1 truncate text-ink-subtle text-[10px]"
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
      </div>
    </div>
  );
}

function RecentAlertsPanel(): JSX.Element | null {
  // The query returns `null` when the endpoint is 404 (cloud mode — no
  // alert engine), so callers can render an empty / hidden state instead
  // of a permanent red error banner. retry: false avoids the 4× request
  // multiplier React Query would otherwise produce on every refetch.
  // See F-007 in docs/CODE_REVIEW.md.
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
    <div className="glass-card p-3">
      <div className="text-[10px] text-ink-muted uppercase tracking-wider mb-2">recent alerts</div>
      {isLoading && <div className="text-ink-muted text-xs">Loading…</div>}
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
              <tr key={`${a.id}-${a.firedAt}-${a.state}`} className="border-t border-bg-line">
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
    </div>
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

function fmtTime(value: number): string {
  return new Date(value).toLocaleString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function isToday(ts: number): boolean {
  const d = new Date(ts);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

function computeTodaySpend(sessions: SessionSummary[]): number {
  let total = 0;
  for (const s of sessions) {
    if (s.startTime && isToday(s.startTime) && s.estimatedCostUsd != null) {
      total += s.estimatedCostUsd;
    }
  }
  return total;
}

function computeTodayToolCalls(sessions: SessionSummary[]): number {
  let total = 0;
  for (const s of sessions) {
    if (s.startTime && isToday(s.startTime)) {
      total += s.toolCallCount ?? 0;
    }
  }
  return total;
}

function computeTodayFlags(sessions: SessionSummary[]): number {
  let total = 0;
  for (const s of sessions) {
    if (s.startTime && isToday(s.startTime)) {
      total += s.antiPatterns?.length ?? 0;
    }
  }
  return total;
}

export interface ModelHealthResult {
  readonly status: 'healthy' | 'degraded' | 'poor' | 'unknown';
  readonly model: string | null;
  readonly currentRate: number | null;
  readonly baseline: number | null;
  readonly message: string;
}

const MIN_SESSIONS_FOR_BASELINE = 3;
const DEGRADED_THRESHOLD = 0.1;
const POOR_THRESHOLD = 0.2;
const POOR_ERROR_THRESHOLD = 5;

export function computeModelHealth(
  currentModel: string | null,
  currentSuccessRate: number | null,
  currentErrorCount: number,
  sessions: SessionSummary[],
): ModelHealthResult {
  if (!currentModel || currentSuccessRate === null) {
    return {
      status: 'unknown',
      model: currentModel,
      currentRate: null,
      baseline: null,
      message: 'Waiting for data…',
    };
  }

  const modelSessions = sessions.filter(
    (s) => s.model === currentModel && s.toolSuccessRate != null,
  );
  const baseline =
    modelSessions.length >= MIN_SESSIONS_FOR_BASELINE
      ? modelSessions.reduce((sum, s) => sum + (s.toolSuccessRate ?? 0), 0) / modelSessions.length
      : null;

  if (baseline === null) {
    const pct = Math.round(currentSuccessRate * 100);
    return {
      status: 'healthy',
      model: currentModel,
      currentRate: currentSuccessRate,
      baseline: null,
      message: `${pct}% success`,
    };
  }

  const gap = baseline - currentSuccessRate;

  if (gap > POOR_THRESHOLD || currentErrorCount > POOR_ERROR_THRESHOLD) {
    const pct = Math.round(currentSuccessRate * 100);
    const basePct = Math.round(baseline * 100);
    return {
      status: 'poor',
      model: currentModel,
      currentRate: currentSuccessRate,
      baseline,
      message: `${pct}% success (avg ${basePct}%) — consider switching models`,
    };
  }

  if (gap > DEGRADED_THRESHOLD) {
    const pct = Math.round(currentSuccessRate * 100);
    const basePct = Math.round(baseline * 100);
    return {
      status: 'degraded',
      model: currentModel,
      currentRate: currentSuccessRate,
      baseline,
      message: `${pct}% success (avg ${basePct}%) — may be throttled`,
    };
  }

  const pct = Math.round(currentSuccessRate * 100);
  return {
    status: 'healthy',
    model: currentModel,
    currentRate: currentSuccessRate,
    baseline,
    message: `${pct}% success`,
  };
}

const HEALTH_STYLE: Record<ModelHealthResult['status'], { dot: string }> = {
  healthy: { dot: 'text-emerald-400' },
  degraded: { dot: 'text-accent-amber' },
  poor: { dot: 'text-accent-red' },
  unknown: { dot: 'text-ink-muted' },
};

function ModelHealthCard({ health }: { health: ModelHealthResult }): JSX.Element {
  const style = HEALTH_STYLE[health.status];
  return (
    <div className={`glass-card p-2.5 mb-3`}>
      <div className="flex items-center gap-2 text-xs">
        <span className={style.dot} aria-hidden="true">
          ●
        </span>
        <span className="font-medium text-ink-default">{health.model ?? 'unknown model'}</span>
        <span className="text-ink-muted">·</span>
        <span className="text-ink-subtle">{health.message}</span>
      </div>
    </div>
  );
}

function buildSpendSparkline(sessions: SessionSummary[], currentSessionCost: number): number[] {
  const todaySorted = sessions
    .filter((s) => s.startTime && isToday(s.startTime) && s.estimatedCostUsd != null)
    .sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0));

  if (todaySorted.length === 0 && currentSessionCost <= 0) return [];

  const points: number[] = [0];
  let cumulative = 0;
  for (const s of todaySorted) {
    cumulative += s.estimatedCostUsd ?? 0;
    points.push(cumulative);
  }
  if (currentSessionCost > 0) {
    points.push(cumulative + currentSessionCost);
  }
  return points;
}

function ForecastEodCard({
  todayTotal,
  forecastEod,
  spendPoints,
}: {
  todayTotal: number;
  forecastEod: number | null;
  spendPoints: number[];
}): JSX.Element {
  const hasForecast = forecastEod !== null && Number.isFinite(forecastEod);
  const effectiveForecast = hasForecast ? Math.max(forecastEod, todayTotal) : 0;
  const delta = hasForecast ? effectiveForecast - todayTotal : 0;
  const pct = hasForecast && todayTotal > 0 ? (delta / todayTotal) * 100 : 0;

  return (
    <div className="glass-card p-3 mb-3">
      <div className="text-[10px] text-ink-muted uppercase tracking-wider mb-1.5">
        forecast · end of day
      </div>
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
          {spendPoints.length >= 2 && (
            <div className="mt-2">
              <Sparkline values={spendPoints} height={36} animate ariaLabel="Today spend" />
            </div>
          )}
        </>
      ) : (
        <div className="text-ink-muted text-xs">
          Insufficient data — forecast appears once burn rate stabilizes.
        </div>
      )}
    </div>
  );
}
