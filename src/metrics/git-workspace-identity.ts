import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { repoNameFromRemote } from './local-session-aggregator.js';

export interface WorktreeIdentity {
  /** `git rev-parse --path-format=absolute --git-common-dir`. Identical for
   *  every worktree of one clone (linked or primary); distinct for two
   *  different clones, even of the same remote URL. This is the repo grouping
   *  key. */
  readonly repoKey: string;
  /** `git rev-parse --path-format=absolute --git-dir`. Distinct for every
   *  worktree, including the primary checkout. For the primary checkout this
   *  equals repoKey; for a linked worktree it is `<repoKey>/worktrees/<name>`. */
  readonly worktreeKey: string;
  /** `owner/name` parsed from `git remote get-url origin`, or null if there is
   *  no origin remote or it doesn't parse. Display only. */
  readonly repoName: string | null;
  /** Absolute path to the worktree's own working directory. Null only if it
   *  genuinely cannot be derived. */
  readonly worktreeRoot: string | null;
  /** Human label: `basename(worktreeRoot)`, or `'primary'` if this is the
   *  primary checkout, or basename of worktreeKey as a last resort. */
  readonly worktreeLabel: string;
  /** Current branch, e.g. `main`. Null if detached HEAD or unresolvable.
   *  Has a short TTL and is re-resolved on each call. */
  readonly branch: string | null;
}

const GIT_OPTS = {
  encoding: 'utf-8' as const,
  timeout: 2000,
  stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'],
  get env() {
    return { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined };
  },
};

interface CachedIdentity {
  identity: WorktreeIdentity;
  branchResolvedAt: number;
}

export class WorktreeIdentityResolver {
  private readonly cache = new Map<string, CachedIdentity>();
  private readonly branchTtlMs = 30_000;

  resolve(dir: string | null | undefined): WorktreeIdentity | null {
    if (typeof dir !== 'string' || dir.length === 0) return null;

    const cached = this.cache.get(dir);
    const now = Date.now();

    if (cached) {
      if (now - cached.branchResolvedAt >= this.branchTtlMs) {
        const refreshed = this.resolveBranch(dir);
        // `refreshed.branch` is legitimately null for detached HEAD, which is
        // a real state a worktree can transition into — `refreshed.ok`, not
        // the branch value itself, is what distinguishes that from "the
        // subprocess call failed, keep reporting the last known branch".
        const updated: WorktreeIdentity = {
          ...cached.identity,
          branch: refreshed.ok ? refreshed.branch : cached.identity.branch,
        };
        this.cache.set(dir, { identity: updated, branchResolvedAt: now });
        return updated;
      }
      return cached.identity;
    }

    const identity = this.computeIdentity(dir);
    if (identity) {
      this.cache.set(dir, { identity, branchResolvedAt: now });
    }
    return identity;
  }

  private computeIdentity(dir: string): WorktreeIdentity | null {
    let repoKey: string;
    let worktreeKey: string;

    // Deliberately a SEPARATE call from branch resolution, not combined into
    // one `rev-parse`: --git-common-dir/--git-dir need no commit and no
    // checked-out work tree, but --abbrev-ref HEAD fails with exit 128 on a
    // freshly `git init`'d repo with zero commits yet (unborn HEAD) — the
    // same class of landmine as --show-toplevel failing on a bare primary.
    // Repo/worktree identity must not depend on a call that can fail for a
    // reason that has nothing to do with identity.
    try {
      const result = spawnSync(
        'git',
        ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir', '--git-dir'],
        GIT_OPTS,
      );

      if (result.status !== 0 || typeof result.stdout !== 'string') {
        return null;
      }

      const lines = result.stdout.trim().split('\n');
      if (lines.length < 2 || !lines[0] || !lines[1]) {
        return null;
      }

      repoKey = lines[0].trim();
      worktreeKey = lines[1].trim();
    } catch {
      return null;
    }

    // Failure here (unborn HEAD, or any other reason) is a real, common
    // state — not evidence that `dir` isn't a valid repo — so it degrades to
    // `branch: null` rather than failing the whole identity resolution.
    const branch = this.resolveBranch(dir).branch;
    const worktreeRoot = this.deriveWorktreeRoot(dir, worktreeKey, repoKey);
    const repoName = this.resolveRepoName(dir);
    const worktreeLabel = this.deriveLabel(worktreeKey, repoKey, worktreeRoot);

    return {
      repoKey,
      worktreeKey,
      repoName,
      worktreeRoot,
      worktreeLabel,
      branch,
    };
  }

  private deriveWorktreeRoot(dir: string, worktreeKey: string, repoKey: string): string | null {
    if (worktreeKey === repoKey) {
      return dirname(repoKey);
    }

    try {
      const gitdirPath = `${worktreeKey}/gitdir`;
      const content = readFileSync(gitdirPath, 'utf-8').trim();
      if (content) {
        return dirname(content);
      }
    } catch {
      /* fall through to null */
    }

    return null;
  }

  private deriveLabel(worktreeKey: string, repoKey: string, worktreeRoot: string | null): string {
    if (worktreeKey === repoKey) {
      return 'primary';
    }

    return basename(worktreeRoot ?? worktreeKey);
  }

  private resolveRepoName(dir: string): string | null {
    try {
      const result = spawnSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], GIT_OPTS);
      if (result.status === 0 && typeof result.stdout === 'string') {
        return repoNameFromRemote(result.stdout);
      }
    } catch {
      /* fall through */
    }
    return null;
  }

  /** `ok: false` means the subprocess call itself failed (caller should keep
   *  the last known branch). `ok: true, branch: null` means the call
   *  succeeded and the worktree is genuinely in detached HEAD — a real state
   *  transition the caller must apply, not mask with the stale cached value. */
  private resolveBranch(dir: string): { ok: boolean; branch: string | null } {
    try {
      const result = spawnSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], GIT_OPTS);
      if (result.status === 0 && typeof result.stdout === 'string') {
        const headRef = result.stdout.trim();
        return { ok: true, branch: headRef === 'HEAD' ? null : headRef };
      }
    } catch {
      /* fall through */
    }
    return { ok: false, branch: null };
  }
}
