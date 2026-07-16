import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { KiroAdapter } from './kiro-adapter.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  for (const key of [
    'KIRO_SESSION_ID',
    'KIRO_IDE',
    'KIRO_VERSION',
    'MCP_CLIENT',
    'NEW_RELIC_AI_PLATFORM',
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

describe('KiroAdapter', () => {
  const adapter = new KiroAdapter();

  it('has platformName "kiro"', () => {
    expect(adapter.platformName).toBe('kiro');
  });

  describe('normalizeToolCall', () => {
    it('maps "fsRead" to "Read"', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'fsRead',
        timestamp: 2000,
        success: true,
      });
      expect(normalized.toolName).toBe('Read');
      expect(normalized.platformToolName).toBe('fsRead');
      expect(normalized.platform).toBe('kiro');
    });

    it('maps "fsWrite" to "Write"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'fsWrite', timestamp: 2000 });
      expect(normalized.toolName).toBe('Write');
    });

    it('maps "fsAppend" to "Edit"', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'fsAppend',
        timestamp: 2000,
        filePath: '/src/app.ts',
      });
      expect(normalized.toolName).toBe('Edit');
      expect(normalized.filePath).toBe('/src/app.ts');
    });

    it('maps "strReplace" to "Edit"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'strReplace', timestamp: 2000 });
      expect(normalized.toolName).toBe('Edit');
    });

    it('maps "fsCreate" to "Write"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'fsCreate', timestamp: 2000 });
      expect(normalized.toolName).toBe('Write');
    });

    it('maps "deletePath" to "Delete"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'deletePath', timestamp: 2000 });
      expect(normalized.toolName).toBe('Delete');
    });

    it('maps "listDirectory" to "Glob"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'listDirectory', timestamp: 2000 });
      expect(normalized.toolName).toBe('Glob');
    });

    it('maps "fileSearch" to "Glob"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'fileSearch', timestamp: 2000 });
      expect(normalized.toolName).toBe('Glob');
    });

    it('maps "grepSearch" to "Grep"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'grepSearch', timestamp: 2000 });
      expect(normalized.toolName).toBe('Grep');
    });

    it('maps "executeBash" to "Bash"', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'executeBash',
        timestamp: 2000,
        command: 'npm test',
      });
      expect(normalized.toolName).toBe('Bash');
      expect(normalized.command).toBe('npm test');
    });

    it('maps "executePwsh" to "Bash"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'executePwsh', timestamp: 2000 });
      expect(normalized.toolName).toBe('Bash');
    });

    it('maps snake_case alias "fs_read" to "Read"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'fs_read', timestamp: 2000 });
      expect(normalized.toolName).toBe('Read');
    });

    it('maps "read" (alias) to "Read"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'read', timestamp: 2000 });
      expect(normalized.toolName).toBe('Read');
    });

    it('maps "write" (alias) to "Write"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'write', timestamp: 2000 });
      expect(normalized.toolName).toBe('Write');
    });

    it('maps "shell" (alias) to "Bash"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'shell', timestamp: 2000 });
      expect(normalized.toolName).toBe('Bash');
    });

    it('maps "use_aws" to "Bash"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'use_aws', timestamp: 2000 });
      expect(normalized.toolName).toBe('Bash');
    });

    it('maps "aws" (alias) to "Bash"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'aws', timestamp: 2000 });
      expect(normalized.toolName).toBe('Bash');
    });

    it('accepts "toolName" field as an alternative to "tool"', () => {
      const normalized = adapter.normalizeToolCall({ toolName: 'fsRead', timestamp: 2000 });
      expect(normalized.toolName).toBe('Read');
      expect(normalized.platformToolName).toBe('fsRead');
    });

    it('normalizes path to filePath', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'fsRead', path: '/src/app.ts' });
      expect(normalized.filePath).toBe('/src/app.ts');
    });

    it('maps unknown tool to "Unknown" with platformToolName preserved', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'custom_kiro_tool', timestamp: 2000 });
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('custom_kiro_tool');
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
      expect(normalized.platform).toBe('kiro');
      expect(normalized.success).toBe(true);
      expect(normalized.durationMs).toBeNull();
    });

    it('defaults success to true when not provided', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'fsRead', timestamp: 2000 });
      expect(normalized.success).toBe(true);
    });

    it('preserves error field', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'fsAppend',
        timestamp: 2000,
        success: false,
        error: 'permission denied',
      });
      expect(normalized.success).toBe(false);
      expect(normalized.error).toBe('permission denied');
    });

    it('uses current time when timestamp is missing', () => {
      const before = Date.now();
      const normalized = adapter.normalizeToolCall({ tool: 'fsRead' });
      const after = Date.now();
      expect(normalized.timestamp).toBeGreaterThanOrEqual(before);
      expect(normalized.timestamp).toBeLessThanOrEqual(after);
    });

    it('includes inputSizeBytes and outputSizeBytes when present', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'fsRead',
        timestamp: 2000,
        inputSizeBytes: 50,
        outputSizeBytes: 1000,
      });
      expect(normalized.inputSizeBytes).toBe(50);
      expect(normalized.outputSizeBytes).toBe(1000);
    });

    it('includes sessionId when present', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'fsRead',
        timestamp: 2000,
        sessionId: 'kiro-sess-001',
      });
      expect(normalized.sessionId).toBe('kiro-sess-001');
    });
  });

  describe('getSessionMetadata', () => {
    it('returns platform "kiro"', () => {
      const meta = adapter.getSessionMetadata();
      expect(meta.platform).toBe('kiro');
    });

    it('includes ideVersion from KIRO_VERSION env var', () => {
      process.env.KIRO_VERSION = '0.1.0';
      const meta = adapter.getSessionMetadata();
      expect(meta.ideVersion).toBe('0.1.0');
    });

    it('omits ideVersion when KIRO_VERSION is unset', () => {
      const meta = adapter.getSessionMetadata();
      expect(meta.ideVersion).toBeUndefined();
    });
  });

  describe('isSupported', () => {
    it('returns true when KIRO_SESSION_ID is set', () => {
      process.env.KIRO_SESSION_ID = 'abc123';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns true when KIRO_IDE is set', () => {
      process.env.KIRO_IDE = '1';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns true when MCP_CLIENT is "kiro"', () => {
      process.env.MCP_CLIENT = 'kiro';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns true when NEW_RELIC_AI_PLATFORM is "kiro"', () => {
      process.env.NEW_RELIC_AI_PLATFORM = 'kiro';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns false in a non-Kiro environment', () => {
      expect(adapter.isSupported()).toBe(false);
    });
  });

  describe('getHookInstallInstructions', () => {
    it('returns non-empty Kiro-specific instructions', () => {
      const instructions = adapter.getHookInstallInstructions();
      expect(instructions.length).toBeGreaterThan(0);
      expect(instructions).toContain('Kiro');
    });

    it('references the Kiro MCP settings file', () => {
      expect(adapter.getHookInstallInstructions()).toContain('.kiro/settings/mcp.json');
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
      expect(adapter.mapToolName('fsRead')).toBe('Read');
    });

    it('returns "Unknown" for an unrecognized tool name', () => {
      expect(adapter.mapToolName('totally_made_up_tool')).toBe('Unknown');
    });
  });
});
