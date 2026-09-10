import {
  execSync as nodeExecSync,
  type ExecSyncOptions,
  type ExecSyncOptionsWithStringEncoding,
} from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ReplayTimelineEntry, ToolCallRecord } from '../storage/types.js';
import { GitWorkspaceReporter, replaySessionToActivityRecords } from './git-workspace-reporter.js';
import { WorktreeIdentityResolver } from './git-workspace-identity.js';

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

function execSync(command: string, options: ExecSyncOptionsWithStringEncoding): string;
function execSync(command: string, options?: ExecSyncOptions): Buffer;
function execSync(
  command: string,
  options?: ExecSyncOptions | ExecSyncOptionsWithStringEncoding,
): Buffer | string {
  return nodeExecSync(command, {
    ...options,
    env: CLEAN_ENV,
  } as ExecSyncOptionsWithStringEncoding);
}

const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
afterAll(() => stderrSpy.mockRestore());

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

function initGitRepo(dir: string): void {
  execSync('git init', { cwd: dir });
  execSync('git config user.email "test@test.local"', { cwd: dir });
  execSync('git config user.name "Test User"', { cwd: dir });
  execSync('git commit --allow-empty -m "initial commit"', { cwd: dir });
}

function getCurrentBranch(dir: string): string {
  return execSync('git rev-parse --abbrev-ref HEAD', { cwd: dir, encoding: 'utf-8' }).trim();
}

describe('GitWorkspaceReporter', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'git-ws-reporter-test-'));
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('records a git commit tool call and reports it via report()', () => {
    const repoDir = join(tmpDir, 'repo');
    execSync(`mkdir -p "${repoDir}"`);
    initGitRepo(repoDir);

    const reporter = new GitWorkspaceReporter();
    reporter.recordToolCall(
      makeRecord({ command: 'git commit -m "test"', cwd: repoDir, timestamp: 5000 }),
    );

    const report = reporter.report({
      scope: { kind: 'all' },
      since: 0,
      until: Date.now() + 1000,
    });

    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].metrics.commitCount).toBe(1);
  });

  it("report() caps velocityMetrics.longestGapMs at the window's own `until`, not real now", () => {
    const repoDir = join(tmpDir, 'repo-past-window');
    execSync(`mkdir -p "${repoDir}"`);
    initGitRepo(repoDir);

    const oneDayMs = 86_400_000;
    const commitTimestamp = 1_000;
    const windowUntil = commitTimestamp + 3 * oneDayMs;

    const reporter = new GitWorkspaceReporter();
    reporter.recordToolCall(
      makeRecord({ command: 'git commit -m "test"', cwd: repoDir, timestamp: commitTimestamp }),
    );

    // A bounded past window ending 3 days after the commit — the gap since
    // that commit must be capped at 3 days, not stretched out to whatever
    // Date.now() happens to be when the test runs.
    const report = reporter.report({
      scope: { kind: 'all' },
      since: 0,
      until: windowUntil,
    });

    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].metrics.velocityMetrics.longestGapMs).toBe(3 * oneDayMs);
  });

  it('report() echoes back the exact since/until it was called with', () => {
    const reporter = new GitWorkspaceReporter();
    const until = Date.now() + 1000;
    const report = reporter.report({ scope: { kind: 'all' }, since: 0, until });
    expect(report.since).toBe(0);
    expect(report.until).toBe(until);
  });

  it('knownWorkspaces() reflects a workspace even when the report window has no activity', () => {
    const repoDir = join(tmpDir, 'repo');
    execSync(`mkdir -p "${repoDir}"`);
    initGitRepo(repoDir);

    const reporter = new GitWorkspaceReporter();
    reporter.recordToolCall(
      makeRecord({ command: 'git commit -m "test"', cwd: repoDir, timestamp: 5000 }),
    );

    const emptyWindowReport = reporter.report({
      scope: { kind: 'all' },
      since: Date.now() + 60_000,
      until: Date.now() + 120_000,
    });

    expect(emptyWindowReport.rows).toHaveLength(0);

    const known = reporter.knownWorkspaces();
    expect(known.size).toBeGreaterThanOrEqual(1);
    const identity = new WorktreeIdentityResolver().resolve(repoDir);
    expect(known.get(identity!.worktreeKey)).toBeDefined();
  });

  describe('sampleLiveState compare-ref ladder', () => {
    it('resolves ahead/behind and defaultBranch from a real configured upstream', () => {
      const remoteDir = join(tmpDir, 'remote.git');
      execSync(`mkdir -p "${remoteDir}"`);
      execSync('git init --bare', { cwd: remoteDir });

      const workDir = join(tmpDir, 'work');
      execSync(`git clone "${remoteDir}" "${workDir}"`);
      execSync('git config user.email "test@test.local"', { cwd: workDir });
      execSync('git config user.name "Test User"', { cwd: workDir });
      execSync('echo a > a.txt && git add a.txt && git commit -m "c1"', {
        cwd: workDir,
        shell: '/bin/bash',
      });
      const branch = getCurrentBranch(workDir);
      execSync(`git push origin ${branch}`, { cwd: workDir });

      const remoteWriterDir = join(tmpDir, 'remote-writer');
      execSync(`git clone "${remoteDir}" "${remoteWriterDir}"`);
      execSync('git config user.email "test@test.local"', { cwd: remoteWriterDir });
      execSync('git config user.name "Test User"', { cwd: remoteWriterDir });
      execSync('echo r1 >> a.txt && git add a.txt && git commit -m "remote-1"', {
        cwd: remoteWriterDir,
        shell: '/bin/bash',
      });
      execSync('echo r2 >> a.txt && git add a.txt && git commit -m "remote-2"', {
        cwd: remoteWriterDir,
        shell: '/bin/bash',
      });
      execSync(`git push origin ${branch}`, { cwd: remoteWriterDir });

      execSync('git fetch origin', { cwd: workDir });
      execSync('echo l1 >> a.txt && git add a.txt && git commit -m "local-1"', {
        cwd: workDir,
        shell: '/bin/bash',
      });
      execSync(`git branch --set-upstream-to=origin/${branch} ${branch}`, { cwd: workDir });

      const identityResolver = new WorktreeIdentityResolver();
      const identity = identityResolver.resolve(workDir);
      expect(identity).not.toBeNull();
      expect(identity!.branch).toBe(branch);

      const reporter = new GitWorkspaceReporter();
      const liveState = reporter.sampleLiveState(identity!);

      expect(liveState.defaultBranch).toBe(branch);
      expect(liveState.behind).toBe(2);
      expect(liveState.ahead).toBe(1);
    });

    it('falls through to null ahead/behind/defaultBranch with no upstream and no origin/HEAD', () => {
      const repoDir = join(tmpDir, 'no-remote-repo');
      execSync(`mkdir -p "${repoDir}"`);
      initGitRepo(repoDir);

      const identityResolver = new WorktreeIdentityResolver();
      const identity = identityResolver.resolve(repoDir);
      expect(identity).not.toBeNull();

      const reporter = new GitWorkspaceReporter();
      const liveState = reporter.sampleLiveState(identity!);

      expect(liveState.branch).toBe(identity!.branch);
      expect(liveState.defaultBranch).toBeNull();
      expect(liveState.ahead).toBeNull();
      expect(liveState.behind).toBeNull();
    });
  });

  it('caches sampleLiveState per worktreeKey within the TTL window', () => {
    const repoDir = join(tmpDir, 'ttl-repo');
    execSync(`mkdir -p "${repoDir}"`);
    initGitRepo(repoDir);

    const identityResolver = new WorktreeIdentityResolver();
    const identity1 = identityResolver.resolve(repoDir);
    expect(identity1).not.toBeNull();
    const originalBranch = identity1!.branch;

    const reporter = new GitWorkspaceReporter();
    const firstSample = reporter.sampleLiveState(identity1!);
    expect(firstSample.branch).toBe(originalBranch);

    execSync('git checkout -b other-branch', { cwd: repoDir });

    // Resolve fresh (a brand-new resolver instance, so its own 30s branch TTL
    // doesn't mask the change) — worktreeKey is unaffected by which branch is
    // checked out, so this identity2 shares identity1's cache key.
    const identity2 = new WorktreeIdentityResolver().resolve(repoDir);
    expect(identity2!.branch).toBe('other-branch');
    expect(identity2!.worktreeKey).toBe(identity1!.worktreeKey);

    const secondSample = reporter.sampleLiveState(identity2!);
    // Still within the (default, 5 minute) TTL window — the cached sample
    // from identity1 wins, proving the cache was consulted rather than
    // re-sampled against the now-current branch.
    expect(secondSample.branch).toBe(originalBranch);
    expect(secondSample.branch).not.toBe('other-branch');
  });

  describe('replaySessionToActivityRecords', () => {
    it('re-classifies a timeline into GitActivityRecords with replay:<sessionId>:<index> ids', () => {
      const repoDir = join(tmpDir, 'replay-repo');
      execSync(`mkdir -p "${repoDir}"`);
      initGitRepo(repoDir);

      const timeline: ReplayTimelineEntry[] = [
        {
          timestamp: 1000,
          toolName: 'Bash',
          durationMs: 50,
          success: true,
          command: 'git commit -m "replayed"',
          cwd: repoDir,
        },
        {
          timestamp: 2000,
          toolName: 'Edit',
          durationMs: 20,
          success: true,
          filePath: '/some/file.ts',
        },
      ];

      const identityResolver = new WorktreeIdentityResolver();
      const { records } = replaySessionToActivityRecords(
        { sessionId: 'sess-1', timeline },
        identityResolver,
      );

      expect(records).toHaveLength(2);

      const gitRecord = records.find((r) => r.kind === 'git');
      expect(gitRecord).toBeDefined();
      expect(gitRecord!.recordId.startsWith('replay:sess-1:0')).toBe(true);

      const editRecord = records.find((r) => r.kind === 'edit');
      expect(editRecord).toBeDefined();
      expect(editRecord!.recordId.startsWith('replay:sess-1:1')).toBe(true);
    });

    it('resolves to the unattributed workspaceKey for an entry with no cwd', () => {
      const timeline: ReplayTimelineEntry[] = [
        {
          timestamp: 1000,
          toolName: 'Edit',
          durationMs: 20,
          success: true,
          filePath: '/some/file.ts',
          // no cwd — a session persisted before that field existed.
        },
      ];

      const identityResolver = new WorktreeIdentityResolver();
      const { records } = replaySessionToActivityRecords(
        { sessionId: 'sess-no-cwd', timeline },
        identityResolver,
      );

      expect(records).toHaveLength(1);
      expect(records[0].workspaceKey).toBe('unattributed');
    });

    it('falls back to a synthetic unresolved-repo identity when repoName is known but cwd is not', () => {
      const timeline: ReplayTimelineEntry[] = [
        {
          timestamp: 1000,
          toolName: 'Edit',
          durationMs: 20,
          success: true,
          filePath: '/some/file.ts',
          // no cwd, but the session still knows which repo it ran in.
        },
      ];

      const identityResolver = new WorktreeIdentityResolver();
      const { records, identities } = replaySessionToActivityRecords(
        { sessionId: 'sess-repo-only', timeline, repoName: 'acme/widgets' },
        identityResolver,
      );

      expect(records).toHaveLength(1);
      const fallbackKey = 'unresolved-repo:acme/widgets';
      expect(records[0].workspaceKey).toBe(fallbackKey);

      const identity = identities.get(fallbackKey);
      expect(identity).toBeDefined();
      expect(identity!.repoName).toBe('acme/widgets');
      expect(identity!.worktreeRoot).toBeNull();
      expect(identity!.branch).toBeNull();
    });

    it('leaves already-resolved entries alone even when repoName fallback is available', () => {
      const repoDir = join(tmpDir, 'repo-with-cwd');
      execSync(`mkdir -p "${repoDir}"`);
      initGitRepo(repoDir);

      const timeline: ReplayTimelineEntry[] = [
        {
          timestamp: 1000,
          toolName: 'Bash',
          durationMs: 50,
          success: true,
          command: 'git commit -m "replayed"',
          cwd: repoDir,
        },
      ];

      const identityResolver = new WorktreeIdentityResolver();
      const { records, identities } = replaySessionToActivityRecords(
        { sessionId: 'sess-mixed', timeline, repoName: 'acme/widgets' },
        identityResolver,
      );

      expect(records).toHaveLength(1);
      expect(records[0].workspaceKey).not.toBe('unresolved-repo:acme/widgets');
      const realIdentity = identityResolver.resolve(repoDir);
      expect(records[0].workspaceKey).toBe(realIdentity!.worktreeKey);
      expect(identities.has('unresolved-repo:acme/widgets')).toBe(false);
    });

    it('produces stable ids across repeated replays, so ingesting both is idempotent', () => {
      const repoDir = join(tmpDir, 'idempotent-repo');
      execSync(`mkdir -p "${repoDir}"`);
      initGitRepo(repoDir);

      const timeline: ReplayTimelineEntry[] = [
        {
          timestamp: 1000,
          toolName: 'Bash',
          durationMs: 50,
          success: true,
          command: 'git commit -m "replayed"',
          cwd: repoDir,
        },
      ];

      const identityResolver = new WorktreeIdentityResolver();
      const session = { sessionId: 'sess-idempotent', timeline };
      const firstPass = replaySessionToActivityRecords(session, identityResolver);
      const secondPass = replaySessionToActivityRecords(session, identityResolver);

      expect(firstPass.records.map((r) => r.recordId)).toEqual(
        secondPass.records.map((r) => r.recordId),
      );

      const reporter = new GitWorkspaceReporter();
      reporter.ingestRecords(firstPass.records, firstPass.identities);
      reporter.ingestRecords(secondPass.records, secondPass.identities);

      const report = reporter.report({
        scope: { kind: 'all' },
        since: 0,
        until: Date.now() + 60_000,
      });

      expect(report.rows).toHaveLength(1);
      expect(report.rows[0].metrics.commitCount).toBe(1);
    });

    it('report() dedupes historical records against what is already live, not just what ingestRecords already deduped', () => {
      // Mirrors the real shape of the bug: a session already ingested live
      // (e.g. at daemon startup, via ingestRecords) gets independently
      // re-replayed and passed as `historical` on a request for a window
      // that also covers today — report() must not double-count it just
      // because the two record arrays never touched the same ActivityStore.
      const repoDir = join(tmpDir, 'historical-overlap-repo');
      execSync(`mkdir -p "${repoDir}"`);
      initGitRepo(repoDir);

      const timeline: ReplayTimelineEntry[] = [
        {
          timestamp: 1000,
          toolName: 'Bash',
          durationMs: 50,
          success: true,
          command: 'git commit -m "replayed"',
          cwd: repoDir,
        },
      ];

      const identityResolver = new WorktreeIdentityResolver();
      const session = { sessionId: 'sess-overlap', timeline };
      const replayed = replaySessionToActivityRecords(session, identityResolver);

      const reporter = new GitWorkspaceReporter();
      // Already live, e.g. from startup replay.
      reporter.ingestRecords(replayed.records, replayed.identities);

      // The SAME session, re-replayed fresh (as the API route does per
      // request) and passed as `historical` — same recordId, different array.
      const replayedAgain = replaySessionToActivityRecords(session, identityResolver);
      const report = reporter.report({
        scope: { kind: 'all' },
        since: 0,
        until: Date.now() + 60_000,
        historical: replayedAgain.records,
        historicalIdentities: replayedAgain.identities,
      });

      expect(report.rows).toHaveLength(1);
      expect(report.rows[0].metrics.commitCount).toBe(1);
    });

    it('report() excludes historical activity that falls outside [since, until), even from a session that started inside the window', () => {
      // A bounded past window (e.g. "yesterday") must not count activity that
      // happened after `until` just because it came from the same session's
      // timeline — replaySessionToActivityRecords hands back the WHOLE
      // timeline regardless of the window being queried, so report() itself
      // has to do the bounding for `historical` the same way ActivityStore
      // already does for live records.
      const repoDir = join(tmpDir, 'historical-window-bound-repo');
      execSync(`mkdir -p "${repoDir}"`);
      initGitRepo(repoDir);

      const timeline: ReplayTimelineEntry[] = [
        {
          timestamp: 1000,
          toolName: 'Bash',
          durationMs: 50,
          success: true,
          command: 'git commit -m "inside window"',
          cwd: repoDir,
        },
        {
          timestamp: 5000,
          toolName: 'Bash',
          durationMs: 50,
          success: true,
          command: 'git commit -m "after window closed"',
          cwd: repoDir,
        },
      ];

      const identityResolver = new WorktreeIdentityResolver();
      const session = { sessionId: 'sess-window-bound', timeline };
      const replayed = replaySessionToActivityRecords(session, identityResolver);

      const reporter = new GitWorkspaceReporter();
      const report = reporter.report({
        scope: { kind: 'all' },
        since: 0,
        until: 3000,
        historical: replayed.records,
        historicalIdentities: replayed.identities,
      });

      expect(report.rows).toHaveLength(1);
      expect(report.rows[0].metrics.commitCount).toBe(1);
    });
  });
});
