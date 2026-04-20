import type {
  PlatformAdapter,
  PlatformConfig,
  PlatformSessionMetadata,
  NormalizedToolCall,
} from './types.js';

const CURSOR_TOOL_MAP: Record<string, string> = {
  edit_file: 'Edit',
  read_file: 'Read',
  run_terminal_command: 'Bash',
  search: 'Grep',
  list_directory: 'Glob',
  file_search: 'Glob',
  grep_search: 'Grep',
  codebase_search: 'Grep',
  delete_file: 'Write',
  create_file: 'Write',
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
    // Cursor uses MCP natively — proxy captures MCP tool calls automatically.
    // Built-in tool calls arrive via file watcher or extension API events.
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

  getSessionMetadata(): PlatformSessionMetadata {
    return {
      platform: this.platformName,
      ...(process.env.CURSOR_VERSION && { ideVersion: process.env.CURSOR_VERSION }),
    };
  }

  getHookInstallInstructions(): string {
    return [
      'Cursor IDE Setup:',
      '1. Open Cursor Settings > MCP',
      '2. Add a new MCP server with command: npx nr-ai-mcp-server --stdio',
      '3. Set the environment variables: NEW_RELIC_LICENSE_KEY, NEW_RELIC_ACCOUNT_ID',
      '4. MCP tool calls are captured automatically via the proxy',
      '5. Built-in tool calls (file edits, terminal) require the file watcher or Cursor extension',
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
