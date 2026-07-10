import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { WindsurfAdapter } from './windsurf-adapter.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  for (const key of [
    'WINDSURF_SESSION_ID',
    'WINDSURF_CONTEXT_ID',
    'WINDSURF_VERSION',
    'MCP_CLIENT',
  ]) {
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

describe('WindsurfAdapter', () => {
  const adapter = new WindsurfAdapter();

  it('has platformName "windsurf"', () => {
    expect(adapter.platformName).toBe('windsurf');
  });

  describe('normalizeToolCall', () => {
    it('maps "Read File" to "Read"', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'Read File',
        timestamp: 3000,
        success: true,
        filePath: '/src/app.ts',
      });
      expect(normalized.toolName).toBe('Read');
      expect(normalized.platformToolName).toBe('Read File');
      expect(normalized.platform).toBe('windsurf');
      expect(normalized.filePath).toBe('/src/app.ts');
    });

    it('maps "Write File" to "Write"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'Write File', timestamp: 3000 });
      expect(normalized.toolName).toBe('Write');
      expect(normalized.platformToolName).toBe('Write File');
    });

    it('maps "Edit File" to "Edit"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'Edit File', timestamp: 3000 });
      expect(normalized.toolName).toBe('Edit');
    });

    it('maps delete_file to "Delete" not "Write"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'delete_file', timestamp: 3000 });
      expect(normalized.toolName).toBe('Delete');
    });

    it('maps "Run Command" to "Bash"', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'Run Command',
        timestamp: 3000,
        command: 'npm test',
      });
      expect(normalized.toolName).toBe('Bash');
      expect(normalized.command).toBe('npm test');
    });

    it('maps "Search" to "Grep"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'Search', timestamp: 3000 });
      expect(normalized.toolName).toBe('Grep');
    });

    it('maps snake_case "read_file" to "Read"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'read_file', timestamp: 3000 });
      expect(normalized.toolName).toBe('Read');
    });

    it('maps snake_case "run_command" to "Bash"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'run_command', timestamp: 3000 });
      expect(normalized.toolName).toBe('Bash');
    });

    it('maps unknown action to "Unknown" with platformToolName preserved', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'Cascade Special Action',
        timestamp: 3000,
      });
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('Cascade Special Action');
    });

    it('defaults missing tool name to "unknown"', () => {
      const normalized = adapter.normalizeToolCall({ timestamp: 3000 });
      expect(normalized.platformToolName).toBe('unknown');
      expect(normalized.toolName).toBe('Unknown');
    });

    it('defaults success to true when not provided', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'Read File', timestamp: 3000 });
      expect(normalized.success).toBe(true);
    });

    it('preserves error field', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'Write File',
        timestamp: 3000,
        success: false,
        error: 'disk full',
      });
      expect(normalized.success).toBe(false);
      expect(normalized.error).toBe('disk full');
    });

    it('uses current time when timestamp is missing', () => {
      const before = Date.now();
      const normalized = adapter.normalizeToolCall({ tool: 'Read File' });
      const after = Date.now();
      expect(normalized.timestamp).toBeGreaterThanOrEqual(before);
      expect(normalized.timestamp).toBeLessThanOrEqual(after);
    });

    it('includes inputSizeBytes and outputSizeBytes when present', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'Read File',
        timestamp: 3000,
        inputSizeBytes: 50,
        outputSizeBytes: 2000,
      });
      expect(normalized.inputSizeBytes).toBe(50);
      expect(normalized.outputSizeBytes).toBe(2000);
    });

    it('includes sessionId when present', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'Read File',
        timestamp: 3000,
        sessionId: 'windsurf-sess-001',
      });
      expect(normalized.sessionId).toBe('windsurf-sess-001');
    });

    it('sets durationMs to null when not provided', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'Read File', timestamp: 3000 });
      expect(normalized.durationMs).toBeNull();
    });

    it('preserves durationMs when provided', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'Read File',
        timestamp: 3000,
        durationMs: 150,
      });
      expect(normalized.durationMs).toBe(150);
    });
  });

  describe('getSessionMetadata', () => {
    it('returns platform "windsurf"', () => {
      const meta = adapter.getSessionMetadata();
      expect(meta.platform).toBe('windsurf');
    });

    it('includes ideVersion from WINDSURF_VERSION env var', () => {
      process.env.WINDSURF_VERSION = '1.5.0';
      const meta = adapter.getSessionMetadata();
      expect(meta.ideVersion).toBe('1.5.0');
    });

    it('omits ideVersion when WINDSURF_VERSION is unset', () => {
      const meta = adapter.getSessionMetadata();
      expect(meta.ideVersion).toBeUndefined();
    });
  });

  describe('isSupported', () => {
    it('returns true when WINDSURF_SESSION_ID is set', () => {
      process.env.WINDSURF_SESSION_ID = 'ws-abc123';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns true when WINDSURF_CONTEXT_ID is set', () => {
      process.env.WINDSURF_CONTEXT_ID = 'ctx-xyz';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns true when MCP_CLIENT is "windsurf"', () => {
      process.env.MCP_CLIENT = 'windsurf';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns false in a non-Windsurf environment', () => {
      expect(adapter.isSupported()).toBe(false);
    });
  });

  describe('getHookInstallInstructions', () => {
    it('returns non-empty Windsurf-specific MCP configuration', () => {
      const instructions = adapter.getHookInstallInstructions();
      expect(instructions.length).toBeGreaterThan(0);
      expect(instructions).toContain('Windsurf');
      expect(instructions).toContain('MCP');
    });

    it('documents the real .windsurf/hooks.json Cascade Hooks system for built-in tool calls', () => {
      const instructions = adapter.getHookInstallInstructions();
      expect(instructions).toContain('hooks.json');
      expect(instructions).not.toContain('file watcher');
      expect(instructions).not.toContain('extension');
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
  });
});
