import { describe, it, expect, jest } from '@jest/globals';
import { GenericMcpAdapter } from '../platforms/generic-mcp-adapter.js';
import { SessionTracker } from '../metrics/session-tracker.js';
import type { ToolCallRecord } from '../storage/types.js';
import {
  handleReportToolCall,
  handleReportSessionStart,
  handleReportSessionEnd,
  registerGenericMcpTools,
} from './generic-mcp-tools.js';

describe('handleReportToolCall()', () => {
  it('normalizes input, records to SessionTracker, and calls nrIngestManager.ingestToolCall', () => {
    const adapter = new GenericMcpAdapter();
    const sessionTracker = new SessionTracker('sess-1');
    const ingestToolCall = jest.fn();

    const result = handleReportToolCall(
      adapter,
      { tool: 'Read', success: true, duration_ms: 42, input: { file_path: '/a.ts' } },
      sessionTracker,
      { ingestToolCall },
      'sess-1',
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.recorded).toBe(true);
    expect(body.tool).toBe('Read');

    expect(sessionTracker.getMetrics().toolCallCount).toBe(1);
    expect(ingestToolCall).toHaveBeenCalledTimes(1);
    const recorded = ingestToolCall.mock.calls[0][0] as ToolCallRecord;
    expect(recorded.toolName).toBe('Read');
    expect(recorded.sessionId).toBe('sess-1');
    expect(recorded.durationMs).toBe(42);
    expect(recorded.filePath).toBe('/a.ts');
  });

  it('works with no sessionTracker or nrIngestManager provided', () => {
    const adapter = new GenericMcpAdapter();
    const result = handleReportToolCall(
      adapter,
      { tool: 'Bash', success: true },
      undefined,
      undefined,
      undefined,
    );
    const body = JSON.parse(result.content[0].text);
    expect(body.recorded).toBe(true);
    expect(body.tool).toBe('Bash');
  });

  it('throws on invalid input (missing tool)', () => {
    const adapter = new GenericMcpAdapter();
    expect(() =>
      handleReportToolCall(adapter, { success: true }, undefined, undefined, undefined),
    ).toThrow('Missing required field: tool');
  });
});

describe('handleReportSessionStart()', () => {
  it('initializes adapter session metadata and returns the resolved platform', () => {
    const adapter = new GenericMcpAdapter();
    const result = handleReportSessionStart(adapter, {
      platform: 'my-ide',
      model: 'gpt-4o',
    });
    const body = JSON.parse(result.content[0].text);
    expect(body.recorded).toBe(true);
    expect(body.platform).toBe('my-ide');
    expect(adapter.getSessionMetadata().model).toBe('gpt-4o');
  });

  it('throws on missing platform', () => {
    const adapter = new GenericMcpAdapter();
    expect(() => handleReportSessionStart(adapter, {})).toThrow('Missing required field: platform');
  });
});

describe('handleReportSessionEnd()', () => {
  it('acknowledges a report with a summary', () => {
    const result = handleReportSessionEnd({ summary: 'Fixed the bug' });
    const body = JSON.parse(result.content[0].text);
    expect(body.recorded).toBe(true);
    expect(body.summary).toBe('Fixed the bug');
  });

  it('acknowledges a report with no summary', () => {
    const result = handleReportSessionEnd(undefined);
    const body = JSON.parse(result.content[0].text);
    expect(body.recorded).toBe(true);
    expect(body.summary).toBeNull();
  });

  it('throws on invalid summary type', () => {
    expect(() => handleReportSessionEnd({ summary: 42 })).toThrow(
      'Field summary must be a string when present',
    );
  });
});

describe('registerGenericMcpTools()', () => {
  it('lists no tools when genericMcpAdapter is absent', () => {
    const { tools } = registerGenericMcpTools({});
    expect(tools).toHaveLength(0);
  });

  it('lists all three tools when genericMcpAdapter is present', () => {
    const { tools } = registerGenericMcpTools({ genericMcpAdapter: new GenericMcpAdapter() });
    const names = tools.map((t) => t.name);
    expect(names).toEqual([
      'nr_observe_report_tool_call',
      'nr_observe_report_session_start',
      'nr_observe_report_session_end',
    ]);
  });

  it('nr_observe_report_tool_call handler returns an explanatory error when adapter is absent', async () => {
    const { handlers } = registerGenericMcpTools({});
    const result = await handlers.nr_observe_report_tool_call!({ tool: 'Read', success: true });
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.error).toBe('GenericMcpAdapter not available');
  });

  it('nr_observe_report_tool_call handler returns an error result (not a throw) on invalid input', async () => {
    const { handlers } = registerGenericMcpTools({ genericMcpAdapter: new GenericMcpAdapter() });
    const result = await handlers.nr_observe_report_tool_call!({ success: true });
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.error).toBe('Missing required field: tool');
  });

  it('nr_observe_report_session_start handler round-trips through the adapter', async () => {
    const adapter = new GenericMcpAdapter();
    const { handlers } = registerGenericMcpTools({ genericMcpAdapter: adapter });
    const result = await handlers.nr_observe_report_session_start!({ platform: 'custom-ide' });
    expect(result.isError).toBeUndefined();
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.platform).toBe('custom-ide');
  });

  it('nr_observe_report_session_end handler acknowledges without requiring input', async () => {
    const { handlers } = registerGenericMcpTools({ genericMcpAdapter: new GenericMcpAdapter() });
    const result = await handlers.nr_observe_report_session_end!(undefined);
    expect(result.isError).toBeUndefined();
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.recorded).toBe(true);
  });
});
