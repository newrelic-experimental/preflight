import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchSessionsList, fetchSessionDetail, qk } from '../api/client';

interface SessionRow {
  readonly sessionId: string;
  readonly startTime?: string;
  readonly toolCallCount?: number;
  readonly estimatedCostUsd?: number | null;
  readonly outcome?: string | null;
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
  readonly toolCalls?: ReadonlyArray<{
    readonly toolName: string;
    readonly durationMs: number;
    readonly startTime: number;
    readonly endTime: number;
  }>;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function Sessions(): JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const list = useQuery<SessionRow[]>({
    queryKey: qk.sessionsList(50),
    queryFn: () => fetchSessionsList(50) as Promise<SessionRow[]>,
  });

  const detail = useQuery<SessionDetail>({
    queryKey: selectedId ? qk.sessionDetail(selectedId) : ['session', 'none'],
    queryFn: () => fetchSessionDetail(selectedId!) as Promise<SessionDetail>,
    enabled: selectedId !== null,
  });

  const rows = list.data ?? [];

  return (
    <section className="grid grid-cols-[260px_1fr] gap-3 h-full">
      <aside className="bg-bg-panel border border-bg-line rounded overflow-hidden flex flex-col">
        <header className="p-2 border-b border-bg-line">
          <h2 className="text-xs uppercase tracking-wider text-ink-muted">Sessions</h2>
        </header>
        <div className="overflow-auto">
          {list.isLoading && <div className="p-3 text-ink-muted text-xs">Loading…</div>}
          {!list.isLoading && rows.length === 0 && (
            <div className="p-3 text-ink-muted text-xs">
              No sessions yet — start coding with Claude.
            </div>
          )}
          {rows.map((r) => (
            <button
              key={r.sessionId}
              type="button"
              onClick={() => setSelectedId(r.sessionId)}
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
          ))}
        </div>
      </aside>

      <div className="bg-bg-panel border border-bg-line rounded p-3 overflow-auto">
        {!selectedId && <div className="text-ink-muted text-xs">Pick a session on the left.</div>}
        {selectedId && detail.isLoading && (
          <div className="text-ink-muted text-xs">Loading detail…</div>
        )}
        {selectedId && detail.data && <SessionTimeline data={detail.data} />}
      </div>
    </section>
  );
}

function SessionTimeline({ data }: { data: SessionDetail }): JSX.Element {
  const calls = data.toolCalls ?? [];
  const breakdown = data.toolBreakdown ?? {};
  const breakdownEntries = Object.entries(breakdown).sort((a, b) => b[1] - a[1]);
  const totalCalls = data.toolCallCount ?? calls.length ?? 0;
  const durationSec = data.durationMs ? Math.round(data.durationMs / 1000) : null;

  if (calls.length === 0 && breakdownEntries.length === 0) {
    return <div className="text-ink-muted text-xs">No tool calls in this session.</div>;
  }

  return (
    <div>
      <h2 className="text-xs uppercase tracking-wider text-ink-muted mb-3">
        {data.sessionId.slice(0, 8)} · {totalCalls} calls
        {durationSec !== null && ` · ${durationSec}s`}
      </h2>

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

      {calls.length > 0 && (
        <div>
          <div className="text-[10px] text-ink-muted uppercase tracking-wider mb-2">Timeline</div>
          <div className="flex flex-col gap-0.5">
            {calls.map((c) => (
              <div
                key={`${c.startTime}-${c.toolName}`}
                className="flex items-center gap-2 text-[11px]"
              >
                <span className="w-20 text-ink-subtle truncate">{c.toolName}</span>
                <span className="w-14 text-right text-ink-muted tabular-nums">{c.durationMs}ms</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
