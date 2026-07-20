import type {
  PlatformAdapter,
  PlatformConfig,
  PlatformSessionMetadata,
  NormalizedToolCall,
} from './types.js';

/**
 * Maps Amazon Kiro tool names to the normalized Claude Code tool vocabulary.
 * Kiro's hook events (https://kiro.dev/docs/cli/hooks) send `tool_name` as
 * either a tool's canonical name (`fs_read`) or a documented alias (`read`) —
 * both forms are covered. Entries without a confirmed source in Kiro's docs
 * (e.g. `fsRead`, `fsCreate`) are kept as best-effort coverage for IDE-surface
 * tool names not yet documented publicly; don't remove them without positive
 * evidence they're wrong.
 */
const KIRO_TOOL_MAP: Record<string, string> = {
  fsRead: 'Read',
  fs_read: 'Read',
  read: 'Read',
  readFile: 'Read',
  readMultipleFiles: 'Read',
  fsWrite: 'Write',
  fs_write: 'Write',
  write: 'Write',
  writeFile: 'Write',
  fsCreate: 'Write',
  fsAppend: 'Edit',
  fsReplace: 'Edit',
  fs_edit: 'Edit',
  editFile: 'Edit',
  strReplace: 'Edit',
  deletePath: 'Delete',
  fs_delete: 'Delete',
  deleteFile: 'Delete',
  listDirectory: 'Glob',
  fs_list: 'Glob',
  fileSearch: 'Glob',
  fs_find: 'Glob',
  findFiles: 'Glob',
  grepSearch: 'Grep',
  grep: 'Grep',
  search_code: 'Grep',
  executeBash: 'Bash',
  execute_bash: 'Bash',
  shell: 'Bash',
  executePwsh: 'Bash',
  run_command: 'Bash',
  use_aws: 'Bash',
  aws: 'Bash',
};

interface KiroToolCallEvent {
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
}

function isKiroToolCallEvent(x: unknown): x is KiroToolCallEvent {
  return typeof x === 'object' && x !== null;
}

export class KiroAdapter implements PlatformAdapter {
  readonly platformName = 'kiro';
  readonly visibilityLevel = 'full-hooks' as const;

  async initialize(_config: PlatformConfig): Promise<void> {
    // Amazon Kiro connects via the MCP stdio protocol.
  }

  normalizeToolCall(raw: unknown): NormalizedToolCall {
    const event = isKiroToolCallEvent(raw) ? raw : {};
    const platformToolName = event.tool ?? event.toolName ?? 'unknown';
    const toolName = KIRO_TOOL_MAP[platformToolName] ?? 'Unknown';
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

  mapToolName(platformToolName: string): string {
    return KIRO_TOOL_MAP[platformToolName] ?? 'Unknown';
  }

  getSessionMetadata(): PlatformSessionMetadata {
    return {
      platform: this.platformName,
      ...(process.env.KIRO_VERSION && { ideVersion: process.env.KIRO_VERSION }),
    };
  }

  getHookInstallInstructions(): string {
    return [
      'Amazon Kiro Setup:',
      '1. Open your Kiro MCP configuration file',
      '   (user-level ~/.kiro/settings/mcp.json or workspace-level .kiro/settings/mcp.json)',
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
      '3. Restart Kiro (or reconnect MCP servers from the Kiro MCP panel).',
    ].join('\n');
  }

  isSupported(): boolean {
    return (
      process.env.KIRO_SESSION_ID !== undefined ||
      process.env.KIRO_IDE !== undefined ||
      process.env.MCP_CLIENT === 'kiro' ||
      process.env.NEW_RELIC_AI_PLATFORM === 'kiro'
    );
  }
}
