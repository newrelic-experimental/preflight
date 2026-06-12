import { useQuery } from '@tanstack/react-query';
import { fetchGitEfficiency, fetchGitEfficiencyRepos, qk } from '../api/client';
import { AnimatedCard } from '../components/AnimatedCard';
import { EmptyState } from '../components/EmptyState';
import { GeoBanner } from '../components/GeoBanner';
import { Kpi } from '../components/Kpi';
import { Card, Eyebrow, Pill, SectionHeader } from '../components/ui';
import type { PillTone } from '../components/ui';

interface GitSuggestion {
  readonly severity: 'info' | 'warning' | 'critical';
  readonly category: string;
  readonly message: string;
  readonly evidence: string;
}

interface MergeConflictRecord {
  readonly timestamp: number;
  readonly resolution: 'resolved' | 'aborted' | 'pending';
  readonly resolutionTimeMs: number | null;
  readonly command: string;
}

interface GitEvent {
  readonly timestamp: number;
  readonly type: string;
  readonly command?: string;
  readonly success: boolean;
  readonly durationMs: number | null;
}

interface BestPractice {
  readonly id: string;
  readonly label: string;
  readonly status: 'pass' | 'fail' | 'warn' | 'unknown';
  readonly detail: string;
}

interface RiskIndicators {
  readonly syncedBeforeEditing: boolean | null;
  readonly timeSinceLastSyncMs: number | null;
  readonly commitsSinceLastSync: number;
  readonly pushRejections: number;
  readonly forceAfterReject: number;
  readonly hotFiles: readonly string[];
  readonly usesWorktrees: boolean;
  readonly usesForceWithLease: boolean;
  readonly avgCommitsBetweenSyncs: number | null;
  readonly commitsAheadOfMain: number | null;
  readonly commitsBehindMain: number | null;
  readonly sessionDurationMs: number | null;
  readonly quickConflictResolutions: number;
}

interface RepoContext {
  readonly repoName: string | null;
  readonly branch: string | null;
  readonly remoteName: string | null;
  readonly defaultBranch: string | null;
}

interface PrEvent {
  readonly timestamp: number;
  readonly action: 'create' | 'merge' | 'view' | 'edit' | 'ready' | 'checks';
  readonly prNumber: string | null;
}

interface PullRequestMetrics {
  readonly created: number;
  readonly merged: number;
  readonly checksViewed: number;
  readonly prsUpdated: number;
  readonly prActivity: readonly PrEvent[];
  readonly avgTimeToCreateMs: number | null;
}

interface VelocityMetrics {
  readonly avgTimeBetweenCommitsMs: number | null;
  readonly commitBurstCount: number;
  readonly longestGapMs: number | null;
  readonly worktreeCount: number;
  readonly buildBeforePush: boolean | null;
  readonly testBeforePush: boolean | null;
}

interface ConflictResolutionStrategy {
  readonly oursCount: number;
  readonly theirsCount: number;
  readonly manualMergeCount: number;
  readonly cherryPickCount: number;
  readonly totalResolutions: number;
}

interface GitEfficiencyData {
  readonly totalGitCommands: number;
  readonly mergeConflicts: number;
  readonly rebaseConflicts: number;
  readonly abortedOperations: number;
  readonly forcePushes: number;
  readonly resetHards: number;
  readonly discardedChanges: number;
  readonly pullCount: number;
  readonly pushCount: number;
  readonly commitCount: number;
  readonly branchOperations: number;
  readonly conflictResolutionRate: number | null;
  readonly avgConflictResolutionMs: number | null;
  readonly staleBranchPulls: number;
  readonly gitCommandTimeline: readonly GitEvent[];
  readonly conflictHistory: readonly MergeConflictRecord[];
  readonly suggestions: readonly GitSuggestion[];
  readonly bestPractices: readonly BestPractice[];
  readonly preventionScore: number | null;
  readonly efficiencyScore: number | null;
  readonly riskIndicators: RiskIndicators;
  readonly velocityMetrics: VelocityMetrics;
  readonly conflictResolutionStrategy: ConflictResolutionStrategy;
  readonly prMetrics: PullRequestMetrics;
  readonly repoContext: RepoContext;
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
  return `${(ms / 60_000).toFixed(1)}m`;
}

function formatEventType(type: string): string {
  return type.replace(/_/g, ' ');
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

export function GitEfficiency(): JSX.Element {
  const { data, isLoading, error } = useQuery<GitEfficiencyData>({
    queryKey: qk.gitEfficiency,
    queryFn: () => fetchGitEfficiency() as Promise<GitEfficiencyData>,
    refetchInterval: 5000,
  });

  const { data: reposData } = useQuery<{ repos: string[]; currentRepo: string | null }>({
    queryKey: qk.gitEfficiencyRepos,
    queryFn: () =>
      fetchGitEfficiencyRepos() as Promise<{ repos: string[]; currentRepo: string | null }>,
    refetchInterval: 30000,
  });

  if (isLoading) return <EmptyState icon="clock" variant="loading" title="Loading..." />;
  if (error)
    return <div className="text-accent-red text-xs">Error loading git efficiency data.</div>;
  if (!data || data.totalGitCommands === 0) {
    return (
      <>
        {reposData && reposData.repos.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 mb-4">
            <Eyebrow as="div" className="mr-1">
              Repos Today:
            </Eyebrow>
            {reposData.repos.map((repo) => {
              const shortName = repo.split('/').pop() || repo;
              const isCurrent = repo === reposData.currentRepo;
              return (
                <Pill
                  key={repo}
                  tone={isCurrent ? 'success' : 'neutral'}
                  size="sm"
                  bordered
                  className="font-mono"
                >
                  {shortName}
                </Pill>
              );
            })}
          </div>
        )}
        <EmptyState
          icon="code"
          title="No Git activity yet"
          subtitle="Git efficiency metrics will appear here as git commands are executed during the session."
        />
      </>
    );
  }

  return (
    <section>
      <GeoBanner theme="git" />
      <header className="flex items-baseline justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold gradient-text">Git Efficiency</h1>
          {data.repoContext.repoName && (
            <div className="flex items-center gap-2 mt-1 text-[11px] text-ink-muted">
              <span className="font-mono">{data.repoContext.repoName}</span>
              {data.repoContext.branch && (
                <>
                  <span className="text-ink-muted">/</span>
                  <span className="font-mono text-ink-subtle">{data.repoContext.branch}</span>
                </>
              )}
            </div>
          )}
          <div className="mt-1 text-[11px] text-ink-muted">
            Today&apos;s activity across all sessions
          </div>
          {reposData && reposData.repos.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 mt-2">
              <span className="text-[10px] text-ink-muted uppercase tracking-wider mr-1">
                Repos today:
              </span>
              {reposData.repos.map((repo) => {
                const shortName = repo.split('/').pop() || repo;
                const isCurrent = repo === reposData.currentRepo;
                return (
                  <Pill
                    key={repo}
                    tone={isCurrent ? 'success' : 'neutral'}
                    size="sm"
                    bordered
                    className="font-mono"
                  >
                    {shortName}
                  </Pill>
                );
              })}
            </div>
          )}
        </div>
        <div className="flex items-center gap-4">
          <div className="text-center">
            <Eyebrow as="div" className="mb-1">
              Prevention
            </Eyebrow>
            <ScoreRing score={data.preventionScore} />
          </div>
          <div className="text-center">
            <Eyebrow as="div" className="mb-1">
              Efficiency
            </Eyebrow>
            <ScoreRing score={data.efficiencyScore} />
          </div>
        </div>
      </header>

      {/* Hero KPIs — what shipped, what's risky, current state */}
      <AnimatedCard index={0} className="mb-3">
        <Card padding="lg" tone="elevated" glow="green">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <Kpi
              label="commits today"
              hero
              value={String(data.commitCount)}
              animate
              numericValue={data.commitCount}
            />
            <Kpi
              label="PRs opened"
              tone={data.prMetrics.created > 0 ? 'good' : 'neutral'}
              value={String(data.prMetrics.created)}
              sub={data.prMetrics.merged > 0 ? `${data.prMetrics.merged} merged` : undefined}
              animate
              numericValue={data.prMetrics.created}
            />
            <Kpi
              label="conflicts"
              tone={data.mergeConflicts + data.rebaseConflicts > 0 ? 'bad' : 'good'}
              value={String(data.mergeConflicts + data.rebaseConflicts)}
              sub={
                data.mergeConflicts + data.rebaseConflicts === 0
                  ? 'clean session'
                  : `${data.abortedOperations} aborted`
              }
              animate
              numericValue={data.mergeConflicts + data.rebaseConflicts}
            />
            <Kpi
              label="behind main"
              tone={
                (data.riskIndicators.commitsBehindMain ?? 0) > 20
                  ? 'bad'
                  : (data.riskIndicators.commitsBehindMain ?? 0) > 5
                    ? 'warn'
                    : 'good'
              }
              value={
                data.riskIndicators.commitsBehindMain !== null
                  ? String(data.riskIndicators.commitsBehindMain)
                  : '—'
              }
              sub={
                data.riskIndicators.commitsBehindMain === 0
                  ? 'up to date'
                  : data.riskIndicators.commitsBehindMain !== null &&
                      data.riskIndicators.commitsBehindMain > 10
                    ? 'rebase soon'
                    : undefined
              }
              animate
              numericValue={data.riskIndicators.commitsBehindMain ?? 0}
            />
          </div>
        </Card>
      </AnimatedCard>

      {/* Best practices checklist — compact: only expand failures */}
      {data.bestPractices.length > 0 && (
        <AnimatedCard index={1} className="mb-3">
          <Card padding="md">
            <SectionHeader
              title="Best Practices"
              action={
                <span className="text-[11px] text-ink-muted">
                  {(() => {
                    const known = data.bestPractices.filter((bp) => bp.status !== 'unknown').length;
                    if (known === 0) return 'No data yet';
                    const passing = data.bestPractices.filter((bp) => bp.status === 'pass').length;
                    return `${passing}/${known} passing`;
                  })()}
                </span>
              }
            />
            {/* Passing items — compact row of chips */}
            <div className="flex flex-wrap gap-1.5 mb-2">
              {data.bestPractices
                .filter((bp) => bp.status === 'pass')
                .map((bp) => (
                  <Pill key={bp.id} tone="success" size="sm" bordered>
                    <span>&#10003;</span> {bp.label}
                  </Pill>
                ))}
              {data.bestPractices
                .filter((bp) => bp.status === 'unknown')
                .map((bp) => (
                  <Pill key={bp.id} tone="neutral" size="sm" bordered>
                    <span>&#9679;</span> {bp.label}
                  </Pill>
                ))}
            </div>
            {/* Failing/warning items — expanded with detail */}
            {data.bestPractices
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

      {/* Conflict resolution stats */}
      {(data.mergeConflicts > 0 || data.rebaseConflicts > 0) && (
        <AnimatedCard index={2} className="mb-3">
          <Card padding="md">
            <SectionHeader title="Conflict Resolution" />
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Kpi
                label="Resolution rate"
                value={
                  data.conflictResolutionRate !== null
                    ? `${Math.round(data.conflictResolutionRate * 100)}%`
                    : '—'
                }
              />
              <Kpi label="Avg resolution time" value={formatMs(data.avgConflictResolutionMs)} />
              <Kpi label="Aborted ops" value={String(data.abortedOperations)} />
              <Kpi label="Stale branch pulls" value={String(data.staleBranchPulls)} />
            </div>

            {data.conflictHistory.length > 0 && (
              <div className="mt-3">
                <Eyebrow as="h3" className="mb-2">
                  Conflict History
                </Eyebrow>
                <div className="space-y-1">
                  {data.conflictHistory.map((c) => (
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

      {/* Suggestions */}
      {data.suggestions.length > 0 && (
        <AnimatedCard index={3} className="mb-3">
          <Card padding="md">
            <SectionHeader title="Suggestions" />
            <div className="space-y-2">
              {data.suggestions.map((s, i) => (
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

      {/* Velocity & workflow */}
      {data.commitCount >= 2 && (
        <AnimatedCard index={4} className="mb-3">
          <Card padding="md">
            <SectionHeader title="Velocity & Workflow" />
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Kpi
                label="Avg time between commits"
                value={formatMs(data.velocityMetrics.avgTimeBetweenCommitsMs)}
              />
              <Kpi label="Longest gap" value={formatMs(data.velocityMetrics.longestGapMs)} />
              <Kpi label="Commit bursts" value={String(data.velocityMetrics.commitBurstCount)} />
              <Kpi label="Worktree ops" value={String(data.velocityMetrics.worktreeCount)} />
            </div>
            {data.velocityMetrics.buildBeforePush !== null && (
              <div className="mt-3 text-xs">
                <span className="text-ink-muted">Verified before push: </span>
                {data.velocityMetrics.buildBeforePush ? (
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
      {(data.prMetrics.created > 0 ||
        data.prMetrics.merged > 0 ||
        data.prMetrics.checksViewed > 0) && (
        <AnimatedCard index={5} className="mb-3">
          <Card padding="md">
            <SectionHeader title="Pull Requests" />
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Kpi
                label="PRs created"
                value={String(data.prMetrics.created)}
                tone={data.prMetrics.created > 0 ? 'good' : 'neutral'}
              />
              <Kpi
                label="PRs merged"
                value={String(data.prMetrics.merged)}
                tone={data.prMetrics.merged > 0 ? 'good' : 'neutral'}
              />
              <Kpi label="CI checks viewed" value={String(data.prMetrics.checksViewed)} />
              <Kpi label="Time to PR" value={formatMs(data.prMetrics.avgTimeToCreateMs)} />
            </div>
            {data.prMetrics.prActivity.length > 0 && (
              <div className="mt-3">
                <Eyebrow as="h3" className="mb-2">
                  Activity
                </Eyebrow>
                <div className="flex flex-wrap gap-1.5">
                  {data.prMetrics.prActivity.map((e) => {
                    const tone: PillTone =
                      e.action === 'create' ? 'success' : e.action === 'merge' ? 'info' : 'neutral';
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

      {/* Conflict resolution strategy */}
      {data.conflictResolutionStrategy.totalResolutions > 0 && (
        <AnimatedCard index={6} className="mb-3">
          <Card padding="md">
            <SectionHeader title="Conflict Resolution Strategy" />
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Kpi label="Accept ours" value={String(data.conflictResolutionStrategy.oursCount)} />
              <Kpi
                label="Accept theirs"
                value={String(data.conflictResolutionStrategy.theirsCount)}
              />
              <Kpi
                label="Manual merge"
                value={String(data.conflictResolutionStrategy.manualMergeCount)}
              />
              <Kpi
                label="Cherry-picks"
                value={String(data.conflictResolutionStrategy.cherryPickCount)}
              />
            </div>
          </Card>
        </AnimatedCard>
      )}

      {/* Destructive operations summary */}
      {(data.resetHards > 0 || data.discardedChanges > 0 || data.forcePushes > 0) && (
        <AnimatedCard index={7} className="mb-3">
          <Card padding="md">
            <SectionHeader title="Destructive Operations" />
            <div className="grid grid-cols-3 gap-3">
              <Kpi label="Hard resets" value={String(data.resetHards)} />
              <Kpi label="Discarded changes" value={String(data.discardedChanges)} />
              <Kpi label="Force pushes" value={String(data.forcePushes)} />
            </div>
          </Card>
        </AnimatedCard>
      )}

      {/* Recent git timeline */}
      <AnimatedCard index={8}>
        <Card padding="md">
          <SectionHeader title="Recent Git Activity" />
          <div className="max-h-64 overflow-auto">
            <table className="w-full text-xs">
              <thead className="text-ink-muted bg-surface-3 sticky top-0">
                <tr>
                  <th className="text-left p-2">Time</th>
                  <th className="text-left p-2">Type</th>
                  <th className="text-left p-2">Duration</th>
                  <th className="text-left p-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {[...data.gitCommandTimeline]
                  .reverse()
                  .slice(0, 30)
                  .map((e) => (
                    <tr key={`${e.type}-${e.timestamp}`} className="border-t border-border-subtle">
                      <td className="p-2 tabular-nums text-ink-subtle">
                        {new Date(e.timestamp).toLocaleTimeString(undefined, {
                          hour: 'numeric',
                          minute: '2-digit',
                          second: '2-digit',
                        })}
                      </td>
                      <td className="p-2">
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${EVENT_TYPE_COLORS[e.type] ?? 'bg-surface-8 text-ink-subtle'}`}
                        >
                          {formatEventType(e.type)}
                        </span>
                      </td>
                      <td className="p-2 tabular-nums text-ink-subtle">{formatMs(e.durationMs)}</td>
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
    </section>
  );
}
