import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { GitEfficiency } from './GitEfficiency';
import type {
  GitWorkspaceReport,
  WorkspaceMetrics,
  WorktreeIdentity,
  BestPractice,
} from '../api/client';

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const BASE_METRICS: WorkspaceMetrics = {
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
  liveState: null,
  commitTimestamps: [],
  lastPushTimestamp: null,
  editedFiles: [],
  hasUsedBareForcePush: false,
  bareForcePushCount: 0,
  hasForcePushedToDefaultBranch: false,
  mergeEventCount: 0,
  rebaseEventCount: 0,
  lastActivityMs: null,
  sessionIds: [],
};

const IDENTITY_A: WorktreeIdentity = {
  repoKey: '/Users/x/repo-a/.git',
  worktreeKey: '/Users/x/repo-a/.git',
  repoName: 'org/repo-a',
  worktreeRoot: '/Users/x/repo-a',
  worktreeLabel: 'primary',
  branch: 'main',
};

const IDENTITY_B: WorktreeIdentity = {
  repoKey: '/Users/x/repo-a/.git',
  worktreeKey: '/Users/x/repo-a/.git/worktrees/feature',
  repoName: 'org/repo-a',
  worktreeRoot: '/Users/x/repo-a-feature',
  worktreeLabel: 'feature',
  branch: 'feature/foo',
};

// Fixed, deterministic bounds — 7 days ending "now" at module-eval time —
// so date-range assertions elsewhere don't depend on when the test runs.
const REPORT_UNTIL = Date.now();
const REPORT_SINCE = REPORT_UNTIL - 6 * 86_400_000;

function makeReport(overrides: Partial<GitWorkspaceReport> = {}): GitWorkspaceReport {
  return {
    scope: { kind: 'all' },
    metrics: BASE_METRICS,
    rows: [{ identity: IDENTITY_A, metrics: BASE_METRICS }],
    worstBehind: null,
    since: REPORT_SINCE,
    until: REPORT_UNTIL,
    ...overrides,
  };
}

function renderGitEfficiency(report: unknown) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
  globalThis.fetch = (async () => jsonResponse(report)) as typeof fetch;
  return render(
    <QueryClientProvider client={qc}>
      <GitEfficiency />
    </QueryClientProvider>,
  );
}

/** Like renderGitEfficiency, but resolves a different response per `window=`
 *  query param — needed to test the week-over-week delta and the 30-day
 *  tree independently, since the real component fires three separate
 *  queries (`week`, `previous_week`, `30`). Callers should supply all three
 *  keys unless a test specifically wants one left unresolved. */
function renderGitEfficiencyByWindow(reportsByWindow: Readonly<Record<string, unknown>>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
  globalThis.fetch = (async (input: string | URL) => {
    const url = new URL(String(input), 'http://localhost');
    const window = url.searchParams.get('window') ?? 'week';
    return jsonResponse(reportsByWindow[window]);
  }) as typeof fetch;
  return render(
    <QueryClientProvider client={qc}>
      <GitEfficiency />
    </QueryClientProvider>,
  );
}

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

describe('GitEfficiency view — empty state', () => {
  it('shows "No Git activity yet" and the repo/worktree tree empty state when totalGitCommands is 0', async () => {
    renderGitEfficiency(
      makeReport({ metrics: { ...BASE_METRICS, totalGitCommands: 0 }, rows: [] }),
    );
    expect(await screen.findByText('No Git activity yet')).toBeInTheDocument();
    expect(screen.getByText('No git activity in this window')).toBeInTheDocument();
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
    renderGitEfficiency(makeReport({ metrics: { ...BASE_METRICS, bestPractices } }));
    // known = 4 (excludes the 1 'unknown' entry), passing = 2 ('pass' entries).
    expect(await screen.findByText('2/4 passing')).toBeInTheDocument();
  });

  it('renders pass entries as compact chips and unknown entries as neutral chips', async () => {
    renderGitEfficiency(makeReport({ metrics: { ...BASE_METRICS, bestPractices } }));
    await screen.findByText('2/4 passing');
    expect(screen.getByText(/Synced before editing/)).toBeInTheDocument();
    expect(screen.getByText(/Small commits/)).toBeInTheDocument();
    expect(screen.getByText(/Uses worktrees/)).toBeInTheDocument();
  });

  it('renders fail and warn entries as expanded detail cards with their detail text', async () => {
    renderGitEfficiency(makeReport({ metrics: { ...BASE_METRICS, bestPractices } }));
    await screen.findByText('2/4 passing');
    expect(screen.getByText('Force push without --force-with-lease.')).toBeInTheDocument();
    expect(screen.getByText('No build run detected before push.')).toBeInTheDocument();
  });

  it('shows "No data yet" when every bestPractice entry is unknown', async () => {
    renderGitEfficiency(
      makeReport({
        metrics: {
          ...BASE_METRICS,
          bestPractices: [{ id: 'a', label: 'A', status: 'unknown', detail: 'n/a' }],
        },
      }),
    );
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
    renderGitEfficiency(
      makeReport({ metrics: { ...BASE_METRICS, bestPractices: practicesWithNA } }),
    );
    // known/passing unchanged from the no-n/a case (2/4) — the n/a entry
    // must not inflate the denominator.
    expect(await screen.findByText('2/4 passing')).toBeInTheDocument();
    expect(screen.getByText(/Use worktrees for parallel work/)).toBeInTheDocument();
  });
});

describe('GitEfficiency view — hero KPIs and gated sections', () => {
  it('renders hero KPI values from the response', async () => {
    renderGitEfficiency(
      makeReport({
        metrics: {
          ...BASE_METRICS,
          commitCount: 7,
          prMetrics: { ...BASE_METRICS.prMetrics, created: 3, merged: 2 },
        },
      }),
    );
    expect(await screen.findByText('commits')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
  });

  // A `merge` event has no per-PR correlation with `create` — a session that
  // merges a PR opened on a prior day but hasn't opened anything new today
  // would otherwise render "PRs opened: 0, 2 merged" directly underneath,
  // reading as a contradiction. The independent "PRs merged" KPI further
  // down the page (in the Pull Requests section) already reports this
  // number without that coupling problem.
  it('does not present "PRs opened" as if merged were a subset/outcome of it', async () => {
    renderGitEfficiency(
      makeReport({
        metrics: {
          ...BASE_METRICS,
          prMetrics: { ...BASE_METRICS.prMetrics, created: 0, merged: 2 },
        },
      }),
    );
    await screen.findByText('Git Efficiency');
    expect(screen.queryByText('2 merged')).toBeNull();
  });

  // `abortedOperations` is a tracker-wide count of every aborted
  // merge/rebase/cherry-pick this session, unrelated to whether *these*
  // conflicts were ever resolved. Showing it under "conflicts" without
  // qualification reads as "0 aborted" even when conflicts were fully
  // resolved, with no confirmation that resolution actually happened.
  it('shows a resolved count under "conflicts" instead of the tracker-wide aborted-operations count', async () => {
    renderGitEfficiency(
      makeReport({
        metrics: {
          ...BASE_METRICS,
          mergeConflicts: 2,
          abortedOperations: 3,
          conflictHistory: [
            {
              timestamp: 1,
              resolution: 'resolved',
              resolutionTimeMs: 100,
              command: 'git commit -m "fix"',
              files: [],
            },
            {
              timestamp: 2,
              resolution: 'resolved',
              resolutionTimeMs: 200,
              command: 'git commit -m "fix2"',
              files: [],
            },
          ],
        },
      }),
    );
    await screen.findByText('Git Efficiency');
    expect(screen.queryByText('3 aborted')).toBeNull();
    // The KPI's sub text now also carries a "vs last week" delta alongside
    // the resolved count, so match the substring rather than the exact node.
    expect(screen.getByText(/2 resolved/)).toBeInTheDocument();
  });

  it('hides the Conflict Resolution section when there are no conflicts', async () => {
    renderGitEfficiency(makeReport());
    await screen.findByText('Git Efficiency');
    expect(screen.queryByText('Conflict Resolution')).toBeNull();
  });

  it('shows the Conflict Resolution section when conflicts are present', async () => {
    renderGitEfficiency(
      makeReport({ metrics: { ...BASE_METRICS, mergeConflicts: 2, abortedOperations: 1 } }),
    );
    expect(await screen.findByText('Conflict Resolution')).toBeInTheDocument();
  });

  it('hides the Destructive Operations section when all destructive counts are zero', async () => {
    renderGitEfficiency(makeReport());
    await screen.findByText('Git Efficiency');
    expect(screen.queryByText('Destructive Operations')).toBeNull();
  });

  it('shows the Destructive Operations section when a force push occurred', async () => {
    renderGitEfficiency(makeReport({ metrics: { ...BASE_METRICS, forcePushes: 1 } }));
    expect(await screen.findByText('Destructive Operations')).toBeInTheDocument();
  });
});

describe('GitEfficiency view — section ordering', () => {
  it('places Best Practices and Suggestions after the data sections, not sandwiched between hero KPIs and Velocity & Workflow', async () => {
    const { container } = renderGitEfficiency(
      makeReport({
        metrics: {
          ...BASE_METRICS,
          commitCount: 5,
          bestPractices: [
            { id: 'sync', label: 'Synced before editing', status: 'pass', detail: 'ok' },
          ],
          suggestions: [
            { severity: 'info', category: 'sync', message: 'pull more often', evidence: '0 pulls' },
          ],
          forcePushes: 1,
        },
      }),
    );
    await screen.findByText('Git Efficiency');
    await screen.findByText('Suggestions');
    const html = container.innerHTML;
    const heroKpiPos = html.indexOf('>commits<');
    const velocityPos = html.indexOf('Velocity &amp; Workflow');
    const destructivePos = html.indexOf('Destructive Operations');
    const bestPracticesPos = html.indexOf('Best Practices');
    const suggestionsPos = html.indexOf('Suggestions');
    expect([
      heroKpiPos,
      velocityPos,
      destructivePos,
      bestPracticesPos,
      suggestionsPos,
    ]).not.toContain(-1);
    // Data sections (Velocity & Workflow, Destructive Operations) both come
    // directly after the hero KPIs and before the coaching sections (Best
    // Practices, Suggestions) — never sandwiched in between.
    expect(heroKpiPos).toBeLessThan(velocityPos);
    expect(velocityPos).toBeLessThan(destructivePos);
    expect(destructivePos).toBeLessThan(bestPracticesPos);
    expect(bestPracticesPos).toBeLessThan(suggestionsPos);
  });
});

describe('GitEfficiency view — Velocity & Workflow and Pull Requests copy', () => {
  it('explains what Velocity & Workflow is showing, and what commit bursts / worktree ops mean', async () => {
    renderGitEfficiency(
      makeReport({
        metrics: {
          ...BASE_METRICS,
          commitCount: 3,
          velocityMetrics: {
            avgTimeBetweenCommitsMs: 60_000,
            commitBurstCount: 2,
            longestGapMs: 120_000,
            worktreeCount: 3,
            buildBeforePush: null,
            testBeforePush: null,
          },
        },
      }),
    );
    expect(await screen.findByText('Velocity & Workflow')).toBeInTheDocument();
    expect(screen.getByText(/How your commits were paced/)).toBeInTheDocument();
    expect(screen.getByText(/often splitting one change up after the fact/)).toBeInTheDocument();
    expect(screen.getByText(/git worktree add\/remove commands run/)).toBeInTheDocument();
  });

  it('scales duration KPIs to hours/days instead of showing huge minute counts', async () => {
    renderGitEfficiency(
      makeReport({
        metrics: {
          ...BASE_METRICS,
          commitCount: 3,
          velocityMetrics: {
            // 262.1 minutes and 1441.0 minutes — the exact values from a
            // real report that read as "262.1m"/"1441.0m" before this fix.
            avgTimeBetweenCommitsMs: 262.1 * 60_000,
            commitBurstCount: 0,
            longestGapMs: 1441 * 60_000,
            worktreeCount: 0,
            buildBeforePush: null,
            testBeforePush: null,
          },
        },
      }),
    );
    await screen.findByText('Velocity & Workflow');
    expect(screen.getByText('4.4h')).toBeInTheDocument();
    expect(screen.getByText('1.0d')).toBeInTheDocument();
    expect(screen.queryByText(/^\d+\.\d+m$/)).toBeNull();
  });

  it('clarifies Pull Requests are gh-CLI/MCP-observed, not live GitHub state, and explains CI checks viewed', async () => {
    renderGitEfficiency(
      makeReport({
        metrics: {
          ...BASE_METRICS,
          prMetrics: {
            created: 2,
            merged: 0,
            checksViewed: 1,
            prsUpdated: 0,
            prActivity: [],
            avgTimeToCreateMs: null,
          },
        },
      }),
    );
    expect(await screen.findByText('Pull Requests')).toBeInTheDocument();
    expect(screen.getByText(/not live GitHub state/)).toBeInTheDocument();
    expect(screen.getByText(/times you ran `gh pr checks`/)).toBeInTheDocument();
  });

  it('explains why Time to PR is blank instead of leaving an unexplained dash', async () => {
    renderGitEfficiency(
      makeReport({
        metrics: {
          ...BASE_METRICS,
          prMetrics: {
            created: 1,
            merged: 0,
            checksViewed: 0,
            prsUpdated: 0,
            prActivity: [],
            avgTimeToCreateMs: null,
          },
        },
      }),
    );
    expect(await screen.findByText('Time to PR')).toBeInTheDocument();
    expect(
      screen.getByText('no commit found in this window before the PR was created'),
    ).toBeInTheDocument();
  });
});

describe('GitEfficiency view — no timeframe picker, always last 7 days', () => {
  it('renders no timeframe tab control and shows the exact 7-day date range', async () => {
    renderGitEfficiency(makeReport());
    await screen.findByText('Git Efficiency');
    expect(
      screen.getByText(/^Last 7 days \(.+\) · compared to the previous 7 days$/),
    ).toBeInTheDocument();
    expect(screen.queryByText('Yesterday')).toBeNull();
    expect(screen.queryByRole('button', { name: 'This week' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'View this week' })).toBeNull();
  });

  it('places the 7-day window label with the hero KPIs, not the page header above the (30-day) tree', async () => {
    const { container } = renderGitEfficiency(makeReport());
    await screen.findByText('Git Efficiency');
    await screen.findByText('commits');
    const html = container.innerHTML;
    const treeSectionPos = html.indexOf('Repos &amp; Worktrees');
    const sevenDayLabelPos = html.indexOf('compared to the previous 7 days');
    const heroCommitsPos = html.indexOf('>commits<');
    expect([treeSectionPos, sevenDayLabelPos, heroCommitsPos]).not.toContain(-1);
    // The 7-day label must come after the tree section (so it can't read as
    // if it also governs the tree's own, differently-windowed 30-day data)
    // and right before the hero KPIs it actually describes.
    expect(treeSectionPos).toBeLessThan(sevenDayLabelPos);
    expect(sevenDayLabelPos).toBeLessThan(heroCommitsPos);
  });

  it('shows a "+N vs last week" delta on the commits KPI once the comparison window loads', async () => {
    renderGitEfficiencyByWindow({
      week: makeReport({ metrics: { ...BASE_METRICS, commitCount: 7 } }),
      previous_week: makeReport({ metrics: { ...BASE_METRICS, commitCount: 4 } }),
      '30': makeReport(),
    });
    await screen.findByText('Git Efficiency');
    expect(await screen.findByText('+3 vs last week')).toBeInTheDocument();
  });

  it('shows "same as last week" when this week and last week match', async () => {
    renderGitEfficiencyByWindow({
      week: makeReport({ metrics: { ...BASE_METRICS, commitCount: 4 } }),
      previous_week: makeReport({ metrics: { ...BASE_METRICS, commitCount: 4 } }),
      '30': makeReport(),
    });
    await screen.findByText('Git Efficiency');
    // Commits AND PRs-created both compare equal here (both KPIs default to
    // matching values in BASE_METRICS), so more than one KPI legitimately
    // renders this text — assert it appears at least once, not exactly once.
    const matches = await screen.findAllByText('same as last week');
    expect(matches.length).toBeGreaterThan(0);
  });

  it('never lets the comparison-week fetch affect coaching/best-practices, which always reflect this week', async () => {
    renderGitEfficiencyByWindow({
      week: makeReport({
        metrics: {
          ...BASE_METRICS,
          bestPractices: [
            { id: 'sync', label: 'Synced before editing', status: 'pass', detail: 'ok' },
          ],
        },
      }),
      previous_week: makeReport({
        metrics: {
          ...BASE_METRICS,
          bestPractices: [
            { id: 'sync', label: 'Synced before editing', status: 'fail', detail: 'not this week' },
          ],
        },
      }),
      '30': makeReport(),
    });
    await screen.findByText('Git Efficiency');
    // Coaching is always this week's — the passing chip, never the
    // comparison window's failing one, and there is no control that could
    // switch it.
    expect(await screen.findByText(/Synced before editing/)).toBeInTheDocument();
    expect(screen.queryByText('not this week')).toBeNull();
  });

  it('explains what "Conflicts" and "Behind" measure, right under the hero KPIs', async () => {
    renderGitEfficiency(makeReport());
    await screen.findByText('Git Efficiency');
    expect(screen.getByText(/merge\/rebase\/pull attempts/)).toBeInTheDocument();
    expect(screen.getByText(/commits your branch is/)).toBeInTheDocument();
  });
});

describe('GitEfficiency view — repo/worktree tree always spans the last 30 days', () => {
  it('shows the exact 30-day date range under "Repos & Worktrees", independent of the 7-day hero window', async () => {
    renderGitEfficiencyByWindow({
      week: makeReport({ since: Date.now() - 6 * 86_400_000, until: Date.now() }),
      previous_week: makeReport(),
      '30': makeReport({ since: Date.now() - 29 * 86_400_000, until: Date.now() }),
    });
    await screen.findByText('Git Efficiency');
    expect(await screen.findByText(/^Last 30 days \(.+\)$/)).toBeInTheDocument();
  });

  it('always requests scope=all for the tree window, even when a repo/worktree is selected for the hero KPIs', async () => {
    const requestedScopes: string[] = [];
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    globalThis.fetch = (async (input: string | URL) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.searchParams.get('window') === '30') {
        requestedScopes.push(url.searchParams.get('scope') ?? '');
      }
      return jsonResponse(makeReport({ rows: [{ identity: IDENTITY_A, metrics: BASE_METRICS }] }));
    }) as typeof fetch;
    render(
      <QueryClientProvider client={qc}>
        <GitEfficiency />
      </QueryClientProvider>,
    );
    await screen.findByText('Repos & Worktrees');
    fireEvent.click(screen.getAllByRole('button', { name: 'org/repo-a' })[0]!);
    await screen.findByRole('button', { name: 'All repos' });
    expect(requestedScopes.length).toBeGreaterThan(0);
    expect(requestedScopes.every((s) => s === 'all')).toBe(true);
  });

  it('shows a tree row set from the 30-day window even when the 7-day hero window has no rows', async () => {
    renderGitEfficiencyByWindow({
      week: makeReport({ rows: [] }),
      previous_week: makeReport({ rows: [] }),
      '30': makeReport({ rows: [{ identity: IDENTITY_A, metrics: BASE_METRICS }] }),
    });
    await screen.findByText('Git Efficiency');
    expect(await screen.findByText('primary')).toBeInTheDocument();
  });
});

describe('GitEfficiency view — Recent Git Activity ordering', () => {
  it('orders rows newest first regardless of insertion order', async () => {
    // The API serves epoch millis, not ISO strings.
    const base = new Date().setHours(9, 0, 0, 0);
    renderGitEfficiency(
      makeReport({
        metrics: {
          ...BASE_METRICS,
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
        },
      }),
    );
    await screen.findByText('Recent Git Activity');
    const order = screen.getAllByText(/^git (diff|push|log)$/).map((el) => el.textContent?.trim());
    expect(order).toEqual(['git push', 'git log', 'git diff']);
  });
});

describe('GitEfficiency view — repo/worktree tree', () => {
  it('renders one repo group and one worktree row per report.rows entry', async () => {
    renderGitEfficiency(
      makeReport({
        rows: [
          { identity: IDENTITY_A, metrics: BASE_METRICS },
          { identity: IDENTITY_B, metrics: BASE_METRICS },
        ],
      }),
    );
    expect(await screen.findByText('Repos & Worktrees')).toBeInTheDocument();
    // IDENTITY_A and IDENTITY_B share a repoKey — one repo header, two
    // worktree rows nested beneath it.
    expect(screen.getAllByText('org/repo-a').length).toBeGreaterThan(0);
    expect(screen.getByText('primary')).toBeInTheDocument();
    expect(screen.getByText('feature')).toBeInTheDocument();
  });

  it('shows an empty state instead of an empty tree when rows is empty', async () => {
    renderGitEfficiency(makeReport({ rows: [] }));
    expect(await screen.findByText('No git activity in this window')).toBeInTheDocument();
  });

  it('collapses and re-expands a repo group without affecting selection', async () => {
    renderGitEfficiency(
      makeReport({
        rows: [
          { identity: IDENTITY_A, metrics: BASE_METRICS },
          { identity: IDENTITY_B, metrics: BASE_METRICS },
        ],
      }),
    );
    await screen.findByText('Repos & Worktrees');
    expect(screen.getByText('primary')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
    expect(screen.queryByText('primary')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
    expect(screen.getByText('primary')).toBeInTheDocument();
  });
});

describe('GitEfficiency view — scope breadcrumb', () => {
  it('starts at "All repos"', async () => {
    renderGitEfficiency(makeReport());
    expect(await screen.findByText('All repos')).toBeInTheDocument();
  });

  it('clicking a repo name in the tree drills into repo scope and updates the breadcrumb', async () => {
    renderGitEfficiency(
      makeReport({
        rows: [
          { identity: IDENTITY_A, metrics: BASE_METRICS },
          { identity: IDENTITY_B, metrics: BASE_METRICS },
        ],
      }),
    );
    await screen.findByText('Repos & Worktrees');
    fireEvent.click(screen.getAllByRole('button', { name: 'org/repo-a' })[0]!);
    // Breadcrumb now reads "All repos / org/repo-a" — the first segment
    // (a button) is clickable, the repo segment is the current, non-link tail.
    expect(await screen.findByRole('button', { name: 'All repos' })).toBeInTheDocument();
  });

  it('clicking a worktree label drills into worktree scope with a three-segment breadcrumb', async () => {
    renderGitEfficiency(
      makeReport({
        rows: [{ identity: IDENTITY_B, metrics: BASE_METRICS }],
      }),
    );
    await screen.findByText('Repos & Worktrees');
    fireEvent.click(screen.getByRole('button', { name: 'feature' }));
    expect(await screen.findByRole('button', { name: 'All repos' })).toBeInTheDocument();
    // Repo segment is clickable at worktree scope (both the breadcrumb link
    // and the tree's own repo header render this same text as a button).
    expect(screen.getAllByRole('button', { name: 'org/repo-a' }).length).toBeGreaterThan(0);
  });

  it('clicking "All repos" resets the scope', async () => {
    renderGitEfficiency(makeReport({ rows: [{ identity: IDENTITY_A, metrics: BASE_METRICS }] }));
    await screen.findByText('Repos & Worktrees');
    fireEvent.click(screen.getAllByRole('button', { name: 'org/repo-a' })[0]!);
    const backButton = await screen.findByRole('button', { name: 'All repos' });
    fireEvent.click(backButton);
    // Back to the plain (non-link) "All repos" label.
    expect(await screen.findByText('All repos')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'All repos' })).toBeNull();
  });

  it('highlights the selected repo and worktree row in the tree', async () => {
    renderGitEfficiency(
      makeReport({
        rows: [
          { identity: IDENTITY_A, metrics: BASE_METRICS },
          { identity: IDENTITY_B, metrics: BASE_METRICS },
        ],
      }),
    );
    await screen.findByText('Repos & Worktrees');
    fireEvent.click(screen.getByRole('button', { name: 'feature' }));
    // The selected worktree row renders a distinct marker glyph alongside
    // its label — not just a breadcrumb change elsewhere on the page.
    const featureButton = await screen.findByRole('button', { name: /feature/ });
    expect(featureButton.textContent).toContain('●');
    const primaryButton = screen.getByRole('button', { name: 'primary' });
    expect(primaryButton.textContent).not.toContain('●');
  });

  it('shows a "View sessions" link once a repo is selected, and navigates to /sessions?repo=<name> on click', async () => {
    renderGitEfficiency(
      makeReport({
        rows: [{ identity: IDENTITY_A, metrics: BASE_METRICS }],
      }),
    );
    await screen.findByText('Repos & Worktrees');
    expect(screen.queryByText(/View sessions/)).toBeNull();

    fireEvent.click(screen.getAllByRole('button', { name: 'org/repo-a' })[0]!);
    const link = await screen.findByText(/View sessions/);
    fireEvent.click(link);
    try {
      expect(window.location.pathname).toBe('/sessions');
      expect(window.location.search).toBe(`?repo=${encodeURIComponent(IDENTITY_A.repoName!)}`);
    } finally {
      // Reset so this navigation doesn't leak into later tests in this file.
      window.history.pushState({}, '', '/');
    }
  });

  it('does not show a "View sessions" link for a repo/worktree with no resolved repoName', async () => {
    const unresolvedIdentity: WorktreeIdentity = {
      ...IDENTITY_A,
      repoKey: 'unresolved-repo:mystery',
      worktreeKey: 'unresolved-repo:mystery',
      repoName: null,
      worktreeLabel: 'worktree unknown',
    };
    renderGitEfficiency(
      makeReport({
        rows: [{ identity: unresolvedIdentity, metrics: BASE_METRICS }],
      }),
    );
    await screen.findByText('Repos & Worktrees');
    fireEvent.click(screen.getAllByRole('button', { name: unresolvedIdentity.repoKey })[0]!);
    await screen.findByRole('button', { name: 'All repos' });
    expect(screen.queryByText(/View sessions/)).toBeNull();
  });

  it('shows a per-worktree session count in the tree, clickable straight to /sessions?sessionIds=...', async () => {
    const metricsWithSessions = { ...BASE_METRICS, sessionIds: ['sess-1', 'sess-2'] };
    renderGitEfficiency(
      makeReport({
        rows: [{ identity: IDENTITY_A, metrics: metricsWithSessions }],
      }),
    );
    await screen.findByText('Repos & Worktrees');
    // Two links matching '2': the repo group header's own union count (also
    // 2, since it has only this one worktree) and the worktree row's count.
    const links = await screen.findAllByRole('button', { name: '2' });
    expect(links.length).toBeGreaterThan(0);
    fireEvent.click(links[links.length - 1]!);
    try {
      expect(window.location.pathname).toBe('/sessions');
      expect(window.location.search).toBe('?sessionIds=sess-1,sess-2');
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it("unions session ids across a repo's worktrees for the repo header count, deduped", async () => {
    const metricsA = { ...BASE_METRICS, sessionIds: ['sess-shared', 'sess-a-only'] };
    const metricsB = { ...BASE_METRICS, sessionIds: ['sess-shared'] };
    renderGitEfficiency(
      makeReport({
        rows: [
          { identity: IDENTITY_A, metrics: metricsA },
          { identity: IDENTITY_B, metrics: metricsB },
        ],
      }),
    );
    await screen.findByText('Repos & Worktrees');
    // Repo header shows the deduped union (2) — as does worktree A's own row
    // (its own 2 sessionIds happen to equal the union here), so there are
    // two '2' buttons; the naive (undeduped) sum of 3 must never appear.
    expect(await screen.findAllByRole('button', { name: '2' })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: '3' })).toBeNull();
  });

  it('links a single-session worktree row straight to that session, not a one-row filtered list', async () => {
    const metricsWithOneSession = { ...BASE_METRICS, sessionIds: ['sess-solo'] };
    renderGitEfficiency(
      makeReport({
        rows: [{ identity: IDENTITY_A, metrics: metricsWithOneSession }],
      }),
    );
    await screen.findByText('Repos & Worktrees');
    const links = await screen.findAllByRole('button', { name: '1' });
    fireEvent.click(links[links.length - 1]!);
    try {
      expect(window.location.pathname).toBe('/sessions');
      expect(window.location.search).toBe('?session=sess-solo');
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('explains a repo header count via tooltip only when it differs from the naive per-row sum', async () => {
    const metricsA = { ...BASE_METRICS, sessionIds: ['sess-shared', 'sess-a-only'] };
    const metricsB = { ...BASE_METRICS, sessionIds: ['sess-shared'] };
    renderGitEfficiency(
      makeReport({
        rows: [
          { identity: IDENTITY_A, metrics: metricsA },
          { identity: IDENTITY_B, metrics: metricsB },
        ],
      }),
    );
    await screen.findByText('Repos & Worktrees');
    const repoHeaderButton = screen.getAllByRole('button', { name: '2' })[0]!;
    expect(repoHeaderButton).toHaveAttribute(
      'title',
      '2 distinct sessions — some touched more than one worktree',
    );
  });

  it('shows a dash instead of a session-count link when a row has no sessions', async () => {
    renderGitEfficiency(
      makeReport({
        rows: [{ identity: IDENTITY_A, metrics: BASE_METRICS }],
      }),
    );
    await screen.findByText('Repos & Worktrees');
    expect(screen.queryByRole('button', { name: '0' })).toBeNull();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });
});

describe('GitEfficiency view — "behind" KPI scope-dependent behavior', () => {
  it('at worktree scope, reads liveState.behind and labels the compare branch dynamically', async () => {
    renderGitEfficiency(
      makeReport({
        scope: { kind: 'worktree', id: IDENTITY_A.worktreeKey },
        metrics: {
          ...BASE_METRICS,
          liveState: {
            branch: 'feature/foo',
            defaultBranch: 'develop',
            ahead: 1,
            behind: 12,
            measuredAtMs: Date.now() - 60_000,
          },
        },
      }),
    );
    expect(await screen.findByText('behind develop')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
  });

  it('at rollup scope, reads worstBehind and names the workspace instead of a bare number', async () => {
    renderGitEfficiency(
      makeReport({
        scope: { kind: 'all' },
        worstBehind: { identity: IDENTITY_B, behind: 25 },
      }),
    );
    expect(await screen.findByText('worst behind')).toBeInTheDocument();
    expect(screen.getByText('25')).toBeInTheDocument();
    expect(screen.getByText(/feature/)).toBeInTheDocument();
  });

  it('at rollup scope with no worstBehind data, shows a neutral "—" instead of a misleading zero', async () => {
    renderGitEfficiency(makeReport({ scope: { kind: 'all' }, worstBehind: null }));
    const label = await screen.findByText('worst behind');
    expect(label.nextElementSibling?.textContent).toBe('—');
  });
});
