import { ContextCompositionTracker } from './context-composition-tracker.js';
import type { TurnTokenReport, ContextThresholdAlert, CategoryDominanceAlert } from './context-composition-tracker.js';

const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
afterEach(() => stderrSpy.mockClear());

function makeReport(overrides: Partial<TurnTokenReport> = {}): TurnTokenReport {
  return {
    systemPromptTokens: 1000,
    conversationHistoryTokens: 2000,
    toolResultTokens: 3000,
    injectedFileContentTokens: 500,
    otherTokens: 500,
    totalTokens: 7000,
    ...overrides,
  };
}

describe('ContextCompositionTracker', () => {
  it('records turn composition and returns metrics', () => {
    const tracker = new ContextCompositionTracker({ modelContextWindow: 100_000 });
    tracker.recordTurn(makeReport());

    const metrics = tracker.getMetrics();
    expect(metrics.turnCount).toBe(1);
    expect(metrics.currentBreakdown.system_prompt).toBe(1000);
    expect(metrics.currentBreakdown.tool_results).toBe(3000);
    expect(metrics.currentFillPercent).toBe(7);
  });

  it('fires threshold alert at 50%', () => {
    const alerts: ContextThresholdAlert[] = [];
    const tracker = new ContextCompositionTracker({
      modelContextWindow: 10_000,
      onThresholdAlert: (a) => alerts.push(a),
    });

    tracker.recordTurn(makeReport({ totalTokens: 5000, toolResultTokens: 4000, systemPromptTokens: 500, conversationHistoryTokens: 300, injectedFileContentTokens: 100, otherTokens: 100 }));

    expect(alerts).toHaveLength(1);
    expect(alerts[0].threshold).toBe(50);
    expect(alerts[0].fillPercent).toBe(50);
  });

  it('fires multiple threshold alerts as fill increases', () => {
    const alerts: ContextThresholdAlert[] = [];
    const tracker = new ContextCompositionTracker({
      modelContextWindow: 10_000,
      onThresholdAlert: (a) => alerts.push(a),
    });

    tracker.recordTurn(makeReport({ totalTokens: 5000, toolResultTokens: 5000, systemPromptTokens: 0, conversationHistoryTokens: 0, injectedFileContentTokens: 0, otherTokens: 0 }));
    tracker.recordTurn(makeReport({ totalTokens: 7500, toolResultTokens: 7500, systemPromptTokens: 0, conversationHistoryTokens: 0, injectedFileContentTokens: 0, otherTokens: 0 }));
    tracker.recordTurn(makeReport({ totalTokens: 9500, toolResultTokens: 9500, systemPromptTokens: 0, conversationHistoryTokens: 0, injectedFileContentTokens: 0, otherTokens: 0 }));

    expect(alerts).toHaveLength(3);
    expect(alerts[0].threshold).toBe(50);
    expect(alerts[1].threshold).toBe(75);
    expect(alerts[2].threshold).toBe(90);
  });

  it('does not duplicate threshold alerts', () => {
    const alerts: ContextThresholdAlert[] = [];
    const tracker = new ContextCompositionTracker({
      modelContextWindow: 10_000,
      onThresholdAlert: (a) => alerts.push(a),
    });

    tracker.recordTurn(makeReport({ totalTokens: 6000, toolResultTokens: 6000, systemPromptTokens: 0, conversationHistoryTokens: 0, injectedFileContentTokens: 0, otherTokens: 0 }));
    tracker.recordTurn(makeReport({ totalTokens: 6500, toolResultTokens: 6500, systemPromptTokens: 0, conversationHistoryTokens: 0, injectedFileContentTokens: 0, otherTokens: 0 }));

    expect(alerts).toHaveLength(1);
  });

  it('fires dominance alert when single category exceeds 60%', () => {
    const alerts: CategoryDominanceAlert[] = [];
    const tracker = new ContextCompositionTracker({
      modelContextWindow: 100_000,
      onDominanceAlert: (a) => alerts.push(a),
    });

    tracker.recordTurn(makeReport({
      totalTokens: 10_000,
      toolResultTokens: 7000,
      systemPromptTokens: 1000,
      conversationHistoryTokens: 1000,
      injectedFileContentTokens: 500,
      otherTokens: 500,
    }));

    expect(alerts).toHaveLength(1);
    expect(alerts[0].category).toBe('tool_results');
    expect(alerts[0].percent).toBe(70);
  });

  it('does not fire dominance alert when no category exceeds threshold', () => {
    const alerts: CategoryDominanceAlert[] = [];
    const tracker = new ContextCompositionTracker({
      modelContextWindow: 100_000,
      onDominanceAlert: (a) => alerts.push(a),
    });

    tracker.recordTurn(makeReport({
      totalTokens: 10_000,
      toolResultTokens: 3000,
      systemPromptTokens: 2500,
      conversationHistoryTokens: 2500,
      injectedFileContentTokens: 1000,
      otherTokens: 1000,
    }));

    expect(alerts).toHaveLength(0);
  });

  it('tracks history and caps at maxHistorySize', () => {
    const tracker = new ContextCompositionTracker({
      modelContextWindow: 100_000,
      maxHistorySize: 3,
    });

    for (let i = 0; i < 5; i++) {
      tracker.recordTurn(makeReport({ totalTokens: 1000 * (i + 1) }));
    }

    const metrics = tracker.getMetrics();
    expect(metrics.history).toHaveLength(3);
    expect(metrics.history[0].turnNumber).toBe(3);
  });

  it('reset clears all state', () => {
    const tracker = new ContextCompositionTracker({ modelContextWindow: 10_000 });
    tracker.recordTurn(makeReport({ totalTokens: 6000, toolResultTokens: 6000, systemPromptTokens: 0, conversationHistoryTokens: 0, injectedFileContentTokens: 0, otherTokens: 0 }));

    tracker.reset('new-session');
    const metrics = tracker.getMetrics();

    expect(metrics.turnCount).toBe(0);
    expect(metrics.currentFillPercent).toBe(0);
    expect(metrics.thresholdAlerts).toHaveLength(0);
    expect(metrics.dominanceAlerts).toHaveLength(0);
    expect(metrics.history).toHaveLength(0);
  });

  it('emitMetrics records expected metrics', () => {
    const aggregator = { record: jest.fn() };
    const tracker = new ContextCompositionTracker();
    tracker.recordTurn({
      systemPromptTokens: 1000,
      conversationHistoryTokens: 2000,
      toolResultTokens: 500,
      injectedFileContentTokens: 300,
      otherTokens: 200,
      totalTokens: 4000,
    });

    tracker.emitMetrics(aggregator as never);
    expect(aggregator.record).toHaveBeenCalledWith('ai.context.fill_percent', expect.any(Number));
    expect(aggregator.record).toHaveBeenCalledWith('ai.context.total_tokens', 4000);
    expect(aggregator.record).toHaveBeenCalledWith('ai.context.category_tokens', 1000, { category: 'system_prompt' });
  });

  it('emitMetrics handles zero modelContextWindow without NaN', () => {
    const aggregator = { record: jest.fn() };
    const tracker = new ContextCompositionTracker({ modelContextWindow: 0 });
    tracker.recordTurn({
      systemPromptTokens: 100,
      conversationHistoryTokens: 200,
      toolResultTokens: 50,
      injectedFileContentTokens: 30,
      otherTokens: 20,
      totalTokens: 400,
    });

    tracker.emitMetrics(aggregator as never);
    expect(aggregator.record).toHaveBeenCalledWith('ai.context.fill_percent', 0);
  });
});
