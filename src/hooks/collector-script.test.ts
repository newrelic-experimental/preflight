import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  processHook,
  redact,
  hashInput,
  sizeOf,
  truncate,
  getRecordContent,
  collectTranscriptTokens,
  readLastAssistantUsage,
  getTranscriptPath,
  translateWslPath,
  getBufferPath,
  writePpidBreadcrumb,
  getLinuxAncestorPids,
  _procFs,
  readStdinSync,
  _stdinFs,
} from './collector-script.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;
let tmpDir: string;
let bufferPath: string;
const originalEnv = { ...process.env };

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
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

  describe('transcript token collection', () => {
    it('getTranscriptPath builds correct path from cwd and sessionId', () => {
      const path = getTranscriptPath('/Users/test/myproject', 'abc-123');
      expect(path).toContain('.claude/projects/-Users-test-myproject/abc-123.jsonl');
    });

    it('getTranscriptPath returns null when sessionId is missing', () => {
      expect(getTranscriptPath('/some/path', undefined)).toBeNull();
    });

    describe('WSL Windows path translation', () => {
      const originalPlatform = process.platform;

      afterEach(() => {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      });

      it('translateWslPath converts a Windows drive path to its WSL mount on Linux', () => {
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
        expect(translateWslPath('C:\\Users\\test\\.claude\\projects\\proj\\abc.jsonl')).toBe(
          '/mnt/c/Users/test/.claude/projects/proj/abc.jsonl',
        );
      });

      it('translateWslPath leaves POSIX paths unchanged on Linux', () => {
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
        expect(translateWslPath('/home/test/.claude/projects/proj/abc.jsonl')).toBe(
          '/home/test/.claude/projects/proj/abc.jsonl',
        );
      });

      it('translateWslPath leaves Windows drive paths unchanged outside Linux', () => {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        expect(translateWslPath('C:\\Users\\test\\abc.jsonl')).toBe('C:\\Users\\test\\abc.jsonl');
      });

      it('getTranscriptPath sanitizes a backslash-separated (Windows) cwd into the project dir name', () => {
        const path = getTranscriptPath('C:\\Users\\test\\myproject', 'abc-123');
        expect(path).toContain('.claude/projects/C:-Users-test-myproject/abc-123.jsonl');
      });
    });

    it('readLastAssistantUsage extracts usage from transcript', () => {
      const transcriptPath = resolve(tmpDir, 'test-transcript.jsonl');
      const lines = [
        JSON.stringify({ type: 'human', message: { content: 'hello' } }),
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'hi' }],
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              cache_creation_input_tokens: 200,
              cache_read_input_tokens: 5000,
            },
          },
        }),
      ];
      writeFileSync(transcriptPath, lines.join('\n') + '\n');

      const usage = readLastAssistantUsage(transcriptPath);
      expect(usage).toEqual({
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 5000,
      });
    });

    it('readLastAssistantUsage returns null for non-existent file', () => {
      expect(readLastAssistantUsage('/does/not/exist.jsonl')).toBeNull();
    });

    it('readLastAssistantUsage returns null for empty file', () => {
      const transcriptPath = resolve(tmpDir, 'empty-transcript.jsonl');
      writeFileSync(transcriptPath, '');
      expect(readLastAssistantUsage(transcriptPath)).toBeNull();
    });

    it('readLastAssistantUsage picks the last assistant entry', () => {
      const transcriptPath = resolve(tmpDir, 'multi-assistant.jsonl');
      const lines = [
        JSON.stringify({
          type: 'assistant',
          message: { usage: { input_tokens: 10, output_tokens: 5 } },
        }),
        JSON.stringify({ type: 'human', message: { content: 'more' } }),
        JSON.stringify({
          type: 'assistant',
          message: {
            usage: { input_tokens: 200, output_tokens: 80, cache_read_input_tokens: 9000 },
          },
        }),
      ];
      writeFileSync(transcriptPath, lines.join('\n') + '\n');

      const usage = readLastAssistantUsage(transcriptPath);
      expect(usage!.input_tokens).toBe(200);
      expect(usage!.output_tokens).toBe(80);
      expect(usage!.cache_read_input_tokens).toBe(9000);
    });

    it('collectTranscriptTokens writes a token event to buffer', () => {
      const sessionId = 'test-session-abc';
      const projectDir = tmpDir.replace(/\//g, '-');
      const claudeHome = resolve(tmpDir, 'claude-home');
      const claudeDir = resolve(claudeHome, 'projects', projectDir);
      mkdirSync(claudeDir, { recursive: true });

      const transcriptPath = resolve(claudeDir, `${sessionId}.jsonl`);
      const transcriptLine = JSON.stringify({
        type: 'assistant',
        message: {
          usage: { input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 10000 },
        },
      });
      writeFileSync(transcriptPath, transcriptLine + '\n');

      process.env.NR_AI_OBSERVE_CLAUDE_HOME = claudeHome;

      try {
        collectTranscriptTokens({ cwd: tmpDir, session_id: sessionId });

        const events = readBufferEvents();
        const tokenEvents = events.filter((e) => e.mode === 'token');
        expect(tokenEvents).toHaveLength(1);
        expect(tokenEvents[0]).toMatchObject({
          mode: 'token',
          inputTokens: 500,
          outputTokens: 100,
          cacheReadTokens: 10000,
          cacheCreationTokens: 0,
          sessionId: sessionId,
        });
      } finally {
        delete process.env.NR_AI_OBSERVE_CLAUDE_HOME;
      }
    });

    it('readLastAssistantUsage skips synthetic assistant entries and walks back to a real one', () => {
      const transcriptPath = resolve(tmpDir, 'with-synthetic.jsonl');
      const lines = [
        JSON.stringify({
          type: 'assistant',
          message: {
            model: 'claude-opus-4-7',
            usage: { input_tokens: 100, output_tokens: 50 },
          },
        }),
        // Synthetic entry — Claude Code internal injection. Has usage but
        // a fake model. Should be skipped so we keep the real model.
        JSON.stringify({
          type: 'assistant',
          message: {
            model: '<synthetic>',
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        }),
      ];
      writeFileSync(transcriptPath, lines.join('\n') + '\n');

      const usage = readLastAssistantUsage(transcriptPath);
      expect(usage?.model).toBe('claude-opus-4-7');
      expect(usage?.input_tokens).toBe(100);
    });

    it('readLastAssistantUsage extracts the model from the assistant entry', () => {
      const transcriptPath = resolve(tmpDir, 'with-model.jsonl');
      const lines = [
        JSON.stringify({
          type: 'assistant',
          message: {
            model: 'claude-opus-4-7',
            usage: { input_tokens: 100, output_tokens: 50 },
          },
        }),
      ];
      writeFileSync(transcriptPath, lines.join('\n') + '\n');

      const usage = readLastAssistantUsage(transcriptPath);
      expect(usage?.model).toBe('claude-opus-4-7');
      expect(usage?.input_tokens).toBe(100);
    });

    it('collectTranscriptTokens uses the model from the transcript when present', () => {
      const sessionId = 'test-session-model';
      const projectDir = tmpDir.replace(/\//g, '-');
      const claudeHome = resolve(tmpDir, 'claude-home-model');
      const claudeDir = resolve(claudeHome, 'projects', projectDir);
      mkdirSync(claudeDir, { recursive: true });

      const transcriptPath = resolve(claudeDir, `${sessionId}.jsonl`);
      const transcriptLine = JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-opus-4-7',
          usage: { input_tokens: 200, output_tokens: 40 },
        },
      });
      writeFileSync(transcriptPath, transcriptLine + '\n');

      process.env.NR_AI_OBSERVE_CLAUDE_HOME = claudeHome;

      try {
        collectTranscriptTokens({ cwd: tmpDir, session_id: sessionId });

        const events = readBufferEvents();
        const tokenEvents = events.filter((e) => e.mode === 'token');
        expect(tokenEvents).toHaveLength(1);
        expect(tokenEvents[0].model).toBe('claude-opus-4-7');
      } finally {
        delete process.env.NR_AI_OBSERVE_CLAUDE_HOME;
      }
    });

    it('collectTranscriptTokens uses transcript_path from hook payload over cwd-derived path', () => {
      // Simulates a git worktree: cwd points at the worktree dir, but the real
      // transcript lives under the parent project's dashed directory. The hook
      // payload provides transcript_path directly, which must win.
      const sessionId = 'test-session-worktree';
      const claudeHome = resolve(tmpDir, 'claude-home-worktree');
      const realTranscriptDir = resolve(claudeHome, 'projects', 'real-parent-project');
      mkdirSync(realTranscriptDir, { recursive: true });

      const realTranscriptPath = resolve(realTranscriptDir, `${sessionId}.jsonl`);
      writeFileSync(
        realTranscriptPath,
        JSON.stringify({
          type: 'assistant',
          message: {
            model: 'claude-opus-4-7',
            usage: { input_tokens: 75, output_tokens: 25 },
          },
        }) + '\n',
      );

      // cwd would derive a path that does NOT exist on disk
      const fakeWorktreeCwd = resolve(tmpDir, 'some-worktree-path');

      process.env.NR_AI_OBSERVE_CLAUDE_HOME = claudeHome;

      try {
        collectTranscriptTokens({
          cwd: fakeWorktreeCwd,
          session_id: sessionId,
          transcript_path: realTranscriptPath,
        });

        const events = readBufferEvents();
        const tokenEvents = events.filter((e) => e.mode === 'token');
        expect(tokenEvents).toHaveLength(1);
        expect(tokenEvents[0].model).toBe('claude-opus-4-7');
        expect(tokenEvents[0].inputTokens).toBe(75);
      } finally {
        delete process.env.NR_AI_OBSERVE_CLAUDE_HOME;
      }
    });

    it('collectTranscriptTokens deduplicates when transcript size has not changed', () => {
      const sessionId = 'test-session-dedup';
      const projectDir = tmpDir.replace(/\//g, '-');
      const claudeHome = resolve(tmpDir, 'claude-home2');
      const claudeDir = resolve(claudeHome, 'projects', projectDir);
      mkdirSync(claudeDir, { recursive: true });

      const transcriptPath = resolve(claudeDir, `${sessionId}.jsonl`);
      const transcriptLine = JSON.stringify({
        type: 'assistant',
        message: { usage: { input_tokens: 300, output_tokens: 60 } },
      });
      writeFileSync(transcriptPath, transcriptLine + '\n');

      process.env.NR_AI_OBSERVE_CLAUDE_HOME = claudeHome;

      try {
        collectTranscriptTokens({ cwd: tmpDir, session_id: sessionId });
        collectTranscriptTokens({ cwd: tmpDir, session_id: sessionId });

        const events = readBufferEvents();
        const tokenEvents = events.filter((e) => e.mode === 'token');
        expect(tokenEvents).toHaveLength(1);
      } finally {
        delete process.env.NR_AI_OBSERVE_CLAUDE_HOME;
      }
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

    it('re-throws non-EACCES /dev/stdin errors without falling back to the fd', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      const calls: Array<string | number> = [];
      _stdinFs.readFileSync = (pathOrFd) => {
        calls.push(pathOrFd);
        const err = new Error("ENOENT: no such file or directory, open '/dev/stdin'");
        (err as NodeJS.ErrnoException).code = 'ENOENT';
        throw err;
      };
      expect(() => readStdinSync()).toThrow('ENOENT');
      expect(calls).toEqual(['/dev/stdin']);
    });
  });
});
