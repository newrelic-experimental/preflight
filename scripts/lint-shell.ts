#!/usr/bin/env tsx
/**
 * Runs shellcheck over the tracked shell scripts that ESLint and Prettier do
 * not reach: files under .claude/skills/ that end in .sh or start with a
 * bash/sh shebang. Without shellcheck on PATH it warns and passes locally, but
 * fails under CI so the check cannot be skipped there.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const SHEBANG_RE = /^#!\s*(?:\/usr\/bin\/env\s+)?(?:\/bin\/)?(?:ba|da|z)?sh\b/;

function trackedShellScripts(): string[] {
  const files = execFileSync('git', ['ls-files', '-z', '--', '.claude/skills'], {
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
  return files.filter(
    (file) => file.endsWith('.sh') || SHEBANG_RE.test(readFileSync(file, 'utf8').split('\n')[0]),
  );
}

function main(): void {
  const scripts = trackedShellScripts();
  if (scripts.length === 0) {
    console.log('✓ no tracked shell scripts under .claude/skills/');
    return;
  }
  const result = spawnSync('shellcheck', scripts, { stdio: 'inherit' });
  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
    if (process.env.CI) {
      console.error('✗ shellcheck is not installed, and CI requires it');
      process.exit(1);
    }
    console.warn(
      `! shellcheck not found; skipped ${scripts.length} script(s). Install: brew install shellcheck`,
    );
    return;
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
  console.log(`✓ shellcheck clean: ${scripts.length} script(s)`);
}

main();
