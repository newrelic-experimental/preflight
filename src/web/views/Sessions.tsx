import { useState, useMemo, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchSessionsList, fetchSessionCurrent, fetchSessionDetail, fetchSessionReplay, qk } from '../api/client';

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
  readonly qualityProxy?: {
    readonly diffApplyRate: number | null;
    readonly testPassRate: number | null;
    readonly backtrackCount: number;
    readonly selfCorrectionCount: number;
  };
  readonly toolSelectionScore?: {
    readonly score: number;
    readonly redundantReadCount: number;
    readonly repeatedFailureCount: number;
    readonly unusedOutputCount: number;
  };
}

interface Segment {
  readonly type: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly iterations: number;
  readonly target: string;
  readonly severity: 'warning' | 'critical';
}

interface ReplayData {
  readonly sessionId: string;
  readonly timeline: TimelineEntry[];
  readonly segments: Segment[];
  readonly worstSegment: Segment | null;
}

const SEGMENT_LABELS: Record<string, string> = {
  thrashing: 'Edit/Test Thrashing',
  stuck_loop: 'Stuck Loop',
  blind_editing: 'Blind Editing',
  re_reading: 'Repeated Reads',
};

const TOOL_ICONS: Record<string, string> = {
  Read: '\u{1F4C4}',
  Edit: '✏️',
  Write: '\u{1F4DD}',
  Bash: '⚡',
  Agent: '\u{1F916}',
  AskUserQuestion: '\u{1F4AC}',
  TaskCreate: '\u{1F4CB}',
  TaskUpdate: '✅',
};

const LIVE_REFETCH_MS = 3_000;

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
    setSelectedId(sessionId);
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
        {selectedId && detail.data && (
          <SessionTimeline data={detail.data} isLive={selectedId === liveSessionId} />
        )}
      </div>
    </section>
  );
}

function qualityRateColor(rate: number | null, goodThreshold = 0.8, warnThreshold = 0.5): string {
  if (rate === null) return 'text-ink-muted';
  if (rate >= goodThreshold) return 'text-green-400';
  if (rate >= warnThreshold) return 'text-amber-400';
  return 'text-red-400';
}

function toolScoreColor(score: number): string {
  if (score >= 0.8) return 'text-accent-cyan';
  if (score >= 0.5) return 'text-amber-400';
  return 'text-red-400';
}

function SessionTimeline({ data, isLive }: { data: SessionDetail; isLive: boolean }): JSX.Element {
  const breakdown = data.toolBreakdown ?? {};
  const breakdownEntries = Object.entries(breakdown).sort((a, b) => b[1] - a[1]);
  const totalCalls = data.toolCallCount ?? 0;
  const durationSec = data.durationMs ? Math.round(data.durationMs / 1000) : null;
  const entries = data.timeline ?? [];
  const first = entries.length > 0 ? entries[0]!.timestamp : 0;

  if (entries.length === 0 && breakdownEntries.length === 0) {
    return <div className="text-ink-muted text-xs">No tool calls in this session.</div>;
  }

  return (
    <div>
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <h2 className="text-xs uppercase tracking-wider text-ink-muted flex items-center gap-2">
            {data.sessionId.slice(0, 8)} · {totalCalls} calls
            {durationSec !== null && ` · ${durationSec}s`}
            {isLive && (
              <span className="inline-flex items-center gap-0.5 bg-accent-cyan/20 text-accent-cyan text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded">
                <span className="w-1.5 h-1.5 rounded-full bg-accent-cyan animate-pulse" />
                live
              </span>
            )}
          </h2>
          {first > 0 && (
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

      {(data.qualityProxy || data.toolSelectionScore) && (
        <div className="grid grid-cols-2 gap-3 mb-4">
          {data.qualityProxy && (
            <div className="bg-bg-base border border-bg-line rounded p-3">
              <div className="text-[10px] text-ink-muted uppercase tracking-wider mb-2">
                Session Quality
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <span className="text-ink-muted">Diff Apply </span>
                  <span className={qualityRateColor(data.qualityProxy.diffApplyRate)}>
                    {data.qualityProxy.diffApplyRate !== null
                      ? `${(data.qualityProxy.diffApplyRate * 100).toFixed(0)}%`
                      : '—'}
                  </span>
                </div>
                <div>
                  <span className="text-ink-muted">Test Pass </span>
                  <span className={qualityRateColor(data.qualityProxy.testPassRate)}>
                    {data.qualityProxy.testPassRate !== null
                      ? `${(data.qualityProxy.testPassRate * 100).toFixed(0)}%`
                      : '—'}
                  </span>
                </div>
                <div>
                  <span className="text-ink-muted">Backtracks </span>
                  <span className={data.qualityProxy.backtrackCount > 0 ? 'text-amber-400' : ''}>
                    {data.qualityProxy.backtrackCount}
                  </span>
                </div>
                <div>
                  <span className="text-ink-muted">Self-corrections </span>
                  <span className="text-ink-subtle">{data.qualityProxy.selfCorrectionCount}</span>
                </div>
              </div>
            </div>
          )}
          {data.toolSelectionScore && (
            <div className="bg-bg-base border border-bg-line rounded p-3">
              <div className="text-[10px] text-ink-muted uppercase tracking-wider mb-2">
                Tool Selection
              </div>
              <div className={`text-2xl font-semibold tabular-nums ${toolScoreColor(data.toolSelectionScore.score)}`}>
                {data.toolSelectionScore.score.toFixed(2)}
              </div>
              <div className="text-[10px] text-ink-muted mt-1">
                re-reads: {data.toolSelectionScore.redundantReadCount} · repeat fails: {data.toolSelectionScore.repeatedFailureCount} · unused: {data.toolSelectionScore.unusedOutputCount}
              </div>
            </div>
          )}
        </div>
      )}

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

      <InlineReplay sessionId={data.sessionId} isLive={isLive} />
    </div>
  );
}

function fmtElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `+${min}:${String(sec).padStart(2, '0')}`;
}

function InlineReplay({ sessionId, isLive }: { sessionId: string; isLive: boolean }): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data, isLoading } = useQuery<ReplayData>({
    queryKey: qk.sessionReplay(sessionId),
    queryFn: () => fetchSessionReplay(sessionId) as Promise<ReplayData>,
    retry: false,
    refetchInterval: isLive ? LIVE_REFETCH_MS : false,
  });

  useEffect(() => {
    if (isLive && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [data?.timeline.length, isLive]);

  if (isLoading) {
    return <div className="text-ink-muted text-xs mt-3">Loading replay…</div>;
  }

  if (!data || data.timeline.length === 0) {
    return <></>;
  }

  const segments = data.segments;
  const firstTs = data.timeline[0]!.timestamp;
  const segmentAt = buildSegmentLookup(data.timeline.length, segments);

  return (
    <div className="mt-4">
      {segments.length > 0 && (
        <div className="bg-bg-base border border-accent-amber/40 rounded p-2.5 mb-3">
          <div className="text-[11px] font-semibold text-accent-amber mb-1.5">
            {segments.length} anti-pattern{segments.length > 1 ? 's' : ''}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {segments.map((seg, i) => (
              <span
                key={`${seg.type}-${seg.startIndex}-${i}`}
                className={
                  'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] ' +
                  (seg.severity === 'critical'
                    ? 'bg-accent-red/10 text-accent-red border border-accent-red/30'
                    : 'bg-accent-amber/10 text-accent-amber border border-accent-amber/30')
                }
              >
                {SEGMENT_LABELS[seg.type] ?? seg.type}
                <span className="opacity-70">({seg.iterations}×)</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="text-[10px] text-ink-muted uppercase tracking-wider mb-2">
        replay · {data.timeline.length} calls
        {isLive && <span className="text-accent-cyan ml-1">· auto-updating</span>}
      </div>

      <div ref={scrollRef} className="max-h-[400px] overflow-auto flex flex-col">
        {data.timeline.map((entry, idx) => {
          const seg = segmentAt[idx];
          const borderColor = seg
            ? seg.severity === 'critical' ? 'border-l-accent-red' : 'border-l-accent-amber'
            : 'border-l-transparent';
          const bgColor = seg
            ? seg.severity === 'critical' ? 'bg-accent-red/5' : 'bg-accent-amber/5'
            : '';
          const elapsed = entry.timestamp - firstTs;

          return (
            <div
              key={`${idx}-${entry.timestamp}`}
              className={`flex items-center gap-1.5 px-2 py-0.5 border-l-2 ${borderColor} ${bgColor} text-[11px]`}
            >
              <span className="w-10 text-ink-muted tabular-nums shrink-0">
                {fmtElapsed(elapsed)}
              </span>
              <span className="w-4 text-center shrink-0" aria-hidden="true">
                {TOOL_ICONS[entry.toolName] ?? '·'}
              </span>
              <span className="w-16 truncate font-medium text-ink-base shrink-0">{entry.toolName}</span>
              <span className="flex-1 truncate text-ink-subtle min-w-0">
                {entry.filePath ?? entry.command ?? ''}
              </span>
              <span className="w-14 text-right tabular-nums text-ink-muted shrink-0">
                {entry.durationMs != null ? `${entry.durationMs}ms` : '—'}
              </span>
              <span className={`w-3 text-center shrink-0 ${entry.success ? 'text-accent-green' : 'text-accent-red'}`}>
                {entry.success ? '✓' : '✗'}
              </span>
              {seg && idx === seg.startIndex && (
                <span
                  className={
                    'ml-0.5 px-1 py-0.5 rounded text-[9px] font-medium shrink-0 ' +
                    (seg.severity === 'critical' ? 'bg-accent-red/20 text-accent-red' : 'bg-accent-amber/20 text-accent-amber')
                  }
                >
                  {SEGMENT_LABELS[seg.type] ?? seg.type}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function buildSegmentLookup(length: number, segments: Segment[]): (Segment | null)[] {
  const lookup: (Segment | null)[] = new Array(length).fill(null);
  for (const seg of segments) {
    for (let i = seg.startIndex; i <= Math.min(seg.endIndex, length - 1); i++) {
      if (lookup[i] === null || seg.severity === 'critical') {
        lookup[i] = seg;
      }
    }
  }
  return lookup;
}
