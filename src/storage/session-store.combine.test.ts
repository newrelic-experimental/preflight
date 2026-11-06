import { describe, it, expect } from '@jest/globals';
import { combineSessionFiles, deserializeFullSessionSummary } from './session-store.js';
import type { FullSessionSummary } from './session-store.js';

const START = Date.parse('2026-03-01T10:00:00Z');
const DAY = 86_400_000;
const TIMELINE_CAP = 10_000;

const entry = (timestamp: number, toolName = 'Read') => ({ timestamp, toolName });
const entries = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => entry(from + i));
type Entry = ReturnType<typeof entry>;

function summary(fields: Record<string, unknown>): FullSessionSummary {
  return deserializeFullSessionSummary({
    sessionId: 'split',
    startTime: START,
    endTime: START + 1000,
    ...fields,
  } as unknown as Parameters<typeof deserializeFullSessionSummary>[0]);
}

type Rule = (older: number, newer: number) => number;
const sum: Rule = (x, y) => x + y;
const max: Rule = (x, y) => Math.max(x, y);
const latest: Rule = (_, y) => y;
const weighted: Rule = (x, y) => (x * x + y * y) / (x + y);

const rows = (disjoint: Rule, overlapping: Rule, paths: string) =>
  paths
    .trim()
    .split(/\s+/)
    .map((path): [string, Rule, Rule] => [path, disjoint, overlapping]);

const COUNTERS = `
  toolCallCount toolBreakdown.Read skillBreakdown.s linesAdded linesRemoved bashCommandCount
  testRunCount testPassCount buildRunCount buildPassCount subagentCostUsd subagentCostByDayUsd.d
  unpricedByModel.m.calls unpricedByModel.m.tokens estimatedByModel.m.calls estimatedByModel.m.tokens
  exactTotals.costUsd exactTotals.inputTokens exactTotals.outputTokens exactTotals.costByDayUsd.d
  tokensThinking tokensCacheRead tokensCacheCreation cacheSavingsUsd taskCount contextCompressions
  agentSpawns costByWorkflowRunId.r.d efficiencyScoreSampleCount
  modelBreakdown.m.requestCount modelBreakdown.m.totalInputTokens modelBreakdown.m.totalOutputTokens
  modelBreakdown.m.totalCostUsd modelBreakdown.m.totalCacheReadTokens
  modelBreakdown.m.totalCacheCreationTokens modelBreakdown.m.totalThinkingTokens
  qualityProxy.totalSignals qualityProxy.diffApplyCleanCount qualityProxy.diffFailCount
  qualityProxy.testPassCount qualityProxy.testFailCount qualityProxy.backtrackCount
  qualityProxy.selfCorrectionCount
  attribution.buckets.tool.Read.costUsd attribution.buckets.tool.Read.tokens
  attribution.buckets.tool.Read.count attribution.buckets.tool.Read.durationMs
  attribution.buckets.tool.Read.breakdown.inputTokens attribution.buckets.tool.Read.breakdown.outputTokens
  attribution.buckets.tool.Read.breakdown.cacheReadTokens
  attribution.buckets.tool.Read.breakdown.cacheCreationTokens
  attribution.highContextCostUsd attribution.apiDurationMs`;
const LEDGER = `
  byteEstimates.costUsd byteEstimates.inputTokens byteEstimates.outputTokens
  byteEstimates.costByModel.m byteEstimates.costByDayUsd.d`;
/** Each is exact plus ledger, so the fixture sets them to twice its counters. */
const TOTALS = 'estimatedCostUsd tokensInput tokensOutput costByDayUsd.d';
const NEVER_ADDED = `
  userMessages assistantMessages userCorrections toolSelectionMetrics.totalCalls
  toolSelectionMetrics.score toolSelectionMetrics.penalizedCalls
  toolSelectionMetrics.redundantReadCount toolSelectionMetrics.repeatedFailureCount
  toolSelectionMetrics.unusedOutputCount`;
const SCORES = `
  efficiencyScore efficiencyScoreComponents.speed efficiencyScoreComponents.correctness
  efficiencyScoreComponents.autonomy efficiencyScoreComponents.firstAttemptQuality`;

const RULES: ReadonlyArray<[string, Rule, Rule]> = [
  ...rows(sum, max, COUNTERS),
  ...rows(sum, max, LEDGER),
  ...rows(
    (x, y) => 2 * (x + y),
    (x, y) => 2 * Math.max(x, y),
    TOTALS,
  ),
  ...rows(max, max, NEVER_ADDED),
  ...rows(weighted, max, SCORES),
  ...rows(() => 1, latest, 'taskSuccessRate'),
  ...rows(weighted, latest, 'toolSuccessRate'),
];

function setPath(target: Record<string, unknown>, path: string, value: number): void {
  const keys = path.split('.');
  const last = keys.pop() as string;
  let node = target;
  for (const key of keys) node = (node[key] ??= {}) as Record<string, unknown>;
  node[last] = value;
}

/** A file with every number in RULES set from `k`, so each row can name what combining gives. */
function everyField(k: number, startTime: number, timeline: Entry[]) {
  const fields: Record<string, unknown> = {
    startTime,
    endTime: startTime + 1000,
    timeline,
    developer: `dev-${k}`,
    sessionName: `name-${startTime}`,
    filesRead: [`read-${k}`],
    antiPatterns: [{ type: `t${k}`, severity: 'low', description: 'd', toolCallIds: [] }],
  };
  for (const [path] of RULES) setPath(fields, path, TOTALS.split(' ').includes(path) ? 2 * k : k);
  (fields.estimatedByModel as { m: Record<string, unknown> }).m.estimatedFrom = 'p';
  return summary(fields);
}

function numericLeaves(value: unknown, path = '', out = new Map<string, number>()) {
  if (typeof value === 'number') {
    if (!['startTime', 'endTime', 'durationMs'].includes(path)) out.set(path, value);
  } else if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      numericLeaves(child, path ? `${path}.${key}` : key, out);
    }
  }
  return out;
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  );
}

/** Combines in every input order, requires one answer, and returns it. */
function combineInEveryOrder(files: readonly FullSessionSummary[]): FullSessionSummary {
  const [first, ...others] = permutations(files).map((order) => combineSessionFiles(order));
  for (const other of others) expect(other).toEqual(first);
  return first;
}

const calls = (start: number, toolCallCount: number, extra: Record<string, unknown> = {}) =>
  summary({
    startTime: start,
    endTime: start + 1000,
    toolCallCount,
    estimatedCostUsd: toolCallCount / 10,
    timeline: entries(start, toolCallCount),
    ...extra,
  });

describe.each([
  ['the older file smaller', 2, 3],
  ['the older file larger', 3, 2],
])('combining two files, %s', (_, older, newer) => {
  const [t1, t2] = [START, START + DAY];
  const disjoint = () =>
    combineSessionFiles([
      everyField(older, t1, [entry(t1 + 1)]),
      everyField(newer, t2, [entry(t2 + 1)]),
    ]);
  const overlapping = () =>
    combineSessionFiles([
      everyField(older, t1, [entry(t1 + 1), entry(t1 + 2)]),
      everyField(newer, t2, [entry(t1 + 2), entry(t2 + 1)]),
    ]);

  it('has a rule for every number on the record', () => {
    expect([...numericLeaves(disjoint()).keys()].sort()).toEqual(
      RULES.map(([path]) => path).sort(),
    );
  });

  it.each(RULES)('%s', (path, whenDisjoint, whenOverlapping) => {
    expect(numericLeaves(disjoint()).get(path)).toBeCloseTo(whenDisjoint(older, newer));
    expect(numericLeaves(overlapping()).get(path)).toBeCloseTo(whenOverlapping(older, newer));
  });

  it('takes the time span and labels from the files, not a sum', () => {
    for (const combined of [disjoint(), overlapping()]) {
      expect([combined.startTime, combined.endTime]).toEqual([t1, t2 + 1000]);
      expect(combined.durationMs).toBe(t2 + 1000 - t1);
      expect(combined.developer).toBe(`dev-${newer}`);
      expect(combined.sessionName).toBe(`name-${t2}`);
      expect(combined.filesRead).toEqual([`read-${older}`, `read-${newer}`]);
    }
  });

  it('unions the timeline and adds anti-patterns only for separate activity', () => {
    const added = disjoint();
    expect(added.timeline?.map((e) => e.timestamp)).toEqual([t1 + 1, t2 + 1]);
    expect(added.antiPatterns.map((p) => p.type)).toEqual([`t${older}`, `t${newer}`]);
    const maxed = overlapping();
    expect(maxed.timeline?.map((e) => e.timestamp)).toEqual([t1 + 1, t1 + 2, t2 + 1]);
    expect(maxed.antiPatterns.map((p) => p.type)).toEqual([`t${newer}`]);
  });
});

describe('combining fields that do not always exist', () => {
  const pair = (older: Record<string, unknown>, newer: Record<string, unknown>) =>
    combineInEveryOrder([calls(START, 1, older), calls(START + DAY, 1, newer)]);
  const ledger = { costUsd: 2, inputTokens: 2, outputTokens: 2, costByModel: {}, costByDayUsd: {} };

  it('leaves cost unknown only when neither file knows it', () => {
    const unknown = { estimatedCostUsd: null };
    expect(pair(unknown, unknown).estimatedCostUsd).toBeNull();
    expect(pair(unknown, { estimatedCostUsd: 2 }).estimatedCostUsd).toBeCloseTo(2);
  });

  it.each(['costByDayUsd', 'subagentCostByDayUsd', 'unpricedByModel', 'estimatedByModel'])(
    'keeps %s absent when neither file has it, since absent and empty read differently',
    (field) => {
      expect((pair({}, {}) as unknown as Record<string, unknown>)[field]).toBeUndefined();
    },
  );

  it('keeps a ledger only one file has', () => {
    const combined = pair({ byteEstimates: ledger }, {});
    expect(combined.byteEstimates).toEqual(ledger);
    expect(pair({}, {}).byteEstimates).toBeUndefined();
    const added = pair({ byteEstimates: ledger, estimatedCostUsd: 3 }, { estimatedCostUsd: 5 });
    expect(added.estimatedCostUsd).toBeCloseTo(8);
  });

  it.each([
    ['one rate missing', null, 5, 0.5, 5, 0.5],
    ['the other rate missing', 0.5, 5, null, 5, 0.5],
    ['both rates missing', null, 5, null, 5, null],
    ['no weight on either side', 0.2, 0, 0.4, 0, 0.3],
    ['uneven weights', 0.2, 1, 0.8, 3, 0.65],
  ])('weighs success rates: %s', (_, rateA, weightA, rateB, weightB, expected) => {
    const task = pair(
      { taskSuccessRate: rateA, taskCount: weightA, toolCallCount: 7 },
      { taskSuccessRate: rateB, taskCount: weightB, toolCallCount: 1 },
    );
    const tool = pair(
      { toolSuccessRate: rateA, toolCallCount: weightA, taskCount: 7 },
      { toolSuccessRate: rateB, toolCallCount: weightB, taskCount: 1 },
    );
    for (const rate of [task.taskSuccessRate, tool.toolSuccessRate]) {
      if (expected === null) expect(rate).toBeNull();
      else expect(rate).toBeCloseTo(expected);
    }
  });

  it.each([
    ['tests pooled', 0.5, 50, 100, 51 / 101],
    ['a rate with no counts', 0.5, 0, 0, 0.75],
  ])('rebuilds the task rate: %s', (_, rate, testPassCount, testRunCount, expected) => {
    const file = { taskSuccessRate: rate, testPassCount, testRunCount, taskCount: 1 };
    const other = { taskSuccessRate: 1, testPassCount: 1, testRunCount: 1, taskCount: 1 };
    expect(pair(file, other).taskSuccessRate).toBeCloseTo(expected);
  });

  it.each([
    ['a file has no score', { efficiencyScore: null }],
    ['a file has no samples', { efficiencyScore: 0.1, efficiencyScoreSampleCount: 0 }],
    ['a file has no components', { efficiencyScore: 0.1, efficiencyScoreComponents: null }],
  ])('keeps one whole efficiency score when %s', (_, thin) => {
    const scored = {
      efficiencyScore: 0.9,
      efficiencyScoreSampleCount: 4,
      efficiencyScoreComponents: { speed: 1, correctness: 1, autonomy: 1, firstAttemptQuality: 1 },
    };
    const combined = pair({ ...scored, efficiencyScoreSampleCount: 4, ...thin }, scored);
    expect(combined.efficiencyScore).toBe(0.9);
    expect(combined.efficiencyScoreSampleCount).toBe(4);
  });

  it('does not divide by zero when neither efficiency score has samples', () => {
    const unsampled = (efficiencyScore: number) => ({
      efficiencyScore,
      efficiencyScoreSampleCount: 0,
      efficiencyScoreComponents: { speed: 1, correctness: 1, autonomy: 1, firstAttemptQuality: 1 },
    });
    expect(pair(unsampled(0.1), unsampled(0.9)).efficiencyScore).toBe(0.9);
  });

  it('leaves attribution duration unknown only when neither file knows it', () => {
    const attribution = (apiDurationMs: number | null) => ({
      attribution: { buckets: {}, highContextCostUsd: 0, apiDurationMs },
    });
    expect(pair(attribution(null), attribution(null)).attribution?.apiDurationMs).toBeNull();
    expect(pair(attribution(null), attribution(5)).attribution?.apiDurationMs).toBe(5);
  });
});

describe('which files add and which max-merge', () => {
  const d = (n: number) => START + n * DAY;

  it('returns a lone file as it is', () => {
    const only = calls(d(0), 3);
    expect(combineSessionFiles([only])).toBe(only);
  });

  it.each([
    ['first', 0],
    ['last', 4],
  ])('adds a separate file written %s to a superseded pair, in any order', (_, day) => {
    const y = entries(d(1), 20);
    const files = [
      calls(d(day), 10),
      calls(d(1), 20, { timeline: y }),
      calls(d(2), 25, { timeline: [...y, ...entries(d(5), 5)] }),
    ];
    const combined = combineInEveryOrder(files);
    expect([combined.toolCallCount, combined.estimatedCostUsd]).toEqual([35, 3.5]);
  });

  it('max-merges within each group of shared activity and adds across groups', () => {
    const [p, q] = [entries(d(0), 4), entries(d(3), 6)];
    const files = [
      calls(d(0), 4, { timeline: p }),
      calls(d(1), 5, { timeline: [...p, entry(d(1))] }),
      calls(d(3), 6, { timeline: q }),
      calls(d(4), 8, { timeline: [...q, entry(d(4))] }),
    ];
    expect(combineInEveryOrder(files).toolCallCount).toBe(13);
  });

  it('treats files linked only through a third file as one group', () => {
    const files = [
      calls(d(0), 2, { timeline: [entry(1), entry(2)] }),
      calls(d(1), 3, { timeline: [entry(2), entry(3)] }),
      calls(d(2), 4, { timeline: [entry(3), entry(4)] }),
    ];
    expect(combineInEveryOrder(files).toolCallCount).toBe(4);
  });

  it.each([
    ['smaller than the total', 15, 30],
    ['larger than the total', 40, 40],
  ])('max-merges a file with no timeline %s into the total', (_, count, expected) => {
    const files = [calls(d(0), 10), calls(d(1), 20), calls(d(2), count, { timeline: [] })];
    expect(combineInEveryOrder(files).toolCallCount).toBe(expected);
  });

  it('combines files that all lack a timeline', () => {
    const files = [calls(d(0), 3, { timeline: [] }), calls(d(1), 5, { timeline: [] })];
    expect(combineInEveryOrder(files).toolCallCount).toBe(5);
  });

  it('does not depend on input order when writers tie on both times', () => {
    const tied = (name: string, timeline: Entry[]) =>
      calls(d(0), 1, { sessionName: name, timeline });
    const merged = combineInEveryOrder([tied('a', [entry(1)]), tied('b', [entry(1)])]);
    expect(merged.toolCallCount).toBe(1);
    const added = combineInEveryOrder([tied('a', [entry(1)]), tied('b', [entry(2)])]);
    expect(added.toolCallCount).toBe(2);
  });

  it('counts the file that ended last as the later writer, not the one that started last', () => {
    const shared = entries(d(0), 2);
    const long = calls(d(0), 2, { timeline: shared, sessionName: 'long', endTime: d(5) });
    const short = calls(d(1), 2, { timeline: shared, sessionName: 'short', endTime: d(2) });
    expect(combineInEveryOrder([long, short]).sessionName).toBe('long');
  });
});

describe('a ledger, which a combine must not lose or resurrect', () => {
  const file = (start: number, exact: number, usd: number, timeline?: Entry[]) =>
    calls(start, 1, {
      timeline,
      estimatedCostUsd: exact + usd,
      exactTotals: { costUsd: exact, inputTokens: 0, outputTokens: 0, costByDayUsd: {} },
      byteEstimates: { costUsd: usd, inputTokens: 0, outputTokens: 0 },
    });
  const tokens = (start: number, count: number, timeline?: Entry[]) =>
    calls(start, 1, {
      timeline,
      tokensInput: count,
      exactTotals: { costUsd: 0, inputTokens: 0, outputTokens: 0, costByDayUsd: {} },
      byteEstimates: { costUsd: 0, inputTokens: count, outputTokens: 0 },
    });
  const [t1, t2, t3] = [START, START + DAY, START + 2 * DAY];
  const [e1, e2, shared] = [[entry(t1)], [entry(t2)], [entry(t1 + 1)]];
  const [a, b] = [file(t1, 1, 4, e1), file(t2, 1, 4, e2)];
  const sum = (endTime: number) => ({ ...file(t1, 2, 8, [...e1, ...e2]), endTime });

  it.each([
    ['newer, no timeline', [a, b, file(t3, 0, 1)], 10],
    ['older, no timeline', [a, b, file(t1 - DAY, 0, 1)], 10],
    ['no timeline, larger exact', [a, b, file(t3, 3, 0)], 11],
    ['no timeline, larger total', [a, b, file(t3, 1, 20)], 22],
    ['no timeline, equal total, reported', [a, b, file(t1 - DAY, 10, 0)], 10],
    ['a leftover source ties the sum', [sum(t2), { ...a, endTime: t2 }], 10],
    ['a leftover source beats the sum', [sum(t2), { ...a, endTime: t2 + 1 }], 10],
    ['copies, a report replaced it', [file(t1, 1, 4, shared), file(t2, 5, 0, shared)], 5],
    ['copies, a report came in lower', [file(t1, 1, 4, shared), file(t2, 3, 0, shared)], 3],
    ['copies, older is further along', [file(t1, 5, 0, shared), file(t2, 1, 6, shared)], 5],
    ['copies, a tie keeps the larger', [file(t1, 1, 8, shared), file(t2, 1, 4, shared)], 9],
  ])('%s', (_, files, usd) => {
    expect(combineInEveryOrder(files).estimatedCostUsd).toBeCloseTo(usd);
  });

  it.each([
    ['copies', [tokens(t1, 8, shared), tokens(t2, 4, shared)], 8],
    ['a sum, no timeline', [tokens(t1, 4, e1), tokens(t2, 4, e2), tokens(t3, 1)], 8],
  ])('ranks by tokens where no cost is known: %s', (_, files, expected) => {
    expect(combineInEveryOrder(files).tokensInput).toBe(expected);
  });
});

describe('a timeline at the cap, which has dropped entries', () => {
  const firstKept = START + 1000;
  const capped = (length = TIMELINE_CAP, startTime = START, count = TIMELINE_CAP + 100) =>
    calls(startTime, count, {
      timeline: entries(firstKept, length),
      endTime: firstKept + 2 * DAY,
    });
  const other = (startTime: number, timeline: Entry[], endTime = startTime + 1) =>
    calls(startTime, 7, { timeline, endTime });
  const justBeforeKept = other(START + 100, [entry(START + 200)]);
  const lastKept = firstKept + TIMELINE_CAP - 1;
  const after = lastKept + 1;

  it.each([
    ['ends before the first kept entry', capped(), justBeforeKept, 10_100],
    ['started when the capped file did', capped(), other(START, [entry(START)]), 10_100],
    [
      'started first',
      capped(TIMELINE_CAP, START + 500),
      other(START, [entry(START + 700)]),
      10_107,
    ],
    ['ends at the first kept entry', capped(), other(START, [entry(firstKept, 'Bash')]), 10_107],
    ['starts after the last kept entry', capped(), other(after, [entry(after)]), 10_100],
    ['starts at the last kept entry', capped(), other(after, [entry(lastKept, 'Bash')]), 10_107],
    ['ends after the capped file', capped(), other(after, [entry(after)], after + 3 * DAY), 10_107],
    [
      'fills the gap',
      capped(TIMELINE_CAP, START, TIMELINE_CAP + 1),
      justBeforeKept,
      TIMELINE_CAP + 1,
    ],
    [
      'is too long for the gap',
      capped(TIMELINE_CAP, START, TIMELINE_CAP),
      justBeforeKept,
      TIMELINE_CAP + 7,
    ],
    [
      'ends after the first kept entry',
      capped(),
      other(START + 100, [entry(START + 200), entry(firstKept + 2 * DAY)]),
      10_107,
    ],
    ['meets a timeline short of the cap', capped(TIMELINE_CAP - 1), justBeforeKept, 10_107],
    [
      'was written after the capped file',
      calls(START, TIMELINE_CAP + 100, {
        timeline: entries(firstKept, TIMELINE_CAP),
        endTime: firstKept + 1,
      }),
      other(START + 100, [entry(START + 200)], firstKept + DAY),
      10_100,
    ],
  ])('a file that %s', (_, full, file, expected) => {
    expect(combineInEveryOrder([full, file]).toolCallCount).toBe(expected);
  });
});
