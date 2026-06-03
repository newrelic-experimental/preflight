import { useMemo, useState, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { useLiveStore, type AlertEvent } from '../store/liveStore';
import { Kpi } from '../components/Kpi';
import {
  fetchRecentAlerts,
  fetchCost,
  fetchSessionCurrent,
  fetchSessionsList,
  fetchSessionReplay,
  fetchAntiPatterns,
  fetchQualityProxy,
  fetchToolSelectionScore,
  NotFoundError,
  qk,
} from '../api/client';
import { formatNumber } from '../lib/format';

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
  readonly cost: { readonly sessionTotalCostUsd?: number | null };
  readonly forecast: { readonly forecastEndOfDayUsd?: number | null } | null;
}

// F-050: minimal shape — only the field this view consumes. The endpoint
// also returns the live SessionMetrics; we don't depend on those here.
interface SessionCurrentApiResponse {
  readonly efficiencyScore?: number | null;
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
  readonly startTime?: number;
  readonly toolCallCount?: number;
  readonly estimatedCostUsd?: number | null;
  readonly antiPatterns?: SessionAntiPattern[];
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
  });
  const { data: todaySessions, isPending: sessionsPending } = useQuery<SessionSummary[]>({
    queryKey: qk.sessionsList(200),
    queryFn: () => fetchSessionsList(200) as Promise<SessionSummary[]>,
  });
  const { data: apiAntiPatterns } = useQuery<SessionAntiPattern[]>({
    queryKey: qk.antiPatterns,
    queryFn: () => fetchAntiPatterns() as Promise<SessionAntiPattern[]>,
  });

  const persistedTodaySpend = useMemo(() => computeTodaySpend(todaySessions ?? []), [todaySessions]);
  const persistedTodayCalls = useMemo(() => computeTodayToolCalls(todaySessions ?? []), [todaySessions]);
  const persistedTodayFlags = useMemo(() => computeTodayFlags(todaySessions ?? []), [todaySessions]);

  const calls = persistedTodayCalls;
  const spendLoading = !cost && costPending && sessionsPending;
  const todayTotal = cost?.todayTotalUsd
    ?? (persistedTodaySpend + (costApi?.cost?.sessionTotalCostUsd ?? 0));

  const currentSessionFlags = Math.max(apiAntiPatterns?.length ?? 0, antiPatterns.length);
  const flagsCount = persistedTodayFlags + currentSessionFlags;
  const headerTimestamp = useMemo(
    () => new Date().toLocaleString(undefined, HEADER_TIMESTAMP_FORMAT),
    [],
  );

  return (
    <section>
      <header className="flex items-baseline justify-between mb-4">
        <h1 className="text-xl font-semibold">Today</h1>
        <span className="text-xs text-ink-muted">{headerTimestamp}</span>
      </header>

      <div className="grid grid-cols-4 gap-2 mb-3">
        <Kpi label="spend" tone="accent" value={spendLoading ? '…' : `$${todayTotal.toFixed(2)}`} />
        <Kpi label="calls" value={String(calls)} />
        <EfficiencyKpi score={sessionCurrent?.efficiencyScore ?? null} />
        <Kpi
          label="flags"
          tone={flagsCount > 0 ? 'warn' : 'neutral'}
          value={String(flagsCount)}
        />
      </div>

      <ForecastEodCard todayTotal={todayTotal} forecastEod={spendLoading ? null : (cost?.forecastEodUsd ?? costApi?.forecast?.forecastEndOfDayUsd ?? null)} />

      {flagsCount > 0 && (
        <div className="mb-3 bg-bg-panel border border-accent-amber/40 rounded p-2.5 text-xs">
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
              <span>{apiAntiPatterns[0].count ?? apiAntiPatterns[0].iterations ?? apiAntiPatterns[0].readCount ?? '?'}× on </span>
              <code className="bg-bg-line px-1 rounded">{apiAntiPatterns[0].file ?? apiAntiPatterns[0].command ?? 'unknown'}</code>
            </>
          ) : null}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 mb-3">
        <QualityProxyPanel />
        <ToolSelectionPanel />
      </div>

      <LiveSessionPane sessions={todaySessions ?? []} />

      <RecentAlertsPanel />
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
    <div className="bg-bg-panel border border-bg-line rounded p-3">
      <div className="text-[10px] text-ink-muted uppercase tracking-wider mb-2">
        Today · Session Quality
      </div>
      {!data || data.totalSignals === 0 ? (
        <div className="text-ink-muted text-xs">Waiting for edits and test runs…</div>
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
            <div className="text-amber-400 text-xs mt-2">
              &#9888; Quality degrading
            </div>
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
    <div className="bg-bg-panel border border-bg-line rounded p-3">
      <div className="text-[10px] text-ink-muted uppercase tracking-wider mb-2">
        Today · Tool Selection
      </div>
      {!data || data.totalCalls === 0 ? (
        <div className="text-ink-muted text-xs">Waiting for tool calls…</div>
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
          {(data.redundantReadCount > 0 || data.repeatedFailureCount > 0 || data.unusedOutputCount > 0) && (
            <div className="text-[10px] text-ink-subtle mt-1 space-x-2">
              {data.redundantReadCount > 0 && <span>re-reads: {data.redundantReadCount}</span>}
              {data.repeatedFailureCount > 0 && <span>repeat fails: {data.repeatedFailureCount}</span>}
              {data.unusedOutputCount > 0 && <span>unused output: {data.unusedOutputCount}</span>}
            </div>
          )}
          <div className="text-[9px] text-ink-subtle/60 mt-2">
            Penalizes: reading the same file 3+ times without editing, repeated tool failures, fetching large outputs never referenced.
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

interface ReplayData {
  readonly sessionId: string;
  readonly timeline: ReplayTimelineEntry[];
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
  const [, navigate] = useLocation();

  const { data: current } = useQuery<{ sessionId: string }>({
    queryKey: qk.sessionCurrent,
    queryFn: () => fetchSessionCurrent() as Promise<{ sessionId: string }>,
  });

  const liveSessionId = current?.sessionId ?? null;
  const activeId = selectedId ?? liveSessionId;
  const isLive = activeId !== null && activeId === liveSessionId;

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
    <div className="bg-bg-panel border border-bg-line rounded mb-3 grid grid-cols-[220px_1fr] overflow-hidden" style={{ height: '320px' }}>
      {/* Session list */}
      <div className="border-r border-bg-line overflow-auto">
        <div className="text-[10px] text-ink-muted uppercase tracking-wider p-2 border-b border-bg-line">
          session live tail
        </div>
        {liveSessionId && (
          <button
            type="button"
            onClick={() => setSelectedId(liveSessionId)}
            className={
              'block w-full text-left p-2 border-b border-bg-line text-xs hover:bg-bg-line ' +
              (activeId === liveSessionId ? 'bg-bg-line' : '')
            }
          >
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-ink-base">{liveSessionId.slice(0, 8)}</span>
              <span className="inline-flex items-center gap-0.5 bg-accent-cyan/20 text-accent-cyan text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded">
                <span className="w-1.5 h-1.5 rounded-full bg-accent-cyan animate-pulse" />
                live
              </span>
            </div>
            <div className="flex gap-2 mt-0.5 text-[10px] text-ink-subtle">
              <span>${(sessions.find((s) => s.sessionId === liveSessionId)?.estimatedCostUsd ?? 0).toFixed(2)}</span>
              <span>{sessions.find((s) => s.sessionId === liveSessionId)?.toolCallCount ?? 0} calls</span>
            </div>
          </button>
        )}
        {todaySessions.map((s) => {
          if (s.sessionId === liveSessionId) return null;
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
                <span className="font-mono text-ink-base">{s.sessionId.slice(0, 8)}</span>
                <span className="text-[10px] text-ink-muted">{s.startTime ? fmtTime(s.startTime) : ''}</span>
              </div>
              <div className="flex gap-2 mt-0.5 text-[10px] text-ink-subtle">
                <span>${(s.estimatedCostUsd ?? 0).toFixed(2)}</span>
                <span>{s.toolCallCount ?? 0} calls</span>
              </div>
            </button>
          );
        })}
        {!liveSessionId && todaySessions.length === 0 && (
          <div className="p-2 text-ink-muted text-xs">No sessions today.</div>
        )}
      </div>

      {/* Live tail */}
      <div className="flex flex-col overflow-hidden">
        {activeId && (
          <div className="flex justify-end px-2 py-1 border-b border-bg-line shrink-0">
            <button
              type="button"
              onClick={() => navigate(`/replay/${activeId}`)}
              className="text-[10px] text-accent-cyan hover:underline"
            >
              full replay &rarr;
            </button>
          </div>
        )}
        <div ref={tailRef} className="overflow-auto flex-1 p-2">
          {!activeId && (
            <div className="text-ink-muted text-xs p-2">Select a session to view its timeline.</div>
          )}
          {activeId && timeline.length === 0 && (
            <div className="text-ink-muted text-xs p-2">
              {isLive ? 'Waiting for tool calls…' : 'No tool calls in this session.'}
            </div>
          )}
          {timeline.length > 0 && (
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
                    <span className="w-24 truncate font-medium text-ink-base text-[11px]">
                      {entry.toolName}
                    </span>
                    <span className="flex-1 truncate text-ink-subtle text-[10px]">
                      {entry.filePath ?? entry.command ?? ''}
                    </span>
                    <span className="w-12 text-right tabular-nums text-ink-muted text-[10px]">
                      {entry.durationMs != null ? `${entry.durationMs}ms` : ''}
                    </span>
                    <span className={`w-3 text-center text-[10px] ${entry.success ? 'text-accent-green' : 'text-accent-red'}`}>
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
    <div className="bg-bg-panel border border-bg-line rounded p-3">
      <div className="text-[10px] text-ink-muted uppercase tracking-wider mb-2">
        recent alerts
      </div>
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
                    'py-1 pl-2 ' +
                    (a.state === 'firing' ? 'text-accent-amber' : 'text-ink-muted')
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

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 100) return n.toFixed(0);
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2);
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
  return d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
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

// F-050: small wrapper that picks tone from the score. The score itself is
// a unitless [0, 1] composite computed by EfficiencyScorer on the server;
// we render it as a percentage so the KPI is legible at a glance.
function EfficiencyKpi({ score }: { score: number | null }): JSX.Element {
  if (score === null || !Number.isFinite(score)) {
    return <Kpi label="eff." tone="good" value="—" sub="needs more data" />;
  }
  const pct = Math.round(score * 100);
  // Bands match the EfficiencyScorer narrative: ≥80% strong, ≥50% mixed, <50% poor.
  const tone: 'good' | 'warn' | 'accent' = pct >= 80 ? 'good' : pct >= 50 ? 'accent' : 'warn';
  return <Kpi label="eff." tone={tone} value={`${pct}%`} />;
}

function ForecastEodCard({
  todayTotal,
  forecastEod,
}: {
  todayTotal: number;
  forecastEod: number | null;
}): JSX.Element {
  const hasForecast = forecastEod !== null && Number.isFinite(forecastEod);
  // The forecast is based on the live session's burn rate. If the MCP server
  // restarted mid-day the forecast only reflects the current session and can be
  // lower than the already-observed spend. Use todayTotal as the floor so the
  // card never shows a nonsensical "negative remaining" projection.
  const effectiveForecast = hasForecast ? Math.max(forecastEod, todayTotal) : 0;
  const delta = hasForecast ? effectiveForecast - todayTotal : 0;
  const pct = hasForecast && todayTotal > 0 ? (delta / todayTotal) * 100 : 0;

  return (
    <div className="bg-bg-panel border border-bg-line rounded p-3 mb-3">
      <div className="text-[10px] text-ink-muted uppercase tracking-wider mb-1.5">
        forecast · end of day
      </div>
      {hasForecast ? (
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
      ) : (
        <div className="text-ink-muted text-xs">
          Insufficient data — forecast appears once burn rate stabilizes.
        </div>
      )}
    </div>
  );
}
