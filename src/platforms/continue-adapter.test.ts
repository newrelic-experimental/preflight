import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ContinueAdapter } from './continue-adapter.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  for (const key of [
    'CONTINUE_SESSION_ID',
    'CONTINUE_SERVER_HOST',
    'CONTINUE_VERSION',
    'MCP_CLIENT',
    'MCP_CLIENT_NAME',
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

describe('ContinueAdapter', () => {
  const adapter = new ContinueAdapter();

  it('has platformName "continue"', () => {
    expect(adapter.platformName).toBe('continue');
  });

  describe('normalizeToolCall', () => {
    it('maps "read_file" to "Read"', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'read_file',
        timestamp: 2000,
        success: true,
      });
      expect(normalized.toolName).toBe('Read');
      expect(normalized.platformToolName).toBe('read_file');
      expect(normalized.platform).toBe('continue');
    });

    it('maps "read_file_range" to "Read"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'read_file_range', timestamp: 2000 });
      expect(normalized.toolName).toBe('Read');
    });

    it('maps "read_currently_open_file" to "Read"', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'read_currently_open_file',
        timestamp: 2000,
      });
      expect(normalized.toolName).toBe('Read');
    });

    it('maps "edit_existing_file" to "Edit"', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'edit_existing_file',
        timestamp: 2000,
        filePath: '/src/app.ts',
      });
      expect(normalized.toolName).toBe('Edit');
      expect(normalized.filePath).toBe('/src/app.ts');
    });

    it('maps "single_find_and_replace" to "Edit"', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'single_find_and_replace',
        timestamp: 2000,
      });
      expect(normalized.toolName).toBe('Edit');
    });

    it('maps "multi_edit" to "MultiEdit"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'multi_edit', timestamp: 2000 });
      expect(normalized.toolName).toBe('MultiEdit');
    });

    it('maps "create_new_file" to "Write"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'create_new_file', timestamp: 2000 });
      expect(normalized.toolName).toBe('Write');
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

    it('maps "grep_search" to "Grep"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'grep_search', timestamp: 2000 });
      expect(normalized.toolName).toBe('Grep');
    });

    it('maps "file_glob_search" to "Glob"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'file_glob_search', timestamp: 2000 });
      expect(normalized.toolName).toBe('Glob');
    });

    it('maps "ls" to "Glob"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'ls', timestamp: 2000 });
      expect(normalized.toolName).toBe('Glob');
    });

    it('maps "view_subdirectory" to "Glob"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'view_subdirectory', timestamp: 2000 });
      expect(normalized.toolName).toBe('Glob');
    });

    it('maps "view_repo_map" to "Glob"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'view_repo_map', timestamp: 2000 });
      expect(normalized.toolName).toBe('Glob');
    });

    it('maps "search_web" to "WebSearch"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'search_web', timestamp: 2000 });
      expect(normalized.toolName).toBe('WebSearch');
    });

    it('maps "fetch_url_content" to "WebFetch"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'fetch_url_content', timestamp: 2000 });
      expect(normalized.toolName).toBe('WebFetch');
    });

    it('maps "read_skill" to "Skill"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'read_skill', timestamp: 2000 });
      expect(normalized.toolName).toBe('Skill');
    });

    it('maps unmapped real tool "view_diff" to "Unknown" with platformToolName preserved', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'view_diff', timestamp: 2000 });
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('view_diff');
    });

    it('maps unmapped real tool "create_rule_block" to "Unknown" with platformToolName preserved', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'create_rule_block', timestamp: 2000 });
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('create_rule_block');
    });

    it('maps unmapped real tool "request_rule" to "Unknown" with platformToolName preserved', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'request_rule', timestamp: 2000 });
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('request_rule');
    });

    it('maps unmapped real tool "codebase" to "Unknown" with platformToolName preserved', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'codebase', timestamp: 2000 });
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('codebase');
    });

    it('accepts "toolName" field as an alternative to "tool"', () => {
      const normalized = adapter.normalizeToolCall({ toolName: 'read_file', timestamp: 2000 });
      expect(normalized.toolName).toBe('Read');
      expect(normalized.platformToolName).toBe('read_file');
    });

    it('normalizes filepath (lowercase p) to filePath', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'read_file', filepath: '/src/app.ts' });
      expect(normalized.filePath).toBe('/src/app.ts');
    });

    it('maps unknown tool to "Unknown" with platformToolName preserved', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'custom_continue_tool',
        timestamp: 2000,
      });
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('custom_continue_tool');
    });

    it('defaults missing tool name to "unknown"', () => {
      const normalized = adapter.normalizeToolCall({ timestamp: 2000 });
      expect(normalized.platformToolName).toBe('unknown');
      expect(normalized.toolName).toBe('Unknown');
    });

    it('falls back to safe defaults when raw is not an object (e.g. null)', () => {
      const normalized = adapter.normalizeToolCall(null);
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('unknown');
      expect(normalized.platform).toBe('continue');
      expect(normalized.success).toBe(true);
      expect(normalized.durationMs).toBeNull();
    });

    it('defaults success to true when not provided', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'read_file', timestamp: 2000 });
      expect(normalized.success).toBe(true);
    });

    it('preserves error field', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'edit_existing_file',
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
        sessionId: 'cont-sess-001',
      });
      expect(normalized.sessionId).toBe('cont-sess-001');
    });

    it('does not validate field types — wrong-typed "tool" and "filepath" leak through unchanged', () => {
      const normalized = adapter.normalizeToolCall({ tool: ['read_file'], filepath: 99 });
      expect(normalized.platformToolName).toEqual(['read_file']);
      expect(normalized.filePath).toBe(99);
    });
  });

  describe('getSessionMetadata', () => {
    it('returns platform "continue"', () => {
      const meta = adapter.getSessionMetadata();
      expect(meta.platform).toBe('continue');
    });

    it('includes ideVersion from CONTINUE_VERSION env var', () => {
      process.env.CONTINUE_VERSION = '0.9.200';
      const meta = adapter.getSessionMetadata();
      expect(meta.ideVersion).toBe('0.9.200');
    });

    it('omits ideVersion when CONTINUE_VERSION is unset', () => {
      const meta = adapter.getSessionMetadata();
      expect(meta.ideVersion).toBeUndefined();
    });
  });

  describe('isSupported', () => {
    it('returns true when CONTINUE_SESSION_ID is set', () => {
      process.env.CONTINUE_SESSION_ID = 'abc123';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns true when CONTINUE_SERVER_HOST is set', () => {
      process.env.CONTINUE_SERVER_HOST = 'localhost:3000';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns true when MCP_CLIENT is "continue"', () => {
      process.env.MCP_CLIENT = 'continue';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns true when MCP_CLIENT_NAME is "continue"', () => {
      process.env.MCP_CLIENT_NAME = 'continue';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns false in a non-Continue environment', () => {
      expect(adapter.isSupported()).toBe(false);
    });
  });

  describe('getHookInstallInstructions', () => {
    it('returns non-empty Continue-specific instructions', () => {
      const instructions = adapter.getHookInstallInstructions();
      expect(instructions.length).toBeGreaterThan(0);
      expect(instructions).toContain('Continue');
    });

    it('states that Continue has no hook mechanism', () => {
      expect(adapter.getHookInstallInstructions()).toContain('no hook mechanism');
    });

    it('describes the real MCP server config location', () => {
      expect(adapter.getHookInstallInstructions()).toContain('.continue/mcpServers');
    });

    it('mentions that Continue is no longer actively maintained', () => {
      expect(adapter.getHookInstallInstructions()).toContain('no longer actively maintained');
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
      expect(adapter.mapToolName('totallyMadeUpTool')).toBe('Unknown');
    });

    it('returns "Unknown" for a real but deliberately unmapped tool name', () => {
      expect(adapter.mapToolName('view_diff')).toBe('Unknown');
    });
  });
});
