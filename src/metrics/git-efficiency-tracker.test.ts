import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GitEfficiencyTracker,
  parseDefaultBranchFromSymbolicRef,
} from './git-efficiency-tracker.js';
import { gitCommandTargetDir, stripHeredocBodies } from './local-session-aggregator.js';
import type { ToolCallRecord, ReplayTimelineEntry } from '../storage/types.js';

const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
afterAll(() => stderrSpy.mockRestore());

function makeRecord(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
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

describe('parseDefaultBranchFromSymbolicRef()', () => {
  it('strips the remote prefix from a well-formed symbolic-ref short output', () => {
    expect(parseDefaultBranchFromSymbolicRef('origin/main\n', 'origin')).toBe('main');
  });

  it('handles a non-main default branch name', () => {
    expect(parseDefaultBranchFromSymbolicRef('origin/master\n', 'origin')).toBe('master');
  });

  it('handles branch names containing slashes', () => {
    expect(parseDefaultBranchFromSymbolicRef('origin/release/stable\n', 'origin')).toBe(
      'release/stable',
    );
  });

  it('falls back to "main" on empty output', () => {
    expect(parseDefaultBranchFromSymbolicRef('', 'origin')).toBe('main');
  });

  it('falls back to "main" when output does not start with the remote prefix', () => {
    expect(parseDefaultBranchFromSymbolicRef('unexpected-output', 'origin')).toBe('main');
  });
});

describe('GitEfficiencyTracker', () => {
  let tracker: GitEfficiencyTracker;

  beforeEach(() => {
    tracker = new GitEfficiencyTracker();
  });

  it('ignores non-git commands', () => {
    tracker.recordToolCall(makeRecord({ command: 'npm run build' }));
    tracker.recordToolCall(makeRecord({ command: 'ls -la' }));
    const metrics = tracker.getMetrics();
    expect(metrics.totalGitCommands).toBe(0);
  });

  it('counts basic git commands', () => {
    tracker.recordToolCall(makeRecord({ command: 'git status' }));
    tracker.recordToolCall(makeRecord({ command: 'git pull origin main' }));
    tracker.recordToolCall(makeRecord({ command: 'git push origin feature-x' }));
    tracker.recordToolCall(makeRecord({ command: 'git commit -m "fix thing"' }));
    const metrics = tracker.getMetrics();
    expect(metrics.totalGitCommands).toBe(4);
    expect(metrics.pullCount).toBe(1);
    expect(metrics.pushCount).toBe(1);
    expect(metrics.commitCount).toBe(1);
  });

  it('detects merge conflicts from error output', () => {
    tracker.recordToolCall(
      makeRecord({
        command: 'git merge main',
        success: false,
        error: 'CONFLICT (content): Merge conflict in src/file.ts\nAutomatic merge failed',
      }),
    );
    const metrics = tracker.getMetrics();
    expect(metrics.mergeConflicts).toBe(1);
  });

  it('detects force pushes', () => {
    tracker.recordToolCall(makeRecord({ command: 'git push --force origin feature' }));
    tracker.recordToolCall(makeRecord({ command: 'git push -f origin feature' }));
    const metrics = tracker.getMetrics();
    expect(metrics.forcePushes).toBe(2);
  });

  it('distinguishes --force-with-lease from bare --force', () => {
    tracker.recordToolCall(makeRecord({ command: 'git push --force-with-lease origin feature' }));
    tracker.recordToolCall(makeRecord({ command: 'git push --force origin feature' }));
    const metrics = tracker.getMetrics();
    expect(metrics.forcePushes).toBe(2);
    expect(metrics.riskIndicators.usesForceWithLease).toBe(true);
  });

  it('detects hard resets', () => {
    tracker.recordToolCall(makeRecord({ command: 'git reset --hard HEAD~1' }));
    const metrics = tracker.getMetrics();
    expect(metrics.resetHards).toBe(1);
  });

  it('detects discarded changes via checkout -- and restore', () => {
    tracker.recordToolCall(makeRecord({ command: 'git checkout -- src/file.ts' }));
    tracker.recordToolCall(makeRecord({ command: 'git restore src/other.ts' }));
    const metrics = tracker.getMetrics();
    expect(metrics.discardedChanges).toBe(2);
  });

  it('detects branch operations', () => {
    tracker.recordToolCall(makeRecord({ command: 'git branch feature-new' }));
    tracker.recordToolCall(makeRecord({ command: 'git checkout -b another-feature' }));
    tracker.recordToolCall(makeRecord({ command: 'git switch -c third-feature' }));
    const metrics = tracker.getMetrics();
    expect(metrics.branchOperations).toBe(3);
  });

  it('tracks merge abort after conflict', () => {
    const t = Date.now();
    tracker.recordToolCall(
      makeRecord({
        command: 'git merge main',
        timestamp: t,
        success: false,
        error: 'CONFLICT (content): Merge conflict in src/file.ts',
      }),
    );
    tracker.recordToolCall(
      makeRecord({
        command: 'git merge --abort',
        timestamp: t + 5000,
      }),
    );
    const metrics = tracker.getMetrics();
    expect(metrics.abortedOperations).toBe(1);
    expect(metrics.conflictHistory).toHaveLength(1);
    expect(metrics.conflictHistory[0].resolution).toBe('aborted');
    expect(metrics.conflictHistory[0].resolutionTimeMs).toBe(5000);
  });

  it('tracks conflict resolved by commit', () => {
    const t = Date.now();
    tracker.recordToolCall(
      makeRecord({
        command: 'git merge main',
        timestamp: t,
        success: false,
        error: 'CONFLICT (content): Merge conflict in src/file.ts',
      }),
    );
    tracker.recordToolCall(
      makeRecord({
        command: 'git commit -m "resolve conflicts"',
        timestamp: t + 10000,
      }),
    );
    const metrics = tracker.getMetrics();
    expect(metrics.conflictHistory).toHaveLength(1);
    expect(metrics.conflictHistory[0].resolution).toBe('resolved');
    expect(metrics.conflictHistory[0].resolutionTimeMs).toBe(10000);
    expect(metrics.conflictResolutionRate).toBe(1);
  });

  // this.events is only ever .push()'d, in whatever order
  // recordToolCall is invoked — not necessarily ascending timestamp order.
  // Two realistic causes: parallel tool calls within a session (a
  // later-started, earlier-finishing command lands first) or multi-session
  // buffer draining. GitEfficiency.tsx's "Recent Git Activity" does
  // `[...gitCommandTimeline].reverse().slice(0, 30)`, which only picks the
  // true newest 30 if the source is already ascending.
  it('sorts gitCommandTimeline by timestamp ascending regardless of push order', () => {
    tracker.recordToolCall(makeRecord({ command: 'git status', timestamp: 300 }));
    tracker.recordToolCall(makeRecord({ command: 'git status', timestamp: 100 }));
    tracker.recordToolCall(makeRecord({ command: 'git status', timestamp: 200 }));
    const metrics = tracker.getMetrics();
    // Unsorted, this would equal [300, 100, 200] — raw push order — so
    // .reverse().slice(0, N) on the frontend would silently pick the wrong
    // window instead of the true newest N.
    expect(metrics.gitCommandTimeline.map((e) => e.timestamp)).toEqual([100, 200, 300]);
  });

  it('sorts conflictHistory by timestamp ascending when conflict sequences interleave out of order', () => {
    // Conflict B (timestamp 100) is processed AFTER conflict A (timestamp
    // 200) — e.g. two concurrent sessions whose buffers were drained in an
    // order that doesn't match wall-clock order.
    tracker.recordToolCall(
      makeRecord({
        command: 'git merge main',
        timestamp: 200,
        success: false,
        error: 'CONFLICT (content): Merge conflict in src/a.ts',
      }),
    );
    tracker.recordToolCall(makeRecord({ command: 'git commit -m "resolve a"', timestamp: 250 }));
    tracker.recordToolCall(
      makeRecord({
        command: 'git merge main',
        timestamp: 100,
        success: false,
        error: 'CONFLICT (content): Merge conflict in src/b.ts',
      }),
    );
    tracker.recordToolCall(makeRecord({ command: 'git commit -m "resolve b"', timestamp: 150 }));
    const metrics = tracker.getMetrics();
    // Unsorted, this would equal [200, 100] — raw push order.
    expect(metrics.conflictHistory.map((c) => c.timestamp)).toEqual([100, 200]);
  });

  it('extracts conflicted file paths', () => {
    tracker.recordToolCall(
      makeRecord({
        command: 'git merge main',
        success: false,
        error:
          'CONFLICT (content): Merge conflict in src/a.ts\n' +
          'CONFLICT (content): Merge conflict in src/b.ts\n' +
          'Automatic merge failed',
      }),
    );
    tracker.recordToolCall(makeRecord({ command: 'git commit -m "resolve"' }));
    const metrics = tracker.getMetrics();
    expect(metrics.conflictHistory[0].files).toContain('src/a.ts');
    expect(metrics.conflictHistory[0].files).toContain('src/b.ts');
  });

  it('detects stale branch pulls (pull -> immediate conflict)', () => {
    const t = Date.now();
    tracker.recordToolCall(makeRecord({ command: 'git pull origin main', timestamp: t }));
    tracker.recordToolCall(
      makeRecord({
        command: 'git merge main',
        timestamp: t + 100,
        success: false,
        error: 'CONFLICT (content): Merge conflict in foo.ts',
      }),
    );
    tracker.recordToolCall(makeRecord({ command: 'git pull origin main', timestamp: t + 5000 }));
    tracker.recordToolCall(
      makeRecord({
        command: 'git rebase main',
        timestamp: t + 5100,
        success: false,
        error: 'rebase conflict could not apply patch',
      }),
    );
    const metrics = tracker.getMetrics();
    expect(metrics.staleBranchPulls).toBe(2);
  });

  // A `git pull` whose own output contains a conflict indicator classifies
  // as merge_conflict/rebase_conflict, never as 'pull' — so the common case
  // (a pull that directly conflicts)
  // must be detected off that single event's own command, not only via the
  // adjacent-event pattern (which is preserved below for the separate,
  // rarer case of a clean pull followed by an unrelated conflicting command).
  it('detects a pull that directly conflicts, not just a pull followed by a separate conflicting command', () => {
    tracker.recordToolCall(
      makeRecord({
        command: 'git pull origin main',
        success: false,
        error: 'CONFLICT (content): Merge conflict in foo.ts',
      }),
    );
    const metrics = tracker.getMetrics();
    expect(metrics.staleBranchPulls).toBe(1);
  });

  describe('pending conflicts', () => {
    it('includes an open, unresolved conflict in the resolution-rate denominator as "pending"', () => {
      tracker.recordToolCall(
        makeRecord({
          command: 'git merge main',
          success: false,
          error: 'CONFLICT (content): Merge conflict in a.ts',
        }),
      );
      const metrics = tracker.getMetrics();
      // Without counting the open conflict, conflictRecords would be empty
      // (nothing has aborted or resolved yet) and the rate would show null
      // rather than reflecting that a real conflict is unresolved.
      expect(metrics.conflictResolutionRate).toBe(0);
      const pendingEntry = metrics.conflictHistory.find((c) => c.resolution === 'pending');
      expect(pendingEntry).toBeDefined();
    });

    it('reflects a mix of one resolved and one still-open conflict as a 50% resolution rate, not 100%', () => {
      const t = Date.now();
      tracker.recordToolCall(
        makeRecord({
          command: 'git merge main',
          timestamp: t,
          success: false,
          error: 'CONFLICT (content): Merge conflict in a.ts',
        }),
      );
      tracker.recordToolCall(
        makeRecord({ command: 'git commit -m "resolve a"', timestamp: t + 1000 }),
      );
      tracker.recordToolCall(
        makeRecord({
          command: 'git rebase main',
          timestamp: t + 2000,
          success: false,
          error: 'rebase conflict could not apply patch',
        }),
      );
      const metrics = tracker.getMetrics();
      expect(metrics.conflictResolutionRate).toBe(0.5);
    });

    // A second conflict arriving while one is already pending must be
    // queued, not silently overwrite the first — both must eventually
    // resolve independently, in the order they arose.
    it('queues a second conflict arriving while one is already pending, instead of overwriting the first', () => {
      const t = Date.now();
      tracker.recordToolCall(
        makeRecord({
          command: 'git merge main',
          timestamp: t,
          success: false,
          error: 'CONFLICT (content): Merge conflict in a.ts',
        }),
      );
      tracker.recordToolCall(
        makeRecord({
          command: 'git rebase main',
          timestamp: t + 1000,
          success: false,
          error: 'rebase conflict could not apply patch',
        }),
      );
      // Both still open at this point.
      let metrics = tracker.getMetrics();
      expect(metrics.conflictHistory.filter((c) => c.resolution === 'pending')).toHaveLength(2);

      // Resolving in FIFO order: the first (a.ts) conflict resolves first.
      tracker.recordToolCall(
        makeRecord({ command: 'git commit -m "resolve a"', timestamp: t + 2000 }),
      );
      metrics = tracker.getMetrics();
      expect(metrics.conflictHistory.filter((c) => c.resolution === 'resolved')).toHaveLength(1);
      expect(metrics.conflictHistory.filter((c) => c.resolution === 'pending')).toHaveLength(1);

      // The second conflict resolves next — it was queued, not dropped.
      tracker.recordToolCall(
        makeRecord({ command: 'git commit -m "resolve b"', timestamp: t + 3000 }),
      );
      metrics = tracker.getMetrics();
      expect(metrics.conflictHistory.filter((c) => c.resolution === 'resolved')).toHaveLength(2);
      expect(metrics.conflictResolutionRate).toBe(1);
    });
  });

  it('detects worktree usage', () => {
    tracker.recordToolCall(makeRecord({ command: 'git worktree add ../feature-x feature-x' }));
    const metrics = tracker.getMetrics();
    expect(metrics.riskIndicators.usesWorktrees).toBe(true);
  });

  it('does not count read-only worktree inspection (e.g. "list") toward the worktree-ops counter', () => {
    tracker.recordToolCall(makeRecord({ command: 'git worktree list' }));
    tracker.recordToolCall(makeRecord({ command: 'git worktree list' }));
    const metrics = tracker.getMetrics();
    expect(metrics.velocityMetrics.worktreeCount).toBe(0);
  });

  it('counts only "add"/"remove" worktree subcommands toward the worktree-ops counter', () => {
    tracker.recordToolCall(makeRecord({ command: 'git worktree add ../feature-x feature-x' }));
    tracker.recordToolCall(makeRecord({ command: 'git worktree remove ../feature-x' }));
    tracker.recordToolCall(makeRecord({ command: 'git worktree list' }));
    const metrics = tracker.getMetrics();
    expect(metrics.velocityMetrics.worktreeCount).toBe(2);
  });

  it('detects push rejections', () => {
    tracker.recordToolCall(
      makeRecord({
        command: 'git push origin feature',
        success: false,
        error: 'Updates were rejected because the remote contains work that you do not have',
      }),
    );
    const metrics = tracker.getMetrics();
    expect(metrics.riskIndicators.pushRejections).toBe(1);
  });

  describe('risk indicators', () => {
    it('detects no sync before editing', () => {
      const t = Date.now();
      // Edit first without syncing
      tracker.recordToolCall(makeRecord({ toolName: 'Edit', filePath: 'src/a.ts', timestamp: t }));
      tracker.recordToolCall(makeRecord({ command: 'git pull origin main', timestamp: t + 5000 }));
      const metrics = tracker.getMetrics();
      expect(metrics.riskIndicators.syncedBeforeEditing).toBe(false);
    });

    it('detects sync before editing', () => {
      const t = Date.now();
      tracker.recordToolCall(makeRecord({ command: 'git pull origin main', timestamp: t }));
      tracker.recordToolCall(
        makeRecord({ toolName: 'Edit', filePath: 'src/a.ts', timestamp: t + 1000 }),
      );
      const metrics = tracker.getMetrics();
      expect(metrics.riskIndicators.syncedBeforeEditing).toBe(true);
    });

    it('tracks commits since last sync', () => {
      tracker.recordToolCall(makeRecord({ command: 'git pull origin main' }));
      tracker.recordToolCall(makeRecord({ command: 'git commit -m "a"' }));
      tracker.recordToolCall(makeRecord({ command: 'git commit -m "b"' }));
      tracker.recordToolCall(makeRecord({ command: 'git commit -m "c"' }));
      const metrics = tracker.getMetrics();
      expect(metrics.riskIndicators.commitsSinceLastSync).toBe(3);
    });

    it('detects force-push-after-rejection pattern', () => {
      const t = Date.now();
      tracker.recordToolCall(
        makeRecord({
          command: 'git push origin feature',
          timestamp: t,
          success: false,
          error: '[rejected] non-fast-forward',
        }),
      );
      tracker.recordToolCall(
        makeRecord({
          command: 'git push --force origin feature',
          timestamp: t + 30_000,
        }),
      );
      const metrics = tracker.getMetrics();
      expect(metrics.riskIndicators.forceAfterReject).toBe(1);
    });

    it('tracks hot files (conflicted then re-edited)', () => {
      tracker.recordToolCall(
        makeRecord({
          command: 'git merge main',
          success: false,
          error: 'CONFLICT (content): Merge conflict in src/hot.ts',
        }),
      );
      tracker.recordToolCall(makeRecord({ command: 'git commit -m "resolve"' }));
      // Now edit the same file
      tracker.recordToolCall(makeRecord({ toolName: 'Edit', filePath: 'src/hot.ts' }));
      const metrics = tracker.getMetrics();
      expect(metrics.riskIndicators.hotFiles).toContain('src/hot.ts');
    });
  });

  describe('best practices', () => {
    it('passes sync_before_edit when pull comes first', () => {
      const t = Date.now();
      tracker.recordToolCall(makeRecord({ command: 'git fetch origin', timestamp: t }));
      tracker.recordToolCall(
        makeRecord({ toolName: 'Edit', filePath: 'src/a.ts', timestamp: t + 500 }),
      );
      const metrics = tracker.getMetrics();
      const practice = metrics.bestPractices.find((p) => p.id === 'sync_before_edit');
      expect(practice?.status).toBe('pass');
    });

    it('fails sync_before_edit when edit comes first', () => {
      const t = Date.now();
      tracker.recordToolCall(makeRecord({ toolName: 'Edit', filePath: 'src/a.ts', timestamp: t }));
      tracker.recordToolCall(makeRecord({ command: 'git pull origin main', timestamp: t + 1000 }));
      const metrics = tracker.getMetrics();
      const practice = metrics.bestPractices.find((p) => p.id === 'sync_before_edit');
      expect(practice?.status).toBe('fail');
    });

    it('warns about too many commits without sync', () => {
      tracker.recordToolCall(makeRecord({ command: 'git pull origin main' }));
      for (let i = 0; i < 9; i++) {
        tracker.recordToolCall(makeRecord({ command: `git commit -m "change ${i}"` }));
      }
      const metrics = tracker.getMetrics();
      const practice = metrics.bestPractices.find((p) => p.id === 'frequent_sync');
      expect(practice?.status).toBe('fail');
    });

    it('recommends worktrees when conflicts occur without them', () => {
      tracker.recordToolCall(
        makeRecord({
          command: 'git merge main',
          success: false,
          error: 'CONFLICT (content): Merge conflict in x.ts',
        }),
      );
      const metrics = tracker.getMetrics();
      const practice = metrics.bestPractices.find((p) => p.id === 'use_worktrees');
      expect(practice?.status).toBe('fail');
    });

    it('does not treat read-only worktree inspection as real worktree usage in the use_worktrees check', () => {
      tracker.recordToolCall(makeRecord({ command: 'git worktree list' }));
      const metrics = tracker.getMetrics();
      expect(metrics.velocityMetrics.worktreeCount).toBe(0);
      expect(metrics.riskIndicators.usesWorktrees).toBe(false);
      const practice = metrics.bestPractices.find((p) => p.id === 'use_worktrees');
      expect(practice?.status).not.toBe('pass');
      expect(practice?.status).toBe('unknown');
    });

    // A session with enough activity to judge (3+ commits), no conflicts,
    // and no worktree usage genuinely doesn't need worktrees — this is a
    // known, non-violating outcome ('n/a'), distinct from the
    // insufficient-data 'unknown' case above (which fires below the
    // commitCount threshold).
    it('marks use_worktrees as n/a (not unknown) once there is enough activity to judge and no conflicts occurred', () => {
      for (let i = 0; i < 3; i++) {
        tracker.recordToolCall(makeRecord({ command: `git commit -m "c${i}"` }));
      }
      const metrics = tracker.getMetrics();
      const practice = metrics.bestPractices.find((p) => p.id === 'use_worktrees');
      expect(practice?.status).toBe('n/a');
    });

    it('fails force_with_lease check when bare --force is used', () => {
      tracker.recordToolCall(makeRecord({ command: 'git push --force origin feature' }));
      const metrics = tracker.getMetrics();
      const practice = metrics.bestPractices.find((p) => p.id === 'force_with_lease');
      expect(practice?.status).toBe('fail');
    });

    it('passes force_with_lease check when --force-with-lease is used', () => {
      tracker.recordToolCall(makeRecord({ command: 'git push --force-with-lease origin feature' }));
      const metrics = tracker.getMetrics();
      const practice = metrics.bestPractices.find((p) => p.id === 'force_with_lease');
      expect(practice?.status).toBe('pass');
    });

    // A bare --force push is the riskiest single operation this tracker
    // tracks. The check must catch it even when a later, safe
    // --force-with-lease push also occurred in the same session — checking
    // only whether lease was ever used would let the safe push mask the
    // unsafe one with a "pass".
    it('warns (not passes) force_with_lease check when a bare --force push is mixed with a later --force-with-lease push', () => {
      tracker.recordToolCall(makeRecord({ command: 'git push --force origin feature' }));
      tracker.recordToolCall(makeRecord({ command: 'git push --force-with-lease origin feature' }));
      const metrics = tracker.getMetrics();
      const practice = metrics.bestPractices.find((p) => p.id === 'force_with_lease');
      expect(practice?.status).toBe('warn');
    });
  });

  describe('suggestions', () => {
    it('warns about frequent merge conflicts with prevention advice', () => {
      for (let i = 0; i < 3; i++) {
        tracker.recordToolCall(
          makeRecord({
            command: 'git merge main',
            success: false,
            error: 'CONFLICT (content): Merge conflict in file.ts',
          }),
        );
      }
      const metrics = tracker.getMetrics();
      const conflictSuggestion = metrics.suggestions.find((s) => s.category === 'merge_conflicts');
      expect(conflictSuggestion).toBeDefined();
      expect(conflictSuggestion!.severity).toBe('critical');
      expect(conflictSuggestion!.message).toContain('worktrees');
    });

    // syncedBeforeEditing is surfaced solely by the sync_before_edit best
    // practice; it must not also fire as a 'no_initial_sync' suggestion,
    // which would render the identical fact twice.
    it('does not duplicate "no initial sync" as a suggestion — it is a Best Practices condition', () => {
      const t = Date.now();
      tracker.recordToolCall(makeRecord({ toolName: 'Edit', filePath: 'src/a.ts', timestamp: t }));
      // Need a git command for suggestions to fire
      tracker.recordToolCall(makeRecord({ command: 'git status', timestamp: t + 100 }));
      const metrics = tracker.getMetrics();
      expect(metrics.suggestions.find((s) => s.category === 'no_initial_sync')).toBeUndefined();
      const practice = metrics.bestPractices.find((p) => p.id === 'sync_before_edit');
      expect(practice?.status).toBe('fail');
    });

    // commitsSinceLastSync > 8 is surfaced solely by the frequent_sync
    // best practice; it must not also fire as a 'drift_risk' suggestion,
    // which would render the identical fact twice.
    it('does not duplicate "drift risk" as a suggestion — it is a Best Practices condition', () => {
      tracker.recordToolCall(makeRecord({ command: 'git pull origin main' }));
      for (let i = 0; i < 12; i++) {
        tracker.recordToolCall(makeRecord({ command: `git commit -m "c${i}"` }));
      }
      const metrics = tracker.getMetrics();
      expect(metrics.suggestions.find((s) => s.category === 'drift_risk')).toBeUndefined();
      const practice = metrics.bestPractices.find((p) => p.id === 'frequent_sync');
      expect(practice?.status).toBe('fail');
    });

    // hotFiles is surfaced solely by the avoid_hot_files best practice; it
    // must not also fire as a 'hot_files' suggestion with a different
    // severity for the identical trigger.
    it('does not duplicate "hot files" as a suggestion — it is a Best Practices condition', () => {
      tracker.recordToolCall(
        makeRecord({
          command: 'git merge main',
          success: false,
          error: 'CONFLICT (content): Merge conflict in src/hot.ts',
        }),
      );
      tracker.recordToolCall(makeRecord({ command: 'git commit -m "resolve"' }));
      tracker.recordToolCall(makeRecord({ toolName: 'Edit', filePath: 'src/hot.ts' }));
      const metrics = tracker.getMetrics();
      expect(metrics.suggestions.find((s) => s.category === 'hot_files')).toBeUndefined();
      const practice = metrics.bestPractices.find((p) => p.id === 'avoid_hot_files');
      expect(practice?.status).toBe('warn');
    });

    it('flags force-push-after-rejection pattern', () => {
      const t = Date.now();
      tracker.recordToolCall(
        makeRecord({
          command: 'git push origin feature',
          timestamp: t,
          success: false,
          error: 'Updates were rejected because the remote contains work',
        }),
      );
      tracker.recordToolCall(
        makeRecord({ command: 'git push --force origin feature', timestamp: t + 10_000 }),
      );
      const metrics = tracker.getMetrics();
      const suggestion = metrics.suggestions.find((s) => s.category === 'force_after_reject');
      expect(suggestion).toBeDefined();
      expect(suggestion!.severity).toBe('critical');
    });

    it('suggests pulling when no pulls detected in busy session', () => {
      for (let i = 0; i < 11; i++) {
        tracker.recordToolCall(makeRecord({ command: 'git status' }));
      }
      const metrics = tracker.getMetrics();
      const syncSuggestion = metrics.suggestions.find((s) => s.category === 'sync_frequency');
      expect(syncSuggestion).toBeDefined();
      expect(syncSuggestion!.severity).toBe('info');
    });

    // A single bare --force push is the riskiest single operation this
    // tracker tracks, so its severity must never rate as the mildest tier
    // ('info') — severity has to account for whether the push was actually
    // safe, not just how many force pushes occurred.
    it('elevates a single bare --force push suggestion above info severity', () => {
      tracker.recordToolCall(makeRecord({ command: 'git push --force origin feature' }));
      const metrics = tracker.getMetrics();
      const suggestion = metrics.suggestions.find((s) => s.category === 'force_push');
      expect(suggestion).toBeDefined();
      expect(suggestion!.severity).not.toBe('info');
    });

    // The force_push suggestion's severity must agree with the
    // force_with_lease best-practice check on which of these two sessions is
    // riskier: adding a safe --force-with-lease push on top of an existing
    // bare push must never raise severity above what the bare push alone
    // already set, since only the bare push is actually unsafe.
    it('does not escalate force_push suggestion severity when a safe --force-with-lease push follows a bare push', () => {
      const bareOnly = new GitEfficiencyTracker();
      bareOnly.recordToolCall(makeRecord({ command: 'git push --force origin feature' }));
      const bareOnlySuggestion = bareOnly
        .getMetrics()
        .suggestions.find((s) => s.category === 'force_push');
      expect(bareOnlySuggestion?.severity).toBe('warning');

      const bareThenLease = new GitEfficiencyTracker();
      bareThenLease.recordToolCall(makeRecord({ command: 'git push --force origin feature' }));
      bareThenLease.recordToolCall(
        makeRecord({ command: 'git push --force-with-lease origin feature' }),
      );
      const bareThenLeaseSuggestion = bareThenLease
        .getMetrics()
        .suggestions.find((s) => s.category === 'force_push');
      expect(bareThenLeaseSuggestion?.severity).toBe('warning');
    });

    // Two safe, lease-protected force pushes must never rate worse than the
    // single unsafe bare push case above — and must never surface advice to
    // "always use --force-with-lease" when the user is already doing
    // exactly that.
    it('does not fire a force_push suggestion for a single lease-protected push with no bare push present', () => {
      tracker.recordToolCall(makeRecord({ command: 'git push --force-with-lease origin feature' }));
      const metrics = tracker.getMetrics();
      expect(metrics.suggestions.find((s) => s.category === 'force_push')).toBeUndefined();
    });

    it('rates repeated lease-protected force pushes as info, not critical, when no bare push occurred', () => {
      tracker.recordToolCall(makeRecord({ command: 'git push --force-with-lease origin feature' }));
      tracker.recordToolCall(makeRecord({ command: 'git push --force-with-lease origin feature' }));
      const metrics = tracker.getMetrics();
      const suggestion = metrics.suggestions.find((s) => s.category === 'force_push');
      expect(suggestion?.severity).toBe('info');
    });

    // Force-push severity must be branch-aware: a bare --force push to the
    // shared default branch is categorically more dangerous (it can clobber
    // other collaborators' work) than an identical bare --force push to a
    // branch only one person is using, so the two must not produce the same
    // severity.
    it('escalates a bare force push on the default branch above an identical push on a feature branch', () => {
      const onDefaultBranch = new GitEfficiencyTracker();
      onDefaultBranch.hydrateRepoContext({
        repoName: 'org/repo',
        branch: 'main',
        remoteName: 'origin',
        defaultBranch: 'main',
      });
      onDefaultBranch.recordToolCall(makeRecord({ command: 'git push --force origin main' }));

      const onFeatureBranch = new GitEfficiencyTracker();
      onFeatureBranch.hydrateRepoContext({
        repoName: 'org/repo',
        branch: 'feature-x',
        remoteName: 'origin',
        defaultBranch: 'main',
      });
      onFeatureBranch.recordToolCall(makeRecord({ command: 'git push --force origin feature-x' }));

      const defaultBranchSuggestion = onDefaultBranch
        .getMetrics()
        .suggestions.find((s) => s.category === 'force_push');
      const featureBranchSuggestion = onFeatureBranch
        .getMetrics()
        .suggestions.find((s) => s.category === 'force_push');

      expect(defaultBranchSuggestion?.severity).toBe('critical');
      expect(featureBranchSuggestion?.severity).toBe('warning');
    });
  });

  describe('severity sort order', () => {
    it('sorts suggestions by severity — critical before warning before info, even when a lower-severity item is pushed first in source order', () => {
      // discarded_changes (info) and sync_frequency (info) are both pushed,
      // in generateSuggestions' fixed source-code order, before
      // divergence_risk (warning) — the output must be sorted by severity
      // rather than relying on source-code order, or both info items would
      // land ahead of the warning.
      for (let i = 0; i < 3; i++) {
        tracker.recordToolCall(makeRecord({ command: 'git checkout -- src/file.ts' }));
      }
      for (let i = 0; i < 11; i++) {
        tracker.recordToolCall(makeRecord({ command: `git commit -m "c${i}"` }));
      }
      const metrics = tracker.getMetrics();
      const categories = metrics.suggestions.map((s) => s.category);
      expect(categories).toEqual(
        expect.arrayContaining(['discarded_changes', 'sync_frequency', 'divergence_risk']),
      );
      const severities = metrics.suggestions.map((s) => s.severity);
      const rank: Record<string, number> = { critical: 0, warning: 1, info: 2 };
      const sortedRanks = severities.map((s) => rank[s]);
      expect(sortedRanks).toEqual([...sortedRanks].sort((a, b) => a - b));
      expect(metrics.suggestions[0]?.category).toBe('divergence_risk');
    });

    it('sorts the failing/warning bestPractices subset — fail before warn, even when warn is pushed first in source order', () => {
      // frequent_sync (check #2, 'warn' here) is pushed before use_worktrees
      // (check #4, 'fail' here) in evaluateBestPractices' fixed source-code
      // order — the failing/warning subset must be sorted by status rather
      // than relying on source-code order, or the 'warn' would land first.
      tracker.recordToolCall(makeRecord({ command: 'git pull origin main' }));
      for (let i = 0; i < 6; i++) {
        tracker.recordToolCall(makeRecord({ command: `git commit -m "c${i}"` }));
      }
      tracker.recordToolCall(
        makeRecord({
          command: 'git merge main',
          success: false,
          error: 'CONFLICT (content): Merge conflict in file.ts',
        }),
      );
      const metrics = tracker.getMetrics();
      const frequentSync = metrics.bestPractices.find((p) => p.id === 'frequent_sync');
      const useWorktrees = metrics.bestPractices.find((p) => p.id === 'use_worktrees');
      expect(frequentSync?.status).toBe('warn');
      expect(useWorktrees?.status).toBe('fail');

      const relevant = metrics.bestPractices.filter(
        (p) => p.status === 'fail' || p.status === 'warn',
      );
      expect(relevant[0]?.id).toBe('use_worktrees');
      expect(relevant[1]?.id).toBe('frequent_sync');
    });
  });

  describe('prevention score', () => {
    it('returns null with insufficient data', () => {
      tracker.recordToolCall(makeRecord({ command: 'git status' }));
      expect(tracker.getMetrics().preventionScore).toBeNull();
    });

    it('returns 100 when all practices pass', () => {
      const t = Date.now();
      // Sync before editing
      tracker.recordToolCall(makeRecord({ command: 'git fetch origin', timestamp: t }));
      tracker.recordToolCall(
        makeRecord({ toolName: 'Edit', filePath: 'src/a.ts', timestamp: t + 100 }),
      );
      // Make commits with good sync cadence
      tracker.recordToolCall(makeRecord({ command: 'git commit -m "a"', timestamp: t + 200 }));
      tracker.recordToolCall(makeRecord({ command: 'git commit -m "b"', timestamp: t + 300 }));
      tracker.recordToolCall(makeRecord({ command: 'git commit -m "c"', timestamp: t + 400 }));
      tracker.recordToolCall(makeRecord({ command: 'git rebase origin/main', timestamp: t + 500 }));
      // Use worktree
      tracker.recordToolCall(
        makeRecord({ command: 'git worktree add ../fix fix', timestamp: t + 600 }),
      );
      const metrics = tracker.getMetrics();
      expect(metrics.preventionScore).toBe(100);
    });

    // use_worktrees resolving to 'n/a' (no conflicts, no worktree, enough
    // activity to judge) must not drag the score down — it's excluded from
    // the ratio the same way a genuinely-'unknown' check already is.
    it('excludes an n/a use_worktrees check from the score, same as it excludes unknown checks', () => {
      const t = Date.now();
      tracker.recordToolCall(makeRecord({ command: 'git fetch origin', timestamp: t }));
      tracker.recordToolCall(
        makeRecord({ toolName: 'Edit', filePath: 'src/a.ts', timestamp: t + 100 }),
      );
      tracker.recordToolCall(makeRecord({ command: 'git commit -m "a"', timestamp: t + 200 }));
      tracker.recordToolCall(makeRecord({ command: 'git commit -m "b"', timestamp: t + 300 }));
      tracker.recordToolCall(makeRecord({ command: 'git commit -m "c"', timestamp: t + 400 }));
      tracker.recordToolCall(makeRecord({ command: 'git rebase origin/main', timestamp: t + 500 }));
      // No worktree usage, no conflicts.
      const metrics = tracker.getMetrics();
      const useWorktrees = metrics.bestPractices.find((p) => p.id === 'use_worktrees');
      expect(useWorktrees?.status).toBe('n/a');
      expect(metrics.preventionScore).toBe(100);
    });
  });

  describe('efficiency score', () => {
    it('returns null when too few git commands', () => {
      tracker.recordToolCall(makeRecord({ command: 'git status' }));
      tracker.recordToolCall(makeRecord({ command: 'git log' }));
      expect(tracker.getMetrics().efficiencyScore).toBeNull();
    });

    it('returns 100 for clean session', () => {
      for (let i = 0; i < 5; i++) {
        tracker.recordToolCall(makeRecord({ command: 'git commit -m "change"' }));
      }
      expect(tracker.getMetrics().efficiencyScore).toBe(100);
    });

    it('penalizes conflicts and force pushes', () => {
      tracker.recordToolCall(makeRecord({ command: 'git commit -m "a"' }));
      tracker.recordToolCall(makeRecord({ command: 'git commit -m "b"' }));
      tracker.recordToolCall(makeRecord({ command: 'git commit -m "c"' }));
      tracker.recordToolCall(
        makeRecord({
          command: 'git merge main',
          success: false,
          error: 'CONFLICT (content): Merge conflict in file.ts',
        }),
      );
      tracker.recordToolCall(makeRecord({ command: 'git push --force origin feature' }));
      const metrics = tracker.getMetrics();
      expect(metrics.efficiencyScore).toBeLessThan(100);
      expect(metrics.efficiencyScore).toBeGreaterThan(0);
    });
  });

  it('resets all state', () => {
    tracker.recordToolCall(
      makeRecord({
        command: 'git merge main',
        success: false,
        error: 'CONFLICT (content): Merge conflict',
      }),
    );
    tracker.recordToolCall(makeRecord({ command: 'git push --force origin x' }));
    tracker.reset('sess-2');
    const metrics = tracker.getMetrics();
    expect(metrics.totalGitCommands).toBe(0);
    expect(metrics.mergeConflicts).toBe(0);
    expect(metrics.forcePushes).toBe(0);
    expect(metrics.conflictHistory).toHaveLength(0);
    expect(metrics.suggestions).toHaveLength(0);
    // Best practices always show baseline entries (with status 'unknown')
    expect(metrics.bestPractices.every((bp) => bp.status === 'unknown')).toBe(true);
    expect(metrics.riskIndicators.syncedBeforeEditing).toBeNull();
  });

  // Without a day-boundary reset, GitEfficiencyTracker never resets, so in
  // --local mode (a persistent, multi-day dashboard daemon) "Today's
  // activity across all sessions" would silently become an unbounded
  // all-time counter. The actual day-boundary trigger lives in
  // src/index.ts's onRecord handler (calls reset() then re-hydrates
  // repoContext/branch-divergence from what was captured at startup, once
  // localDateKey() changes) — not unit-testable from this file. This test
  // instead verifies the composability that depends on: reset() must clear
  // the day's accumulated activity while leaving room for the caller to
  // immediately re-hydrate the repo identity (which isn't "today's
  // activity" and has no periodic refresh of its own), so a day-boundary
  // reset doesn't also make the "Repos Today" pills lose their repoName.
  it('a day-boundary reset followed by re-hydration clears activity but the repo identity can be restored', () => {
    tracker.hydrateRepoContext({
      repoName: 'org/repo',
      branch: 'main',
      remoteName: 'origin',
      defaultBranch: 'main',
    });
    tracker.recordToolCall(makeRecord({ command: 'git commit -m "a"' }));
    tracker.recordToolCall(makeRecord({ command: 'git commit -m "b"' }));
    expect(tracker.getMetrics().commitCount).toBe(2);
    expect(tracker.getMetrics().repoContext.repoName).toBe('org/repo');

    // Simulate the day-boundary reset+re-hydrate sequence performed in
    // src/index.ts's onRecord handler when localDateKey() changes.
    tracker.reset('next-session');
    tracker.hydrateRepoContext({
      repoName: 'org/repo',
      branch: 'main',
      remoteName: 'origin',
      defaultBranch: 'main',
    });

    const metrics = tracker.getMetrics();
    // Yesterday's commits don't leak into today's count.
    expect(metrics.commitCount).toBe(0);
    // But the repo identity survives, because the caller re-hydrated it
    // immediately after reset() — it isn't "today's activity" and has no
    // other refresh path once the process is running.
    expect(metrics.repoContext.repoName).toBe('org/repo');
  });

  // Follow-up to the test above: src/index.ts's day-boundary handler now also
  // re-runs `git log --since=<new local midnight>` (mirroring the startup
  // hydration) and feeds the result through hydrateGitLog() right after
  // reset(), so commits Claude Code makes internally — which never reach
  // recordToolCall() via tool hooks (see the comment on the startup
  // hydration in src/index.ts) — still count toward "today's commits" on
  // day 2+ of a long-lived --local daemon, instead of only ever seeing
  // hook-observed commits made after the reset.
  it('a day-boundary reset followed by hydrateGitLog() recovers commits made outside tool hooks', () => {
    tracker.recordToolCall(makeRecord({ command: 'git commit -m "a"' }));
    expect(tracker.getMetrics().commitCount).toBe(1);

    tracker.reset('next-session');
    expect(tracker.getMetrics().commitCount).toBe(0);

    // Simulates src/index.ts feeding the day-scoped `git log` output
    // (commits not captured by tool hooks) back into the tracker right
    // after the reset.
    const hydratedAt = Date.now();
    tracker.hydrateGitLog([
      { hash: 'abc123', timestamp: hydratedAt },
      { hash: 'def456', timestamp: hydratedAt + 1_000 },
    ]);

    expect(tracker.getMetrics().commitCount).toBe(2);
  });

  // A drain batch can hold hook-observed records for commits that already
  // landed by the time the day-boundary `git log` snapshot ran — that
  // snapshot's hydrateGitLog() call sees them too. Without a way to tell
  // "this hook event is the same commit `git log` already vouched for" from
  // "this is a genuinely new commit," recordToolCall() would double-count.
  it('does not double-count a hook-observed commit whose timestamp hydrateGitLog() already covered', () => {
    const hydratedAt = Date.now();
    tracker.hydrateGitLog([{ hash: 'abc123', timestamp: hydratedAt }]);
    expect(tracker.getMetrics().commitCount).toBe(1);

    // The buffered hook event for that same commit, still queued from before
    // the day-boundary flip, now gets processed — its timestamp is at or
    // before what git log already covered.
    tracker.recordToolCall(makeRecord({ command: 'git commit -m "a"', timestamp: hydratedAt }));
    expect(tracker.getMetrics().commitCount).toBe(1);

    // A genuinely new commit made after the hydration snapshot still counts.
    tracker.recordToolCall(
      makeRecord({ command: 'git commit -m "b"', timestamp: hydratedAt + 5_000 }),
    );
    expect(tracker.getMetrics().commitCount).toBe(2);
  });

  describe('replayTimeline', () => {
    it('hydrates tracker from prior session timeline entries', () => {
      const t = Date.now() - 3600_000;
      const timeline: ReplayTimelineEntry[] = [
        {
          timestamp: t,
          toolName: 'Bash',
          durationMs: 50,
          success: true,
          command: 'git pull origin main',
        },
        {
          timestamp: t + 1000,
          toolName: 'Bash',
          durationMs: 100,
          success: true,
          command: 'git commit -m "first"',
        },
        {
          timestamp: t + 2000,
          toolName: 'Bash',
          durationMs: 100,
          success: true,
          command: 'git commit -m "second"',
        },
        {
          timestamp: t + 3000,
          toolName: 'Bash',
          durationMs: 200,
          success: true,
          command: 'git push origin feature',
        },
      ];
      tracker.replayTimeline(timeline);
      const metrics = tracker.getMetrics();
      expect(metrics.totalGitCommands).toBe(4);
      expect(metrics.pullCount).toBe(1);
      expect(metrics.commitCount).toBe(2);
      expect(metrics.pushCount).toBe(1);
    });

    it('combines replay data with live tool calls', () => {
      const t = Date.now() - 3600_000;
      const timeline: ReplayTimelineEntry[] = [
        {
          timestamp: t,
          toolName: 'Bash',
          durationMs: 50,
          success: true,
          command: 'git commit -m "from earlier"',
        },
        {
          timestamp: t + 1000,
          toolName: 'Bash',
          durationMs: 50,
          success: true,
          command: 'git push origin feature',
        },
      ];
      tracker.replayTimeline(timeline);
      // Now a live tool call
      tracker.recordToolCall(makeRecord({ command: 'git commit -m "live"' }));
      const metrics = tracker.getMetrics();
      expect(metrics.commitCount).toBe(2);
      expect(metrics.pushCount).toBe(1);
      expect(metrics.totalGitCommands).toBe(3);
    });

    it('carries isTestCommand/isBuildCommand through to buildBeforePush detection', () => {
      const t = Date.now() - 3600_000;
      // Commit precedes test/push (not the more intuitive test-then-commit):
      // buildBeforePush only latches true when the build/test timestamp is
      // strictly after the last commit (see the staleness guard in the
      // 'push' case of processEvent), so an earlier test wouldn't count.
      const timeline: ReplayTimelineEntry[] = [
        {
          timestamp: t,
          toolName: 'Bash',
          durationMs: 100,
          success: true,
          command: 'git commit -m "verified change"',
        },
        {
          timestamp: t + 1000,
          toolName: 'Bash',
          durationMs: 500,
          success: true,
          command: 'npm test',
          isTestCommand: true,
        },
        {
          timestamp: t + 2000,
          toolName: 'Bash',
          durationMs: 200,
          success: true,
          command: 'git push origin feature',
        },
      ];
      tracker.replayTimeline(timeline);
      const metrics = tracker.getMetrics();
      expect(metrics.velocityMetrics.buildBeforePush).toBe(true);
    });

    it('replays file edits for sync-before-edit detection', () => {
      const t = Date.now() - 3600_000;
      const timeline: ReplayTimelineEntry[] = [
        { timestamp: t, toolName: 'Edit', durationMs: 10, success: true, filePath: 'src/a.ts' },
        {
          timestamp: t + 1000,
          toolName: 'Bash',
          durationMs: 50,
          success: true,
          command: 'git pull origin main',
        },
      ];
      tracker.replayTimeline(timeline);
      const metrics = tracker.getMetrics();
      expect(metrics.riskIndicators.syncedBeforeEditing).toBe(false);
    });

    it('detects conflicts from replayed sessions', () => {
      const t = Date.now() - 3600_000;
      const timeline: ReplayTimelineEntry[] = [
        {
          timestamp: t,
          toolName: 'Bash',
          durationMs: 50,
          success: true,
          command: 'git pull origin main',
        },
        {
          timestamp: t + 1000,
          toolName: 'Bash',
          durationMs: 100,
          success: true,
          command: 'git push --force origin feature',
        },
      ];
      tracker.replayTimeline(timeline);
      const metrics = tracker.getMetrics();
      expect(metrics.forcePushes).toBe(1);
    });

    // A developer who worked in a different repo earlier today must
    // not have that repo's commits/conflicts/force-pushes counted against
    // whichever repo this tracker's header currently names.
    describe('cross-repo filtering', () => {
      const t = Date.now() - 3600_000;
      const otherRepoTimeline: ReplayTimelineEntry[] = [
        {
          timestamp: t,
          toolName: 'Bash',
          durationMs: 100,
          success: true,
          command: 'git commit -m "work in repo A"',
        },
        {
          timestamp: t + 1000,
          toolName: 'Bash',
          durationMs: 100,
          success: true,
          command: 'git push --force origin feature',
        },
      ];

      it('skips a replayed session from a different repo than the current repoContext', () => {
        tracker.hydrateRepoContext({
          repoName: 'org/repo-b',
          branch: 'main',
          remoteName: 'origin',
          defaultBranch: 'main',
        });

        tracker.replayTimeline(otherRepoTimeline, 'org/repo-a');

        const metrics = tracker.getMetrics();
        expect(metrics.totalGitCommands).toBe(0);
        expect(metrics.commitCount).toBe(0);
        expect(metrics.forcePushes).toBe(0);
      });

      it('replays a session from the SAME repo as the current repoContext', () => {
        tracker.hydrateRepoContext({
          repoName: 'org/repo-a',
          branch: 'main',
          remoteName: 'origin',
          defaultBranch: 'main',
        });

        tracker.replayTimeline(otherRepoTimeline, 'org/repo-a');

        const metrics = tracker.getMetrics();
        expect(metrics.totalGitCommands).toBe(2);
        expect(metrics.commitCount).toBe(1);
        expect(metrics.forcePushes).toBe(1);
      });

      it('replays unfiltered when the session repoName is unknown (null)', () => {
        tracker.hydrateRepoContext({
          repoName: 'org/repo-b',
          branch: 'main',
          remoteName: 'origin',
          defaultBranch: 'main',
        });

        tracker.replayTimeline(otherRepoTimeline, null);

        expect(tracker.getMetrics().totalGitCommands).toBe(2);
      });

      it('replays unfiltered when the tracker has no repoContext yet', () => {
        // No hydrateRepoContext() call — repoContext.repoName stays null.
        tracker.replayTimeline(otherRepoTimeline, 'org/repo-a');

        expect(tracker.getMetrics().totalGitCommands).toBe(2);
      });
    });
  });

  describe('GitHub CLI PR tracking', () => {
    it('tracks PR create/checks/merge events and captures the PR number', () => {
      tracker.recordToolCall(makeRecord({ command: 'gh pr create --title "Add feature"' }));
      tracker.recordToolCall(makeRecord({ command: 'gh pr checks 42' }));
      tracker.recordToolCall(makeRecord({ command: 'gh pr merge 42' }));

      const metrics = tracker.getMetrics();
      expect(metrics.prMetrics.created).toBe(1);
      expect(metrics.prMetrics.checksViewed).toBe(1);
      expect(metrics.prMetrics.merged).toBe(1);

      const checksEvent = metrics.prMetrics.prActivity.find((e) => e.action === 'checks');
      const mergeEvent = metrics.prMetrics.prActivity.find((e) => e.action === 'merge');
      expect(checksEvent?.prNumber).toBe('42');
      expect(mergeEvent?.prNumber).toBe('42');
    });

    it('tracks gh pr edit/ready as prsUpdated', () => {
      tracker.recordToolCall(makeRecord({ command: 'gh pr edit 7 --add-label ready' }));
      tracker.recordToolCall(makeRecord({ command: 'gh pr ready 7' }));

      const metrics = tracker.getMetrics();
      expect(metrics.prMetrics.prsUpdated).toBe(2);
    });

    it('does not treat "gh" text inside a git commit message as a gh command', () => {
      tracker.recordToolCall(makeRecord({ command: 'git commit -m "gh pr create note"' }));

      const metrics = tracker.getMetrics();
      expect(metrics.prMetrics.created).toBe(0);
    });

    it('detects a gh command chained after a git command in a compound shell invocation', () => {
      tracker.recordToolCall(
        makeRecord({ command: 'git push origin main && gh pr create --fill' }),
      );

      const metrics = tracker.getMetrics();
      expect(metrics.prMetrics.created).toBe(1);
    });

    it('detects a gh command separated by ";" or "|" from a preceding git command', () => {
      tracker.recordToolCall(makeRecord({ command: 'git push origin main; gh pr create --fill' }));
      tracker.recordToolCall(makeRecord({ command: 'git status | gh pr checks 42' }));

      const metrics = tracker.getMetrics();
      expect(metrics.prMetrics.created).toBe(1);
      expect(metrics.prMetrics.checksViewed).toBe(1);
    });

    it('computes avgTimeToCreateMs across every PR opened this session, not just the first', () => {
      const t = Date.now();
      tracker.recordToolCall(makeRecord({ command: 'git commit -m "a"', timestamp: t }));
      tracker.recordToolCall(
        makeRecord({ command: 'gh pr create --title "first"', timestamp: t + 10_000 }),
      );
      tracker.recordToolCall(makeRecord({ command: 'git commit -m "b"', timestamp: t + 20_000 }));
      tracker.recordToolCall(
        makeRecord({ command: 'gh pr create --title "second"', timestamp: t + 25_000 }),
      );

      const metrics = tracker.getMetrics();
      // First PR: 10s after its preceding commit. Second PR: 5s after its own
      // most recent preceding commit. True average of the two is 7.5s — not
      // 10s, which is what you'd get by anchoring every PR to the very first
      // commit the tracker ever saw.
      expect(metrics.prMetrics.avgTimeToCreateMs).toBe(7_500);
    });

    it('counts a create_pull_request MCP tool call even with no command field', () => {
      tracker.recordToolCall(makeRecord({ toolName: 'create_pull_request', command: undefined }));

      const metrics = tracker.getMetrics();
      expect(metrics.prMetrics.created).toBe(1);
    });

    it('counts an update_pull_request MCP tool call as prsUpdated', () => {
      tracker.recordToolCall(makeRecord({ toolName: 'update_pull_request', command: undefined }));

      const metrics = tracker.getMetrics();
      expect(metrics.prMetrics.prsUpdated).toBe(1);
    });

    it('does not double-count a gh pr create Bash call as also being an MCP PR event', () => {
      tracker.recordToolCall(
        makeRecord({ toolName: 'Bash', command: 'gh pr create --title "Add feature"' }),
      );

      const metrics = tracker.getMetrics();
      expect(metrics.prMetrics.created).toBe(1);
    });
  });

  describe('hydration entry points', () => {
    it('hydrateGitLog adds historical commits without double-counting duplicates', () => {
      const t = Date.now() - 3600_000;
      tracker.hydrateGitLog([
        { timestamp: t, hash: 'abc123' },
        { timestamp: t + 1_000, hash: 'def456' },
      ]);

      let metrics = tracker.getMetrics();
      expect(metrics.commitCount).toBe(2);
      expect(metrics.totalGitCommands).toBe(2);
      // Historical commits must not count toward real-time sync drift.
      expect(metrics.riskIndicators.commitsSinceLastSync).toBe(0);

      // Re-hydrating an already-seen hash must not create a duplicate event.
      tracker.hydrateGitLog([{ timestamp: t, hash: 'abc123' }]);
      metrics = tracker.getMetrics();
      expect(metrics.commitCount).toBe(2);
    });

    // Two genuinely distinct commits landing within the dedup window must
    // both be counted — a hydrated-vs-hydrated comparison has a real hash on
    // both sides, so it must match by hash equality rather than timestamp
    // proximity, or two rapid sequential commits in the same `git log` batch
    // would incorrectly collapse into one.
    it('counts two distinct commits within the dedup window as separate commits, not a duplicate', () => {
      const t = Date.now() - 3600_000;
      tracker.hydrateGitLog([
        { timestamp: t, hash: 'abc123' },
        { timestamp: t + 500, hash: 'def456' },
      ]);

      const metrics = tracker.getMetrics();
      expect(metrics.commitCount).toBe(2);
      expect(metrics.totalGitCommands).toBe(2);
    });

    // The day-boundary re-hydration path in src/index.ts resets the tracker
    // (emptying this.events) and then feeds it the whole day's `git log`
    // output in one call — every proximity comparison in that batch is
    // hydrated-vs-hydrated, with no hook events to dedup against, so it must
    // rely on hash equality to avoid collapsing distinct commits.
    it('counts two distinct commits within the dedup window after a day-boundary reset', () => {
      tracker.reset('next-session');
      const hydratedAt = Date.now();
      tracker.hydrateGitLog([
        { hash: 'abc123', timestamp: hydratedAt },
        { hash: 'def456', timestamp: hydratedAt + 500 },
      ]);

      expect(tracker.getMetrics().commitCount).toBe(2);
    });

    // Simulates a process restart mid-day: a prior, now-ended session's
    // commit was already replayed as a raw hook event (command text with no
    // hash), then the startup `git log` hydration sees the same commit by
    // hash. A hash-substring dedup can never match a raw command string, so
    // this would double-count every commit made before the restart.
    it('does not double-count a commit already present as a replayed hook event, on process restart', () => {
      const commitTimestamp = Date.now() - 60_000;
      tracker.replayTimeline([
        {
          timestamp: commitTimestamp,
          toolName: 'Bash',
          durationMs: 100,
          success: true,
          command: 'git commit -m "fix thing"',
        },
      ]);
      expect(tracker.getMetrics().commitCount).toBe(1);

      tracker.hydrateGitLog([{ timestamp: commitTimestamp, hash: 'abc123' }]);

      expect(tracker.getMetrics().commitCount).toBe(1);
    });

    it('hydrateBranchDivergence sets ahead/behind counts on risk indicators', () => {
      tracker.hydrateBranchDivergence(3, 7);

      const metrics = tracker.getMetrics();
      expect(metrics.riskIndicators.commitsAheadOfMain).toBe(3);
      expect(metrics.riskIndicators.commitsBehindMain).toBe(7);
    });

    // The "behind main" KPI polls every 5s, implying a live number, but
    // hydrateBranchDivergence() only ever gets called by whatever invokes it
    // — the tracker itself has no way to notice staleness or re-fetch on its
    // own. The actual periodic re-fetch trigger lives in src/index.ts (a
    // setInterval re-running `git rev-list` and re-hydrating) and isn't
    // unit-testable from this file; this test instead verifies the
    // composability that periodic re-fetch depends on: calling
    // hydrateBranchDivergence() again must fully replace the previous
    // snapshot, not just supplement it.
    it('supports a later hydrateBranchDivergence() call replacing a stale snapshot', () => {
      tracker.hydrateBranchDivergence(0, 12);
      expect(tracker.getMetrics().riskIndicators.commitsBehindMain).toBe(12);

      jest.useFakeTimers().setSystemTime(Date.now() + 10 * 60_000);
      // With no re-fetch, the value stays frozen — the tracker itself never
      // refreshes it on its own; only an explicit re-hydration call does.
      expect(tracker.getMetrics().riskIndicators.commitsBehindMain).toBe(12);

      tracker.hydrateBranchDivergence(0, 3);
      expect(tracker.getMetrics().riskIndicators.commitsBehindMain).toBe(3);
      jest.useRealTimers();
    });

    it('hydrateRepoContext sets the repo context returned in metrics', () => {
      tracker.hydrateRepoContext({
        repoName: 'nr-ai-observatory',
        branch: 'main',
        remoteName: 'origin',
        defaultBranch: 'main',
      });

      const metrics = tracker.getMetrics();
      expect(metrics.repoContext).toEqual({
        repoName: 'nr-ai-observatory',
        branch: 'main',
        remoteName: 'origin',
        defaultBranch: 'main',
      });
    });
  });

  describe('conflict resolution strategy', () => {
    // oursCount/theirsCount/cherryPickCount must attribute to the specific
    // pending conflict they resolve (one credit
    // per conflict), not increment per matching command — a strategy command
    // run with no conflict pending isn't resolving anything.
    it('does not credit ours/theirs/cherry-pick strategy when no conflict is pending', () => {
      tracker.recordToolCall(makeRecord({ command: 'git checkout --ours file.ts' }));
      tracker.recordToolCall(makeRecord({ command: 'git checkout --theirs other.ts' }));
      tracker.recordToolCall(makeRecord({ command: 'git cherry-pick abc123' }));

      const metrics = tracker.getMetrics();
      expect(metrics.conflictResolutionStrategy.oursCount).toBe(0);
      expect(metrics.conflictResolutionStrategy.theirsCount).toBe(0);
      expect(metrics.conflictResolutionStrategy.cherryPickCount).toBe(0);
    });

    // Concrete example: one conflict spanning 3 files, resolved by
    // running `git checkout --ours <file>` once per file then committing
    // once. oursCount must be 1 (one conflict resolved with that strategy),
    // not 3 (one per command).
    it('dedupes ours/theirs credit per conflict, not per command, for a multi-file conflict', () => {
      const t = Date.now();
      tracker.recordToolCall(
        makeRecord({
          command: 'git merge main',
          timestamp: t,
          success: false,
          error:
            'CONFLICT (content): Merge conflict in a.ts\n' +
            'CONFLICT (content): Merge conflict in b.ts\n' +
            'CONFLICT (content): Merge conflict in c.ts',
        }),
      );
      tracker.recordToolCall(
        makeRecord({ command: 'git checkout --ours a.ts', timestamp: t + 1000 }),
      );
      tracker.recordToolCall(
        makeRecord({ command: 'git checkout --ours b.ts', timestamp: t + 2000 }),
      );
      tracker.recordToolCall(
        makeRecord({ command: 'git checkout --ours c.ts', timestamp: t + 3000 }),
      );
      tracker.recordToolCall(
        makeRecord({ command: 'git commit -m "resolve"', timestamp: t + 4000 }),
      );

      const metrics = tracker.getMetrics();
      expect(metrics.conflictResolutionStrategy.oursCount).toBe(1);
      expect(metrics.conflictResolutionStrategy.totalResolutions).toBe(1);
    });

    it('credits ours/theirs/cherry-pick strategy once each conflict resolves via commit', () => {
      const t = Date.now();
      tracker.recordToolCall(
        makeRecord({
          command: 'git merge main',
          timestamp: t,
          success: false,
          error: 'CONFLICT (content): Merge conflict in file.ts',
        }),
      );
      tracker.recordToolCall(
        makeRecord({ command: 'git checkout --ours file.ts', timestamp: t + 1000 }),
      );
      tracker.recordToolCall(
        makeRecord({ command: 'git commit -m "resolve"', timestamp: t + 2000 }),
      );

      const metrics = tracker.getMetrics();
      expect(metrics.conflictResolutionStrategy.oursCount).toBe(1);
      expect(metrics.conflictResolutionStrategy.theirsCount).toBe(0);
      expect(metrics.conflictResolutionStrategy.cherryPickCount).toBe(0);
    });

    // Cherry-picks must be included in totalResolutions, not tallied
    // separately and excluded from the total.
    it('includes cherry-pick resolutions in totalResolutions', () => {
      const t = Date.now();
      tracker.recordToolCall(
        makeRecord({
          command: 'git cherry-pick abc123',
          timestamp: t,
          success: false,
          error: 'CONFLICT (content): Merge conflict in file.ts',
        }),
      );
      tracker.recordToolCall(
        makeRecord({ command: 'git cherry-pick --continue', timestamp: t + 1000 }),
      );
      tracker.recordToolCall(
        makeRecord({ command: 'git commit -m "resolve"', timestamp: t + 2000 }),
      );

      const metrics = tracker.getMetrics();
      expect(metrics.conflictResolutionStrategy.cherryPickCount).toBe(1);
      expect(metrics.conflictResolutionStrategy.totalResolutions).toBe(1);
    });

    // `git cherry-pick --abort` is an abort, not a resolution, and must not
    // be counted toward cherryPickCount.
    it('does not credit cherryPickCount for a cherry-pick that was aborted', () => {
      const t = Date.now();
      tracker.recordToolCall(
        makeRecord({
          command: 'git cherry-pick abc123',
          timestamp: t,
          success: false,
          error: 'CONFLICT (content): Merge conflict in file.ts',
        }),
      );
      tracker.recordToolCall(
        makeRecord({ command: 'git cherry-pick --abort', timestamp: t + 1000 }),
      );

      const metrics = tracker.getMetrics();
      expect(metrics.conflictResolutionStrategy.cherryPickCount).toBe(0);
    });
  });

  describe('velocity metrics', () => {
    it('computes avg/longest gap and detects a 3-commit burst', () => {
      const t = Date.now();
      tracker.recordToolCall(makeRecord({ command: 'git commit -m "a"', timestamp: t }));
      tracker.recordToolCall(makeRecord({ command: 'git commit -m "b"', timestamp: t + 10_000 }));
      tracker.recordToolCall(makeRecord({ command: 'git commit -m "c"', timestamp: t + 20_000 }));

      const metrics = tracker.getMetrics();
      expect(metrics.velocityMetrics.avgTimeBetweenCommitsMs).toBe(10_000);
      expect(metrics.velocityMetrics.longestGapMs).toBe(10_000);
      expect(metrics.velocityMetrics.commitBurstCount).toBe(1);
    });

    it('does not flag a burst when commits are spread far apart', () => {
      const t = Date.now();
      tracker.recordToolCall(makeRecord({ command: 'git commit -m "a"', timestamp: t }));
      tracker.recordToolCall(makeRecord({ command: 'git commit -m "b"', timestamp: t + 10_000 }));
      tracker.recordToolCall(makeRecord({ command: 'git commit -m "c"', timestamp: t + 500_000 }));

      const metrics = tracker.getMetrics();
      expect(metrics.velocityMetrics.longestGapMs).toBe(490_000);
      expect(metrics.velocityMetrics.commitBurstCount).toBe(0);
    });
  });

  describe('conflict resolution edge cases', () => {
    it('clears the pending conflict without recording a resolution on --amend', () => {
      const t = Date.now();
      tracker.recordToolCall(
        makeRecord({
          command: 'git merge main',
          timestamp: t,
          success: false,
          error: 'CONFLICT (content): Merge conflict in src/file.ts',
        }),
      );
      tracker.recordToolCall(
        makeRecord({ command: 'git commit --amend -m "fix"', timestamp: t + 5000 }),
      );
      let metrics = tracker.getMetrics();
      expect(metrics.conflictHistory).toHaveLength(0);

      // A later, unrelated commit must not retroactively resolve the old conflict.
      tracker.recordToolCall(
        makeRecord({ command: 'git commit -m "later change"', timestamp: t + 10_000 }),
      );
      metrics = tracker.getMetrics();
      expect(metrics.conflictHistory).toHaveLength(0);
    });

    it('flags quick conflict resolutions when a multi-file conflict resolves in under 30s', () => {
      const t = Date.now();
      tracker.recordToolCall(
        makeRecord({
          command: 'git merge main',
          timestamp: t,
          success: false,
          error:
            'CONFLICT (content): Merge conflict in src/a.ts\n' +
            'CONFLICT (content): Merge conflict in src/b.ts\n' +
            'Automatic merge failed',
        }),
      );
      tracker.recordToolCall(
        makeRecord({ command: 'git commit -m "resolve"', timestamp: t + 15_000 }),
      );

      const metrics = tracker.getMetrics();
      expect(metrics.riskIndicators.quickConflictResolutions).toBe(1);
    });
  });
});

describe('gitCommandTargetDir()', () => {
  it('falls back to the tool call cwd for a plain git command', () => {
    expect(gitCommandTargetDir('git status --short', '/home/u/aic')).toBe('/home/u/aic');
  });

  it('prefers the -C target over cwd, so work driven from one repo at another is attributed correctly', () => {
    expect(gitCommandTargetDir('git -C /home/u/other log --oneline -1', '/home/u/aic')).toBe(
      '/home/u/other',
    );
  });

  it('handles a quoted -C path containing spaces', () => {
    expect(gitCommandTargetDir('git -C "/home/u/my repo" status', '/home/u/aic')).toBe(
      '/home/u/my repo',
    );
  });

  it('resolves the target of a cd && git chain', () => {
    expect(gitCommandTargetDir('cd /home/u/worktree && git commit -m x', '/home/u/aic')).toBe(
      '/home/u/worktree',
    );
  });

  it('ignores -C belonging to a different command', () => {
    expect(gitCommandTargetDir('tar -C /tmp -xf a.tar && git status', '/home/u/aic')).toBe(
      '/home/u/aic',
    );
  });

  it('returns null when there is no target and no cwd', () => {
    expect(gitCommandTargetDir('git status', undefined)).toBeNull();
  });

  it('skips -c config flags preceding -C', () => {
    expect(gitCommandTargetDir('git -c core.pager=cat -C /home/u/repo log', '/home/u/aic')).toBe(
      '/home/u/repo',
    );
  });
});

describe('GitEfficiencyTracker repo attribution', () => {
  it('tags a live git event with a repo rather than leaving it blank', () => {
    // RepoNameResolver shells out to `git -C <dir> remote get-url origin`,
    // so this needs a real repo with a controlled remote rather than
    // hardcoding whatever repo/fork happens to check this test out. Clear
    // GIT_DIR/GIT_WORK_TREE: git sets these for hook subprocesses (e.g. this
    // suite running under husky's pre-push), and they'd otherwise redirect
    // `git init` away from the fresh temp dir and onto the real repo.
    const dir = mkdtempSync(join(tmpdir(), 'git-efficiency-repo-attr-'));
    const gitEnv = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined };
    try {
      execSync('git init -q', { cwd: dir, env: gitEnv });
      execSync('git remote add origin https://github.com/acme/widgets.git', {
        cwd: dir,
        env: gitEnv,
      });

      const tracker = new GitEfficiencyTracker();
      tracker.recordToolCall(
        makeRecord({ command: 'git status --short', cwd: dir } as Partial<ToolCallRecord>),
      );
      const [event] = tracker.getMetrics().gitCommandTimeline;
      expect(event).toBeDefined();
      expect(event?.repo).toBe('acme/widgets');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('redacts credentials embedded in a git remote URL', () => {
    const tracker = new GitEfficiencyTracker();
    tracker.recordToolCall(
      makeRecord({
        command:
          'git push https://x-access-token:ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA@github.com/a/b.git',
      } as Partial<ToolCallRecord>),
    );
    const [event] = tracker.getMetrics().gitCommandTimeline;
    expect(event?.command).not.toContain('ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  });
});

describe('stripHeredocBodies()', () => {
  it('drops an inline script body but keeps the introducing line', () => {
    const out = stripHeredocBodies("python3 - <<'PY'\ngit push --force\nPY\necho done");
    expect(out).toBe("python3 - <<'PY'\necho done");
  });

  it('keeps the body of an unterminated heredoc from leaking a terminator match', () => {
    const out = stripHeredocBodies('cat <<EOF\ngit log\n');
    expect(out).toBe('cat <<EOF');
  });

  it('honours <<- tab-stripped terminators', () => {
    const out = stripHeredocBodies('cat <<-EOF\n\tgit push\n\tEOF\ngit status');
    expect(out).toBe('cat <<-EOF\ngit status');
  });

  it('leaves commands without a heredoc untouched', () => {
    expect(stripHeredocBodies('git push origin main')).toBe('git push origin main');
  });
});

describe('GitEfficiencyTracker heredoc misclassification', () => {
  it('does not classify a script that merely mentions git words as a git operation', () => {
    const tracker = new GitEfficiencyTracker();
    tracker.recordToolCall(
      makeRecord({
        command:
          "cd /tmp/x && python3 - <<'PYEOF'\ns = s.replace('git push --force', 'git log')\nPYEOF\necho ok",
      } as Partial<ToolCallRecord>),
    );
    const metrics = tracker.getMetrics();
    expect(metrics.gitCommandTimeline).toHaveLength(0);
    expect(metrics.pushCount).toBe(0);
    expect(metrics.forcePushes).toBe(0);
  });

  it('still classifies a real git command that carries a heredoc payload', () => {
    const tracker = new GitEfficiencyTracker();
    tracker.recordToolCall(
      makeRecord({
        command: "git commit -F- <<'MSG'\nfix: something\nMSG",
      } as Partial<ToolCallRecord>),
    );
    const [event] = tracker.getMetrics().gitCommandTimeline;
    expect(event?.type).toBe('commit');
  });
});
