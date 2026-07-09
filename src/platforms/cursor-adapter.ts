import type {
  PlatformAdapter,
  PlatformConfig,
  PlatformSessionMetadata,
  NormalizedToolCall,
} from './types.js';

/**
 * Maps Cursor tool names to the normalized Claude Code tool vocabulary.
 * Two distinct vocabularies coexist here, both confirmed against real Cursor
 * documentation and a Cursor engineer's own forum replies
 * (https://forum.cursor.com/t/cursor-cli-doesnt-send-all-events-defined-in-hooks/148316):
 *
 * 1. Cursor's per-action hook events (beforeShellExecution, beforeMCPExecution,
 *    beforeReadFile, afterFileEdit) carry no generic tool_name field at all —
 *    src/hooks/collector-script.ts derives the tool name directly from the
 *    event name itself, so this map is never consulted for those events.
 * 2. Cursor's generic preToolUse/postToolUse events (confirmed to exist, but
 *    with a payload schema that is only partially documented) carry
 *    tool_name as one of a small fixed vocabulary: Shell/Read/Write/Task/MCP.
 *    Read/Write need no translation (Cursor's names already match Preflight's
 *    canonical names). MCP is deliberately left unmapped — collapsing an
 *    arbitrary downstream MCP tool call into the literal string "MCP" would
 *    discard information no source confirms how to recover from this event
 *    alone; mapToolName() correctly returns 'Unknown' for it, and the caller
 *    (src/hooks/event-processor.ts's mapToolNameOrOriginal()) preserves "MCP"
 *    as the original name rather than collapsing it further.
 */
const CURSOR_TOOL_MAP: Record<string, string> = {
  edit_file: 'Edit',
  read_file: 'Read',
  run_terminal_command: 'Bash',
  search: 'Grep',
  list_directory: 'Glob',
  file_search: 'Glob',
  grep_search: 'Grep',
  codebase_search: 'Grep',
  delete_file: 'Delete',
  create_file: 'Write',
  Shell: 'Bash',
  Task: 'Agent',
  Read: 'Read',
  Write: 'Write',
};

interface CursorToolCallEvent {
  tool?: string;
  timestamp?: number;
  durationMs?: number;
  success?: boolean;
  error?: string;
  filePath?: string;
  command?: string;
  inputSizeBytes?: number;
  outputSizeBytes?: number;
  sessionId?: string;
  [key: string]: unknown;
}

export class CursorAdapter implements PlatformAdapter {
  readonly platformName = 'cursor';

  async initialize(_config: PlatformConfig): Promise<void> {
    // Cursor's built-in tool activity (shell commands, file reads/edits) is
    // captured via its own hooks system (.cursor/hooks.json), a local
    // process protocol unrelated to MCP — see getHookInstallInstructions().
    // MCP tool calls Cursor makes to third-party servers also flow through
    // that same hooks system (beforeMCPExecution/afterMCPExecution), not
    // through a Preflight-side MCP proxy.
  }

  normalizeToolCall(raw: unknown): NormalizedToolCall {
    const event = raw as CursorToolCallEvent;
    const platformToolName = event.tool ?? 'unknown';
    const toolName = CURSOR_TOOL_MAP[platformToolName] ?? 'Unknown';

    return {
      toolName,
      platformToolName,
      platform: this.platformName,
      timestamp: event.timestamp ?? Date.now(),
      durationMs: event.durationMs ?? null,
      success: event.success ?? true,
      ...(event.error !== undefined && { error: event.error }),
      ...(event.inputSizeBytes !== undefined && { inputSizeBytes: event.inputSizeBytes }),
      ...(event.outputSizeBytes !== undefined && { outputSizeBytes: event.outputSizeBytes }),
      ...(event.filePath !== undefined && { filePath: event.filePath }),
      ...(event.command !== undefined && { command: event.command }),
      ...(event.sessionId !== undefined && { sessionId: event.sessionId }),
    };
  }

  mapToolName(platformToolName: string): string {
    return CURSOR_TOOL_MAP[platformToolName] ?? 'Unknown';
  }

  getSessionMetadata(): PlatformSessionMetadata {
    return {
      platform: this.platformName,
      ...(process.env.CURSOR_VERSION && { ideVersion: process.env.CURSOR_VERSION }),
    };
  }

  getHookInstallInstructions(): string {
    return [
      'Cursor IDE Setup:',
      '1. Register the preflight MCP server for nr_observe_* tools:',
      '   Open Cursor Settings > MCP, add a new server with command: npx preflight --stdio',
      '   Set the environment variables: NEW_RELIC_LICENSE_KEY, NEW_RELIC_ACCOUNT_ID',
      '2. Configure Cursor hooks so tool-call activity (shell, file reads/edits, MCP) is',
      '   captured — create .cursor/hooks.json (project) or ~/.cursor/hooks.json (global):',
      '   {',
      '     "version": 1,',
      '     "hooks": {',
      '       "beforeShellExecution": [{ "command": "preflight-collector" }],',
      '       "afterShellExecution": [{ "command": "preflight-collector" }],',
      '       "beforeMCPExecution": [{ "command": "preflight-collector" }],',
      '       "afterMCPExecution": [{ "command": "preflight-collector" }],',
      '       "beforeReadFile": [{ "command": "preflight-collector" }],',
      '       "afterFileEdit": [{ "command": "preflight-collector" }]',
      '     }',
      '   }',
      '3. Ensure preflight-collector is on your PATH (npm link, or npm install -g @newrelic/preflight)',
      '4. Restart Cursor.',
    ].join('\n');
  }

  isSupported(): boolean {
    return (
      process.env.CURSOR_SESSION_ID !== undefined ||
      process.env.CURSOR_TRACE_ID !== undefined ||
      process.env.MCP_CLIENT === 'cursor'
    );
  }
}
