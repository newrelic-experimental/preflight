import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { EfficiencyScorer } from './efficiency-score.js';
import type { AiCodingTask } from './task-detector.js';
import type { AntiPattern } from './anti-patterns.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides?: Partial<AiCodingTask>): AiCodingTask {
  return {
    taskId: 'task-001',
    startTime: 1000,
    endTime: 61000,
    durationMs: 60000, // 60 seconds
    toolCallCount: 10,
    toolCallsByType: {},
    filesRead: [],
    filesModified: [],
    linesChanged: 50,
    linesAdded: 50,
    linesRemoved: 0,
    bashCommandsRun: 2,
    testsRun: 4,
    testsPassed: 4,
    buildRun: 1,
    buildPassed: 1,
    estimatedCostUsd: 0.50,
    tokensUsed: 5000,
    askedUserQuestions: 0,
    subAgentsSpawned: 0,
    toolCalls: [],
    ...overrides,
  };
}

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Perfect task
// ---------------------------------------------------------------------------

describe('Perfect task', () => {
  it('scores near 1.0 for a fast, correct, autonomous task with no thrashing', () => {
    const scorer = new EfficiencyScorer();

    // 50 lines in 60s = 0.833 lines/sec → speed = 0.833
    // 4/4 tests pass → correctness = 1.0
    // 0 user questions → autonomy = 1.0
    // no anti-patterns → firstAttemptQuality = 1.0
    const result = scorer.computeScore(makeTask());

    expect(result.score).toBeGreaterThan(0.9);
    expect(result.components.correctness).toBe(1);
    expect(result.components.autonomy).toBe(1);
    expect(result.components.firstAttemptQuality).toBe(1);
    expect(result.taskId).toBe('task-001');
  });
});

// ---------------------------------------------------------------------------
// Poor task
// ---------------------------------------------------------------------------

describe('Poor task', () => {
  it('scores near 0.0 for a slow, failing, non-autonomous task with thrashing', () => {
    const scorer = new EfficiencyScorer();

    const task = makeTask({
      linesChanged: 2,
      durationMs: 300_000, // 5 minutes → 2/300 = 0.0067 lines/sec
      testsRun: 5,
      testsPassed: 0,
      toolCallCount: 10,
      askedUserQuestions: 8,
    });

    const antiPatterns: AntiPattern[] = [{
      type: 'thrashing',
      file: '/a.ts',
      iterations: 5,
      suggestion: 'Consider reading the test output more carefully',
    }];

    const result = scorer.computeScore(task, antiPatterns);

    expect(result.score).toBeLessThan(0.15);
    expect(result.components.speed).toBeLessThan(0.01);
    expect(result.components.correctness).toBe(0);
    expect(result.components.autonomy).toBeLessThan(0.25);
    expect(result.components.firstAttemptQuality).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// No tests run
// ---------------------------------------------------------------------------

describe('No tests run', () => {
  it('defaults correctness to 0.5', () => {
    const scorer = new EfficiencyScorer();

    const task = makeTask({ testsRun: 0, testsPassed: 0 });
    const result = scorer.computeScore(task);

    expect(result.components.correctness).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// No user questions
// ---------------------------------------------------------------------------

describe('No user questions', () => {
  it('gives autonomy score of 1.0', () => {
    const scorer = new EfficiencyScorer();

    const task = makeTask({ askedUserQuestions: 0, toolCallCount: 20 });
    const result = scorer.computeScore(task);

    expect(result.components.autonomy).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Thrash iterations
// ---------------------------------------------------------------------------

describe('Thrash iterations', () => {
  it('3 thrash iterations → first-attempt quality = 0.0', () => {
    const scorer = new EfficiencyScorer();

    const antiPatterns: AntiPattern[] = [{
      type: 'thrashing',
      file: '/a.ts',
      iterations: 3,
      suggestion: '',
    }];

    const result = scorer.computeScore(makeTask(), antiPatterns);

    expect(result.components.firstAttemptQuality).toBe(0);
  });

  it('1 thrash iteration → first-attempt quality = 0.667', () => {
    const scorer = new EfficiencyScorer();

    const antiPatterns: AntiPattern[] = [{
      type: 'thrashing',
      file: '/a.ts',
      iterations: 1,
      suggestion: '',
    }];

    const result = scorer.computeScore(makeTask(), antiPatterns);

    expect(result.components.firstAttemptQuality).toBeCloseTo(0.667, 2);
  });

  it('uses the worst thrashing pattern when multiple files thrash', () => {
    const scorer = new EfficiencyScorer();

    const antiPatterns: AntiPattern[] = [
      { type: 'thrashing', file: '/a.ts', iterations: 1, suggestion: '' },
      { type: 'thrashing', file: '/b.ts', iterations: 4, suggestion: '' },
      { type: 'thrashing', file: '/c.ts', iterations: 2, suggestion: '' },
    ];

    const result = scorer.computeScore(makeTask(), antiPatterns);

    // 1 - 4/3 = negative → clamped to 0
    expect(result.components.firstAttemptQuality).toBe(0);
  });

  it('non-thrashing anti-patterns do not affect first-attempt quality', () => {
    const scorer = new EfficiencyScorer();

    const antiPatterns: AntiPattern[] = [
      { type: 're_reading', file: '/a.ts', readCount: 10, suggestion: '' },
      { type: 'stuck_loop', command: 'npm test', repeatCount: 5, suggestion: '' },
    ];

    const result = scorer.computeScore(makeTask(), antiPatterns);

    expect(result.components.firstAttemptQuality).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Speed normalization
// ---------------------------------------------------------------------------

describe('Speed normalization', () => {
  it('50 lines in 60 seconds → speed ≈ 0.833', () => {
    const scorer = new EfficiencyScorer();

    const task = makeTask({ linesChanged: 50, durationMs: 60_000 });
    const result = scorer.computeScore(task);

    // 50/60 = 0.833 lines/sec
    expect(result.components.speed).toBeCloseTo(0.833, 2);
  });

  it('5 lines in 60 seconds → speed ≈ 0.083', () => {
    const scorer = new EfficiencyScorer();

    const task = makeTask({ linesChanged: 5, durationMs: 60_000 });
    const result = scorer.computeScore(task);

    // 5/60 = 0.083 lines/sec
    expect(result.components.speed).toBeCloseTo(0.083, 2);
  });

  it('100 lines in 60 seconds → clamped at 1.0', () => {
    const scorer = new EfficiencyScorer();

    const task = makeTask({ linesChanged: 100, durationMs: 60_000 });
    const result = scorer.computeScore(task);

    // 100/60 = 1.667 lines/sec → clamped to 1.0
    expect(result.components.speed).toBe(1);
  });

  it('0 lines → speed = 0', () => {
    const scorer = new EfficiencyScorer();

    const task = makeTask({ linesChanged: 0 });
    const result = scorer.computeScore(task);

    expect(result.components.speed).toBe(0);
  });

  it('0 duration → speed = 1.0', () => {
    const scorer = new EfficiencyScorer();

    const task = makeTask({ linesChanged: 10, durationMs: 0 });
    const result = scorer.computeScore(task);

    expect(result.components.speed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Score clamping
// ---------------------------------------------------------------------------

describe('Score clamping', () => {
  it('score is clamped to [0, 1] even with extreme values', () => {
    const scorer = new EfficiencyScorer();

    // Extreme fast: 1000 lines in 1 second
    const task = makeTask({
      linesChanged: 1000,
      durationMs: 1000,
      testsRun: 100,
      testsPassed: 100,
      askedUserQuestions: 0,
    });

    const result = scorer.computeScore(task);

    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  it('all-zero task does not produce NaN or negative', () => {
    const scorer = new EfficiencyScorer();

    const task = makeTask({
      linesChanged: 0,
      durationMs: 0,
      testsRun: 0,
      testsPassed: 0,
      toolCallCount: 0,
      askedUserQuestions: 0,
    });

    const result = scorer.computeScore(task);

    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
    expect(Number.isNaN(result.score)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Session-wide rolling average
// ---------------------------------------------------------------------------

describe('Session-wide rolling average', () => {
  it('computes average across 5 tasks', () => {
    const scorer = new EfficiencyScorer();

    // Score 5 tasks with varying quality
    const tasks: AiCodingTask[] = [
      makeTask({ taskId: 't1', linesChanged: 60, durationMs: 60_000 }), // speed=1.0
      makeTask({ taskId: 't2', linesChanged: 30, durationMs: 60_000 }), // speed=0.5
      makeTask({ taskId: 't3', linesChanged: 12, durationMs: 60_000 }), // speed=0.2
      makeTask({ taskId: 't4', linesChanged: 45, durationMs: 60_000 }), // speed=0.75
      makeTask({ taskId: 't5', linesChanged: 6, durationMs: 60_000 }),  // speed=0.1
    ];

    for (const task of tasks) {
      scorer.computeScore(task);
    }

    const avg = scorer.getSessionAverage();
    expect(avg).not.toBeNull();
    expect(avg!.taskId).toBe('session-average');
    expect(avg!.score).toBeGreaterThan(0);
    expect(avg!.score).toBeLessThanOrEqual(1);

    // Average speed should be (1.0 + 0.5 + 0.2 + 0.75 + 0.1) / 5 = 0.51
    expect(avg!.components.speed).toBeCloseTo(0.51, 1);
  });

  it('returns null when no tasks have been scored', () => {
    const scorer = new EfficiencyScorer();

    expect(scorer.getSessionAverage()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// emitMetrics
// ---------------------------------------------------------------------------

describe('emitMetrics()', () => {
  it('records score and component gauges for each scored task', () => {
    const scorer = new EfficiencyScorer();

    scorer.computeScore(makeTask({ taskId: 't1' }));
    scorer.computeScore(makeTask({ taskId: 't2' }));

    const recorded: Array<{ name: string; value: number }> = [];
    const aggregator = {
      record(name: string, value: number) {
        recorded.push({ name, value });
      },
    } as unknown as import('@nr-ai-observatory/shared').MetricAggregator;

    scorer.emitMetrics(aggregator);

    // 2 tasks × 5 metrics each = 10
    expect(recorded).toHaveLength(10);

    const names = new Set(recorded.map(r => r.name));
    expect(names).toContain('ai.efficiency.score');
    expect(names).toContain('ai.efficiency.speed');
    expect(names).toContain('ai.efficiency.correctness');
    expect(names).toContain('ai.efficiency.autonomy');
    expect(names).toContain('ai.efficiency.first_attempt_quality');
  });
});

// ---------------------------------------------------------------------------
// Configurable weights
// ---------------------------------------------------------------------------

describe('Configurable weights', () => {
  it('heavier correctness weight shifts score toward correctness', () => {
    // All weight on correctness
    const scorer = new EfficiencyScorer({
      speedWeight: 0,
      correctnessWeight: 1,
      autonomyWeight: 0,
      firstAttemptQualityWeight: 0,
    });

    const task = makeTask({ testsRun: 4, testsPassed: 4 });
    const result = scorer.computeScore(task);

    expect(result.score).toBe(1);
  });

  it('custom speed baseline changes speed calculation', () => {
    // Baseline: 0.5 lines/sec = perfect speed
    const scorer = new EfficiencyScorer({
      speedBaselineLinesPerSecond: 0.5,
    });

    // 30 lines / 60s = 0.5 lps → exactly at baseline → speed = 1.0
    const task = makeTask({ linesChanged: 30, durationMs: 60_000 });
    const result = scorer.computeScore(task);

    expect(result.components.speed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// getScores / reset
// ---------------------------------------------------------------------------

describe('getScores() and reset()', () => {
  it('getScores returns all scored tasks', () => {
    const scorer = new EfficiencyScorer();

    scorer.computeScore(makeTask({ taskId: 't1' }));
    scorer.computeScore(makeTask({ taskId: 't2' }));
    scorer.computeScore(makeTask({ taskId: 't3' }));

    const scores = scorer.getScores();
    expect(scores).toHaveLength(3);
    expect(scores.map(s => s.taskId)).toEqual(['t1', 't2', 't3']);
  });

  it('reset clears all scores', () => {
    const scorer = new EfficiencyScorer();

    scorer.computeScore(makeTask());
    expect(scorer.getScores()).toHaveLength(1);

    scorer.reset();
    expect(scorer.getScores()).toHaveLength(0);
    expect(scorer.getSessionAverage()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// updateScore
// ---------------------------------------------------------------------------

describe('updateScore()', () => {
  it('replaces an existing score entry instead of duplicating it', () => {
    const scorer = new EfficiencyScorer();

    const task = makeTask({ taskId: 'active-1', linesChanged: 10, durationMs: 60_000 });
    scorer.computeScore(task);
    expect(scorer.getScores()).toHaveLength(1);

    const updated = { ...task, linesChanged: 50, durationMs: 60_000 };
    scorer.updateScore(updated);
    expect(scorer.getScores()).toHaveLength(1);
    expect(scorer.getScores()[0].components.speed).toBeCloseTo(0.833, 2);
  });

  it('appends a new entry when the taskId has not been scored before', () => {
    const scorer = new EfficiencyScorer();

    scorer.computeScore(makeTask({ taskId: 't1' }));
    scorer.updateScore(makeTask({ taskId: 't2' }));

    expect(scorer.getScores()).toHaveLength(2);
    expect(scorer.getScores().map(s => s.taskId)).toEqual(['t1', 't2']);
  });

  it('computeScore replaces an existing preview entry from updateScore, not duplicates it', () => {
    const scorer = new EfficiencyScorer();

    // updateScore previews the task while it is still active
    scorer.updateScore(makeTask({ taskId: 'active-1', linesChanged: 10 }));
    expect(scorer.getScores()).toHaveLength(1);

    // computeScore is called when the task completes — should replace, not append
    scorer.computeScore(makeTask({ taskId: 'active-1', linesChanged: 50 }));
    expect(scorer.getScores()).toHaveLength(1);

    // The final score reflects the computeScore values, not the preview
    expect(scorer.getScores()[0].components.speed).toBeCloseTo(0.833, 2);
  });

  it('getSessionAverage does not double-weight a task previewed via updateScore', () => {
    const scorer = new EfficiencyScorer();

    scorer.updateScore(makeTask({ taskId: 't1', linesChanged: 60, durationMs: 60_000 })); // speed=1.0
    scorer.computeScore(makeTask({ taskId: 't1', linesChanged: 60, durationMs: 60_000 })); // same task finalised
    scorer.computeScore(makeTask({ taskId: 't2', linesChanged: 0, durationMs: 60_000 })); // speed=0.0

    // Only 2 tasks, so average speed = (1.0 + 0.0) / 2 = 0.5
    const avg = scorer.getSessionAverage();
    expect(avg).not.toBeNull();
    expect(avg!.components.speed).toBeCloseTo(0.5, 2);
  });
});

// ---------------------------------------------------------------------------
// Autonomy edge cases
// ---------------------------------------------------------------------------

describe('Autonomy edge cases', () => {
  it('many user questions reduces autonomy', () => {
    const scorer = new EfficiencyScorer();

    const task = makeTask({ askedUserQuestions: 5, toolCallCount: 10 });
    const result = scorer.computeScore(task);

    // 1 - 5/10 = 0.5
    expect(result.components.autonomy).toBe(0.5);
  });

  it('0 tool calls → autonomy = 1.0 (no work to judge)', () => {
    const scorer = new EfficiencyScorer();

    const task = makeTask({ askedUserQuestions: 0, toolCallCount: 0 });
    const result = scorer.computeScore(task);

    expect(result.components.autonomy).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// scores cap / appendScore
// ---------------------------------------------------------------------------

describe('scores cap (MAX_SCORES = 1000)', () => {
  it('never holds more than 1000 scores', () => {
    const scorer = new EfficiencyScorer();

    for (let i = 0; i < 1005; i++) {
      scorer.computeScore(makeTask({ taskId: `t${i}` }));
    }

    expect(scorer.getScores()).toHaveLength(1000);
  });

  it('drops oldest scores when cap is exceeded', () => {
    const scorer = new EfficiencyScorer();

    for (let i = 0; i < 1002; i++) {
      scorer.computeScore(makeTask({ taskId: `t${i}` }));
    }

    const scores = scorer.getScores();
    expect(scores[0].taskId).toBe('t2');
    expect(scores[999].taskId).toBe('t1001');
  });

  it('emitMetrics does not re-emit already-harvested scores', () => {
    const scorer = new EfficiencyScorer();

    scorer.computeScore(makeTask({ taskId: 't1' }));
    scorer.computeScore(makeTask({ taskId: 't2' }));

    const recorded1: string[] = [];
    const agg1 = { record(name: string) { recorded1.push(name); } } as unknown as import('@nr-ai-observatory/shared').MetricAggregator;
    scorer.emitMetrics(agg1);
    expect(recorded1).toHaveLength(10); // 2 tasks × 5 metrics

    scorer.computeScore(makeTask({ taskId: 't3' }));

    const recorded2: string[] = [];
    const agg2 = { record(name: string) { recorded2.push(name); } } as unknown as import('@nr-ai-observatory/shared').MetricAggregator;
    scorer.emitMetrics(agg2);
    expect(recorded2).toHaveLength(5); // only t3
  });

  it('reset clears lastEmittedIndex so subsequent emits work correctly', () => {
    const scorer = new EfficiencyScorer();

    scorer.computeScore(makeTask({ taskId: 't1' }));
    const agg1 = { record() {} } as unknown as import('@nr-ai-observatory/shared').MetricAggregator;
    scorer.emitMetrics(agg1);

    scorer.reset();

    scorer.computeScore(makeTask({ taskId: 't2' }));

    const recorded: string[] = [];
    const agg2 = { record(name: string) { recorded.push(name); } } as unknown as import('@nr-ai-observatory/shared').MetricAggregator;
    scorer.emitMetrics(agg2);
    expect(recorded).toHaveLength(5); // only t2, not t1 again
  });
});
