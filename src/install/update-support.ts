import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

export function findRepoRoot(): string | null {
  try {
    let dir = dirname(realpathSync(process.argv[1]));
    while (true) {
      if (existsSync(join(dir, 'package.json'))) return dir;
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  } catch {
    return null;
  }
}

export const UPGRADE_COMMAND = 'npm install -g @newrelic/preflight@latest';

export type UpdateBlocker = 'no-repo-root' | 'no-git' | 'package-manager';

export type UpdateSupport =
  | { readonly supported: true; readonly repoRoot: string }
  | { readonly supported: false; readonly blocker: UpdateBlocker };

/**
 * `preflight update` runs `git pull` and a rebuild, so it only works on a
 * source clone. Everything that schedules or relies on it asks this one
 * function.
 */
export function detectUpdateSupport(): UpdateSupport {
  const repoRoot = findRepoRoot();
  if (!repoRoot) return { supported: false, blocker: 'no-repo-root' };

  let gitRoot: string;
  try {
    gitRoot = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--show-toplevel'], {
      stdio: 'pipe',
      env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined },
    })
      .toString()
      .trim();
  } catch (err) {
    const blocker = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'no-git' : 'package-manager';
    return { supported: false, blocker };
  }

  // A repoRoot below node_modules inside a git tree is a dependency, not a clone.
  // path.relative() normalises separators on all platforms.
  if (relative(gitRoot, repoRoot).split(sep).includes('node_modules')) {
    return { supported: false, blocker: 'package-manager' };
  }
  return { supported: true, repoRoot };
}

export function updateBlockerLines(blocker: UpdateBlocker): string[] {
  switch (blocker) {
    case 'no-repo-root':
      return [
        '✗ Could not locate the repo root. Run this command from within the cloned repo or after npm link.',
      ];
    case 'no-git':
      return [
        '✗ git is not installed or not found on PATH.',
        '  Install git (https://git-scm.com) then retry: preflight update',
      ];
    case 'package-manager':
      return [
        '✗ preflight was installed via a package manager, not cloned from source.',
        '  (If your .git directory is missing or corrupt, re-clone the repo instead.)',
        '  To update, reinstall using your package manager, e.g.:',
        `    ${UPGRADE_COMMAND}`,
        '    pnpm add -g @newrelic/preflight@latest',
      ];
  }
}
