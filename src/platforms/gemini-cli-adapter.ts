import type {
  NormalizedToolCall,
  PlatformAdapter,
  PlatformConfig,
  PlatformSessionMetadata,
} from './types.js';

/**
 * Maps Gemini CLI's built-in tool names to the normalized Claude Code tool
 * vocabulary. Source: Gemini CLI's own tool reference docs
 * (github.com/google-gemini/gemini-cli — docs/tools/file-system.md,
 * docs/tools/shell.md, docs/tools/web-search.md, docs/tools/web-fetch.md).
 * `list_directory` has no Claude Code equivalent and is deliberately left
 * unmapped — mapToolName has no pass-through fallback, so an omitted key
 * falls through to 'Unknown' with the original name preserved. There is
 * also no Task/Agent-equivalent subagent-dispatch tool anywhere in Gemini
 * CLI's built-in tool set.
 */
const GEMINI_CLI_TOOL_MAP: Record<string, string> = {
  read_file: 'Read',
  write_file: 'Write',
  replace: 'Edit',
  run_shell_command: 'Bash',
  glob: 'Glob',
  grep_search: 'Grep',
  google_web_search: 'WebSearch',
  web_fetch: 'WebFetch',
};

interface GeminiCliToolCallEvent {
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

function isGeminiCliToolCallEvent(x: unknown): x is GeminiCliToolCallEvent {
  return typeof x === 'object' && x !== null;
}

export class GeminiCliAdapter implements PlatformAdapter {
  readonly platformName = 'gemini-cli';
  readonly visibilityLevel = 'full-hooks' as const;
  readonly capabilities = { instructionFilePaths: ['GEMINI.md'] as const };

  async initialize(_config: PlatformConfig): Promise<void> {
    // Gemini CLI hooks are configured externally (settings.json).
  }

  normalizeToolCall(raw: unknown): NormalizedToolCall {
    const event = isGeminiCliToolCallEvent(raw) ? raw : {};
    const platformToolName = event.tool ?? event.toolName ?? 'unknown';
    const toolName = GEMINI_CLI_TOOL_MAP[platformToolName] ?? 'Unknown';
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
    return GEMINI_CLI_TOOL_MAP[platformToolName] ?? 'Unknown';
  }

  getSessionMetadata(): PlatformSessionMetadata {
    return {
      platform: this.platformName,
    };
  }

  getHookInstallInstructions(): string {
    return [
      'Gemini CLI Setup:',
      '1. Add BeforeTool/AfterTool hooks to settings.json',
      '   (~/.gemini/settings.json user scope, or .gemini/settings.json project scope):',
      '   {',
      '     "hooks": {',
      '       "BeforeTool": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "preflight-collector" }] }],',
      '       "AfterTool": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "preflight-collector" }] }]',
      '     }',
      '   }',
      '2. Ensure preflight-collector is on PATH (npm link, or npm install -g @newrelic/preflight)',
      '3. Register the Preflight MCP server:',
      '   gemini mcp add preflight "npx preflight --stdio" \\',
      '     -e MCP_CLIENT=gemini-cli \\',
      '     -e NEW_RELIC_LICENSE_KEY=<your-key> \\',
      '     -e NEW_RELIC_ACCOUNT_ID=<your-account-id>',
      '4. Restart Gemini CLI',
    ].join('\n');
  }

  isSupported(): boolean {
    return (
      process.env.MCP_CLIENT === 'gemini-cli' || process.env.NEW_RELIC_AI_PLATFORM === 'gemini-cli'
    );
  }
}
