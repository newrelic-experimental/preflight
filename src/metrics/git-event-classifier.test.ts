import { classifyGitCommand } from './git-event-classifier.js';
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
