import type {
  PlatformAdapter,
  PlatformConfig,
  PlatformSessionMetadata,
  NormalizedToolCall,
} from './types.js';

const AMAZON_Q_TOOL_MAP: Record<string, string> = {
  fs_read: 'Read',
  fs_write: 'Write',
  fs_edit: 'Edit',
  fs_create: 'Write',
  fs_delete: 'Delete',
  fs_list: 'Glob',
  fs_find: 'Glob',
  grep: 'Grep',
  search_code: 'Grep',
  execute_bash: 'Bash',
  run_shell: 'Bash',
  execute_command: 'Bash',
  explain_code: 'Read',
  review_code: 'Read',
  transform_code: 'Edit',
};

interface AmazonQToolCallEvent {
  tool?: string;
  toolName?: string;
  timestamp?: number;
  durationMs?: number;
  success?: boolean;
  error?: string;
  filePath?: string;
  path?: string;
  command?: string;
  inputSizeBytes?: number;
  outputSizeBytes?: number;
  sessionId?: string;
  [key: string]: unknown;
}

export class AmazonQAdapter implements PlatformAdapter {
  readonly platformName = 'amazon-q';

  async initialize(_config: PlatformConfig): Promise<void> {
    // Amazon Q Developer connects via the MCP stdio protocol.
  }

  normalizeToolCall(raw: unknown): NormalizedToolCall {
    const event = raw as AmazonQToolCallEvent;
    const platformToolName = event.tool ?? event.toolName ?? 'unknown';
    const toolName = AMAZON_Q_TOOL_MAP[platformToolName] ?? 'Unknown';
    const filePath = event.filePath ?? event.path;

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
      ...(process.env.AMAZON_Q_VERSION && { ideVersion: process.env.AMAZON_Q_VERSION }),
    };
  }

  getHookInstallInstructions(): string {
    return [
      'Amazon Q Developer Setup:',
      '1. Open your Amazon Q Developer MCP configuration file',
      '   (typically ~/.aws/amazonq/mcp.json or project-level .amazonq/mcp.json)',
      '2. Add to "mcpServers":',
      '   {',
      '     "preflight": {',
      '       "command": "npx",',
      '       "args": ["preflight", "--stdio"],',
      '       "env": {',
      '         "NEW_RELIC_LICENSE_KEY": "<your-key>",',
      '         "NEW_RELIC_ACCOUNT_ID": "<your-account-id>"',
      '       }',
      '     }',
      '   }',
      '3. Restart Amazon Q Developer.',
    ].join('\n');
  }

  isSupported(): boolean {
    return (
      process.env.AMAZON_Q_SESSION_ID !== undefined ||
      process.env.Q_DEVELOPER_SESSION !== undefined ||
      process.env.MCP_CLIENT === 'amazon-q' ||
      process.env.AWS_CODEWHISPERER_SESSION !== undefined
    );
  }
}
