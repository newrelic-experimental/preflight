import {
  execSync as nodeExecSync,
  spawnSync as nodeSpawnSync,
  type ExecSyncOptions,
  type ExecSyncOptionsWithStringEncoding,
  type SpawnSyncOptions,
  type SpawnSyncReturns,
} from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeIdentityResolver } from './git-workspace-identity.js';

// git sets GIT_DIR/GIT_WORK_TREE for hook subprocesses (e.g. a pre-push
// hook), which override `-C <dir>` and silently redirect every fixture call
// below to the real repo instead of the isolated temp dir under test.
// `delete process.env.GIT_DIR` does not reliably reach whatever these
// child processes actually inherit, so every call goes through these
// wrappers instead, which strip both via an explicit `env` option.
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

function spawnSync(
  command: string,
  args?: readonly string[],
  options?: SpawnSyncOptions,
): SpawnSyncReturns<string | Buffer> {
  return nodeSpawnSync(command, args, { ...options, env: CLEAN_ENV });
}

const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
afterAll(() => stderrSpy.mockRestore());

function initGitRepo(dir: string): void {
  execSync('git init', { cwd: dir });
  execSync('git config user.email "test@test.local"', { cwd: dir });
  execSync('git config user.name "Test User"', { cwd: dir });
  execSync('git commit --allow-empty -m "initial commit"', { cwd: dir });
}

function getCurrentBranch(dir: string): string {
  return execSync('git rev-parse --abbrev-ref HEAD', { cwd: dir, encoding: 'utf-8' }).trim();
}

describe('WorktreeIdentityResolver', () => {
  let resolver: WorktreeIdentityResolver;
  let tmpDir: string;

  beforeEach(() => {
    resolver = new WorktreeIdentityResolver();
    tmpDir = mkdtempSync(join(tmpdir(), 'git-ws-id-test-'));
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('resolves a normal (non-bare) repo with no worktrees', () => {
    const repoDir = join(tmpDir, 'normal-repo');
    execSync(`mkdir -p "${repoDir}"`);
    initGitRepo(repoDir);

    const identity = resolver.resolve(repoDir);
    expect(identity).not.toBeNull();
    expect(identity!.repoKey).toBeTruthy();
    expect(identity!.worktreeKey).toBeTruthy();
    expect(identity!.worktreeKey).toBe(identity!.repoKey);
    expect(identity!.worktreeLabel).toBe('primary');
    expect(identity!.branch).toBeTruthy();
    expect(identity!.worktreeRoot).toBeTruthy();
  });

  it('resolves a linked worktree with distinct keys and label', () => {
    const repoDir = join(tmpDir, 'primary-repo');
    execSync(`mkdir -p "${repoDir}"`);
    initGitRepo(repoDir);

    const primaryBranch = getCurrentBranch(repoDir);
    const linkedDir = join(tmpDir, 'linked-worktree');

    execSync(`git worktree add "${linkedDir}" -b linked-branch`, { cwd: repoDir });

    const primaryIdentity = resolver.resolve(repoDir);
    const linkedIdentity = resolver.resolve(linkedDir);

    expect(primaryIdentity).not.toBeNull();
    expect(linkedIdentity).not.toBeNull();

    expect(primaryIdentity!.repoKey).toBe(linkedIdentity!.repoKey);
    expect(primaryIdentity!.worktreeKey).not.toBe(linkedIdentity!.worktreeKey);

    expect(primaryIdentity!.worktreeLabel).toBe('primary');
    expect(linkedIdentity!.worktreeLabel).toBe('linked-worktree');

    expect(primaryIdentity!.branch).toBe(primaryBranch);
    expect(linkedIdentity!.branch).toBe('linked-branch');
  });

  it('resolves a bare repo (core.bare=true)', () => {
    const bareDir = join(tmpDir, 'bare-repo');
    execSync(`mkdir -p "${bareDir}"`);
    execSync('git init --bare', { cwd: bareDir });

    // Sanity check: --show-toplevel should fail on a bare repo
    const showTopResult = spawnSync('git', ['-C', bareDir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf-8' as const,
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'],
    });
    expect(showTopResult.status).not.toBe(0);

    const identity = resolver.resolve(bareDir);
    expect(identity).not.toBeNull();
    expect(identity!.repoKey).toBeTruthy();
    expect(identity!.repoKey.length).toBeGreaterThan(0);
  });

  it('resolves a freshly-init repo with zero commits (unborn HEAD)', () => {
    const freshDir = join(tmpDir, 'fresh-repo');
    execSync(`mkdir -p "${freshDir}"`);
    execSync('git init', { cwd: freshDir });

    // Sanity check: --abbrev-ref HEAD alone fails on an unborn HEAD, which is
    // exactly the landmine identity resolution must not depend on.
    const headResult = spawnSync('git', ['-C', freshDir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf-8' as const,
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'],
    });
    expect(headResult.status).not.toBe(0);

    const identity = resolver.resolve(freshDir);
    expect(identity).not.toBeNull();
    expect(identity!.repoKey).toBeTruthy();
    expect(identity!.worktreeKey).toBe(identity!.repoKey);
    expect(identity!.branch).toBeNull();
  });

  it('returns null for a non-repo directory', () => {
    const plainDir = join(tmpDir, 'plain-dir');
    execSync(`mkdir -p "${plainDir}"`);

    const identity = resolver.resolve(plainDir);
    expect(identity).toBeNull();
  });

  it('caches results and produces consistent identity across calls', () => {
    const repoDir = join(tmpDir, 'cached-repo');
    execSync(`mkdir -p "${repoDir}"`);
    initGitRepo(repoDir);

    const identity1 = resolver.resolve(repoDir);
    const identity2 = resolver.resolve(repoDir);

    expect(identity1).not.toBeNull();
    expect(identity2).not.toBeNull();

    expect(identity1!.repoKey).toBe(identity2!.repoKey);
    expect(identity1!.worktreeKey).toBe(identity2!.worktreeKey);
    expect(identity1!.worktreeLabel).toBe(identity2!.worktreeLabel);
  });

  it('handles resolve(null) gracefully', () => {
    const identity = resolver.resolve(null);
    expect(identity).toBeNull();
  });

  it('handles resolve(undefined) gracefully', () => {
    const identity = resolver.resolve(undefined);
    expect(identity).toBeNull();
  });

  it('handles resolve("") gracefully', () => {
    const identity = resolver.resolve('');
    expect(identity).toBeNull();
  });

  it('refreshes branch on TTL expiry', (done) => {
    const repoDir = join(tmpDir, 'branch-ttl-repo');
    execSync(`mkdir -p "${repoDir}"`);
    initGitRepo(repoDir);
    const initialBranch = getCurrentBranch(repoDir);

    const identity1 = resolver.resolve(repoDir);
    expect(identity1!.branch).toBe(initialBranch);

    execSync('git checkout -b new-branch', { cwd: repoDir });

    const identity2 = resolver.resolve(repoDir);
    expect(identity2!.branch).toBe(initialBranch);

    setTimeout(() => {
      const identity3 = resolver.resolve(repoDir);
      expect(identity3!.branch).toBe('new-branch');
      done();
    }, 30_100);
  }, 40_000);

  it('reports detached HEAD on TTL refresh rather than the stale cached branch', (done) => {
    const repoDir = join(tmpDir, 'branch-ttl-detached-repo');
    execSync(`mkdir -p "${repoDir}"`);
    initGitRepo(repoDir);
    const initialBranch = getCurrentBranch(repoDir);

    const identity1 = resolver.resolve(repoDir);
    expect(identity1!.branch).toBe(initialBranch);

    // Detach HEAD — a real state transition the refresh must reflect, not
    // mask by falling back to the last known (named) branch.
    execSync('git checkout --detach HEAD', { cwd: repoDir });

    setTimeout(() => {
      const identity2 = resolver.resolve(repoDir);
      expect(identity2!.branch).toBeNull();
      done();
    }, 30_100);
  }, 40_000);
});
