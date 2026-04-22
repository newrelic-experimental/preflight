import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { processHook, redact, hashInput, sizeOf, truncate } from './collector-script.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;
let tmpDir: string;
let bufferPath: string;
const originalEnv = { ...process.env };

beforeEach(() => {
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  tmpDir = resolve(tmpdir(), `nr-hook-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  bufferPath = resolve(tmpDir, 'buffer.jsonl');
  process.env.NEW_RELIC_AI_MCP_BUFFER_PATH = bufferPath;
  delete process.env.NEW_RELIC_AI_MCP_RECORD_CONTENT;
  delete process.env.NEW_RELIC_AI_MCP_MAX_CONTENT_LENGTH;
});

afterEach(() => {
  stderrSpy.mockRestore();
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  process.env = { ...originalEnv };
});

function makePreToolUse(overrides?: Record<string, unknown>): string {
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    tool_input: { file_path: '/tmp/test.ts', limit: 100 },
    tool_use_id: 'toolu_abc123',
    session_id: 'sess-001',
    cwd: '/projects/test',
    permission_mode: 'default',
    ...overrides,
  });
}

function makePostToolUse(overrides?: Record<string, unknown>): string {
  return JSON.stringify({
    hook_event_name: 'PostToolUse',
    tool_name: 'Write',
    tool_input: { file_path: '/tmp/out.ts', content: 'hello world' },
    tool_response: { filePath: '/tmp/out.ts', success: true },
    tool_use_id: 'toolu_def456',
    session_id: 'sess-001',
    cwd: '/projects/test',
    permission_mode: 'default',
    ...overrides,
  });
}

function makePostToolUseFailure(overrides?: Record<string, unknown>): string {
  return JSON.stringify({
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'Bash',
    tool_input: { command: 'npm test', description: 'Run tests' },
    tool_use_id: 'toolu_ghi789',
    session_id: 'sess-001',
    error: 'Command exited with non-zero status code 1',
    is_interrupt: false,
    cwd: '/projects/test',
    permission_mode: 'default',
    ...overrides,
  });
}

function readBufferEvents(): Record<string, unknown>[] {
  if (!existsSync(bufferPath)) return [];
  const raw = readFileSync(bufferPath, 'utf-8').trim();
  if (!raw) return [];
  return raw.split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
}

describe('collector-script', () => {
  describe('processHook() — PreToolUse', () => {
    it('writes a valid pre event to the buffer', () => {
      processHook(makePreToolUse());

      const events = readBufferEvents();
      expect(events).toHaveLength(1);

      const event = events[0]!;
      expect(event.mode).toBe('pre');
      expect(event.tool).toBe('Read');
      expect(event.timestamp).toEqual(expect.any(Number));
      expect(event.inputSize).toEqual(expect.any(Number));
      expect(event.inputHash).toEqual(expect.any(String));
      expect((event.inputHash as string).length).toBe(16);
    });

    it('captures session metadata', () => {
      processHook(makePreToolUse());

      const event = readBufferEvents()[0]!;
      expect(event.sessionId).toBe('sess-001');
      expect(event.toolUseId).toBe('toolu_abc123');
    });

    it('does not include content fields by default', () => {
      processHook(makePreToolUse());

      const event = readBufferEvents()[0]!;
      expect(event.inputContent).toBeUndefined();
      expect(event.outputContent).toBeUndefined();
    });

    it('stores only metadata fields from toolInput on pre events', () => {
      const input = { file_path: '/tmp/test.ts', limit: 100 };
      processHook(makePreToolUse({ tool_input: input }));

      const event = readBufferEvents()[0]!;
      // Only the metadata fields needed for parsing are stored, not raw content
      expect(event.toolInput).toEqual({ file_path: '/tmp/test.ts', limit: 100 });
    });

    it('does not store raw content strings in toolInput', () => {
      const input = { file_path: '/a.ts', content: 'line1\nline2\nline3' };
      processHook(makePreToolUse({ tool_name: 'Write', tool_input: input }));

      const event = readBufferEvents()[0]!;
      const toolInput = event.toolInput as Record<string, unknown>;
      // Content is replaced with numeric metadata
      expect(toolInput.content).toBeUndefined();
      expect(toolInput.contentLength).toBe(17);
      expect(toolInput.lineCount).toBe(3);
      expect(toolInput.file_path).toBe('/a.ts');
    });
  });

  describe('processHook() — PostToolUse (toolOutput)', () => {
    it('stores output metadata fields when available', () => {
      const response = { exitCode: 0, stdout: 'lots of output here' };
      processHook(makePostToolUse({ tool_name: 'Bash', tool_response: response }));

      const event = readBufferEvents()[0]!;
      // Only exitCode is extracted, not raw stdout
      expect(event.toolOutput).toEqual({ exitCode: 0 });
    });

    it('omits toolOutput when no parseable output fields exist', () => {
      const response = { filePath: '/tmp/out.ts', success: true };
      processHook(makePostToolUse({ tool_response: response }));

      const event = readBufferEvents()[0]!;
      expect(event.toolOutput).toBeUndefined();
    });
  });

  describe('processHook() — PostToolUse', () => {
    it('writes a valid post event with success=true', () => {
      processHook(makePostToolUse());

      const events = readBufferEvents();
      expect(events).toHaveLength(1);

      const event = events[0]!;
      expect(event.mode).toBe('post');
      expect(event.tool).toBe('Write');
      expect(event.success).toBe(true);
      expect(event.outputSize).toEqual(expect.any(Number));
      expect(event.outputSize).toBeGreaterThan(0);
    });

    it('captures session metadata', () => {
      processHook(makePostToolUse());

      const event = readBufferEvents()[0]!;
      expect(event.sessionId).toBe('sess-001');
      expect(event.toolUseId).toBe('toolu_def456');
    });
  });

  describe('processHook() — PostToolUseFailure', () => {
    it('writes a post event with success=false and error', () => {
      processHook(makePostToolUseFailure());

      const events = readBufferEvents();
      expect(events).toHaveLength(1);

      const event = events[0]!;
      expect(event.mode).toBe('post');
      expect(event.tool).toBe('Bash');
      expect(event.success).toBe(false);
      expect(event.error).toBe('Command exited with non-zero status code 1');
      expect(event.isInterrupt).toBe(false);
    });

    it('captures is_interrupt flag when true', () => {
      processHook(makePostToolUseFailure({ is_interrupt: true }));

      const event = readBufferEvents()[0]!;
      expect(event.isInterrupt).toBe(true);
    });
  });

  describe('recordContent', () => {
    it('includes redacted input content when recordContent=true (PreToolUse)', () => {
      process.env.NEW_RELIC_AI_MCP_RECORD_CONTENT = 'true';

      processHook(makePreToolUse({
        tool_input: { file_path: '/tmp/test.ts', content: 'API_KEY = sk-secret123' },
      }));

      const event = readBufferEvents()[0]!;
      expect(event.inputContent).toBeDefined();
      expect(event.inputContent).toContain('[REDACTED]');
      expect(event.inputContent).not.toContain('sk-secret123');
    });

    it('includes redacted output content when recordContent=true (PostToolUse)', () => {
      process.env.NEW_RELIC_AI_MCP_RECORD_CONTENT = 'true';

      processHook(makePostToolUse({
        tool_response: { content: 'Bearer eyJhbGciOiJIUzI1NiJ9.secret' },
      }));

      const event = readBufferEvents()[0]!;
      expect(event.outputContent).toBeDefined();
      expect(event.outputContent).toContain('[REDACTED]');
      expect(event.outputContent).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    });

    it('truncates content exceeding max length', () => {
      process.env.NEW_RELIC_AI_MCP_RECORD_CONTENT = 'true';
      process.env.NEW_RELIC_AI_MCP_MAX_CONTENT_LENGTH = '50';

      const longContent = 'x'.repeat(100_000);
      processHook(makePostToolUse({
        tool_response: { data: longContent },
      }));

      const event = readBufferEvents()[0]!;
      const content = event.outputContent as string;
      expect(content.length).toBeLessThan(100);
      expect(content).toContain('...[truncated]');
    });
  });

  describe('buffer file handling', () => {
    it('creates buffer file if it does not exist', () => {
      expect(existsSync(bufferPath)).toBe(false);
      processHook(makePreToolUse());
      expect(existsSync(bufferPath)).toBe(true);
    });

    it('creates buffer directory if it does not exist', () => {
      const deepPath = resolve(tmpDir, 'deep', 'nested', 'buffer.jsonl');
      process.env.NEW_RELIC_AI_MCP_BUFFER_PATH = deepPath;

      processHook(makePreToolUse());
      expect(existsSync(deepPath)).toBe(true);
    });

    it('exits gracefully when buffer directory is unwritable', () => {
      // Point to an impossible path — processHook should not throw
      process.env.NEW_RELIC_AI_MCP_BUFFER_PATH = '/dev/null/impossible/buffer.jsonl';

      expect(() => processHook(makePreToolUse())).not.toThrow();
    });

    it('handles rapid sequential writes without corruption', () => {
      const count = 50;
      for (let i = 0; i < count; i++) {
        processHook(makePreToolUse({ tool_name: `tool-${i}` }));
      }

      const events = readBufferEvents();
      expect(events).toHaveLength(count);
      for (let i = 0; i < count; i++) {
        expect(events[i]!.tool).toBe(`tool-${i}`);
      }
    });
  });

  describe('unknown events', () => {
    it('silently ignores unknown hook event names', () => {
      processHook(JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'sess-001',
      }));

      expect(readBufferEvents()).toHaveLength(0);
    });
  });

  describe('helper functions', () => {
    it('redact() replaces API keys', () => {
      expect(redact('API_KEY = my-secret-key')).toContain('[REDACTED]');
      expect(redact('API_KEY = my-secret-key')).not.toContain('my-secret-key');
    });

    it('redact() replaces bearer tokens', () => {
      expect(redact('Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig')).toContain('[REDACTED]');
    });

    it('redact() replaces GitHub tokens', () => {
      expect(redact('ghp_1234567890abcdef')).toBe('[REDACTED]');
    });

    it('redact() leaves normal text unchanged', () => {
      expect(redact('function hello() { return 42; }')).toBe('function hello() { return 42; }');
    });

    it('hashInput() produces a 16-char hex string', () => {
      const hash = hashInput({ file_path: '/tmp/test' });
      expect(hash).toHaveLength(16);
      expect(hash).toMatch(/^[0-9a-f]+$/);
    });

    it('hashInput() is deterministic', () => {
      const input = { a: 1, b: 'hello' };
      expect(hashInput(input)).toBe(hashInput(input));
    });

    it('sizeOf() returns string length for strings', () => {
      expect(sizeOf('hello')).toBe(5);
    });

    it('sizeOf() returns JSON length for objects', () => {
      expect(sizeOf({ a: 1 })).toBe(JSON.stringify({ a: 1 }).length);
    });

    it('sizeOf() returns 0 for null/undefined', () => {
      expect(sizeOf(null)).toBe(0);
      expect(sizeOf(undefined)).toBe(0);
    });

    it('truncate() leaves short strings unchanged', () => {
      expect(truncate('hello', 100)).toBe('hello');
    });

    it('truncate() truncates and adds marker', () => {
      const result = truncate('hello world', 5);
      expect(result).toBe('hello...[truncated]');
    });
  });

  describe('integration — script via child process', () => {
    it('processes PreToolUse when piped via stdin', () => {
      const scriptPath = resolve(__dirname, '..', '..', 'dist', 'hooks', 'collector-script.js');

      // Skip if not built yet
      if (!existsSync(scriptPath)) {
        return;
      }

      const payload = makePreToolUse();
      execFileSync('node', [scriptPath], {
        input: payload,
        env: {
          ...process.env,
          NEW_RELIC_AI_MCP_BUFFER_PATH: bufferPath,
        },
        timeout: 5000,
      });

      const events = readBufferEvents();
      expect(events).toHaveLength(1);
      expect(events[0]!.mode).toBe('pre');
      expect(events[0]!.tool).toBe('Read');
    });
  });
});
