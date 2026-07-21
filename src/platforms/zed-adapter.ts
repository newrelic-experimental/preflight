import type {
  PlatformAdapter,
  PlatformConfig,
  PlatformSessionMetadata,
  NormalizedToolCall,
} from './types.js';

// Maps Zed's real built-in agent tool names (confirmed via
// https://zed.dev/docs/ai/tools.html) to the normalized Claude Code tool
// vocabulary. Zed's native agent has no hook/callback mechanism (see
// initialize()'s comment below), so these entries are currently unreachable
// from the real hook pipeline — this map exists for correctness and for any
// future Zed hook capability, not because any Zed event reaches it today.
// `diagnostics`, `copy_path`, `move_path`, and `create_directory` are real
// Zed tools with no named Claude Code equivalent and are deliberately left
// unmapped (they fall through to 'Unknown' with platformToolName preserved).
const ZED_TOOL_MAP: Record<string, string> = {
  read_file: 'Read',
  find_path: 'Glob',
  grep: 'Grep',
  list_directory: 'Glob',
  fetch: 'WebFetch',
  search_web: 'WebSearch',
  edit_file: 'Edit',
  write_file: 'Write',
  delete_path: 'Delete',
  terminal: 'Bash',
  spawn_agent: 'Agent',
  skill: 'Skill',
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
}

function isZedToolCallEvent(x: unknown): x is ZedToolCallEvent {
  return typeof x === 'object' && x !== null;
}

export class ZedAdapter implements PlatformAdapter {
  readonly platformName = 'zed';
  readonly visibilityLevel = 'mcp-tools-only' as const;
  readonly capabilities = { instructionFilePaths: [] as const };

  async initialize(_config: PlatformConfig): Promise<void> {
    // Zed's native agent has no hook/callback mechanism for tool-call
    // interception (confirmed: https://zed.dev/docs/ai/mcp.html — Zed
    // supports only MCP's Tools and Prompts features, with no notification
    // for host-side tool calls). As a Zed MCP "context server", Preflight
    // can only receive calls Zed's agent makes to Preflight's own exposed
    // tools — it cannot observe Zed's built-in read_file/edit_file/terminal
    // calls. When Zed runs another coding agent (Claude Code, Cursor, etc.)
    // as an External Agent via the Agent Client Protocol
    // (https://zed.dev/docs/ai/external-agents.html), that agent's own
    // native hooks already capture its tool calls independently of Zed.
  }

  normalizeToolCall(raw: unknown): NormalizedToolCall {
    const event = isZedToolCallEvent(raw) ? raw : {};
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
      "1. Zed's native agent has no hook mechanism for tool-call capture —",
      '   Preflight configured as a Zed MCP server only sees calls made to',
      "   its own tools, not Zed's built-in read_file/edit_file/terminal calls.",
      '2. To use Preflight as an MCP context server in Zed (for its own',
      '   observability tools), open Settings -> AI -> MCP Servers, click',
      '   "Add Server", and add:',
      '   {',
      '     "context_servers": {',
      '       "preflight": {',
      '         "command": "npx",',
      '         "args": ["preflight", "--stdio"],',
      '         "env": {',
      '           "NEW_RELIC_LICENSE_KEY": "<your-key>",',
      '           "NEW_RELIC_ACCOUNT_ID": "<your-account-id>"',
      '         }',
      '       }',
      '     }',
      '   }',
      '3. For full tool-call observability, run Claude Code (or another',
      '   already-supported platform) as a Zed External Agent instead —',
      '   its own native hooks capture tool calls independently of Zed.',
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
