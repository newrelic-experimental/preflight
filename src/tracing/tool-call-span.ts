import { SpanStatusCode, context } from '@opentelemetry/api';
import type { ToolCallRecord } from '../storage/types.js';
import { getMcpTracer } from './mcp-tracer.js';
import { createLogger } from '../shared/index.js';

const logger = createLogger('tool-call-span');

export function emitToolCallSpan(
  record: ToolCallRecord,
  parentContext: ReturnType<typeof context.active>,
  taskId?: string,
): void {
  const tracer = getMcpTracer();
  const spanName = `mcp.tool.${record.toolName}`;

  const span = tracer.startSpan(
    spanName,
    {
      startTime: record.timestamp,
      attributes: {
        'mcp.tool.name': record.toolName,
        'mcp.tool.use_id': record.toolUseId,
        'ai.session.id': record.sessionId ?? '',
        'mcp.tool.success': record.success,
        ...(record.inputSizeBytes !== undefined && { 'mcp.tool.input_size_bytes': record.inputSizeBytes }),
        ...(record.outputSizeBytes !== undefined && { 'mcp.tool.output_size_bytes': record.outputSizeBytes }),
        ...(taskId && { 'ai.task.id': taskId }),
      },
    },
    parentContext,
  );

  let ended = false;

  if (record.durationMs != null && Number.isFinite(record.durationMs)) {
    const endTime = record.timestamp + record.durationMs;
    if (!record.success) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: record.error ?? record.errorType ?? 'tool call failed' });
      if (record.error) span.recordException(new Error(record.error));
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }
    if (!ended) {
      span.end(endTime);
      ended = true;
    }
  } else if (!ended) {
    // Orphaned/timeout record — end immediately
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'orphaned tool call (no post event)' });
    span.end();
    ended = true;
  }

  logger.debug('Tool call span emitted', { tool: record.toolName, success: record.success });
}
