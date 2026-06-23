import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { CopilotAdapter, parseCopilotUsageResponse } from './copilot-adapter.js';
import type { CopilotToolCallEvent } from './copilot-adapter.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;
const savedEnv: Record<string, string | undefined> = {};

const ENV_KEYS = [
  'NEW_RELIC_AI_PLATFORM',
  'MCP_CLIENT',
  'VSCODE_VERSION',
  'COPILOT_EXTENSION_VERSION',
];

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  for (const key of ENV_KEYS) {
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

describe('CopilotAdapter', () => {
  const adapter = new CopilotAdapter();

  it('has platformName "copilot"', () => {
    expect(adapter.platformName).toBe('copilot');
  });

  describe('normalizeToolCall', () => {
    it('converts a "file_edit" event to type "Edit"', () => {
      const event: CopilotToolCallEvent = {
        type: 'file_edit',
        timestamp: 5000,
        filePath: '/src/app.ts',
        success: true,
      };
      const normalized = adapter.normalizeToolCall(event);
      expect(normalized.toolName).toBe('Edit');
      expect(normalized.platformToolName).toBe('file_edit');
      expect(normalized.platform).toBe('copilot');
      expect(normalized.filePath).toBe('/src/app.ts');
    });

    it('converts a "terminal_command" event to type "Bash"', () => {
      const event: CopilotToolCallEvent = {
        type: 'terminal_command',
        timestamp: 5000,
        command: 'npm test',
      };
      const normalized = adapter.normalizeToolCall(event);
      expect(normalized.toolName).toBe('Bash');
      expect(normalized.command).toBe('npm test');
    });

    it('converts a "file_open" event to type "Read"', () => {
      const event: CopilotToolCallEvent = {
        type: 'file_open',
        timestamp: 5000,
        filePath: '/src/utils.ts',
      };
      const normalized = adapter.normalizeToolCall(event);
      expect(normalized.toolName).toBe('Read');
      expect(normalized.filePath).toBe('/src/utils.ts');
    });

    it('converts a "file_create" event to type "Write"', () => {
      const normalized = adapter.normalizeToolCall({
        type: 'file_create',
        timestamp: 5000,
        filePath: '/src/new-file.ts',
      });
      expect(normalized.toolName).toBe('Write');
    });

    it('converts a "file_delete" event to type "Delete"', () => {
      const normalized = adapter.normalizeToolCall({
        type: 'file_delete',
        timestamp: 5000,
      });
      expect(normalized.toolName).toBe('Delete');
    });

    it('converts a "task" event to type "Bash"', () => {
      const normalized = adapter.normalizeToolCall({
        type: 'task',
        timestamp: 5000,
        command: 'build',
      });
      expect(normalized.toolName).toBe('Bash');
    });

    it('maps unknown event type to "Unknown"', () => {
      const normalized = adapter.normalizeToolCall({
        type: 'copilot_special',
        timestamp: 5000,
      } as unknown);
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('copilot_special');
    });

    it('infers durationMs from timestamp and endTimestamp', () => {
      const event: CopilotToolCallEvent = {
        type: 'file_edit',
        timestamp: 5000,
        endTimestamp: 5500,
      };
      const normalized = adapter.normalizeToolCall(event);
      expect(normalized.durationMs).toBe(500);
    });

    it('sets durationMs to null when endTimestamp is missing', () => {
      const event: CopilotToolCallEvent = {
        type: 'file_edit',
        timestamp: 5000,
      };
      const normalized = adapter.normalizeToolCall(event);
      expect(normalized.durationMs).toBeNull();
    });

    it('returns null durationMs when endTimestamp is present but timestamp is missing', () => {
      const event: CopilotToolCallEvent = {
        type: 'file_edit',
        endTimestamp: Date.now() + 300,
      };
      const normalized = adapter.normalizeToolCall(event);
      expect(normalized.durationMs).toBeNull();
    });

    it('returns null durationMs when neither timestamp nor endTimestamp is present', () => {
      const normalized = adapter.normalizeToolCall({ type: 'file_edit' });
      expect(normalized.durationMs).toBeNull();
    });

    it('clamps durationMs to 0 when clock skew makes endTimestamp earlier than timestamp', () => {
      const event: CopilotToolCallEvent = {
        type: 'file_edit',
        timestamp: 5500,
        endTimestamp: 5000,
      };
      const normalized = adapter.normalizeToolCall(event);
      expect(normalized.durationMs).toBe(0);
    });

    it('defaults success to true', () => {
      const normalized = adapter.normalizeToolCall({ type: 'file_edit', timestamp: 5000 });
      expect(normalized.success).toBe(true);
    });

    it('preserves error field', () => {
      const normalized = adapter.normalizeToolCall({
        type: 'terminal_command',
        timestamp: 5000,
        success: false,
        error: 'command not found',
      });
      expect(normalized.success).toBe(false);
      expect(normalized.error).toBe('command not found');
    });

    it('uses current time when timestamp is missing', () => {
      const before = Date.now();
      const normalized = adapter.normalizeToolCall({ type: 'file_edit' });
      const after = Date.now();
      expect(normalized.timestamp).toBeGreaterThanOrEqual(before);
      expect(normalized.timestamp).toBeLessThanOrEqual(after);
    });

    it('includes inputSizeBytes and outputSizeBytes', () => {
      const normalized = adapter.normalizeToolCall({
        type: 'file_edit',
        timestamp: 5000,
        inputSizeBytes: 100,
        outputSizeBytes: 200,
      });
      expect(normalized.inputSizeBytes).toBe(100);
      expect(normalized.outputSizeBytes).toBe(200);
    });

    it('includes sessionId', () => {
      const normalized = adapter.normalizeToolCall({
        type: 'file_edit',
        timestamp: 5000,
        sessionId: 'copilot-sess-001',
      });
      expect(normalized.sessionId).toBe('copilot-sess-001');
    });
  });

  describe('getSessionMetadata', () => {
    it('returns platform "copilot"', () => {
      const meta = adapter.getSessionMetadata();
      expect(meta.platform).toBe('copilot');
    });

    it('includes ideVersion from VSCODE_VERSION', () => {
      process.env.VSCODE_VERSION = '1.90.0';
      const meta = adapter.getSessionMetadata();
      expect(meta.ideVersion).toBe('1.90.0');
    });

    it('includes extensionVersion from COPILOT_EXTENSION_VERSION', () => {
      process.env.COPILOT_EXTENSION_VERSION = '1.200.0';
      const meta = adapter.getSessionMetadata();
      expect(meta.extensionVersion).toBe('1.200.0');
    });

    it('omits ideVersion and extensionVersion when env vars are unset', () => {
      const meta = adapter.getSessionMetadata();
      expect(meta.ideVersion).toBeUndefined();
      expect(meta.extensionVersion).toBeUndefined();
    });
  });

  describe('isSupported', () => {
    it('returns true when NEW_RELIC_AI_PLATFORM is "copilot"', () => {
      process.env.NEW_RELIC_AI_PLATFORM = 'copilot';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns true when MCP_CLIENT is "copilot"', () => {
      process.env.MCP_CLIENT = 'copilot';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns false when copilot env vars are absent', () => {
      expect(adapter.isSupported()).toBe(false);
    });
  });

  describe('getHookInstallInstructions', () => {
    it('returns non-empty Copilot-specific instructions', () => {
      const instructions = adapter.getHookInstallInstructions();
      expect(instructions.length).toBeGreaterThan(0);
      expect(instructions).toContain('Copilot');
      expect(instructions).toContain('VS Code');
    });
  });

  describe('initialize', () => {
    it('completes without error', async () => {
      await expect(adapter.initialize({})).resolves.toBeUndefined();
    });
  });
});

describe('parseCopilotUsageResponse', () => {
  it('parses a valid API response', () => {
    const raw = [
      {
        day: '2026-04-01',
        total_suggestions_count: 150,
        total_acceptances_count: 90,
        total_lines_suggested: 500,
        total_lines_accepted: 300,
        total_active_users: 5,
      },
      {
        day: '2026-04-02',
        total_suggestions_count: 200,
        total_acceptances_count: 120,
      },
    ];
    const records = parseCopilotUsageResponse(raw);
    expect(records).toHaveLength(2);
    expect(records[0].day).toBe('2026-04-01');
    expect(records[0].total_suggestions_count).toBe(150);
    expect(records[0].total_acceptances_count).toBe(90);
    expect(records[0].total_lines_suggested).toBe(500);
    expect(records[0].total_lines_accepted).toBe(300);
    expect(records[0].total_active_users).toBe(5);
    expect(records[1].day).toBe('2026-04-02');
  });

  it('returns empty array for non-array input', () => {
    expect(parseCopilotUsageResponse(null)).toEqual([]);
    expect(parseCopilotUsageResponse('string')).toEqual([]);
    expect(parseCopilotUsageResponse(42)).toEqual([]);
  });

  it('filters out items without a day field', () => {
    const raw = [
      { day: '2026-04-01', total_suggestions_count: 10 },
      { total_suggestions_count: 20 },
      null,
      'garbage',
    ];
    const records = parseCopilotUsageResponse(raw);
    expect(records).toHaveLength(1);
    expect(records[0].day).toBe('2026-04-01');
  });

  it('returns empty array for empty input', () => {
    expect(parseCopilotUsageResponse([])).toEqual([]);
  });
});

describe('timing inference', () => {
  const adapter = new CopilotAdapter();

  it('two events 500ms apart produce durationMs ≈ 500', () => {
    const event: CopilotToolCallEvent = {
      type: 'file_edit',
      timestamp: 10000,
      endTimestamp: 10500,
    };
    const normalized = adapter.normalizeToolCall(event);
    expect(normalized.durationMs).toBe(500);
  });

  it('events 1200ms apart produce durationMs ≈ 1200', () => {
    const event: CopilotToolCallEvent = {
      type: 'terminal_command',
      timestamp: 20000,
      endTimestamp: 21200,
    };
    const normalized = adapter.normalizeToolCall(event);
    expect(normalized.durationMs).toBe(1200);
  });
});
