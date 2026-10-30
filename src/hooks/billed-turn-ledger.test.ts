import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BilledTurnLedger, pruneBilledTurns, type BillableTurn } from './billed-turn-ledger.js';

const PARENT = 'c0ac675e-9be7-48e9-87b8-86394606f2dc';
const FORK = '5634b9b2-8fa1-42c8-aff0-a4b50a704343';
const DAY_MS = 24 * 60 * 60 * 1000;
const CLAIMED_AT = Date.parse('2026-06-15T12:00:05.000Z');

function claimFileOf(messageId: string, nowMs: number): string {
  const shard = createHash('sha256').update(messageId).digest('hex')[0];
  return `g${Math.floor(nowMs / (7 * DAY_MS))}-${shard}.jsonl`;
}

function turn(messageId: string, iso: string) {
  return { messageId, timestampMs: Date.parse(iso) };
}

function idsInOneShard(prefix: string, count: number): string[] {
  const ids: string[] = [];
  for (let n = 0; ids.length < count; n++) {
    const id = `${prefix}${n}`;
    if (createHash('sha256').update(id).digest('hex').startsWith('0')) ids.push(id);
  }
  return ids;
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
  let logSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    storagePath = mkdtempSync(join(tmpdir(), 'billed-turn-ledger-'));
    logSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
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
    appendFileSync(join(dir, claimFileOf('msg_A', CLAIMED_AT)), `{"m":"msg_A","s":"${FORK}`);
    const a = turn('msg_A', '2026-06-15T12:00:00.000Z');
    expect(
      deliver(
        makeLedger(() => CLAIMED_AT),
        PARENT,
        [a],
      ),
    ).toEqual([a]);
    expect(
      deliver(
        makeLedger(() => CLAIMED_AT),
        FORK,
        [a],
      ),
    ).toEqual([]);
  });

  it('refuses turns beyond the retention horizon and never re-bills a pruned generation', () => {
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

  interface Claimer {
    readonly sessionId: string;
    readonly timestampMs: number;
    readonly undated?: boolean;
  }

  const NOON = Date.parse('2026-06-15T12:00:00.000Z');

  async function raceClaimers(claimers: readonly [Claimer, Claimer], ids: readonly string[]) {
    const startAt = Date.now() + 1_000;
    const script = `
      const { BilledTurnLedger } = await import(${JSON.stringify(join(process.cwd(), 'src/hooks/billed-turn-ledger.ts'))});
      const [storagePath, sessionId, timestampMs, undated, startAt, ids] = JSON.parse(process.argv[1]);
      const ledger = new BilledTurnLedger({ storagePath });
      while (Date.now() < startAt);
      const won = [];
      for (const id of ids) ledger.deliver(sessionId, [{ messageId: id, timestampMs, undated }], (t) => won.push(t));
      process.stdout.write(JSON.stringify(won.map((t) => t.messageId)));
    `;
    const runClaimer = ({ sessionId, timestampMs, undated = false }: Claimer) =>
      new Promise<string[]>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            '--import',
            'tsx',
            '--input-type=module',
            '-e',
            script,
            JSON.stringify([storagePath, sessionId, timestampMs, undated, startAt, ids]),
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
    const [first, second] = await Promise.all(claimers.map(runClaimer));
    return {
      both: first.filter((id) => second.includes(id)),
      all: [...first, ...second].sort(),
    };
  }

  const RACE_IDS = Array.from({ length: 300 }, (_, i) => `msg_${i}`);

  it('awards each message to exactly one of two processes racing on the same ids', async () => {
    const result = await raceClaimers(
      [
        { sessionId: PARENT, timestampMs: NOON },
        { sessionId: FORK, timestampMs: NOON },
      ],
      RACE_IDS,
    );
    expect(result).toEqual({ both: [], all: [...RACE_IDS].sort() });
  }, 15_000);

  it('awards each message to exactly one of two processes tailing the same session', async () => {
    const result = await raceClaimers(
      [
        { sessionId: PARENT, timestampMs: NOON },
        { sessionId: PARENT, timestampMs: NOON },
      ],
      RACE_IDS,
    );
    expect(result).toEqual({ both: [], all: [...RACE_IDS].sort() });
  }, 15_000);

  it('awards each message to one of two processes holding lines either side of UTC midnight', async () => {
    const result = await raceClaimers(
      [
        { sessionId: PARENT, timestampMs: Date.parse('2026-06-15T23:59:59.900Z') },
        { sessionId: FORK, timestampMs: Date.parse('2026-06-16T00:00:00.100Z') },
      ],
      RACE_IDS,
    );
    expect(result).toEqual({ both: [], all: [...RACE_IDS].sort() });
  }, 15_000);

  it('awards each message to one of two processes holding a dated and an undated line', async () => {
    const result = await raceClaimers(
      [
        { sessionId: PARENT, timestampMs: NOON },
        { sessionId: FORK, timestampMs: NOON + 5_000, undated: true },
      ],
      RACE_IDS,
    );
    expect(result).toEqual({ both: [], all: [...RACE_IDS].sort() });
  }, 15_000);

  it('drops a turn an earlier process claimed for the same session', () => {
    const a = turn('msg_A', '2026-06-15T12:00:00.000Z');
    expect(deliver(makeLedger(), PARENT, [a])).toEqual([a]);
    expect(deliver(makeLedger(), PARENT, [a])).toEqual([]);
  });

  it('reads a ledger file that was deleted and regrown past its cached length from the top', () => {
    const ts = '2026-06-15T12:00:00.000Z';
    const [a, x, ...others] = idsInOneShard('msg_', 22).map((id) => turn(id, ts));
    const watcher = makeLedger(() => CLAIMED_AT);
    expect(deliver(watcher, PARENT, [a])).toEqual([a]);

    rmSync(join(storagePath, 'billed-turns', claimFileOf(a.messageId, CLAIMED_AT)));
    expect(
      deliver(
        makeLedger(() => CLAIMED_AT),
        FORK,
        [x, ...others],
      ),
    ).toEqual([x, ...others]);

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

  it('prunes the ledger files it can and keeps going past one it cannot delete', () => {
    const dir = join(storagePath, 'billed-turns');
    mkdirSync(join(dir, 'g0-0.jsonl'), { recursive: true });
    writeFileSync(join(dir, 'g1-a.jsonl'), '');
    writeFileSync(join(dir, 'notes.txt'), '');
    const later = Date.parse('2026-06-15T12:00:00.000Z');

    expect(pruneBilledTurns(storagePath, 90, later)).toBe(1);
    expect(readdirSync(dir).sort()).toEqual(['g0-0.jsonl', 'notes.txt']);
  });

  it('bills a message once when a dated line is re-read undated days later', () => {
    const dated = turn('msg_A', '2026-06-15T12:00:00.000Z');
    const later = dated.timestampMs + 3 * DAY_MS;
    const undated = { messageId: 'msg_A', timestampMs: later, undated: true };
    expect(
      deliver(
        makeLedger(() => dated.timestampMs + 5_000),
        PARENT,
        [dated],
      ),
    ).toEqual([dated]);
    expect(
      deliver(
        makeLedger(() => later),
        FORK,
        [undated],
      ),
    ).toEqual([]);
  });

  it('bills a turn with an unreadable timestamp once instead of throwing', () => {
    const unreadable = { messageId: 'msg_A', timestampMs: Number.NaN };
    expect(deliver(makeLedger(undefined, 90), PARENT, [unreadable])).toEqual([unreadable]);
    expect(deliver(makeLedger(undefined, 90), FORK, [unreadable])).toEqual([]);
  });

  it('never re-bills a later line of a message whose claim was pruned at the horizon', () => {
    const first = turn('msg_A', '2026-06-15T23:59:59.900Z');
    const second = turn('msg_A', '2026-06-16T00:00:00.100Z');
    const claimedAt = Date.parse('2026-06-16T00:00:01.000Z');
    const later = Date.parse('2026-06-17T12:00:00.000Z');
    expect(
      deliver(
        makeLedger(() => claimedAt, 1),
        PARENT,
        [first],
      ),
    ).toEqual([first]);

    pruneBilledTurns(storagePath, 1, later);
    expect(
      deliver(
        makeLedger(() => later, 1),
        FORK,
        [second],
      ),
    ).toEqual([]);
  });

  it('reads a claim whose multibyte message id was split across two reads', () => {
    const nowMs = Date.parse('2026-06-15T12:00:05.000Z');
    const ts = '2026-06-15T12:00:00.000Z';
    const dir = join(storagePath, 'billed-turns');
    const probes = idsInOneShard('msg_probe_', 4);
    const [target] = idsInOneShard('msg_é_', 1);
    const probeTurns = probes.map((id) => turn(id, ts));
    expect(
      deliver(
        makeLedger(() => nowMs),
        FORK,
        probeTurns,
      ),
    ).toEqual(probeTurns);
    const [file] = readdirSync(dir);
    const claim = Buffer.from(`\n{"m":"${target}","s":"${FORK}","c":"another-claimant"}\n`);
    const split = claim.indexOf(0xc3) + 1;

    const watcher = makeLedger(() => nowMs);
    appendFileSync(join(dir, file), claim.subarray(0, split));
    expect(deliver(watcher, PARENT, probeTurns)).toEqual([]);
    appendFileSync(join(dir, file), claim.subarray(split));
    expect(deliver(watcher, PARENT, [turn(target, ts)])).toEqual([]);
  });

  it('bills a turn again when its own claim vanished before it was read back', () => {
    const nowMs = Date.parse('2026-06-15T12:00:05.000Z');
    const ts = '2026-06-15T12:00:00.000Z';
    const dir = join(storagePath, 'billed-turns');
    const [seed, id] = idsInOneShard('msg_', 2);
    expect(
      deliver(
        makeLedger(() => nowMs),
        FORK,
        [turn(seed, ts)],
      ),
    ).toEqual([turn(seed, ts)]);
    const [file] = readdirSync(dir);
    rmSync(join(dir, file));
    symlinkSync('/dev/null', join(dir, file));

    const ledger = makeLedger(() => nowMs);
    expect(deliver(ledger, PARENT, [turn(id, ts)])).toEqual([]);
    rmSync(join(dir, file));
    expect(deliver(ledger, PARENT, [turn(id, ts)])).toEqual([turn(id, ts)]);
    expect(deliver(ledger, PARENT, [turn(id, ts)])).toEqual([]);
  });

  it('owes a message whose claim vanished to whichever session next wins it', () => {
    const ts = '2026-06-15T12:00:00.000Z';
    const dir = join(storagePath, 'billed-turns');
    const [seed, id] = idsInOneShard('msg_', 2).map((m) => turn(m, ts));
    expect(
      deliver(
        makeLedger(() => CLAIMED_AT),
        FORK,
        [seed],
      ),
    ).toEqual([seed]);
    const file = join(dir, claimFileOf(id.messageId, CLAIMED_AT));
    rmSync(file);
    symlinkSync('/dev/null', file);

    const ledger = makeLedger(() => CLAIMED_AT);
    expect(deliver(ledger, PARENT, [id])).toEqual([]);
    rmSync(file);
    expect(deliver(ledger, FORK, [id])).toEqual([id]);
    expect(deliver(ledger, PARENT, [id])).toEqual([]);
  });
});
