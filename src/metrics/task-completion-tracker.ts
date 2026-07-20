import { createLogger } from '../shared/index.js';
import type { AiCodingTask } from './task-detector.js';
import type { ToolCallRecord } from '../storage/types.js';
import type { Resettable } from './tracker-contracts.js';

const logger = createLogger('task-completion-tracker');

interface TaskSummary {
  readonly durationMs: number;
  readonly toolCallCount: number;
}

export interface TaskCompletionMetrics {
  readonly completedTasks: number;
  readonly avgTaskDurationMs: number | null;
  readonly avgToolCallsPerTask: number | null;
}

export class TaskCompletionTracker implements Resettable {
  private completed: TaskSummary[] = [];

  // No-op: this tracker is fed via recordTask() called by TaskDetector.
  // recordToolCall exists for compatibility with the standard tracker pattern.
  recordToolCall(_record: ToolCallRecord): void {
    logger.debug('recordToolCall is a no-op on this tracker; fed via recordTask()');
  }

  recordTask(task: AiCodingTask): void {
    this.completed.push({ durationMs: task.durationMs, toolCallCount: task.toolCallCount });
  }

  getMetrics(): TaskCompletionMetrics {
    const completedCount = this.completed.length;

    const avgTaskDurationMs =
      completedCount > 0
        ? this.completed.reduce((s, t) => s + t.durationMs, 0) / completedCount
        : null;

    const avgToolCallsPerTask =
      completedCount > 0
        ? this.completed.reduce((s, t) => s + t.toolCallCount, 0) / completedCount
        : null;

    return {
      completedTasks: completedCount,
      avgTaskDurationMs,
      avgToolCallsPerTask,
    };
  }

  reset(_sessionId: string): void {
    this.completed = [];
  }
}
