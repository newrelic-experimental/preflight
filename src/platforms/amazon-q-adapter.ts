import type {
  PlatformAdapter,
  PlatformConfig,
  PlatformSessionMetadata,
  NormalizedToolCall,
} from './types.js';

/**
 * Maps Amazon Q Developer CLI's real built-in tool names
 * (https://aws.github.io/amazon-q-developer-cli/built-in-tools.html) to the
 * normalized Claude Code tool vocabulary. Amazon Q CLI has exactly 9
 * built-in tools; only 4 have a genuine Claude Code equivalent.
 * `introspect` (CLI self-help), `report_issue` (opens a GitHub issue
 * template), `knowledge` (cross-session semantic search — a persistent
 * concept with no one-shot equivalent), `thinking` (internal reasoning, no
 * observable side effect), and `use_aws` (a structured AWS API call, not a
 * shell command) are deliberately left unmapped — they fall through to
 * 'Unknown' via mapToolName()'s `?? 'Unknown'` default, with the raw name
 * preserved via event-processor.ts's mapToolNameOrOriginal() fallback.
 */
const AMAZON_Q_TOOL_MAP: Record<string, string> = {
  fs_read: 'Read',
  fs_write: 'Write',
  execute_bash: 'Bash',
  todo_list: 'TaskCreate',
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
}

function isAmazonQToolCallEvent(x: unknown): x is AmazonQToolCallEvent {
  return typeof x === 'object' && x !== null;
}

export class AmazonQAdapter implements PlatformAdapter {
  readonly platformName = 'amazon-q';
  readonly visibilityLevel = 'full-hooks' as const;
  readonly capabilities = { instructionFilePaths: [] as const };

  async initialize(_config: PlatformConfig): Promise<void> {
    // Amazon Q Developer CLI supports MCP as a client (preflight can be
    // registered as an MCP server for nr_observe_* tools, same as every
    // other MCP-client platform in this series) and has a genuine hook
    // mechanism — agentSpawn/userPromptSubmit/preToolUse/postToolUse/stop,
    // configured per-agent (see getHookInstallInstructions()). Unlike Zed or
    // Continue, there is no "hooks don't exist" caveat here: once wired,
    // Amazon Q's preToolUse/postToolUse events are handled by the same
    // generic branches in collector-script.ts that Claude Code and Kiro use
    // — its hook_event_name/tool_name/tool_input field names are identical.
  }

  normalizeToolCall(raw: unknown): NormalizedToolCall {
    const event = isAmazonQToolCallEvent(raw) ? raw : {};
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

  mapToolName(platformToolName: string): string {
    return AMAZON_Q_TOOL_MAP[platformToolName] ?? 'Unknown';
  }

  getSessionMetadata(): PlatformSessionMetadata {
    return {
      platform: this.platformName,
      ...(process.env.AMAZON_Q_VERSION && { ideVersion: process.env.AMAZON_Q_VERSION }),
    };
  }

  getHookInstallInstructions(): string {
    return [
      'Amazon Q Developer CLI Setup:',
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
      '3. Configure Amazon Q CLI hooks so built-in tool calls (fs_read,',
      '   fs_write, execute_bash, etc.) are captured — edit your agent config',
      '   file (~/.aws/amazonq/cli-agents/<agent-name>.json for a global',
      '   agent, or .amazonq/cli-agents/<agent-name>.json for a workspace',
      '   agent) and add:',
      '   {',
      '     "hooks": {',
      '       "preToolUse": [{ "command": "preflight-collector" }],',
      '       "postToolUse": [{ "command": "preflight-collector" }]',
      '     }',
      '   }',
      '   See https://aws.github.io/amazon-q-developer-cli/agent-format.html#hooks-field',
      '   for the full hooks schema.',
      '4. Restart Amazon Q Developer CLI (or start a new `q chat` session).',
      '',
      'Note: Amazon Q hook events carry no session identifier (no session_id',
      'or equivalent field), unlike Claude Code, Kiro, Cursor, or Windsurf.',
      'Concurrent Amazon Q sessions on the same machine share a single',
      'unscoped buffer.',
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
