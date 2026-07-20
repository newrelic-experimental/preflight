import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { TaskCompletionTracker } from './task-completion-tracker.js';
import type { AiCodingTask } from './task-detector.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

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
    subAgentsSpawned: 0,
    toolCalls: [],
    ...overrides,
  };
}

describe('TaskCompletionTracker', () => {
  it('returns zero completedTasks and null avgs for empty tracker', () => {
    const t = new TaskCompletionTracker();
    const m = t.getMetrics();
    expect(m.completedTasks).toBe(0);
    expect(m.avgTaskDurationMs).toBeNull();
    expect(m.avgToolCallsPerTask).toBeNull();
  });

  it('counts completed tasks correctly', () => {
    const t = new TaskCompletionTracker();
    t.recordTask(makeTask());
    t.recordTask(makeTask({ taskId: 'task-002' }));
    expect(t.getMetrics().completedTasks).toBe(2);
  });

  it('avgTaskDurationMs is the mean of completed task durations', () => {
    const t = new TaskCompletionTracker();
    t.recordTask(makeTask({ durationMs: 10000 }));
    t.recordTask(makeTask({ durationMs: 20000 }));
    expect(t.getMetrics().avgTaskDurationMs).toBe(15000);
  });

  it('avgToolCallsPerTask uses toolCallCount', () => {
    const t = new TaskCompletionTracker();
    t.recordTask(makeTask({ toolCallCount: 4 }));
    t.recordTask(makeTask({ toolCallCount: 6 }));
    expect(t.getMetrics().avgToolCallsPerTask).toBe(5);
  });

  it('reset clears all state', () => {
    const t = new TaskCompletionTracker();
    t.recordTask(makeTask());
    t.reset('test-session');
    const m = t.getMetrics();
    expect(m.completedTasks).toBe(0);
    expect(m.avgTaskDurationMs).toBeNull();
    expect(m.avgToolCallsPerTask).toBeNull();
  });
});
