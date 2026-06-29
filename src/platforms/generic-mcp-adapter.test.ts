import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  GenericMcpAdapter,
  validateReportToolCallInput,
  REPORT_TOOL_CALL_TOOL,
  REPORT_SESSION_START_TOOL,
  REPORT_SESSION_END_TOOL,
} from './generic-mcp-adapter.js';
import type { ReportToolCallInput } from './generic-mcp-adapter.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

describe('GenericMcpAdapter', () => {
  let adapter: GenericMcpAdapter;

  beforeEach(() => {
    adapter = new GenericMcpAdapter();
  });

  it('has platformName "generic-mcp"', () => {
    expect(adapter.platformName).toBe('generic-mcp');
  });

  describe('normalizeToolCall', () => {
    it('converts a complete report_tool_call input to NormalizedToolCall', () => {
      const input: ReportToolCallInput = {
        tool: 'Read',
        input: { file_path: '/src/app.ts' },
        output_size_bytes: 1024,
        success: true,
        duration_ms: 50,
        timestamp: 8000,
      };
      const normalized = adapter.normalizeToolCall(input);

      expect(normalized.toolName).toBe('Read');
      expect(normalized.platformToolName).toBe('Read');
      expect(normalized.platform).toBe('generic-mcp');
      expect(normalized.timestamp).toBe(8000);
      expect(normalized.durationMs).toBe(50);
      expect(normalized.success).toBe(true);
      expect(normalized.outputSizeBytes).toBe(1024);
      expect(normalized.filePath).toBe('/src/app.ts');
    });

    it('applies defaults for missing optional fields', () => {
      const before = Date.now();
      const normalized = adapter.normalizeToolCall({ tool: 'Edit', success: true });
      const after = Date.now();

      expect(normalized.toolName).toBe('Edit');
      expect(normalized.durationMs).toBeNull();
      expect(normalized.timestamp).toBeGreaterThanOrEqual(before);
      expect(normalized.timestamp).toBeLessThanOrEqual(after);
      expect(normalized.outputSizeBytes).toBeUndefined();
      expect(normalized.filePath).toBeUndefined();
      expect(normalized.command).toBeUndefined();
    });

    it('extracts command from input when present', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'Bash',
        input: { command: 'npm test' },
        success: true,
        timestamp: 8000,
      });
      expect(normalized.command).toBe('npm test');
    });

    it('preserves error field', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'Edit',
        success: false,
        error: 'permission denied',
        timestamp: 8000,
      });
      expect(normalized.success).toBe(false);
      expect(normalized.error).toBe('permission denied');
    });

    it('throws on missing required tool field', () => {
      expect(() => adapter.normalizeToolCall({ success: true })).toThrow(
        'Missing required field: tool',
      );
    });

    it('throws on empty tool field', () => {
      expect(() => adapter.normalizeToolCall({ tool: '', success: true })).toThrow(
        'Missing required field: tool',
      );
    });

    it('throws on missing required success field', () => {
      expect(() => adapter.normalizeToolCall({ tool: 'Read' })).toThrow(
        'Missing required field: success',
      );
    });

    it('throws on non-object input', () => {
      expect(() => adapter.normalizeToolCall(null)).toThrow('Input must be an object');
      expect(() => adapter.normalizeToolCall('string')).toThrow('Input must be an object');
      expect(() => adapter.normalizeToolCall(42)).toThrow('Input must be an object');
    });

    it('uses platform from session metadata after session start', () => {
      adapter.handleSessionStart({ platform: 'my-custom-ide' });
      const normalized = adapter.normalizeToolCall({
        tool: 'Read',
        success: true,
        timestamp: 8000,
      });
      expect(normalized.platform).toBe('my-custom-ide');
    });
  });

  describe('handleSessionStart', () => {
    it('initializes session metadata correctly', () => {
      adapter.handleSessionStart({
        platform: 'custom-assistant',
        model: 'gpt-4o',
        developer: 'alice',
      });
      const meta = adapter.getSessionMetadata();
      expect(meta.platform).toBe('custom-assistant');
      expect(meta.model).toBe('gpt-4o');
      expect(meta.developer).toBe('alice');
    });

    it('omits developer from metadata when not provided', () => {
      adapter.handleSessionStart({ platform: 'custom-assistant' });
      const meta = adapter.getSessionMetadata();
      expect('developer' in meta).toBe(false);
    });

    it('defaults platform to "generic-mcp" when empty string provided', () => {
      adapter.handleSessionStart({ platform: '' });
      const meta = adapter.getSessionMetadata();
      expect(meta.platform).toBe('generic-mcp');
    });
  });

  describe('getSessionMetadata', () => {
    it('returns default platform "generic-mcp" before session start', () => {
      const meta = adapter.getSessionMetadata();
      expect(meta.platform).toBe('generic-mcp');
    });

    it('returns a copy (not a reference)', () => {
      const meta1 = adapter.getSessionMetadata();
      const meta2 = adapter.getSessionMetadata();
      expect(meta1).not.toBe(meta2);
      expect(meta1).toEqual(meta2);
    });
  });

  describe('isSupported', () => {
    it('always returns true', () => {
      expect(adapter.isSupported()).toBe(true);
    });
  });

  describe('getHookInstallInstructions', () => {
    it('returns non-empty generic MCP instructions', () => {
      const instructions = adapter.getHookInstallInstructions();
      expect(instructions.length).toBeGreaterThan(0);
      expect(instructions).toContain('MCP');
      expect(instructions).toContain('report_tool_call');
    });
  });

  describe('initialize', () => {
    it('completes without error', async () => {
      await expect(adapter.initialize({})).resolves.toBeUndefined();
    });
  });

  describe('getToolDefinitions', () => {
    it('returns the three reporting tools', () => {
      const tools = adapter.getToolDefinitions();
      expect(tools).toHaveLength(3);
      expect(tools[0].name).toBe('nr_observe_report_tool_call');
      expect(tools[1].name).toBe('nr_observe_report_session_start');
      expect(tools[2].name).toBe('nr_observe_report_session_end');
    });
  });

  describe('integration: report_tool_call pipeline', () => {
    it('processes 10 tool calls through normalizeToolCall', () => {
      const results = [];
      for (let i = 0; i < 10; i++) {
        const normalized = adapter.normalizeToolCall({
          tool: i % 2 === 0 ? 'Read' : 'Edit',
          success: true,
          duration_ms: 10 + i,
          timestamp: 8000 + i * 100,
        });
        results.push(normalized);
      }

      expect(results).toHaveLength(10);
      expect(results.every((r) => r.platform === 'generic-mcp')).toBe(true);
      expect(results.filter((r) => r.toolName === 'Read')).toHaveLength(5);
      expect(results.filter((r) => r.toolName === 'Edit')).toHaveLength(5);
      expect(results[0].durationMs).toBe(10);
      expect(results[9].durationMs).toBe(19);
    });
  });
});

describe('validateReportToolCallInput', () => {
  it('passes valid input through', () => {
    const input = { tool: 'Read', success: true, duration_ms: 50 };
    const result = validateReportToolCallInput(input);
    expect(result.tool).toBe('Read');
    expect(result.success).toBe(true);
    expect(result.duration_ms).toBe(50);
  });

  it('rejects null', () => {
    expect(() => validateReportToolCallInput(null)).toThrow('Input must be an object');
  });

  it('rejects non-object', () => {
    expect(() => validateReportToolCallInput('string')).toThrow('Input must be an object');
  });

  it('rejects missing tool', () => {
    expect(() => validateReportToolCallInput({ success: true })).toThrow(
      'Missing required field: tool',
    );
  });

  it('rejects missing success', () => {
    expect(() => validateReportToolCallInput({ tool: 'Read' })).toThrow(
      'Missing required field: success',
    );
  });

  it('rejects non-numeric duration_ms', () => {
    expect(() =>
      validateReportToolCallInput({ tool: 'Read', success: true, duration_ms: 'not-a-number' }),
    ).toThrow('Field duration_ms must be a number when present');
  });

  it('rejects non-numeric input_size_bytes', () => {
    expect(() =>
      validateReportToolCallInput({ tool: 'Read', success: true, input_size_bytes: 'large' }),
    ).toThrow('Field input_size_bytes must be a number when present');
  });

  it('rejects non-numeric output_size_bytes', () => {
    expect(() =>
      validateReportToolCallInput({ tool: 'Read', success: true, output_size_bytes: '1024' }),
    ).toThrow('Field output_size_bytes must be a number when present');
  });

  it('rejects non-numeric timestamp', () => {
    expect(() =>
      validateReportToolCallInput({ tool: 'Read', success: true, timestamp: '2000' }),
    ).toThrow('Field timestamp must be a number when present');
  });

  it('rejects non-string error', () => {
    expect(() => validateReportToolCallInput({ tool: 'Read', success: false, error: 42 })).toThrow(
      'Field error must be a string when present',
    );
  });

  it('rejects non-object input field', () => {
    expect(() =>
      validateReportToolCallInput({ tool: 'Read', success: true, input: 'string' }),
    ).toThrow('Field input must be an object when present');
  });

  it('accepts valid optional numeric and string fields', () => {
    const input = {
      tool: 'Read',
      success: true,
      duration_ms: 100,
      input_size_bytes: 512,
      output_size_bytes: 1024,
      timestamp: 1000,
      error: 'timeout',
      input: { file_path: '/test' },
    };
    const result = validateReportToolCallInput(input);
    expect(result.duration_ms).toBe(100);
    expect(result.input_size_bytes).toBe(512);
    expect(result.output_size_bytes).toBe(1024);
    expect(result.timestamp).toBe(1000);
    expect(result.error).toBe('timeout');
    expect(result.input).toEqual({ file_path: '/test' });
  });
});

describe('tool definitions', () => {
  it('REPORT_TOOL_CALL_TOOL has required fields', () => {
    expect(REPORT_TOOL_CALL_TOOL.inputSchema.required).toContain('tool');
    expect(REPORT_TOOL_CALL_TOOL.inputSchema.required).toContain('success');
  });

  it('REPORT_SESSION_START_TOOL has required platform', () => {
    expect(REPORT_SESSION_START_TOOL.inputSchema.required).toContain('platform');
  });

  it('REPORT_SESSION_END_TOOL has optional summary', () => {
    expect(REPORT_SESSION_END_TOOL.inputSchema.properties).toHaveProperty('summary');
  });
});
