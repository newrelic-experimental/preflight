import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore, deserializeFullSessionSummary } from './session-store.js';
import type { FullSessionSummary } from './session-store.js';
import { WRITERS_DIR } from './session-writers.js';

const SID = 'shared-1';
const START = Date.parse('2026-03-01T10:00:00Z');
const DAY = '2026-03-01';

let storagePath: string;
let store: SessionStore;

beforeEach(() => {
  storagePath = mkdtempSync(join(tmpdir(), 'writer-loaders-'));
  mkdirSync(join(storagePath, 'sessions'));
  store = new SessionStore({ storagePath });
});

afterEach(() => {
  rmSync(storagePath, { recursive: true, force: true });
});

function summary(fields: Record<string, unknown>): FullSessionSummary {
  return deserializeFullSessionSummary({
    sessionId: SID,
    startTime: START,
    endTime: START + 1000,
    ...fields,
  } as unknown as Parameters<typeof deserializeFullSessionSummary>[0]);
}

function activity(ids: readonly string[], endTime = START + 1000): FullSessionSummary {
  return summary({
    endTime,
    toolCallCount: ids.length,
    toolBreakdown: { Read: ids.length },
    timeline: ids.map((toolUseId, i) => ({
      toolUseId,
      toolName: 'Read',
      timestamp: START + i,
      durationMs: 1,
      success: true,
    })),
    estimatedCostUsd: 0.25 * ids.length,
    costByDayUsd: { [DAY]: 0.25 * ids.length },
    tokensInput: 100 * ids.length,
  });
}

function estimating(calls: readonly string[]): FullSessionSummary {
  const s = activity(calls, START + 2000);
  return {
    ...s,
    byteEstimates: {
      costUsd: s.estimatedCostUsd ?? 0,
      inputTokens: s.tokensInput,
      outputTokens: 0,
      costByModel: { m: s.estimatedCostUsd ?? 0 },
      costByDayUsd: { [DAY]: s.estimatedCostUsd ?? 0 },
    },
  };
}

const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

function writeIndex(s: FullSessionSummary, opts: { date?: string; marked?: boolean } = {}): void {
  const body = opts.marked ? { ...s, contributions: { version: 1, writers: 1 } } : s;
  writeFileSync(
    join(storagePath, 'sessions', `${opts.date ?? DAY}_${s.sessionId}.json`),
    JSON.stringify(body, null, 2) + '\n',
  );
}

function writeRaw(sessionId: string, name: string, body: string): void {
  const dir = join(storagePath, 'sessions', WRITERS_DIR, sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body);
}

function writeWriter(name: string, s: FullSessionSummary, retracted = false): void {
  writeRaw(s.sessionId, name, JSON.stringify({ version: 1, retracted, summary: s }));
}

const totals = (s: FullSessionSummary | null | undefined) => ({
  calls: s?.toolCallCount,
  usd: s?.estimatedCostUsd,
  input: s?.tokensInput,
});

describe('loading a session with no writer files', () => {
  const loads = () =>
    JSON.stringify({
      one: store.loadSession(SID),
      old: store.loadSession('old-format'),
      all: store.loadAllSessions(),
      window: store.loadAllSessions({ since: new Date('2026-03-02T00:00:00Z') }),
      dev: store.loadAllSessions({ developer: 'dev-a' }),
    });

  it('loads old-format, split, torn and set-aside files exactly as before', () => {
    writeIndex({ ...activity(ids('a', 2)), developer: 'dev-a' });
    writeIndex(activity(ids('b', 3), START + 90_000_000), { date: '2026-03-02' });
    writeFileSync(
      join(storagePath, 'sessions', '2026-02-27_old-format.json'),
      '{"sessionId":"old-format","startTime":1772186400000,"toolCallCount":4,"estimatedCostUsd":2}\n{"tail"',
    );
    writeFileSync(
      join(storagePath, 'sessions', `${DAY}_${SID}.json.1772359200000.merged`),
      JSON.stringify(activity(ids('m', 9))),
    );
    const before = loads();
    expect(totals(store.loadSession(SID))).toEqual({ calls: 5, usd: 1.25, input: 500 });
    expect(totals(store.loadSession('old-format'))).toEqual({ calls: 4, usd: 2, input: 0 });
    expect(store.loadAllSessions({ developer: 'dev-a' }).map(totals)).toEqual([
      { calls: 2, usd: 0.5, input: 200 },
    ]);
    expect(store.loadAllSessions({ since: new Date('2026-03-02T00:00:00Z') }).map(totals)).toEqual([
      { calls: 3, usd: 0.75, input: 300 },
    ]);

    mkdirSync(join(storagePath, 'sessions', WRITERS_DIR, SID), { recursive: true });
    expect(loads()).toBe(before);
    writeWriter('engine.1.a.b.json', { ...activity(ids('o', 5)), sessionId: 'other-session' });
    writeRaw(SID, '.engine.1.a.b.json.77.tmp', JSON.stringify({ version: 1 }));
    writeRaw(SID, 'engine.2.a.b.json', '{"version": 1, "retracted": fal');
    writeRaw(SID, 'engine.3.a.b.json', JSON.stringify({ version: 2, retracted: false }));
    expect(loads()).toBe(before);
  });
});

describe('loading a session with writer files', () => {
  it('adds the writer files to a captured pre-upgrade index', () => {
    const preUpgrade = activity(ids('p', 4));
    writeIndex(preUpgrade);
    writeWriter('legacy.0123456789abcdef.json', preUpgrade);
    writeWriter('engine.1.a.b.json', activity(ids('a', 2), START + 2000));

    expect(totals(store.loadSession(SID))).toEqual({ calls: 6, usd: 1.5, input: 600 });
  });

  it('counts the index as a capture until one is on disk', () => {
    writeIndex(activity(ids('p', 4)));
    writeWriter('engine.1.a.b.json', activity(['p0', 'p1'], START + 2000));

    expect(totals(store.loadSession(SID))).toEqual({ calls: 4, usd: 1, input: 400 });
  });

  it('counts an older build rewrite of the projection once', () => {
    writeWriter('legacy.0123456789abcdef.json', activity(ids('p', 4)));
    writeWriter('engine.1.a.b.json', activity(ids('a', 2), START + 2000));
    writeIndex(activity([...ids('p', 4), ...ids('a', 2), 'old0'], START + 3000));

    expect(totals(store.loadSession(SID))).toEqual({ calls: 7, usd: 1.75, input: 700 });
  });

  it('combines captures by max, since each holds the history before it', () => {
    writeWriter('legacy.0000000000000001.json', activity(ids('p', 4)));
    writeWriter('legacy.0000000000000002.json', activity([...ids('p', 4), 'old0'], START + 3000));
    writeWriter('engine.1.a.b.json', activity(ids('a', 2), START + 2000));
    writeIndex(activity(ids('x', 1)), { marked: true });

    expect(totals(store.loadSession(SID))).toEqual({ calls: 7, usd: 1.75, input: 700 });
  });

  it('takes a name from the newest capture', () => {
    writeWriter('legacy.0000000000000001.json', {
      ...activity(['p0', 'p1'], START + 5000),
      sessionName: 'newer',
    });
    writeWriter('legacy.0000000000000002.json', { ...activity(['p0']), sessionName: 'older' });
    writeWriter('engine.1.a.b.json', activity(ids('a', 1)));
    writeIndex(activity([]), { marked: true });

    expect(store.loadSession(SID)?.sessionName).toBe('newer');
  });

  it('ignores the numbers in a marked index, a zero ledger included', () => {
    writeIndex(
      {
        ...activity(ids('z', 40)),
        byteEstimates: {
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          costByModel: {},
          costByDayUsd: {},
        },
      },
      { marked: true },
    );
    writeWriter('engine.1.a.b.json', activity(ids('a', 2)));
    writeWriter('aggregator.1.a.b.json', estimating(['b0']));

    const loaded = store.loadSession(SID);
    expect(totals(loaded)).toEqual({ calls: 3, usd: 0.75, input: 300 });
    expect(loaded?.byteEstimates?.costUsd).toBe(0.25);
  });

  it.each(['engine.1.a.b.json', 'legacy.0123456789abcdef.json'])(
    'drops every writer estimate once %s retracts',
    (retracting) => {
      writeIndex(activity([]), { marked: true });
      writeWriter(retracting, activity(ids('a', 2)), true);
      writeWriter('aggregator.1.a.b.json', estimating(['b0']));

      expect(totals(store.loadSession(SID))).toEqual({ calls: 3, usd: 0.5, input: 200 });
    },
  );

  it('counts an older build file beside the projection', () => {
    writeIndex(activity(ids('a', 2)), { marked: true });
    writeIndex(activity(['old0'], START + 90_000_000), { date: '2026-03-02' });
    writeWriter('engine.1.a.b.json', activity(ids('a', 2)));

    expect(totals(store.loadSession(SID))).toEqual({ calls: 3, usd: 0.75, input: 300 });
  });

  it('captures a session split across index files whole', () => {
    writeIndex(activity(ids('a', 2)));
    writeIndex(activity(ids('b', 3), START + 90_000_000), { date: '2026-03-02' });
    writeWriter('legacy.0123456789abcdef.json', activity([...ids('a', 2), ...ids('b', 3)]));
    writeWriter('engine.1.a.b.json', activity(ids('w', 2), START + 2000));

    expect(totals(store.loadSession(SID))).toEqual({ calls: 7, usd: 1.75, input: 700 });
    expect(store.loadAllSessions().map(totals)).toEqual([{ calls: 7, usd: 1.75, input: 700 }]);
  });

  it('folds in every loader, and in the record a save merges into', () => {
    writeIndex(activity(ids('p', 4)), { marked: true });
    writeWriter('engine.1.a.b.json', activity(ids('a', 2)));
    writeWriter('engine.2.a.b.json', activity(ids('b', 3), START + 2000));
    const folded = { calls: 5, usd: 1.25, input: 500 };

    expect(store.loadAllSessions().map(totals)).toEqual([folded]);
    expect(store.loadAllSessions({ since: new Date('2026-02-28T00:00:00Z') }).map(totals)).toEqual([
      folded,
    ]);
    const saved = store.saveSession(activity(['n0'], START + 4000));
    expect(totals(saved?.previous)).toEqual(folded);
  });

  it('loads a marked index as saved when no writer file is usable', () => {
    writeIndex(activity(ids('p', 3)), { marked: true });
    writeRaw(SID, 'engine.1.a.b.json', '{"version": 1, "retracted": fal');

    expect(totals(store.loadSession(SID))).toEqual({ calls: 3, usd: 0.75, input: 300 });
  });

  it('leaves a writer directory without an index unlisted', () => {
    writeWriter('engine.1.a.b.json', { ...activity(ids('a', 2)), sessionId: 'orphan' });
    writeIndex(activity(ids('p', 1)));

    expect(store.loadSession('orphan')).toBeNull();
    expect(store.loadAllSessions().map((s) => s.sessionId)).toEqual([SID]);
    expect(store.listSessions().map((s) => s.sessionId)).toEqual([SID]);
  });

  it('skips writer files it cannot use and counts the rest', () => {
    const unused = (version: number, s: FullSessionSummary) =>
      JSON.stringify({ version, retracted: false, summary: s });
    writeIndex(activity([]), { marked: true });
    writeWriter('engine.1.a.b.json', activity(ids('a', 2)));
    writeRaw(SID, 'engine.2.a.b.json', unused(1, { ...activity(ids('o', 5)), sessionId: 'other' }));
    writeRaw(SID, 'engine.3.a.b.json', unused(2, activity(ids('v', 4))));
    writeRaw(SID, 'engine.4.a.b.json', '{"version": 1, "retracted": fal');
    writeRaw(SID, '.engine.5.a.b.json', unused(1, activity(ids('t', 3))));
    writeRaw(SID, 'engine.6.a.b.json.77.tmp', unused(1, activity(ids('u', 6))));
    writeRaw(SID, 'engine.7.a.b.json', JSON.stringify({ version: 1, retracted: false }));
    writeRaw(SID, 'engine.8.a.b.json', 'null');

    expect(totals(store.loadSession(SID))).toEqual({ calls: 2, usd: 0.5, input: 200 });
  });
});
