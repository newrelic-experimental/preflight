import { LatencyDecompositionTracker } from './latency-decomposition.js';
import type { TurnTimingReport } from './latency-decomposition.js';

const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
afterEach(() => stderrSpy.mockClear());

function makeReport(overrides: Partial<TurnTimingReport> = {}): TurnTimingReport {
  return {
    turnStartMs: 1000,
    turnEndMs: 5000,
    llmApiMs: 2500,
    toolExecutionMs: 1000,
    ...overrides,
  };
}

describe('LatencyDecompositionTracker', () => {
  it('records a turn and computes overhead', () => {
    const tracker = new LatencyDecompositionTracker();
    const turn = tracker.recordTurn(makeReport());

    expect(turn.wallClockMs).toBe(4000);
    expect(turn.llmApiMs).toBe(2500);
    expect(turn.toolExecutionMs).toBe(1000);
    expect(turn.overheadMs).toBe(500); // 4000 - 2500 - 1000
  });

  it('clamps overhead to zero when components exceed wall clock', () => {
    const tracker = new LatencyDecompositionTracker();
    const turn = tracker.recordTurn(makeReport({
      turnStartMs: 0,
      turnEndMs: 3000,
      llmApiMs: 2000,
      toolExecutionMs: 2000,
    }));

    expect(turn.overheadMs).toBe(0);
  });

  it('computes p50/p95 across multiple turns', () => {
    const tracker = new LatencyDecompositionTracker();

    for (let i = 0; i < 100; i++) {
      tracker.recordTurn(makeReport({
        turnStartMs: 0,
        turnEndMs: 1000 + i * 10,
        llmApiMs: 500 + i * 5,
        toolExecutionMs: 200 + i * 2,
      }));
    }

    const metrics = tracker.getMetrics();
    expect(metrics.llmApi).not.toBeNull();
    expect(metrics.llmApi!.p50).toBeGreaterThan(0);
    expect(metrics.llmApi!.p95).toBeGreaterThan(metrics.llmApi!.p50);
    expect(metrics.llmApi!.count).toBe(100);
  });

  it('returns null percentiles when no data', () => {
    const tracker = new LatencyDecompositionTracker();
    const metrics = tracker.getMetrics();

    expect(metrics.llmApi).toBeNull();
    expect(metrics.toolExecution).toBeNull();
    expect(metrics.overhead).toBeNull();
  });

  it('computes average composition as percentages', () => {
    const tracker = new LatencyDecompositionTracker();

    // All turns with same timing: 60% LLM, 30% tool, 10% overhead
    for (let i = 0; i < 10; i++) {
      tracker.recordTurn(makeReport({
        turnStartMs: 0,
        turnEndMs: 1000,
        llmApiMs: 600,
        toolExecutionMs: 300,
      }));
    }

    const metrics = tracker.getMetrics();
    expect(metrics.avgComposition).not.toBeNull();
    expect(metrics.avgComposition!.llm_api).toBe(60);
    expect(metrics.avgComposition!.tool_execution).toBe(30);
    expect(metrics.avgComposition!.overhead).toBe(10);
  });

  it('limits recent turns to configured count', () => {
    const tracker = new LatencyDecompositionTracker({ recentTurnCount: 5 });

    for (let i = 0; i < 10; i++) {
      tracker.recordTurn(makeReport());
    }

    const metrics = tracker.getMetrics();
    expect(metrics.recentTurns).toHaveLength(5);
    expect(metrics.recentTurns[0].turnNumber).toBe(6);
  });

  it('reset clears all state', () => {
    const tracker = new LatencyDecompositionTracker();
    tracker.recordTurn(makeReport());

    tracker.reset('new-session');
    const metrics = tracker.getMetrics();

    expect(metrics.turnCount).toBe(0);
    expect(metrics.llmApi).toBeNull();
    expect(metrics.recentTurns).toHaveLength(0);
    expect(metrics.avgComposition).toBeNull();
  });

  it('uses sliding window so percentiles stay current after maxHistorySize', () => {
    const tracker = new LatencyDecompositionTracker({ maxHistorySize: 10 });

    // Fill with low-latency turns
    for (let i = 0; i < 10; i++) {
      tracker.recordTurn(makeReport({
        turnStartMs: 0,
        turnEndMs: 100,
        llmApiMs: 50,
        toolExecutionMs: 30,
      }));
    }

    // Now push high-latency turns (should evict old ones)
    for (let i = 0; i < 10; i++) {
      tracker.recordTurn(makeReport({
        turnStartMs: 0,
        turnEndMs: 10000,
        llmApiMs: 8000,
        toolExecutionMs: 1000,
      }));
    }

    const metrics = tracker.getMetrics();
    // p50 should reflect the high-latency turns, not the old low ones
    expect(metrics.llmApi!.p50).toBeGreaterThan(5000);
    expect(metrics.llmApi!.count).toBe(10);
  });

  it('emitMetrics records expected metric names', () => {
    const aggregator = { record: jest.fn() };
    const tracker = new LatencyDecompositionTracker();
    tracker.recordTurn(makeReport());

    tracker.emitMetrics(aggregator as never);
    expect(aggregator.record).toHaveBeenCalledWith('ai.latency.llm_api.p50', expect.any(Number));
    expect(aggregator.record).toHaveBeenCalledWith('ai.latency.llm_api.p95', expect.any(Number));
    expect(aggregator.record).toHaveBeenCalledWith('ai.latency.tool_execution.p50', expect.any(Number));
    expect(aggregator.record).toHaveBeenCalledWith('ai.latency.overhead.p50', expect.any(Number));
  });
});
