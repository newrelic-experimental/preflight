import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { fetchSessionsList, fetchSessionCurrent, fetchSessionDetail, qk } from '../api/client';

// F-051: keep the query limit and the "showing N most recent" notice in
// lock-step. If you bump this, also update the api-handler clamp upper
// bound if you intend to allow more than the current 500 ceiling.
const SESSIONS_PAGE_SIZE = 50;

interface SessionRow {
  readonly sessionId: string;
  readonly startTime?: string | number;
  readonly toolCallCount?: number;
  readonly estimatedCostUsd?: number | null;
  readonly outcome?: string | null;
}

interface CurrentSession {
  readonly sessionId: string;
  readonly sessionStartTime?: number;
  readonly toolCallCount?: number;
}

interface TimelineEntry {
  readonly timestamp: number;
  readonly toolName: string;
  readonly durationMs: number | null;
  readonly success: boolean;
  readonly filePath?: string;
  readonly command?: string;
}

interface SessionDetail {
  readonly sessionId: string;
  readonly toolCallCount?: number;
  readonly durationMs?: number;
  readonly estimatedCostUsd?: number | null;
  readonly model?: string | null;
  readonly outcome?: string;
  readonly toolBreakdown?: Record<string, number>;
  readonly filesRead?: string[];
  readonly filesModified?: string[];
  readonly antiPatterns?: Array<{ type: string; count: number }>;
  readonly timeline?: ReadonlyArray<TimelineEntry>;
}

type SortKey = 'date' | 'cost' | 'calls';

function fmtTime(value: string | number): string {
  const d = typeof value === 'number' ? new Date(value) : new Date(value);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function sortSessions(rows: SessionRow[], key: SortKey): SessionRow[] {
  const sorted = [...rows];
  switch (key) {
    case 'date':
      sorted.sort((a, b) => {
        const ta = typeof a.startTime === 'number' ? a.startTime : new Date(a.startTime ?? 0).getTime();
        const tb = typeof b.startTime === 'number' ? b.startTime : new Date(b.startTime ?? 0).getTime();
        return tb - ta;
      });
      break;
    case 'cost':
      sorted.sort((a, b) => (b.estimatedCostUsd ?? 0) - (a.estimatedCostUsd ?? 0));
      break;
    case 'calls':
      sorted.sort((a, b) => (b.toolCallCount ?? 0) - (a.toolCallCount ?? 0));
      break;
  }
  return sorted;
}

export function Sessions(): JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [, navigate] = useLocation();

  const list = useQuery<SessionRow[]>({
    queryKey: qk.sessionsList(SESSIONS_PAGE_SIZE),
    queryFn: () => fetchSessionsList(SESSIONS_PAGE_SIZE) as Promise<SessionRow[]>,
  });

  const current = useQuery<CurrentSession>({
    queryKey: qk.sessionCurrent,
    queryFn: () => fetchSessionCurrent() as Promise<CurrentSession>,
  });

  const detail = useQuery<SessionDetail>({
    queryKey: selectedId ? qk.sessionDetail(selectedId) : ['session', 'none'],
    queryFn: () => fetchSessionDetail(selectedId!) as Promise<SessionDetail>,
    enabled: selectedId !== null,
  });

  const liveSessionId = current.data?.sessionId ?? null;

  const rows = useMemo(() => {
    const persisted = list.data ?? [];
    return sortSessions(persisted, sortKey);
  }, [list.data, sortKey]);

  const handleSessionClick = (sessionId: string): void => {
    if (sessionId === liveSessionId) {
      navigate(`/replay/${sessionId}`);
    } else {
      setSelectedId(sessionId);
    }
  };

  return (
    <section className="grid grid-cols-[260px_1fr] gap-3 h-full">
      <aside className="bg-bg-panel border border-bg-line rounded overflow-hidden flex flex-col">
        <header className="p-2 border-b border-bg-line">
          <div className="flex items-center justify-between">
            <h2 className="text-xs uppercase tracking-wider text-ink-muted">Sessions</h2>
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              className="text-[10px] bg-bg-base border border-bg-line rounded px-1.5 py-0.5 text-ink-subtle"
            >
              <option value="date">Newest</option>
              <option value="cost">Cost</option>
              <option value="calls">Calls</option>
            </select>
          </div>
        </header>
        <div className="overflow-auto">
          {/* Live session pinned at top */}
          {liveSessionId && (
            <button
              key={liveSessionId}
              type="button"
              onClick={() => handleSessionClick(liveSessionId)}
              className={
                'block w-full text-left p-2 border-b border-bg-line text-xs hover:bg-bg-line ' +
                (selectedId === liveSessionId ? 'bg-bg-line' : '')
              }
            >
              <div className="flex justify-between items-center">
                <span className="flex items-center gap-1.5">
                  <span className="font-mono text-ink-base">{liveSessionId.slice(0, 8)}</span>
                  <span className="inline-flex items-center gap-0.5 bg-accent-cyan/20 text-accent-cyan text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded">
                    <span className="w-1.5 h-1.5 rounded-full bg-accent-cyan animate-pulse" />
                    live
                  </span>
                </span>
                <span className="text-ink-muted">
                  {current.data?.sessionStartTime ? fmtTime(current.data.sessionStartTime) : 'now'}
                </span>
              </div>
              <div className="flex justify-between mt-1 text-ink-subtle text-[11px]">
                <span>{current.data?.toolCallCount ?? 0} calls</span>
                <span className="text-accent-cyan">replay →</span>
              </div>
            </button>
          )}

          {list.isLoading && <div className="p-3 text-ink-muted text-xs">Loading…</div>}
          {!list.isLoading && rows.length === 0 && !liveSessionId && (
            <div className="p-3 text-ink-muted text-xs">
              No sessions yet — start coding with Claude.
            </div>
          )}
          {rows.map((r) => {
            if (r.sessionId === liveSessionId) return null;
            return (
              <button
                key={r.sessionId}
                type="button"
                onClick={() => handleSessionClick(r.sessionId)}
                className={
                  'block w-full text-left p-2 border-b border-bg-line text-xs hover:bg-bg-line ' +
                  (selectedId === r.sessionId ? 'bg-bg-line' : '')
                }
              >
                <div className="flex justify-between">
                  <span className="font-mono text-ink-base">{r.sessionId.slice(0, 8)}</span>
                  <span className="text-ink-muted">{r.startTime ? fmtTime(r.startTime) : '—'}</span>
                </div>
                <div className="flex justify-between mt-1 text-ink-subtle text-[11px]">
                  <span>{r.toolCallCount ?? 0} calls</span>
                  <span>
                    {r.estimatedCostUsd != null ? `$${r.estimatedCostUsd.toFixed(2)}` : '—'}
                  </span>
                </div>
              </button>
            );
          })}
          {/* F-051: when the API returns the full page, surface that older
              sessions exist beyond what's rendered. The cap is enforced
              server-side (api-handler `limit` clamp) and matches the
              `qk.sessionsList(50)` query above; bump both together if the
              cap ever changes. */}
          {rows.length >= SESSIONS_PAGE_SIZE && (
            <div className="p-2 text-[10px] text-ink-muted text-center border-t border-bg-line">
              Showing {SESSIONS_PAGE_SIZE} most recent sessions.
            </div>
          )}
        </div>
      </aside>

      <div className="bg-bg-panel border border-bg-line rounded p-3 overflow-auto">
        {!selectedId && (
          <div className="text-ink-muted text-xs">Pick a session on the left.</div>
        )}
        {selectedId && detail.isLoading && (
          <div className="text-ink-muted text-xs">Loading detail…</div>
        )}
        {selectedId && detail.data && <SessionTimeline data={detail.data} />}
      </div>
    </section>
  );
}

function SessionTimeline({ data }: { data: SessionDetail }): JSX.Element {
  const [, navigate] = useLocation();
  const entries = data.timeline ?? [];
  const breakdown = data.toolBreakdown ?? {};
  const breakdownEntries = Object.entries(breakdown).sort((a, b) => b[1] - a[1]);
  const totalCalls = data.toolCallCount ?? entries.length;
  const durationSec = data.durationMs ? Math.round(data.durationMs / 1000) : null;
  const first = entries.length > 0 ? entries[0]!.timestamp : 0;
  const last =
    entries.length > 0
      ? entries[entries.length - 1]!.timestamp + (entries[entries.length - 1]!.durationMs ?? 0)
      : 0;
  const span = Math.max(1, last - first);

  if (entries.length === 0 && breakdownEntries.length === 0) {
    return <div className="text-ink-muted text-xs">No tool calls in this session.</div>;
  }

  return (
    <div>
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <h2 className="text-xs uppercase tracking-wider text-ink-muted">
            {data.sessionId.slice(0, 8)} · {totalCalls} calls
            {durationSec !== null && ` · ${durationSec}s`}
          </h2>
          {entries.length > 0 && (
            <div className="text-[11px] text-ink-subtle mt-0.5">
              {new Date(first).toLocaleString(undefined, {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => navigate(`/replay/${data.sessionId}`)}
          className="text-[11px] text-accent-cyan hover:underline"
        >
          Replay →
        </button>
      </div>

      <div className="grid grid-cols-3 gap-2 mb-4 text-xs">
        {data.model && (
          <div className="bg-bg-base rounded p-2">
            <div className="text-ink-muted text-[10px] uppercase">Model</div>
            <div className="font-mono">{data.model}</div>
          </div>
        )}
        {data.estimatedCostUsd != null && (
          <div className="bg-bg-base rounded p-2">
            <div className="text-ink-muted text-[10px] uppercase">Cost</div>
            <div className="tabular-nums">${data.estimatedCostUsd.toFixed(3)}</div>
          </div>
        )}
        {data.outcome && (
          <div className="bg-bg-base rounded p-2">
            <div className="text-ink-muted text-[10px] uppercase">Outcome</div>
            <div>{data.outcome}</div>
          </div>
        )}
      </div>

      {breakdownEntries.length > 0 && (
        <div className="mb-4">
          <div className="text-[10px] text-ink-muted uppercase tracking-wider mb-2">
            Tool breakdown
          </div>
          <div className="flex flex-col gap-1">
            {breakdownEntries.map(([tool, count]) => {
              const pct = totalCalls > 0 ? (count / totalCalls) * 100 : 0;
              return (
                <div key={tool} className="flex items-center gap-2 text-[11px]">
                  <span className="w-20 text-ink-subtle truncate">{tool}</span>
                  <div className="flex-1 h-3 bg-bg-base relative rounded">
                    <div
                      className="h-3 bg-accent-cyan/70 rounded"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="w-10 text-right text-ink-muted tabular-nums">{count}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {(data.filesModified?.length ?? 0) > 0 && (
        <div className="mb-4">
          <div className="text-[10px] text-ink-muted uppercase tracking-wider mb-1">
            Files modified
          </div>
          <ul className="text-[11px] text-ink-subtle space-y-0.5">
            {data.filesModified!.map((f) => (
              <li key={f} className="font-mono truncate">{f.split('/').slice(-2).join('/')}</li>
            ))}
          </ul>
        </div>
      )}

      {(data.antiPatterns?.length ?? 0) > 0 && (
        <div>
          <div className="text-[10px] text-ink-muted uppercase tracking-wider mb-1">
            Anti-patterns
          </div>
          <ul className="text-[11px] text-amber-400 space-y-0.5">
            {data.antiPatterns!.map((ap) => (
              <li key={ap.type}>⚠ {ap.type} ({ap.count}×)</li>
            ))}
          </ul>
        </div>
      )}

      {entries.length > 0 && (
        <div>
          <div className="text-[10px] text-ink-muted uppercase tracking-wider mb-2">Timeline</div>
          <div className="flex flex-col gap-0.5">
            {entries.map((c, i) => {
              const dur = c.durationMs ?? 0;
              const left = ((c.timestamp - first) / span) * 100;
              const width = Math.max(0.5, (dur / span) * 100);
              return (
                <div
                  key={`${c.timestamp}-${c.toolName}-${i}`}
                  className="flex items-center gap-2 text-[11px]"
                >
                  <span className="w-20 text-ink-subtle truncate">{c.toolName}</span>
                  <div className="flex-1 h-3 bg-bg-base relative rounded">
                    <div
                      className={`absolute top-0 h-3 rounded ${c.success ? 'bg-accent-cyan/70' : 'bg-accent-red/70'}`}
                      style={{ left: `${left}%`, width: `${width}%` }}
                      title={`${dur}ms`}
                    />
                  </div>
                  <span className="w-14 text-right text-ink-muted tabular-nums">{dur}ms</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
