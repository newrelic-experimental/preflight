#!/usr/bin/env npx tsx
/**
 * Sync src/shared/ from the sibling nr-ai-typescript-shared repo.
 *
 * Usage:
 *   npm run sync:shared
 *   npx tsx scripts/sync-shared.ts [--verbose]
 *
 * Behaviour:
 *   1. Verifies ../nr-ai-typescript-shared exists with a src/ tree.
 *   2. Warns (but does not fail) if upstream has uncommitted changes — syncing
 *      dirty code makes the regenerated tree harder to reason about.
 *   3. Replaces src/shared/ with a fresh copy of upstream src/.
 *   4. Reminds you to commit the regenerated tree.
 *
 * Options:
 *   --verbose    List every file copied.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(__dirname, '..');
const sharedSrc = resolve(repoRoot, '..', 'nr-ai-typescript-shared');
const sharedDst = resolve(repoRoot, 'src', 'shared');

const verbose = process.argv.slice(2).includes('--verbose');

function log(msg: string): void {
  console.log(`[sync-shared] ${msg}`);
}

function err(msg: string): void {
  console.error(`[sync-shared] ${msg}`);
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...walk(path));
    } else {
      out.push(path);
    }
  }
  return out;
}

if (!existsSync(sharedSrc)) {
  err(`ERROR: nr-ai-typescript-shared not found at ${sharedSrc}`);
  err('Clone it first:');
  err('  git clone <nr-ai-typescript-shared-url> ../nr-ai-typescript-shared');
  process.exit(1);
}

const srcDir = join(sharedSrc, 'src');

if (!existsSync(srcDir)) {
  err(`ERROR: src/ directory not found in ${sharedSrc}`);
  err('Initialize the upstream repo first:');
  err('  npm --prefix ../nr-ai-typescript-shared install');
  process.exit(1);
}

// Pre-sync safety: warn (don't fail) if upstream has uncommitted changes.
// execFileSync (not execSync) avoids spawning a shell — no command-injection surface.
try {
  const status = execFileSync('git', ['status', '--porcelain'], {
    cwd: sharedSrc,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  if (status) {
    log('');
    log('WARNING: ../nr-ai-typescript-shared has uncommitted changes:');
    for (const line of status.split('\n')) {
      log(`    ${line}`);
    }
    log('You are about to sync in-progress code. Commit upstream first');
    log('if you want a clean snapshot.');
    log('');
  }
} catch {
  // Not a git repo, or git unavailable — continue without the check.
}

if (existsSync(sharedDst)) {
  rmSync(sharedDst, { recursive: true, force: true });
}

// Skip *.property.test.ts files — they require fast-check which is an upstream
// devDependency not present here. The standard *.test.ts files cover the same
// behaviour for consuming-repo purposes; property tests are most valuable
// during active development of the shared module itself.
cpSync(srcDir, sharedDst, {
  recursive: true,
  filter: (src) => !src.endsWith('.property.test.ts'),
});

const fileCount = walk(sharedDst).length;
log(`Synced ${fileCount} file${fileCount === 1 ? '' : 's'}: ${srcDir} -> ${sharedDst}`);

if (verbose) {
  for (const path of walk(sharedDst)) {
    log(`  ${relative(sharedDst, path)}`);
  }
}

log('');
log('Next: review and commit the regenerated tree.');
log('  git add src/shared/ && git commit -m "Chore: sync shared from nr-ai-typescript-shared"');
