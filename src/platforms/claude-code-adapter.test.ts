import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ClaudeCodeAdapter } from './claude-code-adapter.js';
import type { ToolCallRecord } from '../storage/types.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  for (const key of ['CLAUDE_CODE', 'CLAUDE_CODE_VERSION', 'CLAUDE_MODEL', 'MCP_CLIENT']) {
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

function makeRecord(overrides?: Partial<ToolCallRecord>): ToolCallRecord {
  return {
    id: 'rec-001',
    sessionId: 'sess-001',
    toolName: 'Read',
    toolUseId: 'toolu_001',
    timestamp: 1000,
    durationMs: 42,
    success: true,
    inputSizeBytes: 100,
    outputSizeBytes: 500,
    inputHash: 'abc123',
    ...overrides,
  };
}

describe('ClaudeCodeAdapter', () => {
  const adapter = new ClaudeCodeAdapter();

  it('has platformName "claude-code"', () => {
    expect(adapter.platformName).toBe('claude-code');
  });

  describe('normalizeToolCall', () => {
    it('converts a ToolCallRecord to NormalizedToolCall with correct fields', () => {
      const record = makeRecord();
      const normalized = adapter.normalizeToolCall(record);

      expect(normalized.toolName).toBe('Read');
      expect(normalized.platformToolName).toBe('Read');
      expect(normalized.platform).toBe('claude-code');
      expect(normalized.timestamp).toBe(1000);
      expect(normalized.durationMs).toBe(42);
      expect(normalized.success).toBe(true);
      expect(normalized.sessionId).toBe('sess-001');
      expect(normalized.toolUseId).toBe('toolu_001');
      expect(normalized.inputSizeBytes).toBe(100);
      expect(normalized.outputSizeBytes).toBe(500);
      expect(normalized.inputHash).toBe('abc123');
    });

    it('handles records with null sessionId', () => {
      const record = makeRecord({ sessionId: null });
      const normalized = adapter.normalizeToolCall(record);
      expect(normalized.sessionId).toBeUndefined();
    });

    it('handles records with null durationMs', () => {
      const record = makeRecord({ durationMs: null });
      const normalized = adapter.normalizeToolCall(record);
      expect(normalized.durationMs).toBeNull();
    });

    it('includes error when present', () => {
      const record = makeRecord({ success: false, error: 'file not found' });
      const normalized = adapter.normalizeToolCall(record);
      expect(normalized.success).toBe(false);
      expect(normalized.error).toBe('file not found');
    });

    it('includes filePath when present on record', () => {
      const record = { ...makeRecord(), filePath: '/src/index.ts' };
      const normalized = adapter.normalizeToolCall(record);
      expect(normalized.filePath).toBe('/src/index.ts');
    });

    it('includes command when present on record', () => {
      const record = { ...makeRecord(), command: 'npm test' };
      const normalized = adapter.normalizeToolCall(record);
      expect(normalized.command).toBe('npm test');
    });
  });

  describe('getSessionMetadata', () => {
    it('returns platform "claude-code"', () => {
      const meta = adapter.getSessionMetadata();
      expect(meta.platform).toBe('claude-code');
    });

    it('includes model from CLAUDE_MODEL env var', () => {
      process.env.CLAUDE_MODEL = 'claude-sonnet-4-6';
      const meta = adapter.getSessionMetadata();
      expect(meta.model).toBe('claude-sonnet-4-6');
    });

    it('includes ideVersion from CLAUDE_CODE_VERSION env var', () => {
      process.env.CLAUDE_CODE_VERSION = '1.2.3';
      const meta = adapter.getSessionMetadata();
      expect(meta.ideVersion).toBe('1.2.3');
    });

    it('omits model and ideVersion when env vars are unset', () => {
      const meta = adapter.getSessionMetadata();
      expect(meta.model).toBeUndefined();
      expect(meta.ideVersion).toBeUndefined();
    });
  });

  describe('isSupported', () => {
    it('returns true when CLAUDE_CODE is set', () => {
      process.env.CLAUDE_CODE = '1';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns true when CLAUDE_CODE_VERSION is set', () => {
      process.env.CLAUDE_CODE_VERSION = '1.0.0';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns true when MCP_CLIENT is "claude-code"', () => {
      process.env.MCP_CLIENT = 'claude-code';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns false when no Claude Code env vars are set', () => {
      expect(adapter.isSupported()).toBe(false);
    });
  });

  describe('getHookInstallInstructions', () => {
    it('returns non-empty platform-specific instructions', () => {
      const instructions = adapter.getHookInstallInstructions();
      expect(instructions.length).toBeGreaterThan(0);
      expect(instructions).toContain('Claude Code');
    });
  });

  describe('initialize', () => {
    it('completes without error', async () => {
      await expect(adapter.initialize({})).resolves.toBeUndefined();
    });
  });

  describe('mapToolName', () => {
    it('passes the tool name through unchanged', () => {
      expect(adapter.mapToolName('Read')).toBe('Read');
    });
  });
});
