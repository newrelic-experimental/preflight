import type {
  PlatformAdapter,
  PlatformConfig,
  PlatformSessionMetadata,
  NormalizedToolCall,
} from './types.js';

const ZED_TOOL_MAP: Record<string, string> = {
  open_file: 'Read',
  read_file: 'Read',
  create_file: 'Write',
  write_file: 'Write',
  edit_file: 'Edit',
  delete_file: 'Delete',
  search_files: 'Glob',
  find_in_files: 'Grep',
  search_in_file: 'Grep',
  execute_command: 'Bash',
  run_command: 'Bash',
  list_files: 'Glob',
  list_directory: 'Glob',
};

interface ZedToolCallEvent {
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

export class ZedAdapter implements PlatformAdapter {
  readonly platformName = 'zed';

  async initialize(_config: PlatformConfig): Promise<void> {
    // Zed spawns MCP servers as child processes. Tool calls arrive via stdio.
  }

  normalizeToolCall(raw: unknown): NormalizedToolCall {
    const event = raw as ZedToolCallEvent;
    const platformToolName = event.tool ?? 'unknown';
    const toolName = ZED_TOOL_MAP[platformToolName] ?? 'Unknown';

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
    return ZED_TOOL_MAP[platformToolName] ?? 'Unknown';
  }

  getSessionMetadata(): PlatformSessionMetadata {
    return {
      platform: this.platformName,
      ...(process.env.ZED_EXTENSION_API_VERSION && {
        ideVersion: process.env.ZED_EXTENSION_API_VERSION,
      }),
    };
  }

  getHookInstallInstructions(): string {
    return [
      'Zed Editor Setup:',
      '1. Open Zed Settings (Cmd+,) and go to the "assistant" section',
      '2. Add an MCP server entry:',
      '   {',
      '     "name": "preflight",',
      '     "command": "npx",',
      '     "args": ["preflight", "--stdio"],',
      '     "env": {',
      '       "NEW_RELIC_LICENSE_KEY": "<your-key>",',
      '       "NEW_RELIC_ACCOUNT_ID": "<your-account-id>"',
      '     }',
      '   }',
      '3. Restart Zed to activate.',
    ].join('\n');
  }

  isSupported(): boolean {
    return (
      process.env.ZED_SESSION_ID !== undefined ||
      process.env.ZED_EXTENSION_API_VERSION !== undefined ||
      process.env.MCP_CLIENT === 'zed' ||
      process.env.ZED_ITEM_ID !== undefined
    );
  }
}
