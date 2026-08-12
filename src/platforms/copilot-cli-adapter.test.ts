import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { CopilotCliAdapter } from './copilot-cli-adapter.js';

const ENV_KEYS = ['NEW_RELIC_AI_PLATFORM', 'MCP_CLIENT'];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('CopilotCliAdapter', () => {
  const adapter = new CopilotCliAdapter();

  it('has platformName "copilot-cli"', () => {
    expect(adapter.platformName).toBe('copilot-cli');
  });

  it('has visibilityLevel "full-hooks"', () => {
    expect(adapter.visibilityLevel).toBe('full-hooks');
  });

  it('has instructionFilePaths for AGENTS.md and .github/copilot-instructions.md', () => {
    expect(adapter.capabilities.instructionFilePaths).toEqual([
      'AGENTS.md',
      '.github/copilot-instructions.md',
    ]);
  });

  describe('normalizeToolCall', () => {
    it('reads platform tool name from "tool" field', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'bash', timestamp: 5000 });
      expect(normalized.toolName).toBe('Bash');
      expect(normalized.platformToolName).toBe('bash');
      expect(normalized.platform).toBe('copilot-cli');
    });

    it('reads platform tool name from "toolName" field', () => {
      const normalized = adapter.normalizeToolCall({ toolName: 'edit', timestamp: 5000 });
      expect(normalized.toolName).toBe('Edit');
    });

    it('falls back to "unknown" when no tool name field is present', () => {
      const normalized = adapter.normalizeToolCall({ timestamp: 5000 });
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('unknown');
    });

    it('falls back to safe defaults when raw is not an object', () => {
      const normalized = adapter.normalizeToolCall(null);
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('unknown');
      expect(normalized.platform).toBe('copilot-cli');
      expect(normalized.success).toBe(true);
      expect(normalized.durationMs).toBeNull();
    });

    it('uses current time when timestamp is missing', () => {
      const before = Date.now();
      const normalized = adapter.normalizeToolCall({ tool: 'bash' });
      const after = Date.now();
      expect(normalized.timestamp).toBeGreaterThanOrEqual(before);
      expect(normalized.timestamp).toBeLessThanOrEqual(after);
    });

    it('defaults success to true', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'bash', timestamp: 5000 });
      expect(normalized.success).toBe(true);
    });

    it('preserves an explicit success:false and error', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'bash',
        timestamp: 5000,
        success: false,
        error: 'command failed',
      });
      expect(normalized.success).toBe(false);
      expect(normalized.error).toBe('command failed');
    });

    it('prefers filePath over path when both are present', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'edit',
        filePath: '/a.ts',
        path: '/b.ts',
      });
      expect(normalized.filePath).toBe('/a.ts');
    });

    it('falls back to path when filePath is absent', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'view', path: '/src' });
      expect(normalized.filePath).toBe('/src');
    });

    it('includes command, sessionId, inputSizeBytes, outputSizeBytes', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'bash',
        command: 'npm test',
        sessionId: 'copilot-cli-sess-1',
        inputSizeBytes: 10,
        outputSizeBytes: 20,
      });
      expect(normalized.command).toBe('npm test');
      expect(normalized.sessionId).toBe('copilot-cli-sess-1');
      expect(normalized.inputSizeBytes).toBe(10);
      expect(normalized.outputSizeBytes).toBe(20);
    });
  });

  describe('mapToolName', () => {
    it.each([
      ['bash', 'Bash'],
      ['powershell', 'Bash'],
      ['apply_patch', 'Edit'],
      ['create', 'Write'],
      ['edit', 'Edit'],
      ['view', 'Read'],
      ['task', 'Agent'],
      ['glob', 'Glob'],
      ['grep', 'Grep'],
      ['rg', 'Grep'],
    ])('maps "%s" to "%s"', (platformToolName, expected) => {
      expect(adapter.mapToolName(platformToolName)).toBe(expected);
    });

    it('returns "Unknown" for an unrecognized tool name', () => {
      expect(adapter.mapToolName('list_agents')).toBe('Unknown');
      expect(adapter.mapToolName('web_fetch')).toBe('Unknown');
      expect(adapter.mapToolName('totally_made_up')).toBe('Unknown');
    });
  });

  describe('getSessionMetadata', () => {
    it('returns platform "copilot-cli"', () => {
      expect(adapter.getSessionMetadata().platform).toBe('copilot-cli');
    });
  });

  describe('isSupported', () => {
    it('returns true when NEW_RELIC_AI_PLATFORM is "copilot-cli"', () => {
      process.env.NEW_RELIC_AI_PLATFORM = 'copilot-cli';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns true when MCP_CLIENT is "copilot-cli"', () => {
      process.env.MCP_CLIENT = 'copilot-cli';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns false when copilot-cli env vars are absent', () => {
      expect(adapter.isSupported()).toBe(false);
    });

    it('returns false for the VS Code Copilot value "copilot" (distinct platform)', () => {
      process.env.MCP_CLIENT = 'copilot';
      expect(adapter.isSupported()).toBe(false);
    });
  });

  describe('getHookInstallInstructions', () => {
    it('returns non-empty CLI-specific instructions mentioning `copilot mcp add`', () => {
      const instructions = adapter.getHookInstallInstructions();
      expect(instructions.length).toBeGreaterThan(0);
      expect(instructions).toContain('copilot mcp add');
      expect(instructions).toContain('copilot-cli');
    });
  });

  describe('initialize', () => {
    it('completes without error', async () => {
      await expect(adapter.initialize({})).resolves.toBeUndefined();
    });
  });
});
