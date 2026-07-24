import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { AntigravityAdapter } from './antigravity-adapter.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  for (const key of ['MCP_CLIENT']) {
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

describe('AntigravityAdapter', () => {
  const adapter = new AntigravityAdapter();

  it('has platformName "antigravity"', () => {
    expect(adapter.platformName).toBe('antigravity');
  });

  it('declares visibilityLevel "full-hooks"', () => {
    expect(adapter.visibilityLevel).toBe('full-hooks');
  });

  it('declares GEMINI.md and .agents/rules/ as instruction file paths', () => {
    expect(adapter.capabilities.instructionFilePaths).toEqual(['GEMINI.md', '.agents/rules/']);
  });

  describe('mapToolName', () => {
    const cases: [string, string][] = [
      ['view_file', 'Read'],
      ['write_to_file', 'Write'],
      ['replace_file_content', 'Edit'],
      ['multi_replace_file_content', 'MultiEdit'],
      ['list_dir', 'Glob'],
      ['find_by_name', 'Glob'],
      ['grep_search', 'Grep'],
      ['search_web', 'WebSearch'],
      ['read_url_content', 'WebFetch'],
      ['run_command', 'Bash'],
      ['invoke_subagent', 'Agent'],
    ];

    for (const [platformName, expected] of cases) {
      it(`maps "${platformName}" to "${expected}"`, () => {
        expect(adapter.mapToolName(platformName)).toBe(expected);
      });
    }

    it('leaves ask_question unmapped (returns "Unknown")', () => {
      expect(adapter.mapToolName('ask_question')).toBe('Unknown');
    });

    it('leaves generate_image unmapped (returns "Unknown")', () => {
      expect(adapter.mapToolName('generate_image')).toBe('Unknown');
    });

    it('returns "Unknown" for an unrecognized tool name', () => {
      expect(adapter.mapToolName('totally_made_up_tool')).toBe('Unknown');
    });
  });

  describe('normalizeToolCall', () => {
    it('maps a known tool and preserves platform-specific fields', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'run_command',
        timestamp: 3000,
        success: true,
        command: 'npm test',
      });
      expect(normalized.toolName).toBe('Bash');
      expect(normalized.platformToolName).toBe('run_command');
      expect(normalized.platform).toBe('antigravity');
      expect(normalized.command).toBe('npm test');
    });

    it('defaults missing tool name to "unknown"', () => {
      const normalized = adapter.normalizeToolCall({ timestamp: 3000 });
      expect(normalized.platformToolName).toBe('unknown');
      expect(normalized.toolName).toBe('Unknown');
    });

    it('defaults success to true when not provided', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'view_file', timestamp: 3000 });
      expect(normalized.success).toBe(true);
    });

    it('falls back to safe defaults when raw is not an object (e.g. null)', () => {
      const normalized = adapter.normalizeToolCall(null);
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('unknown');
      expect(normalized.platform).toBe('antigravity');
      expect(normalized.success).toBe(true);
      expect(normalized.durationMs).toBeNull();
    });
  });

  describe('getSessionMetadata', () => {
    it('returns platform "antigravity"', () => {
      expect(adapter.getSessionMetadata()).toEqual({ platform: 'antigravity' });
    });
  });

  describe('isSupported', () => {
    it('returns true when MCP_CLIENT is "antigravity"', () => {
      process.env.MCP_CLIENT = 'antigravity';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns false in a non-Antigravity environment', () => {
      expect(adapter.isSupported()).toBe(false);
    });
  });

  describe('getHookInstallInstructions', () => {
    it('returns non-empty instructions mentioning both mcp_config.json and hooks.json', () => {
      const instructions = adapter.getHookInstallInstructions();
      expect(instructions.length).toBeGreaterThan(0);
      expect(instructions).toContain('mcp_config.json');
      expect(instructions).toContain('hooks.json');
    });
  });

  describe('initialize', () => {
    it('completes without error', async () => {
      await expect(adapter.initialize({})).resolves.toBeUndefined();
    });
  });
});
