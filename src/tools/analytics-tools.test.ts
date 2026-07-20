import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ContextWindowTracker } from '../metrics/context-window-tracker.js';
import { ContextTrackerRegistry } from '../metrics/context-tracker.js';
import { LatencyTracker } from '../metrics/latency-tracker.js';
import { TaskCompletionTracker } from '../metrics/task-completion-tracker.js';
import { ModelUsageTracker } from '../metrics/model-usage-tracker.js';
import type { ToolCallRecord } from '../storage/types.js';
import type { AiCodingTask } from '../metrics/task-detector.js';
import {
  handleGetContextEfficiency,
  handleGetLatencyPercentiles,
  handleGetTaskCompletionRate,
  handleGetModelUsage,
  handleGetContextTracking,
  registerAnalyticsTools,
} from './analytics-tools.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

function makeRecord(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: 'r1',
    sessionId: 's1',
    toolUseId: 'u1',
    toolName: 'Read',
    timestamp: Date.now(),
    durationMs: 10,
    success: true,
    filePath: '/src/app.ts',
    ...overrides,
  } as ToolCallRecord;
}

function makeTask(overrides?: Partial<AiCodingTask>): AiCodingTask {
  return {
    taskId: 'task-001',
    startTime: 1000,
    endTime: 61000,
    durationMs: 60000,
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
    estimatedCostUsd: 0.5,
    tokensUsed: 5000,
    askedUserQuestions: 0,
    ...overrides,
  } as AiCodingTask;
}

describe('analytics-tools handlers', () => {
  it('handleGetContextEfficiency returns the tracker metrics verbatim', () => {
    const tracker = new ContextWindowTracker();
    tracker.recordToolCall(makeRecord({ filePath: '/a.ts' }));
    tracker.recordToolCall(makeRecord({ filePath: '/a.ts' }));
    tracker.recordToolCall(makeRecord({ filePath: '/b.ts' }));

    const result = handleGetContextEfficiency(tracker);
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toEqual(tracker.getMetrics());
    expect(parsed.repeatedReadCount).toBe(1);
  });

  it('handleGetLatencyPercentiles returns the tracker metrics verbatim', () => {
    const tracker = new LatencyTracker();
    tracker.recordToolCall(makeRecord({ toolName: 'Bash', durationMs: 100 }));
    tracker.recordToolCall(makeRecord({ toolName: 'Bash', durationMs: 200 }));

    const result = handleGetLatencyPercentiles(tracker);
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toEqual(tracker.getMetrics());
    expect(parsed.overall.count).toBe(2);
  });

  it('handleGetTaskCompletionRate returns the tracker metrics verbatim, ignoring the unused TaskDetector param', () => {
    const tracker = new TaskCompletionTracker();
    tracker.recordTask(makeTask());
    tracker.recordTask(makeTask({ taskId: 'task-002', durationMs: 30000, toolCallCount: 6 }));

    const withoutDetector = handleGetTaskCompletionRate(tracker);
    const withDetector = handleGetTaskCompletionRate(tracker, undefined);

    const parsed = JSON.parse(withoutDetector.content[0].text);
    expect(parsed).toEqual(tracker.getMetrics());
    expect(parsed.completedTasks).toBe(2);
    // Passing (or omitting) the second arg must not change the result.
    expect(JSON.parse(withDetector.content[0].text)).toEqual(parsed);
  });

  it('handleGetModelUsage returns the tracker metrics verbatim', () => {
    const tracker = new ModelUsageTracker();
    tracker.recordUsage('claude-sonnet-4', 1000, 200, 0.06);

    const result = handleGetModelUsage(tracker);
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toEqual(tracker.getMetrics());
    expect(parsed.mostUsedModel).toBe('claude-sonnet-4');
  });

  it('handleGetContextTracking returns the registry metrics verbatim', () => {
    const registry = new ContextTrackerRegistry();
    registry.recordTurn({
      mode: 'token',
      sessionId: 's1',
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      model: 'claude-sonnet-4',
      timestamp: Date.now(),
    });

    const result = handleGetContextTracking(registry);
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toEqual(registry.getMetrics());
    expect(parsed.turnCount).toBe(1);
  });
});

describe('registerAnalyticsTools()', () => {
  it('lists no tools and returns explanatory errors when no deps are provided', async () => {
    const { tools, handlers } = registerAnalyticsTools({});
    expect(tools).toEqual([]);
    expect(Object.keys(handlers).sort()).toEqual([
      'nr_observe_get_context_efficiency',
      'nr_observe_get_context_tracking',
      'nr_observe_get_latency_percentiles',
      'nr_observe_get_model_usage',
      'nr_observe_get_task_completion_rate',
    ]);
    const result = await handlers.nr_observe_get_model_usage!(undefined);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      error: 'ModelUsageTracker not available',
    });
  });

  it('lists every tool once its backing tracker is present', () => {
    const { tools } = registerAnalyticsTools({
      contextWindowTracker: new ContextWindowTracker(),
      contextTracker: new ContextTrackerRegistry(),
      latencyTracker: new LatencyTracker(),
      taskCompletionTracker: new TaskCompletionTracker(),
      modelUsageTracker: new ModelUsageTracker(),
    });
    expect(tools.map((t: { name: string }) => t.name).sort()).toEqual([
      'nr_observe_get_context_efficiency',
      'nr_observe_get_context_tracking',
      'nr_observe_get_latency_percentiles',
      'nr_observe_get_model_usage',
      'nr_observe_get_task_completion_rate',
    ]);
  });
});
