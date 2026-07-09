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
    it('maps "readFile" to "Read"', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'readFile',
        timestamp: 2000,
        success: true,
      });
      expect(normalized.toolName).toBe('Read');
      expect(normalized.platformToolName).toBe('readFile');
      expect(normalized.platform).toBe('continue');
    });

    it('maps "writeFile" to "Write"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'writeFile', timestamp: 2000 });
      expect(normalized.toolName).toBe('Write');
    });

    it('maps "editFile" to "Edit"', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'editFile',
        timestamp: 2000,
        filePath: '/src/app.ts',
      });
      expect(normalized.toolName).toBe('Edit');
      expect(normalized.filePath).toBe('/src/app.ts');
    });

    it('maps "createFile" to "Write"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'createFile', timestamp: 2000 });
      expect(normalized.toolName).toBe('Write');
    });

    it('maps "deleteFile" to "Delete"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'deleteFile', timestamp: 2000 });
      expect(normalized.toolName).toBe('Delete');
    });

    it('maps "searchFiles" to "Glob"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'searchFiles', timestamp: 2000 });
      expect(normalized.toolName).toBe('Glob');
    });

    it('maps "grep" to "Grep"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'grep', timestamp: 2000 });
      expect(normalized.toolName).toBe('Grep');
    });

    it('maps "grepSearch" to "Grep"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'grepSearch', timestamp: 2000 });
      expect(normalized.toolName).toBe('Grep');
    });

    it('maps "fileSearch" to "Glob"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'fileSearch', timestamp: 2000 });
      expect(normalized.toolName).toBe('Glob');
    });

    it('maps "runTerminalCommand" to "Bash"', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'runTerminalCommand',
        timestamp: 2000,
        command: 'npm test',
      });
      expect(normalized.toolName).toBe('Bash');
      expect(normalized.command).toBe('npm test');
    });

    it('maps "terminal" to "Bash"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'terminal', timestamp: 2000 });
      expect(normalized.toolName).toBe('Bash');
    });

    it('maps "viewSubdirectory" to "Glob"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'viewSubdirectory', timestamp: 2000 });
      expect(normalized.toolName).toBe('Glob');
    });

    it('maps "viewRepoMap" to "Glob"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'viewRepoMap', timestamp: 2000 });
      expect(normalized.toolName).toBe('Glob');
    });

    it('accepts "toolName" field as an alternative to "tool"', () => {
      const normalized = adapter.normalizeToolCall({ toolName: 'readFile', timestamp: 2000 });
      expect(normalized.toolName).toBe('Read');
      expect(normalized.platformToolName).toBe('readFile');
    });

    it('normalizes filepath (lowercase p) to filePath', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'readFile', filepath: '/src/app.ts' });
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

    it('defaults success to true when not provided', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'readFile', timestamp: 2000 });
      expect(normalized.success).toBe(true);
    });

    it('preserves error field', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'editFile',
        timestamp: 2000,
        success: false,
        error: 'permission denied',
      });
      expect(normalized.success).toBe(false);
      expect(normalized.error).toBe('permission denied');
    });

    it('uses current time when timestamp is missing', () => {
      const before = Date.now();
      const normalized = adapter.normalizeToolCall({ tool: 'readFile' });
      const after = Date.now();
      expect(normalized.timestamp).toBeGreaterThanOrEqual(before);
      expect(normalized.timestamp).toBeLessThanOrEqual(after);
    });

    it('includes inputSizeBytes and outputSizeBytes when present', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'readFile',
        timestamp: 2000,
        inputSizeBytes: 50,
        outputSizeBytes: 1000,
      });
      expect(normalized.inputSizeBytes).toBe(50);
      expect(normalized.outputSizeBytes).toBe(1000);
    });

    it('includes sessionId when present', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'readFile',
        timestamp: 2000,
        sessionId: 'cont-sess-001',
      });
      expect(normalized.sessionId).toBe('cont-sess-001');
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
      expect(adapter.mapToolName('readFile')).toBe('Read');
    });

    it('returns "Unknown" for an unrecognized tool name', () => {
      expect(adapter.mapToolName('totallyMadeUpTool')).toBe('Unknown');
    });
  });
});
