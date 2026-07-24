import type {
  NormalizedToolCall,
  PlatformAdapter,
  PlatformConfig,
  PlatformSessionMetadata,
} from './types.js';

/**
 * Maps Antigravity's built-in tool names (confirmed from the Hooks page's
 * "Supported Tools" section — antigravity.google/docs/hooks, identical on
 * /docs/ide/hooks) to the normalized Claude Code tool vocabulary.
 * `list_dir` and `find_by_name` both map to 'Glob' — same "directory/file
 * enumeration -> Glob" precedent as Zed's `list_directory`/Continue's `ls`.
 * `invoke_subagent` -> 'Agent' mirrors Zed's `spawn_agent` -> 'Agent'.
 * `manage_task`, `schedule`, `list_permissions`, `ask_permission`,
 * `define_subagent`, `send_message`, `manage_subagents`, `ask_question`, and
 * `generate_image` are deliberately left unmapped (-> 'Unknown', original
 * name preserved) — no existing canonical Preflight tool covers
 * agent-to-agent messaging, permission introspection, or image generation.
 */
const ANTIGRAVITY_TOOL_MAP: Record<string, string> = {
  view_file: 'Read',
  write_to_file: 'Write',
  replace_file_content: 'Edit',
  multi_replace_file_content: 'MultiEdit',
  list_dir: 'Glob',
  find_by_name: 'Glob',
  grep_search: 'Grep',
  search_web: 'WebSearch',
  read_url_content: 'WebFetch',
  run_command: 'Bash',
  invoke_subagent: 'Agent',
};

interface AntigravityToolCallEvent {
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

function isAntigravityToolCallEvent(x: unknown): x is AntigravityToolCallEvent {
  return typeof x === 'object' && x !== null;
}

export class AntigravityAdapter implements PlatformAdapter {
  readonly platformName = 'antigravity';
  readonly visibilityLevel = 'full-hooks' as const;
  // Confirmed via antigravity.google/docs/ide/rules and /docs/rules-workflows:
  // global rules live in ~/.gemini/GEMINI.md; workspace rules live in
  // .agents/rules/ (with backward-compat support for the older .agent/rules/).
  readonly capabilities = { instructionFilePaths: ['GEMINI.md', '.agents/rules/'] as const };

  async initialize(_config: PlatformConfig): Promise<void> {
    // Antigravity's built-in tool-call capture is delivered via a
    // user-installed hooks.json (see getHookInstallInstructions()), parsed by
    // src/hooks/collector-script.ts — not configured by this process, same
    // no-op shape as every other full-hooks adapter.
  }

  normalizeToolCall(raw: unknown): NormalizedToolCall {
    const event = isAntigravityToolCallEvent(raw) ? raw : {};
    const platformToolName = event.tool ?? event.toolName ?? 'unknown';
    const toolName = ANTIGRAVITY_TOOL_MAP[platformToolName] ?? 'Unknown';
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
    return ANTIGRAVITY_TOOL_MAP[platformToolName] ?? 'Unknown';
  }

  getSessionMetadata(): PlatformSessionMetadata {
    return {
      platform: this.platformName,
    };
  }

  getHookInstallInstructions(): string {
    return [
      'Google Antigravity Setup (2.0 / IDE / CLI):',
      '',
      '1. Register Preflight as an MCP server for its own nr_observe_* tools.',
      '   Create or edit mcp_config.json — globally at',
      '   ~/.gemini/config/mcp_config.json, or per-workspace at',
      '   .agents/mcp_config.json:',
      '   {',
      '     "mcpServers": {',
      '       "preflight": {',
      '         "command": "npx",',
      '         "args": ["preflight", "--stdio"],',
      '         "env": {',
      '           "MCP_CLIENT": "antigravity",',
      '           "NEW_RELIC_LICENSE_KEY": "<your-key>",',
      '           "NEW_RELIC_ACCOUNT_ID": "<your-account-id>"',
      '         }',
      '       }',
      '     }',
      '   }',
      '2. Capture built-in tool calls (file edits, terminal, browser) via',
      '   hooks.json — same global (~/.gemini/config/hooks.json) or workspace',
      '   (.agents/hooks.json) location as mcp_config.json:',
      '   {',
      '     "preflight": {',
      '       "PreToolUse": [',
      '         { "matcher": "*", "hooks": [{ "command": "preflight-collector" }] }',
      '       ],',
      '       "PostToolUse": [',
      '         { "matcher": "*", "hooks": [{ "command": "preflight-collector" }] }',
      '       ]',
      '     }',
      '   }',
      '3. Ensure preflight-collector is on your PATH (npm link, or',
      '   npm install -g @newrelic/preflight).',
      '4. Restart Antigravity (or reload the workspace).',
    ].join('\n');
  }

  isSupported(): boolean {
    return process.env.MCP_CLIENT === 'antigravity';
  }
}
