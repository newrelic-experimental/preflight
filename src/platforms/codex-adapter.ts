import type {
  NormalizedToolCall,
  PlatformAdapter,
  PlatformConfig,
  PlatformSessionMetadata,
} from './types.js';

/**
 * Maps OpenAI Codex's built-in tool names to the normalized Claude Code tool
 * vocabulary. Source: developers.openai.com/codex/hooks's "Tool coverage"
 * table and PreToolUse/PostToolUse field reference. Codex's own hook
 * payload already reports shell commands and unified-exec (exec_command)
 * calls alike with the canonical literal tool_name "Bash", so no
 * translation is needed there. apply_patch always reports tool_name
 * literally as "apply_patch" (never "Edit" or "Write", even though Codex's
 * own hook *matcher* config lets a user alias-match it as either) — mapped
 * here to 'Edit' as a single collapsed value, since a patch body can touch
 * multiple files with mixed add/update/delete actions and there's no clean
 * 1:1 mapping to Preflight's Read/Write/Edit vocabulary regardless of
 * approach (same precedent as Windsurf's pre_write_code -> 'Edit'). This
 * means Codex's apply_patch calls don't get collector-script.ts's Edit-
 * specific metadata extraction (oldStringLength/newStringLength/etc.),
 * since that switches on the raw tool_name ("apply_patch", not "Edit")
 * before mapToolName() ever runs — the same pre-existing gap Gemini CLI's
 * replace and Droid's Create/Execute/Task calls are already in.
 * spawn_agent's tool_name is confirmed literal (the coverage table's note
 * "spawn_agent also matches Agent" documents Agent as a matcher *alias*,
 * not the payload's actual tool_name value) -> mapped to 'Agent'.
 * update_plan has no confirmed Preflight canonical equivalent and is left
 * unmapped -> falls through to 'Unknown' with the original name preserved.
 * Hosted tools (e.g. WebSearch) are confirmed unobservable by Codex's own
 * hooks and are never reported through this path at all — see Known gaps
 * in docs/ADAPTERS.md.
 */
const CODEX_TOOL_MAP: Record<string, string> = {
  Bash: 'Bash',
  apply_patch: 'Edit',
  spawn_agent: 'Agent',
};

interface CodexToolCallEvent {
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

function isCodexToolCallEvent(x: unknown): x is CodexToolCallEvent {
  return typeof x === 'object' && x !== null;
}

export class CodexAdapter implements PlatformAdapter {
  readonly platformName = 'codex';
  readonly visibilityLevel = 'full-hooks' as const;
  // developers.openai.com/codex/config-file/config-reference's
  // model_instructions_file field: "Replacement for built-in instructions
  // instead of AGENTS.md." Same convention Droid, Cursor, and Gemini CLI
  // also read.
  readonly capabilities = { instructionFilePaths: ['AGENTS.md'] as const };

  async initialize(_config: PlatformConfig): Promise<void> {
    // Codex hooks are configured externally (hooks.json or inline [hooks]
    // tables in config.toml).
  }

  normalizeToolCall(raw: unknown): NormalizedToolCall {
    const event = isCodexToolCallEvent(raw) ? raw : {};
    const platformToolName = event.tool ?? event.toolName ?? 'unknown';
    const toolName = CODEX_TOOL_MAP[platformToolName] ?? 'Unknown';
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
    return CODEX_TOOL_MAP[platformToolName] ?? 'Unknown';
  }

  getSessionMetadata(): PlatformSessionMetadata {
    return {
      platform: this.platformName,
    };
  }

  getHookInstallInstructions(): string {
    return [
      'OpenAI Codex Setup:',
      '',
      '1. Add a PreToolUse/PostToolUse hook pair matching all tools to hooks.json',
      '   (~/.codex/hooks.json user scope, or <repo>/.codex/hooks.json project scope):',
      '   {',
      '     "hooks": {',
      '       "PreToolUse": [',
      '         { "matcher": "*", "hooks": [{ "type": "command", "command": "preflight-collector" }] }',
      '       ],',
      '       "PostToolUse": [',
      '         { "matcher": "*", "hooks": [{ "type": "command", "command": "preflight-collector" }] }',
      '       ]',
      '     }',
      '   }',
      '2. Non-managed hooks require one-time review and trust before they run —',
      '   run `/hooks` in the Codex CLI to review and trust this hook definition.',
      '3. Ensure preflight-collector is on your PATH (npm link, or npm install -g @newrelic/preflight)',
      '4. Register the Preflight MCP server:',
      '   codex mcp add preflight --env MCP_CLIENT=codex \\',
      '     --env NEW_RELIC_LICENSE_KEY=<your-key> \\',
      '     --env NEW_RELIC_ACCOUNT_ID=<your-account-id> \\',
      '     -- npx preflight --stdio',
      '5. Restart Codex',
    ].join('\n');
  }

  isSupported(): boolean {
    return process.env.MCP_CLIENT === 'codex' || process.env.NEW_RELIC_AI_PLATFORM === 'codex';
  }
}
