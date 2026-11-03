/**
 * Append order in an O_APPEND file is the cross-process arbiter, so two
 * racing claimants both read back the same winner without a lock. A message
 * id maps to one file per generation, chosen by a hash of the id and the
 * claim's wall clock rather than the turn's timestamp, so every line of a
 * message is arbitrated in the same file. Each ledger instance claims under
 * its own random claimant id, so two processes tailing the same session
 * still resolve to one winner.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';

import { createLogger } from '../shared/index.js';

const logger = createLogger('billed-turn-ledger');

export interface BillableTurn {
  readonly messageId: string;
  readonly timestampMs: number;
  /** The source line had no timestamp, so the retention horizon cannot judge the turn. */
  readonly undated?: boolean;
}

export interface BilledTurnLedgerOptions {
  readonly storagePath: string;
  readonly retainDays?: number | null;
  readonly now?: () => number;
}

interface FileIndex {
  // The file's leading bytes when it was first read. A file deleted and
  // recreated starts with a different claim, while its inode can be reused
  // (ext4 hands a freed inode straight back), so content is the identity.
  head: Buffer;
  offset: number;
  partial: Buffer;
  readonly claimants: Map<string, string>;
}

const LEDGER_DIR = 'billed-turns';
const DAY_MS = 24 * 60 * 60 * 1000;
const GENERATION_MS = 7 * DAY_MS;
const LEDGER_FILE = /^g(\d+)-([0-9a-f])\.jsonl$/;
const TORN_LINE_TERMINATOR = '\n';
const HEAD_BYTES = 256;
const NEWLINE = 0x0a;

export class BilledTurnLedger {
  private readonly dir: string;
  private readonly retainDays: number | null;
  private readonly now: () => number;
  private readonly claimant = randomUUID();
  private readonly files = new Map<string, FileIndex>();
  // The session each message this instance won is still owed to: a claim
  // that threw after some of its lines landed, a turn whose append threw, or
  // one whose claim line vanished before it was read back. Only this map lets
  // the ledger's own claims out, and only to the session they were won for.
  private readonly undelivered = new Map<string, string>();

  constructor(options: BilledTurnLedgerOptions) {
    this.dir = join(options.storagePath, LEDGER_DIR);
    this.retainDays = options.retainDays ?? null;
    this.now = options.now ?? Date.now;
  }

  /**
   * Appends, in order, the turns this session owes: the first line of each
   * message this instance claimed first and has not delivered yet. A turn
   * claimed first by any other instance, of any session, is already billed.
   * When `append` throws, that turn and the rest stay owed to this session,
   * so the next deliver() redoing the read appends them, and the error is
   * rethrown.
   */
  deliver<T extends BillableTurn>(
    sessionId: string,
    turns: readonly T[],
    append: (turn: T) => void,
  ): void {
    for (const turn of this.claim(sessionId, turns)) {
      append(turn);
      this.undelivered.delete(turn.messageId);
    }
  }

  private claim<T extends BillableTurn>(sessionId: string, turns: readonly T[]): T[] {
    const nowMs = this.now();
    const horizon = horizonOf(nowMs, this.retainDays);
    const firstLines = new Map<string, T | null>();
    let refused = 0;
    for (const turn of turns) {
      if (firstLines.has(turn.messageId)) continue;
      const beyond =
        !turn.undated && Number.isFinite(turn.timestampMs) && turn.timestampMs < horizon;
      if (beyond) refused++;
      firstLines.set(turn.messageId, beyond ? null : turn);
    }
    if (refused > 0) {
      logger.debug('Refused turns older than the retention horizon', {
        refused,
        retainDays: this.retainDays,
      });
    }
    const live = [...firstLines.values()].filter((turn): turn is T => turn !== null);
    if (live.length === 0) return [];

    // Two processes either side of a generation boundary can both win a
    // brand-new message claimed within the same few milliseconds.
    const home = Math.floor(nowMs / GENERATION_MS);
    const generations = this.listGenerations();
    const filesOf = (messageId: string): string[] => {
      const shard = shardOf(messageId);
      const gens = new Set([...(generations.get(shard) ?? []), home]);
      return [...gens].sort((a, b) => a - b).map((gen) => fileName(gen, shard));
    };
    this.syncFiles(live.flatMap((turn) => filesOf(turn.messageId)));

    const owed: T[] = [];
    const linesByFile = new Map<string, string>();
    for (const turn of live) {
      const id = turn.messageId;
      const claimant = this.claimantOf(id, filesOf(id));
      if (claimant === undefined) {
        const file = fileName(home, shardOf(id));
        const line =
          TORN_LINE_TERMINATOR +
          JSON.stringify({ m: id, s: sessionId, c: this.claimant, t: nowMs });
        linesByFile.set(file, (linesByFile.get(file) ?? '') + line);
        this.undelivered.set(id, sessionId);
      } else if (claimant !== this.claimant) {
        this.undelivered.delete(id);
        continue;
      } else if (this.undelivered.get(id) !== sessionId) {
        continue;
      }
      owed.push(turn);
    }
    if (owed.length === 0) return [];

    if (linesByFile.size > 0) mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    for (const [file, lines] of linesByFile) {
      appendFileSync(join(this.dir, file), lines + '\n', { mode: 0o600 });
    }

    this.syncFiles(owed.flatMap((turn) => filesOf(turn.messageId)));
    return owed.filter((turn) => {
      const claimant = this.claimantOf(turn.messageId, filesOf(turn.messageId));
      if (claimant !== undefined && claimant !== this.claimant) {
        this.undelivered.delete(turn.messageId);
      }
      return claimant === this.claimant;
    });
  }

  private claimantOf(messageId: string, files: readonly string[]): string | undefined {
    for (const file of files) {
      const claimant = this.files.get(file)?.claimants.get(messageId);
      if (claimant !== undefined) return claimant;
    }
    return undefined;
  }

  /** Generations on disk per shard. Drops the index of any file no longer listed. */
  private listGenerations(): Map<string, number[]> {
    const listed = new Set<string>();
    const generations = new Map<string, number[]>();
    for (const name of readLedgerDir(this.dir)) {
      const parsed = parseFileName(name);
      if (parsed === null) continue;
      listed.add(name);
      generations.set(parsed.shard, [...(generations.get(parsed.shard) ?? []), parsed.generation]);
    }
    for (const name of this.files.keys()) {
      if (!listed.has(name)) this.files.delete(name);
    }
    return generations;
  }

  private syncFiles(files: readonly string[]): void {
    for (const file of new Set(files)) {
      let fd: number;
      try {
        fd = openSync(join(this.dir, file), 'r');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        this.files.delete(file);
        continue;
      }
      try {
        this.syncFile(file, fd);
      } finally {
        closeSync(fd);
      }
    }
  }

  private syncFile(file: string, fd: number): void {
    const { size } = fstatSync(fd);
    const head = readAt(fd, 0, Math.min(size, HEAD_BYTES));
    let index = this.files.get(file);
    if (index === undefined || size < index.offset || !onePrefixesOther(head, index.head)) {
      index = { head, offset: 0, partial: Buffer.alloc(0), claimants: new Map() };
      this.files.set(file, index);
    } else if (head.length > index.head.length) {
      index.head = head;
    }
    if (size <= index.offset) return;

    const tail = readAt(fd, index.offset, size);
    const bytes = Buffer.concat([index.partial, tail]);
    const end = bytes.lastIndexOf(NEWLINE) + 1;
    foldLines(bytes.subarray(0, end), index.claimants, file);
    index.partial = Buffer.from(bytes.subarray(end));
    index.offset += tail.length;
  }
}

export function pruneBilledTurns(storagePath: string, retainDays: number, nowMs: number): number {
  const dir = join(storagePath, LEDGER_DIR);
  const horizon = horizonOf(nowMs, retainDays);
  let deleted = 0;
  for (const name of readLedgerDir(dir)) {
    const parsed = parseFileName(name);
    if (parsed === null || (parsed.generation + 1) * GENERATION_MS > horizon) continue;
    try {
      unlinkSync(join(dir, name));
      deleted++;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('Failed to prune billed-turn ledger file', { file: name, error: String(err) });
      }
    }
  }
  return deleted;
}

/**
 * Turns dated before the horizon are refused and generations ending by it
 * are pruned. A turn is claimed no earlier than its own timestamp, so a
 * pruned generation only ever held claims for turns the horizon refuses.
 */
function horizonOf(nowMs: number, retainDays: number | null): number {
  if (retainDays === null || !(retainDays > 0)) return -Infinity;
  return nowMs - retainDays * DAY_MS;
}

function shardOf(messageId: string): string {
  return createHash('sha256').update(messageId).digest('hex')[0];
}

function fileName(generation: number, shard: string): string {
  return `g${generation}-${shard}.jsonl`;
}

function parseFileName(name: string): { generation: number; shard: string } | null {
  const match = LEDGER_FILE.exec(name);
  return match ? { generation: Number(match[1]), shard: match[2] } : null;
}

function readLedgerDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

function onePrefixesOther(a: Buffer, b: Buffer): boolean {
  const n = Math.min(a.length, b.length);
  return a.subarray(0, n).equals(b.subarray(0, n));
}

function readAt(fd: number, start: number, end: number): Buffer {
  const buf = Buffer.allocUnsafe(Math.max(0, end - start));
  let read = 0;
  while (read < buf.length) {
    const n = readSync(fd, buf, read, buf.length - read, start + read);
    if (n === 0) break;
    read += n;
  }
  return buf.subarray(0, read);
}

function foldLines(bytes: Buffer, claimants: Map<string, string>, file: string): void {
  let start = 0;
  while (start < bytes.length) {
    const end = bytes.indexOf(NEWLINE, start);
    const line = bytes.subarray(start, end);
    start = end + 1;
    if (line.length === 0) continue;
    let parsed: { m?: unknown; c?: unknown };
    try {
      parsed = JSON.parse(line.toString('utf-8')) as { m?: unknown; c?: unknown };
    } catch {
      logger.debug('Skipped a torn billed-turn ledger line', { file, bytes: line.length });
      continue;
    }
    if (typeof parsed.m !== 'string') continue;
    if (!claimants.has(parsed.m))
      claimants.set(parsed.m, typeof parsed.c === 'string' ? parsed.c : '');
  }
}
