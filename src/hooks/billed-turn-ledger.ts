/**
 * Append order in an O_APPEND file is the cross-process arbiter, so two
 * racing claimants both read back the same winner without a lock. Each
 * ledger instance claims under its own random claimant id, so two processes
 * tailing the same session still resolve to one winner.
 */

import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';

import { createLogger } from '../shared/index.js';

const logger = createLogger('billed-turn-ledger');

type DayKey = string & { readonly __brand: 'DayKey' };
type LedgerFile = DayKey | typeof UNDATED_FILE;

export interface BillableTurn {
  readonly messageId: string;
  readonly timestampMs: number;
  /** The source line had no timestamp, so the ledger files the turn by when it was read. */
  readonly undated?: boolean;
}

interface Placement {
  readonly home: LedgerFile;
  readonly files: readonly LedgerFile[];
}

export interface BilledTurnLedgerOptions {
  readonly storagePath: string;
  readonly retainDays?: number | null;
  readonly now?: () => number;
}

interface FileIndex {
  ino: number | undefined;
  offset: number;
  partial: string;
  readonly claimants: Map<string, string>;
}

const LEDGER_DIR = 'billed-turns';
const MAX_CACHED_FILES = 8;
const DAY_MS = 24 * 60 * 60 * 1000;
const TORN_LINE_TERMINATOR = '\n';
// Never pruned, so an undated turn keeps one key however late it is re-read.
const UNDATED_FILE = 'undated';

export class BilledTurnLedger {
  private readonly dir: string;
  private readonly retainDays: number | null;
  private readonly now: () => number;
  private readonly claimant = randomUUID();
  private readonly files = new Map<LedgerFile, FileIndex>();
  // Turns this instance claimed but has not delivered, keyed by session and
  // message id: a claim that threw after some of its lines landed, or a turn
  // whose append threw. The ledger already holds them, so only this set lets
  // them out, and only to the session they were claimed for.
  private readonly undelivered = new Set<string>();

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
    const owed = this.claim(sessionId, turns);
    for (const [i, turn] of owed.entries()) {
      try {
        append(turn);
      } catch (err) {
        for (const unappended of owed.slice(i)) {
          this.undelivered.add(undeliveredKey(sessionId, unappended.messageId));
        }
        throw err;
      }
    }
  }

  private claim<T extends BillableTurn>(sessionId: string, turns: readonly T[]): T[] {
    this.trimCache();
    const nowMs = this.now();
    const live: Array<{ turn: T; place: Placement }> = [];
    let refused = 0;
    for (const turn of turns) {
      const place = placementOf(turn, nowMs);
      if (!turn.undated && dayIsBeyondHorizon(dayKeyOf(turn.timestampMs), nowMs, this.retainDays)) {
        refused++;
        continue;
      }
      live.push({ turn, place });
    }
    if (refused > 0) {
      logger.info('Refused turns older than the retention horizon', {
        refused,
        retainDays: this.retainDays,
      });
    }
    this.syncFiles(live.flatMap(({ place }) => place.files));

    const owed = new Map<string, { turn: T; place: Placement }>();
    const linesByFile = new Map<LedgerFile, string>();
    for (const entry of live) {
      const id = entry.turn.messageId;
      if (owed.has(id)) continue;
      const key = undeliveredKey(sessionId, id);
      const claimant = this.claimantOf(id, entry.place.files);
      if (claimant === undefined) {
        const line =
          TORN_LINE_TERMINATOR + JSON.stringify({ m: id, s: sessionId, c: this.claimant });
        linesByFile.set(entry.place.home, (linesByFile.get(entry.place.home) ?? '') + line);
      } else if (claimant !== this.claimant || !this.undelivered.has(key)) {
        this.undelivered.delete(key);
        continue;
      }
      owed.set(id, entry);
      this.undelivered.add(key);
    }
    if (owed.size === 0) return [];

    if (linesByFile.size > 0) mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    for (const [file, lines] of linesByFile) {
      appendFileSync(this.filePath(file), lines + '\n', { mode: 0o600 });
    }

    this.syncFiles([...owed.values()].flatMap(({ place }) => place.files));
    const out: T[] = [];
    for (const { turn, place } of owed.values()) {
      this.undelivered.delete(undeliveredKey(sessionId, turn.messageId));
      if (this.claimantOf(turn.messageId, place.files) === this.claimant) out.push(turn);
    }
    return out;
  }

  private claimantOf(messageId: string, files: readonly LedgerFile[]): string | undefined {
    for (const file of files) {
      const claimant = this.files.get(file)?.claimants.get(messageId);
      if (claimant !== undefined) return claimant;
    }
    return undefined;
  }

  private trimCache(): void {
    for (const file of this.files.keys()) {
      if (this.files.size <= MAX_CACHED_FILES) return;
      this.files.delete(file);
    }
  }

  private syncFiles(files: readonly LedgerFile[]): void {
    for (const file of new Set(files)) {
      const index = this.files.get(file) ?? {
        ino: undefined,
        offset: 0,
        partial: '',
        claimants: new Map(),
      };
      this.files.delete(file);
      this.files.set(file, index);

      let size = 0;
      let ino: number | undefined;
      try {
        ({ size, ino } = statSync(this.filePath(file)));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      if (ino !== index.ino || size < index.offset) {
        index.ino = ino;
        index.offset = 0;
        index.partial = '';
        index.claimants.clear();
      }
      if (size === index.offset) continue;

      const text = index.partial + readRange(this.filePath(file), index.offset, size);
      const lastNewline = text.lastIndexOf('\n');
      foldLines(text.slice(0, lastNewline + 1), index.claimants, file);
      index.partial = text.slice(lastNewline + 1);
      index.offset = size;
    }
  }

  private filePath(file: LedgerFile): string {
    return join(this.dir, `${file}.jsonl`);
  }
}

export function pruneBilledTurns(storagePath: string, retainDays: number, nowMs: number): number {
  const dir = join(storagePath, LEDGER_DIR);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let deleted = 0;
  for (const name of names) {
    const match = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
    if (!match || !dayIsBeyondHorizon(match[1] as DayKey, nowMs, retainDays)) continue;
    try {
      unlinkSync(join(dir, name));
      deleted++;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('Failed to prune billed-turn day file', { file: name, error: String(err) });
      }
    }
  }
  return deleted;
}

function dayKeyOf(timestampMs: number): DayKey {
  return new Date(timestampMs).toISOString().slice(0, 10) as DayKey;
}

function undeliveredKey(sessionId: string, messageId: string): string {
  return `${sessionId}\n${messageId}`;
}

/**
 * A dated turn is claimed in its own day, an undated one in the undated file.
 * Every turn is looked up in the undated file and the days either side of its
 * own, so a message resolves to one claim when its lines straddle UTC midnight
 * or only some of them carry a timestamp. An undated turn's day is the read
 * time: a dated line of the same message was written moments before it.
 */
function placementOf(turn: BillableTurn, nowMs: number): Placement {
  const day = dayKeyOf(turn.undated ? nowMs : turn.timestampMs);
  const startMs = Date.parse(`${day}T00:00:00.000Z`);
  const days = [dayKeyOf(startMs - DAY_MS), day, dayKeyOf(startMs + DAY_MS)];
  return { home: turn.undated ? UNDATED_FILE : day, files: [...days, UNDATED_FILE] };
}

function dayIsBeyondHorizon(day: DayKey, nowMs: number, retainDays: number | null): boolean {
  if (retainDays === null || retainDays <= 0) return false;
  return Date.parse(`${day}T00:00:00.000Z`) + DAY_MS <= nowMs - retainDays * DAY_MS;
}

function readRange(path: string, start: number, end: number): string {
  const buf = Buffer.allocUnsafe(end - start);
  const fd = openSync(path, 'r');
  try {
    let read = 0;
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    return buf.toString('utf-8', 0, read);
  } finally {
    closeSync(fd);
  }
}

function foldLines(text: string, claimants: Map<string, string>, file: LedgerFile): void {
  for (const line of text.split('\n')) {
    if (!line) continue;
    let parsed: { m?: unknown; c?: unknown };
    try {
      parsed = JSON.parse(line) as { m?: unknown; c?: unknown };
    } catch {
      logger.debug('Skipped a torn billed-turn ledger line', { file, bytes: line.length });
      continue;
    }
    if (typeof parsed.m !== 'string') continue;
    if (!claimants.has(parsed.m))
      claimants.set(parsed.m, typeof parsed.c === 'string' ? parsed.c : '');
  }
}
