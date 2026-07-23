import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { CodexAdapter } from './codex-adapter.js';

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

describe('CodexAdapter', () => {
  const adapter = new CodexAdapter();

  it('has platformName "codex"', () => {
    expect(adapter.platformName).toBe('codex');
  });

  it('declares visibilityLevel "full-hooks"', () => {
    expect(adapter.visibilityLevel).toBe('full-hooks');
  });

  it('declares AGENTS.md as an instruction file path', () => {
    expect(adapter.capabilities.instructionFilePaths).toEqual(['AGENTS.md']);
  });

  describe('normalizeToolCall', () => {
    it('maps "Bash" to "Bash" (identity)', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'Bash',
        timestamp: 2000,
        command: 'npm test',
      });
      expect(normalized.toolName).toBe('Bash');
      expect(normalized.command).toBe('npm test');
    });

    it('maps "apply_patch" to "Edit"', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'apply_patch',
        timestamp: 2000,
        filePath: '/src/app.ts',
      });
      expect(normalized.toolName).toBe('Edit');
      expect(normalized.platformToolName).toBe('apply_patch');
      expect(normalized.filePath).toBe('/src/app.ts');
    });

    it('maps "spawn_agent" to "Agent"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'spawn_agent', timestamp: 2000 });
      expect(normalized.toolName).toBe('Agent');
    });

    it('leaves "update_plan" unmapped, falling through to "Unknown"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'update_plan', timestamp: 2000 });
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('update_plan');
    });

    it('leaves an arbitrary MCP tool name unmapped, falling through to "Unknown"', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'mcp__filesystem__read_file',
        timestamp: 2000,
      });
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('mcp__filesystem__read_file');
    });

    it('never fabricates a mapping for a hosted tool Codex cannot hook (e.g. WebSearch)', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'WebSearch', timestamp: 2000 });
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('WebSearch');
    });

    it('accepts "toolName" field as an alternative to "tool"', () => {
      const normalized = adapter.normalizeToolCall({ toolName: 'Bash', timestamp: 2000 });
      expect(normalized.toolName).toBe('Bash');
      expect(normalized.platformToolName).toBe('Bash');
    });

    it('normalizes path to filePath', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'apply_patch', path: '/src/app.ts' });
      expect(normalized.filePath).toBe('/src/app.ts');
    });

    it('maps unknown tool to "Unknown" with platformToolName preserved', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'totally_unmapped_tool',
        timestamp: 2000,
      });
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('totally_unmapped_tool');
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
      expect(normalized.platform).toBe('codex');
      expect(normalized.success).toBe(true);
      expect(normalized.durationMs).toBeNull();
    });

    it('defaults success to true when not provided', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'Bash', timestamp: 2000 });
      expect(normalized.success).toBe(true);
    });

    it('preserves error field', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'apply_patch',
        timestamp: 2000,
        success: false,
        error: 'patch failed to apply',
      });
      expect(normalized.success).toBe(false);
      expect(normalized.error).toBe('patch failed to apply');
    });

    it('uses current time when timestamp is missing', () => {
      const before = Date.now();
      const normalized = adapter.normalizeToolCall({ tool: 'Bash' });
      const after = Date.now();
      expect(normalized.timestamp).toBeGreaterThanOrEqual(before);
      expect(normalized.timestamp).toBeLessThanOrEqual(after);
    });

    it('includes inputSizeBytes and outputSizeBytes when present', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'Bash',
        timestamp: 2000,
        inputSizeBytes: 50,
        outputSizeBytes: 1000,
      });
      expect(normalized.inputSizeBytes).toBe(50);
      expect(normalized.outputSizeBytes).toBe(1000);
    });

    it('includes sessionId when present', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'Bash',
        timestamp: 2000,
        sessionId: 'codex-sess-001',
      });
      expect(normalized.sessionId).toBe('codex-sess-001');
    });
  });

  describe('getSessionMetadata', () => {
    it('returns platform "codex"', () => {
      const meta = adapter.getSessionMetadata();
      expect(meta.platform).toBe('codex');
    });
  });

  describe('isSupported', () => {
    it('returns true when MCP_CLIENT is "codex"', () => {
      process.env.MCP_CLIENT = 'codex';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns true when NEW_RELIC_AI_PLATFORM is "codex"', () => {
      process.env.NEW_RELIC_AI_PLATFORM = 'codex';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns false in a non-Codex environment', () => {
      expect(adapter.isSupported()).toBe(false);
    });
  });

  describe('getHookInstallInstructions', () => {
    it('returns non-empty Codex-specific instructions', () => {
      const instructions = adapter.getHookInstallInstructions();
      expect(instructions.length).toBeGreaterThan(0);
      expect(instructions).toContain('Codex');
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
      expect(adapter.mapToolName('apply_patch')).toBe('Edit');
    });

    it('returns "Unknown" for an unrecognized tool name', () => {
      expect(adapter.mapToolName('totally_made_up_tool')).toBe('Unknown');
    });
  });
});
