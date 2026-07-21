/**
 * Task Boundary Detection — heuristically detects discrete "tasks" from
 * the stream of tool calls.
 *
 * A task is the work Claude does between user messages: the user gives an
 * instruction, Claude executes a series of tool calls, and eventually responds.
 *
 * Detection signals:
 *   1. Idle gap > threshold (configurable, default 30s) → task complete
 *   2. AskUserQuestion tool call → task complete (Claude is asking for direction)
 *   3. TaskUpdate with status=completed → explicit task completion
 */

import { randomUUID } from 'node:crypto';
import type { MetricAggregator } from '../shared/index.js';
import { createLogger } from '../shared/index.js';
import type { ToolCallRecord } from '../storage/types.js';
import type { CostTracker } from './cost-tracker.js';
import type { Resettable } from './tracker-contracts.js';

const logger = createLogger('task-detector');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AiCodingTask {
  readonly taskId: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly durationMs: number;
  readonly toolCallCount: number;
  readonly toolCallsByType: Record<string, number>;
  readonly filesRead: string[];
  readonly filesModified: string[];
  readonly linesChanged: number;
  readonly linesAdded: number;
  readonly linesRemoved: number;
  readonly bashCommandsRun: number;
  readonly testsRun: number;
  readonly testsPassed: number;
  readonly buildRun: number;
  readonly buildPassed: number;
  readonly estimatedCostUsd: number | null;
  readonly tokensUsed: number;
  readonly askedUserQuestions: number;
  readonly subAgentsSpawned: number;
  readonly toolCalls: ToolCallRecord[];
}

export interface TaskMetrics {
  readonly totalTasksCompleted: number;
  readonly currentTaskActive: boolean;
  readonly currentTaskToolCalls: number;
  readonly averageTaskDurationMs: number | null;
  readonly averageToolCallsPerTask: number | null;
  readonly completedTasks: AiCodingTask[];
}

export interface TaskDetectorOptions {
  readonly idleTimeoutMs?: number;
  /**
   * When provided, TaskDetector reads this tracker's cumulative totals at
   * task-start and task-close to compute a per-task cost/token delta. Those
   * totals must only increase between the two reads — calling
   * `CostTracker.reset()` while a task is active silently zeroes that task's
   * delta (a warning is logged; see `computeCostDelta()`).
   */
  readonly costTracker?: CostTracker;
  readonly maxCompletedTasks?: number;
}

// ---------------------------------------------------------------------------
// Internal mutable task accumulator
// ---------------------------------------------------------------------------

class ActiveTask {
  readonly taskId: string;
  readonly startTime: number;

  toolCallCount = 0;
  private readonly toolCallsByType = new Map<string, number>();
  private readonly filesReadSet = new Set<string>();
  private readonly filesModifiedSet = new Set<string>();
  private readonly rawToolCalls: ToolCallRecord[] = [];
  linesChanged = 0;
  linesAdded = 0;
  linesRemoved = 0;
  bashCommandsRun = 0;
  testsRun = 0;
  testsPassed = 0;
  buildRun = 0;
  buildPassed = 0;
  askedUserQuestions = 0;
  subAgentsSpawned = 0;

  constructor(taskId: string, startTime: number) {
    this.taskId = taskId;
    this.startTime = startTime;
  }

  addToolCall(record: ToolCallRecord): void {
    this.toolCallCount++;
    this.rawToolCalls.push(record);

    const tool = record.toolName;
    this.toolCallsByType.set(tool, (this.toolCallsByType.get(tool) ?? 0) + 1);

    // File tracking
    const filePath = record.filePath as string | undefined;
    if (filePath) {
      if (tool === 'Read') {
        this.filesReadSet.add(filePath);
      } else if (tool === 'Write' || tool === 'Edit') {
        this.filesModifiedSet.add(filePath);
      }
    }

    // Line change tracking
    if (tool === 'Write') {
      const lineCount = record.lineCount as number | undefined;
      if (lineCount != null) {
        this.linesAdded += lineCount;
        this.linesChanged += lineCount;
      }
    } else if (tool === 'Edit') {
      const newLines = (record.newLineCount as number | undefined) ?? 0;
      const oldLines = (record.oldLineCount as number | undefined) ?? 0;
      // Track actual additions and removals, not just net diff.
      // An edit that replaces 10 lines with 15 lines: removed=10, added=15 (not added=5).
      this.linesAdded += newLines;
      this.linesRemoved += oldLines;
      this.linesChanged += Math.abs(newLines - oldLines);
    }

    // Bash tracking
    if (tool === 'Bash') {
      this.bashCommandsRun++;
      if (record.isTestCommand) {
        this.testsRun++;
        if (record.success) this.testsPassed++;
      }
      if (record.isBuildCommand) {
        this.buildRun++;
        if (record.success) this.buildPassed++;
      }
    }

    // AskUserQuestion tracking
    if (tool === 'AskUserQuestion') {
      this.askedUserQuestions++;
    }

    // Agent tracking
    if (tool === 'Agent') {
      this.subAgentsSpawned++;
    }
  }

  toCompleted(endTime: number, estimatedCostUsd: number | null, tokensUsed: number): AiCodingTask {
    const toolCallsByType: Record<string, number> = {};
    for (const [tool, count] of this.toolCallsByType) {
      toolCallsByType[tool] = count;
    }

    return {
      taskId: this.taskId,
      startTime: this.startTime,
      endTime,
      // Cap at 4 hours to guard against inflated durations from process suspension
      // (laptop sleep or container pause) causing the idle timer to fire on resume.
      durationMs: Math.min(endTime - this.startTime, 4 * 60 * 60 * 1000),
      toolCallCount: this.toolCallCount,
      toolCallsByType,
      filesRead: [...this.filesReadSet].sort(),
      filesModified: [...this.filesModifiedSet].sort(),
      linesChanged: this.linesChanged,
      linesAdded: this.linesAdded,
      linesRemoved: this.linesRemoved,
      bashCommandsRun: this.bashCommandsRun,
      testsRun: this.testsRun,
      testsPassed: this.testsPassed,
      buildRun: this.buildRun,
      buildPassed: this.buildPassed,
      estimatedCostUsd,
      tokensUsed,
      askedUserQuestions: this.askedUserQuestions,
      subAgentsSpawned: this.subAgentsSpawned,
      toolCalls: [...this.rawToolCalls],
    };
  }
}

// ---------------------------------------------------------------------------
// TaskDetector
// ---------------------------------------------------------------------------

const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_COMPLETED_TASKS = 100;

export class TaskDetector implements Resettable {
  private readonly idleTimeoutMs: number;
  private readonly costTracker: CostTracker | null;
  private readonly maxCompletedTasks: number;

  private activeTask: ActiveTask | null = null;
  private completedTasks: AiCodingTask[] = [];
  private pendingEmission: AiCodingTask[] = [];
  private lifetimeCompletedCount = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  // Cost/token snapshots at task start for computing deltas
  private costAtTaskStart = 0;
  private tokensAtTaskStart = 0;

  constructor(options?: TaskDetectorOptions) {
    this.idleTimeoutMs = options?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.costTracker = options?.costTracker ?? null;
    this.maxCompletedTasks = options?.maxCompletedTasks ?? DEFAULT_MAX_COMPLETED_TASKS;
  }

  recordToolCall(record: ToolCallRecord): void {
    // Start a new task if none is active
    if (this.activeTask === null) {
      this.startNewTask(record.timestamp);
    }

    // Accumulate the tool call
    this.activeTask!.addToolCall(record);

    // Check for boundary signals
    if (record.toolName === 'AskUserQuestion') {
      this.closeCurrentTask(record.timestamp);
      return; // Timer not needed — task is already closed
    }

    if (
      record.toolName === 'TaskUpdate' &&
      (record.taskStatus as string | undefined) === 'completed'
    ) {
      this.closeCurrentTask(record.timestamp);
      return;
    }

    // Reset idle timer
    this.resetIdleTimer();
  }

  getCurrentTask(): AiCodingTask | null {
    if (this.activeTask === null) return null;

    const { costUsd, tokens } = this.computeCostDelta();

    return this.activeTask.toCompleted(Date.now(), costUsd, tokens);
  }

  getCompletedTasks(): AiCodingTask[] {
    return [...this.completedTasks];
  }

  /**
   * Returns tasks completed since the last drain and clears the emission queue.
   * Safe to call on every poll cycle — each task is returned exactly once.
   */
  drainNewlyCompletedTasks(): AiCodingTask[] {
    const tasks = [...this.pendingEmission];
    this.pendingEmission = [];
    return tasks;
  }

  getActiveTaskId(): string | null {
    return this.activeTask?.taskId ?? null;
  }

  /**
   * Explicitly close the current task, if one is active. This is the
   * universal task-boundary signal any platform's calling agent can invoke
   * via `nr_observe_mark_task_boundary` — the only boundary signal available
   * on platforms that have no equivalent to Claude Code's
   * `AskUserQuestion`/`TaskUpdate` tools.
   */
  markBoundary(timestamp: number): AiCodingTask | null {
    return this.closeCurrentTask(timestamp);
  }

  getMetrics(): TaskMetrics {
    const completed = this.completedTasks;

    let avgDuration: number | null = null;
    let avgToolCalls: number | null = null;

    if (completed.length > 0) {
      let totalDuration = 0;
      let totalToolCalls = 0;
      for (const task of completed) {
        totalDuration += task.durationMs;
        totalToolCalls += task.toolCallCount;
      }
      avgDuration = Math.round(totalDuration / completed.length);
      avgToolCalls = Math.round((totalToolCalls / completed.length) * 100) / 100;
    }

    return {
      totalTasksCompleted: this.lifetimeCompletedCount,
      currentTaskActive: this.activeTask !== null,
      currentTaskToolCalls: this.activeTask?.toolCallCount ?? 0,
      averageTaskDurationMs: avgDuration,
      averageToolCallsPerTask: avgToolCalls,
      completedTasks: [...completed],
    };
  }

  emitMetrics(aggregator: MetricAggregator): void {
    aggregator.record('ai.task.completed_count', this.completedTasks.length);
    aggregator.record('ai.task.active', this.activeTask !== null ? 1 : 0);

    for (const task of this.completedTasks) {
      aggregator.record('ai.task.duration_ms', task.durationMs);
      aggregator.record('ai.task.tool_call_count', task.toolCallCount);
      if (task.estimatedCostUsd !== null) {
        aggregator.record('ai.task.cost_usd', task.estimatedCostUsd);
      }
    }
  }

  reset(_sessionId: string): void {
    this.clearIdleTimer();
    this.activeTask = null;
    this.completedTasks = [];
    this.pendingEmission = [];
    this.costAtTaskStart = 0;
    this.tokensAtTaskStart = 0;
    this.lifetimeCompletedCount = 0;
  }

  dispose(): void {
    this.clearIdleTimer();
    if (this.activeTask !== null) {
      this.closeCurrentTask(Date.now());
    }
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private startNewTask(timestamp: number): void {
    this.activeTask = new ActiveTask(randomUUID(), timestamp);
    this.snapshotCostState();
  }

  private closeCurrentTask(endTime: number): AiCodingTask | null {
    if (this.activeTask === null) return null;

    const { costUsd, tokens } = this.computeCostDelta();

    const completed = this.activeTask.toCompleted(endTime, costUsd, tokens);
    this.completedTasks.push(completed);
    this.pendingEmission.push(completed);
    this.lifetimeCompletedCount++;

    // Cap completed tasks to prevent unbounded memory
    while (this.completedTasks.length > this.maxCompletedTasks) {
      this.completedTasks.shift();
    }
    // Cap pendingEmission to the same limit (drainNewlyCompletedTasks may
    // never be called in abnormal shutdown paths)
    while (this.pendingEmission.length > this.maxCompletedTasks) {
      this.pendingEmission.shift();
    }

    this.activeTask = null;
    this.clearIdleTimer();
    return completed;
  }

  private snapshotCostState(): void {
    if (this.costTracker === null) {
      this.costAtTaskStart = 0;
      this.tokensAtTaskStart = 0;
      return;
    }

    const metrics = this.costTracker.getMetrics();
    this.costAtTaskStart = metrics.sessionTotalCostUsd ?? 0;
    this.tokensAtTaskStart =
      metrics.totalInputTokens + metrics.totalOutputTokens + metrics.totalThinkingTokens;
  }

  private computeCostDelta(): { costUsd: number | null; tokens: number } {
    if (this.costTracker === null) {
      return { costUsd: null, tokens: 0 };
    }

    const metrics = this.costTracker.getMetrics();
    const currentCost = metrics.sessionTotalCostUsd ?? 0;
    const currentTokens =
      metrics.totalInputTokens + metrics.totalOutputTokens + metrics.totalThinkingTokens;

    const rawCostDelta = currentCost - this.costAtTaskStart;
    const rawTokenDelta = currentTokens - this.tokensAtTaskStart;

    if (rawCostDelta < 0 || rawTokenDelta < 0) {
      // See TaskDetectorOptions.costTracker: this only happens if the
      // CostTracker was reset (or otherwise had its totals decrease) while
      // this task was active.
      logger.warn('TaskDetector: negative cost/token delta clamped to 0', {
        rawCostDelta,
        rawTokenDelta,
      });
    }

    return {
      costUsd: Math.max(0, rawCostDelta),
      tokens: Math.max(0, rawTokenDelta),
    };
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.closeCurrentTask(Date.now());
    }, this.idleTimeoutMs);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
