import { describe, expect, it } from '@jest/globals';

import {
  UsageLedger,
  ZERO_TOTALS,
  decodeUsageLedger,
  encodeUsageLedger,
  foldUsage,
  parsePersistedUsageLedger,
} from './usage-ledger.js';
import type { UsageEntry } from './usage-ledger.js';
import { mergeSummaries, usageLedgerOf } from '../storage/session-store.js';
import type { FullSessionSummary } from '../storage/session-store.js';

const DAY = '2026-09-10';

function makeEntry(overrides: Partial<UsageEntry> = {}): UsageEntry {
  return {
    id: 'msg_1',
    provisional: false,
    replaces: true,
    ts: 1_000,
    day: DAY,
    model: 'claude-sonnet-4-5',
    inputTokens: 100,
    outputTokens: 10,
    thinkingTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 1,
    cacheSavingsUsd: 0,
    ...overrides,
  };
}

function makeSummary(overrides: Partial<FullSessionSummary> = {}): FullSessionSummary {
  return {
    sessionId: 's1',
    startTime: 0,
    endTime: 5_000,
    durationMs: 5_000,
    toolCallCount: 1,
    developer: 'dev',
    estimatedCostUsd: 0,
    subagentCostUsd: 0,
    tokensInput: 0,
    tokensOutput: 0,
    tokensThinking: 0,
    tokensCacheRead: 0,
    tokensCacheCreation: 0,
    cacheSavingsUsd: 0,
    modelBreakdown: {},
    costByWorkflowRunId: {},
    ...overrides,
  } as unknown as FullSessionSummary;
}

function withLedger(entries: UsageEntry[], overrides: Partial<FullSessionSummary> = {}) {
  const fold = foldUsage(entries);
  return makeSummary({
    estimatedCostUsd: fold.totals.costUsd,
    subagentCostUsd: fold.totals.subagentCostUsd,
    tokensInput: fold.totals.inputTokens,
    tokensOutput: fold.totals.outputTokens,
    costByDayUsd: { ...fold.totals.costByDayUsd },
    usageLedger: encodeUsageLedger(entries),
    ...overrides,
  });
}

describe('UsageLedger', () => {
  it('counts an id once, however often it is inserted', () => {
    const ledger = new UsageLedger();
    expect(ledger.insert(makeEntry())).toBe(true);
    expect(ledger.insert(makeEntry())).toBe(false);
    expect(ledger.fold().totals.costUsd).toBe(1);
  });

  it('keeps the same entry for an id whichever copy arrives first', () => {
    const small = makeEntry({ outputTokens: 10, costUsd: 1, replaces: false });
    const grown = makeEntry({ outputTokens: 50, costUsd: 2 });
    const a = new UsageLedger();
    a.union([small, grown]);
    const b = new UsageLedger();
    b.union([grown, small]);
    expect(a.fold().totals).toEqual(b.fold().totals);
    expect(a.fold().totals.costUsd).toBe(2);
  });

  it('is idempotent under union', () => {
    const entries = [makeEntry(), makeEntry({ id: 'msg_2', costUsd: 3 })];
    const ledger = new UsageLedger();
    ledger.union(entries);
    ledger.union(entries);
    ledger.union([...entries].reverse());
    expect(ledger.fold().totals.costUsd).toBe(4);
  });

  it('refuses a Copilot app range overlapping one it holds, in the same epoch only', () => {
    const ledger = new UsageLedger();
    expect(ledger.insert(makeEntry({ id: 'copilot-app:s#0:0-500' }))).toBe(true);
    expect(ledger.insert(makeEntry({ id: 'copilot-app:s#0:500-800' }))).toBe(true);
    expect(ledger.insert(makeEntry({ id: 'copilot-app:s#0:0-800' }))).toBe(false);
    expect(ledger.insert(makeEntry({ id: 'copilot-app:s#1:0-300' }))).toBe(true);
    expect(ledger.fold().totals.costUsd).toBe(3);
  });

  it('retires an estimate once a replaying report is at or after it', () => {
    const est = makeEntry({ id: 'est:a:1', provisional: true, replaces: false, ts: 2_000 });
    const earlier = makeEntry({ id: 'msg_early', ts: 1_000, costUsd: 5 });
    const later = makeEntry({ id: 'msg_late', ts: 3_000, costUsd: 7 });
    expect(foldUsage([est, earlier]).totals.costUsd).toBe(6);
    expect(foldUsage([est, earlier, later]).totals.costUsd).toBe(12);
    expect(foldUsage([est, later]).byteEstimates?.costUsd).toBe(0);
  });

  it('never retires an estimate on a self-report or a subagent turn', () => {
    const est = makeEntry({ id: 'est:a:1', provisional: true, replaces: false, ts: 2_000 });
    const self = makeEntry({ id: 'anon:a:1', replaces: false, ts: 3_000, costUsd: 5 });
    const sub = makeEntry({ id: 'msg_sub', replaces: false, agentId: 'a', ts: 3_000 });
    expect(foldUsage([est, self, sub]).byteEstimates?.costUsd).toBe(1);
  });

  it('folds the same incrementally as from scratch', () => {
    const ledger = new UsageLedger();
    const all: UsageEntry[] = [];
    for (let i = 0; i < 40; i++) {
      const e = makeEntry({
        id: `msg_${i % 30}`,
        ts: i * 100,
        day: i % 3 === 0 ? '2026-09-11' : DAY,
        model: i % 2 === 0 ? 'a' : 'b',
        costUsd: i % 5 === 0 ? 0 : i,
        inputTokens: i,
        replaces: i % 4 !== 0,
        provisional: i % 9 === 1,
        ...(i % 6 === 0 && { agentId: 'agent', agentType: 'Explore', workflowRunId: 'run' }),
      });
      all.push(e);
      ledger.insert(e);
      expect(ledger.fold()).toEqual(foldUsage(ledger.values()));
    }
  });

  it('round-trips through its persisted form', () => {
    const entries = [
      makeEntry({ agentId: 'agent-1', agentType: 'Explore', workflowRunId: 'run-1' }),
      makeEntry({ id: 'est:x:1', provisional: true, replaces: false, day: null }),
      makeEntry({ id: 'msg_3', pricing: { estimatedFrom: 'claude-opus-5' } }),
      makeEntry({ id: 'msg_4', model: 'mystery', pricing: { kind: 'unpriced' } }),
    ];
    const parsed = parsePersistedUsageLedger(
      JSON.parse(JSON.stringify(encodeUsageLedger(entries))),
    );
    expect(decodeUsageLedger(parsed!).entries).toEqual(entries);
  });

  it('drops malformed persisted entries', () => {
    const parsed = parsePersistedUsageLedger({
      v: 1,
      models: ['m'],
      entries: ['not json', '["id",9,0,null,0]', '["ok",2,1,null,0,1,1,0,0,0,0.5,0]', 42],
    });
    expect(decodeUsageLedger(parsed!).entries.map((e) => e.id)).toEqual(['ok']);
    expect(parsePersistedUsageLedger({ v: 2, models: [], entries: [] })).toBeUndefined();
  });
});

describe('session files and the ledger', () => {
  it('merges two writers of one session as a union', () => {
    const a = withLedger([makeEntry({ id: 'msg_a' }), makeEntry({ id: 'msg_shared' })]);
    const b = withLedger([makeEntry({ id: 'msg_shared' }), makeEntry({ id: 'msg_b' })]);
    const merged = mergeSummaries(a, b);
    expect(merged.estimatedCostUsd).toBe(3);
    expect(merged.tokensInput).toBe(300);
    expect(mergeSummaries(merged, a).estimatedCostUsd).toBe(3);
  });

  it('keeps a pre-ledger file whole without re-adding the calls the other side keyed', () => {
    // An older process wrote $5 that already includes msg_a; the new side holds msg_a keyed.
    const legacy = makeSummary({
      estimatedCostUsd: 5,
      tokensInput: 500,
      costByDayUsd: { [DAY]: 5 },
    });
    const keyed = withLedger([makeEntry({ id: 'msg_a' }), makeEntry({ id: 'msg_new' })]);
    const merged = mergeSummaries(legacy, keyed);
    // Base: $5 less the $2 keyed elsewhere, then the $2 keyed added back.
    expect(merged.estimatedCostUsd).toBe(5);
    expect(merged.usageLedger).toBeDefined();
  });

  it('turns a pre-ledger byte-estimate ledger into estimates the next report retires', () => {
    const legacy = makeSummary({
      endTime: 5_000,
      estimatedCostUsd: 3,
      tokensInput: 300,
      byteEstimates: {
        costUsd: 1,
        inputTokens: 100,
        outputTokens: 0,
        costByModel: { m: 1 },
        costByDayUsd: { [DAY]: 1 },
      },
    });
    const recovered = usageLedgerOf(legacy);
    expect(recovered.base.costUsd).toBe(2);
    expect(foldUsage(recovered.entries, recovered.base).totals.costUsd).toBe(3);
    const replay = makeEntry({ id: 'msg_after', ts: 6_000, costUsd: 4 });
    expect(foldUsage([...recovered.entries, replay], recovered.base).totals.costUsd).toBe(6);
  });

  it('folds into base what an older writer added on top of a stored ledger', () => {
    // A pre-ledger Preflight max-merged its $9 total into a file whose ledger adds up to $2.
    const touched = withLedger([makeEntry({ id: 'msg_a' }), makeEntry({ id: 'msg_b' })], {
      estimatedCostUsd: 9,
    });
    const { entries, base } = usageLedgerOf(touched);
    expect(foldUsage(entries, base).totals.costUsd).toBe(9);
    expect(base).not.toBe(ZERO_TOTALS);
  });
});
