import { basename, join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import {
  spawnSync as nodeSpawnSync,
  type SpawnSyncOptions,
  type SpawnSyncReturns,
} from 'node:child_process';
import { jest } from '@jest/globals';
import { GitActivityRecorder } from './git-activity-recorder.js';
import { processGhCommand, splitShellSegments } from './git-event-classifier.js';
import { ActivityStore } from './git-activity-store.js';
import type { GitActivityRecord } from './git-activity-recorder.js';
import { WorktreeIdentityResolver } from './git-workspace-identity.js';
import type { ToolCallRecord } from '../storage/types.js';

// git sets GIT_DIR/GIT_WORK_TREE for hook subprocesses (e.g. a pre-push
// hook), which override `-C <dir>` and silently redirect every fixture call
// below to the real repo instead of the isolated temp dir under test.
// `delete process.env.GIT_DIR` does not reliably reach whatever these
// child processes actually inherit, so every call goes through this
// wrapper instead, which strips both via an explicit `env` option.
const CLEAN_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
};

function spawnSync(
  command: string,
  args?: readonly string[],
  options?: SpawnSyncOptions,
): SpawnSyncReturns<string | Buffer> {
  return nodeSpawnSync(command, args, { ...options, env: CLEAN_ENV });
}

const makeRecord = (overrides?: Partial<ToolCallRecord>): ToolCallRecord => ({
  id: 'test-id',
  sessionId: 'test-session',
  toolName: 'Bash',
  toolUseId: 'tool-1',
  timestamp: 1000,
  durationMs: 100,
  success: true,
  ...overrides,
});

describe('GitActivityRecorder', () => {
  let store: ActivityStore<GitActivityRecord>;
  let identityResolver: WorktreeIdentityResolver;
  let recorder: GitActivityRecorder;
  let repoDir: string;

  beforeEach(() => {
    store = new ActivityStore();
    identityResolver = new WorktreeIdentityResolver();
    recorder = new GitActivityRecorder(store, identityResolver);

    // Create a temporary git repo for testing
    repoDir = mkdtempSync(join('/tmp', 'git-activity-'));
    spawnSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
    spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir, stdio: 'ignore' });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: repoDir,
      stdio: 'ignore',
    });
    // Identity resolution needs a real HEAD to resolve a branch name from —
    // an unborn HEAD (no commits yet) is a real, separately-tested case in
    // git-workspace-identity.test.ts, but these tests are about workspaceKey
    // attribution, not that edge case, so give the fixture a normal HEAD.
    spawnSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repoDir, stdio: 'ignore' });
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  describe('git command tracking', () => {
    it('records a git commit command as a git activity', () => {
      const ingestSpy = jest.spyOn(store, 'ingest');

      const record = makeRecord({
        command: 'git commit -m "test"',
        cwd: repoDir,
        timestamp: 5000,
      });

      recorder.recordToolCall(record);

      // First, verify that ingest() was called
      expect(ingestSpy).toHaveBeenCalled();

      const results = store.query({ since: 0, until: 10000 });

      expect(results.length).toBeGreaterThan(0);
      const gitActivity = results.find((r) => r.kind === 'git');
      expect(gitActivity).toBeDefined();
      if (gitActivity && gitActivity.kind === 'git') {
        expect(gitActivity.gitEvent.type).toBe('commit');
      }

      ingestSpy.mockRestore();
    });

    it('records git command with correct workspaceKey', () => {
      const record = makeRecord({
        command: 'git push origin main',
        cwd: repoDir,
        timestamp: 5000,
      });

      recorder.recordToolCall(record);

      const identity = identityResolver.resolve(repoDir);
      expect(identity).not.toBeNull();

      const results = store.query({ since: 0, until: 10000 });

      expect(results.length).toBeGreaterThanOrEqual(1);
      const gitActivity = results.find((r) => r.kind === 'git');
      expect(gitActivity).toBeDefined();
      if (gitActivity) {
        expect(gitActivity.workspaceKey).toBe(identity!.worktreeKey);
      }
    });
  });

  describe('file edit tracking', () => {
    it('records an Edit tool call with filePath', () => {
      const record = makeRecord({
        toolName: 'Edit',
        filePath: '/path/to/file.ts',
        cwd: repoDir,
      });

      recorder.recordToolCall(record);

      const results = store.query({
        since: 0,
        until: Date.now() + 1000,
      });

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        kind: 'edit',
        filePath: '/path/to/file.ts',
      });
    });

    it('records a Write tool call with filePath', () => {
      const record = makeRecord({
        toolName: 'Write',
        filePath: '/path/to/file.ts',
        cwd: repoDir,
      });

      recorder.recordToolCall(record);

      const results = store.query({
        since: 0,
        until: Date.now() + 1000,
      });

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        kind: 'edit',
        filePath: '/path/to/file.ts',
      });
    });

    it('ignores Edit tool without filePath', () => {
      const record = makeRecord({
        toolName: 'Edit',
        filePath: undefined,
        cwd: repoDir,
      });

      recorder.recordToolCall(record);

      const results = store.query({
        since: 0,
        until: Date.now() + 1000,
      });

      expect(results).toHaveLength(0);
    });
  });

  describe('build/test tracking', () => {
    it('records build command as verify activity', () => {
      const record = makeRecord({
        toolName: 'Bash',
        isBuildCommand: true,
        cwd: repoDir,
      });

      recorder.recordToolCall(record);

      const results = store.query({
        since: 0,
        until: Date.now() + 1000,
      });

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        kind: 'verify',
      });
      expect(results[0].kind === 'verify' && results[0].verify).toBe('build');
    });

    it('records test command as verify activity', () => {
      const record = makeRecord({
        toolName: 'Bash',
        isTestCommand: true,
        cwd: repoDir,
      });

      recorder.recordToolCall(record);

      const results = store.query({
        since: 0,
        until: Date.now() + 1000,
      });

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        kind: 'verify',
      });
      expect(results[0].kind === 'verify' && results[0].verify).toBe('test');
    });
  });

  describe('MCP PR tool tracking', () => {
    it('records MCP create_pull_request tool call as PR activity', () => {
      const record = makeRecord({
        toolName: 'create_pull_request',
        cwd: repoDir,
      });

      recorder.recordToolCall(record);

      const results = store.query({
        since: 0,
        until: Date.now() + 1000,
      });

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        kind: 'pr',
      });
      expect(results[0].kind === 'pr' && results[0].prEvent.action).toBe('create');
      expect(results[0].kind === 'pr' && results[0].prEvent.prNumber).toBeNull();
    });

    it('records MCP update_pull_request tool call as PR activity', () => {
      const record = makeRecord({
        toolName: 'update_pull_request',
        cwd: repoDir,
      });

      recorder.recordToolCall(record);

      const results = store.query({
        since: 0,
        until: Date.now() + 1000,
      });

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        kind: 'pr',
      });
      expect(results[0].kind === 'pr' && results[0].prEvent.action).toBe('edit');
    });
  });

  describe('gh CLI PR tracking', () => {
    it('records gh pr create command as PR activity', () => {
      const record = makeRecord({
        command: 'gh pr create --title "test"',
        cwd: repoDir,
      });

      recorder.recordToolCall(record);

      const results = store.query({
        since: 0,
        until: Date.now() + 1000,
      });

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        kind: 'pr',
      });
      expect(results[0].kind === 'pr' && results[0].prEvent.action).toBe('create');
    });

    it('uses the PR number captured from the output as the create event prNumber', () => {
      recorder.recordToolCall(
        makeRecord({ command: 'gh pr create --fill', cwd: repoDir, createdPrNumber: '42' }),
      );
      recorder.recordToolCall(
        makeRecord({
          id: 'mcp',
          toolUseId: 'tool-2',
          toolName: 'create_pull_request',
          cwd: repoDir,
          createdPrNumber: '57',
        }),
      );

      const numbers = store
        .query({ since: 0, until: Date.now() + 1000 })
        .map((r) => (r.kind === 'pr' ? r.prEvent.prNumber : undefined));
      expect(numbers.sort()).toEqual(['42', '57']);
    });

    it('records gh pr merge command as PR activity', () => {
      const record = makeRecord({
        command: 'gh pr merge 123',
        cwd: repoDir,
      });

      recorder.recordToolCall(record);

      const results = store.query({
        since: 0,
        until: Date.now() + 1000,
      });

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        kind: 'pr',
      });
      expect(results[0].kind === 'pr' && results[0].prEvent.action).toBe('merge');
      expect(results[0].kind === 'pr' && results[0].prEvent.prNumber).toBe('123');
    });
  });

  describe('non-git repo handling', () => {
    it('uses unattributed workspaceKey for non-git directories', () => {
      const nonGitDir = mkdtempSync(join('/tmp', 'non-git-'));

      try {
        const record = makeRecord({
          command: 'git commit -m "test"',
          cwd: nonGitDir,
        });

        recorder.recordToolCall(record);

        const results = store.query({
          since: 0,
          until: Date.now() + 1000,
          keys: ['unattributed'],
        });

        expect(results).toHaveLength(1);
        expect(results[0].workspaceKey).toBe('unattributed');
      } finally {
        rmSync(nonGitDir, { recursive: true, force: true });
      }
    });
  });

  describe('record ID deduplication', () => {
    it('uses toolUseId for recordId when available', () => {
      const record = makeRecord({
        command: 'git commit -m "test"',
        cwd: repoDir,
        toolUseId: 'stable-id-123',
      });

      recorder.recordToolCall(record);
      recorder.recordToolCall(record); // Record same thing twice

      const results = store.query({
        since: 0,
        until: Date.now() + 1000,
      });

      expect(results).toHaveLength(1); // Only one record due to dedup
    });

    it('falls back to generated recordId when toolUseId is empty', () => {
      const record = makeRecord({
        command: 'git commit -m "test"',
        cwd: repoDir,
        toolUseId: '', // Empty string
        sessionId: 'session-1',
        timestamp: 5000,
      });

      recorder.recordToolCall(record);

      const results = store.query({
        since: 0,
        until: Date.now() + 1000,
      });

      expect(results).toHaveLength(1);
      // Generated recordId format: ${sessionId}:${timestamp}:${toolName}:${discriminator}
      // — the discriminator suffix is what lets one record produce more than
      // one activity (e.g. a build command that's also a git command)
      // without the two colliding in the store's dedup. The `-0` is the
      // segment's index in the (single-segment, here) split command.
      expect(results[0].recordId).toBe('session-1:5000:Bash:git-0');
    });
  });

  describe('processGhCommand standalone function', () => {
    it('extracts PR action and number from gh commands', () => {
      const event = processGhCommand('gh pr create --title "test"', 1000);
      expect(event).toMatchObject({
        action: 'create',
        prNumber: null,
        timestamp: 1000,
      });
    });

    it('extracts PR number when present', () => {
      const event = processGhCommand('gh pr merge 456', 1000);
      expect(event).toMatchObject({
        action: 'merge',
        prNumber: '456',
        timestamp: 1000,
      });
    });

    it('returns null for unrecognized gh commands', () => {
      const event = processGhCommand('gh issue create', 1000);
      expect(event).toBeNull();
    });
  });

  describe('multiple activities from one record', () => {
    it('records both git command and build command if both conditions met', () => {
      const record = makeRecord({
        command: 'npm run build && git commit -m "build"',
        isBuildCommand: true,
        cwd: repoDir,
        timestamp: 5000,
      });

      recorder.recordToolCall(record);

      const results = store.query({
        since: 0,
        until: 10000,
      });

      // Should have build verify + git command
      expect(results.length).toBeGreaterThanOrEqual(2);
      const kinds = results.map((r) => r.kind).sort();
      expect(kinds).toContain('verify');
      expect(kinds).toContain('git');
    });
  });

  describe('per-segment git classification (chained commands)', () => {
    it('keeps every git verb in a chained commit+push instead of only the first match', () => {
      const record = makeRecord({
        command: 'git add -A && git commit -m x && git push',
        cwd: repoDir,
        timestamp: 5000,
      });

      recorder.recordToolCall(record);

      const results = store.query({ since: 0, until: 10000 });
      const gitResults = results.filter((r) => r.kind === 'git');

      const commitRecord = gitResults.find((r) => r.recordId.endsWith(':git-1'));
      const pushRecord = gitResults.find((r) => r.recordId.endsWith(':git-2'));
      expect(commitRecord).toBeDefined();
      expect(pushRecord).toBeDefined();
      expect(commitRecord?.kind === 'git' && commitRecord.gitEvent.type).toBe('commit');
      expect(pushRecord?.kind === 'git' && pushRecord.gitEvent.type).toBe('push');
    });

    it('ignores a segment that only mentions git inside quoted text', () => {
      recorder.recordToolCall(
        makeRecord({
          command: `printf 'not json but has git commit inside' > /tmp/in.json`,
          cwd: repoDir,
          timestamp: 5000,
        }),
      );

      expect(store.query({ since: 0, until: 10000 }).filter((r) => r.kind === 'git')).toHaveLength(
        0,
      );
    });

    it('still classifies git behind env assignments or a path prefix', () => {
      recorder.recordToolCall(
        makeRecord({
          command: 'GIT_EDITOR=true /usr/bin/git commit -m x',
          cwd: repoDir,
          timestamp: 5000,
        }),
      );

      const gitResults = store.query({ since: 0, until: 10000 }).filter((r) => r.kind === 'git');
      expect(gitResults).toHaveLength(1);
      expect(gitResults[0].kind === 'git' && gitResults[0].gitEvent.type).toBe('commit');
    });

    it('attributes a conflict error to the git segment that actually ran last', () => {
      const record = makeRecord({
        command: 'git fetch && git rebase origin/main',
        cwd: repoDir,
        timestamp: 5000,
        error: 'fatal: rebase conflict: could not apply 1234567... commit message',
      });

      recorder.recordToolCall(record);

      const results = store.query({ since: 0, until: 10000 });
      const gitResults = results.filter((r) => r.kind === 'git');

      const fetchRecord = gitResults.find((r) => r.recordId.endsWith(':git-0'));
      const rebaseRecord = gitResults.find((r) => r.recordId.endsWith(':git-1'));
      expect(fetchRecord?.kind === 'git' && fetchRecord.gitEvent.type).toBe('fetch');
      expect(rebaseRecord?.kind === 'git' && rebaseRecord.gitEvent.type).toBe('rebase_conflict');
    });
  });

  describe('gh PR create/success gating and shell-segment parsing', () => {
    const prRecords = () => store.query({ since: 0, until: 10000 }).filter((r) => r.kind === 'pr');

    it('does not count a failed gh pr create as a PR', () => {
      recorder.recordToolCall(
        makeRecord({ command: 'gh pr create --title x', cwd: repoDir, success: false }),
      );
      expect(prRecords()).toHaveLength(0);
    });

    it('does not count a failed gh pr merge as a merge', () => {
      recorder.recordToolCall(
        makeRecord({ command: 'gh pr merge 5', cwd: repoDir, success: false }),
      );
      expect(prRecords()).toHaveLength(0);
    });

    it('still counts a failed gh pr checks — a verb that changes nothing stays real on failure', () => {
      recorder.recordToolCall(
        makeRecord({ command: 'gh pr checks 5', cwd: repoDir, success: false }),
      );
      const results = prRecords();
      expect(results).toHaveLength(1);
      expect(results[0].kind === 'pr' && results[0].prEvent.action).toBe('checks');
      expect(results[0].kind === 'pr' && results[0].prEvent.prNumber).toBe('5');
    });

    it.each(['gh pr merge 5 --auto --squash', 'gh pr merge 5 --disable-auto'])(
      'does not count `%s`, which only toggles auto-merge, as a merge',
      (command) => {
        recorder.recordToolCall(makeRecord({ command, cwd: repoDir }));
        expect(prRecords()).toHaveLength(0);
      },
    );

    it.each([
      'gh pr merge 5 -R acme/other',
      'gh pr merge 5 -Racme/other',
      'gh pr merge 5 -dR acme/other',
      'gh pr merge 5 --repo acme/other',
      'gh pr merge 5 --repo=acme/other',
      'GH_REPO=acme/other gh pr merge 5',
    ])('keeps `%s` as a merge but drops a number aimed at another repo', (command) => {
      recorder.recordToolCall(makeRecord({ command, cwd: repoDir }));
      const results = prRecords();
      expect(results).toHaveLength(1);
      expect(results[0].kind === 'pr' && results[0].prEvent.action).toBe('merge');
      expect(results[0].kind === 'pr' && results[0].prEvent.prNumber).toBeNull();
    });

    it('does not attach the captured number to a gh pr create aimed at another repo', () => {
      recorder.recordToolCall(
        makeRecord({
          command: 'gh pr create --fill -R acme/other',
          cwd: repoDir,
          createdPrNumber: '42',
        }),
      );
      const results = prRecords();
      expect(results).toHaveLength(1);
      expect(results[0].kind === 'pr' && results[0].prEvent.action).toBe('create');
      expect(results[0].kind === 'pr' && results[0].prEvent.prNumber).toBeNull();
    });

    it('keeps the number of a merge with unrelated flags', () => {
      recorder.recordToolCall(
        makeRecord({ command: 'gh pr merge 5 --rebase -d --admin', cwd: repoDir }),
      );
      const results = prRecords();
      expect(results).toHaveLength(1);
      expect(results[0].kind === 'pr' && results[0].prEvent.prNumber).toBe('5');
    });

    it('does not mistake a piped-in fixture string for a real gh pr create', () => {
      recorder.recordToolCall(
        makeRecord({
          command: `printf '{"tool_input":{"command":"gh pr create"}}' | node script.js`,
          cwd: repoDir,
        }),
      );
      expect(prRecords()).toHaveLength(0);
    });

    it('does not mistake "gh pr create" inside a comment body for a real create', () => {
      recorder.recordToolCall(
        makeRecord({ command: 'gh pr comment 5 --body "see gh pr create"', cwd: repoDir }),
      );
      expect(prRecords()).toHaveLength(0);
    });

    it('finds a real gh pr create after a heredoc body, on its own newline-separated segment', () => {
      recorder.recordToolCall(
        makeRecord({
          command:
            "cat > body.md <<'EOF'\nsome text\nEOF\ngh pr create --title x --body-file body.md",
          cwd: repoDir,
        }),
      );
      const results = prRecords();
      expect(results).toHaveLength(1);
      expect(results[0].kind === 'pr' && results[0].prEvent.action).toBe('create');
    });

    it('recognizes gh pr create prefixed with an env-var assignment', () => {
      recorder.recordToolCall(
        makeRecord({ command: 'GH_TOKEN=abc gh pr create --title x', cwd: repoDir }),
      );
      const results = prRecords();
      expect(results).toHaveLength(1);
      expect(results[0].kind === 'pr' && results[0].prEvent.action).toBe('create');
    });

    it('recognizes gh pr create chained after a cd', () => {
      recorder.recordToolCall(
        makeRecord({ command: 'cd /somewhere && gh pr create --title x', cwd: repoDir }),
      );
      const results = prRecords();
      expect(results).toHaveLength(1);
      expect(results[0].kind === 'pr' && results[0].prEvent.action).toBe('create');
    });
  });

  describe('gh pr merge and create inside compound commands', () => {
    const prEvents = () =>
      store
        .query({ since: 0, until: 10000 })
        .flatMap((r) => (r.kind === 'pr' ? [r.prEvent] : []))
        .map(({ action, prNumber }) => ({ action, prNumber }));
    const merges = () => prEvents().filter((e) => e.action === 'merge');

    it.each([
      'gh pr merge 42 --squash 2>&1 | tail -5',
      'gh pr merge 42 --squash || echo "merge failed"',
      'gh pr merge 42 --squash; echo done',
      'gh pr merge 42 --squash\necho done',
      'gh pr merge 42 --squash && echo ok || echo failed',
      'gh pr view 42 --json state | grep -q MERGED || gh pr merge 42',
      'gh pr merge 42 --squash --auto ||\n  gh pr merge 42 --squash',
      'gh pr merge 42 --squash --auto || \\\n  gh pr merge 42 --squash',
      'gh pr view 42 --json state | grep -q MERGED ||\n\n  gh pr merge 42',
      'gh pr view 42 --json state | grep -q MERGED || # not merged yet\n  gh pr merge 42',
      "gh pr merge 42 --auto --body-file - <<'EOF' ||\nQueued.\nEOF\ngh pr merge 42 --squash",
      'gh pr view 42 --json state | grep -q MERGED || (echo merging; gh pr merge 42)',
      'gh pr view 42 --json state | grep -q MERGED || { echo merging; gh pr merge 42; }',
      'gh pr merge 42 --squash &',
      'gh pr checks 42 --watch && gh pr merge 42 --squash &',
    ])('drops `%s`: the command can succeed while the merge failed or never ran', (command) => {
      recorder.recordToolCall(makeRecord({ command, cwd: repoDir, success: true }));
      expect(merges()).toEqual([]);
    });

    it.each([
      'gh pr merge 42 --squash',
      'gh pr merge 42 --squash;',
      'git fetch && gh pr merge 42 --squash',
      'gh pr view 42 | cat; gh pr merge 42 --squash',
      'gh pr merge 42 --squash && git checkout main && git pull',
      'gh pr merge 42 --squash && git pull 2>&1 | tail -3',
      'gh pr merge 42 \\\n  --squash',
      'gh pr merge 42 --squash &&\n  git pull',
      "gh pr merge 42 --squash --body-file - <<'EOF' &&\nMerged.\nEOF\ngit pull",
      '{ git fetch && gh pr merge 42 --squash; }',
      'gh pr merge 42 --squash &>/dev/null',
      'sleep 1 & gh pr merge 42 --squash',
    ])('counts `%s`, whose success means the merge succeeded', (command) => {
      recorder.recordToolCall(makeRecord({ command, cwd: repoDir, success: true }));
      expect(merges()).toEqual([{ action: 'merge', prNumber: '42' }]);
    });

    it('drops a merge the Bash tool ran in the background, whose success came before the merge', () => {
      recorder.recordToolCall(
        makeRecord({
          command: 'gh pr checks 42 --watch && gh pr merge 42 --squash',
          cwd: repoDir,
          runInBackground: true,
        }),
      );
      expect(merges()).toEqual([]);
    });

    it.each([
      'echo "then && gh pr merge 42"',
      'gh pr comment 7 --body "LGTM.\ngh pr merge 42 once CI is green"',
    ])('finds no merge in quoted text: `%s`', (command) => {
      recorder.recordToolCall(makeRecord({ command, cwd: repoDir }));
      expect(merges()).toEqual([]);
    });

    it('drops the captured create number when --repo is on a continued line', () => {
      recorder.recordToolCall(
        makeRecord({
          command: 'gh pr create --fill \\\n  --repo acme/other',
          cwd: repoDir,
          createdPrNumber: '42',
        }),
      );
      expect(prEvents()).toEqual([{ action: 'create', prNumber: null }]);
    });

    it('gives no number to either create when one command opens two PRs', () => {
      recorder.recordToolCall(
        makeRecord({
          command:
            'gh pr create --base main --fill && git checkout part-2 && gh pr create --base part-1 --fill',
          cwd: repoDir,
          createdPrNumber: '42',
        }),
      );
      expect(prEvents()).toEqual([
        { action: 'create', prNumber: null },
        { action: 'create', prNumber: null },
      ]);
    });

    it('keeps the captured number when one create shares a command with other gh verbs', () => {
      recorder.recordToolCall(
        makeRecord({
          command: 'gh pr create --fill && gh pr view --web',
          cwd: repoDir,
          createdPrNumber: '42',
        }),
      );
      expect(prEvents()).toContainEqual({ action: 'create', prNumber: '42' });
    });

    describe('a cd or GH_REPO earlier in the command', () => {
      let otherRepo: string;

      beforeEach(() => {
        otherRepo = mkdtempSync(join('/tmp', 'git-activity-other-'));
        spawnSync('git', ['init'], { cwd: otherRepo, stdio: 'ignore' });
        mkdirSync(join(repoDir, 'sub'));
      });

      afterEach(() => {
        rmSync(otherRepo, { recursive: true, force: true });
      });

      it.each([
        ['an absolute cd into another repo', () => `cd ${otherRepo} && gh pr merge 12`],
        ['a relative cd into another repo', () => `cd ../${basename(otherRepo)} && gh pr merge 12`],
        ['a cd in a subshell', () => `(cd "${otherRepo}" && gh pr merge 12)`],
        ['a cd that cannot be resolved', () => 'cd "$OTHER" && gh pr merge 12'],
        ['a bare cd', () => 'cd; gh pr merge 12'],
        ['an exported GH_REPO', () => 'export GH_REPO=acme/other; gh pr merge 12'],
        ['a GH_REPO assignment', () => 'GH_REPO=acme/other\ngh pr merge 12'],
        ['a pushd into another repo', () => `pushd ${otherRepo} && gh pr merge 12`],
        ['a builtin cd into another repo', () => `builtin cd ${otherRepo} && gh pr merge 12`],
        ['a cd in a brace group', () => `{ cd ${otherRepo} && gh pr merge 12; }`],
      ])('keeps the merge after %s but drops its number', (_label, command) => {
        recorder.recordToolCall(makeRecord({ command: command(), cwd: repoDir }));
        expect(merges()).toEqual([{ action: 'merge', prNumber: null }]);
      });

      it('drops the captured create number after a cd into another repo', () => {
        recorder.recordToolCall(
          makeRecord({
            command: `cd ${otherRepo} && gh pr create --fill`,
            cwd: repoDir,
            createdPrNumber: '42',
          }),
        );
        expect(prEvents()).toEqual([{ action: 'create', prNumber: null }]);
      });

      it.each([
        ['into the same repo', () => `cd ${repoDir} && gh pr merge 12`],
        ['into a subdirectory of the same repo', () => 'cd sub && gh pr merge 12'],
      ])('keeps the number after a cd %s', (_label, command) => {
        recorder.recordToolCall(makeRecord({ command: command(), cwd: repoDir }));
        expect(merges()).toEqual([{ action: 'merge', prNumber: '12' }]);
      });

      it('does not look up a cd target that does not exist', () => {
        const resolve = jest.spyOn(identityResolver, 'resolve');
        recorder.recordToolCall(
          makeRecord({ command: 'cd "$OTHER" && gh pr merge 12', cwd: repoDir }),
        );
        expect(merges()).toEqual([{ action: 'merge', prNumber: null }]);
        expect(resolve).not.toHaveBeenCalledWith(join(repoDir, '$OTHER'));
      });

      it('drops the number after a cd when the cwd is unknown', () => {
        recorder.recordToolCall(makeRecord({ command: `cd ${repoDir} && gh pr merge 12` }));
        expect(merges()).toEqual([{ action: 'merge', prNumber: null }]);
      });

      it('keeps the number when the cd comes after the gh segment', () => {
        recorder.recordToolCall(
          makeRecord({ command: `gh pr merge 12 && cd ${otherRepo}`, cwd: repoDir }),
        );
        expect(merges()).toEqual([{ action: 'merge', prNumber: '12' }]);
      });
    });
  });

  describe('processGhCommand standalone function — verb table and anchoring', () => {
    it('returns null for a verb outside the PR-action table (comment)', () => {
      expect(processGhCommand('gh pr comment 5 --body "see gh pr create"', 1000)).toBeNull();
    });

    it('returns null when "gh pr create" is not at the start of the segment', () => {
      expect(
        processGhCommand(`printf '{"tool_input":{"command":"gh pr create"}}'`, 1000),
      ).toBeNull();
    });

    it('matches through a leading env-var assignment', () => {
      expect(processGhCommand('GH_TOKEN=abc gh pr create --title x', 1000)).toMatchObject({
        action: 'create',
        prNumber: null,
      });
    });

    it('extracts the merge verb and PR number', () => {
      expect(processGhCommand('gh pr merge 5', 1000)).toMatchObject({
        action: 'merge',
        prNumber: '5',
      });
    });
  });

  describe('splitShellSegments', () => {
    it('splits on &&, ;, |, and newline', () => {
      expect(splitShellSegments('a && b; c | d\ne')).toEqual(['a ', ' b', ' c ', ' d', 'e']);
    });

    it('treats a newline as a separator, not just &&/;/|', () => {
      expect(splitShellSegments('git commit -m x\ngh pr create')).toEqual([
        'git commit -m x',
        'gh pr create',
      ]);
    });

    it('does not split on an operator inside quotes', () => {
      expect(splitShellSegments(`git commit -m "a; b && c" && echo 'x | y'`)).toEqual([
        'git commit -m "a; b && c" ',
        " echo 'x | y'",
      ]);
    });

    it('joins a backslash-newline and continues a line that ends in ||, && or |', () => {
      expect(
        splitShellSegments('git commit \\\n  -m x &&\n  git push ||\n\n  echo failed'),
      ).toEqual(['git commit   -m x ', '  git push ', '  echo failed']);
    });

    it('splits on a background & but not on a redirection', () => {
      expect(splitShellSegments('git fetch & git status 2>&1 >/dev/null &>/dev/null')).toEqual([
        'git fetch ',
        ' git status 2>&1 >/dev/null &>/dev/null',
      ]);
    });
  });
});
