import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { KiloCodeAdapter } from './kilo-code-adapter.js';

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

describe('KiloCodeAdapter', () => {
  const adapter = new KiloCodeAdapter();

  it('has platformName "kilocode"', () => {
    expect(adapter.platformName).toBe('kilocode');
  });

  it('declares visibilityLevel "full-hooks"', () => {
    expect(adapter.visibilityLevel).toBe('full-hooks');
  });

  it('declares AGENTS.md as an instruction file path', () => {
    expect(adapter.capabilities.instructionFilePaths).toEqual(['AGENTS.md']);
  });

  describe('normalizeToolCall', () => {
    const cases: Array<[string, string]> = [
      ['read', 'Read'],
      ['glob', 'Glob'],
      ['grep', 'Grep'],
      ['edit', 'Edit'],
      ['write', 'Write'],
      ['apply_patch', 'Edit'],
      ['bash', 'Bash'],
      ['webfetch', 'WebFetch'],
      ['websearch', 'WebSearch'],
      ['question', 'AskUserQuestion'],
      ['todowrite', 'TaskCreate'],
      ['todoread', 'TaskList'],
      ['plan', 'EnterPlanMode'],
      ['task', 'Agent'],
      ['skill', 'Skill'],
    ];

    for (const [platformToolName, expected] of cases) {
      it(`maps "${platformToolName}" to "${expected}"`, () => {
        const normalized = adapter.normalizeToolCall({ tool: platformToolName, timestamp: 2000 });
        expect(normalized.toolName).toBe(expected);
        expect(normalized.platformToolName).toBe(platformToolName);
      });
    }

    it('leaves "agent_manager" unmapped, falling through to "Unknown"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'agent_manager', timestamp: 2000 });
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('agent_manager');
    });

    it('leaves a namespaced kilo-playwright MCP tool call unmapped, falling through to "Unknown"', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'kilo-playwright_browser_click',
        timestamp: 2000,
      });
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('kilo-playwright_browser_click');
    });

    it('leaves an arbitrary unrecognized tool name unmapped, falling through to "Unknown"', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'totally_unmapped_tool',
        timestamp: 2000,
      });
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('totally_unmapped_tool');
    });

    it('accepts "toolName" field as an alternative to "tool"', () => {
      const normalized = adapter.normalizeToolCall({ toolName: 'bash', timestamp: 2000 });
      expect(normalized.toolName).toBe('Bash');
      expect(normalized.platformToolName).toBe('bash');
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
      expect(normalized.platform).toBe('kilocode');
      expect(normalized.success).toBe(true);
      expect(normalized.durationMs).toBeNull();
    });

    it('defaults success to true when not provided', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'bash', timestamp: 2000 });
      expect(normalized.success).toBe(true);
    });

    it('preserves error field', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'bash',
        timestamp: 2000,
        success: false,
        error: 'command failed',
      });
      expect(normalized.success).toBe(false);
      expect(normalized.error).toBe('command failed');
    });

    it('uses current time when timestamp is missing', () => {
      const before = Date.now();
      const normalized = adapter.normalizeToolCall({ tool: 'bash' });
      const after = Date.now();
      expect(normalized.timestamp).toBeGreaterThanOrEqual(before);
      expect(normalized.timestamp).toBeLessThanOrEqual(after);
    });

    it('includes inputSizeBytes and outputSizeBytes when present', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'bash',
        timestamp: 2000,
        inputSizeBytes: 50,
        outputSizeBytes: 1000,
      });
      expect(normalized.inputSizeBytes).toBe(50);
      expect(normalized.outputSizeBytes).toBe(1000);
    });

    it('includes sessionId when present', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'bash',
        timestamp: 2000,
        sessionId: 'kilocode-sess-001',
      });
      expect(normalized.sessionId).toBe('kilocode-sess-001');
    });

    it('includes filePath when present', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'read',
        timestamp: 2000,
        filePath: '/src/app.ts',
      });
      expect(normalized.filePath).toBe('/src/app.ts');
    });

    it('includes command when present', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'bash',
        timestamp: 2000,
        command: 'npm test',
      });
      expect(normalized.command).toBe('npm test');
    });
  });

  describe('getSessionMetadata', () => {
    it('returns platform "kilocode"', () => {
      const meta = adapter.getSessionMetadata();
      expect(meta.platform).toBe('kilocode');
    });
  });

  describe('isSupported', () => {
    it('returns true when MCP_CLIENT is "kilocode"', () => {
      process.env.MCP_CLIENT = 'kilocode';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns true when NEW_RELIC_AI_PLATFORM is "kilocode"', () => {
      process.env.NEW_RELIC_AI_PLATFORM = 'kilocode';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns false in a non-kilocode environment', () => {
      expect(adapter.isSupported()).toBe(false);
    });
  });

  describe('getHookInstallInstructions', () => {
    it('returns non-empty Kilo Code-specific instructions', () => {
      const instructions = adapter.getHookInstallInstructions();
      expect(instructions.length).toBeGreaterThan(0);
      expect(instructions).toContain('Kilo');
    });

    it('documents the plugin directory', () => {
      expect(adapter.getHookInstallInstructions()).toContain('.kilo/plugin/');
    });

    it('does not reference opencode plugin paths', () => {
      expect(adapter.getHookInstallInstructions()).not.toContain('.opencode/plugins/');
    });

    it('documents the tool.execute.before/after hooks', () => {
      const instructions = adapter.getHookInstallInstructions();
      expect(instructions).toContain('tool.execute.before');
      expect(instructions).toContain('tool.execute.after');
    });

    it('documents the current (non-legacy) plugin module descriptor shape', () => {
      expect(adapter.getHookInstallInstructions()).toContain('export default { id:');
    });

    it('mentions preflight-collector', () => {
      expect(adapter.getHookInstallInstructions()).toContain('preflight-collector');
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
