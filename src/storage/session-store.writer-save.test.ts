import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

jest.mock('node:fs', () => {
  const real = jest.requireActual<typeof import('node:fs')>('node:fs');
  return {
    ...real,
    linkSync: jest.fn(real.linkSync),
    readFileSync: jest.fn(real.readFileSync),
    renameSync: jest.fn(real.renameSync),
    rmSync: jest.fn(real.rmSync),
    writeFileSync: jest.fn(real.writeFileSync),
  };
});

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore, deserializeFullSessionSummary } from './session-store.js';
import type { FullSessionSummary } from './session-store.js';
import { WRITERS_DIR, type WriterContribution } from './session-writers.js';

const SID = 'shared-1';
const START = Date.parse('2026-03-01T10:00:00Z');
const DAY = '2026-03-01';

const real = jest.requireActual<typeof import('node:fs')>('node:fs');
const { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } =
  real;
const mocked = {
  linkSync: jest.mocked(fs.linkSync),
  readFileSync: fs.readFileSync as unknown as jest.Mock<(...args: unknown[]) => unknown>,
  renameSync: jest.mocked(fs.renameSync),
  rmSync: jest.mocked(fs.rmSync),
  writeFileSync: jest.mocked(fs.writeFileSync),
};

let storagePath: string;
let sessionsDir: string;
let store: SessionStore;

beforeEach(() => {
  storagePath = mkdtempSync(join(tmpdir(), 'writer-save-'));
  sessionsDir = join(storagePath, 'sessions');
  store = new SessionStore({ storagePath });
  mocked.linkSync.mockImplementation(real.linkSync);
  mocked.readFileSync.mockImplementation(real.readFileSync as (...args: unknown[]) => unknown);
  mocked.renameSync.mockImplementation(real.renameSync);
  mocked.rmSync.mockImplementation(real.rmSync);
  mocked.writeFileSync.mockImplementation(real.writeFileSync);
});

afterEach(() => {
  rmSync(storagePath, { recursive: true, force: true });
});

function activity(
  ids: readonly string[],
  opts: { start?: number; usd?: number; sessionId?: string } = {},
): FullSessionSummary {
  const start = opts.start ?? START;
  const usd = opts.usd ?? 0.1 * ids.length;
  return deserializeFullSessionSummary({
    sessionId: opts.sessionId ?? SID,
    startTime: start,
    endTime: start + 1000 + ids.length,
    toolCallCount: ids.length,
    toolBreakdown: { Read: ids.length },
    timeline: ids.map((toolUseId, i) => ({
      toolUseId,
      toolName: 'Read',
      timestamp: start + i,
      durationMs: 1,
      success: true,
    })),
    estimatedCostUsd: usd,
    costByDayUsd: { [new Date(start).toISOString().slice(0, 10)]: usd },
    tokensInput: 10 * ids.length,
  } as unknown as Parameters<typeof deserializeFullSessionSummary>[0]);
}

const own = (summary: FullSessionSummary, retracted = false): WriterContribution => ({
  summary,
  retracted,
});

const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

const totals = (s: FullSessionSummary | null | undefined) =>
  s && {
    calls: s.toolCallCount,
    usd: Number(s.estimatedCostUsd?.toFixed(6)),
    input: s.tokensInput,
  };

function writeIndex(s: FullSessionSummary, date = DAY): void {
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(sessionsDir, `${date}_${s.sessionId}.json`), JSON.stringify(s, null, 2));
}

const topLevel = () => readdirSync(sessionsDir).sort();
const writerFiles = (sid = SID) => readdirSync(join(sessionsDir, WRITERS_DIR, sid)).sort();
const readJson = (path: string) =>
  JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;

describe('SessionStore.writer', () => {
  it('keeps both shares when two writers save on top of a session they both read', () => {
    store.saveSession(activity(ids('p', 10), { usd: 1 }));
    const a = store.writer('engine');
    const b = new SessionStore({ storagePath }).writer('aggregator');
    store.loadSession(SID);
    store.loadSession(SID);

    const saved = { kind: 'saved', retracted: false };
    expect(a.save(own(activity(ids('a', 5), { usd: 0.5 })))).toEqual(saved);
    expect(b.save(own(activity(ids('b', 5), { usd: 0.5 })))).toEqual(saved);

    const loaded = new SessionStore({ storagePath }).loadSession(SID);
    expect(totals(loaded)).toEqual({ calls: 20, usd: 2, input: 200 });
    expect(writerFiles()).toEqual([
      `${b.id}.json`,
      `${a.id}.json`,
      expect.stringMatching(/^legacy\.[0-9a-f]{16}\.json$/),
    ]);
    const index = readJson(join(sessionsDir, `${DAY}_${SID}.json`));
    expect(index.contributions).toEqual({ version: 1, writers: 2 });
    expect([index.toolCallCount, index.estimatedCostUsd, index.tokensInput]).toEqual([20, 2, 200]);
  });

  it('names each writer by producer, process and a fresh suffix', () => {
    const a = store.writer('homelab');
    const b = store.writer('homelab');

    expect(a.id).toMatch(new RegExp(`^homelab\\.${process.pid}\\.[0-9a-z]+\\.[0-9a-f]{8}$`));
    expect(b.id).not.toBe(a.id);
  });

  it('replaces its own share on each save instead of adding to it', () => {
    const a = store.writer('engine');
    a.save(own(activity(ids('a', 2))));
    a.save(own(activity(ids('a', 5))));

    expect(totals(store.loadSession(SID))).toEqual({ calls: 5, usd: 0.5, input: 50 });
    expect(writerFiles()).toEqual([`${a.id}.json`]);
    expect(readJson(join(sessionsDir, WRITERS_DIR, SID, `${a.id}.json`))).toEqual({
      version: 1,
      retracted: false,
      summary: JSON.parse(JSON.stringify(activity(ids('a', 5)))),
    });
  });

  it('starts a new session with a projection and no capture', () => {
    store.writer('engine').save(own(activity(ids('a', 3))));

    expect(topLevel()).toEqual([WRITERS_DIR, `${DAY}_${SID}.json`]);
    expect(writerFiles().filter((f) => f.startsWith('legacy.'))).toEqual([]);
    expect(store.loadAllSessions().map(totals)).toEqual([{ calls: 3, usd: 0.3, input: 30 }]);
  });

  it('captures an older build rewrite once more, and counts it once', () => {
    writeIndex(activity(ids('p', 4)));
    const a = store.writer('engine');
    a.save(own(activity(ids('a', 2))));
    writeIndex(activity([...ids('p', 4), ...ids('a', 2), 'old0']));

    store.writer('aggregator').save(own(activity(ids('b', 3))));

    expect(writerFiles().filter((f) => f.startsWith('legacy.'))).toHaveLength(2);
    expect(totals(store.loadSession(SID))).toEqual({ calls: 10, usd: 1, input: 100 });
  });

  it('folds a session split across dates into one index at its earliest date', () => {
    writeIndex(activity(ids('p', 2)));
    writeIndex(activity(ids('q', 3), { start: START + 86_400_000 }), '2026-03-02');
    const capture = (date: string) => {
      const bytes = readFileSync(join(sessionsDir, `${date}_${SID}.json`));
      return `legacy.${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}.json`;
    };
    const captures = [capture(DAY), capture('2026-03-02')].sort();

    store.writer('engine').save(own(activity(ids('a', 1), { start: START + 2 * 86_400_000 })));

    expect(writerFiles().filter((f) => f.startsWith('legacy.'))).toEqual(captures);

    expect(topLevel().filter((f) => f.endsWith('.json'))).toEqual([`${DAY}_${SID}.json`]);
    expect(topLevel().filter((f) => f.endsWith('.merged'))).toHaveLength(1);
    expect(totals(store.loadSession(SID))).toEqual({ calls: 6, usd: 0.6, input: 60 });
  });

  it('moves the index to the earlier start a share brings', () => {
    writeIndex(activity(ids('p', 2), { start: START + 86_400_000 }), '2026-03-02');

    store.writer('engine').save(own(activity(ids('a', 1))));

    expect(topLevel().filter((f) => f.endsWith('.json'))).toEqual([`${DAY}_${SID}.json`]);
  });

  it('skips an unusable session id and a share with nothing in it', () => {
    const save = (s: FullSessionSummary) => store.writer('engine').save(own(s));
    const skip = (reason: string) => ({ kind: 'skipped', reason });

    expect(save(activity(ids('a', 1), { sessionId: '../x' }))).toEqual(skip('invalid-session-id'));
    expect(save(activity(ids('a', 1), { sessionId: 'unknown' }))).toEqual(
      skip('invalid-session-id'),
    );
    expect(save(activity([], { usd: 0 }))).toEqual(skip('no-recorded-usage'));
    expect(existsSync(sessionsDir)).toBe(false);
  });

  it('tells every writer the session is retracted once one writer retracts it', () => {
    const a = store.writer('aggregator');
    const b = store.writer('engine');

    expect(a.save(own(activity(ids('a', 1))))).toMatchObject({ retracted: false });
    expect(b.save(own(activity(ids('b', 1)), true))).toMatchObject({ retracted: true });
    expect(a.save(own(activity(ids('a', 2))))).toMatchObject({ retracted: true });
  });

  it('tells a writer the session is retracted when an older build retracted it', () => {
    const zero = { costUsd: 0, inputTokens: 0, outputTokens: 0, costByModel: {}, costByDayUsd: {} };
    writeIndex({ ...activity(ids('p', 2)), byteEstimates: zero });

    expect(store.writer('engine').save(own(activity(ids('a', 1))))).toMatchObject({
      retracted: true,
    });
  });
});

describe('SessionWriter.retire', () => {
  it('removes only its own share and rewrites the index from the rest', () => {
    const a = store.writer('engine');
    const b = store.writer('aggregator');
    a.save(own(activity(ids('a', 2))));
    b.save(own(activity(ids('b', 3))));

    a.retire(SID);

    expect(writerFiles()).toEqual([`${b.id}.json`]);
    expect(totals(store.loadSession(SID))).toEqual({ calls: 3, usd: 0.3, input: 30 });
    const index = readJson(join(sessionsDir, `${DAY}_${SID}.json`));
    expect([index.toolCallCount, index.contributions]).toEqual([3, { version: 1, writers: 1 }]);
  });

  it('removes the session when its share was the only one', () => {
    const a = store.writer('engine');
    a.save(own(activity(ids('a', 2))));
    writeFileSync(join(sessionsDir, `2026-03-05_${SID}.json`), '{"sessionId": "shar');

    a.retire(SID);

    expect(store.loadSession(SID)).toBeNull();
    expect(store.listSessions().map((s) => s.date)).toEqual(['2026-03-05']);
    expect(topLevel()).toEqual([WRITERS_DIR, `2026-03-05_${SID}.json`]);
  });

  it('keeps a captured pre-upgrade index when its share goes', () => {
    writeIndex(activity(ids('p', 4)));
    const a = store.writer('engine');
    a.save(own(activity(ids('a', 2))));

    a.retire(SID);

    expect(totals(store.loadSession(SID))).toEqual({ calls: 4, usd: 0.4, input: 40 });
    expect(readJson(join(sessionsDir, `${DAY}_${SID}.json`)).toolCallCount).toBe(4);
  });

  it('drops its share from an older build file that copied it', () => {
    writeIndex(activity(ids('p', 4)));
    const a = store.writer('engine');
    a.save(own(activity(ids('a', 2))));
    writeIndex(activity([...ids('p', 4), ...ids('a', 2), 'old0']));

    a.retire(SID);

    expect(totals(store.loadSession(SID))).toEqual({ calls: 5, usd: 0.5, input: 50 });
    expect(readJson(indexPath()).toolCallCount).toBe(5);
  });

  it('touches nothing in a session it never saved', () => {
    writeIndex(activity(ids('p', 4)));
    const before = readFileSync(join(sessionsDir, `${DAY}_${SID}.json`));

    const a = store.writer('engine');
    a.retire(SID);

    expect(topLevel()).toEqual([`${DAY}_${SID}.json`]);
    expect(readFileSync(join(sessionsDir, `${DAY}_${SID}.json`)).equals(before)).toBe(true);
    a.save(own(activity(ids('a', 2))));
    a.retire(`x/../${SID}`);
    expect(writerFiles()).toContain(`${a.id}.json`);
  });
});

describe('a since load of a session with writer files', () => {
  it('folds every index file once any of them is in the window', () => {
    writeIndex(activity(ids('p', 4)));
    writeIndex(activity(ids('q', 3), { start: START + 86_400_000 }), '2026-03-02');
    mkdirSync(join(sessionsDir, WRITERS_DIR, SID), { recursive: true });
    writeFileSync(
      join(sessionsDir, WRITERS_DIR, SID, 'engine.1.a.b.json'),
      JSON.stringify({ version: 1, retracted: false, summary: activity(['p0', 'p1']) }),
    );
    const whole = totals(store.loadSession(SID));

    expect(whole).toEqual({ calls: 7, usd: 0.7, input: 70 });
    expect(store.loadAllSessions({ since: new Date('2026-03-02T00:00:00Z') }).map(totals)).toEqual([
      whole,
    ]);
  });

  it('rereads an older file that moved out of the window during the load', () => {
    store.writer('engine').save(own(activity(ids('a', 2))));
    writeIndex(activity([...ids('a', 2), 'old0']));
    writeIndex(activity(ids('q', 3), { start: START + 86_400_000 }), '2026-03-02');
    mocked.readFileSync.mockImplementationOnce(() => {
      real.renameSync(indexPath(), join(sessionsDir, `2026-02-28_${SID}.json`));
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const since = { since: new Date('2026-03-02T00:00:00Z') };
    expect(store.loadAllSessions(since).map(totals)).toEqual([{ calls: 6, usd: 0.6, input: 60 }]);
  });

  it('picks a resumed session by its projection, which every save rewrites', () => {
    writeIndex(activity(ids('p', 4)));
    store.writer('engine').save(own(activity(ids('a', 2), { start: START + 5 * 86_400_000 })));
    const recent = { since: new Date('2026-04-01T00:00:00Z') };

    expect(store.loadAllSessions(recent)).toEqual([]);
    expect(
      store
        .loadAllSessions({ ...recent, includeModifiedSince: new Date(Date.now() - 60_000) })
        .map(totals),
    ).toEqual([{ calls: 6, usd: 0.6, input: 60 }]);
  });
});

const calls = () => new SessionStore({ storagePath }).loadSession(SID)?.toolCallCount ?? null;
const indexPath = () => join(sessionsDir, `${DAY}_${SID}.json`);
const isIndex = (path: unknown) => String(path) === indexPath();

function crash(): never {
  throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
}

function tearNextWrite(): void {
  mocked.writeFileSync.mockImplementationOnce((path, data, options) => {
    writeFileSync(path, String(data).slice(0, 40), options);
    crash();
  });
}

const crashIndexRename = () =>
  mocked.renameSync.mockImplementation((from, to) =>
    isIndex(to) ? crash() : real.renameSync(from, to),
  );

describe('writer saves under filesystem faults', () => {
  it('keeps the last whole share when a save dies writing its own file', () => {
    const a = store.writer('engine');
    a.save(own(activity(ids('a', 2))));
    tearNextWrite();

    expect(a.save(own(activity(ids('a', 5))))).toMatchObject({ kind: 'failed' });
    expect(calls()).toBe(2);
    expect(writerFiles()).toEqual([`${a.id}.json`]);
  });

  it('counts the pre-upgrade index whole when a save dies writing its capture', () => {
    writeIndex(activity(ids('p', 4)));
    const a = store.writer('engine');
    tearNextWrite();

    expect(a.save(own(activity(ids('a', 2))))).toMatchObject({ kind: 'failed' });
    expect(writerFiles()).toEqual([]);
    expect(calls()).toBe(4);
    expect(a.save(own(activity(ids('a', 2))))).toMatchObject({ kind: 'saved' });
    expect(calls()).toBe(6);
  });

  it('loads every share when a save dies between its own file and the index', () => {
    writeIndex(activity(ids('p', 4)));
    crashIndexRename();

    expect(store.writer('engine').save(own(activity(ids('a', 2))))).toMatchObject({
      kind: 'failed',
    });
    const stale = readJson(indexPath());
    expect([stale.toolCallCount, stale.contributions]).toEqual([4, undefined]);
    expect(calls()).toBe(6);

    mocked.renameSync.mockImplementation(real.renameSync);
    store.writer('aggregator').save(own(activity(ids('b', 3))));
    expect(calls()).toBe(9);
    expect(readJson(indexPath())).toMatchObject({
      toolCallCount: 9,
      contributions: { writers: 2 },
    });
  });

  it('lists a new session from its next save when the first one dies before the index', () => {
    const a = store.writer('engine');
    crashIndexRename();

    expect(a.save(own(activity(ids('a', 2))))).toMatchObject({ kind: 'failed' });
    expect(calls()).toBeNull();
    mocked.renameSync.mockImplementation(real.renameSync);
    a.save(own(activity(ids('a', 3))));
    expect(calls()).toBe(3);
  });

  it('makes one capture when two writers capture the same index at once', () => {
    writeIndex(activity(ids('p', 4)));
    const b = new SessionStore({ storagePath }).writer('aggregator');
    mocked.linkSync.mockImplementationOnce((from, to) => {
      b.save(own(activity(ids('b', 3))));
      real.linkSync(from, to);
    });

    expect(store.writer('engine').save(own(activity(ids('a', 2))))).toMatchObject({
      kind: 'saved',
    });
    expect(writerFiles().filter((f) => f.startsWith('legacy.'))).toHaveLength(1);
    expect(calls()).toBe(9);
  });
});

describe('the order a save reads and writes in', () => {
  it('reads the index before the writer files, so an older rewrite in between counts once', () => {
    writeIndex(activity(ids('p', 4)));
    const a = store.writer('engine');
    a.save(own(activity(ids('a', 2))));
    mocked.readFileSync.mockImplementation((path, options) => {
      if (isIndex(path)) {
        mocked.readFileSync.mockImplementation(
          real.readFileSync as (...args: unknown[]) => unknown,
        );
        a.save(own(activity(ids('a', 3))));
        writeIndex(activity([...ids('p', 4), ...ids('a', 3), 'old0']));
      }
      return real.readFileSync(path as string, options as BufferEncoding);
    });

    store.writer('aggregator').save(own(activity(ids('b', 3))));

    expect(totals(store.loadSession(SID))).toEqual({ calls: 11, usd: 1.1, input: 110 });
  });

  it('captures the index before its own file, so a save in between cannot shrink the capture', () => {
    writeIndex(activity(ids('p', 4)));
    const a = store.writer('engine');
    mocked.renameSync.mockImplementation((from, to) => {
      real.renameSync(from, to);
      if (!String(to).endsWith(`${a.id}.json`)) return;
      mocked.renameSync.mockImplementation(real.renameSync);
      new SessionStore({ storagePath }).writer('aggregator').save(own(activity(ids('b', 3))));
    });

    a.save(own(activity(ids('a', 2))));

    expect(calls()).toBe(9);
  });
});

describe('retire racing a save', () => {
  it('lists a writer whose first save lands while retire removes the index', () => {
    const a = store.writer('engine');
    a.save(own(activity(ids('a', 2))));
    mocked.rmSync.mockImplementation((path, options) => {
      if (isIndex(path)) {
        mocked.rmSync.mockImplementation(real.rmSync);
        new SessionStore({ storagePath }).writer('aggregator').save(own(activity(ids('b', 3))));
      }
      real.rmSync(path, options);
    });

    a.retire(SID);

    expect(calls()).toBe(3);
    expect(readJson(indexPath())).toMatchObject({
      toolCallCount: 3,
      contributions: { writers: 1 },
    });
  });

  it('drops the retired share from every load though a racing save still projects it', () => {
    const a = store.writer('engine');
    const b = new SessionStore({ storagePath }).writer('aggregator');
    a.save(own(activity(ids('a', 2))));
    mocked.renameSync.mockImplementation((from, to) => {
      if (isIndex(to)) {
        mocked.renameSync.mockImplementation(real.renameSync);
        a.retire(SID);
      }
      real.renameSync(from, to);
    });

    b.save(own(activity(ids('b', 3))));

    expect(writerFiles()).toEqual([`${b.id}.json`]);
    expect(calls()).toBe(3);
    expect(readJson(indexPath()).toolCallCount).toBe(5);
    b.save(own(activity(ids('b', 3))));
    expect(readJson(indexPath()).toolCallCount).toBe(3);
  });
});
