import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { AmazonQAdapter } from './amazon-q-adapter.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  for (const key of [
    'AMAZON_Q_SESSION_ID',
    'Q_DEVELOPER_SESSION',
    'AWS_CODEWHISPERER_SESSION',
    'AMAZON_Q_VERSION',
    'MCP_CLIENT',
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

describe('AmazonQAdapter', () => {
  const adapter = new AmazonQAdapter();

  it('has platformName "amazon-q"', () => {
    expect(adapter.platformName).toBe('amazon-q');
  });

  describe('normalizeToolCall', () => {
    it('maps "fs_read" to "Read"', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'fs_read',
        timestamp: 2000,
        success: true,
      });
      expect(normalized.toolName).toBe('Read');
      expect(normalized.platformToolName).toBe('fs_read');
      expect(normalized.platform).toBe('amazon-q');
    });

    it('maps "fs_write" to "Write"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'fs_write', timestamp: 2000 });
      expect(normalized.toolName).toBe('Write');
    });

    it('maps "fs_edit" to "Edit"', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'fs_edit',
        timestamp: 2000,
        filePath: '/src/app.ts',
      });
      expect(normalized.toolName).toBe('Edit');
      expect(normalized.filePath).toBe('/src/app.ts');
    });

    it('maps "fs_create" to "Write"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'fs_create', timestamp: 2000 });
      expect(normalized.toolName).toBe('Write');
    });

    it('maps "fs_delete" to "Delete"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'fs_delete', timestamp: 2000 });
      expect(normalized.toolName).toBe('Delete');
    });

    it('maps "fs_list" to "Glob"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'fs_list', timestamp: 2000 });
      expect(normalized.toolName).toBe('Glob');
    });

    it('maps "fs_find" to "Glob"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'fs_find', timestamp: 2000 });
      expect(normalized.toolName).toBe('Glob');
    });

    it('maps "grep" to "Grep"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'grep', timestamp: 2000 });
      expect(normalized.toolName).toBe('Grep');
    });

    it('maps "search_code" to "Grep"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'search_code', timestamp: 2000 });
      expect(normalized.toolName).toBe('Grep');
    });

    it('maps "execute_bash" to "Bash"', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'execute_bash',
        timestamp: 2000,
        command: 'npm test',
      });
      expect(normalized.toolName).toBe('Bash');
      expect(normalized.command).toBe('npm test');
    });

    it('maps "run_shell" to "Bash"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'run_shell', timestamp: 2000 });
      expect(normalized.toolName).toBe('Bash');
    });

    it('maps "execute_command" to "Bash"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'execute_command', timestamp: 2000 });
      expect(normalized.toolName).toBe('Bash');
    });

    it('maps "explain_code" to "Read"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'explain_code', timestamp: 2000 });
      expect(normalized.toolName).toBe('Read');
    });

    it('maps "review_code" to "Read"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'review_code', timestamp: 2000 });
      expect(normalized.toolName).toBe('Read');
    });

    it('maps "transform_code" to "Edit"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'transform_code', timestamp: 2000 });
      expect(normalized.toolName).toBe('Edit');
    });

    it('accepts "toolName" field as an alternative to "tool"', () => {
      const normalized = adapter.normalizeToolCall({ toolName: 'fs_read', timestamp: 2000 });
      expect(normalized.toolName).toBe('Read');
      expect(normalized.platformToolName).toBe('fs_read');
    });

    it('normalizes path to filePath', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'fs_read', path: '/src/app.ts' });
      expect(normalized.filePath).toBe('/src/app.ts');
    });

    it('maps unknown tool to "Unknown" with platformToolName preserved', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'custom_q_tool', timestamp: 2000 });
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('custom_q_tool');
    });

    it('defaults missing tool name to "unknown"', () => {
      const normalized = adapter.normalizeToolCall({ timestamp: 2000 });
      expect(normalized.platformToolName).toBe('unknown');
      expect(normalized.toolName).toBe('Unknown');
    });

    it('defaults success to true when not provided', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'fs_read', timestamp: 2000 });
      expect(normalized.success).toBe(true);
    });

    it('preserves error field', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'fs_edit',
        timestamp: 2000,
        success: false,
        error: 'permission denied',
      });
      expect(normalized.success).toBe(false);
      expect(normalized.error).toBe('permission denied');
    });

    it('uses current time when timestamp is missing', () => {
      const before = Date.now();
      const normalized = adapter.normalizeToolCall({ tool: 'fs_read' });
      const after = Date.now();
      expect(normalized.timestamp).toBeGreaterThanOrEqual(before);
      expect(normalized.timestamp).toBeLessThanOrEqual(after);
    });

    it('includes inputSizeBytes and outputSizeBytes when present', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'fs_read',
        timestamp: 2000,
        inputSizeBytes: 50,
        outputSizeBytes: 1000,
      });
      expect(normalized.inputSizeBytes).toBe(50);
      expect(normalized.outputSizeBytes).toBe(1000);
    });

    it('includes sessionId when present', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'fs_read',
        timestamp: 2000,
        sessionId: 'q-sess-001',
      });
      expect(normalized.sessionId).toBe('q-sess-001');
    });
  });

  describe('getSessionMetadata', () => {
    it('returns platform "amazon-q"', () => {
      const meta = adapter.getSessionMetadata();
      expect(meta.platform).toBe('amazon-q');
    });

    it('includes ideVersion from AMAZON_Q_VERSION env var', () => {
      process.env.AMAZON_Q_VERSION = '1.2.0';
      const meta = adapter.getSessionMetadata();
      expect(meta.ideVersion).toBe('1.2.0');
    });

    it('omits ideVersion when AMAZON_Q_VERSION is unset', () => {
      const meta = adapter.getSessionMetadata();
      expect(meta.ideVersion).toBeUndefined();
    });
  });

  describe('isSupported', () => {
    it('returns true when AMAZON_Q_SESSION_ID is set', () => {
      process.env.AMAZON_Q_SESSION_ID = 'abc123';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns true when Q_DEVELOPER_SESSION is set', () => {
      process.env.Q_DEVELOPER_SESSION = 'dev-session-123';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns true when AWS_CODEWHISPERER_SESSION is set', () => {
      process.env.AWS_CODEWHISPERER_SESSION = 'cw-session-xyz';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns true when MCP_CLIENT is "amazon-q"', () => {
      process.env.MCP_CLIENT = 'amazon-q';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns false in a non-Amazon-Q environment', () => {
      expect(adapter.isSupported()).toBe(false);
    });
  });

  describe('getHookInstallInstructions', () => {
    it('returns non-empty Amazon Q-specific instructions', () => {
      const instructions = adapter.getHookInstallInstructions();
      expect(instructions.length).toBeGreaterThan(0);
      expect(instructions).toContain('Amazon Q');
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
      expect(adapter.mapToolName('fs_read')).toBe('Read');
    });

    it('returns "Unknown" for an unrecognized tool name', () => {
      expect(adapter.mapToolName('totally_made_up_tool')).toBe('Unknown');
    });
  });
});
