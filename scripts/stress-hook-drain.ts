#!/usr/bin/env tsx
/**
 * Races one hook writer against four drainer processes (two `drainBuffer`, two
 * `drainAllBuffers`) and counts what the drainers return. A line returned zero
 * times was lost, and one returned twice was doubled. Exits 1 on either, or on
 * a claim or `.migrating` file left behind.
 *
 *   npx tsx scripts/stress-hook-drain.ts [lines]
 */
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { LocalStore } from '../src/storage/local-store.js';
import { appendToHookBuffer } from '../src/storage/hook-buffer.js';

const SESSION = 'stress-session';
const DRAINERS = 4;

function runWriter(dir: string, lines: number): void {
  const bufferPath = resolve(dir, `buffer-${SESSION}.jsonl`);
  for (let i = 0; i < lines; i++) {
    const event = { mode: 'post', tool: `w${i}`, input: {}, timestamp: 1, sessionId: SESSION };
    appendToHookBuffer(bufferPath, JSON.stringify(event) + '\n');
  }
}

function runDrainer(dir: string, index: number): void {
  const store = index % 2 ? new LocalStore(dir) : new LocalStore(dir, SESSION);
  const out = resolve(dir, `out-${index}.txt`);
  const drain = (): number => {
    const events = index % 2 ? store.drainAllBuffers() : store.drainBuffer();
    if (events.length) appendFileSync(out, events.map((e) => e.tool).join('\n') + '\n');
    return events.length;
  };
  let quiet = 0;
  while (quiet < 3) {
    const drained = drain();
    if (existsSync(resolve(dir, 'done'))) quiet = drained ? 0 : quiet + 1;
  }
}

function spawnRole(role: string, dir: string, extra: string[]): Promise<number> {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', import.meta.filename, role, dir, ...extra],
    { stdio: 'inherit' },
  );
  return new Promise((done) => child.on('exit', (code) => done(code ?? 1)));
}

async function runParent(lines: number): Promise<void> {
  const dir = mkdtempSync(resolve(tmpdir(), 'stress-hook-drain-'));
  try {
    const drainers = Array.from({ length: DRAINERS }, (_, i) =>
      spawnRole('drainer', dir, [String(i)]),
    );
    const writerCode = await spawnRole('writer', dir, [String(lines)]);
    writeFileSync(resolve(dir, 'done'), '');
    const drainerCodes = await Promise.all(drainers);

    const seen = new Map<string, number>();
    for (const name of readdirSync(dir).filter((n) => n.startsWith('out-'))) {
      for (const tool of readFileSync(resolve(dir, name), 'utf-8').split('\n')) {
        if (tool) seen.set(tool, (seen.get(tool) ?? 0) + 1);
      }
    }
    let lost = 0;
    for (let i = 0; i < lines; i++) if (!seen.has(`w${i}`)) lost++;
    const doubled = [...seen.values()].filter((n) => n > 1).length;
    const drainsDir = resolve(dir, 'drains');
    const leftBehind = [
      ...(existsSync(drainsDir) ? readdirSync(drainsDir) : []),
      ...readdirSync(dir).filter((n) => n.startsWith('buffer-')),
    ];

    console.log(
      `lines ${lines}, lost ${lost}, doubled ${doubled}, left behind ${leftBehind.length}`,
    );
    const failed = [writerCode, ...drainerCodes].some((c) => c !== 0);
    if (lost || doubled || leftBehind.length || failed) process.exitCode = 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const [role, dir, arg] = process.argv.slice(2);
if (role === 'writer') runWriter(dir!, Number(arg));
else if (role === 'drainer') runDrainer(dir!, Number(arg));
else await runParent(Number(role && /^\d+$/.test(role) ? role : 20_000));
