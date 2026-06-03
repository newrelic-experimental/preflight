import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLiveStore, type AlertEvent } from '../store/liveStore';
import { Kpi } from '../components/Kpi';
import { Sparkline } from '../components/Sparkline';
import {
  fetchRecentAlerts,
  fetchCost,
  fetchSessionCurrent,
  fetchSessionsList,
  fetchAntiPatterns,
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

export function Today(): JSX.Element {
  const recent = useLiveStore((s) => s.recentToolCalls);
  const cost = useLiveStore((s) => s.cost);
  const antiPatterns = useLiveStore((s) => s.antiPatterns);

  const { data: costApi } = useQuery<CostApiResponse>({
    queryKey: qk.cost,
    queryFn: () => fetchCost() as Promise<CostApiResponse>,
  });
  const { data: sessionCurrent } = useQuery<SessionCurrentApiResponse>({
    queryKey: qk.sessionCurrent,
    queryFn: () => fetchSessionCurrent() as Promise<SessionCurrentApiResponse>,
  });
  const { data: todaySessions } = useQuery<SessionSummary[]>({
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

  const calls = persistedTodayCalls + recent.length;
  // SSE cost-update includes persisted + live; use it when available.
  // Fallback: persisted sessions + current session cost from the REST API
  // (the current session isn't in the sessions list until shutdown).
  const todayTotal = cost?.todayTotalUsd
    ?? (persistedTodaySpend + (costApi?.cost?.sessionTotalCostUsd ?? 0));

  // Flags = past sessions today (from session list) + current session (from
  // anti-patterns API, which is authoritative and survives refresh). SSE
  // pushes update live but reset on reload, so use API as floor.
  const currentSessionFlags = Math.max(apiAntiPatterns?.length ?? 0, antiPatterns.length);
  const flagsCount = persistedTodayFlags + currentSessionFlags;
  const sparklineValues = useMemo(() => recent.map((c) => c.durationMs), [recent]);
  const headerTimestamp = useMemo(
    () => new Date().toLocaleString(undefined, HEADER_TIMESTAMP_FORMAT),
    [],
  );
  const recentReversed = useMemo(() => recent.slice().reverse(), [recent]);

  return (
    <section>
      <header className="flex items-baseline justify-between mb-4">
        <h1 className="text-xl font-semibold">Today</h1>
        <span className="text-xs text-ink-muted">{headerTimestamp}</span>
      </header>

      <div className="grid grid-cols-4 gap-2 mb-3">
        <Kpi label="spend" tone="accent" value={`$${todayTotal.toFixed(2)}`} />
        <Kpi label="calls" value={String(calls)} />
        <EfficiencyKpi score={sessionCurrent?.efficiencyScore ?? null} />
        <Kpi
          label="flags"
          tone={flagsCount > 0 ? 'warn' : 'neutral'}
          value={String(flagsCount)}
        />
      </div>

      <ForecastEodCard todayTotal={todayTotal} forecastEod={cost?.forecastEodUsd ?? costApi?.forecast?.forecastEndOfDayUsd ?? null} />

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

      <div className="bg-bg-panel border border-bg-line rounded p-3 mb-3">
        <div className="text-[10px] text-ink-muted uppercase tracking-wider mb-1.5">
          tool latency · live
        </div>
        {sparklineValues.length >= 2 ? (
          <Sparkline values={sparklineValues} ariaLabel="Tool call latency, milliseconds" />
        ) : (
          <div className="text-ink-muted text-xs h-[50px] flex items-center">
            Waiting for tool calls…
          </div>
        )}
      </div>

      <div className="bg-bg-panel border border-bg-line rounded p-3 mb-3">
        <div className="text-[10px] text-ink-muted uppercase tracking-wider mb-2">recent</div>
        {recent.length === 0 && calls === 0 ? (
          <div className="text-ink-muted text-xs">No calls yet — start a Claude prompt.</div>
        ) : recent.length === 0 ? (
          <div className="text-ink-muted text-xs">
            {calls} tool calls recorded today · waiting for live events…
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-ink-muted">
              <tr>
                <th className="text-left pb-1">tool</th>
                <th className="text-right pb-1">latency</th>
              </tr>
            </thead>
            <tbody>
              {recentReversed.map((c) => (
                <tr key={c.id} className="border-t border-bg-line">
                  <td className="py-1">{c.tool}</td>
                  <td className="py-1 text-right tabular-nums">{c.durationMs} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <RecentAlertsPanel />
    </section>
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
  const delta = hasForecast ? forecastEod - todayTotal : 0;
  const pct = hasForecast && todayTotal > 0 ? (delta / todayTotal) * 100 : 0;

  return (
    <div className="bg-bg-panel border border-bg-line rounded p-3 mb-3">
      <div className="text-[10px] text-ink-muted uppercase tracking-wider mb-1.5">
        forecast · end of day
      </div>
      {hasForecast ? (
        <div className="flex items-baseline gap-3">
          <span className="text-lg font-semibold text-accent-cyan tabular-nums">
            ${forecastEod.toFixed(2)}
          </span>
          <span className="text-xs text-ink-muted tabular-nums">
            {/* F-017: render the sign explicitly and use the absolute value
                so a negative delta renders as `-$1.23`, never `+$-1.23`. */}
            {delta >= 0 ? '+' : '−'}${Math.abs(delta).toFixed(2)}
            {todayTotal > 0 && ` (${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%)`} from now
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
