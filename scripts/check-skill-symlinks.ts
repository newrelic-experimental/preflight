#!/usr/bin/env tsx
/**
 * Fails when a symlink (git mode 120000) is in the index under
 * `.claude/skills/`.
 *
 * `.gitignore` tracks that directory by allow-list and keeps symlinks outside
 * the allow-listed skills out of `git status`, but it cannot stop a symlink
 * inside an allow-listed skill, or one force-added with `git add -f`. A
 * committed symlink points at a path on one developer's machine, so it is a
 * dangling link for everyone else.
 *
 * Reads the index, so the pre-commit hook sees what is about to be committed
 * and CI (a clean checkout) sees what was committed.
 */
import { execFileSync } from 'node:child_process';

const SKILLS_DIR = '.claude/skills';
const SYMLINK_MODE = '120000';

function indexedSymlinks(): string[] {
  const out = execFileSync('git', ['ls-files', '-s', '-z', '--', SKILLS_DIR], {
    encoding: 'utf8',
  });
  const symlinks: string[] = [];
  for (const entry of out.split('\0')) {
    // `<mode> <sha> <stage>\t<path>`
    const tab = entry.indexOf('\t');
    if (tab === -1) continue;
    if (entry.slice(0, entry.indexOf(' ')) === SYMLINK_MODE) symlinks.push(entry.slice(tab + 1));
  }
  return symlinks;
}

const symlinks = indexedSymlinks();
if (symlinks.length > 0) {
  console.error(`Symlinks staged or tracked under ${SKILLS_DIR}/:`);
  for (const path of symlinks) console.error(`  - ${path}`);
  console.error(
    '\n✗ FAIL: commit the skill itself, not a link to a copy kept elsewhere ' +
      '(see CONTRIBUTING.md, "The three suites"). Unstage with `git rm --cached <path>`.',
  );
  process.exit(1);
}
console.log(`✓ OK: no symlinks in the index under ${SKILLS_DIR}/.`);
