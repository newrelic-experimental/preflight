import type {
  PlatformAdapter,
  PlatformConfig,
  PlatformSessionMetadata,
  NormalizedToolCall,
} from './types.js';

const CONTINUE_TOOL_MAP: Record<string, string> = {
  read_file: 'Read',
  read_file_range: 'Read',
  read_currently_open_file: 'Read',
  edit_existing_file: 'Edit',
  single_find_and_replace: 'Edit',
  multi_edit: 'MultiEdit',
  create_new_file: 'Write',
  run_terminal_command: 'Bash',
  grep_search: 'Grep',
  file_glob_search: 'Glob',
  ls: 'Glob',
  view_subdirectory: 'Glob',
  view_repo_map: 'Glob',
  search_web: 'WebSearch',
  fetch_url_content: 'WebFetch',
  read_skill: 'Skill',
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
}

function isContinueToolCallEvent(x: unknown): x is ContinueToolCallEvent {
  return typeof x === 'object' && x !== null;
}

export class ContinueAdapter implements PlatformAdapter {
  readonly platformName = 'continue';

  async initialize(_config: PlatformConfig): Promise<void> {
    // Continue's native agent (VS Code/JetBrains extension and CLI) has no
    // PreToolUse/PostToolUse-style hook mechanism for its built-in tools
    // (read_file, edit_existing_file, run_terminal_command, etc.). Continue
    // supports MCP only as a client: it can call out to an MCP server like
    // Preflight, but that only surfaces calls Continue's agent chooses to make
    // to Preflight's own tools, never a callback for Continue's built-in tool
    // calls. See getHookInstallInstructions() for the real integration path.
  }

  normalizeToolCall(raw: unknown): NormalizedToolCall {
    const event = isContinueToolCallEvent(raw) ? raw : {};
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

  mapToolName(platformToolName: string): string {
    return CONTINUE_TOOL_MAP[platformToolName] ?? 'Unknown';
  }

  getSessionMetadata(): PlatformSessionMetadata {
    return {
      platform: this.platformName,
      ...(process.env.CONTINUE_VERSION && { ideVersion: process.env.CONTINUE_VERSION }),
    };
  }

  getHookInstallInstructions(): string {
    return [
      'Continue Setup:',
      '',
      "Continue's native agent has no hook mechanism — Preflight cannot",
      'observe calls to built-in tools (read_file, edit_existing_file,',
      'run_terminal_command, etc.) the way it does for Claude Code.',
      '',
      'What Preflight CAN see: calls Continue routes to its own MCP tools.',
      '1. Create a folder .continue/mcpServers in your workspace root.',
      '2. Add a file preflight.yaml with:',
      '   name: Preflight mcpServer',
      '   version: 0.0.1',
      '   schema: v1',
      '   mcpServers:',
      '     - name: preflight',
      '       command: npx',
      '       args: ["preflight", "--stdio"]',
      '       env:',
      '         NEW_RELIC_LICENSE_KEY: <your-key>',
      '         NEW_RELIC_ACCOUNT_ID: <your-account-id>',
      '3. Reload Continue.',
      '',
      'Note: the continuedev/continue repository is no longer actively maintained',
      'and is read-only for all users as of its final 2.0.0',
      'release, so this integration path is unlikely to gain deeper hooks.',
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
