import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BilledTurnLedger, pruneBilledTurns, type BillableTurn } from './billed-turn-ledger.js';

const PARENT = 'c0ac675e-9be7-48e9-87b8-86394606f2dc';
const FORK = '5634b9b2-8fa1-42c8-aff0-a4b50a704343';
const DAY_MS = 24 * 60 * 60 * 1000;

function turn(messageId: string, iso: string) {
  return { messageId, timestampMs: Date.parse(iso) };
}

function deliver<T extends BillableTurn>(
  ledger: BilledTurnLedger,
  sessionId: string,
  turns: readonly T[],
): T[] {
  const delivered: T[] = [];
  ledger.deliver(sessionId, turns, (t) => delivered.push(t));
  return delivered;
}

describe('BilledTurnLedger', () => {
  let storagePath: string;

  beforeEach(() => {
    storagePath = mkdtempSync(join(tmpdir(), 'billed-turn-ledger-'));
  });

  afterEach(() => {
    rmSync(storagePath, { recursive: true, force: true });
  });

  const makeLedger = (now?: () => number, retainDays?: number | null) =>
    new BilledTurnLedger({ storagePath, now, retainDays });

  it('returns a new turn once, and nothing when the same input is claimed again', () => {
    const ledger = makeLedger();
    const a = turn('msg_A', '2026-06-15T12:00:00.000Z');
    expect(deliver(ledger, PARENT, [a])).toEqual([a]);
    expect(deliver(ledger, PARENT, [a])).toEqual([]);
    expect(deliver(makeLedger(), PARENT, [a])).toEqual([]);
  });

  it('returns only the first line of a multi-line message, in and across batches', () => {
    const ledger = makeLedger();
    const first = turn('msg_A', '2026-06-15T12:00:00.000Z');
    const second = turn('msg_A', '2026-06-15T12:00:01.000Z');
    const other = turn('msg_B', '2026-06-15T12:00:02.000Z');
    expect(deliver(ledger, PARENT, [first, second, other])).toEqual([first, other]);
    expect(deliver(ledger, PARENT, [turn('msg_A', '2026-06-15T12:00:03.000Z')])).toEqual([]);
  });

  it("drops another session's copy of a billed turn, including after a restart", () => {
    const a = turn('msg_A', '2026-10-29T22:30:50.181Z');
    const c = turn('msg_C', '2026-10-29T22:31:31.042Z');
    expect(deliver(makeLedger(), PARENT, [a])).toEqual([a]);
    expect(deliver(makeLedger(), FORK, [a, c])).toEqual([c]);
    expect(deliver(makeLedger(), PARENT, [a, c])).toEqual([]);
  });

  it('resolves a message whose lines straddle UTC midnight to one owner', () => {
    const beforeMidnight = turn('msg_A', '2026-06-15T23:59:59.900Z');
    const afterMidnight = turn('msg_A', '2026-06-16T00:00:00.100Z');
    expect(deliver(makeLedger(), PARENT, [beforeMidnight])).toEqual([beforeMidnight]);
    expect(deliver(makeLedger(), PARENT, [afterMidnight])).toEqual([]);
    expect(deliver(makeLedger(), FORK, [afterMidnight])).toEqual([]);
  });

  it('ignores a torn line left by a crashed writer', () => {
    const dir = join(storagePath, 'billed-turns');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, '2026-06-15.jsonl'), `{"m":"msg_A","s":"${FORK}`);
    const a = turn('msg_A', '2026-06-15T12:00:00.000Z');
    expect(deliver(makeLedger(), PARENT, [a])).toEqual([a]);
    expect(deliver(makeLedger(), FORK, [a])).toEqual([]);
  });

  it('refuses turns beyond the retention horizon and never re-bills a pruned day', () => {
    const t = turn('msg_A', '2026-06-15T12:00:00.000Z');
    const soon = t.timestampMs + DAY_MS;
    const later = t.timestampMs + 100 * DAY_MS;
    expect(
      deliver(
        makeLedger(() => soon, 90),
        PARENT,
        [t],
      ),
    ).toEqual([t]);

    expect(pruneBilledTurns(storagePath, 90, soon)).toBe(0);
    expect(pruneBilledTurns(storagePath, 90, later)).toBe(1);
    expect(readdirSync(join(storagePath, 'billed-turns'))).toEqual([]);

    expect(
      deliver(
        makeLedger(() => later, 90),
        PARENT,
        [t],
      ),
    ).toEqual([]);
    expect(
      deliver(
        makeLedger(() => later, 90),
        FORK,
        [t],
      ),
    ).toEqual([]);
    expect(
      deliver(
        makeLedger(() => later, null),
        FORK,
        [t],
      ),
    ).toEqual([t]);
  });

  async function raceClaimers(sessionIds: readonly [string, string], ids: readonly string[]) {
    const startAt = Date.now() + 1_000;
    const script = `
      const { BilledTurnLedger } = await import(${JSON.stringify(join(process.cwd(), 'src/hooks/billed-turn-ledger.ts'))});
      const [storagePath, sessionId, startAt, ids] = JSON.parse(process.argv[1]);
      const ledger = new BilledTurnLedger({ storagePath });
      const ts = Date.parse('2026-06-15T12:00:00.000Z');
      while (Date.now() < startAt);
      const won = [];
      for (const id of ids) ledger.deliver(sessionId, [{ messageId: id, timestampMs: ts }], (t) => won.push(t));
      process.stdout.write(JSON.stringify(won.map((t) => t.messageId)));
    `;
    const runClaimer = (sessionId: string) =>
      new Promise<string[]>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            '--import',
            'tsx',
            '--input-type=module',
            '-e',
            script,
            JSON.stringify([storagePath, sessionId, startAt, ids]),
          ],
          { cwd: process.cwd() },
        );
        let out = '';
        let err = '';
        child.stdout.on('data', (d: Buffer) => (out += d.toString()));
        child.stderr.on('data', (d: Buffer) => (err += d.toString()));
        child.on('error', reject);
        child.on('close', (code) =>
          code === 0 ? resolve(JSON.parse(out) as string[]) : reject(new Error(err)),
        );
      });
    return Promise.all(sessionIds.map(runClaimer));
  }

  const RACE_IDS = Array.from({ length: 300 }, (_, i) => `msg_${i}`);

  it('awards each message to exactly one of two processes racing on the same ids', async () => {
    const [parentWon, forkWon] = await raceClaimers([PARENT, FORK], RACE_IDS);

    expect(parentWon.filter((id) => forkWon.includes(id))).toEqual([]);
    expect([...parentWon, ...forkWon].sort()).toEqual([...RACE_IDS].sort());
  }, 15_000);

  it('awards each message to exactly one of two processes tailing the same session', async () => {
    const [firstWon, secondWon] = await raceClaimers([PARENT, PARENT], RACE_IDS);

    expect(firstWon.filter((id) => secondWon.includes(id))).toEqual([]);
    expect([...firstWon, ...secondWon].sort()).toEqual([...RACE_IDS].sort());
  }, 15_000);

  it('drops a turn an earlier process claimed for the same session', () => {
    const a = turn('msg_A', '2026-06-15T12:00:00.000Z');
    expect(deliver(makeLedger(), PARENT, [a])).toEqual([a]);
    expect(deliver(makeLedger(), PARENT, [a])).toEqual([]);
  });

  it('reads a day file that was deleted and regrown past its cached length from the top', () => {
    const watcher = makeLedger();
    const a = turn('msg_A', '2026-06-15T12:00:00.000Z');
    expect(deliver(watcher, PARENT, [a])).toEqual([a]);

    rmSync(join(storagePath, 'billed-turns', '2026-06-15.jsonl'));
    const others = Array.from({ length: 20 }, (_, i) =>
      turn(`msg_other_${i}`, '2026-06-15T12:00:00.000Z'),
    );
    const x = turn('msg_X', '2026-06-15T12:00:00.000Z');
    expect(deliver(makeLedger(), FORK, [x, ...others])).toEqual([x, ...others]);

    expect(deliver(watcher, PARENT, [x])).toEqual([]);
  });

  it('hands a requeued turn back only to the session it was claimed for', () => {
    const ledger = makeLedger();
    const a = turn('msg_A', '2026-06-15T12:00:00.000Z');
    expect(() =>
      ledger.deliver(PARENT, [a], () => {
        throw new Error('ENOSPC');
      }),
    ).toThrow('ENOSPC');

    expect(deliver(ledger, FORK, [a])).toEqual([]);
    expect(deliver(ledger, PARENT, [a])).toEqual([a]);
    expect(deliver(ledger, PARENT, [a])).toEqual([]);
  });

  it('bills a message once when only some of its lines carry a timestamp', () => {
    const nowMs = Date.parse('2026-06-15T12:00:05.000Z');
    const dated = turn('msg_A', '2026-06-15T12:00:00.000Z');
    const undated = { messageId: 'msg_A', timestampMs: nowMs, undated: true };
    expect(
      deliver(
        makeLedger(() => nowMs),
        PARENT,
        [dated],
      ),
    ).toEqual([dated]);
    expect(
      deliver(
        makeLedger(() => nowMs),
        FORK,
        [undated],
      ),
    ).toEqual([]);

    const undatedFirst = { messageId: 'msg_B', timestampMs: nowMs, undated: true };
    expect(
      deliver(
        makeLedger(() => nowMs),
        PARENT,
        [undatedFirst],
      ),
    ).toEqual([undatedFirst]);
    expect(
      deliver(
        makeLedger(() => nowMs),
        FORK,
        [turn('msg_B', '2026-06-15T12:00:06.000Z')],
      ),
    ).toEqual([]);
  });

  it('prunes the day files it can and keeps going past one it cannot delete', () => {
    const dir = join(storagePath, 'billed-turns');
    mkdirSync(join(dir, '2026-01-01.jsonl'), { recursive: true });
    writeFileSync(join(dir, '2026-01-02.jsonl'), '');
    const later = Date.parse('2026-06-15T12:00:00.000Z');

    expect(pruneBilledTurns(storagePath, 90, later)).toBe(1);
    expect(readdirSync(dir)).toEqual(['2026-01-01.jsonl']);
  });
});
