import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { TaskDetector } from './task-detector.js';
import { CostTracker } from './cost-tracker.js';
import type { ToolCallRecord } from '../storage/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(overrides?: Partial<ToolCallRecord>): ToolCallRecord {
  return {
    id: 'rec-001',
    sessionId: 'sess-001',
    toolName: 'Read',
    toolUseId: 'toolu_001',
    timestamp: Date.now(),
    durationMs: 50,
    success: true,
    ...overrides,
  };
}

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  jest.useFakeTimers();
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  jest.useRealTimers();
  stderrSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Idle-based task detection
// ---------------------------------------------------------------------------

describe('Idle-based task detection', () => {
  it('5 tool calls within 10s, then 45s idle -> 1 task with 5 calls', () => {
    const detector = new TaskDetector();

    for (let i = 0; i < 5; i++) {
      jest.advanceTimersByTime(2000);
      detector.recordToolCall(makeRecord({ toolName: `Tool${i}` }));
    }

    expect(detector.getCompletedTasks()).toHaveLength(0);
    expect(detector.getCurrentTask()).not.toBeNull();

    jest.advanceTimersByTime(45_000);

    const tasks = detector.getCompletedTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].toolCallCount).toBe(5);

    detector.dispose();
  });

  it('single call + idle -> 1 task with 1 call', () => {
    const detector = new TaskDetector();

    detector.recordToolCall(makeRecord({ toolName: 'Read' }));

    jest.advanceTimersByTime(30_000);

    const tasks = detector.getCompletedTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].toolCallCount).toBe(1);
    expect(tasks[0].toolCallsByType).toEqual({ Read: 1 });

    detector.dispose();
  });

  it('rapid continuous calls -> single long task', () => {
    const detector = new TaskDetector();

    // 20 calls, each 1s apart — each resets the 30s idle timer
    for (let i = 0; i < 20; i++) {
      jest.advanceTimersByTime(1000);
      detector.recordToolCall(makeRecord({ toolName: 'Read' }));
    }

    // Trigger idle timeout
    jest.advanceTimersByTime(30_000);

    const tasks = detector.getCompletedTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].toolCallCount).toBe(20);

    detector.dispose();
  });

  it('configurable idleTimeoutMs', () => {
    const detector = new TaskDetector({ idleTimeoutMs: 10_000 });

    detector.recordToolCall(makeRecord({ toolName: 'Read' }));

    // 15s idle — should trigger with 10s timeout
    jest.advanceTimersByTime(15_000);

    expect(detector.getCompletedTasks()).toHaveLength(1);

    detector.dispose();
  });
});

// ---------------------------------------------------------------------------
// Boundary signals
// ---------------------------------------------------------------------------

describe('Boundary signals', () => {
  it('AskUserQuestion splits into 2 tasks', () => {
    const detector = new TaskDetector();

    // First task: 3 Read calls + AskUserQuestion
    detector.recordToolCall(makeRecord({ toolName: 'Read' }));
    jest.advanceTimersByTime(1000);
    detector.recordToolCall(makeRecord({ toolName: 'Read' }));
    jest.advanceTimersByTime(1000);
    detector.recordToolCall(makeRecord({ toolName: 'Read' }));
    jest.advanceTimersByTime(1000);
    detector.recordToolCall(makeRecord({ toolName: 'AskUserQuestion', questionCount: 1 }));

    // Task 1 should be completed (AskUserQuestion closes it)
    expect(detector.getCompletedTasks()).toHaveLength(1);
    expect(detector.getCurrentTask()).toBeNull();

    // Second task: 3 more Read calls
    jest.advanceTimersByTime(5000);
    detector.recordToolCall(makeRecord({ toolName: 'Read' }));
    jest.advanceTimersByTime(1000);
    detector.recordToolCall(makeRecord({ toolName: 'Read' }));
    jest.advanceTimersByTime(1000);
    detector.recordToolCall(makeRecord({ toolName: 'Read' }));

    // Idle timeout to close second task
    jest.advanceTimersByTime(30_000);

    const tasks = detector.getCompletedTasks();
    expect(tasks).toHaveLength(2);
    // First task: 3 Read + 1 AskUserQuestion = 4
    expect(tasks[0].toolCallCount).toBe(4);
    expect(tasks[0].askedUserQuestions).toBe(1);
    // Second task: 3 Read
    expect(tasks[1].toolCallCount).toBe(3);

    detector.dispose();
  });

  it('TaskUpdate with status=completed closes task', () => {
    const detector = new TaskDetector();

    detector.recordToolCall(makeRecord({ toolName: 'Read' }));
    jest.advanceTimersByTime(1000);
    detector.recordToolCall(makeRecord({ toolName: 'Edit', filePath: '/a.ts' }));
    jest.advanceTimersByTime(1000);
    detector.recordToolCall(makeRecord({
      toolName: 'TaskUpdate',
      taskId: 'task-1',
      taskStatus: 'completed',
    }));

    // Task should be closed immediately, no idle timeout needed
    expect(detector.getCompletedTasks()).toHaveLength(1);
    expect(detector.getCompletedTasks()[0].toolCallCount).toBe(3);
    expect(detector.getCurrentTask()).toBeNull();

    detector.dispose();
  });

  it('TaskUpdate with status=in_progress does NOT close task', () => {
    const detector = new TaskDetector();

    detector.recordToolCall(makeRecord({ toolName: 'Read' }));
    jest.advanceTimersByTime(1000);
    detector.recordToolCall(makeRecord({
      toolName: 'TaskUpdate',
      taskId: 'task-1',
      taskStatus: 'in_progress',
    }));

    // Task should still be active
    expect(detector.getCompletedTasks()).toHaveLength(0);
    expect(detector.getCurrentTask()).not.toBeNull();

    jest.advanceTimersByTime(30_000);
    expect(detector.getCompletedTasks()).toHaveLength(1);

    detector.dispose();
  });
});

// ---------------------------------------------------------------------------
// Accumulation of task-level data
// ---------------------------------------------------------------------------

describe('Task data accumulation', () => {
  it('accumulates filesRead, filesModified, linesChanged', () => {
    const detector = new TaskDetector();

    detector.recordToolCall(makeRecord({ toolName: 'Read', filePath: '/a.ts' }));
    detector.recordToolCall(makeRecord({ toolName: 'Read', filePath: '/b.ts' }));
    detector.recordToolCall(makeRecord({ toolName: 'Read', filePath: '/a.ts' })); // duplicate
    detector.recordToolCall(makeRecord({ toolName: 'Write', filePath: '/c.ts', lineCount: 50 }));
    detector.recordToolCall(makeRecord({
      toolName: 'Edit',
      filePath: '/a.ts',
      oldLineCount: 10,
      newLineCount: 15,
    }));

    jest.advanceTimersByTime(30_000);

    const task = detector.getCompletedTasks()[0];
    expect(task.filesRead).toEqual(['/a.ts', '/b.ts']); // sorted, unique
    expect(task.filesModified).toEqual(['/a.ts', '/c.ts']); // sorted, unique
    expect(task.linesChanged).toBe(55); // 50 (Write) + |15-10| (Edit)
    expect(task.linesAdded).toBe(65); // 50 (Write) + 15 (Edit new lines)
    expect(task.linesRemoved).toBe(10); // 10 (Edit old lines removed)

    detector.dispose();
  });

  it('counts testsRun and testsPassed from Bash calls', () => {
    const detector = new TaskDetector();

    detector.recordToolCall(makeRecord({
      toolName: 'Bash',
      isTestCommand: true,
      success: true,
    }));
    detector.recordToolCall(makeRecord({
      toolName: 'Bash',
      isTestCommand: true,
      success: false,
    }));
    detector.recordToolCall(makeRecord({
      toolName: 'Bash',
      isTestCommand: true,
      success: true,
    }));
    detector.recordToolCall(makeRecord({
      toolName: 'Bash',
      isTestCommand: false,
    }));

    jest.advanceTimersByTime(30_000);

    const task = detector.getCompletedTasks()[0];
    expect(task.bashCommandsRun).toBe(4);
    expect(task.testsRun).toBe(3);
    expect(task.testsPassed).toBe(2);

    detector.dispose();
  });

  it('counts buildRun and buildPassed from Bash calls', () => {
    const detector = new TaskDetector();

    detector.recordToolCall(makeRecord({
      toolName: 'Bash',
      isBuildCommand: true,
      success: true,
    }));
    detector.recordToolCall(makeRecord({
      toolName: 'Bash',
      isBuildCommand: true,
      success: false,
    }));

    jest.advanceTimersByTime(30_000);

    const task = detector.getCompletedTasks()[0];
    expect(task.buildRun).toBe(2);
    expect(task.buildPassed).toBe(1);

    detector.dispose();
  });

  it('counts subAgentsSpawned from Agent tool calls', () => {
    const detector = new TaskDetector();

    detector.recordToolCall(makeRecord({
      toolName: 'Agent',
      agentDescription: 'research',
      subagentType: 'Explore',
    }));
    detector.recordToolCall(makeRecord({
      toolName: 'Agent',
      agentDescription: 'plan',
      subagentType: 'Plan',
    }));

    jest.advanceTimersByTime(30_000);

    const task = detector.getCompletedTasks()[0];
    expect(task.subAgentsSpawned).toBe(2);

    detector.dispose();
  });

  it('Edit deletion has linesChanged = oldLineCount', () => {
    const detector = new TaskDetector();

    detector.recordToolCall(makeRecord({
      toolName: 'Edit',
      filePath: '/a.ts',
      oldLineCount: 5,
      newLineCount: 0, // deletion
    }));

    jest.advanceTimersByTime(30_000);

    const task = detector.getCompletedTasks()[0];
    expect(task.linesChanged).toBe(5); // |0 - 5|
    expect(task.linesAdded).toBe(0);
    expect(task.linesRemoved).toBe(5);

    detector.dispose();
  });

  it('Edit that both adds and removes lines reports both separately', () => {
    const detector = new TaskDetector();

    detector.recordToolCall(makeRecord({
      toolName: 'Edit',
      filePath: '/a.ts',
      oldLineCount: 10, // 10 lines removed
      newLineCount: 12, // 12 lines added
    }));

    jest.advanceTimersByTime(30_000);

    const task = detector.getCompletedTasks()[0];
    expect(task.linesChanged).toBe(2); // |12 - 10|
    expect(task.linesAdded).toBe(12); // gross additions, not net
    expect(task.linesRemoved).toBe(10); // gross removals, not net

    detector.dispose();
  });
});

// ---------------------------------------------------------------------------
// Cost tracking integration
// ---------------------------------------------------------------------------

describe('Cost tracking integration', () => {
  it('estimatedCostUsd matches delta from CostTracker', () => {
    const costTracker = new CostTracker();
    const detector = new TaskDetector({ costTracker });

    // Record some cost BEFORE the task starts
    costTracker.recordTokenUsage(
      {
        inputTokens: 5000,
        outputTokens: 1000,
        thinkingTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 6000,
      },
      'claude-sonnet-4',
    );

    const preTaskCost = costTracker.getMetrics().sessionTotalCostUsd!;

    // Start a task
    detector.recordToolCall(makeRecord({ toolName: 'Read' }));

    // Record cost DURING the task
    costTracker.recordTokenUsage(
      {
        inputTokens: 10000,
        outputTokens: 2000,
        thinkingTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 12000,
      },
      'claude-sonnet-4',
    );

    const postTaskCost = costTracker.getMetrics().sessionTotalCostUsd!;
    const expectedDelta = postTaskCost - preTaskCost;

    // Close task
    jest.advanceTimersByTime(30_000);

    const task = detector.getCompletedTasks()[0];
    expect(task.estimatedCostUsd).toBeCloseTo(expectedDelta, 6);
    expect(task.tokensUsed).toBe(12000); // 10000 input + 2000 output

    detector.dispose();
  });

  it('estimatedCostUsd is clamped to 0 if CostTracker is reset mid-task', () => {
    const costTracker = new CostTracker();
    const detector = new TaskDetector({ costTracker });

    // Accumulate cost before the task starts
    costTracker.recordTokenUsage(
      { inputTokens: 5000, outputTokens: 1000, thinkingTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 6000 },
      'claude-sonnet-4',
    );

    // Start task — costAtTaskStart is snapshot here
    detector.recordToolCall(makeRecord({ toolName: 'Read' }));

    // Reset wipes the cumulative total to 0 while the task is still active
    costTracker.reset();

    // Close task
    jest.advanceTimersByTime(30_000);

    const task = detector.getCompletedTasks()[0];
    // Before fix this would be negative; after fix it must be >= 0
    expect(task!.estimatedCostUsd).toBeGreaterThanOrEqual(0);
    expect(task!.tokensUsed).toBeGreaterThanOrEqual(0);

    detector.dispose();
  });

  it('estimatedCostUsd is null when no costTracker', () => {
    const detector = new TaskDetector();

    detector.recordToolCall(makeRecord({ toolName: 'Read' }));
    jest.advanceTimersByTime(30_000);

    const task = detector.getCompletedTasks()[0];
    expect(task.estimatedCostUsd).toBeNull();
    expect(task.tokensUsed).toBe(0);

    detector.dispose();
  });
});

// ---------------------------------------------------------------------------
// getCurrentTask
// ---------------------------------------------------------------------------

describe('getCurrentTask()', () => {
  it('returns snapshot of active task', () => {
    const detector = new TaskDetector();

    detector.recordToolCall(makeRecord({ toolName: 'Read', filePath: '/a.ts' }));
    detector.recordToolCall(makeRecord({ toolName: 'Edit', filePath: '/b.ts' }));

    const snapshot = detector.getCurrentTask();
    expect(snapshot).not.toBeNull();
    expect(snapshot!.toolCallCount).toBe(2);
    expect(snapshot!.filesRead).toEqual(['/a.ts']);
    expect(snapshot!.filesModified).toEqual(['/b.ts']);

    detector.dispose();
  });

  it('returns null when no active task', () => {
    const detector = new TaskDetector();

    expect(detector.getCurrentTask()).toBeNull();

    detector.dispose();
  });
});

// ---------------------------------------------------------------------------
// getCompletedTasks ordering
// ---------------------------------------------------------------------------

describe('getCompletedTasks() ordering', () => {
  it('returns tasks in chronological order', () => {
    const detector = new TaskDetector();

    // Task 1
    jest.setSystemTime(1000);
    detector.recordToolCall(makeRecord({ toolName: 'Read' }));
    jest.setSystemTime(2000);
    detector.recordToolCall(makeRecord({ toolName: 'AskUserQuestion' }));

    // Task 2
    jest.setSystemTime(10_000);
    detector.recordToolCall(makeRecord({ toolName: 'Edit' }));
    jest.setSystemTime(11_000);
    detector.recordToolCall(makeRecord({ toolName: 'AskUserQuestion' }));

    // Task 3
    jest.setSystemTime(20_000);
    detector.recordToolCall(makeRecord({ toolName: 'Bash' }));
    jest.advanceTimersByTime(30_000);

    const tasks = detector.getCompletedTasks();
    expect(tasks).toHaveLength(3);
    expect(tasks[0].startTime).toBeLessThan(tasks[1].startTime);
    expect(tasks[1].startTime).toBeLessThan(tasks[2].startTime);

    detector.dispose();
  });
});

// ---------------------------------------------------------------------------
// getMetrics
// ---------------------------------------------------------------------------

describe('getMetrics()', () => {
  it('returns correct aggregated metrics', () => {
    const detector = new TaskDetector();

    // Complete 2 tasks via AskUserQuestion
    detector.recordToolCall(makeRecord({ toolName: 'Read' }));
    detector.recordToolCall(makeRecord({ toolName: 'Read' }));
    detector.recordToolCall(makeRecord({ toolName: 'AskUserQuestion' }));

    jest.advanceTimersByTime(5000);
    detector.recordToolCall(makeRecord({ toolName: 'Edit' }));
    jest.advanceTimersByTime(30_000);

    const metrics = detector.getMetrics();
    expect(metrics.totalTasksCompleted).toBe(2);
    expect(metrics.currentTaskActive).toBe(false);
    expect(metrics.currentTaskToolCalls).toBe(0);
    expect(metrics.averageTaskDurationMs).not.toBeNull();
    expect(metrics.averageToolCallsPerTask).toBe(2); // (3 + 1) / 2
    expect(metrics.completedTasks).toHaveLength(2);

    detector.dispose();
  });

  it('returns null averages when no completed tasks', () => {
    const detector = new TaskDetector();

    const metrics = detector.getMetrics();
    expect(metrics.totalTasksCompleted).toBe(0);
    expect(metrics.averageTaskDurationMs).toBeNull();
    expect(metrics.averageToolCallsPerTask).toBeNull();

    detector.dispose();
  });

  it('reports currentTaskToolCalls when task is active', () => {
    const detector = new TaskDetector();

    detector.recordToolCall(makeRecord({ toolName: 'Read' }));
    detector.recordToolCall(makeRecord({ toolName: 'Edit' }));

    const metrics = detector.getMetrics();
    expect(metrics.currentTaskActive).toBe(true);
    expect(metrics.currentTaskToolCalls).toBe(2);

    detector.dispose();
  });
});

// ---------------------------------------------------------------------------
// emitMetrics
// ---------------------------------------------------------------------------

describe('emitMetrics()', () => {
  it('records expected metric names', () => {
    const detector = new TaskDetector();

    detector.recordToolCall(makeRecord({ toolName: 'Read' }));
    jest.advanceTimersByTime(30_000);

    // Use a mock aggregator to capture metric names
    const recorded: Array<{ name: string; value: number }> = [];
    const aggregator = {
      record(name: string, value: number) {
        recorded.push({ name, value });
      },
    } as unknown as import('../shared/index.js').MetricAggregator;

    detector.emitMetrics(aggregator);

    const names = recorded.map(r => r.name);
    expect(names).toContain('ai.task.completed_count');
    expect(names).toContain('ai.task.active');
    expect(names).toContain('ai.task.duration_ms');
    expect(names).toContain('ai.task.tool_call_count');

    detector.dispose();
  });
});

// ---------------------------------------------------------------------------
// reset and dispose
// ---------------------------------------------------------------------------

describe('reset()', () => {
  it('clears all state', () => {
    const detector = new TaskDetector();

    // Complete a task
    detector.recordToolCall(makeRecord({ toolName: 'Read' }));
    jest.advanceTimersByTime(30_000);
    expect(detector.getCompletedTasks()).toHaveLength(1);

    // Start another task
    detector.recordToolCall(makeRecord({ toolName: 'Edit' }));
    expect(detector.getCurrentTask()).not.toBeNull();

    // Reset
    detector.reset();

    expect(detector.getCompletedTasks()).toHaveLength(0);
    expect(detector.getCurrentTask()).toBeNull();
    expect(detector.getMetrics().totalTasksCompleted).toBe(0);
  });
});

describe('dispose()', () => {
  it('closes active task and clears timer', () => {
    const detector = new TaskDetector();

    detector.recordToolCall(makeRecord({ toolName: 'Read' }));
    detector.recordToolCall(makeRecord({ toolName: 'Edit' }));

    expect(detector.getCurrentTask()).not.toBeNull();
    expect(detector.getCompletedTasks()).toHaveLength(0);

    detector.dispose();

    // Active task should have been closed
    expect(detector.getCurrentTask()).toBeNull();
    expect(detector.getCompletedTasks()).toHaveLength(1);
    expect(detector.getCompletedTasks()[0].toolCallCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// maxCompletedTasks cap
// ---------------------------------------------------------------------------

describe('maxCompletedTasks cap', () => {
  it('evicts oldest tasks when cap exceeded', () => {
    const detector = new TaskDetector({ maxCompletedTasks: 3 });

    // Create 5 tasks via AskUserQuestion boundaries
    for (let i = 0; i < 5; i++) {
      detector.recordToolCall(makeRecord({ toolName: `Tool${i}` }));
      detector.recordToolCall(makeRecord({ toolName: 'AskUserQuestion' }));
    }

    const tasks = detector.getCompletedTasks();
    expect(tasks).toHaveLength(3);
    // Should be the last 3 (oldest evicted)
    expect(tasks[0].toolCallsByType).toHaveProperty('Tool2');
    expect(tasks[1].toolCallsByType).toHaveProperty('Tool3');
    expect(tasks[2].toolCallsByType).toHaveProperty('Tool4');

    detector.dispose();
  });
});

// ---------------------------------------------------------------------------
// drainNewlyCompletedTasks()
// ---------------------------------------------------------------------------

describe('drainNewlyCompletedTasks()', () => {
  it('returns completed tasks and clears the queue', () => {
    const detector = new TaskDetector();

    detector.recordToolCall(makeRecord({ toolName: 'Read' }));
    detector.recordToolCall(makeRecord({ toolName: 'AskUserQuestion' }));

    const firstDrain = detector.drainNewlyCompletedTasks();
    expect(firstDrain).toHaveLength(1);
    expect(firstDrain[0].toolCallCount).toBe(2);

    // Second drain — queue is already empty
    const secondDrain = detector.drainNewlyCompletedTasks();
    expect(secondDrain).toHaveLength(0);

    detector.dispose();
  });

  it('does not remove tasks from getCompletedTasks() history', () => {
    const detector = new TaskDetector();

    detector.recordToolCall(makeRecord({ toolName: 'Read' }));
    detector.recordToolCall(makeRecord({ toolName: 'AskUserQuestion' }));

    detector.drainNewlyCompletedTasks(); // drain it

    // History is still intact
    expect(detector.getCompletedTasks()).toHaveLength(1);

    detector.dispose();
  });

  it('each task is returned exactly once across multiple drains', () => {
    const detector = new TaskDetector();

    // Task 1
    detector.recordToolCall(makeRecord({ toolName: 'Read' }));
    detector.recordToolCall(makeRecord({ toolName: 'AskUserQuestion' }));

    const drain1 = detector.drainNewlyCompletedTasks();
    expect(drain1).toHaveLength(1);

    // Task 2
    detector.recordToolCall(makeRecord({ toolName: 'Edit' }));
    detector.recordToolCall(makeRecord({ toolName: 'AskUserQuestion' }));

    const drain2 = detector.drainNewlyCompletedTasks();
    expect(drain2).toHaveLength(1);
    expect(drain2[0].toolCallsByType).toHaveProperty('Edit');

    detector.dispose();
  });

  it('reset() clears the pending emission queue', () => {
    const detector = new TaskDetector();

    detector.recordToolCall(makeRecord({ toolName: 'Read' }));
    detector.recordToolCall(makeRecord({ toolName: 'AskUserQuestion' }));

    detector.reset();

    expect(detector.drainNewlyCompletedTasks()).toHaveLength(0);
    expect(detector.getCompletedTasks()).toHaveLength(0);
  });
});
