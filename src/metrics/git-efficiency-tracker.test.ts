import {
  GitEfficiencyTracker,
  parseDefaultBranchFromSymbolicRef,
} from './git-efficiency-tracker.js';
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

  it('detects worktree usage', () => {
    tracker.recordToolCall(makeRecord({ command: 'git worktree add ../feature-x feature-x' }));
    const metrics = tracker.getMetrics();
    expect(metrics.riskIndicators.usesWorktrees).toBe(true);
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

    it('warns about no initial sync', () => {
      const t = Date.now();
      tracker.recordToolCall(makeRecord({ toolName: 'Edit', filePath: 'src/a.ts', timestamp: t }));
      // Need a git command for suggestions to fire
      tracker.recordToolCall(makeRecord({ command: 'git status', timestamp: t + 100 }));
      const metrics = tracker.getMetrics();
      const syncSuggestion = metrics.suggestions.find((s) => s.category === 'no_initial_sync');
      expect(syncSuggestion).toBeDefined();
      expect(syncSuggestion!.message).toContain('git fetch');
    });

    it('warns about drift risk', () => {
      tracker.recordToolCall(makeRecord({ command: 'git pull origin main' }));
      for (let i = 0; i < 12; i++) {
        tracker.recordToolCall(makeRecord({ command: `git commit -m "c${i}"` }));
      }
      const metrics = tracker.getMetrics();
      const driftSuggestion = metrics.suggestions.find((s) => s.category === 'drift_risk');
      expect(driftSuggestion).toBeDefined();
      expect(driftSuggestion!.message).toContain('rebase');
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
  });
});
