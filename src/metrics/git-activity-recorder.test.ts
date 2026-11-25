import { basename, join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import {
  spawnSync as nodeSpawnSync,
  type SpawnSyncOptions,
  type SpawnSyncReturns,
} from 'node:child_process';
import { jest } from '@jest/globals';
import { GitActivityRecorder } from './git-activity-recorder.js';
import { processGhCommand, segmentRunsNoCommand } from './git-event-classifier.js';
import { ActivityStore } from './git-activity-store.js';
import type { GitActivityRecord } from './git-activity-recorder.js';
import { WorktreeIdentityResolver } from './git-workspace-identity.js';
import { HookEventProcessor } from '../hooks/event-processor.js';
import { ClaudeCodeAdapter } from '../platforms/claude-code-adapter.js';
import { LocalStore } from '../storage/local-store.js';
import type { HookEvent, ToolCallRecord } from '../storage/types.js';

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

// What `ssh -G <host>` would report for a `Host` entry in ~/.ssh/config.
const SSH_ALIASES: Readonly<Record<string, string | null>> = {
  'github-work': 'github.com',
  'github.com-work': 'github.com',
  'ghe-work': 'ghe.example.com',
  'broken-alias': null,
};
const sshHostName = (host: string): string | null =>
  host in SSH_ALIASES ? SSH_ALIASES[host]! : host;

describe('GitActivityRecorder', () => {
  let store: ActivityStore<GitActivityRecord>;
  let identityResolver: WorktreeIdentityResolver;
  let recorder: GitActivityRecorder;
  let repoDir: string;

  beforeEach(() => {
    store = new ActivityStore();
    identityResolver = new WorktreeIdentityResolver(sshHostName);
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

  // Claude Code names an MCP tool `mcp__<server>__<tool>`.
  describe('MCP PR tools under Claude Code names', () => {
    interface HookCall {
      readonly tool: string;
      readonly toolInput?: Record<string, unknown>;
      readonly success?: boolean;
    }

    /** Pairs one Claude Code pre/post hook per call through HookEventProcessor
     *  and feeds the records to the recorder. `toolOutput` is what the
     *  collector writes for a create_pull_request result naming PR 57;
     *  `toolInput` is what it writes for the call's owner/repo/pullNumber. */
    function recordThroughHooks(calls: readonly (string | HookCall)[]): void {
      const bufferDir = mkdtempSync(join('/tmp', 'git-activity-hooks-'));
      try {
        const localStore = new LocalStore(bufferDir);
        localStore.initialize();
        const processor = new HookEventProcessor({
          store: localStore,
          onRecord: (record) => recorder.recordToolCall(record),
          platformAdapter: new ClaudeCodeAdapter(),
        });
        processor.processEvents(
          calls.flatMap((call, i): HookEvent[] => {
            const {
              tool,
              toolInput,
              success = true,
            } = typeof call === 'string' ? { tool: call } : call;
            return [
              {
                mode: 'pre',
                tool,
                timestamp: 1000 + i * 10,
                toolUseId: `tu-${i}`,
                sessionId: 's',
                ...(toolInput && { toolInput }),
              },
              {
                mode: 'post',
                tool,
                timestamp: 1005 + i * 10,
                success,
                toolUseId: `tu-${i}`,
                sessionId: 's',
                cwd: repoDir,
                toolOutput: { createdPrNumber: '57' },
              },
            ];
          }),
        );
      } finally {
        rmSync(bufferDir, { recursive: true, force: true });
      }
    }

    const prEvents = () =>
      store
        .query({ since: 0, until: Date.now() + 1000 })
        .flatMap((r) => (r.kind === 'pr' ? [r.prEvent] : []));

    it('records mcp__github__create_pull_request with its PR number', () => {
      recordThroughHooks(['mcp__github__create_pull_request']);

      expect(prEvents()).toEqual([expect.objectContaining({ action: 'create', prNumber: '57' })]);
    });

    it('records update_pull_request from a plugin-bundled GitHub server', () => {
      recordThroughHooks(['mcp__plugin_github_github__update_pull_request']);

      expect(prEvents()).toEqual([expect.objectContaining({ action: 'edit', prNumber: null })]);
    });

    it('records merge_pull_request with the PR number it named', () => {
      recordThroughHooks([
        { tool: 'mcp__github__merge_pull_request', toolInput: { prNumber: '12' } },
      ]);

      expect(prEvents()).toEqual([expect.objectContaining({ action: 'merge', prNumber: '12' })]);
    });

    it('records update_pull_request with the PR number it named', () => {
      recordThroughHooks([
        { tool: 'mcp__github__update_pull_request', toolInput: { prNumber: '12' } },
      ]);

      expect(prEvents()).toEqual([expect.objectContaining({ action: 'edit', prNumber: '12' })]);
    });

    it('skips a failed create or merge, but keeps a failed edit', () => {
      recordThroughHooks([
        { tool: 'mcp__github__create_pull_request', success: false },
        { tool: 'mcp__github__merge_pull_request', toolInput: { prNumber: '12' }, success: false },
        { tool: 'mcp__github__update_pull_request', toolInput: { prNumber: '12' }, success: false },
      ]);

      expect(prEvents()).toEqual([expect.objectContaining({ action: 'edit' })]);
    });

    describe('in a repo whose remote is acme/app', () => {
      beforeEach(() => {
        spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/app.git'], {
          cwd: repoDir,
          stdio: 'ignore',
        });
      });

      it('drops the number of a PR in another repo, keeping the event', () => {
        recordThroughHooks([
          {
            tool: 'mcp__github__merge_pull_request',
            toolInput: { prRepo: 'acme/other', prNumber: '12' },
          },
          { tool: 'mcp__github__create_pull_request', toolInput: { prRepo: 'acme/other' } },
        ]);

        expect(prEvents()).toEqual([
          expect.objectContaining({ action: 'merge', prNumber: null }),
          expect.objectContaining({ action: 'create', prNumber: null }),
        ]);
      });

      it("keeps the number of a PR in the cwd's repo, whatever its case", () => {
        recordThroughHooks([
          {
            tool: 'mcp__github__merge_pull_request',
            toolInput: { prRepo: 'Acme/App', prNumber: '12' },
          },
        ]);

        expect(prEvents()).toEqual([expect.objectContaining({ action: 'merge', prNumber: '12' })]);
      });

      // A fork clone: origin is the fork, the PR lives in upstream.
      it('keeps the number of a PR in another remote of the clone', () => {
        spawnSync('git', ['remote', 'add', 'upstream', 'https://github.com/upstream-org/app.git'], {
          cwd: repoDir,
          stdio: 'ignore',
        });
        recordThroughHooks([
          { tool: 'mcp__github__create_pull_request', toolInput: { prRepo: 'upstream-org/app' } },
          {
            tool: 'mcp__github__merge_pull_request',
            toolInput: { prRepo: 'upstream-org/app', prNumber: '57' },
          },
        ]);

        expect(prEvents()).toEqual([
          expect.objectContaining({ action: 'create', prNumber: '57' }),
          expect.objectContaining({ action: 'merge', prNumber: '57' }),
        ]);
      });
    });

    it('ignores GitHub MCP tools whose names only start like a PR tool', () => {
      recordThroughHooks([
        'mcp__github__create_pull_request_with_copilot',
        'mcp__github__update_pull_request_branch',
      ]);

      expect(prEvents()).toEqual([]);
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

  describe('PR refs (owner/repo#N)', () => {
    const refsOf = (...records: ToolCallRecord[]) => {
      for (const record of records) recorder.recordToolCall(record);
      return store
        .query({ since: 0, until: Date.now() + 1000 })
        .map((r) => (r.kind === 'pr' ? [r.prEvent.action, r.prEvent.prNumber, r.prRef] : null));
    };
    const addRemote = (name: string, url: string) =>
      spawnSync('git', ['remote', 'add', name, url], { cwd: repoDir, stdio: 'ignore' });

    it('takes a create ref from the repo its PR URL named, even with -R', () => {
      expect(
        refsOf(
          makeRecord({
            command: 'gh pr create -R acme/app --fill',
            cwd: repoDir,
            createdPrNumber: '42',
            createdPrRepo: 'acme/app',
          }),
        ),
      ).toEqual([['create', null, 'acme/app#42']]);
    });

    it("takes a merge ref from the cwd repo's only remote", () => {
      addRemote('origin', 'git@github.com:Acme/App.git');
      expect(refsOf(makeRecord({ command: 'gh pr merge 42 --squash', cwd: repoDir }))).toEqual([
        ['merge', '42', 'acme/app#42'],
      ]);
    });

    it('takes a merge ref from -R, which keeps the number off the cwd repo', () => {
      addRemote('origin', 'https://github.com/fork/app.git');
      expect(refsOf(makeRecord({ command: 'gh pr merge 42 -R acme/app', cwd: repoDir }))).toEqual([
        ['merge', null, 'acme/app#42'],
      ]);
    });

    it('gives a merge no ref when the cwd repo has several remotes', () => {
      addRemote('origin', 'https://github.com/fork/app.git');
      addRemote('upstream', 'https://github.com/acme/app.git');
      expect(refsOf(makeRecord({ command: 'gh pr merge 42', cwd: repoDir }))).toEqual([
        ['merge', '42', null],
      ]);
    });

    it('takes a merge ref from the default gh repo set-default saved', () => {
      addRemote('origin', 'https://github.com/fork/app.git');
      addRemote('upstream', 'https://github.com/acme/app.git');
      spawnSync('git', ['config', 'remote.upstream.gh-resolved', 'base'], {
        cwd: repoDir,
        stdio: 'ignore',
      });
      expect(refsOf(makeRecord({ command: 'gh pr merge 42', cwd: repoDir }))).toEqual([
        ['merge', '42', 'acme/app#42'],
      ]);
    });

    describe('with a default saved on one of two remotes', () => {
      const setDefault = (remote: string, value: string) =>
        spawnSync('git', ['config', `remote.${remote}.gh-resolved`, value], {
          cwd: repoDir,
          stdio: 'ignore',
        });
      const mergeRef = () => refsOf(makeRecord({ command: 'gh pr merge 42', cwd: repoDir }))[0];

      beforeEach(() => {
        addRemote('origin', 'https://github.com/fork/app.git');
        addRemote('upstream', 'https://github.com/acme/app.git');
      });

      it('takes an owner/name default as written, lowercased', () => {
        setDefault('origin', 'Acme/Other');
        expect(mergeRef()).toEqual(['merge', '42', 'acme/other#42']);
      });

      it('takes a host/owner/name default without its host', () => {
        setDefault('origin', 'github.com/acme/other');
        expect(mergeRef()).toEqual(['merge', '42', 'acme/other#42']);
      });

      it('gives no ref when two remotes save different defaults', () => {
        setDefault('origin', 'base');
        setDefault('upstream', 'base');
        expect(mergeRef()).toEqual(['merge', '42', null]);
      });

      it('gives no ref when the default is not an owner/name', () => {
        setDefault('upstream', 'not-a-repo-name');
        expect(mergeRef()).toEqual(['merge', '42', null]);
      });
    });

    it('keeps a GitHub Enterprise remote apart from github.com in a merge ref', () => {
      addRemote('origin', 'git@ghe.example.com:Acme/App.git');
      expect(refsOf(makeRecord({ command: 'gh pr merge 42', cwd: repoDir }))).toEqual([
        ['merge', '42', 'ghe.example.com/acme/app#42'],
      ]);
    });

    it.each([
      ['an ssh host alias', 'git@github-work:Acme/App.git'],
      ['a dotted ssh host alias', 'git@github.com-work:Acme/App.git'],
      ['the ssh.github.com port-443 host', 'ssh://git@ssh.github.com:443/Acme/App.git'],
      ['an alias ssh cannot resolve', 'git@broken-alias:Acme/App.git'],
    ])('reads a github.com remote through %s as github.com', (_label, url) => {
      addRemote('origin', url);
      expect(refsOf(makeRecord({ command: 'gh pr merge 42', cwd: repoDir }))).toEqual([
        ['merge', '42', 'acme/app#42'],
      ]);
    });

    it('takes the host of a GHE remote reached through an ssh alias', () => {
      addRemote('origin', 'git@ghe-work:Acme/App.git');
      expect(refsOf(makeRecord({ command: 'gh pr merge 42', cwd: repoDir }))).toEqual([
        ['merge', '42', 'ghe.example.com/acme/app#42'],
      ]);
    });

    it('gives a GHE MCP create and merge the same host-qualified ref', () => {
      addRemote('origin', 'git@ghe.example.com:acme/app.git');
      expect(
        refsOf(
          makeRecord({
            toolName: 'mcp__github__create_pull_request',
            cwd: repoDir,
            createdPrNumber: '57',
            createdPrRepo: 'ghe.example.com/acme/app',
            mcpPrRepo: 'acme/app',
          }),
          makeRecord({
            toolUseId: 'tool-2',
            toolName: 'mcp__github__merge_pull_request',
            cwd: repoDir,
            mcpPrNumber: '57',
            mcpPrRepo: 'acme/app',
          }),
        ),
      ).toEqual([
        ['create', '57', 'ghe.example.com/acme/app#57'],
        ['merge', '57', 'ghe.example.com/acme/app#57'],
      ]);
    });

    it('leaves an MCP repo without a host when two hosts have it or no remote does', () => {
      addRemote('origin', 'git@ghe.example.com:acme/app.git');
      addRemote('upstream', 'https://github.com/acme/app.git');
      expect(
        refsOf(
          makeRecord({
            toolName: 'mcp__github__merge_pull_request',
            cwd: repoDir,
            mcpPrNumber: '57',
            mcpPrRepo: 'acme/app',
          }),
        ),
      ).toEqual([['merge', '57', 'acme/app#57']]);
    });

    it('takes a merge ref with the host -R names', () => {
      expect(
        refsOf(
          makeRecord({ command: 'gh pr merge 42 -R ghe.example.com/acme/app', cwd: repoDir }),
          makeRecord({
            toolUseId: 'tool-2',
            command: 'gh pr merge 42 -R github.com/acme/app',
            cwd: repoDir,
          }),
        ),
      ).toEqual([
        ['merge', null, 'ghe.example.com/acme/app#42'],
        ['merge', null, 'acme/app#42'],
      ]);
    });

    it('does not read a -R quoted into the merge body as the target repo', () => {
      addRemote('origin', 'https://github.com/acme/app.git');
      expect(
        refsOf(
          makeRecord({
            command: 'gh pr merge 42 --squash --body "see -R acme/other for details"',
            cwd: repoDir,
          }),
        ),
      ).toEqual([['merge', '42', 'acme/app#42']]);
    });

    it('reads an attached -R and a quoted GH_REPO as the target repo', () => {
      expect(
        refsOf(
          makeRecord({ command: 'gh pr merge 42 -Racme/app', cwd: repoDir }),
          makeRecord({
            toolUseId: 'tool-2',
            command: 'GH_REPO="acme/other" gh pr merge 43',
            cwd: repoDir,
          }),
        ),
      ).toEqual([
        ['merge', null, 'acme/app#42'],
        ['merge', null, 'acme/other#43'],
      ]);
    });

    it('gives a merge no ref when an earlier segment assigns GH_REPO', () => {
      addRemote('origin', 'https://github.com/acme/app.git');
      expect(
        refsOf(makeRecord({ command: 'export GH_REPO=acme/other; gh pr merge 42', cwd: repoDir })),
      ).toEqual([['merge', null, null]]);
    });

    it('takes MCP refs from the call, preferring the URL repo on a create', () => {
      expect(
        refsOf(
          makeRecord({
            toolName: 'mcp__github__create_pull_request',
            cwd: repoDir,
            createdPrNumber: '57',
            createdPrRepo: 'acme/app',
            mcpPrRepo: 'Acme/App',
          }),
          makeRecord({
            toolUseId: 'tool-2',
            toolName: 'mcp__github__merge_pull_request',
            cwd: repoDir,
            mcpPrNumber: '57',
            mcpPrRepo: 'Acme/App',
          }),
        ),
      ).toEqual([
        ['create', '57', 'acme/app#57'],
        ['merge', '57', 'acme/app#57'],
      ]);
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

    it('counts the commands after a comment line holding an apostrophe', () => {
      recorder.recordToolCall(
        makeRecord({
          command: "git add -A\n# Claude's fix for the login bug\ngit commit -m x && git push",
          cwd: repoDir,
          timestamp: 5000,
        }),
      );

      const types = store
        .query({ since: 0, until: 10000 })
        .flatMap((r) => (r.kind === 'git' ? [r.gitEvent.type] : []));
      expect(types).toEqual(['other_git', 'commit', 'push']);
    });

    it('still counts the git commands of a command whose quotes do not balance', () => {
      recorder.recordToolCall(
        makeRecord({
          command: "echo $'it\\'s done' && git commit -m x && git push",
          cwd: repoDir,
          timestamp: 5000,
        }),
      );

      const types = store
        .query({ since: 0, until: 10000 })
        .flatMap((r) => (r.kind === 'git' ? [r.gitEvent.type] : []));
      expect(types).toEqual(['commit', 'push']);
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
      'gh pr checks 42 # then && gh pr merge 42',
      'gh pr checks 42 --watch\n# && gh pr merge 42',
      'gh pr merge 42 --squash ||\n  # retry via <<web\n  echo failed',
      'gh pr merge 42 --body "see <<X" ||\n  echo failed',
      'gh pr merge 42 --body "see <<X" &&\ngit pull\necho done',
      'gh pr merge 42 --squash && grep -q MERGED <<<"$(gh pr view 42 --json state)"\necho done',
      'gh pr merge 42 --squash && echo "<<EOF"\necho done',
      'gh pr merge 42 --squash && echo $((1<<N))\necho done',
      'gh pr merge 42 --squash &&',
      'gh pr merge 42 --squash && # then pull',
      'gh pr merge 42 --body "see <<X" &&\n  git pull',
      'gh pr merge 812 --squash --body "Fixes <<EOF handling"\ngh pr comment 812 --body-file - <<\'EOF\'\nMerged after green CI.\nEOF',
      'gh pr comment 812 --body-file - <<-EOF\n    LGTM, merging.\n    EOF\ngh pr merge 812 --squash',
      'gh pr comment 812 --body-file - <<EOF\nLGTM, merging.\nEOF \ngh pr merge 812 --squash',
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
      "# Claude's merge, once checks pass\ngh pr checks 42 --watch && gh pr merge 42 --squash",
      'echo issue#12 ${#arr} $# "#" && gh pr merge 42 --squash',
      '(git fetch; gh pr merge 42)',
      "gh pr merge 42 --squash --body-file - <<'EOF'\nMerged.\nEOF",
      'gh pr merge 42 --squash --body "$(cat <<\'EOF\'\nMerged after review.\nEOF\n)" && git pull',
      'gh pr merge 42 --squash --body-file - <<-EOF &&\n\tMerged.\n\tEOF\ngit pull',
      'gh pr merge 42 --squash && grep -q MERGED <<<"$(gh pr view 42 --json state)"',
      'gh pr merge 42 --squash --body "see <<X"',
      'gh pr merge 42 --squash && echo $((1<<2))',
      'gh pr merge 42 --squash --body "$(echo "a; b")" && git pull',
      'echo "x" \\<<EOF && gh pr merge 42 --squash',
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

    it('drops a merge from a command whose quotes the splitter cannot balance', () => {
      // bash reads `$'it\'s green'` as one string, but the splitter sees a quote
      // left open, so where the merge's segment ends is a guess.
      recorder.recordToolCall(
        makeRecord({ command: "echo $'it\\'s green' && gh pr merge 42 --squash", cwd: repoDir }),
      );
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

    it.each(['gh pr merge 123-fix-login', 'gh pr merge 123-fix-login --squash'])(
      'takes no PR number from a branch name that starts with digits: `%s`',
      (command) => {
        expect(processGhCommand(command, 1000)).toMatchObject({ action: 'merge', prNumber: null });
      },
    );

    it('takes the PR number before the `)` closing a subshell', () => {
      expect(processGhCommand('gh pr merge 5)', 1000)).toMatchObject({ prNumber: '5' });
    });
  });

  describe('segmentRunsNoCommand', () => {
    it.each(['', '  ', ' )', ' ) }', '  # note'])('is true for %j', (segment) => {
      expect(segmentRunsNoCommand(segment)).toBe(true);
    });

    it.each([' git push', ' x)', 'echo #', ') x'])('is false for %j', (segment) => {
      expect(segmentRunsNoCommand(segment)).toBe(false);
    });
  });
});
