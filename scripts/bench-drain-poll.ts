#!/usr/bin/env tsx
/**
 * Microseconds per `LocalStore.drainBuffer()` poll in a storage directory
 * holding 2,000 unrelated entries, the cost every stdio engine pays each
 * 100 ms. Pass a module path to measure another build of `local-store`, such
 * as one bundled from an older revision.
 *
 *   npx tsx scripts/bench-drain-poll.ts [module] [iterations]
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type LocalStoreModule = typeof import('../src/storage/local-store.js');

const [modulePath = resolve(import.meta.dirname, '../src/storage/local-store.ts'), iterationsArg] =
  process.argv.slice(2);
const { LocalStore } = (await import(pathToFileURL(resolve(modulePath)).href)) as LocalStoreModule;
const iterations = Number(iterationsArg ?? 20_000);
const session = 'bench-session';
const line =
  JSON.stringify({ mode: 'post', tool: 'Bash', input: {}, timestamp: 1, sessionId: session }) +
  '\n';

const MODES = ['idle, no drains/', 'idle, drains/ present', 'one line per poll'] as const;

function measure(mode: (typeof MODES)[number]): number {
  const dir = mkdtempSync(resolve(tmpdir(), 'bench-drain-poll-'));
  try {
    for (let i = 0; i < 2000; i++) {
      writeFileSync(resolve(dir, i % 2 ? `buffer-other-${i}.jsonl` : `active-other-${i}.pid`), '');
    }
    if (mode !== 'idle, no drains/') mkdirSync(resolve(dir, 'drains'));
    const store = new LocalStore(dir, session);
    const bufferPath = resolve(dir, `buffer-${session}.jsonl`);
    const poll = (): number => {
      if (mode === 'one line per poll') writeFileSync(bufferPath, line);
      return store.drainBuffer().length;
    };
    for (let i = 0; i < iterations / 10; i++) poll();
    let returned = 0;
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) returned += poll();
    const elapsedNs = Number(process.hrtime.bigint() - start);
    const expected = mode === 'one line per poll' ? iterations : 0;
    if (returned !== expected)
      throw new Error(`${mode}: returned ${returned}, expected ${expected}`);
    return elapsedNs / iterations / 1000;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const mode of MODES) console.log(`${mode}: ${measure(mode).toFixed(1)} µs/poll`);
