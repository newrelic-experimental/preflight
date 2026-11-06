#!/usr/bin/env tsx
/**
 * Drives the always-on `--local` server and a per-session `--stdio` server
 * against one shared storage dir, restarts them, and checks that one session's
 * cost and tool calls are counted once. It needs a build (`npm run build`) and
 * feeds only what Claude Code writes, so it needs no API key.
 *
 *   npm run test:scenario
 *
 * Two scenarios, each in a fresh isolated run (see .claude/skills/verify-preflight):
 *   local-only   `--local` tails the transcript alone, then restarts.
 *   split-turns  `--stdio` bills turn A, `--local` bills turn B, then both restart.
 *
 * A check tagged with a `knownBug` is expected to fail. It prints `xfail` and
 * does not fail the run. When it starts to pass the run fails with `XPASS`, so
 * the tag cannot outlive the fix.
 */
import { execFileSync, spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PF = join(REPO, '.claude/skills/verify-preflight/scripts/pf-verify');
const PORT = process.env.PF_PORT ?? '7795';
const MODEL = 'claude-sonnet-4-5-20250929';
const PERSIST_MS = 3000;
const SETTLE_MS = 2 * PERSIST_MS + 1000;
const CLAUDE_VAR = /^CLAUDE/;

// Sonnet 4.5 bills $3 per million input tokens and $15 per million output tokens.
const TURN_A = { input: '1000000', output: '0', usd: 3 } as const;
const TURN_B = { input: '0', output: '200000', usd: 3 } as const;
const BOTH_TURNS_USD = TURN_A.usd + TURN_B.usd;
const TOOL_CALLS = 3;

const SPLIT_TURNS_BUG =
  'session saves merge cost by max, so turns billed by different processes count only the larger share';

interface Check {
  readonly name: string;
  readonly outcome: 'ok' | 'FAIL' | 'xfail' | 'XPASS';
  readonly detail: string;
}

interface TodayTotals {
  readonly totalCostUsd: number;
  readonly toolCallCount: number;
  readonly sessionCount: number;
}

const checks: Check[] = [];

function check(name: string, actual: unknown, expected: unknown, knownBug?: string): void {
  const passed = actual === expected;
  const detail = `expected ${String(expected)}, got ${String(actual)}`;
  const outcome = knownBug ? (passed ? 'XPASS' : 'xfail') : passed ? 'ok' : 'FAIL';
  const suffix = knownBug ? ` (known: ${knownBug})` : '';
  checks.push({ name, outcome, detail: `${detail}${suffix}` });
  console.log(`${outcome.padEnd(5)} ${name}: ${detail}${suffix}`);
}

const baseEnv: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && !CLAUDE_VAR.test(key)) baseEnv[key] = value;
}
baseEnv.PF_PORT = PORT;
baseEnv.PF_PERSIST_MS = String(PERSIST_MS);

function pf(...args: string[]): string {
  return execFileSync(PF, args, { env: baseEnv, encoding: 'utf8' }).trim();
}

function field(object: unknown, key: string): number {
  const value = (object as Record<string, unknown> | null)?.[key];
  if (typeof value !== 'number') throw new Error(`expected a number at "${key}"`);
  return value;
}

function todayTotals(): TodayTotals {
  const body: unknown = JSON.parse(pf('api', '/api/sessions/today/aggregate'));
  return {
    totalCostUsd: field(body, 'totalCostUsd'),
    toolCallCount: field(body, 'toolCallCount'),
    sessionCount: field(body, 'sessionCount'),
  };
}

function localSessionCostUsd(): number | null {
  const body = JSON.parse(pf('api', '/api/cost')) as {
    cost: { sessionTotalCostUsd: number | null };
  };
  return body.cost.sessionTotalCostUsd;
}

async function waitFor<T>(
  probe: () => T | Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 25_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await probe();
  while (!done(value) && Date.now() < deadline) {
    await delay(500);
    value = await probe();
  }
  return value;
}

function sendHooks(sid: string): void {
  pf('hook', sid, 'Read', '{"file_path":"/tmp/pf-verify-project/src/app.ts"}');
  pf('hook', sid, 'Bash', '{"command":"npm test"}');
  pf(
    'hook',
    sid,
    'Edit',
    '{"file_path":"/tmp/pf-verify-project/src/app.ts","old_string":"a","new_string":"b"}',
  );
}

function sendTurn(sid: string, turn: { readonly input: string; readonly output: string }): void {
  pf('turn', sid, MODEL, turn.input, turn.output, '0');
}

class StdioServer {
  private readonly child: ChildProcessByStdio<Writable, Readable, null>;
  private readonly pending = new Map<number, (message: unknown) => void>();
  private buffer = '';
  private nextId = 0;

  constructor(runDir: string, sid: string) {
    const jobDir = join(runDir, 'job');
    mkdirSync(jobDir, { recursive: true });
    const transcript = join(runDir, 'home/.claude/projects/-tmp-pf-verify-project', `${sid}.jsonl`);
    writeFileSync(join(jobDir, 'state.json'), JSON.stringify({ linkScanPath: transcript }));
    const env: Record<string, string> = { ...baseEnv, CLAUDE_JOB_DIR: jobDir };
    for (const line of pf('env').split('\n')) {
      const at = line.indexOf('=');
      env[line.slice(0, at)] = line.slice(at + 1);
    }
    this.child = spawn(process.execPath, ['dist/index.js', '--stdio'], {
      cwd: REPO,
      env,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    this.child.stdout.on('data', (chunk: Buffer) => this.onData(chunk.toString()));
  }

  private onData(text: string): void {
    this.buffer += text;
    for (let nl = this.buffer.indexOf('\n'); nl >= 0; nl = this.buffer.indexOf('\n')) {
      const message = JSON.parse(this.buffer.slice(0, nl)) as { id?: number };
      this.buffer = this.buffer.slice(nl + 1);
      if (message.id !== undefined) this.pending.get(message.id)?.(message);
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.nextId;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => reject(new Error(`stdio ${method} timed out`)), 15_000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolveRequest(message);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async start(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'scenario-both-modes-restart', version: '1' },
    });
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    await delay(3000);
  }

  async costUsd(): Promise<number> {
    const message = (await this.request('tools/call', {
      name: 'nr_observe_get_cost_breakdown',
      arguments: {},
    })) as { result: { content: { text: string }[] } };
    return field(JSON.parse(message.result.content[0].text), 'total_usd');
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null) return;
    const exited = new Promise<void>((done) => this.child.once('exit', () => done()));
    this.child.kill();
    const force = setTimeout(() => this.child.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(force);
  }
}

function runDir(): string {
  const line = pf('where')
    .split('\n')
    .find((l) => l.startsWith('run='));
  if (!line) throw new Error('pf-verify where printed no run dir');
  return line.slice('run='.length);
}

async function localOnly(): Promise<void> {
  console.log('\n-- local-only');
  pf('up');
  try {
    const sid = pf('sid');
    sendHooks(sid);
    sendTurn(sid, TURN_A);
    sendTurn(sid, TURN_B);
    const today = await waitFor(todayTotals, (t) => t.totalCostUsd >= BOTH_TURNS_USD);
    check('local bills both turns', today.totalCostUsd, BOTH_TURNS_USD);
    check('local counts each tool call once', today.toolCallCount, TOOL_CALLS);

    pf('stop');
    pf('restart');
    await delay(SETTLE_MS);
    const restarted = todayTotals();
    check('local restart does not bill again', restarted.totalCostUsd, BOTH_TURNS_USD);
    check('local restart does not recount tool calls', restarted.toolCallCount, TOOL_CALLS);
    check('local restart keeps one session', restarted.sessionCount, 1);
  } finally {
    pf('down');
  }
}

async function splitTurns(): Promise<void> {
  console.log('\n-- split-turns');
  pf('up');
  pf('stop');
  let stdio: StdioServer | null = null;
  try {
    const sid = pf('sid');
    const run = runDir();
    stdio = new StdioServer(run, sid);
    await stdio.start();
    sendHooks(sid);
    sendTurn(sid, TURN_A);
    const first = stdio;
    const stdioCost = await waitFor(
      () => first.costUsd(),
      (cost) => cost === TURN_A.usd,
    );
    check('stdio bills turn A', stdioCost, TURN_A.usd);
    await delay(SETTLE_MS);
    await stdio.stop();

    sendTurn(sid, TURN_B);
    pf('restart');
    const localCost = await waitFor(localSessionCostUsd, (cost) => cost === TURN_B.usd);
    check('local bills turn B once the stdio server is gone', localCost, TURN_B.usd);
    stdio = new StdioServer(run, sid);
    await stdio.start();
    await delay(SETTLE_MS);

    const split = todayTotals();
    check('Today counts both turns', split.totalCostUsd, BOTH_TURNS_USD, SPLIT_TURNS_BUG);
    check('Today counts each tool call once', split.toolCallCount, TOOL_CALLS);
    check('Today keeps one session', split.sessionCount, 1);

    await stdio.stop();
    pf('stop');
    pf('restart');
    stdio = new StdioServer(run, sid);
    await stdio.start();
    await delay(SETTLE_MS);

    const restarted = todayTotals();
    check(
      'restarting both modes leaves the cost unchanged',
      restarted.totalCostUsd,
      split.totalCostUsd,
    );
    check('restarting both modes leaves tool calls unchanged', restarted.toolCallCount, TOOL_CALLS);
    check('restarting both modes keeps one session', restarted.sessionCount, 1);
  } finally {
    await stdio?.stop();
    pf('down');
  }
}

try {
  await localOnly();
  await splitTurns();
} catch (error) {
  checks.push({ name: 'scenario ran to completion', outcome: 'FAIL', detail: String(error) });
  console.log(`FAIL  scenario ran to completion: ${String(error)}`);
}

const failed = checks.filter((c) => c.outcome === 'FAIL' || c.outcome === 'XPASS');
const known = checks.filter((c) => c.outcome === 'xfail');
console.log(`\n${checks.length} checks, ${failed.length} failed, ${known.length} known failures`);
if (failed.some((c) => c.outcome === 'XPASS')) {
  console.log('A known failure now passes. Remove its knownBug tag.');
}
process.exit(failed.length > 0 ? 1 : 0);
