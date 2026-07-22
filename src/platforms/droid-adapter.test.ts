import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { DroidAdapter } from './droid-adapter.js';

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

describe('DroidAdapter', () => {
  const adapter = new DroidAdapter();

  it('has platformName "droid"', () => {
    expect(adapter.platformName).toBe('droid');
  });

  it('declares visibilityLevel "full-hooks"', () => {
    expect(adapter.visibilityLevel).toBe('full-hooks');
  });

  it('declares AGENTS.md as an instruction file path', () => {
    expect(adapter.capabilities.instructionFilePaths).toEqual(['AGENTS.md']);
  });

  describe('normalizeToolCall', () => {
    it('maps "Task" to "Agent"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'Task', timestamp: 2000 });
      expect(normalized.toolName).toBe('Agent');
      expect(normalized.platformToolName).toBe('Task');
      expect(normalized.platform).toBe('droid');
    });

    it('maps "Execute" to "Bash"', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'Execute',
        timestamp: 2000,
        command: 'npm test',
      });
      expect(normalized.toolName).toBe('Bash');
      expect(normalized.command).toBe('npm test');
    });

    it('maps "Create" to "Write"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'Create', timestamp: 2000 });
      expect(normalized.toolName).toBe('Write');
    });

    it('maps "FetchUrl" to "WebFetch"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'FetchUrl', timestamp: 2000 });
      expect(normalized.toolName).toBe('WebFetch');
    });

    it('maps "WebSearch" to "WebSearch" (identity)', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'WebSearch', timestamp: 2000 });
      expect(normalized.toolName).toBe('WebSearch');
    });

    it('maps "Read" to "Read" (identity)', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'Read', timestamp: 2000 });
      expect(normalized.toolName).toBe('Read');
    });

    it('maps "Glob" to "Glob" (identity)', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'Glob', timestamp: 2000 });
      expect(normalized.toolName).toBe('Glob');
    });

    it('maps "Grep" to "Grep" (identity)', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'Grep', timestamp: 2000 });
      expect(normalized.toolName).toBe('Grep');
    });

    it('maps "Edit" to "Edit" (identity)', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'Edit',
        timestamp: 2000,
        filePath: '/src/app.ts',
      });
      expect(normalized.toolName).toBe('Edit');
      expect(normalized.filePath).toBe('/src/app.ts');
    });

    it('accepts "toolName" field as an alternative to "tool"', () => {
      const normalized = adapter.normalizeToolCall({ toolName: 'Read', timestamp: 2000 });
      expect(normalized.toolName).toBe('Read');
      expect(normalized.platformToolName).toBe('Read');
    });

    it('normalizes path to filePath', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'Read', path: '/src/app.ts' });
      expect(normalized.filePath).toBe('/src/app.ts');
    });

    it('maps unknown tool to "Unknown" with platformToolName preserved', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'mcp__github__search',
        timestamp: 2000,
      });
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('mcp__github__search');
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
      expect(normalized.platform).toBe('droid');
      expect(normalized.success).toBe(true);
      expect(normalized.durationMs).toBeNull();
    });

    it('defaults success to true when not provided', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'Read', timestamp: 2000 });
      expect(normalized.success).toBe(true);
    });

    it('preserves error field', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'Edit',
        timestamp: 2000,
        success: false,
        error: 'permission denied',
      });
      expect(normalized.success).toBe(false);
      expect(normalized.error).toBe('permission denied');
    });

    it('uses current time when timestamp is missing', () => {
      const before = Date.now();
      const normalized = adapter.normalizeToolCall({ tool: 'Read' });
      const after = Date.now();
      expect(normalized.timestamp).toBeGreaterThanOrEqual(before);
      expect(normalized.timestamp).toBeLessThanOrEqual(after);
    });

    it('includes inputSizeBytes and outputSizeBytes when present', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'Read',
        timestamp: 2000,
        inputSizeBytes: 50,
        outputSizeBytes: 1000,
      });
      expect(normalized.inputSizeBytes).toBe(50);
      expect(normalized.outputSizeBytes).toBe(1000);
    });

    it('includes sessionId when present', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'Read',
        timestamp: 2000,
        sessionId: 'droid-sess-001',
      });
      expect(normalized.sessionId).toBe('droid-sess-001');
    });
  });

  describe('getSessionMetadata', () => {
    it('returns platform "droid"', () => {
      const meta = adapter.getSessionMetadata();
      expect(meta.platform).toBe('droid');
    });
  });

  describe('isSupported', () => {
    it('returns true when MCP_CLIENT is "droid"', () => {
      process.env.MCP_CLIENT = 'droid';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns true when NEW_RELIC_AI_PLATFORM is "droid"', () => {
      process.env.NEW_RELIC_AI_PLATFORM = 'droid';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns false in a non-Droid environment', () => {
      expect(adapter.isSupported()).toBe(false);
    });
  });

  describe('getHookInstallInstructions', () => {
    it('returns non-empty Droid-specific instructions', () => {
      const instructions = adapter.getHookInstallInstructions();
      expect(instructions.length).toBeGreaterThan(0);
      expect(instructions).toContain('Droid');
    });

    it('references hooks.json', () => {
      expect(adapter.getHookInstallInstructions()).toContain('hooks.json');
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
      expect(adapter.mapToolName('Task')).toBe('Agent');
    });

    it('returns "Unknown" for an unrecognized tool name', () => {
      expect(adapter.mapToolName('totally_made_up_tool')).toBe('Unknown');
    });
  });
});
