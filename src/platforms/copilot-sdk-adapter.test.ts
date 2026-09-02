import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { CopilotSdkAdapter } from './copilot-sdk-adapter.js';

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

describe('CopilotSdkAdapter', () => {
  const adapter = new CopilotSdkAdapter();

  it('has platformName "copilot-sdk"', () => {
    expect(adapter.platformName).toBe('copilot-sdk');
  });

  it('has visibilityLevel "full-hooks"', () => {
    expect(adapter.visibilityLevel).toBe('full-hooks');
  });

  it('has instructionFilePaths for AGENTS.md, CLAUDE.md, GEMINI.md, and .github/copilot-instructions.md', () => {
    expect(adapter.capabilities.instructionFilePaths).toEqual([
      'AGENTS.md',
      'CLAUDE.md',
      'GEMINI.md',
      '.github/copilot-instructions.md',
    ]);
  });

  describe('normalizeToolCall', () => {
    it('reads platform tool name from "tool" field', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'bash', timestamp: 5000 });
      expect(normalized.toolName).toBe('Bash');
      expect(normalized.platformToolName).toBe('bash');
      expect(normalized.platform).toBe('copilot-sdk');
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
      expect(normalized.platform).toBe('copilot-sdk');
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
        sessionId: 'copilot-sdk-sess-1',
        inputSizeBytes: 10,
        outputSizeBytes: 20,
      });
      expect(normalized.command).toBe('npm test');
      expect(normalized.sessionId).toBe('copilot-sdk-sess-1');
      expect(normalized.inputSizeBytes).toBe(10);
      expect(normalized.outputSizeBytes).toBe(20);
    });
  });

  describe('mapToolName', () => {
    // Canonical Claude-shaped names — what PascalCase PreToolUse/PostToolUse
    // (the config this adapter's setup instructions require) actually
    // delivers as `tool_name`. This is the real-world path.
    it.each([
      ['Bash', 'Bash'],
      ['Read', 'Read'],
      ['Write', 'Write'],
      ['Edit', 'Edit'],
      ['Grep', 'Grep'],
      ['Glob', 'Glob'],
      ['Agent', 'Agent'],
      ['Task', 'Agent'],
      ['WebFetch', 'WebFetch'],
      ['WebSearch', 'WebSearch'],
      ['AskUserQuestion', 'AskUserQuestion'],
      ['TodoWrite', 'TodoWrite'],
    ])('maps canonical name "%s" to "%s" (identity)', (platformToolName, expected) => {
      expect(adapter.mapToolName(platformToolName)).toBe(expected);
    });

    // Raw runtime names — defensive fallback only, not expected to be
    // looked up under the documented PascalCase config.
    it.each([
      ['bash', 'Bash'],
      ['powershell', 'Bash'],
      ['apply_patch', 'Edit'],
      ['create', 'Write'],
      ['edit', 'Edit'],
      ['str_replace_editor', 'Edit'],
      ['view', 'Read'],
      ['task', 'Agent'],
      ['glob', 'Glob'],
      ['grep', 'Grep'],
      ['rg', 'Grep'],
      ['web_fetch', 'WebFetch'],
      ['web_search', 'WebSearch'],
      ['ask_user', 'AskUserQuestion'],
      ['update_todo', 'TodoWrite'],
    ])('maps raw runtime name "%s" to "%s" (fallback)', (platformToolName, expected) => {
      expect(adapter.mapToolName(platformToolName)).toBe(expected);
    });

    it('returns "Unknown" for a tool with no Claude equivalent', () => {
      expect(adapter.mapToolName('list_agents')).toBe('Unknown');
      expect(adapter.mapToolName('list_bash')).toBe('Unknown');
      expect(adapter.mapToolName('skill')).toBe('Unknown');
      expect(adapter.mapToolName('totally_made_up')).toBe('Unknown');
    });
  });

  describe('getSessionMetadata', () => {
    it('returns platform "copilot-sdk"', () => {
      expect(adapter.getSessionMetadata().platform).toBe('copilot-sdk');
    });
  });

  describe('isSupported', () => {
    it('returns true when NEW_RELIC_AI_PLATFORM is "copilot-sdk"', () => {
      process.env.NEW_RELIC_AI_PLATFORM = 'copilot-sdk';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns true when MCP_CLIENT is "copilot-sdk"', () => {
      process.env.MCP_CLIENT = 'copilot-sdk';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns false when copilot-sdk env vars are absent', () => {
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
      expect(instructions).toContain('copilot-sdk');
    });

    it('mentions installing the token-usage extension and --experimental', () => {
      const instructions = adapter.getHookInstallInstructions();
      expect(instructions).toContain('copilot-sdk-extension/extension.mjs');
      expect(instructions).toContain('~/.copilot/extensions/preflight/extension.mjs');
      expect(instructions).toContain('--experimental');
    });

    it('includes a "version": 1 field in the sample hooks JSON', () => {
      // A missing/wrong `version` is a structural error that rejects the
      // entire hooks file, per GitHub's Copilot hooks reference.
      const instructions = adapter.getHookInstallInstructions();
      expect(instructions).toContain('"version": 1,');
    });

    it('does not tell users to run the nonexistent "/extensions reload" command', () => {
      const instructions = adapter.getHookInstallInstructions();
      expect(instructions).not.toContain('/extensions reload');
    });

    // Regression guard: the hooks-runner does not inherit env vars set on the
    // `copilot mcp add` registration below, so every hook command must embed
    // the platform tag directly or events silently default to 'claude-code'.
    it('embeds NEW_RELIC_AI_PLATFORM=copilot directly in the hook commands', () => {
      const instructions = adapter.getHookInstallInstructions();
      expect(instructions).toContain('NEW_RELIC_AI_PLATFORM=copilot');
    });

    it('mentions the automated installer', () => {
      const instructions = adapter.getHookInstallInstructions();
      expect(instructions).toContain('preflight install --copilot');
    });

    it('still registers the MCP server itself with MCP_CLIENT=copilot-sdk (unchanged)', () => {
      // Distinct from the hooks file's NEW_RELIC_AI_PLATFORM=copilot tag —
      // this env var drives the MCP server's own platform self-detection
      // (CopilotSdkAdapter's tool-name normalization, local-dashboard
      // session summaries), not per-event NR tagging.
      const instructions = adapter.getHookInstallInstructions();
      expect(instructions).toContain('--env MCP_CLIENT=copilot-sdk');
    });
  });

  describe('initialize', () => {
    it('completes without error', async () => {
      await expect(adapter.initialize({})).resolves.toBeUndefined();
    });
  });
});
