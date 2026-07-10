import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ZedAdapter } from './zed-adapter.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  for (const key of ['ZED_SESSION_ID', 'ZED_EXTENSION_API_VERSION', 'ZED_ITEM_ID', 'MCP_CLIENT']) {
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

describe('ZedAdapter', () => {
  const adapter = new ZedAdapter();

  it('has platformName "zed"', () => {
    expect(adapter.platformName).toBe('zed');
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
      expect(normalized.platform).toBe('zed');
    });

    it('maps "find_path" to "Glob"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'find_path', timestamp: 2000 });
      expect(normalized.toolName).toBe('Glob');
    });

    it('maps "grep" to "Grep"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'grep', timestamp: 2000 });
      expect(normalized.toolName).toBe('Grep');
    });

    it('maps "list_directory" to "Glob"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'list_directory', timestamp: 2000 });
      expect(normalized.toolName).toBe('Glob');
    });

    it('maps "fetch" to "WebFetch"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'fetch', timestamp: 2000 });
      expect(normalized.toolName).toBe('WebFetch');
    });

    it('maps "search_web" to "WebSearch"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'search_web', timestamp: 2000 });
      expect(normalized.toolName).toBe('WebSearch');
    });

    it('maps "edit_file" to "Edit"', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'edit_file',
        timestamp: 2000,
        filePath: '/src/app.ts',
      });
      expect(normalized.toolName).toBe('Edit');
      expect(normalized.filePath).toBe('/src/app.ts');
    });

    it('maps "write_file" to "Write"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'write_file', timestamp: 2000 });
      expect(normalized.toolName).toBe('Write');
    });

    it('maps "delete_path" to "Delete"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'delete_path', timestamp: 2000 });
      expect(normalized.toolName).toBe('Delete');
    });

    it('maps "terminal" to "Bash"', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'terminal',
        timestamp: 2000,
        command: 'npm test',
      });
      expect(normalized.toolName).toBe('Bash');
      expect(normalized.command).toBe('npm test');
    });

    it('maps "spawn_agent" to "Agent"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'spawn_agent', timestamp: 2000 });
      expect(normalized.toolName).toBe('Agent');
    });

    it('maps "skill" to "Skill"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'skill', timestamp: 2000 });
      expect(normalized.toolName).toBe('Skill');
    });

    it('leaves "diagnostics" unmapped (falls through to "Unknown")', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'diagnostics', timestamp: 2000 });
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('diagnostics');
    });

    it('leaves "copy_path" unmapped (falls through to "Unknown")', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'copy_path', timestamp: 2000 });
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('copy_path');
    });

    it('leaves "move_path" unmapped (falls through to "Unknown")', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'move_path', timestamp: 2000 });
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('move_path');
    });

    it('leaves "create_directory" unmapped (falls through to "Unknown")', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'create_directory', timestamp: 2000 });
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('create_directory');
    });

    it('maps unknown tool to "Unknown" with platformToolName preserved', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'custom_zed_tool', timestamp: 2000 });
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('custom_zed_tool');
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
        sessionId: 'zed-sess-001',
      });
      expect(normalized.sessionId).toBe('zed-sess-001');
    });
  });

  describe('getSessionMetadata', () => {
    it('returns platform "zed"', () => {
      const meta = adapter.getSessionMetadata();
      expect(meta.platform).toBe('zed');
    });

    it('includes ideVersion from ZED_EXTENSION_API_VERSION env var', () => {
      process.env.ZED_EXTENSION_API_VERSION = '0.1.2';
      const meta = adapter.getSessionMetadata();
      expect(meta.ideVersion).toBe('0.1.2');
    });

    it('omits ideVersion when ZED_EXTENSION_API_VERSION is unset', () => {
      const meta = adapter.getSessionMetadata();
      expect(meta.ideVersion).toBeUndefined();
    });
  });

  describe('isSupported', () => {
    it('returns true when ZED_SESSION_ID is set', () => {
      process.env.ZED_SESSION_ID = 'abc123';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns true when ZED_EXTENSION_API_VERSION is set', () => {
      process.env.ZED_EXTENSION_API_VERSION = '0.1.0';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns true when ZED_ITEM_ID is set', () => {
      process.env.ZED_ITEM_ID = 'item-xyz';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns true when MCP_CLIENT is "zed"', () => {
      process.env.MCP_CLIENT = 'zed';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns false in a non-Zed environment', () => {
      expect(adapter.isSupported()).toBe(false);
    });
  });

  describe('getHookInstallInstructions', () => {
    it('returns non-empty Zed-specific instructions', () => {
      const instructions = adapter.getHookInstallInstructions();
      expect(instructions.length).toBeGreaterThan(0);
      expect(instructions).toContain('Zed');
    });

    it('mentions NEW_RELIC_LICENSE_KEY', () => {
      expect(adapter.getHookInstallInstructions()).toContain('NEW_RELIC_LICENSE_KEY');
    });

    it('mentions NEW_RELIC_ACCOUNT_ID', () => {
      expect(adapter.getHookInstallInstructions()).toContain('NEW_RELIC_ACCOUNT_ID');
    });

    it('states Zed has no hook mechanism instead of claiming automatic capture', () => {
      const instructions = adapter.getHookInstallInstructions();
      expect(instructions).toContain('no hook mechanism');
    });

    it('documents the real context_servers settings key', () => {
      expect(adapter.getHookInstallInstructions()).toContain('context_servers');
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

    it('maps "terminal" to "Bash"', () => {
      expect(adapter.mapToolName('terminal')).toBe('Bash');
    });

    it('returns "Unknown" for a real Zed tool with no canonical equivalent', () => {
      expect(adapter.mapToolName('diagnostics')).toBe('Unknown');
    });

    it('returns "Unknown" for an unrecognized tool name', () => {
      expect(adapter.mapToolName('totally_made_up_tool')).toBe('Unknown');
    });
  });
});
