import type { JSX } from 'react';
import { Fragment, useState } from 'react';
import { useLocation } from 'wouter';

import { useQuery } from '@tanstack/react-query';
import {
  fetchGitEfficiency,
  formatScope,
  qk,
  type GitSuggestion,
  type MergeConflictRecord,
  type GitWorkspaceReport,
  type WorkspaceRow,
  type WorktreeIdentity,
  type ScopeRefInput,
} from '../api/client';
import { AnimatedCard } from '../components/AnimatedCard';
import { EmptyState } from '../components/EmptyState';
import { GeoBanner } from '../components/GeoBanner';
import { Kpi } from '../components/Kpi';
import { Card, Eyebrow, Pill, SectionHeader } from '../components/ui';
import type { PillTone } from '../components/ui';

/** Formats a same-metric delta against the previous 7-day period for a
 *  `Kpi`'s `sub` text. Null while that comparison window hasn't loaded yet —
 *  never rendered as "+0". */
function formatDeltaVsLastWeek(thisWeek: number, lastWeek: number | null): string | null {
  if (lastWeek === null) return null;
  const delta = thisWeek - lastWeek;
  if (delta === 0) return 'same as last week';
  return delta > 0 ? `+${delta} vs last week` : `${delta} vs last week`;
}

const SEVERITY_STYLE: Record<GitSuggestion['severity'], string> = {
  info: 'border-l-accent-blue bg-accent-blue/5',
  warning: 'border-l-accent-amber bg-accent-amber/5',
  critical: 'border-l-accent-red bg-accent-red/5',
};

const SEVERITY_TONE: Record<GitSuggestion['severity'], PillTone> = {
  info: 'info',
  warning: 'warning',
  critical: 'danger',
};

const RESOLUTION_STYLE: Record<MergeConflictRecord['resolution'], string> = {
  resolved: 'text-accent-green',
  aborted: 'text-accent-red',
  pending: 'text-accent-amber',
};

const EVENT_TYPE_COLORS: Record<string, string> = {
  merge_conflict: 'bg-accent-red/20 text-accent-red',
  rebase_conflict: 'bg-accent-red/20 text-accent-red',
  merge_abort: 'bg-accent-amber/20 text-accent-amber',
  rebase_abort: 'bg-accent-amber/20 text-accent-amber',
  force_push: 'bg-accent-red/20 text-accent-red',
  reset_hard: 'bg-accent-amber/20 text-accent-amber',
  commit: 'bg-accent-green/20 text-accent-green',
  push: 'bg-accent-blue/20 text-accent-blue',
  pull: 'bg-accent-blue/20 text-accent-blue',
};

function formatMs(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

function formatEventType(type: string): string {
  return type.replace(/_/g, ' ');
}

/** Time-only for today's events; date-prefixed for older ones so the ordering reads correctly. */
function formatEventTime(timestamp: number): string {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return '—';
  const time = d.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
}

/** "as of Xm ago" style relative label for a `liveState.measuredAtMs` sample. */
function formatAgo(measuredAtMs: number): string {
  const deltaMs = Date.now() - measuredAtMs;
  if (deltaMs < 0 || deltaMs < 1000) return 'as of just now';
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return `as of ${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `as of ${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `as of ${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `as of ${days}d ago`;
}

/** Renders an exact `[sinceMs, untilMs)` window as a short date range, e.g.
 *  "Aug 29 – Sep 4" — used everywhere a window's real bounds need to be
 *  shown rather than a vague word like "recent". `untilMs` is shown as its
 *  own date (not "today") since a comparison-baseline window's `until` is
 *  never "now". */
function formatDateRange(sinceMs: number, untilMs: number): string {
  const fmt = (ms: number): string =>
    new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  // `untilMs` is an exclusive upper bound (start-of-day for a fixed window,
  // or "now" for a live one) — subtract a millisecond so a window ending at
  // midnight displays as the prior calendar day, not the next one.
  return `${fmt(sinceMs)} – ${fmt(untilMs - 1)}`;
}

/** Tone for a "commits behind" style KPI — null (unknown) stays neutral so it
 *  never coalesces to the "good" green a confirmed 0 would render. */
function behindTone(n: number | null): 'neutral' | 'good' | 'warn' | 'bad' {
  if (n === null) return 'neutral';
  if (n > 20) return 'bad';
  if (n > 5) return 'warn';
  return 'good';
}

function ScoreRing({ score }: { score: number | null }): JSX.Element {
  if (score === null) {
    return (
      <div className="flex items-center justify-center w-20 h-20 rounded-full border-4 border-border-medium">
        <span className="text-ink-muted text-xs">N/A</span>
      </div>
    );
  }

  // Clamp score to [0, 100] so out-of-range values don't produce negative
  // strokeDashoffset (arc overflows full circle) or > circumference (arc disappears).
  const clampedScore = Math.max(0, Math.min(100, score));
  const [textColor, borderColor] =
    clampedScore >= 80
      ? ['text-accent-green', 'border-accent-green']
      : clampedScore >= 60
        ? ['text-accent-amber', 'border-accent-amber']
        : ['text-accent-red', 'border-accent-red'];

  const circumference = 2 * Math.PI * 34;
  const offset = circumference - (clampedScore / 100) * circumference;

  return (
    <div className="relative w-20 h-20">
      <svg className="w-20 h-20 -rotate-90" viewBox="0 0 80 80">
        <circle
          cx="40"
          cy="40"
          r="34"
          fill="none"
          stroke="rgba(255,255,255,0.08)"
          strokeWidth="6"
        />
        <circle
          cx="40"
          cy="40"
          r="34"
          fill="none"
          className={borderColor}
          stroke="currentColor"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ transition: 'stroke-dashoffset 0.8s ease-out' }}
        />
      </svg>
      <div
        className={`absolute inset-0 flex items-center justify-center text-lg font-bold ${textColor}`}
      >
        {score}
      </div>
    </div>
  );
}

interface WorkspaceGroup {
  readonly repoKey: string;
  readonly repoName: string | null;
  readonly rows: readonly WorkspaceRow[];
  readonly lastActivityMs: number | null;
  /** Union (deduped) of every row's own sessionIds — a session that touched
   *  more than one worktree in this repo is still counted once here. */
  readonly sessionIds: readonly string[];
}

/** `/sessions?sessionIds=...` — precise, not an approximation by repo name:
 *  exactly the sessions that produced activity in this row/group. With
 *  exactly one session, skips the filtered-list detour entirely and links
 *  straight to that session's own detail view (`?session=`) — a list of one
 *  row the user would just have to click again is a wasted step. */
function sessionsPath(ids: readonly string[]): string {
  if (ids.length === 1) return `/sessions?session=${encodeURIComponent(ids[0]!)}`;
  return `/sessions?sessionIds=${ids.map(encodeURIComponent).join(',')}`;
}

/** Nulls sort last — an unknown last-activity time is worse information than
 *  "definitely long ago," never better, so it never floats above real data. */
function byLastActivityDesc(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

/** Groups rows by `identity.repoKey` (the real identity — `repoName` can be
 *  null or, in principle, shared by two unrelated repos), sorting worktrees
 *  within a repo and repos themselves by most-recent activity. */
function groupWorkspaceRows(rows: readonly WorkspaceRow[]): readonly WorkspaceGroup[] {
  const byRepo = new Map<string, WorkspaceRow[]>();
  for (const row of rows) {
    const existing = byRepo.get(row.identity.repoKey);
    if (existing) existing.push(row);
    else byRepo.set(row.identity.repoKey, [row]);
  }

  const groups: WorkspaceGroup[] = [];
  for (const [repoKey, groupRows] of byRepo) {
    const sortedRows = [...groupRows].sort((a, b) =>
      byLastActivityDesc(a.metrics.lastActivityMs, b.metrics.lastActivityMs),
    );
    const lastActivityMs = sortedRows.reduce<number | null>((max, r) => {
      const ts = r.metrics.lastActivityMs;
      if (ts === null) return max;
      return max === null || ts > max ? ts : max;
    }, null);
    groups.push({
      repoKey,
      repoName: sortedRows[0]?.identity.repoName ?? null,
      rows: sortedRows,
      lastActivityMs,
      sessionIds: [...new Set(sortedRows.flatMap((r) => r.metrics.sessionIds))],
    });
  }

  return groups.sort((a, b) => byLastActivityDesc(a.lastActivityMs, b.lastActivityMs));
}

interface WorkspaceTreeProps {
  readonly rows: readonly WorkspaceRow[];
  readonly scope: ScopeRefInput;
  readonly onSelectRepo: (identity: WorktreeIdentity) => void;
  readonly onSelectWorktree: (identity: WorktreeIdentity) => void;
}

/** Repo -> worktree tree, sorted by most-recent activity — NOT filtered by
 *  the currently-selected scope (the scope drills into the cards below; this
 *  tree is always the full picture so a click can broaden or narrow it).
 *  The currently-selected repo or worktree is highlighted directly in the
 *  tree, since the breadcrumb above is easy to miss. */
function WorkspaceTree({
  rows,
  scope,
  onSelectRepo,
  onSelectWorktree,
}: WorkspaceTreeProps): JSX.Element {
  const [, navigate] = useLocation();
  const [collapsedRepos, setCollapsedRepos] = useState<ReadonlySet<string>>(new Set());

  if (rows.length === 0) {
    return <EmptyState icon="code" title="No git activity in this window" />;
  }

  const groups = groupWorkspaceRows(rows);
  const selectedRepoKey = typeof scope === 'object' && 'repo' in scope ? scope.repo : null;
  const selectedWorktreeKey =
    typeof scope === 'object' && 'worktree' in scope ? scope.worktree : null;

  const toggleGroup = (repoKey: string): void => {
    setCollapsedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(repoKey)) next.delete(repoKey);
      else next.add(repoKey);
      return next;
    });
  };

  return (
    <div className="max-h-64 overflow-auto">
      <table className="w-full text-xs">
        <thead className="text-ink-muted bg-bg-panel sticky top-0">
          <tr>
            <th className="text-left p-2">Repo / worktree</th>
            <th className="text-left p-2">Branch</th>
            <th className="text-left p-2">Commits</th>
            <th className="text-left p-2">Conflicts</th>
            <th className="text-left p-2">Best practices</th>
            <th className="text-left p-2">Sessions</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => {
            const isCollapsed = collapsedRepos.has(group.repoKey);
            // "Selected" at the repo row means scope is narrowed to exactly
            // this repo (not a specific worktree within it) — a worktree
            // selection is indicated on its own row below instead.
            const repoSelected = selectedRepoKey === group.repoKey && selectedWorktreeKey === null;
            const repoIdentity = group.rows[0]!.identity;
            return (
              <Fragment key={group.repoKey}>
                <tr
                  className={`border-t border-border-subtle ${repoSelected ? 'bg-accent-blue/10' : ''}`}
                >
                  <td className="p-2 whitespace-nowrap" colSpan={5}>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => toggleGroup(group.repoKey)}
                        aria-label={isCollapsed ? 'Expand' : 'Collapse'}
                        aria-expanded={!isCollapsed}
                        className="text-ink-muted hover:text-ink-base w-4 shrink-0 text-center"
                      >
                        {isCollapsed ? '▸' : '▾'}
                      </button>
                      <button
                        type="button"
                        onClick={() => onSelectRepo(repoIdentity)}
                        className={`font-mono font-semibold hover:underline ${
                          repoSelected ? 'text-accent-blue' : 'text-ink-base'
                        }`}
                      >
                        {repoSelected && (
                          <span aria-hidden="true" className="mr-1">
                            &#9679;
                          </span>
                        )}
                        {group.repoName ?? group.repoKey}
                      </button>
                      <span className="text-ink-muted text-[10px]">
                        {group.rows.length} worktree{group.rows.length === 1 ? '' : 's'}
                      </span>
                    </div>
                  </td>
                  <td className="p-2 tabular-nums">
                    {group.sessionIds.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => navigate(sessionsPath(group.sessionIds))}
                        className="text-accent-blue hover:underline"
                        title={(() => {
                          const rawSum = group.rows.reduce(
                            (sum, r) => sum + r.metrics.sessionIds.length,
                            0,
                          );
                          // The per-row counts below can sum to more than
                          // this — a session that touched more than one
                          // worktree in this repo is still counted once
                          // here, not once per worktree it touched.
                          return rawSum > group.sessionIds.length
                            ? `${group.sessionIds.length} distinct sessions — some touched more than one worktree`
                            : 'View these sessions';
                        })()}
                      >
                        {group.sessionIds.length}
                      </button>
                    ) : (
                      <span className="text-ink-muted">—</span>
                    )}
                  </td>
                </tr>
                {!isCollapsed &&
                  group.rows.map((row) => {
                    const known = row.metrics.bestPractices.filter(
                      (bp) => bp.status !== 'unknown' && bp.status !== 'n/a',
                    );
                    const passing = row.metrics.bestPractices.filter(
                      (bp) => bp.status === 'pass',
                    ).length;
                    const conflicts = row.metrics.mergeConflicts + row.metrics.rebaseConflicts;
                    const worktreeSelected = selectedWorktreeKey === row.identity.worktreeKey;
                    return (
                      <tr
                        key={row.identity.worktreeKey}
                        className={`border-t border-border-subtle ${
                          worktreeSelected ? 'bg-accent-blue/10' : ''
                        }`}
                      >
                        <td className="p-2 pl-8 whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => onSelectWorktree(row.identity)}
                            className={`font-mono hover:underline ${
                              worktreeSelected
                                ? 'text-accent-blue font-semibold'
                                : 'text-ink-subtle'
                            }`}
                          >
                            {worktreeSelected && (
                              <span aria-hidden="true" className="mr-1">
                                &#9679;
                              </span>
                            )}
                            {row.identity.worktreeLabel}
                          </button>
                        </td>
                        <td className="p-2 font-mono text-ink-subtle whitespace-nowrap">
                          {row.identity.branch ?? '—'}
                        </td>
                        <td className="p-2 tabular-nums">{row.metrics.commitCount}</td>
                        <td className="p-2 tabular-nums">{conflicts}</td>
                        <td className="p-2 tabular-nums text-ink-subtle">
                          {known.length > 0 ? `${passing}/${known.length}` : '—'}
                        </td>
                        <td className="p-2 tabular-nums">
                          {row.metrics.sessionIds.length > 0 ? (
                            <button
                              type="button"
                              onClick={() => navigate(sessionsPath(row.metrics.sessionIds))}
                              className="text-accent-blue hover:underline"
                              title="View these sessions"
                            >
                              {row.metrics.sessionIds.length}
                            </button>
                          ) : (
                            <span className="text-ink-muted">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function GitEfficiency(): JSX.Element {
  const [, navigate] = useLocation();
  const [scope, setScope] = useState<ScopeRefInput>('all');
  // The identity of whichever row was last clicked into — carried alongside
  // `scope` purely so the breadcrumb always has a display name/label, even if
  // that workspace later drops out of `report.rows` (e.g. it goes idle).
  const [scopeIdentity, setScopeIdentity] = useState<WorktreeIdentity | null>(null);

  // Hero KPIs, coaching, velocity, PRs, and the timeline are always "last 7
  // days" for the currently-selected scope — there is no picker that can
  // change this window; the exact date range is rendered from
  // report.since/until so it's never ambiguous what "recent" means here.
  const {
    data: report,
    isLoading,
    error,
  } = useQuery<GitWorkspaceReport>({
    queryKey: qk.gitEfficiency('week', formatScope(scope)),
    queryFn: () => fetchGitEfficiency('week', formatScope(scope)),
    refetchInterval: 5000,
  });

  // The 7 days immediately before `report`'s window, same scope — a
  // week-over-week comparison baseline for the "+N vs last week" deltas
  // below. Never rendered on its own, and never affects coaching/best-
  // practices, which only ever read `report` (the current week).
  const { data: previousWeekReport } = useQuery<GitWorkspaceReport>({
    queryKey: qk.gitEfficiency('previous_week', formatScope(scope)),
    queryFn: () => fetchGitEfficiency('previous_week', formatScope(scope)),
    // A fully-past, fixed comparison baseline — no need to poll it as
    // aggressively as the current week's live numbers.
    refetchInterval: 60_000,
  });

  // The repo/worktree tree below always shows the last 30 days across every
  // repo — deliberately a wider, independent window from the 7-day hero KPIs
  // above, and deliberately always scope 'all' regardless of what's
  // currently selected for the KPI cards (rows are never scope-filtered
  // server-side either — the tree is always the full picture to drill from).
  const { data: treeReport } = useQuery<GitWorkspaceReport>({
    queryKey: qk.gitEfficiency('30', 'all'),
    queryFn: () => fetchGitEfficiency('30', 'all'),
    refetchInterval: 30_000,
  });

  const handleSelectRepo = (identity: WorktreeIdentity): void => {
    setScope({ repo: identity.repoKey });
    setScopeIdentity(identity);
  };
  const handleSelectWorktree = (identity: WorktreeIdentity): void => {
    setScope({ worktree: identity.worktreeKey });
    setScopeIdentity(identity);
  };
  const handleResetScope = (): void => {
    setScope('all');
    setScopeIdentity(null);
  };
  const handleGoToRepo = (): void => {
    if (!scopeIdentity) return;
    setScope({ repo: scopeIdentity.repoKey });
  };

  if (isLoading) return <EmptyState icon="clock" variant="loading" title="Loading..." />;
  if (error)
    return <div className="text-accent-red text-xs">Error loading git efficiency data.</div>;
  if (!report) return <EmptyState icon="clock" variant="loading" title="Loading..." />;

  const metrics = report.metrics;
  const resolvedConflictCount = metrics.conflictHistory.filter(
    (c) => c.resolution === 'resolved',
  ).length;

  // Week-over-week deltas for the same scope — null until previousWeekReport
  // loads, in which case formatDeltaVsLastWeek returns null and the Kpi
  // renders without a delta rather than a misleading "+0".
  const lastWeekCommitCount = previousWeekReport?.metrics.commitCount ?? null;
  const lastWeekPrsCreated = previousWeekReport?.metrics.prMetrics.created ?? null;
  const lastWeekConflictCount = previousWeekReport
    ? previousWeekReport.metrics.mergeConflicts + previousWeekReport.metrics.rebaseConflicts
    : null;
  const conflictCount = metrics.mergeConflicts + metrics.rebaseConflicts;

  return (
    <section>
      <GeoBanner theme="git" />
      {/* items-end (not items-baseline): the score rings on the right are
          much taller than the title/breadcrumb on the left, and baseline
          alignment left a large dead gap below the shorter left column
          before the Repos & Worktrees card — bottom-aligning both columns
          keeps "All repos" flush with the card below it. */}
      <header className="flex items-end justify-between mb-3">
        <div>
          <h1 className="text-xl font-semibold gradient-text">Git Efficiency</h1>

          {/* Scope breadcrumb — starts at "All repos"; drills in as the
              repo/worktree tree or a suggestion below is clicked. */}
          <div className="flex items-center gap-1.5 mt-1 text-[11px]">
            {scope === 'all' ? (
              <span className="text-ink-subtle">All repos</span>
            ) : (
              <>
                <button
                  type="button"
                  onClick={handleResetScope}
                  className="text-ink-muted hover:text-ink-base hover:underline"
                >
                  All repos
                </button>
                <span aria-hidden="true" className="text-ink-muted">
                  /
                </span>
                {'worktree' in scope ? (
                  <>
                    <button
                      type="button"
                      onClick={handleGoToRepo}
                      className="font-mono text-ink-muted hover:text-ink-base hover:underline"
                    >
                      {scopeIdentity?.repoName ?? scopeIdentity?.repoKey ?? 'repo'}
                    </button>
                    <span aria-hidden="true" className="text-ink-muted">
                      /
                    </span>
                    <span className="font-mono text-ink-subtle">
                      {scopeIdentity?.worktreeLabel ?? scope.worktree}
                    </span>
                  </>
                ) : (
                  <span className="font-mono text-ink-subtle">
                    {scopeIdentity?.repoName ?? scope.repo}
                  </span>
                )}
              </>
            )}
            {/* Repo-only, never worktree-specific — which worktree a session
                ran in only lives in its timeline, not on the list summary,
                so there's no reliable way to filter finer than the repo. */}
            {scope !== 'all' && scopeIdentity?.repoName && (
              <button
                type="button"
                onClick={() =>
                  navigate(`/sessions?repo=${encodeURIComponent(scopeIdentity.repoName!)}`)
                }
                className="text-accent-blue hover:underline ml-1"
              >
                View sessions &rarr;
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-center">
            <Eyebrow as="div" className="mb-1">
              Prevention
            </Eyebrow>
            <ScoreRing score={metrics.preventionScore} />
          </div>
          <div className="text-center">
            <Eyebrow as="div" className="mb-1">
              Efficiency
            </Eyebrow>
            <ScoreRing score={metrics.efficiencyScore} />
          </div>
        </div>
      </header>

      {/* Repo/worktree tree — every repo and worktree with activity in the
          last 30 days (deliberately wider than the 7-day hero KPIs, and
          always scope 'all' regardless of what's selected below). Clicking a
          repo or worktree drills the cards below into it. */}
      <AnimatedCard index={0} className="mb-3">
        <Card padding="md">
          <SectionHeader
            title="Repos & Worktrees"
            action={
              <span className="text-[11px] text-ink-muted">
                {(() => {
                  const rows = treeReport?.rows ?? [];
                  const repoCount = new Set(rows.map((r) => r.identity.repoKey)).size;
                  return `${repoCount} repo${repoCount === 1 ? '' : 's'} · ${rows.length} worktree${rows.length === 1 ? '' : 's'}`;
                })()}
              </span>
            }
          />
          <div className="mb-2 text-[11px] text-ink-muted">
            {treeReport
              ? `Last 30 days (${formatDateRange(treeReport.since, treeReport.until)})`
              : 'Loading…'}
          </div>
          {treeReport ? (
            <WorkspaceTree
              rows={treeReport.rows}
              scope={scope}
              onSelectRepo={handleSelectRepo}
              onSelectWorktree={handleSelectWorktree}
            />
          ) : (
            <EmptyState icon="clock" variant="loading" title="Loading..." />
          )}
        </Card>
      </AnimatedCard>

      {metrics.totalGitCommands === 0 ? (
        <EmptyState
          icon="code"
          title="No Git activity yet"
          subtitle="Git efficiency metrics will appear here as git commands are executed during the session."
        />
      ) : (
        <>
          {/* Hero KPIs — what shipped, what's risky, current state. The
              window label lives here, right against the numbers it actually
              describes — not in the page header above, where it read as if
              it also governed the (30-day) Repos & Worktrees tree. */}
          <AnimatedCard index={1} className="mb-3">
            <Card padding="lg" tone="elevated" glow="green">
              <div className="mb-3 text-[11px] text-ink-muted">
                Last 7 days ({formatDateRange(report.since, report.until)}) · compared to the
                previous 7 days
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <Kpi
                  label="commits"
                  hero
                  value={String(metrics.commitCount)}
                  sub={formatDeltaVsLastWeek(metrics.commitCount, lastWeekCommitCount) ?? undefined}
                  animate
                  numericValue={metrics.commitCount}
                />
                <Kpi
                  label="PRs created"
                  tone={metrics.prMetrics.created > 0 ? 'good' : 'neutral'}
                  value={String(metrics.prMetrics.created)}
                  sub={
                    formatDeltaVsLastWeek(metrics.prMetrics.created, lastWeekPrsCreated) ??
                    undefined
                  }
                  animate
                  numericValue={metrics.prMetrics.created}
                />
                <Kpi
                  label="conflicts"
                  tone={conflictCount > 0 ? 'bad' : 'good'}
                  value={String(conflictCount)}
                  sub={[
                    conflictCount === 0 ? 'clean session' : `${resolvedConflictCount} resolved`,
                    formatDeltaVsLastWeek(conflictCount, lastWeekConflictCount),
                  ]
                    .filter((s): s is string => s !== null)
                    .join(' · ')}
                  animate
                  numericValue={conflictCount}
                />
                {report.scope.kind === 'worktree' ? (
                  <Kpi
                    label={`behind ${metrics.liveState?.defaultBranch ?? 'upstream'}`}
                    tone={behindTone(metrics.liveState?.behind ?? null)}
                    value={
                      metrics.liveState?.behind != null ? String(metrics.liveState.behind) : '—'
                    }
                    sub={
                      metrics.liveState?.measuredAtMs != null
                        ? formatAgo(metrics.liveState.measuredAtMs)
                        : undefined
                    }
                    animate
                    numericValue={metrics.liveState?.behind ?? null}
                  />
                ) : (
                  <Kpi
                    label="worst behind"
                    tone={behindTone(report.worstBehind?.behind ?? null)}
                    value={report.worstBehind ? String(report.worstBehind.behind) : '—'}
                    sub={
                      report.worstBehind
                        ? report.worstBehind.identity.repoName
                          ? `${report.worstBehind.identity.worktreeLabel} · ${report.worstBehind.identity.repoName}`
                          : report.worstBehind.identity.worktreeLabel
                        : undefined
                    }
                    animate
                    numericValue={report.worstBehind?.behind ?? null}
                  />
                )}
              </div>
              <div className="mt-3 text-[11px] text-ink-muted leading-relaxed">
                <strong className="text-ink-subtle">Conflicts</strong> = merge/rebase/pull attempts
                that git itself reported a real conflict on (not a live GitHub check).{' '}
                <strong className="text-ink-subtle">Behind</strong> = commits your branch is missing
                vs. its upstream (or the repo&apos;s default branch), as of your last local{' '}
                <code className="font-mono">git fetch</code> — Preflight never fetches on your
                behalf, so this can be stale if you haven&apos;t synced recently.
              </div>
            </Card>
          </AnimatedCard>

          {/* Velocity & workflow — grouped with the other "what happened" data
              sections (this, Pull Requests, Conflict Resolution, Destructive
              Operations), all ahead of the coaching sections below. */}
          {metrics.commitCount >= 2 && (
            <AnimatedCard index={2} className="mb-3">
              <Card padding="md">
                <SectionHeader
                  title="Velocity & Workflow"
                  subtitle="How your commits were paced — steady, incremental work is easier to review and revert than one big batch at the end."
                />
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <Kpi
                    label="Avg time between commits"
                    value={formatMs(metrics.velocityMetrics.avgTimeBetweenCommitsMs)}
                  />
                  <Kpi
                    label="Longest gap"
                    value={formatMs(metrics.velocityMetrics.longestGapMs)}
                    sub="biggest idle stretch between commits"
                  />
                  <Kpi
                    label="Commit bursts"
                    value={String(metrics.velocityMetrics.commitBurstCount)}
                    sub="3+ commits within 2 min — often splitting one change up after the fact"
                  />
                  <Kpi
                    label="Worktree ops"
                    value={String(metrics.velocityMetrics.worktreeCount)}
                    sub="git worktree add/remove commands run"
                  />
                </div>
                {metrics.velocityMetrics.buildBeforePush !== null && (
                  <div className="mt-3 text-xs">
                    <span className="text-ink-muted">Verified before push: </span>
                    {metrics.velocityMetrics.buildBeforePush ? (
                      <span className="text-accent-green">yes (build/test ran first)</span>
                    ) : (
                      <span className="text-accent-amber">no build/test detected before push</span>
                    )}
                  </div>
                )}
              </Card>
            </AnimatedCard>
          )}

          {/* Pull requests */}
          {(metrics.prMetrics.created > 0 ||
            metrics.prMetrics.merged > 0 ||
            metrics.prMetrics.checksViewed > 0) && (
            <AnimatedCard index={3} className="mb-3">
              <Card padding="md">
                <SectionHeader
                  title="Pull Requests"
                  subtitle="Counts commands you (or the AI) ran — gh CLI and MCP PR tools — not live GitHub state."
                />
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <Kpi
                    label="PRs created"
                    value={String(metrics.prMetrics.created)}
                    tone={metrics.prMetrics.created > 0 ? 'good' : 'neutral'}
                  />
                  <Kpi
                    label="PRs merged"
                    value={String(metrics.prMetrics.merged)}
                    tone={metrics.prMetrics.merged > 0 ? 'good' : 'neutral'}
                  />
                  <Kpi
                    label="CI checks viewed"
                    value={String(metrics.prMetrics.checksViewed)}
                    sub="times you ran `gh pr checks`"
                  />
                  <Kpi
                    label="Time to PR"
                    value={formatMs(metrics.prMetrics.avgTimeToCreateMs)}
                    sub={
                      metrics.prMetrics.avgTimeToCreateMs === null
                        ? 'no commit found in this window before the PR was created'
                        : undefined
                    }
                  />
                </div>
                {metrics.prMetrics.prActivity.length > 0 && (
                  <div className="mt-3">
                    <Eyebrow as="h3" className="mb-2">
                      Activity
                    </Eyebrow>
                    <div className="flex flex-wrap gap-1.5">
                      {metrics.prMetrics.prActivity.map((e) => {
                        const tone: PillTone =
                          e.action === 'create'
                            ? 'success'
                            : e.action === 'merge'
                              ? 'info'
                              : 'neutral';
                        return (
                          <Pill key={`${e.timestamp}-${e.action}`} tone={tone} size="sm">
                            {e.action}
                            {e.prNumber ? ` #${e.prNumber}` : ''}
                          </Pill>
                        );
                      })}
                    </div>
                  </div>
                )}
              </Card>
            </AnimatedCard>
          )}

          {/* Conflict resolution stats */}
          {(metrics.mergeConflicts > 0 || metrics.rebaseConflicts > 0) && (
            <AnimatedCard index={4} className="mb-3">
              <Card padding="md">
                <SectionHeader title="Conflict Resolution" />
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <Kpi
                    label="Resolution rate"
                    value={
                      metrics.conflictResolutionRate !== null
                        ? `${Math.round(metrics.conflictResolutionRate * 100)}%`
                        : '—'
                    }
                  />
                  <Kpi
                    label="Avg resolution time"
                    value={formatMs(metrics.avgConflictResolutionMs)}
                  />
                  <Kpi label="Aborted ops" value={String(metrics.abortedOperations)} />
                  <Kpi label="Stale branch pulls" value={String(metrics.staleBranchPulls)} />
                </div>

                {metrics.conflictHistory.length > 0 && (
                  <div className="mt-3">
                    <Eyebrow as="h3" className="mb-2">
                      Conflict History
                    </Eyebrow>
                    <div className="space-y-1">
                      {metrics.conflictHistory.map((c) => (
                        <div
                          key={`${c.timestamp}-${c.command}`}
                          className="flex items-center gap-3 text-xs py-1 border-t border-border-subtle"
                        >
                          <span className="tabular-nums text-ink-subtle w-28 shrink-0">
                            {new Date(c.timestamp).toLocaleTimeString(undefined, {
                              hour: 'numeric',
                              minute: '2-digit',
                              second: '2-digit',
                            })}
                          </span>
                          <span className={`font-medium ${RESOLUTION_STYLE[c.resolution]}`}>
                            {c.resolution}
                          </span>
                          <span className="text-ink-muted">{formatMs(c.resolutionTimeMs)}</span>
                          <span className="text-ink-subtle font-mono text-[11px] truncate">
                            {c.command}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </Card>
            </AnimatedCard>
          )}

          {/* Conflict resolution strategy */}
          {metrics.conflictResolutionStrategy.totalResolutions > 0 && (
            <AnimatedCard index={5} className="mb-3">
              <Card padding="md">
                <SectionHeader title="Conflict Resolution Strategy" />
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <Kpi
                    label="Accept ours"
                    value={String(metrics.conflictResolutionStrategy.oursCount)}
                  />
                  <Kpi
                    label="Accept theirs"
                    value={String(metrics.conflictResolutionStrategy.theirsCount)}
                  />
                  <Kpi
                    label="Manual merge"
                    value={String(metrics.conflictResolutionStrategy.manualMergeCount)}
                  />
                  <Kpi
                    label="Cherry-picks"
                    value={String(metrics.conflictResolutionStrategy.cherryPickCount)}
                  />
                </div>
              </Card>
            </AnimatedCard>
          )}

          {/* Destructive operations summary */}
          {(metrics.resetHards > 0 || metrics.discardedChanges > 0 || metrics.forcePushes > 0) && (
            <AnimatedCard index={6} className="mb-3">
              <Card padding="md">
                <SectionHeader title="Destructive Operations" />
                <div className="grid grid-cols-3 gap-3">
                  <Kpi label="Hard resets" value={String(metrics.resetHards)} />
                  <Kpi label="Discarded changes" value={String(metrics.discardedChanges)} />
                  <Kpi label="Force pushes" value={String(metrics.forcePushes)} />
                </div>
              </Card>
            </AnimatedCard>
          )}

          {/* Best practices checklist — compact: only expand failures. Grouped
              with Suggestions right after every "what happened" data section
              above, and before the raw Recent Git Activity log — not sandwiched
              in between two unrelated data sections. */}
          {metrics.bestPractices.length > 0 && (
            <AnimatedCard index={7} className="mb-3">
              <Card padding="md">
                <SectionHeader
                  title="Best Practices"
                  action={
                    <span className="text-[11px] text-ink-muted">
                      {(() => {
                        // 'n/a' (fully known, not applicable) is excluded from the
                        // ratio the same way 'unknown' (insufficient data) is —
                        // matching computePreventionScore()'s treatment so this
                        // header and the Prevention score ring never disagree on
                        // which items count. See BestPractice['status']'s docstring.
                        const known = metrics.bestPractices.filter(
                          (bp) => bp.status !== 'unknown' && bp.status !== 'n/a',
                        ).length;
                        if (known === 0) return 'No data yet';
                        const passing = metrics.bestPractices.filter(
                          (bp) => bp.status === 'pass',
                        ).length;
                        return `${passing}/${known} passing`;
                      })()}
                    </span>
                  }
                />
                {/* Passing items — compact row of chips */}
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {metrics.bestPractices
                    .filter((bp) => bp.status === 'pass')
                    .map((bp) => (
                      <Pill key={bp.id} tone="success" size="sm" bordered>
                        <span>&#10003;</span> {bp.label}
                      </Pill>
                    ))}
                  {metrics.bestPractices
                    .filter((bp) => bp.status === 'unknown' || bp.status === 'n/a')
                    .map((bp) => (
                      <Pill key={bp.id} tone="neutral" size="sm" bordered>
                        <span>&#9679;</span> {bp.label}
                      </Pill>
                    ))}
                </div>
                {/* Failing/warning items — expanded with detail */}
                {metrics.bestPractices
                  .filter((bp) => bp.status === 'fail' || bp.status === 'warn')
                  .map((bp) => (
                    <div
                      key={bp.id}
                      className={`flex items-start gap-2 px-2.5 py-2 rounded-lg mt-1.5 ${
                        bp.status === 'fail'
                          ? 'bg-accent-red/5 border border-accent-red/20'
                          : 'bg-accent-amber/5 border border-accent-amber/20'
                      }`}
                    >
                      <span className="shrink-0 mt-0.5 text-xs">
                        {bp.status === 'fail' ? (
                          <span className="text-accent-red">&#10007;</span>
                        ) : (
                          <span className="text-accent-amber">&#9888;</span>
                        )}
                      </span>
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-ink-base">{bp.label}</div>
                        <div className="text-[11px] text-ink-muted mt-0.5 leading-relaxed">
                          {bp.detail}
                        </div>
                      </div>
                    </div>
                  ))}
              </Card>
            </AnimatedCard>
          )}

          {/* Suggestions */}
          {metrics.suggestions.length > 0 && (
            <AnimatedCard index={8} className="mb-3">
              <Card padding="md">
                <SectionHeader title="Suggestions" />
                <div className="space-y-2">
                  {metrics.suggestions.map((s, i) => (
                    <div
                      key={`${s.category}-${s.severity}-${i}`}
                      className={`border-l-[3px] rounded-r-lg px-3 py-2 ${SEVERITY_STYLE[s.severity]}`}
                    >
                      <div className="flex items-start gap-2">
                        <Pill tone={SEVERITY_TONE[s.severity]} size="sm" className="font-semibold">
                          {s.severity}
                        </Pill>
                        <div>
                          <p className="text-xs text-ink-base">{s.message}</p>
                          <p className="text-[11px] text-ink-muted mt-0.5">{s.evidence}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            </AnimatedCard>
          )}

          {/* Recent git timeline */}
          <AnimatedCard index={9}>
            <Card padding="md">
              <SectionHeader title="Recent Git Activity" />
              <div className="max-h-64 overflow-auto">
                <table className="w-full text-xs">
                  <thead className="text-ink-muted bg-bg-panel sticky top-0">
                    <tr>
                      <th className="text-left p-2">Time</th>
                      <th className="text-left p-2">Type</th>
                      <th className="text-left p-2">Repo</th>
                      <th className="text-left p-2">Detail</th>
                      <th className="text-left p-2">Duration</th>
                      <th className="text-left p-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...metrics.gitCommandTimeline]
                      // Hydrated commits are appended after live events, so
                      // insertion order isn't chronological — sort explicitly.
                      .sort((a, b) => b.timestamp - a.timestamp)
                      .slice(0, 30)
                      .map((e) => (
                        <tr
                          key={`${e.type}-${e.timestamp}`}
                          className="border-t border-border-subtle"
                        >
                          <td className="p-2 tabular-nums text-ink-subtle whitespace-nowrap">
                            {formatEventTime(e.timestamp)}
                          </td>
                          <td className="p-2">
                            <span
                              className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${EVENT_TYPE_COLORS[e.type] ?? 'bg-surface-8 text-ink-subtle'}`}
                            >
                              {formatEventType(e.type)}
                            </span>
                          </td>
                          <td className="p-2 text-ink-subtle whitespace-nowrap">
                            {e.repo ? e.repo.split('/').pop() : '—'}
                          </td>
                          <td
                            className="p-2 max-w-xs truncate"
                            title={e.subject ?? e.command ?? undefined}
                          >
                            {e.url ? (
                              <a
                                href={e.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-accent-blue hover:underline"
                              >
                                {e.subject ?? 'view commit'}
                              </a>
                            ) : (
                              // Live git events carry no commit subject, but the
                              // command itself is the useful detail for them.
                              (e.subject ?? e.command ?? '—')
                            )}
                          </td>
                          <td className="p-2 tabular-nums text-ink-subtle">
                            {formatMs(e.durationMs)}
                          </td>
                          <td className="p-2">
                            {e.success ? (
                              <span className="text-accent-green">ok</span>
                            ) : (
                              <span className="text-accent-red">fail</span>
                            )}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </AnimatedCard>
        </>
      )}
    </section>
  );
}
