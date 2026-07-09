import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { CursorAdapter } from './cursor-adapter.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  for (const key of ['CURSOR_SESSION_ID', 'CURSOR_TRACE_ID', 'CURSOR_VERSION', 'MCP_CLIENT']) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  stderrSpy.mockRestore();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('CursorAdapter', () => {
  const adapter = new CursorAdapter();

  it('has platformName "cursor"', () => {
    expect(adapter.platformName).toBe('cursor');
  });

  describe('normalizeToolCall', () => {
    it('maps "edit_file" to "Edit"', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'edit_file',
        timestamp: 2000,
        success: true,
        filePath: '/src/app.ts',
      });
      expect(normalized.toolName).toBe('Edit');
      expect(normalized.platformToolName).toBe('edit_file');
      expect(normalized.platform).toBe('cursor');
      expect(normalized.filePath).toBe('/src/app.ts');
    });

    it('maps "read_file" to "Read"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'read_file', timestamp: 2000 });
      expect(normalized.toolName).toBe('Read');
      expect(normalized.platformToolName).toBe('read_file');
    });

    it('maps "run_terminal_command" to "Bash"', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'run_terminal_command',
        timestamp: 2000,
        command: 'npm test',
      });
      expect(normalized.toolName).toBe('Bash');
      expect(normalized.command).toBe('npm test');
    });

    it('maps "search" to "Grep"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'search', timestamp: 2000 });
      expect(normalized.toolName).toBe('Grep');
    });

    it('maps "grep_search" to "Grep"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'grep_search', timestamp: 2000 });
      expect(normalized.toolName).toBe('Grep');
    });

    it('maps "codebase_search" to "Grep"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'codebase_search', timestamp: 2000 });
      expect(normalized.toolName).toBe('Grep');
    });

    it('maps "list_directory" to "Glob"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'list_directory', timestamp: 2000 });
      expect(normalized.toolName).toBe('Glob');
    });

    it('maps "delete_file" to "Delete" not "Write"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'delete_file', timestamp: 2000 });
      expect(normalized.toolName).toBe('Delete');
    });

    it('maps unknown tool to "Unknown" with platformToolName preserved', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'custom_cursor_tool',
        timestamp: 2000,
      });
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('custom_cursor_tool');
    });

    it('defaults missing tool name to "unknown"', () => {
      const normalized = adapter.normalizeToolCall({ timestamp: 2000 });
      expect(normalized.platformToolName).toBe('unknown');
      expect(normalized.toolName).toBe('Unknown');
    });

    it('defaults success to true when not provided', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'read_file', timestamp: 2000 });
      expect(normalized.success).toBe(true);
    });

    it('preserves error field', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'edit_file',
        timestamp: 2000,
        success: false,
        error: 'permission denied',
      });
      expect(normalized.success).toBe(false);
      expect(normalized.error).toBe('permission denied');
    });

    it('uses current time when timestamp is missing', () => {
      const before = Date.now();
      const normalized = adapter.normalizeToolCall({ tool: 'read_file' });
      const after = Date.now();
      expect(normalized.timestamp).toBeGreaterThanOrEqual(before);
      expect(normalized.timestamp).toBeLessThanOrEqual(after);
    });

    it('includes inputSizeBytes and outputSizeBytes when present', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'read_file',
        timestamp: 2000,
        inputSizeBytes: 50,
        outputSizeBytes: 1000,
      });
      expect(normalized.inputSizeBytes).toBe(50);
      expect(normalized.outputSizeBytes).toBe(1000);
    });

    it('includes sessionId when present', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'read_file',
        timestamp: 2000,
        sessionId: 'cursor-sess-001',
      });
      expect(normalized.sessionId).toBe('cursor-sess-001');
    });
  });

  describe('getSessionMetadata', () => {
    it('returns platform "cursor"', () => {
      const meta = adapter.getSessionMetadata();
      expect(meta.platform).toBe('cursor');
    });

    it('includes ideVersion from CURSOR_VERSION env var', () => {
      process.env.CURSOR_VERSION = '0.42.0';
      const meta = adapter.getSessionMetadata();
      expect(meta.ideVersion).toBe('0.42.0');
    });

    it('omits ideVersion when CURSOR_VERSION is unset', () => {
      const meta = adapter.getSessionMetadata();
      expect(meta.ideVersion).toBeUndefined();
    });
  });

  describe('isSupported', () => {
    it('returns true when CURSOR_SESSION_ID is set', () => {
      process.env.CURSOR_SESSION_ID = 'abc123';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns true when CURSOR_TRACE_ID is set', () => {
      process.env.CURSOR_TRACE_ID = 'trace-xyz';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns true when MCP_CLIENT is "cursor"', () => {
      process.env.MCP_CLIENT = 'cursor';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns false in a non-Cursor environment', () => {
      expect(adapter.isSupported()).toBe(false);
    });
  });

  describe('getHookInstallInstructions', () => {
    it('returns non-empty Cursor-specific instructions', () => {
      const instructions = adapter.getHookInstallInstructions();
      expect(instructions.length).toBeGreaterThan(0);
      expect(instructions).toContain('Cursor');
    });

    it('documents the real .cursor/hooks.json setup, not a file watcher', () => {
      const instructions = adapter.getHookInstallInstructions();
      expect(instructions).toContain('.cursor/hooks.json');
      expect(instructions).toContain('preflight-collector');
      expect(instructions).not.toContain('file watcher');
    });
  });

  describe('initialize', () => {
    it('completes without error', async () => {
      await expect(adapter.initialize({})).resolves.toBeUndefined();
    });
  });

  describe('mapToolName', () => {
    it('maps a known tool name', () => {
      expect(adapter.mapToolName('read_file')).toBe('Read');
    });

    it('returns "Unknown" for an unrecognized tool name', () => {
      expect(adapter.mapToolName('totally_made_up_tool')).toBe('Unknown');
    });

    it('maps the generic preToolUse/postToolUse "Shell" category to "Bash"', () => {
      expect(adapter.mapToolName('Shell')).toBe('Bash');
    });

    it('maps the generic preToolUse/postToolUse "Task" category to "Agent"', () => {
      expect(adapter.mapToolName('Task')).toBe('Agent');
    });

    it('maps the generic preToolUse/postToolUse "Read" category to "Read"', () => {
      expect(adapter.mapToolName('Read')).toBe('Read');
    });

    it('maps the generic preToolUse/postToolUse "Write" category to "Write"', () => {
      expect(adapter.mapToolName('Write')).toBe('Write');
    });
  });
});
