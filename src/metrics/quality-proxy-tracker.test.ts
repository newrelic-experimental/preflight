import { QualityProxyTracker } from './quality-proxy-tracker.js';
import type { ToolCallRecord } from '../storage/types.js';

const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
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

beforeEach(() => { idCounter = 0; });

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

  it('detects backtracking (Read after Edit of same file)', () => {
    const tracker = new QualityProxyTracker();
    tracker.recordToolCall(makeRecord({ toolName: 'Edit', filePath: '/a.ts', success: true }));
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
      tracker.recordToolCall(makeRecord({ toolName: 'Edit', filePath: `/f${i}.ts`, success: true }));
    }
    // Next 5 turns: all bad
    for (let i = 0; i < 5; i++) {
      tracker.recordToolCall(makeRecord({ toolName: 'Edit', filePath: `/g${i}.ts`, success: false }));
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
      tracker.recordToolCall(makeRecord({ toolName: 'Edit', filePath: `/good${i}.ts`, success: true }));
    }
    for (let i = 0; i < 9; i++) {
      tracker.recordToolCall(makeRecord({ toolName: 'Edit', filePath: `/bad${i}.ts`, success: false }));
    }

    const metrics = tracker.getMetrics();
    expect(metrics.degradationDetected).toBe(true);
  });

  it('does not detect degradation for consistent sessions', () => {
    const tracker = new QualityProxyTracker({ bucketSize: 3, degradationThreshold: 0.3 });

    // All good across all buckets
    for (let i = 0; i < 15; i++) {
      tracker.recordToolCall(makeRecord({ toolName: 'Edit', filePath: `/f${i}.ts`, success: true }));
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
    expect(aggregator.record).toHaveBeenCalledWith('ai.quality.diff_apply_rate', expect.any(Number));
    expect(aggregator.record).toHaveBeenCalledWith('ai.quality.test_pass_rate', expect.any(Number));
    expect(aggregator.record).toHaveBeenCalledWith('ai.quality.backtrack_count', expect.any(Number));
    expect(aggregator.record).toHaveBeenCalledWith('ai.quality.self_correction_count', expect.any(Number));
  });

  it('emitMetrics skips null rates when no data', () => {
    const aggregator = { record: jest.fn() };
    const tracker = new QualityProxyTracker();
    tracker.emitMetrics(aggregator as never);
    expect(aggregator.record).not.toHaveBeenCalledWith('ai.quality.diff_apply_rate', expect.anything());
    expect(aggregator.record).not.toHaveBeenCalledWith('ai.quality.test_pass_rate', expect.anything());
  });
});
