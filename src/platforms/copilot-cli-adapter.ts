import type {
  NormalizedToolCall,
  PlatformAdapter,
  PlatformConfig,
  PlatformSessionMetadata,
} from './types.js';

/**
 * Maps Copilot CLI's built-in tool names to Preflight's canonical
 * (Claude-Code-shaped) vocabulary. Source: GitHub's own CLI command
 * reference, "Tool availability values" section
 * (docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#tool-availability-values),
 * which enumerates the full built-in tool set by category (shell, file
 * operation, agent/task delegation, other).
 *
 * Deliberately unmapped (no clear canonical correspondence, preserved as
 * the original name downstream): the shell session-management variants
 * (list_bash/read_bash/stop_bash/write_bash and their powershell
 * equivalents — these manage a *background* shell session rather than
 * running a command, unlike bash/powershell itself), list_agents,
 * read_agent, write_agent, ask_user, skill, web_fetch. This mirrors the
 * VS Code CopilotAdapter's COPILOT_TOOL_MAP precedent of leaving
 * introspection/messaging tools unmapped rather than guessing.
 */
const COPILOT_CLI_TOOL_MAP: Record<string, string> = {
  bash: 'Bash',
  powershell: 'Bash',
  apply_patch: 'Edit',
  create: 'Write',
  edit: 'Edit',
  view: 'Read',
  task: 'Agent',
  glob: 'Glob',
  grep: 'Grep',
  rg: 'Grep',
};

interface CopilotCliToolCallEvent {
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

function isCopilotCliToolCallEvent(x: unknown): x is CopilotCliToolCallEvent {
  return typeof x === 'object' && x !== null;
}

/**
 * Adapter for the GitHub Copilot CLI runtime — distinct from the VS Code
 * Copilot Chat adapter (`CopilotAdapter`): different session-id space (no
 * `workspaceStorage`; sessions live in `~/.copilot/session-state/<id>/`),
 * and different tool-name vocabulary (`bash`/`edit`/`grep` rather than VS
 * Code's `run_in_terminal`/`replace_string_in_file`).
 */
export class CopilotCliAdapter implements PlatformAdapter {
  readonly platformName = 'copilot-cli';
  // Copilot CLI hooks fire on every built-in tool call via the same
  // uniform hook envelope collector-script.ts already parses (confirmed:
  // ~/.copilot/hooks/preflight.json fires for CLI sessions, lowerCamelCase
  // event names surviving the collector's case normalization — see
  // docs/ADAPTERS.md's Copilot section).
  readonly visibilityLevel = 'full-hooks' as const;
  // Repo-relative instruction files the CLI itself reads (Git root and cwd),
  // per GitHub's own CLI reference, "Custom instructions locations"
  // (docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#custom-instructions-locations).
  // That table also lists a user-level `$HOME/.copilot/copilot-instructions.md`,
  // but every existing adapter's instructionFilePaths entry is a repo-relative
  // fragment matched against a tool call's filePath (see
  // ClaudeMdTracker.matchesInstructionFile) — a global per-user path doesn't
  // fit that shape, so it's intentionally left out here rather than modeled
  // as a novel case no other adapter uses.
  readonly capabilities = {
    instructionFilePaths: ['AGENTS.md', '.github/copilot-instructions.md'] as const,
  };

  async initialize(_config: PlatformConfig): Promise<void> {
    // Tool calls arrive via Copilot CLI agent hooks (collector script),
    // parsed by collector-script.ts's uniform branch.
  }

  normalizeToolCall(raw: unknown): NormalizedToolCall {
    const event = isCopilotCliToolCallEvent(raw) ? raw : {};
    const platformToolName = event.tool ?? event.toolName ?? 'unknown';
    const toolName = COPILOT_CLI_TOOL_MAP[platformToolName] ?? 'Unknown';
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
    return COPILOT_CLI_TOOL_MAP[platformToolName] ?? 'Unknown';
  }

  getSessionMetadata(): PlatformSessionMetadata {
    return {
      platform: this.platformName,
    };
  }

  getHookInstallInstructions(): string {
    return [
      'GitHub Copilot CLI Setup:',
      '1. Create a hooks file to enable tool-call capture — user-level',
      '   ~/.copilot/hooks/preflight.json (applies to all sessions) or',
      '   workspace-level .github/hooks/preflight.json:',
      '   {',
      '     "hooks": {',
      '       "PreToolUse": [{ "type": "command", "command": "preflight-collector pre-tool" }],',
      '       "PostToolUse": [{ "type": "command", "command": "preflight-collector post-tool" }]',
      '     }',
      '   }',
      '2. Ensure preflight-collector is on PATH (npm link, or npm install -g @newrelic/preflight)',
      '3. Register the Preflight MCP server:',
      '   copilot mcp add preflight \\',
      '     --env MCP_CLIENT=copilot-cli \\',
      '     --env NEW_RELIC_LICENSE_KEY=<your-key> \\',
      '     --env NEW_RELIC_ACCOUNT_ID=<your-account-id> \\',
      '     -- npx preflight --stdio',
      '4. Restart the CLI (or run /extensions reload if already open)',
    ].join('\n');
  }

  isSupported(): boolean {
    return (
      process.env.MCP_CLIENT === 'copilot-cli' ||
      process.env.NEW_RELIC_AI_PLATFORM === 'copilot-cli'
    );
  }
}
