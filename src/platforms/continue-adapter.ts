import type {
  PlatformAdapter,
  PlatformConfig,
  PlatformSessionMetadata,
  NormalizedToolCall,
} from './types.js';

const CONTINUE_TOOL_MAP: Record<string, string> = {
  readFile: 'Read',
  writeFile: 'Write',
  editFile: 'Edit',
  createFile: 'Write',
  deleteFile: 'Delete',
  searchFiles: 'Glob',
  grep: 'Grep',
  grepSearch: 'Grep',
  fileSearch: 'Glob',
  runTerminalCommand: 'Bash',
  terminal: 'Bash',
  viewSubdirectory: 'Glob',
  viewRepoMap: 'Glob',
};

interface ContinueToolCallEvent {
  tool?: string;
  toolName?: string;
  timestamp?: number;
  durationMs?: number;
  success?: boolean;
  error?: string;
  filepath?: string;
  filePath?: string;
  command?: string;
  inputSizeBytes?: number;
  outputSizeBytes?: number;
  sessionId?: string;
  [key: string]: unknown;
}

export class ContinueAdapter implements PlatformAdapter {
  readonly platformName = 'continue';

  async initialize(_config: PlatformConfig): Promise<void> {
    // Continue.dev communicates via MCP stdio or local HTTP server.
  }

  normalizeToolCall(raw: unknown): NormalizedToolCall {
    const event = raw as ContinueToolCallEvent;
    // Continue may use either 'tool' or 'toolName'
    const platformToolName = event.tool ?? event.toolName ?? 'unknown';
    const toolName = CONTINUE_TOOL_MAP[platformToolName] ?? 'Unknown';
    // Continue may use 'filepath' (lowercase p) or 'filePath'
    const filePath = event.filePath ?? event.filepath;

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
      ...(filePath !== undefined && { filePath }),
      ...(event.command !== undefined && { command: event.command }),
      ...(event.sessionId !== undefined && { sessionId: event.sessionId }),
    };
  }

  getSessionMetadata(): PlatformSessionMetadata {
    return {
      platform: this.platformName,
      ...(process.env.CONTINUE_VERSION && { ideVersion: process.env.CONTINUE_VERSION }),
    };
  }

  getHookInstallInstructions(): string {
    return [
      'Continue.dev Setup:',
      '1. Open Continue config file (~/.continue/config.json)',
      '2. Add to "mcpServers":',
      '   {',
      '     "name": "preflight",',
      '     "command": "npx",',
      '     "args": ["preflight", "--stdio"],',
      '     "env": {',
      '       "NEW_RELIC_LICENSE_KEY": "<your-key>",',
      '       "NEW_RELIC_ACCOUNT_ID": "<your-account-id>"',
      '     }',
      '   }',
      '3. Reload the Continue extension.',
    ].join('\n');
  }

  isSupported(): boolean {
    return (
      process.env.CONTINUE_SESSION_ID !== undefined ||
      process.env.CONTINUE_SERVER_HOST !== undefined ||
      process.env.MCP_CLIENT === 'continue' ||
      process.env.MCP_CLIENT_NAME === 'continue'
    );
  }
}
