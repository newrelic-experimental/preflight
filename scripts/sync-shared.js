#!/usr/bin/env node
// Copies src/ from the sibling nr-ai-typescript-shared repo into packages/shared/src/.
// Run automatically by 'npm run build' before tsc --build.

import { cpSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(__dirname, '..');
const sharedSrc = resolve(repoRoot, '..', 'nr-ai-typescript-shared');
const sharedDst = resolve(repoRoot, 'packages', 'shared');

if (!existsSync(sharedSrc)) {
  console.error(`[sync-shared] ERROR: nr-ai-typescript-shared not found at ${sharedSrc}`);
  console.error('[sync-shared] Clone it first:');
  console.error('[sync-shared]   git clone <nr-ai-typescript-shared-url> ../nr-ai-typescript-shared');
  process.exit(1);
}

const srcDir = join(sharedSrc, 'src');
const dstDir = join(sharedDst, 'src');

if (!existsSync(srcDir)) {
  console.error(`[sync-shared] ERROR: src/ directory not found in ${sharedSrc}`);
  console.error('[sync-shared] Build nr-ai-typescript-shared first:');
  console.error('[sync-shared]   npm --prefix ../nr-ai-typescript-shared install');
  process.exit(1);
}

// Remove stale destination before copy to avoid leftover files
if (existsSync(dstDir)) {
  rmSync(dstDir, { recursive: true, force: true });
}

cpSync(srcDir, dstDir, { recursive: true });
console.log(`[sync-shared] Synced ${srcDir} → ${dstDir}`);
