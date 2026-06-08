import {
  useState,
  useMemo,
  useRef,
  useEffect,
  useCallback,
  forwardRef,
  type ReactNode,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import { EmptyState } from '../components/EmptyState';
import { GanttTimeline } from '../components/GanttTimeline';
import { ActivityHeatmap } from '../components/ActivityHeatmap';
import { GeoBanner } from '../components/GeoBanner';
import {
  fetchSessionsList,
  fetchSessionCurrent,
  fetchSessionDetail,
  fetchSessionReplay,
  qk,
} from '../api/client';
import { shortToolName } from '../lib/format';
import { bucketTimeline, autoBucketSize } from '../lib/bucket';

// F-051: keep the query limit and the "showing N most recent" notice in
// lock-step. If you bump this, also update the api-handler clamp upper
// bound if you intend to allow more than the current 500 ceiling.
const SESSIONS_PAGE_SIZE = 50;

interface SessionRow {
  readonly sessionId: string;
  readonly sessionName?: string | null;
  readonly startTime?: string | number;
  readonly toolCallCount?: number;
  readonly estimatedCostUsd?: number | null;
  readonly outcome?: string | null;
}

interface CurrentSession {
  readonly sessionId: string;
  readonly sessionStartTime?: number;
  readonly toolCallCount?: number;
  readonly estimatedCostUsd?: number | null;
  readonly liveSessions?: string[];
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
  readonly sessionName?: string | null;
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
  const d = new Date(value);
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
        const ta =
          typeof a.startTime === 'number' ? a.startTime : new Date(a.startTime ?? 0).getTime();
        const tb =
          typeof b.startTime === 'number' ? b.startTime : new Date(b.startTime ?? 0).getTime();
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
  const initialId = new URLSearchParams(window.location.search).get('id');
  const [selectedId, setSelectedId] = useState<string | null>(initialId);
  const [sortKey, setSortKey] = useState<SortKey>('date');

  const list = useQuery<SessionRow[]>({
    queryKey: qk.sessionsList(SESSIONS_PAGE_SIZE),
    queryFn: () => fetchSessionsList(SESSIONS_PAGE_SIZE) as Promise<SessionRow[]>,
    refetchInterval: 10_000,
  });

  const current = useQuery<CurrentSession>({
    queryKey: qk.sessionCurrent,
    queryFn: () => fetchSessionCurrent() as Promise<CurrentSession>,
    refetchInterval: 10_000,
  });

  const detail = useQuery<SessionDetail>({
    queryKey: selectedId ? qk.sessionDetail(selectedId) : ['session', 'none'],
    queryFn: () => fetchSessionDetail(selectedId!) as Promise<SessionDetail>,
    enabled: selectedId !== null,
  });

  const liveSessionIds = useMemo(() => {
    const set = new Set<string>();
    if (current.data?.liveSessions?.length) {
      for (const id of current.data.liveSessions) set.add(id);
    } else if (current.data?.sessionId) {
      set.add(current.data.sessionId);
    }
    return set;
  }, [current.data]);

  const rows = useMemo(() => {
    const persisted = list.data ?? [];
    return sortSessions(persisted, sortKey);
  }, [list.data, sortKey]);

  useEffect(() => {
    if (selectedId) return;
    const firstLiveId = liveSessionIds.size > 0 ? [...liveSessionIds][0]! : null;
    if (firstLiveId) {
      setSelectedId(firstLiveId);
    } else if (rows.length > 0) {
      setSelectedId(rows[0]!.sessionId);
    }
  }, [liveSessionIds, rows, selectedId]);

  const handleSessionClick = (sessionId: string): void => {
    setSelectedId(sessionId);
  };

  return (
    <section className="flex flex-col h-full">
      <div className="h-8 overflow-hidden rounded-lg mb-2 shrink-0">
        <GeoBanner theme="sessions" />
      </div>
      <h1 className="text-lg font-semibold gradient-text mb-2 shrink-0">Sessions</h1>
      <div className="grid grid-cols-[260px_1fr] gap-3 flex-1 min-h-0">
        <aside className="glass-card overflow-hidden flex flex-col">
          <header className="p-2 border-b border-border-subtle">
            <div className="flex items-center justify-between">
              <h2 className="text-xs uppercase tracking-wider text-ink-muted">List</h2>
              <select
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value as SortKey)}
                className="text-[10px] bg-surface-5 border border-border-medium rounded px-1.5 py-0.5 text-ink-subtle"
              >
                <option value="date">Newest</option>
                <option value="cost">Cost</option>
                <option value="calls">Calls</option>
              </select>
            </div>
          </header>
          <div className="overflow-auto">
            {list.isLoading && <div className="p-3 text-ink-muted text-xs">Loading…</div>}
            {!list.isLoading && rows.length === 0 && liveSessionIds.size === 0 && (
              <EmptyState
                icon="code"
                title="No sessions yet"
                subtitle="Start coding with Claude to see your sessions here."
              />
            )}
            {rows.map((r) => {
              const isLive = liveSessionIds.has(r.sessionId);
              return (
                <button
                  key={r.sessionId}
                  type="button"
                  onClick={() => handleSessionClick(r.sessionId)}
                  className={
                    'block w-full text-left p-2 border-b border-border-subtle text-xs hover:bg-bg-line ' +
                    (selectedId === r.sessionId ? 'bg-bg-line' : '')
                  }
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="font-mono text-ink-base truncate">
                      {r.sessionName || r.sessionId.slice(0, 8)}
                    </span>
                    {isLive && (
                      <span className="shrink-0 inline-flex items-center gap-0.5 bg-accent-cyan/20 text-accent-cyan text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded">
                        <span className="w-1.5 h-1.5 rounded-full bg-accent-cyan animate-pulse" />
                        live
                      </span>
                    )}
                  </div>
                  <div className="flex justify-between mt-1 text-ink-subtle text-[11px]">
                    <span>{r.toolCallCount ?? 0} calls</span>
                    <span className="text-ink-muted">
                      {r.startTime ? fmtTime(r.startTime) : '—'}
                    </span>
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
              <div className="p-2 text-[10px] text-ink-muted text-center border-t border-border-subtle">
                Showing {SESSIONS_PAGE_SIZE} most recent sessions.
              </div>
            )}
          </div>
        </aside>

        <div className="glass-card glass-card-static p-4 overflow-auto">
          {!selectedId && (
            <EmptyState
              icon="timeline"
              title="Loading sessions"
              subtitle="Selecting the most recent session…"
            />
          )}
          {selectedId && detail.isLoading && (
            <div className="text-ink-muted text-xs">Loading detail…</div>
          )}
          {selectedId && detail.data && (
            <SessionTimeline
              data={detail.data}
              isLive={!!selectedId && liveSessionIds.has(selectedId)}
            />
          )}
        </div>
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

function toolBarColor(toolName: string): string {
  if (toolName === 'Read') return 'bg-accent-blue/80';
  if (toolName === 'Edit' || toolName === 'Write') return 'bg-accent-green/80';
  if (toolName === 'Bash') return 'bg-accent-purple/80';
  if (toolName === 'Agent') return 'bg-accent-teal/80';
  return 'bg-ink-subtle/80';
}

function SessionTimeline({ data, isLive }: { data: SessionDetail; isLive: boolean }): JSX.Element {
  const breakdown = data.toolBreakdown ?? {};
  const breakdownEntries = Object.entries(breakdown).sort((a, b) => b[1] - a[1]);
  const totalCalls = data.toolCallCount ?? 0;
  const durationSec = data.durationMs ? Math.round(data.durationMs / 1000) : null;
  const entries = data.timeline ?? [];
  const first = entries.length > 0 ? entries[0]!.timestamp : 0;

  if (entries.length === 0 && breakdownEntries.length === 0) {
    return (
      <EmptyState
        icon="timeline"
        title="No tool calls"
        subtitle="This session has no recorded tool calls."
      />
    );
  }

  return (
    <div>
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <h2 className="text-xs tracking-wider text-ink-muted flex items-center gap-2">
            <span
              className={data.sessionName ? 'font-medium text-ink-base' : 'uppercase font-mono'}
            >
              {data.sessionName || data.sessionId.slice(0, 8)}
            </span>
            <span className="uppercase">
              · {totalCalls} calls{durationSec !== null ? ` · ${durationSec}s` : ''}
            </span>
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
          <div className="bg-surface-3 rounded-lg p-2.5">
            <div className="text-ink-muted text-[10px] uppercase">Model</div>
            <div className="font-mono">{data.model}</div>
          </div>
        )}
        {data.estimatedCostUsd != null && (
          <div className="bg-surface-3 rounded-lg p-2.5">
            <div className="text-ink-muted text-[10px] uppercase">Cost</div>
            <div className="tabular-nums">${data.estimatedCostUsd.toFixed(3)}</div>
          </div>
        )}
        {data.outcome && (
          <div className="bg-surface-3 rounded-lg p-2.5">
            <div className="text-ink-muted text-[10px] uppercase">Outcome</div>
            <div>{data.outcome}</div>
          </div>
        )}
      </div>

      {(data.qualityProxy || data.toolSelectionScore) && (
        <div className="grid grid-cols-2 gap-3 mb-4">
          {data.qualityProxy && (
            <div className="bg-surface-3 rounded-lg p-3">
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
            <div className="bg-surface-3 rounded-lg p-3">
              <div className="text-[10px] text-ink-muted uppercase tracking-wider mb-2">
                Tool Selection
              </div>
              <div
                className={`text-2xl font-semibold tabular-nums ${toolScoreColor(data.toolSelectionScore.score)}`}
              >
                {data.toolSelectionScore.score.toFixed(2)}
              </div>
              <div className="text-[10px] text-ink-muted mt-1">
                re-reads: {data.toolSelectionScore.redundantReadCount} · repeat fails:{' '}
                {data.toolSelectionScore.repeatedFailureCount} · unused:{' '}
                {data.toolSelectionScore.unusedOutputCount}
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
                  <span className="w-28 text-ink-subtle truncate" title={tool}>
                    {shortToolName(tool)}
                  </span>
                  <div className="flex-1 h-3 bg-surface-3 relative rounded">
                    <div
                      className={`h-3 rounded ${toolBarColor(tool)}`}
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
              <li key={f} className="font-mono truncate">
                {f.split('/').slice(-2).join('/')}
              </li>
            ))}
          </ul>
        </div>
      )}

      <SessionActivityStrip timeline={entries} />

      <InlineReplay sessionId={data.sessionId} isLive={isLive} />
    </div>
  );
}

function SessionActivityStrip({
  timeline,
}: {
  timeline: ReadonlyArray<{ timestamp: number }>;
}): JSX.Element | null {
  const heatmap = useMemo(() => {
    if (timeline.length < 2) return null;
    const startMs = timeline[0]!.timestamp;
    const endMs = timeline[timeline.length - 1]!.timestamp;
    const durationMs = endMs - startMs;
    if (durationMs < 1000) return null;
    const bucketSizeMs = autoBucketSize(durationMs);
    const buckets = bucketTimeline(timeline, {
      startMs,
      endMs: endMs + bucketSizeMs,
      bucketSizeMs,
    });
    const maxCount = Math.max(...buckets, 1);
    return { buckets, maxCount, bucketSizeMs, startMs };
  }, [timeline]);

  if (!heatmap) return null;

  return (
    <div className="mb-4">
      <div className="text-[10px] text-ink-muted uppercase tracking-wider mb-1">
        Activity density
      </div>
      <ActivityHeatmap
        variant="strip"
        buckets={heatmap.buckets}
        maxCount={heatmap.maxCount}
        bucketSizeMs={heatmap.bucketSizeMs}
        startTimestamp={heatmap.startMs}
        ariaLabel="Session activity density"
      />
    </div>
  );
}

function fmtElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `+${min}:${String(sec).padStart(2, '0')}`;
}

const ScrollableTimeline = forwardRef<
  HTMLDivElement,
  { children: ReactNode; isLive: boolean; timelineLength?: number }
>(function ScrollableTimeline({ children, isLive, timelineLength }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [showJump, setShowJump] = useState(false);

  const checkScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const hasOverflow = el.scrollHeight > el.clientHeight + 40;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setShowJump(hasOverflow && !atBottom);
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    checkScroll();
    el.addEventListener('scroll', checkScroll, { passive: true });
    return () => el.removeEventListener('scroll', checkScroll);
  }, [checkScroll]);

  useEffect(() => {
    if (isLive && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [isLive, timelineLength]);

  const jumpToBottom = useCallback(() => {
    containerRef.current?.scrollTo({
      top: containerRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, []);

  const mergedRef = useCallback(
    (el: HTMLDivElement | null) => {
      (containerRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
      if (typeof ref === 'function') ref(el);
      else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = el;
    },
    [ref],
  );

  return (
    <div className="relative">
      <div ref={mergedRef} className="overflow-auto max-h-[60vh]">
        {children}
      </div>
      {showJump && (
        <button
          type="button"
          onClick={jumpToBottom}
          className="absolute bottom-2 right-3 px-2 py-1 rounded-lg bg-bg-elevated/90 border border-bg-line text-[10px] text-ink-subtle hover:text-ink-base hover:border-accent-green/40 backdrop-blur-sm transition-all shadow-lg"
        >
          ↓ Jump to bottom
        </button>
      )}
    </div>
  );
});

function InlineReplay({ sessionId, isLive }: { sessionId: string; isLive: boolean }): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewMode, setViewMode] = useState<'gantt' | 'list'>('gantt');

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
        <div className="bg-accent-amber/5 border border-accent-amber/30 rounded-xl p-2.5 mb-3">
          <div className="text-[11px] font-semibold text-accent-amber mb-1.5">
            {segments.length} anti-pattern{segments.length > 1 ? 's' : ''} detected
          </div>
          <div className="flex flex-wrap gap-1.5">
            {aggregateSegments(segments).map(({ type, count, worstSeverity }) => (
              <span
                key={type}
                className={
                  'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] ' +
                  (worstSeverity === 'critical'
                    ? 'bg-accent-red/10 text-accent-red border border-accent-red/30'
                    : 'bg-accent-amber/10 text-accent-amber border border-accent-amber/30')
                }
              >
                {SEGMENT_LABELS[type] ?? type}
                <span className="opacity-70">× {count}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-2">
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
        <div className="text-[10px] text-ink-muted uppercase tracking-wider">
          replay · {data.timeline.length} calls
          {isLive && <span className="text-accent-cyan ml-1">· auto-updating</span>}
        </div>
      </div>

      <ScrollableTimeline ref={scrollRef} isLive={isLive} timelineLength={data.timeline.length}>
        {viewMode === 'gantt' ? (
          <GanttTimeline entries={data.timeline} segments={segments} />
        ) : (
          <div className="flex flex-col">
            {data.timeline.map((entry, idx) => {
              const seg = segmentAt[idx];
              const borderColor = seg
                ? seg.severity === 'critical'
                  ? 'border-l-accent-red'
                  : 'border-l-accent-amber'
                : 'border-l-transparent';
              const bgColor = seg
                ? seg.severity === 'critical'
                  ? 'bg-accent-red/5'
                  : 'bg-accent-amber/5'
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
                  <span
                    className="w-28 truncate font-medium text-ink-base shrink-0"
                    title={entry.toolName}
                  >
                    {shortToolName(entry.toolName)}
                  </span>
                  <span
                    className="flex-1 truncate text-ink-subtle min-w-0"
                    title={entry.filePath ?? entry.command ?? ''}
                  >
                    {entry.filePath ?? entry.command ?? ''}
                  </span>
                  <span className="w-14 text-right tabular-nums text-ink-muted shrink-0">
                    {entry.durationMs != null ? `${entry.durationMs}ms` : '—'}
                  </span>
                  <span
                    className={`w-3 text-center shrink-0 ${entry.success ? 'text-accent-green' : 'text-accent-red'}`}
                  >
                    {entry.success ? '✓' : '✗'}
                  </span>
                  {seg && idx === seg.startIndex && (
                    <span
                      className={
                        'ml-0.5 px-1 py-0.5 rounded text-[9px] font-medium shrink-0 ' +
                        (seg.severity === 'critical'
                          ? 'bg-accent-red/20 text-accent-red'
                          : 'bg-accent-amber/20 text-accent-amber')
                      }
                    >
                      {SEGMENT_LABELS[seg.type] ?? seg.type}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </ScrollableTimeline>
    </div>
  );
}

interface AggregatedSegment {
  readonly type: string;
  readonly count: number;
  readonly totalIterations: number;
  readonly worstSeverity: 'warning' | 'critical';
}

function aggregateSegments(segments: Segment[]): AggregatedSegment[] {
  const map = new Map<
    string,
    { count: number; totalIterations: number; worstSeverity: 'warning' | 'critical' }
  >();
  for (const seg of segments) {
    const existing = map.get(seg.type);
    if (existing) {
      existing.count++;
      existing.totalIterations += seg.iterations;
      if (seg.severity === 'critical') existing.worstSeverity = 'critical';
    } else {
      map.set(seg.type, { count: 1, totalIterations: seg.iterations, worstSeverity: seg.severity });
    }
  }
  return Array.from(map.entries()).map(([type, data]) => ({ type, ...data }));
}

function buildSegmentLookup(length: number, segments: Segment[]): (Segment | null)[] {
  const lookup: (Segment | null)[] = new Array(length).fill(null);
  for (const seg of segments) {
    const start = Math.max(0, seg.startIndex);
    const end = Math.min(seg.endIndex, length - 1);
    for (let i = start; i <= end; i++) {
      if (
        lookup[i] === null ||
        (seg.severity === 'critical' && lookup[i]!.severity !== 'critical')
      ) {
        lookup[i] = seg;
      }
    }
  }
  return lookup;
}
