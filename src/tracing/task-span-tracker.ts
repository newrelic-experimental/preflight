import { type Span, SpanStatusCode, context, trace } from '@opentelemetry/api';
import { getMcpTracer } from './mcp-tracer.js';
import { createLogger } from '../core/index.js';

const logger = createLogger('task-span-tracker');

export class TaskSpanTracker {
  private readonly activeTasks: Map<string, Span> = new Map();
  private readonly taskContexts: Map<string, ReturnType<typeof context.active>> = new Map();

  openTask(taskId: string, label: string, parentContext: ReturnType<typeof context.active>): void {
    if (this.activeTasks.has(taskId)) return;
    const span = getMcpTracer().startSpan(
      `ai.task ${label}`,
      {
        attributes: {
          'ai.task.id': taskId,
          'ai.task.label': label,
        },
      },
      parentContext,
    );
    this.activeTasks.set(taskId, span);
    this.taskContexts.set(taskId, parentContext);
    logger.debug('Task span opened', { taskId, label });
  }

  closeTask(taskId: string, toolCallCount: number): void {
    const span = this.activeTasks.get(taskId);
    if (!span) return;
    span.setAttributes({ 'ai.task.tool_call_count': toolCallCount });
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
    this.activeTasks.delete(taskId);
    this.taskContexts.delete(taskId);
    logger.debug('Task span closed', { taskId });
  }

  getContext(
    taskId: string | null,
    fallback: ReturnType<typeof context.active>,
  ): ReturnType<typeof context.active> {
    if (!taskId) return fallback;
    const span = this.activeTasks.get(taskId);
    if (!span) return fallback;
    // Use the stored parent context from openTask() rather than context.active() to
    // avoid attaching the span to an unrelated async frame's context.
    const parentCtx = this.taskContexts.get(taskId) ?? fallback;
    return trace.setSpan(parentCtx, span);
  }

  closeAll(): void {
    for (const [taskId, span] of this.activeTasks) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: 'session ended with task in progress',
      });
      span.end();
      logger.debug('Force-closed task span', { taskId });
    }
    this.activeTasks.clear();
    this.taskContexts.clear();
  }

  get size(): number {
    return this.activeTasks.size;
  }
}
