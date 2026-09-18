import {
  buildGitWorkspaceReport,
  computeWorkspaceMetrics,
  reconcileHydratedCommits,
  rollupWorkspaceMetrics,
  COMMIT_RECONCILE_WINDOW_MS,
  type WorktreeLiveState,
} from './git-workspace-report.js';
import { classifyGitCommand } from './git-event-classifier.js';
import { GIT_LOG_SESSION_ID, type GitActivityRecord } from './git-activity-recorder.js';
import type { WorktreeIdentity } from './git-workspace-identity.js';
import type { ToolCallRecord } from '../storage/types.js';

const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
afterAll(() => stderrSpy.mockRestore());

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

let recordCounter = 0;
beforeEach(() => {
  recordCounter = 0;
});

function makeToolCallRecord(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: 'r-1',
    sessionId: 'sess-1',
    toolName: 'Bash',
    toolUseId: 'tu-1',
    timestamp: Date.now(),
    durationMs: 100,
    success: true,
    ...overrides,
  };
}

/** Builds a 'git' GitActivityRecord by running a command through the real
 *  classifier — so gitEvent.command (redacted) and gitEvent.files
 *  (conflict-file extraction) match what production code would produce. */
function gitActivity(
  command: string,
  workspaceKey: string,
  overrides: Partial<ToolCallRecord> = {},
): GitActivityRecord {
  const record = makeToolCallRecord({ command, ...overrides });
  const gitEvent = classifyGitCommand(command, record, () => null);
  recordCounter++;
  return {
    kind: 'git',
    gitEvent,
    timestamp: record.timestamp,
    recordId: `r-${recordCounter}`,
    workspaceKey,
    sessionId: record.sessionId ?? 'unknown',
  };
}

/** Builds a hydrated-from-`git log` commit record, the shape
 *  `GitWorkspaceReporter.hydrateGitLog` ingests. */
function hydratedCommitActivity(
  workspaceKey: string,
  timestamp: number,
  hash: string,
): GitActivityRecord {
  return {
    kind: 'git',
    gitEvent: {
      timestamp,
      type: 'commit',
      command: `git commit (${hash})`,
      success: true,
      durationMs: null,
      repo: null,
      subject: `subject ${hash}`,
      url: null,
      hash,
    },
    timestamp,
    recordId: `gitlog:${hash}`,
    workspaceKey,
    sessionId: GIT_LOG_SESSION_ID,
  };
}

function editActivity(
  filePath: string,
  workspaceKey: string,
  timestamp: number,
  sessionId = 'sess-1',
): GitActivityRecord {
  recordCounter++;
  return {
    kind: 'edit',
    filePath,
    timestamp,
    recordId: `r-${recordCounter}`,
    workspaceKey,
    sessionId,
  };
}

function makeIdentity(overrides: Partial<WorktreeIdentity> = {}): WorktreeIdentity {
  return {
    repoKey: '/repo',
    worktreeKey: '/repo',
    repoName: 'acme/widgets',
    worktreeRoot: '/repo',
    worktreeLabel: 'primary',
    branch: 'main',
    ...overrides,
  };
}

function makeLiveState(overrides: Partial<WorktreeLiveState> = {}): WorktreeLiveState {
  return {
    branch: 'main',
    defaultBranch: 'main',
    ahead: null,
    behind: null,
    measuredAtMs: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Step 1 transplant fidelity: reproduce key GitEfficiencyTracker scenarios
// against computeWorkspaceMetrics directly, before trusting anything about
// rollup.
// ---------------------------------------------------------------------------

describe('computeWorkspaceMetrics — transplanted single-workspace behavior', () => {
  const identity = makeIdentity();

  it('tracks conflict resolved by commit', () => {
    const t = Date.now();
    const records = [
      gitActivity('git merge main', 'ws-a', {
        timestamp: t,
        success: false,
        error: 'CONFLICT (content): Merge conflict in src/file.ts',
      }),
      gitActivity('git commit -m "resolve conflicts"', 'ws-a', { timestamp: t + 10_000 }),
    ];
    const metrics = computeWorkspaceMetrics(records, identity, null);
    expect(metrics.conflictHistory).toHaveLength(1);
    expect(metrics.conflictHistory[0].resolution).toBe('resolved');
    expect(metrics.conflictHistory[0].resolutionTimeMs).toBe(10_000);
    expect(metrics.conflictResolutionRate).toBe(1);
  });

  it('tracks merge abort after conflict', () => {
    const t = Date.now();
    const records = [
      gitActivity('git merge main', 'ws-a', {
        timestamp: t,
        success: false,
        error: 'CONFLICT (content): Merge conflict in src/file.ts',
      }),
      gitActivity('git merge --abort', 'ws-a', { timestamp: t + 5000 }),
    ];
    const metrics = computeWorkspaceMetrics(records, identity, null);
    expect(metrics.abortedOperations).toBe(1);
    expect(metrics.conflictHistory).toHaveLength(1);
    expect(metrics.conflictHistory[0].resolution).toBe('aborted');
    expect(metrics.conflictHistory[0].resolutionTimeMs).toBe(5000);
  });

  it('includes an open, unresolved conflict in the resolution-rate denominator as "pending"', () => {
    const records = [
      gitActivity('git merge main', 'ws-a', {
        success: false,
        error: 'CONFLICT (content): Merge conflict in a.ts',
      }),
    ];
    const metrics = computeWorkspaceMetrics(records, identity, null);
    expect(metrics.conflictResolutionRate).toBe(0);
    expect(metrics.conflictHistory.find((c) => c.resolution === 'pending')).toBeDefined();
  });

  it('distinguishes --force-with-lease from bare --force', () => {
    const records = [
      gitActivity('git push --force-with-lease origin feature', 'ws-a'),
      gitActivity('git push --force origin feature', 'ws-a'),
    ];
    const metrics = computeWorkspaceMetrics(records, identity, null);
    expect(metrics.forcePushes).toBe(2);
    expect(metrics.riskIndicators.usesForceWithLease).toBe(true);
    expect(metrics.hasUsedBareForcePush).toBe(true);
  });

  it('does not treat read-only worktree inspection as real worktree usage', () => {
    const records = [gitActivity('git worktree list', 'ws-a')];
    const metrics = computeWorkspaceMetrics(records, identity, null);
    expect(metrics.velocityMetrics.worktreeCount).toBe(0);
    expect(metrics.riskIndicators.usesWorktrees).toBe(false);
  });

  it('prevention score: null with insufficient data, 100 when all remaining practices pass', () => {
    const insufficient = computeWorkspaceMetrics(
      [gitActivity('git status', 'ws-a')],
      identity,
      null,
    );
    expect(insufficient.preventionScore).toBeNull();

    const t = Date.now();
    const clean = computeWorkspaceMetrics(
      [
        gitActivity('git fetch origin', 'ws-a', { timestamp: t }),
        editActivity('src/a.ts', 'ws-a', t + 100),
        gitActivity('git commit -m "a"', 'ws-a', { timestamp: t + 200 }),
        gitActivity('git commit -m "b"', 'ws-a', { timestamp: t + 300 }),
        gitActivity('git commit -m "c"', 'ws-a', { timestamp: t + 400 }),
        gitActivity('git rebase origin/main', 'ws-a', { timestamp: t + 500 }),
      ],
      identity,
      null,
    );
    // use_worktrees no longer exists at workspace scope, so a clean session
    // (sync-before-edit, small increments, rebase over merge) should score
    // 100 across the remaining checks alone.
    expect(clean.preventionScore).toBe(100);
  });

  it('sync_before_edit is "unknown" before any edit, "fail" when edit precedes sync', () => {
    const noEditsYet = computeWorkspaceMetrics([gitActivity('git status', 'ws-a')], identity, null);
    expect(noEditsYet.bestPractices.find((p) => p.id === 'sync_before_edit')?.status).toBe(
      'unknown',
    );

    const t = Date.now();
    const editFirst = computeWorkspaceMetrics(
      [
        editActivity('src/a.ts', 'ws-a', t),
        gitActivity('git pull origin main', 'ws-a', { timestamp: t + 1000 }),
      ],
      identity,
      null,
    );
    expect(editFirst.bestPractices.find((p) => p.id === 'sync_before_edit')?.status).toBe('fail');
  });

  it('does not include a use_worktrees entry in per-workspace bestPractices', () => {
    const records = [
      gitActivity('git merge main', 'ws-a', {
        success: false,
        error: 'CONFLICT (content): Merge conflict in x.ts',
      }),
    ];
    const metrics = computeWorkspaceMetrics(records, identity, null);
    expect(metrics.bestPractices.find((p) => p.id === 'use_worktrees')).toBeUndefined();
  });

  it('extracts conflicted file paths and surfaces them as hot files once re-edited', () => {
    const records: GitActivityRecord[] = [
      gitActivity('git merge main', 'ws-a', {
        success: false,
        error:
          'CONFLICT (content): Merge conflict in src/a.ts\n' +
          'CONFLICT (content): Merge conflict in src/b.ts\n' +
          'Automatic merge failed',
      }),
      gitActivity('git commit -m "resolve"', 'ws-a', { timestamp: Date.now() + 1000 }),
      editActivity('src/a.ts', 'ws-a', Date.now() + 2000),
    ];
    const metrics = computeWorkspaceMetrics(records, identity, null);
    expect(metrics.conflictHistory[0].files).toContain('src/a.ts');
    expect(metrics.conflictHistory[0].files).toContain('src/b.ts');
    expect(metrics.riskIndicators.hotFiles).toContain('src/a.ts');
  });
});

// ---------------------------------------------------------------------------
// The load-bearing correctness test: per-worktree sequential state must
// never leak across worktrees.
// ---------------------------------------------------------------------------

describe('buildGitWorkspaceReport — per-workspace isolation', () => {
  it('workspace A pulling never resets workspace B commitsSinceLastSync, even when their records interleave by timestamp', () => {
    const identityA = makeIdentity({
      repoKey: '/repo',
      worktreeKey: '/repo/a',
      worktreeLabel: 'a',
      branch: 'feature-a',
    });
    const identityB = makeIdentity({
      repoKey: '/repo',
      worktreeKey: '/repo/b',
      worktreeLabel: 'b',
      branch: 'feature-b',
    });

    // A: edit, pull, then 3 commits -> commitsSinceLastSync should read 3.
    const aRecords = [
      editActivity('a.ts', '/repo/a', 100),
      gitActivity('git pull origin main', '/repo/a', { timestamp: 200 }),
      gitActivity('git commit -m "a1"', '/repo/a', { timestamp: 400 }),
      gitActivity('git commit -m "a2"', '/repo/a', { timestamp: 600 }),
      gitActivity('git commit -m "a3"', '/repo/a', { timestamp: 800 }),
    ];

    // B: 5 commits, no pull at all, interleaved by timestamp with A's records.
    const bRecords = [
      gitActivity('git commit -m "b1"', '/repo/b', { timestamp: 150 }),
      gitActivity('git commit -m "b2"', '/repo/b', { timestamp: 350 }),
      gitActivity('git commit -m "b3"', '/repo/b', { timestamp: 500 }),
      gitActivity('git commit -m "b4"', '/repo/b', { timestamp: 700 }),
      gitActivity('git commit -m "b5"', '/repo/b', { timestamp: 900 }),
    ];

    const identities = new Map([
      ['/repo/a', identityA],
      ['/repo/b', identityB],
    ]);
    const report = buildGitWorkspaceReport({
      scope: { kind: 'all' },
      records: [...aRecords, ...bRecords],
      identities,
      liveStates: new Map(),
    });

    const rowA = report.rows.find((r) => r.identity.worktreeKey === '/repo/a');
    const rowB = report.rows.find((r) => r.identity.worktreeKey === '/repo/b');
    // A pulled, then made 3 commits after that pull -> 3, reset by its OWN
    // pull only (not polluted by B's activity).
    expect(rowA?.metrics.riskIndicators.commitsSinceLastSync).toBe(3);
    // B never pulled at all -> its 5 commits must not be zeroed out by A's
    // pull, which is exactly the bug this whole redesign exists to fix.
    expect(rowB?.metrics.riskIndicators.commitsSinceLastSync).toBe(5);
  });
});

describe('rollupWorkspaceMetrics', () => {
  it('sums additive counters across workspaces (commitCount, forcePushes)', () => {
    const identityA = makeIdentity({ worktreeKey: '/repo/a', worktreeLabel: 'a' });
    const identityB = makeIdentity({ worktreeKey: '/repo/b', worktreeLabel: 'b' });

    const metricsA = computeWorkspaceMetrics(
      [
        gitActivity('git commit -m "1"', 'ws-a', { timestamp: 100 }),
        gitActivity('git commit -m "2"', 'ws-a', { timestamp: 200 }),
        gitActivity('git push --force origin feature-a', 'ws-a', { timestamp: 300 }),
      ],
      identityA,
      null,
    );
    const metricsB = computeWorkspaceMetrics(
      [
        gitActivity('git commit -m "1"', 'ws-b', { timestamp: 100 }),
        gitActivity('git commit -m "2"', 'ws-b', { timestamp: 200 }),
        gitActivity('git push --force origin feature-b', 'ws-b', { timestamp: 300 }),
      ],
      identityB,
      null,
    );

    const rolled = rollupWorkspaceMetrics([
      { identity: identityA, metrics: metricsA },
      { identity: identityB, metrics: metricsB },
    ]);

    expect(rolled.commitCount).toBe(4);
    expect(rolled.forcePushes).toBe(2);
  });

  it('recomputes conflictResolutionRate from concatenated conflict history, not by averaging per-workspace rates', () => {
    const identityA = makeIdentity({ worktreeKey: '/repo/a', worktreeLabel: 'a' });
    const identityB = makeIdentity({ worktreeKey: '/repo/b', worktreeLabel: 'b' });

    // A: 1 resolved out of 1 -> rate 1.0
    const metricsA = computeWorkspaceMetrics(
      [
        gitActivity('git merge main', 'ws-a', {
          timestamp: 100,
          success: false,
          error: 'CONFLICT (content): Merge conflict in a.ts',
        }),
        gitActivity('git commit -m "resolve a"', 'ws-a', { timestamp: 200 }),
      ],
      identityA,
      null,
    );
    // B: 0 resolved out of 2 (both still pending) -> rate 0.0
    const metricsB = computeWorkspaceMetrics(
      [
        gitActivity('git merge main', 'ws-b', {
          timestamp: 100,
          success: false,
          error: 'CONFLICT (content): Merge conflict in b1.ts',
        }),
        gitActivity('git rebase main', 'ws-b', {
          timestamp: 200,
          success: false,
          error: 'rebase conflict could not apply patch',
        }),
      ],
      identityB,
      null,
    );

    expect(metricsA.conflictResolutionRate).toBe(1);
    expect(metricsB.conflictResolutionRate).toBe(0);

    const rolled = rollupWorkspaceMetrics([
      { identity: identityA, metrics: metricsA },
      { identity: identityB, metrics: metricsB },
    ]);

    // 1 resolved out of 3 total conflict records, not (1.0 + 0.0) / 2 = 0.5.
    expect(rolled.conflictResolutionRate).toBeCloseTo(1 / 3);
  });

  it("nulls out inherently single-workspace RiskIndicators fields rather than inheriting one workspace's values", () => {
    const identityA = makeIdentity({ worktreeKey: '/repo/a', worktreeLabel: 'a' });

    const t = Date.now();
    const metricsA = computeWorkspaceMetrics(
      [
        editActivity('a.ts', 'ws-a', t),
        gitActivity('git commit -m "x"', 'ws-a', { timestamp: t + 1000 }),
      ],
      identityA,
      null,
    );
    expect(metricsA.riskIndicators.syncedBeforeEditing).toBe(false);

    const rolled = rollupWorkspaceMetrics([{ identity: identityA, metrics: metricsA }]);
    expect(rolled.riskIndicators.syncedBeforeEditing).toBeNull();
    expect(rolled.riskIndicators.hotFiles).toEqual([]);
  });
});

describe('lastActivityMs', () => {
  it('is null when a workspace has no records', () => {
    const identity = makeIdentity();
    const metrics = computeWorkspaceMetrics([], identity, null);
    expect(metrics.lastActivityMs).toBeNull();
  });

  it('tracks the latest record timestamp across git, edit, and other kinds — not just commits', () => {
    const identity = makeIdentity();
    const metrics = computeWorkspaceMetrics(
      [
        gitActivity('git commit -m "1"', 'ws-a', { timestamp: 100 }),
        editActivity('a.ts', 'ws-a', 9000),
        gitActivity('git status', 'ws-a', { timestamp: 500 }),
      ],
      identity,
      null,
    );
    // The latest activity is the edit at 9000, not the commit at 100 — a
    // sort keyed off commitTimestamps/lastPushTimestamp alone would miss it.
    expect(metrics.lastActivityMs).toBe(9000);
  });

  it('rolls up as the max across workspaces, not the sum or the last node', () => {
    const identityA = makeIdentity({ worktreeKey: '/repo/a', worktreeLabel: 'a' });
    const identityB = makeIdentity({ worktreeKey: '/repo/b', worktreeLabel: 'b' });

    const metricsA = computeWorkspaceMetrics(
      [gitActivity('git commit -m "1"', 'ws-a', { timestamp: 5000 })],
      identityA,
      null,
    );
    // B is chronologically earlier but declared second — rollup must pick
    // the max timestamp, not whichever node happens to come last.
    const metricsB = computeWorkspaceMetrics(
      [gitActivity('git commit -m "1"', 'ws-b', { timestamp: 100 })],
      identityB,
      null,
    );

    const rolled = rollupWorkspaceMetrics([
      { identity: identityB, metrics: metricsB },
      { identity: identityA, metrics: metricsA },
    ]);
    expect(rolled.lastActivityMs).toBe(5000);
  });

  it('rolls up to null when every workspace has a null lastActivityMs', () => {
    const identityA = makeIdentity({ worktreeKey: '/repo/a', worktreeLabel: 'a' });
    const metricsA = computeWorkspaceMetrics([], identityA, null);
    const rolled = rollupWorkspaceMetrics([{ identity: identityA, metrics: metricsA }]);
    expect(rolled.lastActivityMs).toBeNull();
  });
});

describe('velocityMetrics.longestGapMs — includes the open-ended gap since the last commit', () => {
  const FIXED_NOW = new Date(2026, 8, 8, 12, 0, 0).getTime(); // 2026-09-08 noon local

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('counts the gap from the last commit to now, not just gaps between existing commits', () => {
    const identity = makeIdentity();
    const oneDayMs = 86_400_000;
    // Two commits a mere hour apart, but the last one was 4 days before
    // FIXED_NOW — the real "longest gap" is the 4-day silence since, not the
    // 1-hour gap between the two commits, which is all the old math saw.
    const metrics = computeWorkspaceMetrics(
      [
        gitActivity('git commit -m "1"', 'ws-a', {
          timestamp: FIXED_NOW - 4 * oneDayMs - 3_600_000,
        }),
        gitActivity('git commit -m "2"', 'ws-a', { timestamp: FIXED_NOW - 4 * oneDayMs }),
      ],
      identity,
      null,
    );
    expect(metrics.velocityMetrics.longestGapMs).toBe(4 * oneDayMs);
  });

  it('still reports the gap since the only commit when there is just one', () => {
    const identity = makeIdentity();
    const twoDaysMs = 2 * 86_400_000;
    const metrics = computeWorkspaceMetrics(
      [gitActivity('git commit -m "1"', 'ws-a', { timestamp: FIXED_NOW - twoDaysMs })],
      identity,
      null,
    );
    expect(metrics.velocityMetrics.longestGapMs).toBe(twoDaysMs);
  });

  it('stays null with zero commits — there is no "last commit" to measure from', () => {
    const identity = makeIdentity();
    const metrics = computeWorkspaceMetrics([], identity, null);
    expect(metrics.velocityMetrics.longestGapMs).toBeNull();
  });

  it('prefers a between-commits gap that is larger than the since-last-commit gap', () => {
    const identity = makeIdentity();
    const oneDayMs = 86_400_000;
    // The gap between commit 1 and commit 2 (3 days) is bigger than the gap
    // from commit 2 to FIXED_NOW (1 hour) — the between-commits max must
    // still win here, not get silently replaced by the smaller tail gap.
    const metrics = computeWorkspaceMetrics(
      [
        gitActivity('git commit -m "1"', 'ws-a', {
          timestamp: FIXED_NOW - 3 * oneDayMs - 3_600_000,
        }),
        gitActivity('git commit -m "2"', 'ws-a', { timestamp: FIXED_NOW - 3_600_000 }),
      ],
      identity,
      null,
    );
    expect(metrics.velocityMetrics.longestGapMs).toBe(3 * oneDayMs);
  });

  it('caps the since-last-commit gap at an explicit nowMs instead of real wall-clock time', () => {
    // A bounded PAST window (e.g. "yesterday") must not extend this gap all
    // the way to FIXED_NOW just because that's what real "now" happens to
    // be — it should stop at the window's own boundary.
    const identity = makeIdentity();
    const oneDayMs = 86_400_000;
    const windowUntil = FIXED_NOW - 2 * oneDayMs;
    const metrics = computeWorkspaceMetrics(
      [gitActivity('git commit -m "1"', 'ws-a', { timestamp: FIXED_NOW - 5 * oneDayMs })],
      identity,
      null,
      windowUntil,
    );
    expect(metrics.velocityMetrics.longestGapMs).toBe(3 * oneDayMs);
  });

  it('defaults to real wall-clock time when no nowMs is passed', () => {
    const identity = makeIdentity();
    const twoDaysMs = 2 * 86_400_000;
    const metrics = computeWorkspaceMetrics(
      [gitActivity('git commit -m "1"', 'ws-a', { timestamp: FIXED_NOW - twoDaysMs })],
      identity,
      null,
    );
    expect(metrics.velocityMetrics.longestGapMs).toBe(twoDaysMs);
  });
});

describe('sessionIds', () => {
  it('is empty when a workspace has no records', () => {
    const identity = makeIdentity();
    const metrics = computeWorkspaceMetrics([], identity, null);
    expect(metrics.sessionIds).toEqual([]);
  });

  it('collects distinct session ids across every record kind, deduped', () => {
    const identity = makeIdentity();
    const metrics = computeWorkspaceMetrics(
      [
        gitActivity('git commit -m "1"', 'ws-a', { sessionId: 'sess-x', timestamp: 100 }),
        gitActivity('git push', 'ws-a', { sessionId: 'sess-x', timestamp: 200 }),
        editActivity('a.ts', 'ws-a', 300, 'sess-y'),
      ],
      identity,
      null,
    );
    expect([...metrics.sessionIds].sort()).toEqual(['sess-x', 'sess-y']);
  });

  it("falls back to 'unknown' for a record whose source ToolCallRecord had no sessionId", () => {
    const identity = makeIdentity();
    const metrics = computeWorkspaceMetrics(
      [gitActivity('git commit -m "1"', 'ws-a', { sessionId: undefined, timestamp: 100 })],
      identity,
      null,
    );
    expect(metrics.sessionIds).toEqual(['unknown']);
  });

  it('rolls up as a deduped union across workspaces, not a concatenation with duplicates', () => {
    const identityA = makeIdentity({ worktreeKey: '/repo/a', worktreeLabel: 'a' });
    const identityB = makeIdentity({ worktreeKey: '/repo/b', worktreeLabel: 'b' });

    // sess-shared touched both worktrees (e.g. a session that cd'd between
    // them) — the rollup must count it once, not twice.
    const metricsA = computeWorkspaceMetrics(
      [
        gitActivity('git commit -m "1"', 'ws-a', { sessionId: 'sess-shared', timestamp: 100 }),
        gitActivity('git commit -m "2"', 'ws-a', { sessionId: 'sess-a-only', timestamp: 200 }),
      ],
      identityA,
      null,
    );
    const metricsB = computeWorkspaceMetrics(
      [gitActivity('git commit -m "1"', 'ws-b', { sessionId: 'sess-shared', timestamp: 300 })],
      identityB,
      null,
    );

    const rolled = rollupWorkspaceMetrics([
      { identity: identityA, metrics: metricsA },
      { identity: identityB, metrics: metricsB },
    ]);
    expect([...rolled.sessionIds].sort()).toEqual(['sess-a-only', 'sess-shared']);
  });
});

describe('buildGitWorkspaceReport — parallel_isolation (repo scope)', () => {
  const repoKey = '/repo';

  function tworktrees(sameFile: boolean) {
    const identityA = makeIdentity({ repoKey, worktreeKey: '/repo/a', worktreeLabel: 'a' });
    const identityB = makeIdentity({ repoKey, worktreeKey: '/repo/b', worktreeLabel: 'b' });
    const records = [
      editActivity('src/a.ts', '/repo/a', 100),
      gitActivity('git commit -m "a"', '/repo/a', { timestamp: 200 }),
      editActivity(sameFile ? 'src/a.ts' : 'src/b.ts', '/repo/b', 150),
      gitActivity('git commit -m "b"', '/repo/b', { timestamp: 250 }),
    ];
    const identities = new Map([
      ['/repo/a', identityA],
      ['/repo/b', identityB],
    ]);
    return { records, identities };
  }

  it('warns when the same file was edited in two active worktrees of the same repo', () => {
    const { records, identities } = tworktrees(true);
    const report = buildGitWorkspaceReport({
      scope: { kind: 'repo', id: repoKey },
      records,
      identities,
      liveStates: new Map(),
    });
    const check = report.metrics.bestPractices.find((p) => p.id === 'parallel_isolation');
    expect(check?.status).toBe('warn');
  });

  it('passes when the two active worktrees touched disjoint files', () => {
    const { records, identities } = tworktrees(false);
    const report = buildGitWorkspaceReport({
      scope: { kind: 'repo', id: repoKey },
      records,
      identities,
      liveStates: new Map(),
    });
    const check = report.metrics.bestPractices.find((p) => p.id === 'parallel_isolation');
    expect(check?.status).toBe('pass');
  });

  it('does not count a placeholder row as an active worktree', () => {
    const identityA = makeIdentity({ repoKey, worktreeKey: '/repo/a', worktreeLabel: 'a' });
    const unknown = makeIdentity({ repoKey, worktreeKey: 'unresolved-repo:acme/widgets' });
    const records = [
      editActivity('src/a.ts', '/repo/a', 100),
      editActivity('src/a.ts', 'unresolved-repo:acme/widgets', 150),
    ];
    const identities = new Map([
      ['/repo/a', identityA],
      ['unresolved-repo:acme/widgets', unknown],
    ]);
    const report = buildGitWorkspaceReport({
      scope: { kind: 'repo', id: repoKey },
      records,
      identities,
      liveStates: new Map(),
    });
    expect(report.rows).toHaveLength(2);
    const check = report.metrics.bestPractices.find((p) => p.id === 'parallel_isolation');
    expect(check?.status).toBe('n/a');
  });
});

describe('buildGitWorkspaceReport — hasForcePushedToDefaultBranch uses per-workspace liveState', () => {
  it('does not flag a bare force-push on a feature branch, but does flag one on the default branch, for the right workspace only', () => {
    const identityA = makeIdentity({ worktreeKey: '/repo/a', worktreeLabel: 'a' });
    const identityB = makeIdentity({ worktreeKey: '/repo/b', worktreeLabel: 'b' });

    const records = [
      gitActivity('git push --force origin feature-x', '/repo/a', { timestamp: 100 }),
      gitActivity('git push --force origin main', '/repo/b', { timestamp: 100 }),
    ];
    const identities = new Map([
      ['/repo/a', identityA],
      ['/repo/b', identityB],
    ]);
    const liveStates = new Map<string, WorktreeLiveState>([
      ['/repo/a', makeLiveState({ branch: 'feature-x', defaultBranch: 'main' })],
      ['/repo/b', makeLiveState({ branch: 'main', defaultBranch: 'main' })],
    ]);

    const report = buildGitWorkspaceReport({
      scope: { kind: 'all' },
      records,
      identities,
      liveStates,
    });

    const rowA = report.rows.find((r) => r.identity.worktreeKey === '/repo/a');
    const rowB = report.rows.find((r) => r.identity.worktreeKey === '/repo/b');
    expect(rowA?.metrics.hasForcePushedToDefaultBranch).toBe(false);
    expect(rowB?.metrics.hasForcePushedToDefaultBranch).toBe(true);
  });
});

describe('buildGitWorkspaceReport — worstBehind', () => {
  it('names the workspace with the highest non-null liveState.behind among all rows', () => {
    const identityA = makeIdentity({ worktreeKey: '/repo/a', worktreeLabel: 'a' });
    const identityB = makeIdentity({ worktreeKey: '/repo/b', worktreeLabel: 'b' });
    const identityC = makeIdentity({ worktreeKey: '/repo/c', worktreeLabel: 'c' });

    const records = [
      gitActivity('git status', '/repo/a', { timestamp: 100 }),
      gitActivity('git status', '/repo/b', { timestamp: 100 }),
      gitActivity('git status', '/repo/c', { timestamp: 100 }),
    ];
    const identities = new Map([
      ['/repo/a', identityA],
      ['/repo/b', identityB],
      ['/repo/c', identityC],
    ]);
    const liveStates = new Map<string, WorktreeLiveState>([
      ['/repo/a', makeLiveState({ behind: 2 })],
      ['/repo/b', makeLiveState({ behind: 15 })],
      ['/repo/c', makeLiveState({ behind: 8 })],
    ]);

    const report = buildGitWorkspaceReport({
      scope: { kind: 'all' },
      records,
      identities,
      liveStates,
    });

    expect(report.worstBehind?.behind).toBe(15);
    expect(report.worstBehind?.identity.worktreeKey).toBe('/repo/b');
  });
});

describe('buildGitWorkspaceReport — empty input', () => {
  it('does not throw and returns zeroed metrics, no rows, no worstBehind', () => {
    const report = buildGitWorkspaceReport({
      scope: { kind: 'all' },
      records: [],
      identities: new Map(),
      liveStates: new Map(),
    });

    expect(report.rows).toEqual([]);
    expect(report.metrics.totalGitCommands).toBe(0);
    expect(report.metrics.efficiencyScore).toBeNull();
    expect(report.metrics.preventionScore).toBeNull();
    expect(report.worstBehind).toBeNull();
  });
});

describe('reconcileHydratedCommits', () => {
  const identityA = makeIdentity({ repoKey: '/repo/a', worktreeKey: 'ws-a' });
  const identityB = makeIdentity({ repoKey: '/repo/b', worktreeKey: 'ws-b' });
  const identities = new Map([
    ['ws-a', identityA],
    ['ws-b', identityB],
  ]);

  it('merges a hydrated commit into a hook commit that ran shortly after it', () => {
    const hook = gitActivity('git commit -m x', 'ws-a', { timestamp: 10_000 });
    const hydrated = hydratedCommitActivity('ws-a', 8_000, 'abc123');

    const result = reconcileHydratedCommits([hook, hydrated], identities);

    expect(result).toHaveLength(1);
    expect(result[0].kind === 'git' && result[0].gitEvent.hash).toBe('abc123');
    // The kept record is the hook's own — it knows the real worktree/session,
    // the hydrated one only ever carries the synthetic git-log session.
    expect(result[0].sessionId).toBe(hook.sessionId);
  });

  it('merges a hydrated commit whose git timestamp is after the hook record (pre-hook start time)', () => {
    const hook = gitActivity('git commit -m x', 'ws-a', { timestamp: 10_000 });
    const hydrated = hydratedCommitActivity('ws-a', 11_000, 'abc123');

    const result = reconcileHydratedCommits([hook, hydrated], identities);

    expect(result).toHaveLength(1);
    expect(result[0].kind === 'git' && result[0].gitEvent.hash).toBe('abc123');
  });

  it('pairs each hook with the nearest hydrated commit when several are in range', () => {
    const hook = gitActivity('git commit -m x', 'ws-a', { timestamp: 10_000 });
    const far = hydratedCommitActivity('ws-a', 40_000, 'far');
    const near = hydratedCommitActivity('ws-a', 12_000, 'near');

    const result = reconcileHydratedCommits([hook, far, near], identities);

    expect(result).toHaveLength(2);
    const merged = result.find((r) => r.sessionId === hook.sessionId);
    expect(merged?.kind === 'git' && merged.gitEvent.hash).toBe('near');
  });

  it('drops a hook commit git log cannot vouch for when git log covers that repo', () => {
    const hook = gitActivity('git commit -m x', 'ws-a', { timestamp: 100_000 });
    const hydrated = hydratedCommitActivity('ws-a', 10_000, 'abc123');
    expect(hook.timestamp - hydrated.timestamp).toBeGreaterThan(COMMIT_RECONCILE_WINDOW_MS);

    const result = reconcileHydratedCommits([hook, hydrated], identities);

    expect(result).toEqual([hydrated]);
  });

  it('keeps an unpaired hook commit in a repo git log does not cover', () => {
    const hook = gitActivity('git commit -m x', 'ws-a', { timestamp: 100_000 });
    const hydratedElsewhere = hydratedCommitActivity('ws-b', 10_000, 'abc123');

    const result = reconcileHydratedCommits([hook, hydratedElsewhere], identities);

    expect(result).toHaveLength(2);
    expect(result).toContain(hook);
  });

  it('passes a failed commit through without letting it consume a hydrated match', () => {
    const failed = gitActivity('git commit -m x', 'ws-a', { timestamp: 9_000, success: false });
    const hook = gitActivity('git commit -m y', 'ws-a', { timestamp: 10_000 });
    const hydrated = hydratedCommitActivity('ws-a', 9_500, 'abc123');

    const result = reconcileHydratedCommits([failed, hook, hydrated], identities);

    expect(result).toHaveLength(2);
    expect(result).toContain(failed);
    const merged = result.find((r) => r !== failed);
    expect(merged?.kind === 'git' && merged.gitEvent.hash).toBe('abc123');
    expect(merged?.sessionId).toBe(hook.sessionId);
  });

  it('pairs a hook commit from a deleted worktree with the hydrated copy from any repo', () => {
    const orphan = gitActivity('git commit -m x', 'gone-worktree', { timestamp: 10_000 });
    const hydrated = hydratedCommitActivity('ws-a', 12_000, 'abc123');

    const result = reconcileHydratedCommits([orphan, hydrated], identities);

    expect(result).toEqual([hydrated]);
  });

  it('keeps a hook commit from a deleted worktree when no hydrated commit is near', () => {
    const orphan = gitActivity('git commit -m x', 'gone-worktree', { timestamp: 10_000 });
    const hydrated = hydratedCommitActivity('ws-a', 500_000, 'abc123');

    const result = reconcileHydratedCommits([orphan, hydrated], identities);

    expect(result).toHaveLength(2);
    expect(result).toContain(orphan);
  });

  it('treats an amend as a rewrite, not a new commit', () => {
    const amend = gitActivity('git commit --amend --no-edit', 'ws-a', { timestamp: 10_000 });
    const hydrated = hydratedCommitActivity('ws-a', 10_500, 'abc123');

    const result = reconcileHydratedCommits([amend, hydrated], identities);

    expect(result).toHaveLength(2);
    expect(result).toContain(amend);
    expect(result).toContain(hydrated);
  });

  it('matches two hooks against two hydrated commits one-to-one', () => {
    const hook1 = gitActivity('git commit -m x', 'ws-a', { timestamp: 10_000 });
    const hook2 = gitActivity('git commit -m y', 'ws-a', { timestamp: 20_000 });
    const hydrated1 = hydratedCommitActivity('ws-a', 9_000, 'hash1');
    const hydrated2 = hydratedCommitActivity('ws-a', 19_000, 'hash2');

    const result = reconcileHydratedCommits([hook1, hook2, hydrated1, hydrated2], identities);
    const commits = result.filter((r) => r.kind === 'git' && r.gitEvent.type === 'commit');

    expect(commits).toHaveLength(2);
    expect(commits.every((r) => r.kind === 'git' && r.gitEvent.hash)).toBe(true);
  });

  it('does not match a hook and a hydrated commit from different repos, even at the same timestamp', () => {
    const hook = gitActivity('git commit -m x', 'ws-a', { timestamp: 10_000 });
    const hydrated = hydratedCommitActivity('ws-b', 10_000, 'abc123');

    const result = reconcileHydratedCommits([hook, hydrated], identities);

    expect(result).toHaveLength(2);
  });

  it('passes an unmatched hydrated commit through unchanged', () => {
    const hydrated = hydratedCommitActivity('ws-a', 10_000, 'abc123');

    const result = reconcileHydratedCommits([hydrated], identities);

    expect(result).toEqual([hydrated]);
  });

  it('passes non-commit records through untouched', () => {
    const edit = editActivity('/a.ts', 'ws-a', 10_000);
    const push = gitActivity('git push', 'ws-a', { timestamp: 10_000 });

    const result = reconcileHydratedCommits([edit, push], identities);

    expect(result).toEqual(expect.arrayContaining([edit, push]));
    expect(result).toHaveLength(2);
  });
});

describe('computeWorkspaceMetrics — git-log hydrated commits', () => {
  it('counts a hydrated-only commit but excludes GIT_LOG_SESSION_ID from sessionIds', () => {
    const identity = makeIdentity();
    const hydrated = hydratedCommitActivity('ws-a', 10_000, 'abc123');
    const edit = editActivity('/a.ts', 'ws-a', 5_000, 'real-session');

    const metrics = computeWorkspaceMetrics([edit, hydrated], identity, null);

    expect(metrics.commitCount).toBe(1);
    expect(metrics.sessionIds).toEqual(['real-session']);
  });
});
