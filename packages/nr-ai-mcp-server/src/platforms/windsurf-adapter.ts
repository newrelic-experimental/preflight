import type {
  NormalizedToolCall,
  PlatformAdapter,
  PlatformConfig,
  PlatformSessionMetadata,
} from './types.js';

const WINDSURF_TOOL_MAP: Record<string, string> = {
  'Read File': 'Read',
  'Write File': 'Write',
  'Edit File': 'Edit',
  'Run Command': 'Bash',
  'Search': 'Grep',
  read_file: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  run_command: 'Bash',
  search: 'Grep',
  create_file: 'Write',
  delete_file: 'Write',
  list_directory: 'Glob',
};

interface WindsurfToolCallEvent {
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

export class WindsurfAdapter implements PlatformAdapter {
  readonly platformName = 'windsurf';

  async initialize(_config: PlatformConfig): Promise<void> {
    // Windsurf supports MCP natively — proxy captures MCP tool calls automatically.
    // Built-in Cascade tool calls arrive via extension API or file watcher events.
  }

  normalizeToolCall(raw: unknown): NormalizedToolCall {
    const event = raw as WindsurfToolCallEvent;
    const platformToolName = event.tool ?? 'unknown';
    const toolName = WINDSURF_TOOL_MAP[platformToolName] ?? 'Unknown';

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
      ...(process.env.WINDSURF_VERSION && { ideVersion: process.env.WINDSURF_VERSION }),
    };
  }

  getHookInstallInstructions(): string {
    return [
      'Windsurf IDE Setup:',
      '1. Open Windsurf Settings > MCP Servers',
      '2. Add a new MCP server with command: npx nr-ai-mcp-server --stdio',
      '3. Set the environment variables: NEW_RELIC_LICENSE_KEY, NEW_RELIC_ACCOUNT_ID',
      '4. MCP tool calls via Cascade are captured automatically through the proxy',
      '5. Built-in tool calls (file edits, terminal) require the file watcher or Windsurf extension',
    ].join('\n');
  }

  isSupported(): boolean {
    return (
      process.env.WINDSURF_SESSION_ID !== undefined ||
      process.env.WINDSURF_CONTEXT_ID !== undefined ||
      process.env.MCP_CLIENT === 'windsurf'
    );
  }
}
