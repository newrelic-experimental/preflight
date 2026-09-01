import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { GitEfficiency } from './GitEfficiency';
import type { GitEfficiencyData, GitEfficiencyReposResponse, BestPractice } from '../api/client';

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const EMPTY_REPOS: GitEfficiencyReposResponse = { repos: [], currentRepo: null };

const BASE_DATA: GitEfficiencyData = {
  totalGitCommands: 5,
  mergeConflicts: 0,
  rebaseConflicts: 0,
  abortedOperations: 0,
  forcePushes: 0,
  resetHards: 0,
  discardedChanges: 0,
  pullCount: 1,
  pushCount: 1,
  commitCount: 1,
  branchOperations: 0,
  conflictResolutionRate: null,
  avgConflictResolutionMs: null,
  staleBranchPulls: 0,
  gitCommandTimeline: [],
  conflictHistory: [],
  suggestions: [],
  bestPractices: [],
  preventionScore: null,
  efficiencyScore: null,
  riskIndicators: {
    syncedBeforeEditing: null,
    timeSinceLastSyncMs: null,
    commitsSinceLastSync: 0,
    pushRejections: 0,
    forceAfterReject: 0,
    hotFiles: [],
    usesWorktrees: false,
    usesForceWithLease: false,
    avgCommitsBetweenSyncs: null,
    commitsAheadOfMain: null,
    commitsBehindMain: null,
    sessionDurationMs: null,
    quickConflictResolutions: 0,
  },
  velocityMetrics: {
    avgTimeBetweenCommitsMs: null,
    commitBurstCount: 0,
    longestGapMs: null,
    worktreeCount: 0,
    buildBeforePush: null,
    testBeforePush: null,
  },
  conflictResolutionStrategy: {
    oursCount: 0,
    theirsCount: 0,
    manualMergeCount: 0,
    cherryPickCount: 0,
    totalResolutions: 0,
  },
  prMetrics: {
    created: 0,
    merged: 0,
    checksViewed: 0,
    prsUpdated: 0,
    prActivity: [],
    avgTimeToCreateMs: null,
  },
  repoContext: {
    repoName: null,
    branch: null,
    remoteName: null,
    defaultBranch: null,
  },
};

function renderGitEfficiency(data: unknown, repos: unknown = EMPTY_REPOS) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
  globalThis.fetch = (async (url: string) => {
    if (url === '/api/git-efficiency') return jsonResponse(data);
    if (url === '/api/git-efficiency/repos') return jsonResponse(repos);
    return jsonResponse({});
  }) as typeof fetch;
  return render(
    <QueryClientProvider client={qc}>
      <GitEfficiency />
    </QueryClientProvider>,
  );
}

describe('GitEfficiency view — empty state', () => {
  it('shows "No Git activity yet" when totalGitCommands is 0', async () => {
    renderGitEfficiency({ ...BASE_DATA, totalGitCommands: 0 });
    expect(await screen.findByText('No Git activity yet')).toBeInTheDocument();
  });

  it('shows the Repos Today chips in the empty state when repos are known', async () => {
    renderGitEfficiency(
      { ...BASE_DATA, totalGitCommands: 0 },
      { repos: ['org/repo-a', 'org/repo-b'], currentRepo: 'org/repo-a' },
    );
    expect(await screen.findByText('Repos Today:')).toBeInTheDocument();
    expect(screen.getByText('repo-a')).toBeInTheDocument();
    expect(screen.getByText('repo-b')).toBeInTheDocument();
  });
});

describe('GitEfficiency view — loading and error', () => {
  it('shows a loading state while the query is pending', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    globalThis.fetch = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    render(
      <QueryClientProvider client={qc}>
        <GitEfficiency />
      </QueryClientProvider>,
    );
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('shows an error message when the query fails', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    globalThis.fetch = (() =>
      Promise.resolve(new Response('boom', { status: 500 }))) as typeof fetch;
    render(
      <QueryClientProvider client={qc}>
        <GitEfficiency />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Error loading git efficiency data.')).toBeInTheDocument();
  });
});

describe('GitEfficiency view — bestPractices filtering', () => {
  const bestPractices: BestPractice[] = [
    {
      id: 'sync',
      label: 'Synced before editing',
      status: 'pass',
      detail: 'Synced 2m before first edit.',
    },
    {
      id: 'small-commits',
      label: 'Small commits',
      status: 'pass',
      detail: 'Commits stayed small.',
    },
    {
      id: 'force-with-lease',
      label: 'Force-with-lease',
      status: 'fail',
      detail: 'Force push without --force-with-lease.',
    },
    {
      id: 'build-before-push',
      label: 'Build before push',
      status: 'warn',
      detail: 'No build run detected before push.',
    },
    { id: 'worktrees', label: 'Uses worktrees', status: 'unknown', detail: 'Not enough data yet.' },
  ];

  it('uses only known (non-unknown) entries as the denominator and pass entries as the numerator', async () => {
    renderGitEfficiency({ ...BASE_DATA, bestPractices });
    // known = 4 (excludes the 1 'unknown' entry), passing = 2 ('pass' entries).
    expect(await screen.findByText('2/4 passing')).toBeInTheDocument();
  });

  it('renders pass entries as compact chips and unknown entries as neutral chips', async () => {
    renderGitEfficiency({ ...BASE_DATA, bestPractices });
    await screen.findByText('2/4 passing');
    expect(screen.getByText(/Synced before editing/)).toBeInTheDocument();
    expect(screen.getByText(/Small commits/)).toBeInTheDocument();
    expect(screen.getByText(/Uses worktrees/)).toBeInTheDocument();
  });

  it('renders fail and warn entries as expanded detail cards with their detail text', async () => {
    renderGitEfficiency({ ...BASE_DATA, bestPractices });
    await screen.findByText('2/4 passing');
    expect(screen.getByText('Force push without --force-with-lease.')).toBeInTheDocument();
    expect(screen.getByText('No build run detected before push.')).toBeInTheDocument();
  });

  it('shows "No data yet" when every bestPractice entry is unknown', async () => {
    renderGitEfficiency({
      ...BASE_DATA,
      bestPractices: [{ id: 'a', label: 'A', status: 'unknown', detail: 'n/a' }],
    });
    expect(await screen.findByText('No data yet')).toBeInTheDocument();
  });

  // 'n/a' (fully known, not applicable) must be excluded from the
  // known/passing ratio the same way 'unknown' already is, and still render
  // visibly as a neutral chip rather than silently disappearing from the list.
  it('excludes n/a entries from the known/passing ratio and still renders them as a neutral chip', async () => {
    const practicesWithNA: BestPractice[] = [
      ...bestPractices,
      {
        id: 'use_worktrees',
        label: 'Use worktrees for parallel work',
        status: 'n/a',
        detail: 'No conflicts and no worktree usage detected this session.',
      },
    ];
    renderGitEfficiency({ ...BASE_DATA, bestPractices: practicesWithNA });
    // known/passing unchanged from the no-n/a case (2/4) — the n/a entry
    // must not inflate the denominator.
    expect(await screen.findByText('2/4 passing')).toBeInTheDocument();
    expect(screen.getByText(/Use worktrees for parallel work/)).toBeInTheDocument();
  });
});

describe('GitEfficiency view — hero KPIs and gated sections', () => {
  it('renders hero KPI values from the response', async () => {
    renderGitEfficiency({
      ...BASE_DATA,
      commitCount: 7,
      prMetrics: { ...BASE_DATA.prMetrics, created: 3, merged: 2 },
      riskIndicators: { ...BASE_DATA.riskIndicators, commitsBehindMain: 12 },
    });
    expect(await screen.findByText('commits today')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('rebase soon')).toBeInTheDocument();
  });

  // The "behind main" KPI passes `animate`, so it must not coalesce a null
  // commitsBehindMain to 0 before it reaches Kpi — that would render a
  // misleading "0" instead of falling through to the "—" (unknown) string.
  it('shows "—" (not "0") for "behind main" when commitsBehindMain is null — unknown, not a confirmed zero', async () => {
    renderGitEfficiency({
      ...BASE_DATA,
      riskIndicators: { ...BASE_DATA.riskIndicators, commitsBehindMain: null },
    });
    const label = await screen.findByText('behind main');
    expect(label.nextElementSibling?.textContent).toBe('—');
    // A null value must render with a neutral tone, not the "good" green
    // that a coalesced-to-0 value would fall through to.
    expect(label.nextElementSibling?.className).not.toContain('text-accent-green');
  });

  it('renders the real "behind main" count when commitsBehindMain is a known number', async () => {
    renderGitEfficiency({
      ...BASE_DATA,
      riskIndicators: { ...BASE_DATA.riskIndicators, commitsBehindMain: 12 },
    });
    const label = await screen.findByText('behind main');
    expect(label.nextElementSibling?.textContent).toBe('12');
  });

  // A `merge` event has no per-PR correlation with `create` — a session that
  // merges a PR opened on a prior day but hasn't opened anything new today
  // would otherwise render "PRs opened: 0, 2 merged" directly underneath,
  // reading as a contradiction. The independent "PRs merged" KPI further
  // down the page (in the Pull Requests section) already reports this
  // number without that coupling problem.
  it('does not present "PRs opened" as if merged were a subset/outcome of it', async () => {
    renderGitEfficiency({
      ...BASE_DATA,
      prMetrics: { ...BASE_DATA.prMetrics, created: 0, merged: 2 },
    });
    await screen.findByText('Git Efficiency');
    expect(screen.queryByText('2 merged')).toBeNull();
  });

  // `abortedOperations` is a tracker-wide count of every aborted
  // merge/rebase/cherry-pick this session, unrelated to whether *these*
  // conflicts were ever resolved. Showing it under "conflicts" without
  // qualification reads as "0 aborted" even when conflicts were fully
  // resolved, with no confirmation that resolution actually happened.
  it('shows a resolved count under "conflicts" instead of the tracker-wide aborted-operations count', async () => {
    renderGitEfficiency({
      ...BASE_DATA,
      mergeConflicts: 2,
      abortedOperations: 3,
      conflictHistory: [
        {
          timestamp: 1,
          resolution: 'resolved',
          resolutionTimeMs: 100,
          command: 'git commit -m "fix"',
        },
        {
          timestamp: 2,
          resolution: 'resolved',
          resolutionTimeMs: 200,
          command: 'git commit -m "fix2"',
        },
      ],
    });
    await screen.findByText('Git Efficiency');
    expect(screen.queryByText('3 aborted')).toBeNull();
    expect(screen.getByText('2 resolved')).toBeInTheDocument();
  });

  it('hides the Conflict Resolution section when there are no conflicts', async () => {
    renderGitEfficiency(BASE_DATA);
    await screen.findByText('Git Efficiency');
    expect(screen.queryByText('Conflict Resolution')).toBeNull();
  });

  it('shows the Conflict Resolution section when conflicts are present', async () => {
    renderGitEfficiency({ ...BASE_DATA, mergeConflicts: 2, abortedOperations: 1 });
    expect(await screen.findByText('Conflict Resolution')).toBeInTheDocument();
  });

  it('hides the Destructive Operations section when all destructive counts are zero', async () => {
    renderGitEfficiency(BASE_DATA);
    await screen.findByText('Git Efficiency');
    expect(screen.queryByText('Destructive Operations')).toBeNull();
  });

  it('shows the Destructive Operations section when a force push occurred', async () => {
    renderGitEfficiency({ ...BASE_DATA, forcePushes: 1 });
    expect(await screen.findByText('Destructive Operations')).toBeInTheDocument();
  });
});

describe('GitEfficiency view — Recent Git Activity ordering', () => {
  it('orders rows newest first regardless of insertion order', async () => {
    // The API serves epoch millis, not ISO strings.
    const base = new Date().setHours(9, 0, 0, 0);
    renderGitEfficiency({
      ...BASE_DATA,
      gitCommandTimeline: [
        { type: 'diff', timestamp: base, command: 'git diff', success: true, durationMs: null },
        {
          type: 'push',
          timestamp: base + 7_200_000,
          command: 'git push',
          success: true,
          durationMs: null,
        },
        {
          type: 'log',
          timestamp: base + 3_600_000,
          command: 'git log',
          success: true,
          durationMs: null,
        },
      ],
    });
    await screen.findByText('Recent Git Activity');
    const order = screen.getAllByText(/^git (diff|push|log)$/).map((el) => el.textContent?.trim());
    expect(order).toEqual(['git push', 'git log', 'git diff']);
  });
});
