import type {
  NormalizedToolCall,
  PlatformAdapter,
  PlatformConfig,
  PlatformSessionMetadata,
} from './types.js';

/**
 * Maps Factory Droid's built-in tool names to the normalized Claude Code
 * tool vocabulary. Source: Droid's documented PreToolUse/PostToolUse
 * matchers (https://docs.factory.ai/reference/hooks-reference) — Task,
 * Execute, Glob, Grep, Read, Edit, Create, FetchUrl, WebSearch. Read, Glob,
 * Grep, and Edit already match Preflight's canonical vocabulary exactly and
 * are listed here as explicit identity entries — mapToolName has no
 * pass-through fallback, so an omitted key would incorrectly fall through
 * to 'Unknown'.
 */
const DROID_TOOL_MAP: Record<string, string> = {
  Task: 'Agent',
  Execute: 'Bash',
  Create: 'Write',
  FetchUrl: 'WebFetch',
  WebSearch: 'WebSearch',
  Read: 'Read',
  Glob: 'Glob',
  Grep: 'Grep',
  Edit: 'Edit',
};

interface DroidToolCallEvent {
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

function isDroidToolCallEvent(x: unknown): x is DroidToolCallEvent {
  return typeof x === 'object' && x !== null;
}

export class DroidAdapter implements PlatformAdapter {
  readonly platformName = 'droid';
  readonly visibilityLevel = 'full-hooks' as const;
  readonly capabilities = { instructionFilePaths: ['AGENTS.md'] as const };

  async initialize(_config: PlatformConfig): Promise<void> {
    // Droid hooks are configured externally (hooks.json).
  }

  normalizeToolCall(raw: unknown): NormalizedToolCall {
    const event = isDroidToolCallEvent(raw) ? raw : {};
    const platformToolName = event.tool ?? event.toolName ?? 'unknown';
    const toolName = DROID_TOOL_MAP[platformToolName] ?? 'Unknown';
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
    return DROID_TOOL_MAP[platformToolName] ?? 'Unknown';
  }

  getSessionMetadata(): PlatformSessionMetadata {
    return {
      platform: this.platformName,
    };
  }

  getHookInstallInstructions(): string {
    return [
      'Factory Droid Setup:',
      '1. Add a PreToolUse/PostToolUse hook pair to hooks.json',
      '   (~/.factory/hooks.json user scope, or .factory/hooks.json project scope):',
      '   {',
      '     "hooks": {',
      '       "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "preflight-collector" }] }],',
      '       "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "preflight-collector" }] }]',
      '     }',
      '   }',
      '2. Ensure preflight-collector is on PATH (npm link, or npm install -g @newrelic/preflight)',
      '3. Register the Preflight MCP server:',
      '   droid mcp add preflight "npx preflight --stdio" \\',
      '     --env MCP_CLIENT=droid \\',
      '     --env NEW_RELIC_LICENSE_KEY=<your-key> \\',
      '     --env NEW_RELIC_ACCOUNT_ID=<your-account-id>',
      '4. Restart Droid',
    ].join('\n');
  }

  isSupported(): boolean {
    return process.env.MCP_CLIENT === 'droid' || process.env.NEW_RELIC_AI_PLATFORM === 'droid';
  }
}
