import {
  QualityProxyTracker,
  combineQualityProxyRawCounts,
  ZERO_QUALITY_PROXY_COUNTS,
} from './quality-proxy-tracker.js';
import type { ToolCallRecord } from '../storage/types.js';

const stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
afterEach(() => stderrSpy.mockClear());

let idCounter = 0;
function makeRecord(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: `id-${++idCounter}`,
    sessionId: 'sess-1',
    toolName: 'Bash',
    toolUseId: `tu-${idCounter}`,
    timestamp: Date.now(),
    durationMs: 100,
    success: true,
    ...overrides,
  };
}

beforeEach(() => {
  idCounter = 0;
});

type QualityProxyRawCountsLike = ReturnType<QualityProxyTracker['getRawCounts']>;

describe('QualityProxyTracker', () => {
  it('tracks successful edits as diff_applied_clean', () => {
    const tracker = new QualityProxyTracker();
    tracker.recordToolCall(makeRecord({ toolName: 'Edit', filePath: '/a.ts', success: true }));

    const metrics = tracker.getMetrics();
    expect(metrics.diffApplyRate).toBe(1);
    expect(metrics.totalSignals).toBe(1);
  });

  it('tracks failed edits as diff_failed', () => {
    const tracker = new QualityProxyTracker();
    tracker.recordToolCall(makeRecord({ toolName: 'Edit', filePath: '/a.ts', success: false }));

    const metrics = tracker.getMetrics();
    expect(metrics.diffApplyRate).toBe(0);
  });

  it('tracks test pass/fail rates', () => {
    const tracker = new QualityProxyTracker();
    tracker.recordToolCall(makeRecord({ toolName: 'Bash', isTestCommand: true, success: true }));
    tracker.recordToolCall(makeRecord({ toolName: 'Bash', isTestCommand: true, success: true }));
    tracker.recordToolCall(makeRecord({ toolName: 'Bash', isTestCommand: true, success: false }));

    const metrics = tracker.getMetrics();
    expect(metrics.testPassRate).toBeCloseTo(0.667, 2);
  });

  it('does NOT count post-edit verification Read as backtrack when edit succeeded', () => {
    // Edit(success) → Read same file within 2 turns is a normal verification, not a backtrack.
    const tracker = new QualityProxyTracker();
    tracker.recordToolCall(makeRecord({ toolName: 'Edit', filePath: '/a.ts', success: true }));
    tracker.recordToolCall(makeRecord({ toolName: 'Read', filePath: '/a.ts', success: true }));

    const metrics = tracker.getMetrics();
    expect(metrics.backtrackCount).toBe(0);
  });

  it('counts Read after failed Edit as backtrack', () => {
    const tracker = new QualityProxyTracker();
    tracker.recordToolCall(makeRecord({ toolName: 'Edit', filePath: '/a.ts', success: false }));
    tracker.recordToolCall(makeRecord({ toolName: 'Read', filePath: '/a.ts', success: true }));

    const metrics = tracker.getMetrics();
    expect(metrics.backtrackCount).toBe(1);
  });

  it('counts Read after successful Edit + test failure as backtrack', () => {
    const tracker = new QualityProxyTracker();
    tracker.recordToolCall(makeRecord({ toolName: 'Edit', filePath: '/a.ts', success: true }));
    tracker.recordToolCall(makeRecord({ toolName: 'Bash', isTestCommand: true, success: false }));
    tracker.recordToolCall(makeRecord({ toolName: 'Read', filePath: '/a.ts', success: true }));

    const metrics = tracker.getMetrics();
    expect(metrics.backtrackCount).toBe(1);
  });

  it('detects self-correction (Edit → test fail → Edit same file)', () => {
    const tracker = new QualityProxyTracker();
    tracker.recordToolCall(makeRecord({ toolName: 'Edit', filePath: '/a.ts', success: true }));
    tracker.recordToolCall(makeRecord({ toolName: 'Bash', isTestCommand: true, success: false }));
    tracker.recordToolCall(makeRecord({ toolName: 'Edit', filePath: '/a.ts', success: true }));

    const metrics = tracker.getMetrics();
    expect(metrics.selfCorrectionCount).toBe(1);
  });

  it('computes quality by turn bucket', () => {
    const tracker = new QualityProxyTracker({ bucketSize: 5 });

    // First 5 turns: all good
    for (let i = 0; i < 5; i++) {
      tracker.recordToolCall(
        makeRecord({ toolName: 'Edit', filePath: `/f${i}.ts`, success: true }),
      );
    }
    // Next 5 turns: all bad
    for (let i = 0; i < 5; i++) {
      tracker.recordToolCall(
        makeRecord({ toolName: 'Edit', filePath: `/g${i}.ts`, success: false }),
      );
    }

    const metrics = tracker.getMetrics();
    expect(metrics.qualityByTurnBucket.length).toBeGreaterThanOrEqual(2);
    expect(metrics.qualityByTurnBucket[0].qualityRatio).toBe(1);
    expect(metrics.qualityByTurnBucket[1].qualityRatio).toBe(0);
  });

  it('detects degradation when early quality > late quality', () => {
    const tracker = new QualityProxyTracker({ bucketSize: 3, degradationThreshold: 0.3 });

    // 9 good turns followed by 9 bad turns (3 buckets each)
    for (let i = 0; i < 9; i++) {
      tracker.recordToolCall(
        makeRecord({ toolName: 'Edit', filePath: `/good${i}.ts`, success: true }),
      );
    }
    for (let i = 0; i < 9; i++) {
      tracker.recordToolCall(
        makeRecord({ toolName: 'Edit', filePath: `/bad${i}.ts`, success: false }),
      );
    }

    const metrics = tracker.getMetrics();
    expect(metrics.degradationDetected).toBe(true);
  });

  it('does not detect degradation for consistent sessions', () => {
    const tracker = new QualityProxyTracker({ bucketSize: 3, degradationThreshold: 0.3 });

    // All good across all buckets
    for (let i = 0; i < 15; i++) {
      tracker.recordToolCall(
        makeRecord({ toolName: 'Edit', filePath: `/f${i}.ts`, success: true }),
      );
    }

    const metrics = tracker.getMetrics();
    expect(metrics.degradationDetected).toBe(false);
  });

  it('reset clears all state', () => {
    const tracker = new QualityProxyTracker();
    tracker.recordToolCall(makeRecord({ toolName: 'Edit', filePath: '/a.ts', success: true }));

    tracker.reset('new-session');
    const metrics = tracker.getMetrics();
    expect(metrics.totalSignals).toBe(0);
    expect(metrics.diffApplyRate).toBeNull();
    expect(metrics.testPassRate).toBeNull();
  });

  it('emitMetrics records expected metrics', () => {
    const aggregator = { record: jest.fn() };
    const tracker = new QualityProxyTracker();
    tracker.recordToolCall(makeRecord({ toolName: 'Edit', filePath: '/a.ts', success: true }));
    tracker.recordToolCall(makeRecord({ toolName: 'Edit', filePath: '/a.ts', success: false }));
    tracker.recordToolCall(makeRecord({ toolName: 'Bash', success: true, isTestCommand: true }));

    tracker.emitMetrics(aggregator as never);
    expect(aggregator.record).toHaveBeenCalledWith(
      'ai.quality.diff_apply_rate',
      expect.any(Number),
    );
    expect(aggregator.record).toHaveBeenCalledWith('ai.quality.test_pass_rate', expect.any(Number));
    expect(aggregator.record).toHaveBeenCalledWith(
      'ai.quality.backtrack_count',
      expect.any(Number),
    );
    expect(aggregator.record).toHaveBeenCalledWith(
      'ai.quality.self_correction_count',
      expect.any(Number),
    );
  });

  it('emitMetrics skips null rates when no data', () => {
    const aggregator = { record: jest.fn() };
    const tracker = new QualityProxyTracker();
    tracker.emitMetrics(aggregator as never);
    expect(aggregator.record).not.toHaveBeenCalledWith(
      'ai.quality.diff_apply_rate',
      expect.anything(),
    );
    expect(aggregator.record).not.toHaveBeenCalledWith(
      'ai.quality.test_pass_rate',
      expect.anything(),
    );
  });

  it('seedFromPersisted adds persisted raw counts into getRawCounts()', () => {
    const tracker = new QualityProxyTracker();
    tracker.recordToolCall(makeRecord({ toolName: 'Edit', filePath: '/a.ts', success: true }));

    tracker.seedFromPersisted({
      totalSignals: 4,
      diffApplyCleanCount: 2,
      diffFailCount: 1,
      testPassCount: 1,
      testFailCount: 0,
      backtrackCount: 0,
      selfCorrectionCount: 0,
    });

    const counts = tracker.getRawCounts();
    expect(counts.totalSignals).toBe(5); // 1 live diff_applied_clean + 4 seeded
    expect(counts.diffApplyCleanCount).toBe(3); // 1 live + 2 seeded
    expect(counts.diffFailCount).toBe(1);
    expect(counts.testPassCount).toBe(1);
  });

  it('seedFromPersisted is additive across multiple calls (repeated rehydration guard upstream)', () => {
    const tracker = new QualityProxyTracker();
    tracker.seedFromPersisted({
      totalSignals: 1,
      diffApplyCleanCount: 1,
      diffFailCount: 0,
      testPassCount: 0,
      testFailCount: 0,
      backtrackCount: 0,
      selfCorrectionCount: 0,
    });
    tracker.seedFromPersisted({
      totalSignals: 1,
      diffApplyCleanCount: 1,
      diffFailCount: 0,
      testPassCount: 0,
      testFailCount: 0,
      backtrackCount: 0,
      selfCorrectionCount: 0,
    });
    expect(tracker.getRawCounts().diffApplyCleanCount).toBe(2);
  });

  it('seeded counts feed diffApplyRate/testPassRate via getMetrics()', () => {
    const tracker = new QualityProxyTracker();
    tracker.seedFromPersisted({
      totalSignals: 4,
      diffApplyCleanCount: 3,
      diffFailCount: 1,
      testPassCount: 0,
      testFailCount: 0,
      backtrackCount: 0,
      selfCorrectionCount: 0,
    });
    expect(tracker.getMetrics().diffApplyRate).toBe(0.75);
  });

  it('is a no-op when the persisted counts are all zero', () => {
    const tracker = new QualityProxyTracker();
    tracker.seedFromPersisted(ZERO_QUALITY_PROXY_COUNTS);
    expect(tracker.getRawCounts()).toEqual(ZERO_QUALITY_PROXY_COUNTS);
  });
});

describe('QualityProxyTracker.getRawCounts', () => {
  it('returns all-zero counts for a new tracker', () => {
    const tracker = new QualityProxyTracker();
    expect(tracker.getRawCounts()).toEqual(ZERO_QUALITY_PROXY_COUNTS);
  });

  it('returns raw counts matching what recordToolCall derived, with no rates', () => {
    const tracker = new QualityProxyTracker();
    tracker.recordToolCall(makeRecord({ toolName: 'Edit', filePath: '/a.ts', success: true }));
    tracker.recordToolCall(makeRecord({ toolName: 'Edit', filePath: '/b.ts', success: false }));
    tracker.recordToolCall(makeRecord({ toolName: 'Bash', isTestCommand: true, success: true }));

    expect(tracker.getRawCounts()).toEqual({
      totalSignals: 3,
      diffApplyCleanCount: 1,
      diffFailCount: 1,
      testPassCount: 1,
      testFailCount: 0,
      backtrackCount: 0,
      selfCorrectionCount: 0,
    });
  });

  it('is consistent with getMetrics(): totalSignals and backtrack/self-correction counts always match', () => {
    const tracker = new QualityProxyTracker();
    tracker.recordToolCall(makeRecord({ toolName: 'Edit', filePath: '/a.ts', success: false }));
    tracker.recordToolCall(makeRecord({ toolName: 'Read', filePath: '/a.ts', success: true }));
    tracker.recordToolCall(makeRecord({ toolName: 'Bash', isTestCommand: true, success: true }));

    const raw = tracker.getRawCounts();
    const metrics = tracker.getMetrics();
    expect(raw.totalSignals).toBe(metrics.totalSignals);
    expect(raw.backtrackCount).toBe(metrics.backtrackCount);
    expect(raw.selfCorrectionCount).toBe(metrics.selfCorrectionCount);
  });
});

describe('combineQualityProxyRawCounts', () => {
  it('returns all-zero rates for an empty array', () => {
    expect(combineQualityProxyRawCounts([])).toEqual({
      totalSignals: 0,
      diffApplyRate: null,
      testPassRate: null,
      backtrackCount: 0,
      selfCorrectionCount: 0,
    });
  });

  it('sums raw counts across sources before deriving rates, rather than averaging per-source rates', () => {
    // Source A alone: 1/10 diffs applied = 10% apply rate.
    const sourceA: QualityProxyRawCountsLike = {
      totalSignals: 10,
      diffApplyCleanCount: 1,
      diffFailCount: 9,
      testPassCount: 0,
      testFailCount: 0,
      backtrackCount: 0,
      selfCorrectionCount: 0,
    };
    // Source B alone: 9/10 diffs applied = 90% apply rate.
    const sourceB: QualityProxyRawCountsLike = {
      totalSignals: 10,
      diffApplyCleanCount: 9,
      diffFailCount: 1,
      testPassCount: 0,
      testFailCount: 0,
      backtrackCount: 0,
      selfCorrectionCount: 0,
    };
    const combined = combineQualityProxyRawCounts([sourceA, sourceB]);
    // Correct: sum first (10/20 = 50% apply rate). A naive average of the two
    // per-source rates (10% and 90%) would also give 50% here by coincidence —
    // use unequal-volume sources instead, checked in the next test.
    expect(combined.totalSignals).toBe(20);
    expect(combined.diffApplyRate).toBeCloseTo(0.5);
  });

  it('never misweights unequal-volume sources by averaging their rates', () => {
    // Source A: 1/1 diffs applied = 100% apply rate, tiny volume.
    const sourceA: QualityProxyRawCountsLike = {
      totalSignals: 1,
      diffApplyCleanCount: 1,
      diffFailCount: 0,
      testPassCount: 0,
      testFailCount: 0,
      backtrackCount: 0,
      selfCorrectionCount: 0,
    };
    // Source B: 1/99 diffs applied ≈ 1% apply rate, huge volume.
    const sourceB: QualityProxyRawCountsLike = {
      totalSignals: 100,
      diffApplyCleanCount: 1,
      diffFailCount: 99,
      testPassCount: 0,
      testFailCount: 0,
      backtrackCount: 0,
      selfCorrectionCount: 0,
    };
    const combined = combineQualityProxyRawCounts([sourceA, sourceB]);
    // Correct: sum first (2 applied / 100 total = 2%). A naive average of 100%
    // and ~1% would give ~50.5%, which is wrong — it ignores that source B
    // contributed 100x the volume of source A.
    expect(combined.diffApplyRate).toBeCloseTo(0.02);
  });

  it('sums backtrackCount/selfCorrectionCount directly (not rate-shaped)', () => {
    const a: QualityProxyRawCountsLike = { ...ZERO_QUALITY_PROXY_COUNTS, backtrackCount: 2 };
    const b: QualityProxyRawCountsLike = { ...ZERO_QUALITY_PROXY_COUNTS, selfCorrectionCount: 3 };
    const combined = combineQualityProxyRawCounts([a, b]);
    expect(combined.backtrackCount).toBe(2);
    expect(combined.selfCorrectionCount).toBe(3);
  });

  it('returns null rates when the relevant denominator is zero across all sources', () => {
    const a: QualityProxyRawCountsLike = { ...ZERO_QUALITY_PROXY_COUNTS, testPassCount: 0 };
    const combined = combineQualityProxyRawCounts([a]);
    expect(combined.diffApplyRate).toBeNull();
    expect(combined.testPassRate).toBeNull();
  });

  it('is consistent with a single source: combining one tracker own raw counts matches its own derived rates', () => {
    const tracker = new QualityProxyTracker();
    tracker.recordToolCall(makeRecord({ toolName: 'Edit', filePath: '/a.ts', success: true }));
    tracker.recordToolCall(makeRecord({ toolName: 'Bash', isTestCommand: true, success: false }));
    const combined = combineQualityProxyRawCounts([tracker.getRawCounts()]);
    const metrics = tracker.getMetrics();
    expect(combined.totalSignals).toBe(metrics.totalSignals);
    expect(combined.diffApplyRate).toBe(metrics.diffApplyRate);
    expect(combined.testPassRate).toBe(metrics.testPassRate);
  });
});
