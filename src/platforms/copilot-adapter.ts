import type {
  NormalizedToolCall,
  PlatformAdapter,
  PlatformConfig,
  PlatformSessionMetadata,
} from './types.js';

/**
 * Event types forwarded by a Copilot-compatible VS Code extension via HTTP.
 * This adapter only consumes its events.
 */
export interface CopilotToolCallEvent {
  readonly type:
    'file_edit' | 'file_open' | 'file_create' | 'file_delete' | 'terminal_command' | 'task';
  readonly timestamp?: number;
  readonly endTimestamp?: number;
  readonly filePath?: string;
  readonly command?: string;
  readonly success?: boolean;
  readonly error?: string;
  readonly inputSizeBytes?: number;
  readonly outputSizeBytes?: number;
  readonly sessionId?: string;
}

const COPILOT_EVENT_TYPES = new Set<string>([
  'file_edit',
  'file_open',
  'file_create',
  'file_delete',
  'terminal_command',
  'task',
]);

function isCopilotToolCallEvent(x: unknown): x is CopilotToolCallEvent {
  return (
    typeof x === 'object' &&
    x !== null &&
    'type' in x &&
    typeof (x as { type: unknown }).type === 'string' &&
    COPILOT_EVENT_TYPES.has((x as { type: string }).type)
  );
}

const COPILOT_EVENT_TYPE_MAP: Record<string, string> = {
  file_edit: 'Edit',
  file_open: 'Read',
  file_create: 'Write',
  file_delete: 'Delete',
  terminal_command: 'Bash',
  task: 'Bash',
};

/**
 * Maps VS Code Copilot tool names (carried in hook `tool_name`) to the
 * normalized Claude Code tool vocabulary. VS Code agent hooks send VS Code's
 * own tool names, not Claude Code's — documented in the hooks FAQ
 * (https://code.visualstudio.com/docs/copilot/customization/hooks, "Tool
 * names: ... VS Code uses tool names like `create_file` and
 * `replace_string_in_file`"). The full name inventory is the `ToolName` enum
 * in microsoft/vscode `extensions/copilot/src/extension/tools/common/toolNames.ts`.
 * `editFiles` appears in the hooks reference example payloads
 * (https://code.visualstudio.com/docs/agents/reference/hooks-reference).
 * This map is VS Code-specific — the GitHub Copilot CLI/SDK runtime is a
 * separate adapter (copilot-sdk) with its own tool-name vocabulary. Names
 * without a clear canonical correspondence (semantic_search, get_errors,
 * ...) are deliberately left unmapped so the original name is preserved
 * downstream.
 */
const COPILOT_TOOL_MAP: Record<string, string> = {
  read_file: 'Read',
  create_file: 'Write',
  replace_string_in_file: 'Edit',
  multi_replace_string_in_file: 'Edit',
  insert_edit_into_file: 'Edit',
  apply_patch: 'Edit',
  edit_files: 'Edit',
  editFiles: 'Edit',
  run_in_terminal: 'Bash',
  grep_search: 'Grep',
  file_search: 'Glob',
  list_dir: 'Glob',
  runSubagent: 'Agent',
  search_subagent: 'Agent',
  explore_subagent: 'Agent',
  execution_subagent: 'Agent',
};

export interface CopilotUsageRecord {
  readonly day: string;
  readonly total_suggestions_count?: number;
  readonly total_acceptances_count?: number;
  readonly total_lines_suggested?: number;
  readonly total_lines_accepted?: number;
  readonly total_active_users?: number;
}

export function parseCopilotUsageResponse(raw: unknown): CopilotUsageRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is CopilotUsageRecord =>
      typeof item === 'object' && item !== null && typeof item.day === 'string',
  );
}

export class CopilotAdapter implements PlatformAdapter {
  readonly platformName = 'copilot';
  // Full-hooks since VS Code agent hooks (PreToolUse/PostToolUse et al.,
  // https://code.visualstudio.com/docs/copilot/customization/hooks) fire on
  // every built-in tool call and are parsed by collector-script.ts's uniform
  // branch. The HTTP-push extension path below remains as a legacy fallback.
  readonly visibilityLevel = 'full-hooks' as const;
  readonly capabilities = { instructionFilePaths: [] as const };

  async initialize(_config: PlatformConfig): Promise<void> {
    // Tool calls arrive via VS Code agent hooks (collector script), or
    // legacy HTTP push from a Copilot-compatible extension.
  }

  normalizeToolCall(raw: unknown): NormalizedToolCall {
    const event = isCopilotToolCallEvent(raw) ? raw : undefined;
    const eventType = event?.type ?? 'unknown';
    const toolName = COPILOT_EVENT_TYPE_MAP[eventType] ?? 'Unknown';

    const timestamp = event?.timestamp ?? Date.now();
    const durationMs =
      event?.timestamp !== undefined && event?.endTimestamp !== undefined
        ? Math.max(0, event.endTimestamp - event.timestamp)
        : null;

    return {
      toolName,
      platformToolName: eventType,
      platform: this.platformName,
      timestamp,
      durationMs,
      success: event?.success ?? true,
      ...(event?.error !== undefined && { error: event.error }),
      ...(event?.inputSizeBytes !== undefined && { inputSizeBytes: event.inputSizeBytes }),
      ...(event?.outputSizeBytes !== undefined && { outputSizeBytes: event.outputSizeBytes }),
      ...(event?.filePath !== undefined && { filePath: event.filePath }),
      ...(event?.command !== undefined && { command: event.command }),
      ...(event?.sessionId !== undefined && { sessionId: event.sessionId }),
    };
  }

  mapToolName(platformToolName: string): string {
    return (
      COPILOT_TOOL_MAP[platformToolName] ?? COPILOT_EVENT_TYPE_MAP[platformToolName] ?? 'Unknown'
    );
  }

  getSessionMetadata(): PlatformSessionMetadata {
    return {
      platform: this.platformName,
      ...(process.env.VSCODE_VERSION && { ideVersion: process.env.VSCODE_VERSION }),
      ...(process.env.COPILOT_EXTENSION_VERSION && {
        extensionVersion: process.env.COPILOT_EXTENSION_VERSION,
      }),
    };
  }

  getHookInstallInstructions(): string {
    return [
      'GitHub Copilot Observability Setup (VS Code agent hooks):',
      '0. Or just run `preflight setup` (or `preflight install --copilot`) — it',
      '   configures all of the below automatically for both VS Code Copilot Chat',
      "   and the Copilot CLI, including the fix for VS Code's hook double-capture",
      '   (step 1b below) via chat.hookFilesLocations.',
      '1. Create a hooks file — user-level ~/.copilot/hooks/preflight.json (applies to',
      '   all workspaces) or workspace-level .github/hooks/preflight.json:',
      '   {',
      '     "version": 1,',
      '     "hooks": {',
      '       "PreToolUse": [{ "type": "command", "command": "NEW_RELIC_AI_PLATFORM=copilot preflight-collector pre-tool" }],',
      '       "PostToolUse": [{ "type": "command", "command": "NEW_RELIC_AI_PLATFORM=copilot preflight-collector post-tool" }]',
      '     }',
      '   }',
      "   The NEW_RELIC_AI_PLATFORM=copilot prefix is required — Copilot's hooks-runner",
      '   does not inherit env vars set on an MCP server registration (e.g.',
      '   `copilot mcp add --env MCP_CLIENT=...`), so without it every event falls',
      '   through to the claude-code platform default.',
      '1b. VS Code also reads Claude-format hooks from ~/.claude/settings.json by',
      '   default — if preflight hooks are installed there for Claude Code, either',
      '   rely on those or disable that location via chat.hookFilesLocations to',
      '   avoid double capture.',
      '2. Ensure preflight-collector is on PATH (npm install -g @newrelic/preflight).',
      '3. Register the Preflight MCP server for nr_observe_* tools with env',
      '   MCP_CLIENT=copilot, NEW_RELIC_LICENSE_KEY, NEW_RELIC_ACCOUNT_ID.',
      '4. For the GitHub Copilot CLI/SDK runtime instead of VS Code, use the',
      "   copilot-sdk adapter's own setup — Copilot CLI's native lowerCamelCase",
      '   hooks are not compatible with this adapter.',
      'Legacy fallback: a Copilot-compatible extension may instead push events to',
      'http://localhost:9847 ("preflight.endpoint" in VS Code settings).',
    ].join('\n');
  }

  isSupported(): boolean {
    return process.env.MCP_CLIENT === 'copilot' || process.env.NEW_RELIC_AI_PLATFORM === 'copilot';
  }
}
