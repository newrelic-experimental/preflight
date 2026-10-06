import { classifyGitCommand, classifyGitSegments } from './git-event-classifier.js';
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
    expect(classify('git pull; git push', CONFLICT)).toEqual(['merge_conflict', 'push']);
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

  it('keeps the command outcome for a step after a ; that the error does not name', () => {
    expect(outcomes('git merge feature; git push', CONFLICT)).toEqual([
      ['merge_conflict', false],
      ['push', false],
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

  it('splits on every operator when the quotes do not balance', () => {
    const REJECTED = ' ! [rejected] main -> main (non-fast-forward)';
    expect(outcomes('git commit -m "x && git push', REJECTED)).toEqual([
      ['commit', true],
      ['push_rejected', false],
    ]);
  });
});
