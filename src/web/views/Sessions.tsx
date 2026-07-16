import { useState, useMemo, useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearch } from 'wouter';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { EmptyState } from '../components/EmptyState';
import { ActivityHeatmap } from '../components/ActivityHeatmap';
import { GeoBanner } from '../components/GeoBanner';
import { type AgentSpan } from '../components/AgentSwimlanes';
import { SessionTrace } from '../components/SessionTrace';
import { WorkflowRunDetail } from '../components/WorkflowRunDetail';
import { Kpi } from '../components/Kpi';
import {
  fetchSessionsList,
  fetchSessionCurrent,
  fetchSessionDetail,
  fetchSessionSubagents,
  fetchWorkflows,
  fetchWorkflowDetail,
  qk,
  type SessionDetail,
  type WorkflowRunInfo,
  type WorkflowRunDetailResponse,
  type SessionSubagentsResponse,
} from '../api/client';
import { ContextBar } from '../components/ContextBar';
import type { ContextResponse } from '../api/client';
import type { AgentRow } from '../components/AgentTable';
import { Card, Eyebrow, LiveBadge, Pill, Tabs } from '../components/ui';
import type { PillTone } from '../components/ui';
import {
  fmtDateTime,
  formatDuration,
  formatUsd,
  formatUsdOrDash,
  rateColor,
  scoreColor,
  shortToolName,
} from '../lib/format';
import { bucketTimeline, autoBucketSize } from '../lib/bucket';

// Keep the query limit and the "showing N most recent" notice in
// lock-step. If you bump this, also update the api-handler clamp upper
// bound if you intend to allow more than the current 500 ceiling.
const SESSIONS_PAGE_SIZE = 50;

interface SessionRow {
  readonly sessionId: string;
  readonly sessionName?: string | null;
  readonly startTime?: string | number;
  readonly durationMs?: number;
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

const SEGMENT_LABELS: Record<string, string> = {
  thrashing: 'Edit/Test Thrashing',
  stuck_loop: 'Stuck Loop',
  blind_editing: 'Blind Editing',
  re_reading: 'Repeated Reads',
};

const WORKFLOW_STATUS_PILL: Record<WorkflowRunInfo['status'], { tone: PillTone; label: string }> = {
  running: { tone: 'info', label: 'Running' },
  completed: { tone: 'success', label: 'Completed' },
  failed: { tone: 'danger', label: 'Failed' },
  cancelled: { tone: 'warning', label: 'Cancelled' },
  unknown: { tone: 'neutral', label: 'Unknown' },
};

type SortKey = 'date' | 'lastActive' | 'cost' | 'calls';

// Run-level filters consolidated from the former Workflows view. They scope the
// KPI strip AND the master list (a non-default filter shows only sessions that
// own a matching run).
type TimeWindow = 'today' | '7d' | '30d' | 'all';
type RunSource = 'all' | 'script' | 'agent_tool';
type StatusFilter = 'all' | 'running' | 'completed' | 'failed' | 'cancelled';

const TIME_WINDOW_OPTIONS: ReadonlyArray<{ value: TimeWindow; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'all', label: 'All' },
];
const RUN_SOURCE_OPTIONS: ReadonlyArray<{ value: RunSource; label: string }> = [
  { value: 'all', label: 'All sources' },
  { value: 'script', label: 'Script' },
  { value: 'agent_tool', label: 'Agent tool' },
];
const STATUS_OPTIONS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'running', label: 'Running' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
];

// True when `value` (a run's startedAt) falls within the selected window. Null/
// unparseable timestamps pass (we don't hide runs we can't date). Mirrors the
// former Workflows view's window filter.
function isWithinWindow(value: string | number | null | undefined, window: TimeWindow): boolean {
  if (window === 'all') return true;
  if (value == null) return true;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return true;
  const now = Date.now();
  const cutoffMs: Record<Exclude<TimeWindow, 'all'>, number> = {
    today: new Date().setHours(0, 0, 0, 0),
    '7d': now - 7 * 24 * 60 * 60 * 1000,
    '30d': now - 30 * 24 * 60 * 60 * 1000,
  };
  return ms >= cutoffMs[window as Exclude<TimeWindow, 'all'>];
}

// Robust query-param extraction shared by the session deep-link. Returns a
// non-empty, plausibly-shaped id or null; garbage params are ignored.
function readSessionParam(search: string): string | null {
  let raw: string | null;
  try {
    const params = new URLSearchParams(search);
    // `?session=` is the cross-view contract with the Workflows view; `?id=`
    // is the pre-existing param this view already honored.
    raw = params.get('session') ?? params.get('id');
  } catch {
    return null;
  }
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 256) return null;
  return trimmed;
}

function startTimeMs(row: SessionRow): number {
  return typeof row.startTime === 'number' ? row.startTime : new Date(row.startTime ?? 0).getTime();
}

function lastActiveMs(row: SessionRow): number {
  const start = startTimeMs(row);
  return start + (row.durationMs ?? 0);
}

function sortSessions(rows: SessionRow[], key: SortKey): SessionRow[] {
  const sorted = [...rows];
  switch (key) {
    case 'date':
      sorted.sort((a, b) => startTimeMs(b) - startTimeMs(a));
      break;
    case 'lastActive':
      sorted.sort((a, b) => lastActiveMs(b) - lastActiveMs(a));
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

function fmtTokensCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function Sessions(): JSX.Element {
  const search = useSearch();
  // Mount-only initial selection, read once from the live URL (mirrors the
  // view's prior behavior of reading the param directly at construction).
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    readSessionParam(window.location.search),
  );
  const [sortKey, setSortKey] = useState<SortKey>('date');

  // Run-level filters (consolidated from the Workflows view). Default all/all so
  // the list shows every session; narrowing scopes both the KPI strip and the
  // master list to sessions owning a matching run.
  const [activeWindow, setActiveWindow] = useState<TimeWindow>('all');
  const [runSourceFilter, setRunSourceFilter] = useState<RunSource>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  // 6a: in-place workflow-run drawer. Opening a run anywhere in this view sets
  // this id and overlays WorkflowRunDetail at the Sessions root rather than
  // navigating to the Workflows route — closing it returns the user to the
  // exact session they were viewing.
  const [openRunId, setOpenRunId] = useState<string | null>(null);

  // Master-list tree expand state. Two independent sets keyed by id so a
  // user's disclosure choices stick across data refreshes:
  //   - expandedSessions: session rows whose workflow runs are revealed
  //   - expandedRuns: run sub-rows whose agents are revealed
  // Toggling either is separate from the detail-pane selection (the chevron
  // stops event propagation), so expanding never moves the right-hand pane.
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(() => new Set());
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(() => new Set());

  // React to query-param changes after mount, so deep-linking in from the
  // Workflows view (?session=<id>) selects the right session even when this
  // view is already mounted.
  const sessionParam = useMemo(() => readSessionParam(search), [search]);
  useEffect(() => {
    if (sessionParam) setSelectedId(sessionParam);
  }, [sessionParam]);

  const list = useQuery<SessionRow[]>({
    queryKey: qk.sessionsList(SESSIONS_PAGE_SIZE),
    queryFn: () => fetchSessionsList(SESSIONS_PAGE_SIZE),
    refetchInterval: 10_000,
  });

  // All workflow runs — drives the KPI strip, the filters, and the master-list
  // run tree. One shared query for the whole view (was one per expanded row).
  const { data: rawWorkflows } = useQuery({
    queryKey: qk.workflows,
    queryFn: fetchWorkflows,
    refetchInterval: 10_000,
  });

  const current = useQuery<CurrentSession>({
    queryKey: qk.sessionCurrent,
    queryFn: fetchSessionCurrent,
    refetchInterval: 10_000,
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

  const detail = useQuery<SessionDetail>({
    queryKey: selectedId ? qk.sessionDetail(selectedId) : ['session', 'none'],
    queryFn: () => fetchSessionDetail(selectedId!),
    enabled: selectedId !== null,
    // Poll while current session data is still loading (we don't know yet if
    // this session is live), then only continue polling if it turns out to be live.
    refetchInterval:
      current.isLoading || (selectedId && liveSessionIds.has(selectedId)) ? 10_000 : false,
  });

  const rows = useMemo(() => {
    const persisted = list.data ?? [];
    return sortSessions(persisted, sortKey);
  }, [list.data, sortKey]);

  const allRuns = useMemo<ReadonlyArray<WorkflowRunInfo>>(
    () => (Array.isArray(rawWorkflows) ? rawWorkflows : []),
    [rawWorkflows],
  );
  const filteredRuns = useMemo(
    () =>
      allRuns.filter((run) => {
        if (!isWithinWindow(run.startedAt, activeWindow)) return false;
        if (runSourceFilter !== 'all' && run.runSource !== runSourceFilter) return false;
        if (statusFilter !== 'all' && run.status !== statusFilter) return false;
        return true;
      }),
    [allRuns, activeWindow, runSourceFilter, statusFilter],
  );
  const kpis = useMemo(() => {
    const totalRuns = filteredRuns.length;
    const totalAgents = filteredRuns.reduce((sum, r) => sum + (r.agentCount ?? 0), 0);
    const spendVals = filteredRuns.map((r) => r.totalUsd).filter((v): v is number => v != null);
    const totalSpend = spendVals.length > 0 ? spendVals.reduce((a, b) => a + b, 0) : null;
    const durs = filteredRuns.map((r) => r.durationMs).filter((v): v is number => v != null);
    const avgDurationMs = durs.length > 0 ? durs.reduce((a, b) => a + b, 0) / durs.length : null;
    return { totalRuns, totalAgents, totalSpend, avgDurationMs };
  }, [filteredRuns]);
  // runId-set per session, built from the FILTERED runs — drives both the
  // per-session run tree and which sessions stay visible when a filter is set.
  const runsBySession = useMemo(() => {
    const m = new Map<string, WorkflowRunInfo[]>();
    for (const r of filteredRuns) {
      const sid = r.parentSessionId;
      if (typeof sid !== 'string') continue;
      const arr = m.get(sid);
      if (arr) arr.push(r);
      else m.set(sid, [r]);
    }
    return m;
  }, [filteredRuns]);
  const filtersActive =
    activeWindow !== 'all' || runSourceFilter !== 'all' || statusFilter !== 'all';
  // When a filter is active, show only sessions that own a matching run.
  const visibleRows = useMemo(
    () => (filtersActive ? rows.filter((r) => runsBySession.has(r.sessionId)) : rows),
    [filtersActive, rows, runsBySession],
  );

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

  const toggleSession = useCallback((sessionId: string): void => {
    setExpandedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }, []);

  const toggleRun = useCallback((runId: string): void => {
    setExpandedRuns((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  }, []);

  // 6a: open the run as an in-place overlay drawer (no route change) so closing
  // it returns the user to the session they were viewing.
  const openRun = useCallback((runId: string): void => {
    setOpenRunId(runId);
  }, []);

  return (
    <section className="flex flex-col h-full">
      <div className="h-8 overflow-hidden rounded-lg mb-2 shrink-0">
        <GeoBanner theme="sessions" />
      </div>
      <h1 className="text-lg font-semibold gradient-text mb-2 shrink-0">Sessions</h1>

      {/* Fleet workflow KPIs + filters (consolidated from the former Workflows
          view). Filters scope the KPIs AND the master list below. */}
      <Card tone="static" padding="sm" className="mb-2 shrink-0">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 divide-x divide-border-subtle">
          <div className="px-3 first:pl-0">
            <Kpi
              label="Workflow runs"
              value={String(kpis.totalRuns)}
              numericValue={kpis.totalRuns}
              animate
            />
          </div>
          <div className="px-3">
            <Kpi
              label="Subagents"
              value={String(kpis.totalAgents)}
              numericValue={kpis.totalAgents}
              animate
            />
          </div>
          <div className="px-3">
            <Kpi
              label="Workflow spend"
              value={formatUsdOrDash(kpis.totalSpend)}
              tone={kpis.totalSpend !== null ? 'warn' : 'neutral'}
            />
          </div>
          <div className="px-3">
            <Kpi
              label="Avg duration"
              value={kpis.avgDurationMs !== null ? formatDuration(kpis.avgDurationMs) : '—'}
            />
          </div>
        </div>
      </Card>

      <div className="flex items-center gap-3 flex-wrap mb-2 shrink-0">
        <Tabs<TimeWindow>
          value={activeWindow}
          onChange={setActiveWindow}
          options={TIME_WINDOW_OPTIONS}
          ariaLabel="Time window"
        />
        <div className="h-4 w-px bg-border-subtle" aria-hidden="true" />
        <div className="flex items-center gap-1.5" role="group" aria-label="Run source filter">
          {RUN_SOURCE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              aria-pressed={runSourceFilter === opt.value}
              onClick={() => setRunSourceFilter(opt.value)}
              className={[
                'px-2.5 py-1 rounded-full text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/40',
                runSourceFilter === opt.value
                  ? 'bg-accent-cyan/20 text-accent-cyan font-medium'
                  : 'text-ink-muted hover:text-ink-subtle',
              ].join(' ')}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <div className="h-4 w-px bg-border-subtle" aria-hidden="true" />
        <div className="flex items-center gap-1.5" role="group" aria-label="Status filter">
          {STATUS_OPTIONS.map((opt) => {
            const active = statusFilter === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                aria-pressed={active}
                onClick={() => setStatusFilter(opt.value)}
                className={[
                  'px-2.5 py-1 rounded-full text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/40',
                  active
                    ? 'bg-accent-green/20 text-accent-green font-medium'
                    : 'text-ink-muted hover:text-ink-subtle',
                ].join(' ')}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        {filtersActive && (
          <button
            type="button"
            onClick={() => {
              setActiveWindow('all');
              setRunSourceFilter('all');
              setStatusFilter('all');
            }}
            className="text-[10px] text-ink-muted hover:text-ink-subtle underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/40 rounded-sm"
          >
            Clear filters
          </button>
        )}
      </div>

      <div className="grid grid-cols-[260px_1fr] gap-3 flex-1 min-h-0">
        <Card padding="none" tone="static" className="overflow-hidden flex flex-col">
          <header className="p-2 border-b border-border-subtle">
            <div className="flex items-center justify-between">
              <Eyebrow as="h2">List</Eyebrow>
              <select
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value as SortKey)}
                className="text-[10px] bg-surface-5 border border-border-medium rounded-md px-1.5 py-0.5 text-ink-subtle"
              >
                <option value="date">Newest</option>
                <option value="lastActive">Last active</option>
                <option value="cost">Cost</option>
                <option value="calls">Calls</option>
              </select>
            </div>
          </header>
          <div className="overflow-auto">
            {list.isLoading && (
              <EmptyState variant="loading" icon="timeline" title="Loading sessions" />
            )}
            {!list.isLoading && visibleRows.length === 0 && liveSessionIds.size === 0 && (
              <EmptyState
                icon="code"
                title={filtersActive ? 'No matching sessions' : 'No sessions yet'}
                subtitle={
                  filtersActive
                    ? 'No sessions own a workflow run matching these filters.'
                    : 'Start coding with Claude to see your sessions here.'
                }
              />
            )}
            {visibleRows.map((r) => (
              <SessionListRow
                key={r.sessionId}
                row={r}
                isLive={liveSessionIds.has(r.sessionId)}
                isSelected={selectedId === r.sessionId}
                isExpanded={expandedSessions.has(r.sessionId)}
                sortKey={sortKey}
                runs={runsBySession.get(r.sessionId) ?? []}
                expandedRuns={expandedRuns}
                onSelect={handleSessionClick}
                onToggleSession={toggleSession}
                onToggleRun={toggleRun}
                onOpenRun={openRun}
              />
            ))}
            {/* When the API returns the full page, surface that older
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
        </Card>

        <div className="glass-card glass-card-static p-4 overflow-auto">
          {!selectedId && (
            <EmptyState
              icon="timeline"
              title="Loading sessions"
              subtitle="Selecting the most recent session…"
            />
          )}
          {selectedId && detail.isLoading && (
            <EmptyState variant="loading" icon="timeline" title="Loading detail" />
          )}
          {selectedId && detail.data && (
            <SessionTimeline
              data={detail.data}
              isLive={!!selectedId && liveSessionIds.has(selectedId)}
              onOpenRun={openRun}
            />
          )}
        </div>
      </div>

      {/* 6a: in-place workflow-run drawer. Self-contains its backdrop, ESC and
          focus trap (fixed z-50 overlay); we only mount/unmount it. */}
      {openRunId != null && (
        <WorkflowRunDetail runId={openRunId} onClose={() => setOpenRunId(null)} />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Master-list tree row (session → workflow runs → agents)
// ---------------------------------------------------------------------------

interface SessionListRowProps {
  readonly row: SessionRow;
  readonly isLive: boolean;
  readonly isSelected: boolean;
  readonly isExpanded: boolean;
  readonly sortKey: SortKey;
  readonly runs: ReadonlyArray<WorkflowRunInfo>;
  readonly expandedRuns: ReadonlySet<string>;
  readonly onSelect: (sessionId: string) => void;
  readonly onToggleSession: (sessionId: string) => void;
  readonly onToggleRun: (runId: string) => void;
  readonly onOpenRun: (runId: string) => void;
}

// A single session row in the master list. Renders the selectable summary
// button plus a SEPARATE chevron disclosure: clicking the chevron toggles the
// session's workflow-run subtree and stops propagation so the detail-pane
// selection is untouched. Workflow runs are lazily fetched only while expanded.
function SessionListRow({
  row,
  isLive,
  isSelected,
  isExpanded,
  sortKey,
  runs,
  expandedRuns,
  onSelect,
  onToggleSession,
  onToggleRun,
  onOpenRun,
}: SessionListRowProps): JSX.Element {
  return (
    <div className="border-b border-border-subtle">
      <div
        className={
          'flex items-stretch text-xs transition-colors duration-150 hover:bg-surface-5 ' +
          (isSelected ? 'bg-surface-5' : '')
        }
      >
        {/* Disclosure chevron — separate hit target from the select-click.
            stopPropagation keeps it from also changing the detail selection. */}
        <button
          type="button"
          aria-label={isExpanded ? 'Collapse workflows' : 'Expand workflows'}
          aria-expanded={isExpanded}
          onClick={(e) => {
            e.stopPropagation();
            onToggleSession(row.sessionId);
          }}
          className="shrink-0 flex items-center justify-center w-6 text-ink-muted hover:text-ink-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/40"
        >
          {isExpanded ? (
            <ChevronDown size={13} aria-hidden="true" />
          ) : (
            <ChevronRight size={13} aria-hidden="true" />
          )}
        </button>

        {/* Session summary — selects this session in the detail pane. */}
        <button
          type="button"
          onClick={() => onSelect(row.sessionId)}
          className="flex-1 min-w-0 text-left py-2 pr-2"
        >
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="font-mono text-ink-base truncate">
              {row.sessionName || row.sessionId.slice(0, 8)}
            </span>
            {isLive && <LiveBadge size="sm" label="live" className="shrink-0" />}
          </div>
          <div className="flex justify-between mt-1 text-ink-subtle text-[11px] tabular-nums">
            <span>{row.toolCallCount ?? 0} calls</span>
            <span
              className="text-ink-muted"
              title={
                sortKey === 'lastActive' && row.startTime
                  ? `Started ${fmtDateTime(row.startTime)}`
                  : undefined
              }
            >
              {!row.startTime
                ? '—'
                : sortKey === 'lastActive'
                  ? fmtDateTime(lastActiveMs(row))
                  : fmtDateTime(row.startTime)}
            </span>
            <span>{formatUsdOrDash(row.estimatedCostUsd)}</span>
          </div>
        </button>
      </div>

      {/* Level 2: workflow runs for this session (lazy). */}
      {isExpanded && (
        <div className="pl-3 border-l border-border-subtle ml-3 mb-1">
          {runs.length === 0 ? (
            <div className="py-1.5 pl-1 text-[10px] text-ink-muted">
              No workflows in this session.
            </div>
          ) : (
            runs.map((run) => (
              <SessionRunSubRow
                key={run.runId}
                run={run}
                isExpanded={expandedRuns.has(run.runId)}
                onToggleRun={onToggleRun}
                onOpenRun={onOpenRun}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

interface SessionRunSubRowProps {
  readonly run: WorkflowRunInfo;
  readonly isExpanded: boolean;
  readonly onToggleRun: (runId: string) => void;
  readonly onOpenRun: (runId: string) => void;
}

// A workflow-run sub-row beneath an expanded session. Its own chevron lazily
// fetches the run detail and lists this run's agents (level 3). Clicking the
// run body (or any agent) opens the run in the in-place drawer (onOpenRun).
function SessionRunSubRow({
  run,
  isExpanded,
  onToggleRun,
  onOpenRun,
}: SessionRunSubRowProps): JSX.Element {
  const { data: detail } = useQuery<WorkflowRunDetailResponse>({
    queryKey: qk.workflowDetail(run.runId),
    queryFn: () => fetchWorkflowDetail(run.runId),
    enabled: isExpanded,
  });

  const agents = useMemo<ReadonlyArray<AgentRow>>(() => detail?.agents ?? [], [detail]);

  const pillMeta = WORKFLOW_STATUS_PILL[run.status] ?? WORKFLOW_STATUS_PILL.unknown;

  return (
    <div>
      <div className="flex items-stretch hover:bg-surface-5 rounded transition-colors">
        {/* Run disclosure chevron — lazy-loads agents; stopPropagation so it
            does not also open the run drawer. */}
        <button
          type="button"
          aria-label={isExpanded ? 'Collapse agents' : 'Expand agents'}
          aria-expanded={isExpanded}
          onClick={(e) => {
            e.stopPropagation();
            onToggleRun(run.runId);
          }}
          className="shrink-0 flex items-center justify-center w-5 text-ink-muted hover:text-ink-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/40"
        >
          {isExpanded ? (
            <ChevronDown size={12} aria-hidden="true" />
          ) : (
            <ChevronRight size={12} aria-hidden="true" />
          )}
        </button>

        {/* Run body — opens the run in the in-place drawer. */}
        <button
          type="button"
          aria-label={`View workflow run ${run.workflowName ?? run.runId}`}
          onClick={() => onOpenRun(run.runId)}
          className="flex-1 min-w-0 flex items-center gap-1.5 text-left py-1.5 pr-1 text-[10px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/40 rounded"
        >
          <span className="flex-1 min-w-0 font-medium text-ink-base truncate">
            {run.workflowName ?? run.runId}
          </span>
          <span className="text-ink-muted tabular-nums shrink-0">
            {run.agentCount != null ? run.agentCount : 0}a
          </span>
          <span className="text-ink-muted tabular-nums shrink-0">
            {formatUsdOrDash(run.totalUsd)}
          </span>
          <Pill tone={pillMeta.tone} size="sm" bordered>
            {pillMeta.label}
          </Pill>
        </button>
      </div>

      {/* Level 3: agents for this run (lazy). */}
      {isExpanded && (
        <div className="pl-3 border-l border-border-subtle ml-2.5">
          {agents.length === 0 ? (
            <div className="py-1 pl-1 text-[10px] text-ink-muted">No agents recorded.</div>
          ) : (
            agents.map((agent) => (
              <button
                key={agent.agentId}
                type="button"
                aria-label={`View agent ${agent.label} in run ${run.workflowName ?? run.runId}`}
                onClick={() => onOpenRun(run.runId)}
                className="flex w-full items-center gap-1.5 text-left py-1 pr-1 text-[10px] hover:bg-surface-5 rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/40"
              >
                <span className="flex-1 min-w-0 text-ink-subtle truncate" title={agent.label}>
                  {agent.label}
                </span>
                <span
                  className="font-mono text-ink-muted truncate max-w-[72px] shrink-0"
                  title={agent.model}
                >
                  {agent.model}
                </span>
                <span className="text-ink-muted tabular-nums shrink-0">
                  {fmtTokensCompact(agent.tokens)}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function toolBarColor(toolName: string): string {
  if (toolName === 'Read') return 'bg-accent-blue/80';
  if (toolName === 'Edit' || toolName === 'Write') return 'bg-accent-green/80';
  if (toolName === 'Bash') return 'bg-accent-purple/80';
  if (toolName === 'Agent') return 'bg-accent-teal/80';
  return 'bg-ink-subtle/80';
}

function SessionTimeline({
  data,
  isLive,
  onOpenRun,
}: {
  data: SessionDetail;
  isLive: boolean;
  onOpenRun: (runId: string) => void;
}): JSX.Element {
  const breakdown = data.toolBreakdown ?? {};
  const breakdownEntries = Object.entries(breakdown).sort((a, b) => b[1] - a[1]);
  const totalCalls = data.toolCallCount ?? 0;
  const durationLabel = data.durationMs != null ? formatDuration(data.durationMs) : null;
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
            {/* Identifier in mono so it looks identical to the left-aside list.
                Each meta segment is its own span — the bullet separators sit
                outside any uppercase scope, and the duration ("15h 30m")
                escapes the uppercase span so its abbreviated units don't get
                rendered as "15H 30M". */}
            <span
              className={`font-mono text-ink-base ${data.sessionName ? 'font-medium' : 'uppercase'}`}
            >
              {data.sessionName || data.sessionId.slice(0, 8)}
            </span>
            <span aria-hidden="true">·</span>
            <span className="uppercase">{totalCalls} calls</span>
            {durationLabel && (
              <>
                <span aria-hidden="true">·</span>
                <span className="tabular-nums">{durationLabel}</span>
              </>
            )}
            {isLive && <LiveBadge size="sm" label="live" />}
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
            <Eyebrow>Model</Eyebrow>
            <div className="font-mono">{data.model}</div>
          </div>
        )}
        {data.estimatedCostUsd != null && (
          <div className="bg-surface-3 rounded-lg p-2.5">
            <Eyebrow>Cost</Eyebrow>
            <div className="tabular-nums">{formatUsd(data.estimatedCostUsd)}</div>
          </div>
        )}
        {data.outcome && (
          <div className="bg-surface-3 rounded-lg p-2.5">
            <Eyebrow>Status</Eyebrow>
            <div className="capitalize">{data.outcome}</div>
          </div>
        )}
      </div>

      {(data.antiPatterns?.length ?? 0) > 0 && (
        <div className="mb-4">
          <Eyebrow className="mb-1">Anti-Patterns</Eyebrow>
          <div className="flex flex-wrap gap-1.5">
            {data.antiPatterns!.map(({ type, count }) => (
              <Pill key={type} tone="warning" size="sm" bordered>
                {SEGMENT_LABELS[type] ?? type}
                <span className="opacity-70">× {count}</span>
              </Pill>
            ))}
          </div>
        </div>
      )}

      {(data.qualityProxy || data.toolSelectionScore) && (
        <div className="grid grid-cols-2 gap-3 mb-4">
          {data.qualityProxy && (
            <div className="bg-surface-3 rounded-lg p-3">
              <Eyebrow className="mb-2">Session Quality</Eyebrow>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <span className="text-ink-muted">Diff Apply </span>
                  <span className={rateColor(data.qualityProxy.diffApplyRate)}>
                    {data.qualityProxy.diffApplyRate !== null
                      ? `${(data.qualityProxy.diffApplyRate * 100).toFixed(0)}%`
                      : '—'}
                  </span>
                </div>
                <div>
                  <span className="text-ink-muted">Test Pass </span>
                  <span className={rateColor(data.qualityProxy.testPassRate)}>
                    {data.qualityProxy.testPassRate !== null
                      ? `${(data.qualityProxy.testPassRate * 100).toFixed(0)}%`
                      : '—'}
                  </span>
                </div>
                <div>
                  <span className="text-ink-muted">Backtracks </span>
                  <span className={data.qualityProxy.backtrackCount > 0 ? 'text-accent-amber' : ''}>
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
              <Eyebrow className="mb-2">Tool Selection</Eyebrow>
              <div
                className={`text-2xl font-semibold tabular-nums ${scoreColor(data.toolSelectionScore.score)}`}
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

      {isLive && (
        <div className="mb-4">
          <ContextBar sessionId={data.sessionId} />
        </div>
      )}

      {/* Tools + activity density sit ABOVE the (often very long) session trace
          so they stay visible without scrolling past the whole gantt/list. */}
      {breakdownEntries.length > 0 && (
        <ToolsSection
          breakdownEntries={breakdownEntries}
          totalCalls={totalCalls}
          isLive={isLive}
          sessionId={data.sessionId}
        />
      )}

      <SessionActivityStrip timeline={entries} />
      {(data.filesRead?.length ?? 0) > 0 && (
        <div className="mb-4">
          <Eyebrow className="mb-1">Files Read</Eyebrow>
          <ul className="text-[11px] text-ink-subtle space-y-0.5">
            {data.filesRead!.map((f) => (
              <li key={f} className="font-mono truncate">
                {f.split('/').slice(-2).join('/')}
              </li>
            ))}
          </ul>
        </div>
      )}

      {(data.filesModified?.length ?? 0) > 0 && (
        <div className="mb-4">
          <Eyebrow className="mb-1">Files Modified</Eyebrow>
          <ul className="text-[11px] text-ink-subtle space-y-0.5">
            {data.filesModified!.map((f) => (
              <li key={f} className="font-mono truncate">
                {f.split('/').slice(-2).join('/')}
              </li>
            ))}
          </ul>
        </div>
      )}

      <SessionTraceSection
        key={data.sessionId}
        sessionId={data.sessionId}
        isLive={isLive}
        parentEntries={entries}
        onOpenRun={onOpenRun}
      />
    </div>
  );
}

// Unified session trace (parent tool calls + subagents on one shared axis).
// Sits directly beneath the per-session workflows list and replaces the two
// formerly-redundant cards (the AgentSwimlanes "Session timeline" card and the
// Gantt/List "Replay" card): the single SessionTrace component now owns both
// the parent tool-call gantt and the subagent fan-out, attributing every call
// to its owning agent/run on one shared x-scale.
//
// This wrapper retains the subagents query (GET /api/sessions/:id/subagents)
// and recomputes the shared time window so SessionTrace's parent + subagent
// lanes share one scale:
//   - startMs = min(first parent ts, subagents.window.startMs)
//   - endMs   = max(last parent activity end, subagents.window.endMs)
// Guards: parent timeline may be empty (use the subagent window) and the
// subagent window may be degenerate. Computed unconditionally to keep hook
// order stable; only consumed on the success branch.
//
// Three-state rendering of the subagent fetch (mirrors the loading/error/empty
// pattern the prior SessionSubagents card used):
//   - isLoading            → loading affordance.
//   - isError / no data    → "Subagent timeline unavailable" EmptyState. The
//     query runs with retry:false, so a disabled subagent watcher (a documented
//     opt-in v0 state) or a failed fetch settles here. We still render the
//     parent trace (agents={[]}) so the parent tool calls remain visible.
//   - success (data set)   → unified SessionTrace (parent lane + subagents) on
//     the shared window.
function SessionTraceSection({
  sessionId,
  isLive,
  parentEntries,
  onOpenRun,
}: {
  sessionId: string;
  isLive: boolean;
  parentEntries: ReadonlyArray<TimelineEntry>;
  onOpenRun: (runId: string) => void;
}): JSX.Element {
  const { data, isLoading, isError } = useQuery<SessionSubagentsResponse>({
    queryKey: qk.sessionSubagents(sessionId),
    queryFn: () => fetchSessionSubagents(sessionId),
    retry: false,
    refetchInterval: isLive ? 10_000 : false,
  });

  // 6b: workflow run statuses for this session, keyed by runId, so the trace
  // can badge each run lane with its current status. Reuses the shared
  // workflows query/key (same cache as SessionWorkflows / the master list).
  const { data: rawWorkflows } = useQuery({
    queryKey: qk.workflows,
    queryFn: fetchWorkflows,
    refetchInterval: isLive ? 10_000 : 30_000,
  });

  const runStatusById = useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    if (!Array.isArray(rawWorkflows)) return map;
    for (const run of rawWorkflows) {
      if (run.parentSessionId === sessionId) {
        map[run.runId] = run.status;
      }
    }
    return map;
  }, [rawWorkflows, sessionId]);

  const agents = useMemo<ReadonlyArray<AgentSpan>>(() => data?.agents ?? [], [data]);

  // Shared time window spanning both the parent tool-call timeline and the
  // subagent fan-out, so SessionTrace's parent lane + subagent lanes share one
  // x-scale. Computed unconditionally to keep hook order stable; only consumed
  // on the success branch.
  const sharedWindow = useMemo<{ startMs: number; endMs: number } | null>(() => {
    const hasAgents = data !== undefined && (data.agents?.length ?? 0) > 0;
    const subStart = hasAgents ? data!.window.startMs : null;
    const subEnd = hasAgents ? data!.window.endMs : null;

    let parentStart: number | null = null;
    let parentEnd: number | null = null;
    for (const e of parentEntries) {
      const start = e.timestamp;
      const end = e.timestamp + (e.durationMs ?? 50);
      if (parentStart === null || start < parentStart) parentStart = start;
      if (parentEnd === null || end > parentEnd) parentEnd = end;
    }

    const starts = [parentStart, subStart].filter((v): v is number => v !== null);
    const ends = [parentEnd, subEnd].filter((v): v is number => v !== null);
    if (starts.length === 0 || ends.length === 0) return null;

    return { startMs: Math.min(...starts), endMs: Math.max(...ends) };
  }, [data, parentEntries]);

  // The parent timeline entries shaped for the SessionTrace parent lane — the
  // ReplayTimelineEntry fields (timestamp / toolName / durationMs / success /
  // filePath / command). A fresh array of plain objects, passed straight
  // through; SessionTrace accepts those.
  const parentTraceEntries = useMemo(
    () =>
      parentEntries.map((e) => ({
        timestamp: e.timestamp,
        toolName: e.toolName,
        durationMs: e.durationMs,
        success: e.success,
        filePath: e.filePath,
        command: e.command,
      })),
    [parentEntries],
  );

  return (
    <div className="mb-4">
      <Eyebrow className="mb-2">Session trace</Eyebrow>
      <Card tone="static" padding="sm">
        {isLoading ? (
          <EmptyState variant="loading" icon="radar" title="Loading subagents" />
        ) : isError || data === undefined ? (
          // Subagent fetch failed or watcher disabled: still render the parent
          // trace (agents={[]}) so the parent tool calls remain visible rather
          // than silently blanking the section.
          <SessionTrace
            sessionId={sessionId}
            parentEntries={parentTraceEntries}
            agents={[]}
            window={sharedWindow ?? { startMs: 0, endMs: 1 }}
            onSelectRun={onOpenRun}
            runStatusById={runStatusById}
          />
        ) : (
          <SessionTrace
            sessionId={sessionId}
            parentEntries={parentTraceEntries}
            agents={agents}
            window={sharedWindow ?? data.window}
            onSelectRun={onOpenRun}
            runStatusById={runStatusById}
          />
        )}
      </Card>
    </div>
  );
}

function ToolsSection({
  breakdownEntries,
  totalCalls,
  isLive,
  sessionId,
}: {
  breakdownEntries: [string, number][];
  totalCalls: number;
  isLive: boolean;
  sessionId: string;
}): JSX.Element {
  const [tab, setTab] = useState<'calls' | 'context'>('calls');

  const contextUrl = `/api/context?sessionId=${encodeURIComponent(sessionId)}`;
  const { data: contextData } = useQuery<ContextResponse>({
    queryKey: ['context', sessionId],
    queryFn: () => fetch(contextUrl).then((r) => (r.ok ? r.json() : null)),
    refetchInterval: 10_000,
    enabled: isLive && tab === 'context',
  });

  const toolContributions = contextData?.toolContributions ?? [];
  const maxTokens = toolContributions.length > 0 ? toolContributions[0]!.estimatedTokens : 0;

  return (
    <div className="mb-4">
      <div className="flex items-center justify-between mb-2">
        <Eyebrow>Tools</Eyebrow>
        {isLive && (
          <Tabs<'calls' | 'context'>
            value={tab}
            onChange={setTab}
            options={[
              { value: 'calls', label: 'Calls' },
              { value: 'context', label: 'Context' },
            ]}
            size="sm"
            tone="cyan"
            ariaLabel="Tools view"
          />
        )}
      </div>
      <div className="flex flex-col gap-1">
        {tab === 'calls' &&
          breakdownEntries.map(([tool, count]) => {
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
        {tab === 'context' &&
          toolContributions.map((tc) => {
            const pct = maxTokens > 0 ? (tc.estimatedTokens / maxTokens) * 100 : 0;
            return (
              <div key={tc.tool} className="flex items-center gap-2 text-[11px]">
                <span className="w-28 text-ink-subtle truncate" title={tc.tool}>
                  {shortToolName(tc.tool)}
                </span>
                <div className="flex-1 h-3 bg-surface-3 relative rounded">
                  <div className="h-3 rounded bg-accent-amber/80" style={{ width: `${pct}%` }} />
                </div>
                <span className="w-16 text-right text-ink-muted tabular-nums text-[10px]">
                  ~{formatTokens(tc.estimatedTokens)}
                </span>
              </div>
            );
          })}
        {tab === 'context' && toolContributions.length === 0 && (
          <div className="text-[11px] text-ink-muted">No context data available yet</div>
        )}
      </div>
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
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
      <Eyebrow className="mb-1">Activity Density</Eyebrow>
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
