import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ClineAdapter } from './cline-adapter.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  for (const key of ['MCP_CLIENT', 'NEW_RELIC_AI_PLATFORM']) {
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

describe('ClineAdapter', () => {
  const adapter = new ClineAdapter();

  it('has platformName "cline"', () => {
    expect(adapter.platformName).toBe('cline');
  });

  it('declares visibilityLevel "mcp-tools-only"', () => {
    expect(adapter.visibilityLevel).toBe('mcp-tools-only');
  });

  it('declares .clinerules/ as an instruction file path', () => {
    expect(adapter.capabilities.instructionFilePaths).toEqual(['.clinerules/']);
  });

  describe('normalizeToolCall', () => {
    it('maps "execute_command" to "Bash"', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'execute_command',
        timestamp: 2000,
        command: 'npm test',
      });
      expect(normalized.toolName).toBe('Bash');
      expect(normalized.platformToolName).toBe('execute_command');
      expect(normalized.platform).toBe('cline');
      expect(normalized.command).toBe('npm test');
    });

    it('maps "read_file" to "Read"', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'read_file',
        timestamp: 2000,
        filePath: '/src/app.ts',
      });
      expect(normalized.toolName).toBe('Read');
      expect(normalized.filePath).toBe('/src/app.ts');
    });

    it('maps "replace_in_file" to "Edit"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'replace_in_file', timestamp: 2000 });
      expect(normalized.toolName).toBe('Edit');
    });

    it('leaves "write_to_file" unmapped (falls through to "Unknown")', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'write_to_file', timestamp: 2000 });
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('write_to_file');
    });

    it('leaves "search_files" unmapped (falls through to "Unknown")', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'search_files', timestamp: 2000 });
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('search_files');
    });

    it('leaves "list_files" unmapped (falls through to "Unknown")', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'list_files', timestamp: 2000 });
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('list_files');
    });

    it('leaves "browser_action" unmapped (falls through to "Unknown")', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'browser_action', timestamp: 2000 });
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('browser_action');
    });

    it('leaves "use_mcp_tool" unmapped (falls through to "Unknown")', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'use_mcp_tool', timestamp: 2000 });
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('use_mcp_tool');
    });

    it('leaves "ask_followup_question" unmapped (falls through to "Unknown")', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'ask_followup_question',
        timestamp: 2000,
      });
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('ask_followup_question');
    });

    it('leaves "attempt_completion" unmapped (falls through to "Unknown")', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'attempt_completion', timestamp: 2000 });
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('attempt_completion');
    });

    it('leaves "new_task" unmapped (falls through to "Unknown")', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'new_task', timestamp: 2000 });
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('new_task');
    });

    it('leaves "plan_mode_respond" unmapped (falls through to "Unknown")', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'plan_mode_respond', timestamp: 2000 });
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('plan_mode_respond');
    });

    it('maps unknown tool to "Unknown" with platformToolName preserved', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'custom_cline_tool', timestamp: 2000 });
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('custom_cline_tool');
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
        tool: 'replace_in_file',
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
        sessionId: 'cline-sess-001',
      });
      expect(normalized.sessionId).toBe('cline-sess-001');
    });

    it('falls back to safe defaults when raw is not an object (e.g. null)', () => {
      const normalized = adapter.normalizeToolCall(null);
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('unknown');
      expect(normalized.platform).toBe('cline');
      expect(normalized.success).toBe(true);
      expect(normalized.durationMs).toBeNull();
    });

    it('does not validate field types — a numeric "sessionId" leaks through unchanged', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'read_file', sessionId: 42 });
      expect(normalized.sessionId).toBe(42);
    });
  });

  describe('getSessionMetadata', () => {
    it('returns platform "cline" with no extra fields', () => {
      const meta = adapter.getSessionMetadata();
      expect(meta).toEqual({ platform: 'cline' });
    });
  });

  describe('isSupported', () => {
    it('returns true when MCP_CLIENT is "cline"', () => {
      process.env.MCP_CLIENT = 'cline';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns true when NEW_RELIC_AI_PLATFORM is "cline"', () => {
      process.env.NEW_RELIC_AI_PLATFORM = 'cline';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns false in a non-Cline environment', () => {
      expect(adapter.isSupported()).toBe(false);
    });
  });

  describe('getHookInstallInstructions', () => {
    it('returns non-empty Cline-specific instructions', () => {
      const instructions = adapter.getHookInstallInstructions();
      expect(instructions.length).toBeGreaterThan(0);
      expect(instructions).toContain('Cline');
    });

    it('mentions NEW_RELIC_LICENSE_KEY', () => {
      expect(adapter.getHookInstallInstructions()).toContain('NEW_RELIC_LICENSE_KEY');
    });

    it('mentions NEW_RELIC_ACCOUNT_ID', () => {
      expect(adapter.getHookInstallInstructions()).toContain('NEW_RELIC_ACCOUNT_ID');
    });

    it('states Cline has no hook mechanism instead of claiming automatic capture', () => {
      expect(adapter.getHookInstallInstructions()).toContain('no hook mechanism');
    });

    it('documents the real mcpServers settings key', () => {
      expect(adapter.getHookInstallInstructions()).toContain('mcpServers');
    });

    it('documents the MCP_CLIENT=cline opt-in env var', () => {
      expect(adapter.getHookInstallInstructions()).toContain('MCP_CLIENT');
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

    it('maps "execute_command" to "Bash"', () => {
      expect(adapter.mapToolName('execute_command')).toBe('Bash');
    });

    it('returns "Unknown" for a real Cline tool with no canonical equivalent', () => {
      expect(adapter.mapToolName('browser_action')).toBe('Unknown');
    });

    it('returns "Unknown" for an unrecognized tool name', () => {
      expect(adapter.mapToolName('totally_made_up_tool')).toBe('Unknown');
    });
  });
});
