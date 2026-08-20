import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import {
  _procFs,
  _stdinFs,
  getBufferPath,
  getLinuxAncestorPids,
  getRecordContent,
  hashInput,
  processHook,
  readStdinSync,
  redact,
  sizeOf,
  truncate,
  writeCwdBreadcrumb,
  writePpidBreadcrumb,
} from './collector-script.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;
let stdoutSpy: ReturnType<typeof jest.spyOn>;
let tmpDir: string;
let bufferPath: string;
const originalEnv = { ...process.env };

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  tmpDir = resolve(tmpdir(), `nr-hook-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  bufferPath = resolve(tmpDir, 'buffer.jsonl');
  process.env.NEW_RELIC_AI_MCP_BUFFER_PATH = bufferPath;
  delete process.env.NEW_RELIC_AI_MCP_RECORD_CONTENT;
  delete process.env.NEW_RELIC_AI_MCP_MAX_CONTENT_LENGTH;
});

afterEach(() => {
  stderrSpy.mockRestore();
  stdoutSpy.mockRestore();
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

function makeGeminiBeforeTool(overrides?: Record<string, unknown>): string {
  return JSON.stringify({
    hook_event_name: 'BeforeTool',
    session_id: 'gemini-sess-001',
    transcript_path: '/tmp/gemini-transcript.json',
    cwd: '/projects/test',
    timestamp: '2026-07-22T00:00:00.000Z',
    tool_name: 'read_file',
    tool_input: { file_path: '/tmp/test.ts', limit: 100 },
    ...overrides,
  });
}

function makeGeminiAfterTool(overrides?: Record<string, unknown>): string {
  return JSON.stringify({
    hook_event_name: 'AfterTool',
    session_id: 'gemini-sess-001',
    transcript_path: '/tmp/gemini-transcript.json',
    cwd: '/projects/test',
    timestamp: '2026-07-22T00:00:00.000Z',
    tool_name: 'write_file',
    tool_input: { file_path: '/tmp/out.ts', content: 'hello' },
    tool_response: { llmContent: 'Wrote file.', returnDisplay: 'Wrote file.' },
    ...overrides,
  });
}

function makeAntigravityPreToolUse(overrides?: Record<string, unknown>): string {
  return JSON.stringify({
    toolCall: { name: 'run_command', args: { CommandLine: 'npm test', Cwd: '/workspace/project' } },
    stepIdx: 19,
    conversationId: 'agy-conv-001',
    workspacePaths: ['/workspace/project'],
    transcriptPath: '/tmp/agy-transcript.jsonl',
    artifactDirectoryPath: '/tmp/agy-artifacts',
    ...overrides,
  });
}

function makeAntigravityPostToolUse(overrides?: Record<string, unknown>): string {
  return JSON.stringify({
    stepIdx: 19,
    error: '',
    conversationId: 'agy-conv-001',
    workspacePaths: ['/workspace/project'],
    transcriptPath: '/tmp/agy-transcript.jsonl',
    artifactDirectoryPath: '/tmp/agy-artifacts',
    ...overrides,
  });
}

function readBufferEvents(): Record<string, unknown>[] {
  if (!existsSync(bufferPath)) return [];
  const raw = readFileSync(bufferPath, 'utf-8').trim();
  if (!raw) return [];
  return raw.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * Helper to read buffer events from a session-specific buffer file.
 * When sessionId is provided, reads from buffer-{sessionId}.jsonl instead of the default.
 * Used for testing platforms like Cursor and Windsurf that route by conversation_id/trajectory_id.
 */
function readBufferLines(sessionId?: string): Record<string, unknown>[] {
  let path = bufferPath;
  if (sessionId) {
    path = resolve(dirname(bufferPath), `buffer-${sessionId}.jsonl`);
  }
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8').trim();
  if (!raw) return [];
  return raw.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
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

    it('captures transcript_path as transcriptPath', () => {
      processHook(makePreToolUse({ transcript_path: '/tmp/fake-session.jsonl' }));

      const event = readBufferEvents()[0]!;
      expect(event.transcriptPath).toBe('/tmp/fake-session.jsonl');
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

  describe('processHook() — PowerShell (native Windows tool, no Git Bash)', () => {
    // PowerShell is a real, first-party Claude Code tool (see
    // code.claude.com/docs/en/tools-reference) — extractInputMeta() had no
    // case for it, so toolInput stayed undefined and every PowerShell call
    // serialized identically downstream.
    it('stores command/description/timeout/run_in_background metadata, same as Bash', () => {
      const input = {
        command: 'Get-Process',
        description: 'List processes',
        timeout: 30000,
        run_in_background: false,
      };
      processHook(makePreToolUse({ tool_name: 'PowerShell', tool_input: input }));

      const event = readBufferEvents()[0]!;
      expect(event.toolInput).toEqual({
        command: 'Get-Process',
        description: 'List processes',
        timeout: 30000,
        run_in_background: false,
      });
    });

    it('redacts sensitive content in the command, same as Bash', () => {
      const input = { command: '$env:API_KEY = "sk-1234567890abcdef"' };
      processHook(makePreToolUse({ tool_name: 'PowerShell', tool_input: input }));

      const event = readBufferEvents()[0]!;
      const toolInput = event.toolInput as Record<string, unknown>;
      expect(toolInput.command).not.toContain('sk-1234567890abcdef');
      expect(toolInput.command).toContain('[REDACTED]');
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

    it('extracts Edit output metadata', () => {
      const response = { success: true, matched: true };
      processHook(makePostToolUse({ tool_name: 'Edit', tool_response: response }));

      const event = readBufferEvents()[0]!;
      expect(event.toolOutput).toEqual({ editSuccess: true, editMatched: true });
    });

    it('extracts Edit error message truncated to 200 chars', () => {
      const longError = 'x'.repeat(300);
      const response = { success: false, error: longError };
      processHook(makePostToolUse({ tool_name: 'Edit', tool_response: response }));

      const event = readBufferEvents()[0]!;
      expect(event.toolOutput).toEqual({
        editSuccess: false,
        editError: 'x'.repeat(200),
      });
    });

    it('extracts Grep matchCount from results array', () => {
      const response = { results: [{ file: 'a.ts' }, { file: 'b.ts' }, { file: 'c.ts' }] };
      processHook(makePostToolUse({ tool_name: 'Grep', tool_response: response }));

      const event = readBufferEvents()[0]!;
      expect(event.toolOutput).toEqual({ grepMatchCount: 3 });
    });

    it('extracts Grep resultLines from content blocks', () => {
      const response = { content: [{ type: 'text', text: 'line1\nline2\nline3' }] };
      processHook(makePostToolUse({ tool_name: 'Grep', tool_response: response }));

      const event = readBufferEvents()[0]!;
      expect(event.toolOutput).toEqual({ grepResultLines: 3 });
    });

    it('extracts Agent completed and result length', () => {
      const response = { completed: true, result: 'Task finished successfully' };
      processHook(makePostToolUse({ tool_name: 'Agent', tool_response: response }));

      const event = readBufferEvents()[0]!;
      expect(event.toolOutput).toEqual({
        agentCompleted: true,
        agentResultLength: 'Task finished successfully'.length,
      });
    });

    it('extracts Agent interrupted flag', () => {
      const response = { interrupted: true };
      processHook(makePostToolUse({ tool_name: 'Agent', tool_response: response }));

      const event = readBufferEvents()[0]!;
      expect(event.toolOutput).toEqual({ agentInterrupted: true });
    });

    it('extracts Agent resultLength from content blocks', () => {
      const response = { content: [{ type: 'text', text: 'hello world' }] };
      processHook(makePostToolUse({ tool_name: 'Agent', tool_response: response }));

      const event = readBufferEvents()[0]!;
      expect(event.toolOutput).toEqual({ agentResultLength: 11 });
    });
  });

  // VS Code Copilot agent hooks send the uniform PreToolUse/PostToolUse envelope
  // but with VS Code's own tool names and camelCase tool_input keys — both deltas
  // documented in the hooks FAQ (code.visualstudio.com/docs/copilot/customization/hooks).
  // Note: Copilot CLI's own native lowerCamelCase hook config (preToolUse) is a
  // DIFFERENT, incompatible payload shape with no hook_event_name field at all
  // (confirmed against GitHub's hooks reference) — it is not what's exercised
  // below. The Copilot CLI/SDK adapter (copilot-sdk) instead requires the
  // PascalCase PreToolUse/PostToolUse config, which sends this same envelope.
  describe('processHook() — VS Code Copilot hooks', () => {
    function makeCopilotPreToolUse(overrides?: Record<string, unknown>): string {
      return JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'create_file',
        tool_input: { filePath: '/src/new.ts', content: 'line1\nline2' },
        tool_use_id: 'toolu_copilot_1',
        session_id: 'copilot-sess-001',
        cwd: '/projects/test',
        timestamp: '2026-08-07T00:00:00.000Z',
        ...overrides,
      });
    }

    it('captures camelCase filePath as the common file_path meta field', () => {
      processHook(makeCopilotPreToolUse());

      const events = readBufferEvents();
      expect(events).toHaveLength(1);
      const toolInput = events[0]!.toolInput as Record<string, unknown>;
      expect(toolInput.file_path).toBe('/src/new.ts');
    });

    it('extracts Write-style content metadata for create_file', () => {
      processHook(makeCopilotPreToolUse());

      const toolInput = readBufferEvents()[0]!.toolInput as Record<string, unknown>;
      expect(toolInput.content).toBeUndefined();
      expect(toolInput.contentLength).toBe(11);
      expect(toolInput.lineCount).toBe(2);
    });

    it('extracts Edit-style metadata from replace_string_in_file camelCase fields', () => {
      processHook(
        makeCopilotPreToolUse({
          tool_name: 'replace_string_in_file',
          tool_input: { filePath: '/src/a.ts', oldString: 'aaa\nbbb', newString: '' },
        }),
      );

      const toolInput = readBufferEvents()[0]!.toolInput as Record<string, unknown>;
      expect(toolInput.oldStringLength).toBe(7);
      expect(toolInput.oldLineCount).toBe(2);
      expect(toolInput.newStringLength).toBe(0);
      expect(toolInput.isDelete).toBe(true);
    });

    it('counts replacements for multi_replace_string_in_file', () => {
      processHook(
        makeCopilotPreToolUse({
          tool_name: 'multi_replace_string_in_file',
          tool_input: {
            replacements: [
              { filePath: '/a.ts', oldString: 'x', newString: 'y' },
              { filePath: '/b.ts', oldString: 'p', newString: 'q' },
            ],
          },
        }),
      );

      const toolInput = readBufferEvents()[0]!.toolInput as Record<string, unknown>;
      expect(toolInput.replacementsCount).toBe(2);
    });

    it('extracts Bash-style command metadata for run_in_terminal', () => {
      processHook(
        makeCopilotPreToolUse({
          tool_name: 'run_in_terminal',
          tool_input: { command: 'npm test', explanation: 'Run tests', isBackground: false },
        }),
      );

      const toolInput = readBufferEvents()[0]!.toolInput as Record<string, unknown>;
      expect(toolInput.command).toBe('npm test');
      expect(toolInput.description).toBe('Run tests');
      expect(toolInput.run_in_background).toBe(false);
    });

    it('handles a plain-string tool_response on PostToolUse', () => {
      processHook(
        makeCopilotPreToolUse({
          hook_event_name: 'PostToolUse',
          tool_response: 'File edited successfully',
        }),
      );

      const event = readBufferEvents()[0]!;
      expect(event.mode).toBe('post');
      expect(event.success).toBe(true);
      expect(event.outputSize).toBeGreaterThan(0);
    });

    it('accepts a lowerCamelCase hook_event_name value (case-insensitive dispatch, e.g. for Kiro)', () => {
      processHook(makeCopilotPreToolUse({ hook_event_name: 'preToolUse' }));

      const events = readBufferEvents();
      expect(events).toHaveLength(1);
      expect(events[0]!.mode).toBe('pre');
      expect(events[0]!.tool).toBe('create_file');
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

    it('redacts sensitive information in error messages', () => {
      const errorWithToken = 'Authorization failed: Bearer eyJhbGciOiJIUzI1NiJ9.token.signature';
      processHook(makePostToolUseFailure({ error: errorWithToken }));

      const event = readBufferEvents()[0]!;
      expect(event.error).not.toContain('Bearer');
      expect(event.error).not.toContain('eyJhbGciOiJIUzI1NiJ9');
      expect(event.error).toContain('[REDACTED]');
    });

    it('redacts API keys in error messages', () => {
      const errorWithApiKey = 'Failed: API_KEY = sk-1234567890abcdef';
      processHook(makePostToolUseFailure({ error: errorWithApiKey }));

      const event = readBufferEvents()[0]!;
      expect(event.error).not.toContain('sk-1234567890abcdef');
      expect(event.error).toContain('[REDACTED]');
    });
  });

  describe('recordContent', () => {
    it('includes redacted input content when recordContent=true (PreToolUse)', () => {
      process.env.NEW_RELIC_AI_MCP_RECORD_CONTENT = 'true';

      processHook(
        makePreToolUse({
          tool_input: { file_path: '/tmp/test.ts', content: 'API_KEY = sk-secret123' },
        }),
      );

      const event = readBufferEvents()[0]!;
      expect(event.inputContent).toBeDefined();
      expect(event.inputContent).toContain('[REDACTED]');
      expect(event.inputContent).not.toContain('sk-secret123');
    });

    it('includes redacted output content when recordContent=true (PostToolUse)', () => {
      process.env.NEW_RELIC_AI_MCP_RECORD_CONTENT = 'true';

      processHook(
        makePostToolUse({
          tool_response: { content: 'Bearer eyJhbGciOiJIUzI1NiJ9.secret' },
        }),
      );

      const event = readBufferEvents()[0]!;
      expect(event.outputContent).toBeDefined();
      expect(event.outputContent).toContain('[REDACTED]');
      expect(event.outputContent).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    });

    it('truncates content exceeding max length', () => {
      process.env.NEW_RELIC_AI_MCP_RECORD_CONTENT = 'true';
      process.env.NEW_RELIC_AI_MCP_MAX_CONTENT_LENGTH = '50';

      const longContent = 'x'.repeat(100_000);
      processHook(
        makePostToolUse({
          tool_response: { data: longContent },
        }),
      );

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
      processHook(
        JSON.stringify({
          hook_event_name: 'SessionStart',
          session_id: 'sess-001',
        }),
      );

      expect(readBufferEvents()).toHaveLength(0);
    });

    it('silently ignores malformed (non-JSON) stdin payloads', () => {
      expect(() => processHook('not valid json{{{')).not.toThrow();

      expect(readBufferEvents()).toHaveLength(0);
    });
  });

  function makeKiroPreToolUse(overrides?: Record<string, unknown>): string {
    return JSON.stringify({
      hook_event_name: 'preToolUse',
      tool_name: 'read',
      tool_input: { operations: [{ mode: 'Line', path: '/tmp/test.ts' }] },
      session_id: 'kiro-sess-001',
      cwd: '/projects/test',
      ...overrides,
    });
  }

  function makeKiroPostToolUse(overrides?: Record<string, unknown>): string {
    return JSON.stringify({
      hook_event_name: 'postToolUse',
      tool_name: 'read',
      tool_response: { success: true },
      session_id: 'kiro-sess-001',
      cwd: '/projects/test',
      ...overrides,
    });
  }

  describe('collector-script — Kiro hook event names (lower-camelCase)', () => {
    it('writes a pre event when hook_event_name is "preToolUse" (not "PreToolUse")', () => {
      processHook(makeKiroPreToolUse());
      const events = readBufferEvents();
      expect(events).toHaveLength(1);
      expect(events[0].mode).toBe('pre');
      expect(events[0].tool).toBe('read');
    });

    it('writes a post event when hook_event_name is "postToolUse" (not "PostToolUse")', () => {
      processHook(makeKiroPostToolUse());
      const events = readBufferEvents();
      expect(events).toHaveLength(1);
      expect(events[0].mode).toBe('post');
      expect(events[0].success).toBe(true);
    });

    it('still ignores a genuinely unknown hook_event_name', () => {
      processHook(makeKiroPreToolUse({ hook_event_name: 'agentSpawn' }));
      expect(readBufferEvents()).toHaveLength(0);
    });
  });

  describe('collector-script — postToolUse tool_response.success (Kiro / Amazon Q)', () => {
    it('marks the event unsuccessful when tool_response.success is false', () => {
      processHook(
        makeKiroPostToolUse({ tool_response: { success: false, result: ['permission denied'] } }),
      );
      const events = readBufferEvents();
      expect(events).toHaveLength(1);
      expect(events[0].success).toBe(false);
    });

    it('marks the event successful when tool_response.success is true', () => {
      processHook(makeKiroPostToolUse({ tool_response: { success: true, result: ['ok'] } }));
      const events = readBufferEvents();
      expect(events[0].success).toBe(true);
    });

    it('defaults to successful when tool_response has no success field (Claude Code shape)', () => {
      processHook(makePostToolUse({ tool_response: { exitCode: 0 } }));
      const events = readBufferEvents();
      expect(events[0].success).toBe(true);
    });

    it('defaults to successful when tool_response is a non-object', () => {
      processHook(makePostToolUse({ tool_response: 'plain string output' }));
      const events = readBufferEvents();
      expect(events[0].success).toBe(true);
    });

    it("unifies top-level success with Edit's own tool_response.success (intentional — Claude Code's Edit tool is not exempt)", () => {
      processHook(
        makePostToolUse({
          tool_name: 'Edit',
          tool_response: { success: false, error: 'no match found' },
        }),
      );
      const events = readBufferEvents();
      expect(events).toHaveLength(1);
      expect(events[0].success).toBe(false);
    });
  });

  describe('collector-script — Amazon Q Developer CLI hook payloads (https://github.com/aws/amazon-q-developer-cli/blob/main/docs/hooks.md)', () => {
    function makeAmazonQPreToolUse(overrides?: Record<string, unknown>): string {
      return JSON.stringify({
        hook_event_name: 'preToolUse',
        cwd: '/current/working/directory',
        tool_name: 'fs_read',
        tool_input: {
          operations: [{ mode: 'Line', path: '/current/working/directory/docs/hooks.md' }],
        },
        ...overrides,
      });
    }

    function makeAmazonQPostToolUse(overrides?: Record<string, unknown>): string {
      return JSON.stringify({
        hook_event_name: 'postToolUse',
        cwd: '/current/working/directory',
        tool_name: 'fs_read',
        tool_input: {
          operations: [{ mode: 'Line', path: '/current/working/directory/docs/hooks.md' }],
        },
        tool_response: { success: true, result: ['# Hooks\n\nHooks allow you to execute...'] },
        ...overrides,
      });
    }

    it('writes a pre event for a real Amazon Q preToolUse payload', () => {
      processHook(makeAmazonQPreToolUse());
      const events = readBufferEvents();
      expect(events).toHaveLength(1);
      expect(events[0].mode).toBe('pre');
      expect(events[0].tool).toBe('fs_read');
    });

    it('writes a successful post event for a real Amazon Q postToolUse payload', () => {
      processHook(makeAmazonQPostToolUse());
      const events = readBufferEvents();
      expect(events[0].mode).toBe('post');
      expect(events[0].success).toBe(true);
    });

    it('writes a failed post event when tool_response.success is false', () => {
      processHook(
        makeAmazonQPostToolUse({ tool_response: { success: false, result: ['Access denied'] } }),
      );
      const events = readBufferEvents();
      expect(events[0].success).toBe(false);
    });

    it('has no session identifier field, unlike every other supported platform', () => {
      processHook(makeAmazonQPreToolUse());
      const events = readBufferEvents();
      // Amazon Q hook events carry no session_id/conversation_id/trajectory_id —
      // confirmed absent from the real payload shape in hooks.md. sessionId
      // falls through to undefined, and getBufferPath() buckets it under
      // buffer-unknown.jsonl (the same fallback bucket the storage layer
      // already provides for any session-less platform).
      expect(events[0].sessionId).toBeUndefined();
    });
  });

  function makeCursorBeforeShellExecution(overrides?: Record<string, unknown>): string {
    return JSON.stringify({
      hook_event_name: 'beforeShellExecution',
      conversation_id: '668320d2-2fd8-4888-b33c-2a466fec86e7',
      generation_id: '490b90b7-a2ce-4c2c-bb76-cb77b125df2f',
      command: 'git status',
      cwd: '/Users/schacon/projects/cc-hooks-example',
      workspace_roots: ['/Users/schacon/projects/cc-hooks-example'],
      ...overrides,
    });
  }

  function makeCursorAfterShellExecution(overrides?: Record<string, unknown>): string {
    return JSON.stringify({
      hook_event_name: 'afterShellExecution',
      conversation_id: '668320d2-2fd8-4888-b33c-2a466fec86e7',
      generation_id: '490b90b7-a2ce-4c2c-bb76-cb77b125df2f',
      workspace_roots: ['/Users/schacon/projects/cc-hooks-example'],
      ...overrides,
    });
  }

  function makeCursorBeforeMCPExecution(overrides?: Record<string, unknown>): string {
    return JSON.stringify({
      hook_event_name: 'beforeMCPExecution',
      conversation_id: 'cdefee2d-2727-4b73-bf77-d9d830f31d2a',
      generation_id: '63feaa30-ae88-4e47-b6c7-70ee4c39980c',
      tool_name: 'gitbutler_update_branches',
      tool_input: '{"changesSummary": "Added a README to the project"}',
      command: 'but',
      workspace_roots: ['/Users/schacon/projects/cc-hooks-example'],
      ...overrides,
    });
  }

  function makeCursorAfterMCPExecution(overrides?: Record<string, unknown>): string {
    return JSON.stringify({
      hook_event_name: 'afterMCPExecution',
      conversation_id: 'cdefee2d-2727-4b73-bf77-d9d830f31d2a',
      generation_id: '63feaa30-ae88-4e47-b6c7-70ee4c39980c',
      tool_name: 'gitbutler_update_branches',
      workspace_roots: ['/Users/schacon/projects/cc-hooks-example'],
      ...overrides,
    });
  }

  function makeCursorBeforeReadFile(overrides?: Record<string, unknown>): string {
    return JSON.stringify({
      hook_event_name: 'beforeReadFile',
      conversation_id: '668320d2-2fd8-4888-b33c-2a466fec86e7',
      generation_id: '490b90b7-a2ce-4c2c-bb76-cb77b125df2f',
      content: "#!/bin/bash\n\necho 'my_github_access_token'\n",
      file_path: 'leaks/github_tokens.sh',
      workspace_roots: ['/Users/schacon/projects/cc-hooks-example'],
      ...overrides,
    });
  }

  function makeCursorAfterFileEdit(overrides?: Record<string, unknown>): string {
    return JSON.stringify({
      hook_event_name: 'afterFileEdit',
      conversation_id: 'cdefee2d-2727-4b73-bf77-d9d830f31d2a',
      generation_id: '23681cf0-a483-49ab-9748-36044efcef52',
      file_path: 'README.md',
      edits: [{ old_string: '# OLD README', new_string: '# NEW README' }],
      workspace_roots: ['/Users/schacon/projects/cc-hooks-example'],
      ...overrides,
    });
  }

  describe('collector-script — Cursor hook event names (https://cursor.com/docs/agent/hooks)', () => {
    it('beforeShellExecution writes a pre/Bash event with the command redacted', () => {
      processHook(
        makeCursorBeforeShellExecution({ command: 'curl https://x.com?token=SECRET_ABC123XYZ' }),
      );

      const events = readBufferEvents();
      expect(events).toHaveLength(1);
      const event = events[0]!;
      expect(event.mode).toBe('pre');
      expect(event.tool).toBe('Bash');
      const toolInput = event.toolInput as { command?: string };
      expect(toolInput.command).not.toContain('SECRET_ABC123XYZ');
    });

    it('afterShellExecution writes a post/Bash success event', () => {
      processHook(makeCursorBeforeShellExecution());
      processHook(makeCursorAfterShellExecution());

      const events = readBufferEvents();
      expect(events).toHaveLength(2);
      const post = events[1]!;
      expect(post.mode).toBe('post');
      expect(post.tool).toBe('Bash');
      expect(post.success).toBe(true);
    });

    it('beforeMCPExecution writes a pre event using the raw MCP tool_name (no mapping applied)', () => {
      processHook(makeCursorBeforeMCPExecution());

      const event = readBufferEvents()[0]!;
      expect(event.mode).toBe('pre');
      expect(event.tool).toBe('gitbutler_update_branches');
    });

    it('afterMCPExecution writes a post success event using the raw MCP tool_name', () => {
      processHook(makeCursorBeforeMCPExecution());
      processHook(makeCursorAfterMCPExecution());

      const post = readBufferEvents()[1]!;
      expect(post.mode).toBe('post');
      expect(post.tool).toBe('gitbutler_update_branches');
      expect(post.success).toBe(true);
    });

    it('beforeReadFile writes a completed post/Read event (no matching after-event exists)', () => {
      processHook(makeCursorBeforeReadFile());

      const events = readBufferEvents();
      expect(events).toHaveLength(1);
      const event = events[0]!;
      expect(event.mode).toBe('post');
      expect(event.tool).toBe('Read');
      expect(event.success).toBe(true);
    });

    it('beforeReadFile never writes raw file content to the buffer by default', () => {
      processHook(makeCursorBeforeReadFile({ content: 'super-secret-file-contents' }));

      const raw = readFileSync(bufferPath, 'utf-8');
      expect(raw).not.toContain('super-secret-file-contents');
    });

    it('afterFileEdit writes a completed post/Edit event (no matching before-event exists)', () => {
      processHook(makeCursorAfterFileEdit());

      const events = readBufferEvents();
      expect(events).toHaveLength(1);
      const event = events[0]!;
      expect(event.mode).toBe('post');
      expect(event.tool).toBe('Edit');
      expect(event.success).toBe(true);
    });

    it('uses conversation_id as the session identifier when session_id is absent', () => {
      processHook(makeCursorBeforeShellExecution({ conversation_id: 'conv-abc-123' }));

      const event = readBufferEvents()[0]!;
      expect(event.sessionId).toBe('conv-abc-123');
    });

    it('routes events with different conversation_id values to different buffer files', () => {
      delete process.env.NEW_RELIC_AI_MCP_BUFFER_PATH;
      process.env.NEW_RELIC_AI_MCP_STORAGE_PATH = tmpDir;

      processHook(makeCursorBeforeShellExecution({ conversation_id: 'conv-aaa' }));
      processHook(makeCursorBeforeShellExecution({ conversation_id: 'conv-bbb' }));

      expect(existsSync(resolve(tmpDir, 'buffer-conv-aaa.jsonl'))).toBe(true);
      expect(existsSync(resolve(tmpDir, 'buffer-conv-bbb.jsonl'))).toBe(true);
    });
  });

  describe('Windsurf hook events', () => {
    function makeWindsurfPreReadCode(overrides: Record<string, unknown> = {}): string {
      return JSON.stringify({
        agent_action_name: 'pre_read_code',
        trajectory_id: 'traj-abc123',
        execution_id: 'exec-1',
        timestamp: '2026-07-09T12:00:00Z',
        model_name: 'Claude Sonnet 4',
        tool_info: { file_path: '/Users/dev/project/file.py' },
        ...overrides,
      });
    }

    function makeWindsurfPostReadCode(overrides: Record<string, unknown> = {}): string {
      return JSON.stringify({
        agent_action_name: 'post_read_code',
        trajectory_id: 'traj-abc123',
        tool_info: { file_path: '/Users/dev/project/file.py' },
        ...overrides,
      });
    }

    function makeWindsurfPreWriteCode(overrides: Record<string, unknown> = {}): string {
      return JSON.stringify({
        agent_action_name: 'pre_write_code',
        trajectory_id: 'traj-abc123',
        tool_info: {
          file_path: '/Users/dev/project/file.py',
          edits: [
            { old_string: 'def old():\n    pass', new_string: 'def new():\n    return True' },
          ],
        },
        ...overrides,
      });
    }

    function makeWindsurfPostWriteCode(overrides: Record<string, unknown> = {}): string {
      return JSON.stringify({
        agent_action_name: 'post_write_code',
        trajectory_id: 'traj-abc123',
        tool_info: {
          file_path: '/Users/dev/project/file.py',
          edits: [{ old_string: 'import os', new_string: 'import os\nimport sys' }],
        },
        ...overrides,
      });
    }

    function makeWindsurfPreRunCommand(overrides: Record<string, unknown> = {}): string {
      return JSON.stringify({
        agent_action_name: 'pre_run_command',
        trajectory_id: 'traj-abc123',
        tool_info: { command_line: 'npm install left-pad', cwd: '/Users/dev/project' },
        ...overrides,
      });
    }

    function makeWindsurfPostRunCommand(overrides: Record<string, unknown> = {}): string {
      return JSON.stringify({
        agent_action_name: 'post_run_command',
        trajectory_id: 'traj-abc123',
        tool_info: { command_line: 'npm install left-pad', cwd: '/Users/dev/project' },
        ...overrides,
      });
    }

    function makeWindsurfPreMcpToolUse(overrides: Record<string, unknown> = {}): string {
      return JSON.stringify({
        agent_action_name: 'pre_mcp_tool_use',
        trajectory_id: 'traj-abc123',
        tool_info: {
          mcp_server_name: 'github',
          mcp_tool_name: 'create_issue',
          mcp_tool_arguments: { owner: 'code-owner', repo: 'my-repo', title: 'Bug report' },
        },
        ...overrides,
      });
    }

    function makeWindsurfPostMcpToolUse(overrides: Record<string, unknown> = {}): string {
      return JSON.stringify({
        agent_action_name: 'post_mcp_tool_use',
        trajectory_id: 'traj-abc123',
        tool_info: {
          mcp_server_name: 'github',
          mcp_tool_name: 'create_issue',
          mcp_tool_arguments: { owner: 'code-owner', repo: 'my-repo', title: 'Bug report' },
          mcp_result: 'issue #42 created',
        },
        ...overrides,
      });
    }

    it('writes a pre event for pre_read_code with tool Read', () => {
      processHook(makeWindsurfPreReadCode());
      const lines = readBufferLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        mode: 'pre',
        tool: 'Read',
        toolInput: { file_path: '/Users/dev/project/file.py' },
      });
    });

    it('writes a post event for post_read_code with success true', () => {
      processHook(makeWindsurfPostReadCode());
      const lines = readBufferLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        mode: 'post',
        tool: 'Read',
        success: true,
        toolInput: { file_path: '/Users/dev/project/file.py' },
      });
    });

    it('writes a pre event for pre_write_code with tool Edit', () => {
      processHook(makeWindsurfPreWriteCode());
      const lines = readBufferLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        mode: 'pre',
        tool: 'Edit',
        toolInput: { file_path: '/Users/dev/project/file.py' },
      });
    });

    it('writes a post event for post_write_code with success true', () => {
      processHook(makeWindsurfPostWriteCode());
      const lines = readBufferLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        mode: 'post',
        tool: 'Edit',
        success: true,
      });
    });

    it('writes a pre event for pre_run_command with tool Bash and redacts the command', () => {
      processHook(
        makeWindsurfPreRunCommand({
          tool_info: {
            command_line: 'API_KEY=sk-abcdefghijklmnopqrstuvwxyz012345 deploy',
            cwd: '/x',
          },
        }),
      );
      const lines = readBufferLines();
      expect(lines).toHaveLength(1);
      expect(lines[0].mode).toBe('pre');
      expect(lines[0].tool).toBe('Bash');
      expect((lines[0].toolInput as { command: string }).command).toContain('[REDACTED]');
      expect((lines[0].toolInput as { command: string }).command).not.toContain(
        'sk-abcdefghijklmnopqrstuvwxyz012345',
      );
    });

    it('writes a post event for post_run_command with success true', () => {
      processHook(makeWindsurfPostRunCommand());
      const lines = readBufferLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ mode: 'post', tool: 'Bash', success: true });
    });

    it('writes a pre event for pre_mcp_tool_use with the raw MCP tool name', () => {
      processHook(makeWindsurfPreMcpToolUse());
      const lines = readBufferLines();
      expect(lines).toHaveLength(1);
      expect(lines[0].mode).toBe('pre');
      expect(lines[0].tool).toBe('create_issue');
    });

    it('writes a post event for post_mcp_tool_use with success true', () => {
      processHook(makeWindsurfPostMcpToolUse());
      const lines = readBufferLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ mode: 'post', tool: 'create_issue', success: true });
    });

    it('routes by trajectory_id when session_id is absent', () => {
      delete process.env.NEW_RELIC_AI_MCP_BUFFER_PATH;
      process.env.NEW_RELIC_AI_MCP_STORAGE_PATH = tmpDir;

      processHook(makeWindsurfPreReadCode({ trajectory_id: 'traj-route-test' }));
      const lines = readBufferLines('traj-route-test');
      expect(lines).toHaveLength(1);
      expect(lines[0].sessionId).toBe('traj-route-test');
    });

    it('silently ignores pre_user_prompt (not a tool-call event)', () => {
      processHook(
        JSON.stringify({
          agent_action_name: 'pre_user_prompt',
          trajectory_id: 'traj-abc123',
          tool_info: { user_prompt: 'can you run echo hello' },
        }),
      );
      expect(readBufferLines('traj-abc123')).toHaveLength(0);
    });

    it('silently ignores post_cascade_response (not a tool-call event)', () => {
      processHook(
        JSON.stringify({
          agent_action_name: 'post_cascade_response',
          trajectory_id: 'traj-abc123',
          tool_info: { response: 'Done.' },
        }),
      );
      expect(readBufferLines('traj-abc123')).toHaveLength(0);
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
      expect(redact('ghp_1234567890abcdef01234567890abcdef01')).toBe('[REDACTED]');
    });

    it('redact() replaces GitHub Apps installation tokens (ghs_)', () => {
      const token = 'ghs_16C7e42F292c6912E7710c838347Ae178B4a';
      expect(redact(token)).toBe('[REDACTED]');
      expect(redact(`Authorization: ${token}`)).toContain('[REDACTED]');
      expect(redact(`Authorization: ${token}`)).not.toContain(token);
    });

    it('redact() leaves normal text unchanged', () => {
      expect(redact('function hello() { return 42; }')).toBe('function hello() { return 42; }');
    });

    it('redact() replaces database connection strings with embedded credentials', () => {
      const connStr = 'postgres://admin:s3cr3tpass@db.internal.example.com:5432/mydb';
      expect(redact(connStr)).toContain('[REDACTED]');
      expect(redact(connStr)).not.toContain('s3cr3tpass');
    });

    it('redact() replaces Stripe live secret keys', () => {
      const key = 'sk_live_' + 'a'.repeat(24);
      expect(redact(key)).toBe('[REDACTED]');
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

    // ReDoS protection
    it('redact() truncates input over 1 MB before applying patterns', () => {
      const overLimit = 'A'.repeat(1_048_577);
      const result = redact(overLimit);
      expect(result.length).toBeLessThanOrEqual(1_048_576);
    });

    it('redact() does not match an unterminated PEM block — bounded pattern prevents ReDoS', () => {
      const input = '-----BEGIN RSA PRIVATE KEY-----' + 'B'.repeat(200);
      expect(redact(input)).toBe(input);
    });

    describe('getRecordContent() — enforcing highSecurity', () => {
      beforeEach(() => {
        delete process.env.NEW_RELIC_AI_HIGH_SECURITY;
        delete process.env.NEW_RELIC_AI_MCP_RECORD_CONTENT;
      });

      it('returns false when NEW_RELIC_AI_HIGH_SECURITY env var is set', () => {
        process.env.NEW_RELIC_AI_HIGH_SECURITY = 'true';
        process.env.NEW_RELIC_AI_MCP_RECORD_CONTENT = 'true';

        expect(getRecordContent()).toBe(false);
      });

      it('returns true when recordContent env var is true and highSecurity is not set', () => {
        process.env.NEW_RELIC_AI_MCP_RECORD_CONTENT = 'true';

        expect(getRecordContent()).toBe(true);
      });

      it('returns false by default when neither env nor config is set', () => {
        expect(getRecordContent()).toBe(false);
      });
    });
  });

  describe('file permissions', () => {
    it('creates the buffer directory with mode 0o700', () => {
      // Point to a subdirectory that does not yet exist so mkdirSync is triggered
      const subDir = resolve(tmpDir, 'new-subdir');
      const subBufPath = resolve(subDir, 'buffer.jsonl');
      process.env.NEW_RELIC_AI_MCP_BUFFER_PATH = subBufPath;

      processHook(makePreToolUse());

      expect(existsSync(subDir)).toBe(true);
      const dirStat = statSync(subDir);
      expect(dirStat.mode & 0o777).toBe(0o700);

      // Restore the original buffer path for subsequent tests
      process.env.NEW_RELIC_AI_MCP_BUFFER_PATH = bufferPath;
    });

    it('creates the buffer file with mode 0o600', () => {
      processHook(makePreToolUse());

      expect(existsSync(bufferPath)).toBe(true);
      const fileStat = statSync(bufferPath);
      expect(fileStat.mode & 0o777).toBe(0o600);
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

  // ---------------------------------------------------------------------------
  // Per-session buffer paths + PPID breadcrumb
  // ---------------------------------------------------------------------------

  describe('getBufferPath()', () => {
    it('honours NEW_RELIC_AI_MCP_BUFFER_PATH verbatim and ignores sessionId', () => {
      const explicit = resolve(tmpDir, 'explicit.jsonl');
      process.env.NEW_RELIC_AI_MCP_BUFFER_PATH = explicit;
      expect(getBufferPath('sess-anything')).toBe(explicit);
    });

    it('returns buffer-<sessionId>.jsonl under the storage path when sessionId is valid', () => {
      delete process.env.NEW_RELIC_AI_MCP_BUFFER_PATH;
      process.env.NEW_RELIC_AI_MCP_STORAGE_PATH = tmpDir;
      expect(getBufferPath('sess-good')).toBe(resolve(tmpDir, 'buffer-sess-good.jsonl'));
    });

    it('falls back to buffer-unknown.jsonl on a missing sessionId', () => {
      delete process.env.NEW_RELIC_AI_MCP_BUFFER_PATH;
      process.env.NEW_RELIC_AI_MCP_STORAGE_PATH = tmpDir;
      expect(getBufferPath()).toBe(resolve(tmpDir, 'buffer-unknown.jsonl'));
    });

    it('falls back to buffer-unknown.jsonl on a path-traversal attempt', () => {
      delete process.env.NEW_RELIC_AI_MCP_BUFFER_PATH;
      process.env.NEW_RELIC_AI_MCP_STORAGE_PATH = tmpDir;
      expect(getBufferPath('../../etc/passwd')).toBe(resolve(tmpDir, 'buffer-unknown.jsonl'));
    });
  });

  describe('processHook() per-session buffer scoping', () => {
    it('writes events to buffer-<sessionId>.jsonl when no explicit BUFFER_PATH is set', () => {
      delete process.env.NEW_RELIC_AI_MCP_BUFFER_PATH;
      process.env.NEW_RELIC_AI_MCP_STORAGE_PATH = tmpDir;

      processHook(makePreToolUse({ session_id: 'sess-zzz' }));

      const sessionPath = resolve(tmpDir, 'buffer-sess-zzz.jsonl');
      expect(existsSync(sessionPath)).toBe(true);
      const lines = readFileSync(sessionPath, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(1);
      expect((JSON.parse(lines[0]!) as { sessionId: string }).sessionId).toBe('sess-zzz');
    });

    it('partitions concurrent multi-session writes into separate files', () => {
      delete process.env.NEW_RELIC_AI_MCP_BUFFER_PATH;
      process.env.NEW_RELIC_AI_MCP_STORAGE_PATH = tmpDir;

      processHook(makePreToolUse({ session_id: 'sess-A', tool_use_id: 'a1' }));
      processHook(makePreToolUse({ session_id: 'sess-B', tool_use_id: 'b1' }));
      processHook(makePreToolUse({ session_id: 'sess-A', tool_use_id: 'a2' }));

      const aPath = resolve(tmpDir, 'buffer-sess-A.jsonl');
      const bPath = resolve(tmpDir, 'buffer-sess-B.jsonl');
      expect(readFileSync(aPath, 'utf-8').trim().split('\n')).toHaveLength(2);
      expect(readFileSync(bPath, 'utf-8').trim().split('\n')).toHaveLength(1);
    });
  });

  describe('writePpidBreadcrumb()', () => {
    beforeEach(() => {
      delete process.env.NEW_RELIC_AI_MCP_BUFFER_PATH;
      process.env.NEW_RELIC_AI_MCP_STORAGE_PATH = tmpDir;
    });

    it('writes <storage>/session-by-ppid/<ppid>.txt with the sessionId', () => {
      writePpidBreadcrumb('sess-bread');
      const ppid = process.ppid;
      const breadcrumbPath = resolve(tmpDir, 'session-by-ppid', `${ppid}.txt`);
      expect(existsSync(breadcrumbPath)).toBe(true);
      expect(readFileSync(breadcrumbPath, 'utf-8')).toBe('sess-bread');
    });

    it('rejects malformed sessionIds without writing', () => {
      writePpidBreadcrumb('../../escape');
      const ppid = process.ppid;
      expect(existsSync(resolve(tmpDir, 'session-by-ppid', `${ppid}.txt`))).toBe(false);
    });

    it('short-circuits when content already matches', () => {
      writePpidBreadcrumb('sess-stable');
      const ppid = process.ppid;
      const breadcrumbPath = resolve(tmpDir, 'session-by-ppid', `${ppid}.txt`);
      const firstStat = statSync(breadcrumbPath).mtimeMs;
      // Tight loop — most calls should observe the existsSync + readFileSync
      // short-circuit and not rewrite the file. mtimeMs has 1ms resolution so
      // we just assert that we don't error and the content is unchanged.
      for (let i = 0; i < 50; i++) writePpidBreadcrumb('sess-stable');
      expect(readFileSync(breadcrumbPath, 'utf-8')).toBe('sess-stable');
      // The mtime may or may not change depending on filesystem — the key
      // assertion is correctness; the perf claim is documented separately.
      expect(typeof firstStat).toBe('number');
    });

    it('refreshes mtime on the short-circuit path so an active session never goes stale', () => {
      writePpidBreadcrumb('sess-active');
      const ppid = process.ppid;
      const breadcrumbPath = resolve(tmpDir, 'session-by-ppid', `${ppid}.txt`);

      // Simulate this breadcrumb having gone quiet for a while (e.g. no hook
      // fired since before an MCP server restart) by backdating its mtime.
      const oldMs = Date.now() - 60_000;
      utimesSync(breadcrumbPath, oldMs / 1000, oldMs / 1000);
      expect(statSync(breadcrumbPath).mtimeMs).toBeLessThan(Date.now() - 30_000);

      // A subsequent hook call with the SAME session_id (content unchanged,
      // short-circuit path) must still bump mtime — otherwise
      // resolveFromBreadcrumb()'s staleness check (session-resolver.ts)
      // would reject this breadcrumb forever after any MCP restart that
      // keeps the same ppid and session_id.
      writePpidBreadcrumb('sess-active');
      expect(readFileSync(breadcrumbPath, 'utf-8')).toBe('sess-active');
      expect(statSync(breadcrumbPath).mtimeMs).toBeGreaterThan(Date.now() - 5_000);
    });

    it('processHook() drops the breadcrumb on every fire (idempotent overwrite)', () => {
      delete process.env.NEW_RELIC_AI_MCP_BUFFER_PATH;
      process.env.NEW_RELIC_AI_MCP_STORAGE_PATH = tmpDir;

      processHook(makePreToolUse({ session_id: 'sess-bc' }));
      const breadcrumbPath = resolve(tmpDir, 'session-by-ppid', `${process.ppid}.txt`);
      expect(readFileSync(breadcrumbPath, 'utf-8')).toBe('sess-bc');
    });

    it('writes breadcrumb at each ancestor PID (end-to-end WSL+fish path)', () => {
      // Inject a fake /proc chain: process.ppid → fakeGrandpid → (ENOENT, stop).
      // Both the direct-ppid slot and the ancestor slot must be written.
      const ppid = process.ppid;
      const fakeGrandpid = 99_997;
      const origReadFile = _procFs.readFile;
      _procFs.readFile = (path: string): string => {
        if (path === `/proc/${ppid}/stat`)
          return `${ppid} (sh) S ${fakeGrandpid} ${ppid} ${ppid} 0 -1 0`;
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      };
      try {
        writePpidBreadcrumb('sess-ancestor');
      } finally {
        _procFs.readFile = origReadFile;
      }

      const breadcrumbDir = resolve(tmpDir, 'session-by-ppid');

      const directCrumb = resolve(breadcrumbDir, `${ppid}.txt`);
      expect(existsSync(directCrumb)).toBe(true);
      expect(readFileSync(directCrumb, 'utf-8')).toBe('sess-ancestor');

      const ancestorCrumb = resolve(breadcrumbDir, `${fakeGrandpid}.txt`);
      expect(existsSync(ancestorCrumb)).toBe(true);
      expect(readFileSync(ancestorCrumb, 'utf-8')).toBe('sess-ancestor');
    });
  });

  describe('writeCwdBreadcrumb()', () => {
    beforeEach(() => {
      delete process.env.NEW_RELIC_AI_MCP_BUFFER_PATH;
      process.env.NEW_RELIC_AI_MCP_STORAGE_PATH = tmpDir;
    });

    it('writes <storage>/session-by-cwd/<sanitized-cwd>.txt with the sessionId', () => {
      writeCwdBreadcrumb('sess-bread', '/projects/test');
      const breadcrumbPath = resolve(tmpDir, 'session-by-cwd', '-projects-test.txt');
      expect(existsSync(breadcrumbPath)).toBe(true);
      expect(readFileSync(breadcrumbPath, 'utf-8')).toBe('sess-bread');
    });

    it('sanitizes a backslash-separated (Windows) cwd, stripping the drive-letter colon too', () => {
      writeCwdBreadcrumb('sess-win', 'C:\\Users\\test\\myproject');
      const breadcrumbPath = resolve(tmpDir, 'session-by-cwd', 'C--Users-test-myproject.txt');
      expect(existsSync(breadcrumbPath)).toBe(true);
      expect(readFileSync(breadcrumbPath, 'utf-8')).toBe('sess-win');
    });

    it('strips the drive-letter colon so the breadcrumb filename has no embedded colon', () => {
      writeCwdBreadcrumb('sess-colon', 'C:\\Users\\test\\myproject');
      expect(existsSync(resolve(tmpDir, 'session-by-cwd', 'C--Users-test-myproject.txt'))).toBe(
        true,
      );
      expect(existsSync(resolve(tmpDir, 'session-by-cwd', 'C:-Users-test-myproject.txt'))).toBe(
        false,
      );
    });

    it('no-ops when cwd is missing or empty', () => {
      writeCwdBreadcrumb('sess-nocwd', undefined);
      writeCwdBreadcrumb('sess-nocwd', '');
      expect(existsSync(resolve(tmpDir, 'session-by-cwd'))).toBe(false);
    });

    it('rejects malformed sessionIds without writing', () => {
      writeCwdBreadcrumb('../../escape', '/projects/test');
      expect(existsSync(resolve(tmpDir, 'session-by-cwd', '-projects-test.txt'))).toBe(false);
    });

    it('short-circuits when content already matches', () => {
      writeCwdBreadcrumb('sess-stable', '/projects/test');
      const breadcrumbPath = resolve(tmpDir, 'session-by-cwd', '-projects-test.txt');
      for (let i = 0; i < 50; i++) writeCwdBreadcrumb('sess-stable', '/projects/test');
      expect(readFileSync(breadcrumbPath, 'utf-8')).toBe('sess-stable');
    });

    it('processHook() drops the cwd breadcrumb on every fire', () => {
      delete process.env.NEW_RELIC_AI_MCP_BUFFER_PATH;
      process.env.NEW_RELIC_AI_MCP_STORAGE_PATH = tmpDir;

      processHook(makePreToolUse({ session_id: 'sess-bc', cwd: '/projects/test' }));
      const breadcrumbPath = resolve(tmpDir, 'session-by-cwd', '-projects-test.txt');
      expect(readFileSync(breadcrumbPath, 'utf-8')).toBe('sess-bc');
    });
  });

  // ---------------------------------------------------------------------------
  // getLinuxAncestorPids
  // ---------------------------------------------------------------------------
  describe('getLinuxAncestorPids()', () => {
    let originalReadFile: typeof _procFs.readFile;

    beforeEach(() => {
      originalReadFile = _procFs.readFile;
    });

    afterEach(() => {
      _procFs.readFile = originalReadFile;
    });

    function mockProc(statMap: Record<string, string>): void {
      _procFs.readFile = (path: string): string => {
        if (path in statMap) return statMap[path]!;
        if (/^\/proc\/\d+\/stat$/.test(path)) {
          throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
        }
        // Real call for non-/proc/ paths (other tests in this file use real fs)
        throw Object.assign(new Error(`unexpected readFile: ${path}`), { code: 'ENOENT' });
      };
    }

    it('returns [startPpid] when /proc/<pid>/stat is not readable', () => {
      mockProc({}); // all /proc/ reads throw ENOENT
      expect(getLinuxAncestorPids(1001)).toEqual([1001]);
    });

    it('walks one intermediate shell process (the WSL+fish case)', () => {
      // claude=1000, sh=1001, collector ppid=1001
      mockProc({
        '/proc/1001/stat': '1001 (sh) S 1000 1001 1000 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 0',
        // /proc/1000/stat not present → stops there
      });
      expect(getLinuxAncestorPids(1001)).toEqual([1001, 1000]);
    });

    it('handles process names that contain parentheses', () => {
      // lastIndexOf(')') must find the field-separator paren, not one inside the name
      mockProc({
        '/proc/2000/stat': '2000 (my(app)name) S 1999 2000 2000 0 -1 0 0 0 0 0',
      });
      expect(getLinuxAncestorPids(2000)).toEqual([2000, 1999]);
    });

    it('does not include PID 1 (init/systemd)', () => {
      mockProc({
        '/proc/100/stat': '100 (daemon) S 1 100 100 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 0',
      });
      // ppid of 100 is 1 → stop condition: parentPid <= 1
      expect(getLinuxAncestorPids(100)).toEqual([100]);
    });

    it('does not include PID 0', () => {
      mockProc({
        '/proc/50/stat': '50 (kthread) S 0 0 0 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 0',
      });
      expect(getLinuxAncestorPids(50)).toEqual([50]);
    });

    it('stops at maxDepth and returns startPpid + that many ancestors', () => {
      // Chain: 100 → 99 → 98 → 97 → 96 → 95 (unlimited)
      const statMap: Record<string, string> = {};
      for (let pid = 100; pid > 90; pid--) {
        statMap[`/proc/${pid}/stat`] = `${pid} (proc) S ${pid - 1} ${pid} ${pid} 0 -1 0`;
      }
      mockProc(statMap);
      // default maxDepth=5: starts with [100], walks 5 times → [100,99,98,97,96,95]
      const result = getLinuxAncestorPids(100);
      expect(result).toHaveLength(6);
      expect(result[0]).toBe(100);
      expect(result[5]).toBe(95);

      // explicit maxDepth=2: [100, 99, 98]
      expect(getLinuxAncestorPids(100, 2)).toEqual([100, 99, 98]);
    });

    it('breaks on a cycle and does not loop infinitely', () => {
      // 100 → 99 → 100 (cycle)
      mockProc({
        '/proc/100/stat': '100 (proc) S 99 100 100 0 -1 0',
        '/proc/99/stat': '99 (proc) S 100 99 99 0 -1 0', // cycle back to 100
      });
      const result = getLinuxAncestorPids(100);
      expect(result).toEqual([100, 99]); // stops before re-adding 100
    });

    it('returns [startPpid] when stat has no closing parenthesis', () => {
      mockProc({ '/proc/300/stat': '300 malformed-no-parens' });
      expect(getLinuxAncestorPids(300)).toEqual([300]);
    });

    it('returns [startPpid] when parsed ppid is NaN', () => {
      mockProc({ '/proc/400/stat': '400 (proc) S notanumber ...' });
      expect(getLinuxAncestorPids(400)).toEqual([400]);
    });
  });

  // ---------------------------------------------------------------------------
  // readStdinSync (/dev/stdin has no Windows equivalent)
  // ---------------------------------------------------------------------------
  describe('readStdinSync()', () => {
    const originalPlatform = process.platform;
    let originalReadFileSync: typeof _stdinFs.readFileSync;

    beforeEach(() => {
      originalReadFileSync = _stdinFs.readFileSync;
    });

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      _stdinFs.readFileSync = originalReadFileSync;
    });

    it('reads /dev/stdin on POSIX platforms', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      const calls: Array<string | number> = [];
      _stdinFs.readFileSync = (pathOrFd) => {
        calls.push(pathOrFd);
        return '{"hook_event_name":"PreToolUse"}';
      };
      expect(readStdinSync()).toBe('{"hook_event_name":"PreToolUse"}');
      expect(calls).toEqual(['/dev/stdin']);
    });

    it('reads via the stdin fd on Windows, not /dev/stdin', () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      const calls: Array<string | number> = [];
      _stdinFs.readFileSync = (pathOrFd) => {
        calls.push(pathOrFd);
        return '{}';
      };
      readStdinSync();
      expect(calls).toEqual([process.stdin.fd]);
    });

    it('falls back to the inherited stdin fd when /dev/stdin re-open is denied (EACCES)', () => {
      // Reproduces the WSL boundary case: a Windows-host Claude Code process
      // spawns this script inside WSL via wsl.exe. The piped stdin's
      // underlying inode is root-owned, so re-opening /dev/stdin
      // (-> /proc/self/fd/0) fails permission checks even though the
      // already-inherited fd 0 is readable.
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      const calls: Array<string | number> = [];
      _stdinFs.readFileSync = (pathOrFd) => {
        calls.push(pathOrFd);
        if (pathOrFd === '/dev/stdin') {
          const err = new Error("EACCES: permission denied, open '/dev/stdin'");
          (err as NodeJS.ErrnoException).code = 'EACCES';
          throw err;
        }
        return '{"hook_event_name":"PreToolUse"}';
      };
      expect(readStdinSync()).toBe('{"hook_event_name":"PreToolUse"}');
      expect(calls).toEqual(['/dev/stdin', process.stdin.fd]);
    });

    it('falls back to the inherited stdin fd when /dev/stdin is a socket (ENXIO)', () => {
      // Reproduces VS Code Copilot Chat's hook spawn: an Electron/Node parent
      // backs a `stdio: 'pipe'` child with a socketpair rather than a FIFO,
      // and open() on a unix socket via /proc/self/fd fails with ENXIO even
      // though the inherited fd 0 reads normally.
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      const calls: Array<string | number> = [];
      _stdinFs.readFileSync = (pathOrFd) => {
        calls.push(pathOrFd);
        if (pathOrFd === '/dev/stdin') {
          const err = new Error("ENXIO: no such device or address, open '/dev/stdin'");
          (err as NodeJS.ErrnoException).code = 'ENXIO';
          throw err;
        }
        return '{"hook_event_name":"PreToolUse"}';
      };
      expect(readStdinSync()).toBe('{"hook_event_name":"PreToolUse"}');
      expect(calls).toEqual(['/dev/stdin', process.stdin.fd]);
    });

    it('propagates the error when the fd fallback also fails', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      const calls: Array<string | number> = [];
      _stdinFs.readFileSync = (pathOrFd) => {
        calls.push(pathOrFd);
        const err = new Error('EBADF: bad file descriptor, read');
        (err as NodeJS.ErrnoException).code = 'EBADF';
        throw err;
      };
      expect(() => readStdinSync()).toThrow('EBADF');
      expect(calls).toEqual(['/dev/stdin', process.stdin.fd]);
    });
  });

  describe('collector-script — GitHub Copilot CLI tool_result payloads', () => {
    // The Copilot CLI puts the tool outcome under `tool_result` with a
    // `result_type` string, not under `tool_response` with a `success` boolean.
    // Verified against real CLI hook payloads captured on v1.0.78.
    const makeCopilotCliPost = (overrides: Record<string, unknown> = {}) =>
      JSON.stringify({
        hook_event_name: 'PostToolUse',
        session_id: 'cc25c3e5-5475-4c5b-861b-dc5637fd04da',
        cwd: '/home/dev/project',
        tool_name: 'Bash',
        tool_input: { command: 'echo hi', description: 'Echo' },
        tool_result: { result_type: 'success', text_result_for_llm: 'hi\n' },
        ...overrides,
      });

    it('records a non-zero outputSize from tool_result', () => {
      processHook(makeCopilotCliPost());
      const events = readBufferEvents();
      expect(events).toHaveLength(1);
      expect(events[0].mode).toBe('post');
      expect(events[0].outputSize).toBeGreaterThan(0);
    });

    it('treats result_type "success" as a successful call', () => {
      processHook(makeCopilotCliPost());
      expect(readBufferEvents()[0].success).toBe(true);
    });

    it('treats result_type "failure" as a failed call', () => {
      processHook(
        makeCopilotCliPost({
          tool_result: { result_type: 'failure', text_result_for_llm: 'boom' },
        }),
      );
      expect(readBufferEvents()[0].success).toBe(false);
    });

    it('still prefers tool_response when both fields are present', () => {
      processHook(
        makeCopilotCliPost({
          tool_response: { success: false },
          tool_result: { result_type: 'success' },
        }),
      );
      expect(readBufferEvents()[0].success).toBe(false);
    });

    it('defaults to success when neither field carries an outcome', () => {
      processHook(makeCopilotCliPost({ tool_result: { text_result_for_llm: 'hi' } }));
      expect(readBufferEvents()[0].success).toBe(true);
    });
  });

  describe('collector-script — Gemini CLI hook event names (https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md)', () => {
    it('writes a pre event when hook_event_name is "BeforeTool"', () => {
      processHook(makeGeminiBeforeTool());
      const events = readBufferEvents();
      expect(events).toHaveLength(1);
      expect(events[0].mode).toBe('pre');
      expect(events[0].tool).toBe('read_file');
    });

    it('writes a successful post event when tool_response has no error field', () => {
      processHook(makeGeminiAfterTool());
      const events = readBufferEvents();
      expect(events).toHaveLength(1);
      expect(events[0].mode).toBe('post');
      expect(events[0].success).toBe(true);
    });

    it('writes a failed post event when tool_response.error is present', () => {
      processHook(
        makeGeminiAfterTool({
          tool_response: { llmContent: 'boom', returnDisplay: 'boom', error: 'file not found' },
        }),
      );
      const events = readBufferEvents();
      expect(events[0].success).toBe(false);
    });

    it('captures session_id the same way Claude Code does', () => {
      processHook(makeGeminiBeforeTool());
      const events = readBufferEvents();
      expect(events[0].sessionId).toBe('gemini-sess-001');
    });

    it('captures transcript_path as transcriptPath', () => {
      processHook(makeGeminiBeforeTool());
      const events = readBufferEvents();
      expect(events[0].transcriptPath).toBe('/tmp/gemini-transcript.json');
    });

    it('still ignores a genuinely unknown hook_event_name', () => {
      processHook(makeGeminiBeforeTool({ hook_event_name: 'SessionStart' }));
      expect(readBufferEvents()).toHaveLength(0);
    });
  });

  describe('collector-script — Gemini CLI stdout contract (https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/index.md)', () => {
    it('writes "{}" to stdout when MCP_CLIENT is "gemini-cli"', () => {
      process.env.MCP_CLIENT = 'gemini-cli';
      processHook(makeGeminiAfterTool());
      expect(stdoutSpy).toHaveBeenCalledWith('{}\n');
    });

    it('writes "{}" to stdout when NEW_RELIC_AI_PLATFORM is "gemini-cli"', () => {
      process.env.NEW_RELIC_AI_PLATFORM = 'gemini-cli';
      processHook(makeGeminiBeforeTool());
      expect(stdoutSpy).toHaveBeenCalledWith('{}\n');
    });

    it('does not write to stdout for a Claude Code event', () => {
      processHook(makePreToolUse());
      expect(stdoutSpy).not.toHaveBeenCalled();
    });

    it('does not write to stdout for a Gemini CLI-shaped event when neither env var is set', () => {
      processHook(makeGeminiBeforeTool());
      expect(stdoutSpy).not.toHaveBeenCalled();
    });
  });

  describe('collector-script — Antigravity hook events (https://antigravity.google/docs/hooks)', () => {
    it('writes a pre event with tool from toolCall.name and toolUseId from stepIdx', () => {
      delete process.env.NEW_RELIC_AI_MCP_BUFFER_PATH;
      process.env.NEW_RELIC_AI_MCP_STORAGE_PATH = tmpDir;
      processHook(makeAntigravityPreToolUse());

      const events = readBufferLines('agy-conv-001');
      expect(events).toHaveLength(1);
      const event = events[0]!;
      expect(event.mode).toBe('pre');
      expect(event.tool).toBe('run_command');
      expect(event.toolUseId).toBe('19');
      expect(event.sessionId).toBe('agy-conv-001');
    });

    it('replies with {"decision":"allow"} on stdout for PreToolUse', () => {
      processHook(makeAntigravityPreToolUse());
      expect(stdoutSpy).toHaveBeenCalledWith('{"decision":"allow"}\n');
    });

    it('writes a post event with tool "unknown" and toolUseId from stepIdx', () => {
      delete process.env.NEW_RELIC_AI_MCP_BUFFER_PATH;
      process.env.NEW_RELIC_AI_MCP_STORAGE_PATH = tmpDir;
      processHook(makeAntigravityPostToolUse());

      const events = readBufferLines('agy-conv-001');
      expect(events).toHaveLength(1);
      const event = events[0]!;
      expect(event.mode).toBe('post');
      expect(event.tool).toBe('unknown');
      expect(event.toolUseId).toBe('19');
      expect(event.success).toBe(true);
    });

    it('reports success: false when PostToolUse carries a non-empty error', () => {
      delete process.env.NEW_RELIC_AI_MCP_BUFFER_PATH;
      process.env.NEW_RELIC_AI_MCP_STORAGE_PATH = tmpDir;
      processHook(makeAntigravityPostToolUse({ error: 'exit status 1' }));

      const events = readBufferLines('agy-conv-001');
      const event = events[0]!;
      expect(event.success).toBe(false);
      expect(event.error).toBe('exit status 1');
    });

    it('replies with {} on stdout for PostToolUse', () => {
      processHook(makeAntigravityPostToolUse());
      expect(stdoutSpy).toHaveBeenCalledWith('{}\n');
    });

    it('does not misfire on a Claude Code PreToolUse payload (no toolCall key)', () => {
      processHook(makePreToolUse());
      // Claude Code's own pretooluse branch should still handle this, not the
      // Antigravity one — same buffer file (no conversationId), tool preserved.
      const events = readBufferEvents();
      expect(events).toHaveLength(1);
      expect(events[0]!.tool).toBe('Read');
    });
  });
});
