import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLiveStore, type AlertEvent } from '../store/liveStore';
import { Kpi } from '../components/Kpi';
import { Sparkline } from '../components/Sparkline';
import { fetchRecentAlerts, qk } from '../api/client';

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

export function Today(): JSX.Element {
  const recent = useLiveStore((s) => s.recentToolCalls);
  const cost = useLiveStore((s) => s.cost);
  const antiPatterns = useLiveStore((s) => s.antiPatterns);

  const calls = recent.length;
  const todayTotal = cost?.todayTotalUsd ?? 0;
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
        <Kpi label="eff." tone="good" value="—" sub="needs more data" />
        <Kpi
          label="flags"
          tone={antiPatterns.length > 0 ? 'warn' : 'neutral'}
          value={String(antiPatterns.length)}
        />
      </div>

      <ForecastEodCard todayTotal={todayTotal} forecastEod={cost?.forecastEodUsd ?? null} />

      {antiPatterns.length > 0 && (
        <div className="mb-3 bg-bg-panel border border-accent-amber/40 rounded p-2.5 text-xs">
          <span className="text-accent-amber font-semibold">⚠ {antiPatterns[0].type}</span>
          <span className="text-ink-muted"> — </span>
          <span>{antiPatterns[0].count}× re-edits to </span>
          <code className="bg-bg-line px-1 rounded">{antiPatterns[0].target}</code>
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
        {recent.length === 0 ? (
          <div className="text-ink-muted text-xs">No calls yet — start a Claude prompt.</div>
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

function RecentAlertsPanel(): JSX.Element {
  const { data, isLoading, error } = useQuery<readonly AlertEvent[]>({
    queryKey: qk.alertsRecent,
    queryFn: () => fetchRecentAlerts() as Promise<readonly AlertEvent[]>,
    refetchInterval: RECENT_ALERTS_REFETCH_MS,
  });

  const entries = data ?? [];

  return (
    <div className="bg-bg-panel border border-bg-line rounded p-3">
      <div className="text-[10px] text-ink-muted uppercase tracking-wider mb-2">
        recent alerts
      </div>
      {isLoading && <div className="text-ink-muted text-xs">Loading…</div>}
      {error && <div className="text-accent-red text-xs">Error loading recent alerts.</div>}
      {!isLoading && !error && entries.length === 0 && (
        <div className="text-ink-muted text-xs">No alerts in recent history.</div>
      )}
      {!isLoading && !error && entries.length > 0 && (
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
            {entries.slice(0, 50).map((a) => (
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
            +${delta.toFixed(2)}
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
