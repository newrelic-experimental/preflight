import { classifyGitCommand, classifyGitSegments, type GitEvent } from './git-event-classifier.js';
import type { ToolCallRecord } from '../storage/types.js';

const makeRecord = (overrides?: Partial<ToolCallRecord>): ToolCallRecord => ({
  id: 'test-id',
  sessionId: 'test-session',
  toolName: 'Bash',
  toolUseId: 'tool-1',
  timestamp: 1000,
  durationMs: 100,
  success: true,
  command: 'git commit -m "test"',
  ...overrides,
});

describe('classifyGitCommand', () => {
  let resolveRepoSpy: jest.Mock;

  beforeEach(() => {
    resolveRepoSpy = jest.fn().mockReturnValue(null);
  });

  describe('basic git commands', () => {
    it('classifies a git commit command', () => {
      const record = makeRecord({ command: 'git commit -m "test"' });
      const event = classifyGitCommand('git commit -m "test"', record, resolveRepoSpy);

      expect(event.type).toBe('commit');
      expect(event.success).toBe(true);
      expect(resolveRepoSpy).toHaveBeenCalled();
    });

    it('classifies a git push command', () => {
      const record = makeRecord({ command: 'git push origin main' });
      const event = classifyGitCommand('git push origin main', record, resolveRepoSpy);

      expect(event.type).toBe('push');
    });

    it('classifies a git pull command', () => {
      const record = makeRecord({ command: 'git pull' });
      const event = classifyGitCommand('git pull', record, resolveRepoSpy);

      expect(event.type).toBe('pull');
    });

    it('classifies a git fetch command', () => {
      const record = makeRecord({ command: 'git fetch origin' });
      const event = classifyGitCommand('git fetch origin', record, resolveRepoSpy);

      expect(event.type).toBe('fetch');
    });

    it('classifies a git branch command', () => {
      const record = makeRecord({ command: 'git branch feature' });
      const event = classifyGitCommand('git branch feature', record, resolveRepoSpy);

      expect(event.type).toBe('branch');
    });
  });

  describe('force push variants', () => {
    it('distinguishes git push --force from git push --force-with-lease', () => {
      const recordForce = makeRecord({ command: 'git push --force' });
      const eventForce = classifyGitCommand('git push --force', recordForce, resolveRepoSpy);

      expect(eventForce.type).toBe('force_push');

      const recordLease = makeRecord({ command: 'git push --force-with-lease' });
      const eventLease = classifyGitCommand(
        'git push --force-with-lease',
        recordLease,
        resolveRepoSpy,
      );

      expect(eventLease.type).toBe('force_push_lease');
    });

    it('matches git push -f as force_push', () => {
      const record = makeRecord({ command: 'git push -f' });
      const event = classifyGitCommand('git push -f', record, resolveRepoSpy);

      expect(event.type).toBe('force_push');
    });

    it('does not match force_push_lease for plain --force pattern', () => {
      // Ensure --force-with-lease doesn't get classified as force_push
      const record = makeRecord({ command: 'git push --force-with-lease' });
      const event = classifyGitCommand('git push --force-with-lease', record, resolveRepoSpy);

      expect(event.type).toBe('force_push_lease');
      expect(event.type).not.toBe('force_push');
    });
  });

  describe('conflict detection', () => {
    it('detects merge conflicts from error output', () => {
      const record = makeRecord({
        command: 'git merge feature',
        success: false,
        error: 'CONFLICT (content): Merge conflict in file.ts',
      });
      const event = classifyGitCommand('git merge feature', record, resolveRepoSpy);

      expect(event.type).toBe('merge_conflict');
    });

    it('detects rebase conflicts from error output', () => {
      const record = makeRecord({
        command: 'git rebase origin/main',
        success: false,
        error: 'error: rebase could not apply commit 123456',
      });
      const event = classifyGitCommand('git rebase origin/main', record, resolveRepoSpy);

      expect(event.type).toBe('rebase_conflict');
    });

    it('prefers rebase_conflict classification over merge_conflict when both indicators present', () => {
      const record = makeRecord({
        command: 'git rebase origin/main',
        success: false,
        error:
          'CONFLICT (content): Merge conflict in file.ts\nerror: rebase could not apply 123456',
      });
      const event = classifyGitCommand('git rebase origin/main', record, resolveRepoSpy);

      expect(event.type).toBe('rebase_conflict');
    });
  });

  describe('abort commands', () => {
    it('classifies merge abort', () => {
      const record = makeRecord({ command: 'git merge --abort' });
      const event = classifyGitCommand('git merge --abort', record, resolveRepoSpy);

      expect(event.type).toBe('merge_abort');
    });

    it('classifies rebase abort', () => {
      const record = makeRecord({ command: 'git rebase --abort' });
      const event = classifyGitCommand('git rebase --abort', record, resolveRepoSpy);

      expect(event.type).toBe('rebase_abort');
    });

    it('classifies cherry-pick abort', () => {
      const record = makeRecord({ command: 'git cherry-pick --abort' });
      const event = classifyGitCommand('git cherry-pick --abort', record, resolveRepoSpy);

      expect(event.type).toBe('cherry_pick_abort');
    });
  });

  describe('repo resolution', () => {
    it('calls resolveRepo with the correct directory', () => {
      const mockResolveRepo = jest.fn().mockReturnValue('owner/repo');
      const record = makeRecord({ command: 'git commit', cwd: '/path/to/repo' });
      const event = classifyGitCommand('git commit', record, mockResolveRepo);

      expect(event.repo).toBe('owner/repo');
      expect(mockResolveRepo).toHaveBeenCalled();
    });

    it('uses null repo when resolveRepo returns null', () => {
      const mockResolveRepo = jest.fn().mockReturnValue(null);
      const record = makeRecord({ command: 'git commit' });
      const event = classifyGitCommand('git commit', record, mockResolveRepo);

      expect(event.repo).toBeNull();
    });
  });

  describe('command redaction', () => {
    it('redacts sensitive information from command', () => {
      const mockResolveRepo = jest.fn().mockReturnValue(null);
      const record = makeRecord({ command: 'git push https://user:token@github.com/repo.git' });
      const event = classifyGitCommand(
        'git push https://user:token@github.com/repo.git',
        record,
        mockResolveRepo,
      );

      // The exact redaction output depends on redactSensitive implementation
      expect(event.command).toBeDefined();
      expect(event.command).not.toContain('token@github.com');
    });
  });

  describe('event metadata', () => {
    it('preserves timestamp, success, and duration', () => {
      const mockResolveRepo = jest.fn().mockReturnValue(null);
      const record = makeRecord({
        command: 'git commit',
        timestamp: 5000,
        success: false,
        durationMs: 250,
      });
      const event = classifyGitCommand('git commit', record, mockResolveRepo);

      expect(event.timestamp).toBe(5000);
      expect(event.success).toBe(false);
      expect(event.durationMs).toBe(250);
    });
  });

  describe('various git operations', () => {
    it('classifies git reset --hard', () => {
      const record = makeRecord({ command: 'git reset --hard' });
      const event = classifyGitCommand('git reset --hard', record, resolveRepoSpy);

      expect(event.type).toBe('reset_hard');
    });

    it('classifies git checkout -- as discard_changes', () => {
      const record = makeRecord({ command: 'git checkout -- file.ts' });
      const event = classifyGitCommand('git checkout -- file.ts', record, resolveRepoSpy);

      expect(event.type).toBe('discard_changes');
    });

    it('classifies git restore as discard_changes', () => {
      const record = makeRecord({ command: 'git restore file.ts' });
      const event = classifyGitCommand('git restore file.ts', record, resolveRepoSpy);

      expect(event.type).toBe('discard_changes');
    });

    it('classifies git stash', () => {
      const record = makeRecord({ command: 'git stash' });
      const event = classifyGitCommand('git stash', record, resolveRepoSpy);

      expect(event.type).toBe('stash');
    });

    it('classifies git log', () => {
      const record = makeRecord({ command: 'git log --oneline' });
      const event = classifyGitCommand('git log --oneline', record, resolveRepoSpy);

      expect(event.type).toBe('log');
    });

    it('classifies git diff', () => {
      const record = makeRecord({ command: 'git diff' });
      const event = classifyGitCommand('git diff', record, resolveRepoSpy);

      expect(event.type).toBe('diff');
    });

    it('classifies git status', () => {
      const record = makeRecord({ command: 'git status' });
      const event = classifyGitCommand('git status', record, resolveRepoSpy);

      expect(event.type).toBe('status');
    });
  });

  describe('edge cases', () => {
    it('classifies unrecognized git command as other_git', () => {
      const record = makeRecord({ command: 'git custom-cmd' });
      const event = classifyGitCommand('git custom-cmd', record, resolveRepoSpy);

      expect(event.type).toBe('other_git');
    });

    it('handles missing error output gracefully', () => {
      const record = makeRecord({ command: 'git commit', error: undefined });
      const event = classifyGitCommand('git commit', record, resolveRepoSpy);

      expect(event.type).toBe('commit');
    });

    it('handles rejected push', () => {
      const record = makeRecord({
        command: 'git push',
        success: false,
        error: '[rejected] non-fast-forward',
      });
      const event = classifyGitCommand('git push', record, resolveRepoSpy);

      expect(event.type).toBe('push_rejected');
    });
  });
});

describe('classifyGitSegments error attribution', () => {
  const resolveRepo = (): string | null => null;
  const CONFLICT = 'CONFLICT (content): Merge conflict in a.ts\nAutomatic merge failed';
  const REJECTED = ' ! [rejected] main -> main (non-fast-forward)\nerror: failed to push some refs';

  const classify = (command: string, error: string): string[] =>
    classifyGitSegments(command, makeRecord({ command, success: false, error }), resolveRepo).map(
      ({ event }) => event.type,
    );

  it('hands conflict text to the segment that can conflict, not a later push', () => {
    expect(classify('git pull && git push', CONFLICT)).toEqual(['merge_conflict']);
  });

  it('keeps conflicted files on the segment the conflict is attributed to', () => {
    const command = 'git merge feature; git push; gh pr create --fill';
    const events = classifyGitSegments(
      command,
      makeRecord({ command, success: false, error: CONFLICT }),
      resolveRepo,
    ).map(({ event }) => event);
    expect(events.map((e) => e.type)).toEqual(['merge_conflict', 'push']);
    expect(events[0]!.files).toEqual(['a.ts']);
    expect(events[1]!.files).toBeUndefined();
  });

  it('attributes rebase conflict text to a pull --rebase before a push', () => {
    expect(
      classify('git pull --rebase && git push', 'error: rebase could not apply abc123'),
    ).toEqual(['rebase_conflict']);
  });

  it('attributes push rejection text to the push, not a later git segment', () => {
    expect(classify('git push; git status', REJECTED)).toEqual(['push_rejected', 'status']);
  });

  it('leaves a git segment unattributed when a following gh command could own the error', () => {
    // `gh pr checkout` runs its own git merge; its conflict text is not the fetch's.
    expect(classify('git fetch && gh pr checkout 12', CONFLICT)).toEqual(['fetch']);
    expect(classify('git status && gh pr view', 'both modified:   a.ts')).toEqual(['status']);
  });

  it('does not flag a push as rejected when a following gh step fails without rejection text', () => {
    expect(
      classify(
        'git push && gh pr create --fill',
        'pull request create failed: GraphQL: No commits between main and feature',
      ),
    ).toEqual(['push']);
  });

  it('still attributes push rejection text to a push followed by gh', () => {
    expect(classify('git push && gh pr create --fill', REJECTED)).toEqual(['push_rejected']);
  });

  it('gives the last git segment the error when nothing runs after it', () => {
    expect(classify('git commit -m x && git push', REJECTED)).toEqual(['commit', 'push_rejected']);
    expect(classify('git rebase main && npm test', 'error: rebase could not apply abc')).toEqual([
      'rebase_conflict',
    ]);
    // Single-segment behavior is unchanged, even for text no verb explains.
    expect(classify('git status', 'both modified:   a.ts')).toEqual(['merge_conflict']);
  });

  it('drops git segments that a failure earlier in an && chain kept from running', () => {
    expect(classify('git pull && git push && git status', CONFLICT)).toEqual(['merge_conflict']);
    // `||` and `;` run the next segment after a failure, so it is kept.
    expect(classify('git pull && git push || git status', CONFLICT)).toEqual([
      'merge_conflict',
      'status',
    ]);
    // The pull's conflict leaves the branch behind, so the push it then runs
    // is rejected, and the rejection text still names the push.
    expect(classify('git pull; git push', `${CONFLICT}\n${REJECTED}`)).toEqual([
      'merge_conflict',
      'push_rejected',
    ]);
  });

  it('keeps every segment of a chain that succeeded', () => {
    const command = 'git pull && git push';
    const events = classifyGitSegments(command, makeRecord({ command }), resolveRepo);
    expect(events.map(({ event }) => [event.type, event.success])).toEqual([
      ['pull', true],
      ['push', true],
    ]);
  });
});

describe('classifyGitSegments per-segment outcome', () => {
  const resolveRepo = (): string | null => null;
  const REJECTED = ' ! [rejected] main -> main (non-fast-forward)\nerror: failed to push some refs';

  // The hook reports one exit status for the whole chain, so only the
  // segment the failure is attributed to inherits it.
  const outcomes = (command: string, error: string): [string, boolean][] =>
    classifyGitSegments(command, makeRecord({ command, success: false, error }), resolveRepo).map(
      ({ event }) => [event.type, event.success],
    );

  it('marks a commit before a rejected push as succeeded', () => {
    expect(outcomes('git commit -m x && git push', REJECTED)).toEqual([
      ['commit', true],
      ['push_rejected', false],
    ]);
  });

  it('marks a commit before a failing gh step as succeeded', () => {
    expect(
      outcomes(
        'git commit -m x && gh pr create --fill',
        'pull request create failed: GraphQL: No commits between main and feature',
      ),
    ).toEqual([['commit', true]]);
  });

  it('marks a final commit failed when its own hook rejects it', () => {
    expect(outcomes('git add -A && git commit -m x', 'husky - pre-commit script failed')).toEqual([
      ['other_git', true],
      ['commit', false],
    ]);
  });

  it('attributes commit-failure text to the commit, not a later push', () => {
    expect(
      outcomes(
        'git add -A && git commit -m x && git push',
        'nothing to commit, working tree clean',
      ),
    ).toEqual([
      ['other_git', true],
      ['commit', false],
    ]);
    expect(
      outcomes('git commit -m x && git push', 'husky - pre-commit script failed (code 1)'),
    ).toEqual([['commit', false]]);
  });

  // The text doesn't say which commit failed, and a failed first one stops
  // the `&&` run, so the earliest commit in it takes the failure.
  it('gives commit-failure text to the earliest commit of the && run', () => {
    expect(
      outcomes(
        'git add a.ts && git commit -m "feat: a" && git add b.ts && git commit -m "feat: b"',
        'husky - pre-commit script failed (code 1)',
      ),
    ).toEqual([
      ['other_git', true],
      ['commit', false],
    ]);
    expect(
      outcomes(
        'git commit -m a && git commit -m b && git push',
        'nothing to commit, working tree clean',
      ),
    ).toEqual([['commit', false]]);
  });

  it('gives commit-failure text to the commit after the || in its own && run', () => {
    expect(
      outcomes(
        'git commit -m x || git commit --no-verify -m x',
        'husky - pre-commit script failed',
      ),
    ).toEqual([
      ['commit', false],
      ['commit', false],
    ]);
  });

  it('does not read a landed commit subject as its failure before a failed push', () => {
    expect(
      outcomes(
        'git commit -m "Fix pre-commit hook failed on CI" && git push',
        '[main abc1234] Fix pre-commit hook failed on CI\nfatal: Authentication failed',
      ),
    ).toEqual([['commit', true]]);
  });

  it('attributes "nothing added to commit" to the commit, not a later push', () => {
    expect(
      outcomes(
        'git commit -m x && git push',
        'nothing added to commit but untracked files present (use "git add" to track)',
      ),
    ).toEqual([['commit', false]]);
  });
});

describe('classifyGitSegments when the error names no step', () => {
  const resolveRepo = (): string | null => null;
  const GPG = 'error: gpg failed to sign the data\nfatal: failed to write commit object';

  const outcomes = (command: string, error: string): [string, boolean][] =>
    classifyGitSegments(command, makeRecord({ command, success: false, error }), resolveRepo).map(
      ({ event }) => [event.type, event.success],
    );

  it('fails a heredoc-message commit that is the only command', () => {
    // What stripHeredocBodies leaves of `git commit -m "$(cat <<'EOF' ... EOF )"`.
    expect(outcomes('git commit -m "$(cat <<\'EOF\'\n)"', GPG)).toEqual([['commit', false]]);
  });

  it('fails a multi-line quoted commit message that is the only command', () => {
    expect(outcomes('git commit -m "title\n\nbody"', 'Author identity unknown')).toEqual([
      ['commit', false],
    ]);
  });

  it('ignores a trailing comment when finding the last command', () => {
    expect(outcomes("git commit -m x\n# don't push yet", GPG)).toEqual([['commit', false]]);
  });

  it('drops git steps that a failing non-git step ahead of them may have skipped', () => {
    expect(
      outcomes(
        'npm test && git add -A && git commit -m x && git push',
        'FAIL src/a.test.ts\nTests: 1 failed, 4 passed',
      ),
    ).toEqual([]);
  });

  it('drops git steps that an earlier git step may have kept from running', () => {
    expect(outcomes('git add -A && git commit -m x && git push', GPG)).toEqual([
      ['other_git', true],
    ]);
  });
});

// Bash groups `&&` and `||` left to right with equal precedence and reads a
// pipeline as one step, so `a || b && c` is `(a || b) && c`.
describe('classifyGitSegments under bash && and || grouping', () => {
  const resolveRepo = (): string | null => null;
  const GPG = 'error: gpg failed to sign the data\nfatal: failed to write commit object';
  const CONFLICT = 'CONFLICT (content): Merge conflict in a.ts\nAutomatic merge failed';

  const outcomes = (command: string, error: string): [string, boolean][] =>
    classifyGitSegments(command, makeRecord({ command, success: false, error }), resolveRepo).map(
      ({ event }) => [event.type, event.success],
    );

  it('fails a commit whose || fallback ran', () => {
    expect(
      outcomes(
        'git commit -m x || git commit --no-verify -m x',
        'husky - pre-commit script failed (code 1)',
      ),
    ).toEqual([
      ['commit', false],
      ['commit', false],
    ]);
  });

  it('does not mark succeeded a commit that the || before it may have skipped', () => {
    expect(
      outcomes(
        'git diff --quiet || git commit -am wip && git push',
        "fatal: Authentication failed for 'https://github.com/acme/widgets.git/'",
      ),
    ).toEqual([
      ['diff', false],
      ['commit', false],
    ]);
  });

  it('gives conflict text to the earliest step of the && run that can conflict', () => {
    expect(outcomes('git pull && git commit -m merge && git checkout other', CONFLICT)).toEqual([
      ['merge_conflict', false],
    ]);
    expect(outcomes('git pull && git checkout -b feature', CONFLICT)).toEqual([
      ['merge_conflict', false],
    ]);
  });

  it('does not give conflict text to a stash push or a plain checkout', () => {
    expect(outcomes('git stash && git pull && git stash pop', CONFLICT)).toEqual([
      ['stash', true],
      ['merge_conflict', false],
    ]);
    expect(outcomes('git checkout main && git pull', CONFLICT)).toEqual([
      ['other_git', true],
      ['merge_conflict', false],
    ]);
  });

  it('reads a pipeline as one && step', () => {
    expect(outcomes('git commit -m x && git log --oneline | head -1', GPG)).toEqual([
      ['commit', false],
    ]);
  });

  // `x || ( … ) && t` is `(x || ( … )) && t`: when `x` succeeds the group
  // never runs.
  it('does not mark succeeded a step in a group that is the fallback of a ||', () => {
    const REJECTED = ' ! [rejected] main -> main (non-fast-forward)';
    expect(outcomes('git fetch || (git add -A && git commit -m x) && git push', REJECTED)).toEqual([
      ['fetch', false],
      ['commit', false],
      ['push_rejected', false],
    ]);
  });

  it('marks succeeded a step that a pipeline joined by && separates from the failure', () => {
    const REJECTED = ' ! [rejected] main -> main (non-fast-forward)';
    expect(outcomes('git commit -m x && git log -1 | cat && git push', REJECTED)).toEqual([
      ['commit', true],
      ['log', false],
      ['push_rejected', false],
    ]);
  });

  it('does not mark succeeded a failed step when the quotes do not balance, nor drop less', () => {
    expect(outcomes('npm test "x && git add -A && git commit -m x', 'FAIL a.test.ts')).toEqual([]);
  });

  it('marks succeeded the && steps after the first one that follows a ||', () => {
    expect(
      outcomes(
        'git fetch || git pull && git add -A && git commit -m x',
        'husky - pre-commit script failed (code 1)',
      ),
    ).toEqual([
      ['fetch', false],
      ['pull', false],
      ['other_git', true],
      ['commit', false],
    ]);
  });

  // A `;` or newline list exits with its last command's status, so a failed
  // list's last step failed even when the error names an earlier one. The
  // push keeps its `push` type, and its `false` keeps it out of the counts.
  it.each(['git merge feature; git push', 'git merge feature\ngit push'])(
    'keeps a failed final step in `%s` failed when the error names an earlier one',
    (command) => {
      expect(outcomes(command, CONFLICT)).toEqual([
        ['merge_conflict', false],
        ['push', false],
      ]);
    },
  );

  it.each([
    ['git merge-base HEAD origin/main && git rebase origin/main', 'git rebase origin/main'],
    ['git mergetool && git rebase --continue', 'git rebase --continue'],
  ])('gives conflict text in `%s` to the step that can conflict', (command, conflicted) => {
    const conflicts = classifyGitSegments(
      command,
      makeRecord({ command, success: false, error: CONFLICT }),
      resolveRepo,
    )
      .filter(({ event }) => event.type === 'merge_conflict' || event.type === 'rebase_conflict')
      .map(({ segment }) => segment.trim());
    expect(conflicts).toEqual([conflicted]);
  });
});

// One error can hold two failures' text, such as a pull's conflict and the
// rejection of the push it left behind the remote.
describe('classifyGitSegments when the error holds two failures', () => {
  const resolveRepo = (): string | null => null;
  const CONFLICT = 'CONFLICT (content): Merge conflict in a.ts\nAutomatic merge failed';
  const REJECTED = ' ! [rejected] main -> main (non-fast-forward)\nerror: failed to push some refs';

  const events = (command: string, error: string): GitEvent[] =>
    classifyGitSegments(command, makeRecord({ command, success: false, error }), resolveRepo).map(
      ({ event }) => event,
    );
  const outcomes = (command: string, error: string): [string, boolean][] =>
    events(command, error).map((event) => [event.type, event.success]);

  it.each(['git pull; git push', 'git pull\ngit push'])(
    'types the push in `%s` rejected when conflict text names the pull',
    (command) => {
      const [pull, push] = events(command, `${CONFLICT}\n${REJECTED}`);
      expect([pull!.type, pull!.success, pull!.files]).toEqual(['merge_conflict', false, ['a.ts']]);
      expect([push!.type, push!.success, push!.files]).toEqual(['push_rejected', false, undefined]);
    },
  );

  // The stash pop's conflict leaves unmerged files, the commit then refuses
  // to run, and `&&` skips the pull, so the run stopped at the commit.
  it('fails a commit that stopped the && run before the conflict-capable step', () => {
    const UNMERGED = 'error: Committing is not possible because you have unmerged files.';
    const command = 'git stash pop; git commit -m wip && git pull --rebase';
    const [stash, commit, ...rest] = events(command, `${CONFLICT}\n${UNMERGED}`);
    expect([stash!.type, stash!.success, stash!.files]).toEqual([
      'merge_conflict',
      false,
      ['a.ts'],
    ]);
    expect([commit!.type, commit!.success]).toEqual(['commit', false]);
    expect(rest).toEqual([]);
  });

  // git 2.54's output for a stash pop that conflicts after the commit ran:
  // its status block ends in a line that reads like a commit failure.
  it('keeps a commit before a conflicting stash pop succeeded', () => {
    const STASH_POP = [
      '[main 522d323] x',
      'CONFLICT (content): Merge conflict in a.ts',
      'Unmerged paths:',
      '  (use "git restore --staged <file>..." to unstage)',
      '\tboth modified:   a.ts',
      'no changes added to commit (use "git add" and/or "git commit -a")',
    ].join('\n');
    expect(outcomes('git commit -m x && git stash pop', STASH_POP)).toEqual([
      ['commit', true],
      ['merge_conflict', false],
    ]);
  });

  it('does not take a rebase conflict that echoes a commit subject for a failed commit', () => {
    const REBASE =
      'error: could not apply abc1234... Fix pre-commit hook failed on Windows\n' +
      'CONFLICT (content): Merge conflict in a.ts';
    expect(outcomes('git commit -am x && git pull --rebase', REBASE)).toEqual([
      ['commit', true],
      ['merge_conflict', false],
    ]);
  });

  it('looks for the refusing commit in the run of the conflict, not a later one', () => {
    const UNMERGED = 'error: Committing is not possible because you have unmerged files.';
    expect(
      outcomes(
        'git stash pop; git commit -m a && git pull --rebase; git commit -m b',
        `${CONFLICT}\n${UNMERGED}\n${UNMERGED}`,
      ),
    ).toEqual([
      ['merge_conflict', false],
      ['commit', false],
      ['commit', false],
    ]);
  });

  // The merge's conflict leaves markers that `git add -A` stages, and the
  // commit's hook rejects them, so `&&` never runs the rebase.
  it('fails a commit whose hook stopped the run after an earlier conflict', () => {
    const HUSKY = 'husky - pre-commit script failed (code 1)';
    const MERGE = `${CONFLICT}; fix conflicts and then commit the result.`;
    expect(
      outcomes(
        'git merge x; git add -A && git commit -m m && git rebase main',
        `${MERGE}\n${HUSKY}`,
      ),
    ).toEqual([
      ['merge_conflict', false],
      ['other_git', true],
      ['commit', false],
    ]);
  });

  // `git status` prints the unmerged paths, and no step here can conflict.
  it('types a commit refusing over unmerged files from another command as a commit', () => {
    const STATUS = 'Unmerged paths:\n\tboth modified:   a.ts';
    const UNMERGED = 'error: Committing is not possible because you have unmerged files.';
    expect(outcomes('git status && git commit -m x', `${STATUS}\n${UNMERGED}`)).toEqual([
      ['status', true],
      ['commit', false],
    ]);
  });

  // git 2.54 during an unresolved merge: the status block names the unmerged
  // path, the commit refuses, and `&&` never runs the pull. The status, behind
  // a `;`, keeps the command's failure, as every step `&&` doesn't prove does.
  it('fails a commit refusing over unmerged files before a later conflict-capable step', () => {
    const OUTPUT = [
      'Unmerged paths:',
      '\tboth modified:   a.ts',
      'no changes added to commit (use "git add" and/or "git commit -a")',
      'error: Committing is not possible because you have unmerged files.',
    ].join('\n');
    expect(outcomes('git status; git commit -m x && git pull', OUTPUT)).toEqual([
      ['status', false],
      ['commit', false],
    ]);
  });

  // The commit landed and printed its subject; the pull then conflicted.
  it('does not read the subject of a landed commit as its failure', () => {
    const OUTPUT = [
      '[main abc1234] Fix pre-commit hook failed on CI',
      ' 1 file changed, 1 insertion(+)',
      'CONFLICT (content): Merge conflict in a.ts',
      'Automatic merge failed; fix conflicts and then commit the result.',
    ].join('\n');
    expect(
      outcomes(
        'git stash pop; git add -A && git commit -m "Fix pre-commit hook failed on CI" && git pull',
        OUTPUT,
      ),
    ).toEqual([
      ['stash', false],
      ['other_git', true],
      ['commit', true],
      ['merge_conflict', false],
    ]);
  });

  // git 2.54: the first commit lands, the merge conflicts, and the commit
  // after the `;` is the one that refuses over the unmerged files.
  it('leaves a refusal to the commit after a conflict, not one that landed before it', () => {
    const OUTPUT = [
      '[main 0327490] wip',
      'CONFLICT (content): Merge conflict in a.ts',
      'Automatic merge failed; fix conflicts and then commit the result.',
      'error: Committing is not possible because you have unmerged files.',
    ].join('\n');
    expect(outcomes('git commit -m wip && git merge other; git commit --no-edit', OUTPUT)).toEqual([
      ['commit', true],
      ['merge_conflict', false],
      ['commit', false],
    ]);
  });

  it('does not read a refusal named in a landed commit subject as the refusal', () => {
    const OUTPUT = [
      '[main abc1234] Document Committing is not possible error',
      'CONFLICT (content): Merge conflict in a.ts',
      'Automatic merge failed; fix conflicts and then commit the result.',
    ].join('\n');
    expect(
      outcomes(
        'git add -A && git commit -m "Document Committing is not possible error" && git pull --no-rebase origin main',
        OUTPUT,
      ),
    ).toEqual([
      ['other_git', true],
      ['commit', true],
      ['merge_conflict', false],
    ]);
  });

  // git 2.54 during an unresolved merge: only `git status` printed the
  // unmerged paths, so the merge never ran and commit a is the refuser.
  it('fails the first refusing commit when only a status block named the conflict', () => {
    const STATUS = 'Unmerged paths:\n\tboth modified:   a.ts';
    const UNMERGED = 'error: Committing is not possible because you have unmerged files.';
    expect(
      outcomes(
        'git status; git commit -m a && git merge other; git commit -m b',
        `${STATUS}\n${UNMERGED}\n${UNMERGED}`,
      ),
    ).toEqual([
      ['status', false],
      ['commit', false],
      ['commit', false],
    ]);
  });

  // `&&` skips the commit after the pull, so it can't be the one that refused.
  it('ignores a later commit that && kept from running', () => {
    const STATUS = 'Unmerged paths:\n\tboth modified:   a.ts';
    const UNMERGED = 'error: Committing is not possible because you have unmerged files.';
    expect(
      outcomes(
        'git status; git commit -m x && git pull && git commit -m y',
        `${STATUS}\n${UNMERGED}`,
      ),
    ).toEqual([
      ['status', false],
      ['commit', false],
    ]);
  });

  it('does not take a revert conflict that echoes a commit subject for a failed commit', () => {
    const REVERT =
      'error: could not revert abc1234... Fix pre-commit hook failed on Windows\n' +
      'CONFLICT (content): Merge conflict in a.ts';
    expect(outcomes('git stash pop; git commit -m x && git revert abc1234', REVERT)).toEqual([
      ['stash', false],
      ['commit', true],
      ['merge_conflict', false],
    ]);
  });

  // git 2.54: `git checkout -m` leaves the path unmerged without a CONFLICT
  // line, and the status after it reports it, so commit b is the refuser.
  it('keeps a landed commit when a status after checkout -m names the conflict', () => {
    const OUTPUT = [
      '[main 792a4f1] a',
      "Switched to branch 'other'",
      'M\tf',
      'Unmerged paths:',
      '\tboth modified:   f',
      'error: Committing is not possible because you have unmerged files.',
    ].join('\n');
    const steps = outcomes(
      'git commit -m a && git checkout -m other && git status && git commit -m b',
      OUTPUT,
    );
    expect(steps[0]).toEqual(['commit', true]);
  });

  // git 2.54: `git apply --3way` prints no CONFLICT line either.
  it('keeps a landed commit when a status after apply --3way names the conflict', () => {
    const OUTPUT = [
      '[main 792a4f1] a',
      "Applied patch to 'f' with conflicts.",
      'U f',
      'Unmerged paths:',
      '\tboth modified:   f',
      'error: Committing is not possible because you have unmerged files.',
    ].join('\n');
    const steps = outcomes(
      'git commit -m a && git apply --3way fix.patch; git status; git commit -m b',
      OUTPUT,
    );
    expect(steps[0]).toEqual(['commit', true]);
  });

  // git 2.54's rebase conflict echoes the stopped commit twice, the second
  // time with no `error:` prefix.
  it('does not read either rebase echo of a commit subject as a failure', () => {
    const OUTPUT = [
      'error: could not apply 660f0d8... Fix pre-commit hook failed on CI',
      'CONFLICT (content): Merge conflict in a.ts',
      'Could not apply 660f0d8... # Fix pre-commit hook failed on CI',
    ].join('\n');
    expect(outcomes('git stash pop; git commit -m x && git rebase main', OUTPUT)).toEqual([
      ['stash', false],
      ['commit', true],
      ['merge_conflict', false],
    ]);
  });

  it('types the push that ran rejected, not one && then kept from running', () => {
    // The first push's rejection is why `||` ran the pull; its conflict then
    // stopped the second push.
    expect(
      outcomes('git push || git pull --rebase && git push', `${REJECTED}\n${CONFLICT}`),
    ).toEqual([
      ['push_rejected', false],
      ['merge_conflict', false],
    ]);
  });

  it('keeps a push && proves succeeded when conflict output mentions a rejection', () => {
    // A rebase that stops on a commit whose subject says "non-fast-forward".
    const stopped = `CONFLICT (content): Merge conflict in a.ts\nerror: could not apply 1a2b3c... Handle non-fast-forward retry`;
    expect(outcomes('git push && git pull --rebase && git push', stopped)).toEqual([
      ['push', true],
      ['merge_conflict', false],
    ]);
  });

  it('types a rejected push before the conflicting step rejected', () => {
    expect(outcomes('git push; git pull', `${REJECTED}\n${CONFLICT}`)).toEqual([
      ['push_rejected', false],
      ['merge_conflict', false],
    ]);
  });

  it('types a rejected push before a commit that names the error rejected', () => {
    expect(
      outcomes('git push; git commit -m x', `${REJECTED}\nnothing to commit, working tree clean`),
    ).toEqual([
      ['push_rejected', false],
      ['commit', false],
    ]);
  });

  it('records no push that the conflict kept from running', () => {
    expect(outcomes('git pull && git push', `${CONFLICT}\n${REJECTED}`)).toEqual([
      ['merge_conflict', false],
    ]);
  });
});

describe('classifyGitSegments shell splitting', () => {
  const resolveRepo = (): string | null => null;
  const NOTHING = 'nothing to commit, working tree clean';

  it('splits a continued line made of a long run of # in linear time', () => {
    // `git push ||` continues past comment-only lines; the line after the run
    // of `#` is a real command, so the continuation check must fail fast.
    const command = `git push ||\n${'#'.repeat(5000)}\necho done\ngit commit -m x`;
    const startedAt = performance.now();
    const events = classifyGitSegments(
      command,
      makeRecord({ command, success: true }),
      resolveRepo,
    ).map(({ event }) => event.type);
    expect(performance.now() - startedAt).toBeLessThan(1000);
    expect(events).toEqual(['push', 'commit']);
  });

  const outcomes = (command: string, error: string): [string, boolean][] =>
    classifyGitSegments(command, makeRecord({ command, success: false, error }), resolveRepo).map(
      ({ event }) => [event.type, event.success],
    );

  it('drops a push chained after a heredoc-message commit that failed', () => {
    expect(outcomes('git commit -m "$(cat <<\'EOF\'\n)" && git push', NOTHING)).toEqual([
      ['commit', false],
    ]);
  });

  it('does not split on an operator inside a quoted commit message', () => {
    expect(outcomes('git commit -m "a; b" && git push', NOTHING)).toEqual([['commit', false]]);
  });

  it('reads a backslash or an operator before a newline as one command line', () => {
    const committed: [string, boolean][] = [
      ['other_git', true],
      ['commit', false],
    ];
    expect(outcomes('git add -A && \\\ngit commit -m x && \\\ngit push', NOTHING)).toEqual(
      committed,
    );
    expect(outcomes('git add -A &&\ngit commit -m x &&\ngit push', NOTHING)).toEqual(committed);
  });

  it('ignores quotes inside a # comment', () => {
    expect(outcomes("# don't\ngit commit -m x && git push\n# won't", NOTHING)).toEqual([
      ['commit', false],
    ]);
  });

  // bash refuses a command whose quote never closes, so in a failed one the
  // `&&` may be text inside the open quote and nothing may have run.
  it('marks no step succeeded by && when the quotes of a failed command do not balance', () => {
    const REJECTED = ' ! [rejected] main -> main (non-fast-forward)';
    expect(outcomes('git commit -m "x && git push', REJECTED)).toEqual([
      ['commit', false],
      ['push_rejected', false],
    ]);
  });

  const succeeded = (command: string): [string, boolean][] =>
    classifyGitSegments(command, makeRecord({ command, success: true }), resolveRepo).map(
      ({ event }) => [event.type, event.success],
    );

  // A command that ran had balanced quotes, so the scan misread them, and
  // its steps keep the command's success.
  it('keeps every step of a succeeded command whose quotes do not balance', () => {
    expect(succeeded("git commit -m $'it\\'s done' && git push")).toEqual([
      ['commit', true],
      ['push', true],
    ]);
  });

  // A background job's exit status never reaches the command's.
  it.each([
    [
      'git commit -m x & git push',
      [
        ['commit', false],
        ['push', true],
      ],
    ],
    ['git push &', [['push', false]]],
    [
      'git add -A && git commit -m x & wait',
      [
        ['other_git', false],
        ['commit', false],
      ],
    ],
  ])('does not mark a step that `&` backgrounds in `%s` succeeded', (command, expected) => {
    expect(succeeded(command)).toEqual(expected);
  });

  it('leaves a # comment out of the step it follows', () => {
    expect(succeeded('git push origin main # not --force yet')).toEqual([['push', true]]);
    expect(succeeded('git commit -m x # --amend later')).toEqual([['commit', true]]);
  });

  it('reads a # after an escaped space as text', () => {
    expect(succeeded('git commit -m fix\\ #12 && git push')).toEqual([
      ['commit', true],
      ['push', true],
    ]);
  });
});
