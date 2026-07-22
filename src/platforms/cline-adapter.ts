import type {
  NormalizedToolCall,
  PlatformAdapter,
  PlatformConfig,
  PlatformSessionMetadata,
} from './types.js';

/**
 * Maps Cline's built-in tool names to the normalized Claude Code tool
 * vocabulary. Source: docs.cline.bot/tools-reference/all-cline-tools,
 * whose "Legacy Tool Names vs Current Runtime Tools" section names
 * execute_command, read_file, and replace_in_file directly as tool names
 * that appear in "older docs/examples" — contrasted with the newer
 * "ClineCore" SDK runtime's read_files/apply_patch/bash/etc. That page does
 * not state which surface (VS Code/JetBrains extension vs. SDK/CLI) emits
 * which name set, and does not enumerate a complete historical tool list —
 * so it's unconfirmed whether the current extension still emits these
 * exact names today. Since visibilityLevel is 'mcp-tools-only' (see
 * initialize() below), this map is currently unreachable from any real
 * hook pipeline regardless. It exists for correctness and any future hook
 * capability, same as Zed's and Continue's tool maps. Other real or
 * reported Cline tool names (write_to_file, search_files, list_files,
 * browser_action, use_mcp_tool, ask_followup_question, attempt_completion,
 * new_task, plan_mode_respond, etc.) are left unmapped rather than guessed
 * at without a documented source — mapToolName has no pass-through
 * fallback, so an omitted key falls through to 'Unknown' with the original
 * name preserved.
 */
const CLINE_TOOL_MAP: Record<string, string> = {
  execute_command: 'Bash',
  read_file: 'Read',
  replace_in_file: 'Edit',
};

interface ClineToolCallEvent {
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

function isClineToolCallEvent(x: unknown): x is ClineToolCallEvent {
  return typeof x === 'object' && x !== null;
}

export class ClineAdapter implements PlatformAdapter {
  readonly platformName = 'cline';
  readonly visibilityLevel = 'mcp-tools-only' as const;
  readonly capabilities = { instructionFilePaths: ['.clinerules/'] as const };

  async initialize(_config: PlatformConfig): Promise<void> {
    // Cline's VS Code/JetBrains extension has no hook/callback mechanism for
    // built-in tool-call interception (confirmed: docs.cline.bot/customization/plugins
    // and docs.cline.bot/tools-reference/all-cline-tools both state Plugins/Custom
    // Tools are "not applicable on VSCode and JetBrains Extension for now" — only
    // Cline SDK, CLI, and Kanban support the beforeTool/afterTool lifecycle hooks
    // documented at docs.cline.bot/sdk/plugins). As a Cline MCP server, Preflight
    // can only receive calls Cline's agent makes to Preflight's own exposed tools —
    // it cannot observe Cline's built-in execute_command/read_file/write_to_file/
    // etc. calls.
  }

  normalizeToolCall(raw: unknown): NormalizedToolCall {
    const event = isClineToolCallEvent(raw) ? raw : {};
    const platformToolName = event.tool ?? event.toolName ?? 'unknown';
    const toolName = CLINE_TOOL_MAP[platformToolName] ?? 'Unknown';
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
    return CLINE_TOOL_MAP[platformToolName] ?? 'Unknown';
  }

  getSessionMetadata(): PlatformSessionMetadata {
    return {
      platform: this.platformName,
    };
  }

  getHookInstallInstructions(): string {
    return [
      'Cline Setup:',
      '',
      "Cline's VS Code/JetBrains extension has no hook mechanism for tool-call",
      'capture — Preflight configured as a Cline MCP server only sees calls made',
      "to its own tools, not Cline's built-in execute_command/read_file/",
      'write_to_file/etc. calls.',
      '',
      '1. Extension: open the Cline panel, click the MCP Servers icon, open the',
      '   Configure tab, click "Configure MCP Servers", and add to mcpServers:',
      '   {',
      '     "mcpServers": {',
      '       "preflight": {',
      '         "command": "npx",',
      '         "args": ["preflight", "--stdio"],',
      '         "env": {',
      '           "MCP_CLIENT": "cline",',
      '           "NEW_RELIC_LICENSE_KEY": "<your-key>",',
      '           "NEW_RELIC_ACCOUNT_ID": "<your-account-id>"',
      '         }',
      '       }',
      '     }',
      '   }',
      '2. CLI: edit ~/.cline/mcp.json with the same shape, or run `cline mcp`.',
      '3. Restart Cline / reload the extension.',
    ].join('\n');
  }

  isSupported(): boolean {
    return process.env.MCP_CLIENT === 'cline' || process.env.NEW_RELIC_AI_PLATFORM === 'cline';
  }
}
