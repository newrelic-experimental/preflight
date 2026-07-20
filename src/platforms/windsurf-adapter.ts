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
  Search: 'Grep',
  read_file: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  run_command: 'Bash',
  search: 'Grep',
  create_file: 'Write',
  delete_file: 'Delete',
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
}

function isWindsurfToolCallEvent(x: unknown): x is WindsurfToolCallEvent {
  return typeof x === 'object' && x !== null;
}

export class WindsurfAdapter implements PlatformAdapter {
  readonly platformName = 'windsurf';
  readonly visibilityLevel = 'full-hooks' as const;

  async initialize(_config: PlatformConfig): Promise<void> {
    // Windsurf supports MCP natively via its own mcp_config.json. Built-in
    // Cascade tool calls (file reads/writes, terminal commands, MCP calls)
    // arrive through Windsurf's real Cascade Hooks system (.windsurf/hooks.json),
    // handled by src/hooks/collector-script.ts — not through a file watcher
    // or extension API. See https://docs.windsurf.com/windsurf/cascade/hooks.
  }

  normalizeToolCall(raw: unknown): NormalizedToolCall {
    const event = isWindsurfToolCallEvent(raw) ? raw : {};
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

  mapToolName(platformToolName: string): string {
    return WINDSURF_TOOL_MAP[platformToolName] ?? 'Unknown';
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
      '2. Add a new MCP server with command: npx preflight --stdio',
      '3. Set the environment variables: NEW_RELIC_LICENSE_KEY, NEW_RELIC_ACCOUNT_ID',
      '4. MCP tool calls via Cascade are captured automatically through the MCP connection',
      '5. Built-in tool calls (file reads/writes, terminal commands) require Cascade Hooks:',
      '   a. Create .windsurf/hooks.json in your workspace root (or use the user/system-level path)',
      '   b. Register pre_read_code, post_read_code, pre_write_code, post_write_code,',
      '      pre_run_command, and post_run_command hooks, each running:',
      '      preflight-collector',
      '   c. See https://docs.windsurf.com/windsurf/cascade/hooks for the full hooks.json schema',
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
