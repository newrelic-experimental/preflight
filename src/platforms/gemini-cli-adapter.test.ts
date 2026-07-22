import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { GeminiCliAdapter } from './gemini-cli-adapter.js';

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

describe('GeminiCliAdapter', () => {
  const adapter = new GeminiCliAdapter();

  it('has platformName "gemini-cli"', () => {
    expect(adapter.platformName).toBe('gemini-cli');
  });

  it('declares visibilityLevel "full-hooks"', () => {
    expect(adapter.visibilityLevel).toBe('full-hooks');
  });

  it('declares GEMINI.md as an instruction file path', () => {
    expect(adapter.capabilities.instructionFilePaths).toEqual(['GEMINI.md']);
  });

  describe('normalizeToolCall', () => {
    it('maps "read_file" to "Read"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'read_file', timestamp: 2000 });
      expect(normalized.toolName).toBe('Read');
      expect(normalized.platformToolName).toBe('read_file');
      expect(normalized.platform).toBe('gemini-cli');
    });

    it('maps "write_file" to "Write"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'write_file', timestamp: 2000 });
      expect(normalized.toolName).toBe('Write');
    });

    it('maps "replace" to "Edit"', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'replace',
        timestamp: 2000,
        filePath: '/src/app.ts',
      });
      expect(normalized.toolName).toBe('Edit');
      expect(normalized.filePath).toBe('/src/app.ts');
    });

    it('maps "run_shell_command" to "Bash"', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'run_shell_command',
        timestamp: 2000,
        command: 'npm test',
      });
      expect(normalized.toolName).toBe('Bash');
      expect(normalized.command).toBe('npm test');
    });

    it('maps "glob" to "Glob"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'glob', timestamp: 2000 });
      expect(normalized.toolName).toBe('Glob');
    });

    it('maps "grep_search" to "Grep"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'grep_search', timestamp: 2000 });
      expect(normalized.toolName).toBe('Grep');
    });

    it('maps "google_web_search" to "WebSearch"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'google_web_search', timestamp: 2000 });
      expect(normalized.toolName).toBe('WebSearch');
    });

    it('maps "web_fetch" to "WebFetch"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'web_fetch', timestamp: 2000 });
      expect(normalized.toolName).toBe('WebFetch');
    });

    it('maps "list_directory" to "Unknown" with platformToolName preserved (no Claude Code equivalent)', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'list_directory', timestamp: 2000 });
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('list_directory');
    });

    it('accepts "toolName" field as an alternative to "tool"', () => {
      const normalized = adapter.normalizeToolCall({ toolName: 'read_file', timestamp: 2000 });
      expect(normalized.toolName).toBe('Read');
      expect(normalized.platformToolName).toBe('read_file');
    });

    it('normalizes path to filePath', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'read_file', path: '/src/app.ts' });
      expect(normalized.filePath).toBe('/src/app.ts');
    });

    it('maps unknown tool to "Unknown" with platformToolName preserved', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'mcp_github_search',
        timestamp: 2000,
      });
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('mcp_github_search');
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
      expect(normalized.platform).toBe('gemini-cli');
      expect(normalized.success).toBe(true);
      expect(normalized.durationMs).toBeNull();
    });

    it('defaults success to true when not provided', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'read_file', timestamp: 2000 });
      expect(normalized.success).toBe(true);
    });

    it('preserves error field', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'replace',
        timestamp: 2000,
        success: false,
        error: 'file not found',
      });
      expect(normalized.success).toBe(false);
      expect(normalized.error).toBe('file not found');
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
        sessionId: 'gemini-sess-001',
      });
      expect(normalized.sessionId).toBe('gemini-sess-001');
    });
  });

  describe('getSessionMetadata', () => {
    it('returns platform "gemini-cli"', () => {
      const meta = adapter.getSessionMetadata();
      expect(meta.platform).toBe('gemini-cli');
    });
  });

  describe('isSupported', () => {
    it('returns true when MCP_CLIENT is "gemini-cli"', () => {
      process.env.MCP_CLIENT = 'gemini-cli';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns true when NEW_RELIC_AI_PLATFORM is "gemini-cli"', () => {
      process.env.NEW_RELIC_AI_PLATFORM = 'gemini-cli';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns false in a non-Gemini-CLI environment', () => {
      expect(adapter.isSupported()).toBe(false);
    });
  });

  describe('getHookInstallInstructions', () => {
    it('returns non-empty Gemini CLI-specific instructions', () => {
      const instructions = adapter.getHookInstallInstructions();
      expect(instructions.length).toBeGreaterThan(0);
      expect(instructions).toContain('Gemini CLI');
    });

    it('references settings.json', () => {
      expect(adapter.getHookInstallInstructions()).toContain('settings.json');
    });

    it('mentions NEW_RELIC_LICENSE_KEY', () => {
      expect(adapter.getHookInstallInstructions()).toContain('NEW_RELIC_LICENSE_KEY');
    });

    it('mentions NEW_RELIC_ACCOUNT_ID', () => {
      expect(adapter.getHookInstallInstructions()).toContain('NEW_RELIC_ACCOUNT_ID');
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
