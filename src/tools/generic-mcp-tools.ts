/**
 * MCP tool handlers for the generic-mcp self-reported platform (GenericMcpAdapter).
 *
 * Defines:
 *   - `nr_observe_report_tool_call`     — report a non-MCP tool call for tracking/ingest
 *   - `nr_observe_report_session_start` — initialize session metadata (platform/model/developer)
 *   - `nr_observe_report_session_end`   — acknowledge session completion
 */

import { randomUUID } from 'node:crypto';

import type { GenericMcpAdapter } from '../platforms/generic-mcp-adapter.js';
import {
  REPORT_TOOL_CALL_TOOL,
  REPORT_SESSION_START_TOOL,
  REPORT_SESSION_END_TOOL,
  validateReportSessionStartInput,
  validateReportSessionEndInput,
} from '../platforms/generic-mcp-adapter.js';
import type { SessionTracker } from '../metrics/session-tracker.js';
import type { ToolCallRecord } from '../storage/types.js';
import {
  errorResult,
  requireTracker,
  buildToolSet,
  type RegisteredToolSet,
} from './tool-registry.js';

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function handleReportToolCall(
  adapter: GenericMcpAdapter,
  args: Record<string, unknown> | undefined,
  sessionTracker: SessionTracker | undefined,
  nrIngestManager: { ingestToolCall(record: ToolCallRecord): void } | undefined,
  sessionTraceId: string | undefined,
) {
  const normalized = adapter.normalizeToolCall(args ?? {});

  const record: ToolCallRecord = {
    id: randomUUID(),
    sessionId: sessionTraceId ?? null,
    toolName: normalized.toolName,
    toolUseId: randomUUID(),
    timestamp: normalized.timestamp,
    durationMs: normalized.durationMs,
    success: normalized.success,
    ...(normalized.error !== undefined && { error: normalized.error }),
    ...(normalized.inputSizeBytes !== undefined && { inputSizeBytes: normalized.inputSizeBytes }),
    ...(normalized.outputSizeBytes !== undefined && {
      outputSizeBytes: normalized.outputSizeBytes,
    }),
    ...(normalized.filePath !== undefined && { filePath: normalized.filePath }),
    ...(normalized.command !== undefined && { command: normalized.command }),
  };

  sessionTracker?.recordToolCall(record);
  nrIngestManager?.ingestToolCall(record);

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          { recorded: true, tool: record.toolName, timestamp: record.timestamp },
          null,
          2,
        ),
      },
    ],
  };
}

export function handleReportSessionStart(
  adapter: GenericMcpAdapter,
  args: Record<string, unknown> | undefined,
) {
  const input = validateReportSessionStartInput(args ?? {});
  adapter.handleSessionStart(input);

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          { recorded: true, platform: adapter.getSessionMetadata().platform },
          null,
          2,
        ),
      },
    ],
  };
}

export function handleReportSessionEnd(args: Record<string, unknown> | undefined) {
  const input = validateReportSessionEndInput(args);

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ recorded: true, summary: input.summary ?? null }, null, 2),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export interface GenericMcpToolsDeps {
  genericMcpAdapter?: GenericMcpAdapter;
  sessionTracker?: SessionTracker;
  nrIngestManager?: { ingestToolCall(record: ToolCallRecord): void };
  sessionTraceId?: string;
}

export function registerGenericMcpTools(deps: GenericMcpToolsDeps): RegisteredToolSet {
  return buildToolSet([
    {
      definition: REPORT_TOOL_CALL_TOOL,
      available: !!deps.genericMcpAdapter,
      handle: (args) => {
        const check = requireTracker(deps.genericMcpAdapter, 'GenericMcpAdapter');
        if (!check.ok) return check.result;
        try {
          return handleReportToolCall(
            check.value,
            args,
            deps.sessionTracker,
            deps.nrIngestManager,
            deps.sessionTraceId,
          );
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: REPORT_SESSION_START_TOOL,
      available: !!deps.genericMcpAdapter,
      handle: (args) => {
        const check = requireTracker(deps.genericMcpAdapter, 'GenericMcpAdapter');
        if (!check.ok) return check.result;
        try {
          return handleReportSessionStart(check.value, args);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: REPORT_SESSION_END_TOOL,
      available: !!deps.genericMcpAdapter,
      handle: (args) => {
        const check = requireTracker(deps.genericMcpAdapter, 'GenericMcpAdapter');
        if (!check.ok) return check.result;
        try {
          return handleReportSessionEnd(args);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
  ]);
}
