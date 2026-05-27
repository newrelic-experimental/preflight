import { type Span, SpanStatusCode, context, trace } from '@opentelemetry/api';
import { getMcpTracer } from './mcp-tracer.js';
import { createLogger } from '../shared/index.js';

const logger = createLogger('session-span');

export class SessionSpan {
  private span: Span | null = null;
  private readonly sessionId: string;
  private readonly developer: string;
  private ended = false;

  constructor(sessionId: string, developer: string) {
    this.sessionId = sessionId;
    this.developer = developer;
  }

  start(): void {
    if (this.span) return;
    this.span = getMcpTracer().startSpan('ai.coding.session', {
      attributes: {
        'ai.session.id': this.sessionId,
        'ai.developer': this.developer,
        'ai.platform': 'claude-code',
      },
    });
    logger.debug('Session span started', { sessionId: this.sessionId });
  }

  end(toolCallCount: number, taskCount: number): void {
    if (this.ended) return;
    this.ended = true;
    if (!this.span) return;
    this.span.setAttributes({
      'ai.session.tool_call_count': toolCallCount,
      'ai.session.task_count': taskCount,
    });
    this.span.setStatus({ code: SpanStatusCode.OK });
    this.span.end();
    this.span = null;
  }

  getSpan(): Span | null {
    return this.span;
  }

  getContext() {
    if (!this.span) return context.active();
    return trace.setSpan(context.active(), this.span);
  }
}
