import type {
  NormalizedToolCall,
  PlatformAdapter,
  PlatformConfig,
  PlatformSessionMetadata,
} from './types.js';

/**
 * Maps the Copilot agent-host's built-in tool names to Preflight's canonical
 * (Claude-Code-shaped) vocabulary. Source: GitHub's own Copilot hooks
 * reference, "Claude-format matchers (PascalCase PreToolUse)" section
 * (docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference#pretooluse--pretooluse),
 * which documents this exact runtime-tool → Claude-tool-name table.
 *
 * Under the PascalCase `PreToolUse`/`PostToolUse` hook config this adapter's
 * setup instructions require (see getHookInstallInstructions() below), the
 * CLI has ALREADY canonicalized `tool_name` to these Claude-shaped values
 * before Preflight ever sees them (confirmed in the same reference: "Payloads
 * for PascalCase PreToolUse report tool_name as the Claude tool name, for
 * example Bash, not bash"). The canonical-name entries below are therefore
 * the ones that actually get looked up in practice; the lowercase
 * runtime-name entries are kept only as a defensive fallback in case some
 * other Copilot SDK host ever delivers un-canonicalized names.
 *
 * Deliberately unmapped (no Claude equivalent per the same reference table,
 * preserved as the original name downstream): the shell session-management
 * variants (list_bash/read_bash/stop_bash/write_bash and their powershell
 * equivalents — these manage a *background* shell session rather than
 * running a command, unlike bash/powershell itself), list_agents,
 * read_agent, write_agent, skill. This mirrors the VS Code CopilotAdapter's
 * COPILOT_TOOL_MAP precedent of leaving introspection tools unmapped rather
 * than guessing.
 *
 * Exported for reuse by `CopilotAppAdapter`: the GitHub Copilot desktop app
 * runs this exact CLI as a pooled stdio process (empirically verified —
 * macOS, Copilot app v1.1.14, 2026-09-01), so it speaks the identical
 * tool-name vocabulary. One source of truth rather than a forked copy.
 */
export const COPILOT_SDK_TOOL_MAP: Record<string, string> = {
  // Canonical Claude-shaped names, as actually delivered by PascalCase
  // PreToolUse/PostToolUse (identity — see the module doc above).
  Bash: 'Bash',
  Read: 'Read',
  Write: 'Write',
  Edit: 'Edit',
  Grep: 'Grep',
  Glob: 'Glob',
  Agent: 'Agent',
  Task: 'Agent', // GitHub's docs note the literal 'Task' is also accepted.
  WebFetch: 'WebFetch',
  WebSearch: 'WebSearch',
  AskUserQuestion: 'AskUserQuestion',
  TodoWrite: 'TodoWrite',
  // Raw runtime names — defensive fallback only; not expected to be looked
  // up under the documented PascalCase config, which already canonicalizes
  // tool_name before this adapter sees it.
  bash: 'Bash',
  powershell: 'Bash',
  apply_patch: 'Edit',
  create: 'Write',
  edit: 'Edit',
  str_replace_editor: 'Edit',
  view: 'Read',
  task: 'Agent',
  glob: 'Glob',
  grep: 'Grep',
  rg: 'Grep',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  ask_user: 'AskUserQuestion',
  update_todo: 'TodoWrite',
};

interface CopilotSdkToolCallEvent {
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

function isCopilotSdkToolCallEvent(x: unknown): x is CopilotSdkToolCallEvent {
  return typeof x === 'object' && x !== null;
}

/**
 * Adapter for the GitHub Copilot SDK / agent-host runtime — distinct from the
 * VS Code Copilot Chat adapter (`CopilotAdapter`): different session-id space
 * (no `workspaceStorage`; sessions live in `~/.copilot/session-state/<id>/`),
 * and different tool-name vocabulary (`bash`/`edit`/`grep` rather than VS
 * Code's `run_in_terminal`/`replace_string_in_file`). The Copilot CLI is the
 * confirmed host of this runtime; the same SDK extension mechanism plausibly
 * hosts elsewhere (e.g. the desktop app), untested.
 */
export class CopilotSdkAdapter implements PlatformAdapter {
  readonly platformName = 'copilot-sdk';
  // The agent host's hooks fire on every built-in tool call via the same
  // uniform hook envelope collector-script.ts already parses — but only
  // when configured with the PascalCase event names PreToolUse/PostToolUse
  // (see getHookInstallInstructions() below), which deliver the
  // VS-Code-compatible snake_case payload (hook_event_name/tool_name/...)
  // collector-script.ts's uniform branch expects. GitHub's native
  // lowerCamelCase config (preToolUse) is NOT supported here: it emits an
  // incompatible payload shape (sessionId/toolName, no hook_event_name field
  // at all) that the collector's uniform branch can't parse. See
  // docs/ADAPTERS.md's Copilot SDK section.
  readonly visibilityLevel = 'full-hooks' as const;
  // Repo-relative instruction files the host itself reads (Git root and cwd),
  // per GitHub's own "Add custom instructions" guide for Copilot CLI
  // (docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions#custom-instructions-locations),
  // which also lists `CLAUDE.md` and `GEMINI.md` alongside `AGENTS.md` and
  // `.github/copilot-instructions.md`. The same table lists a user-level
  // `$HOME/.copilot/copilot-instructions.md` and a glob-based
  // `.github/instructions/**/*.instructions.md` — neither fits here: every
  // existing adapter's instructionFilePaths entry is a repo-relative exact
  // filename matched against a tool call's filePath (see
  // ClaudeMdTracker.matchesInstructionFile), which supports neither a
  // per-user global path nor a glob pattern.
  readonly capabilities = {
    instructionFilePaths: [
      'AGENTS.md',
      'CLAUDE.md',
      'GEMINI.md',
      '.github/copilot-instructions.md',
    ] as const,
  };

  async initialize(_config: PlatformConfig): Promise<void> {
    // Tool calls arrive via the Copilot agent host's hooks (collector
    // script), parsed by collector-script.ts's uniform branch.
  }

  normalizeToolCall(raw: unknown): NormalizedToolCall {
    const event = isCopilotSdkToolCallEvent(raw) ? raw : {};
    const platformToolName = event.tool ?? event.toolName ?? 'unknown';
    const toolName = COPILOT_SDK_TOOL_MAP[platformToolName] ?? 'Unknown';
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
    return COPILOT_SDK_TOOL_MAP[platformToolName] ?? 'Unknown';
  }

  getSessionMetadata(): PlatformSessionMetadata {
    return {
      platform: this.platformName,
    };
  }

  getHookInstallInstructions(): string {
    return [
      'GitHub Copilot (SDK / agent-host, e.g. the Copilot CLI) Setup:',
      '1. Create a hooks file to enable tool-call capture — user-level',
      '   ~/.copilot/hooks/preflight.json (applies to all sessions) or',
      '   workspace-level .github/hooks/preflight.json:',
      '   {',
      '     "version": 1,',
      '     "hooks": {',
      '       "PreToolUse": [{ "type": "command", "command": "preflight-collector pre-tool" }],',
      '       "PostToolUse": [{ "type": "command", "command": "preflight-collector post-tool" }]',
      '     }',
      '   }',
      '2. Ensure preflight-collector is on PATH (npm link, or npm install -g @newrelic/preflight)',
      '3. Register the Preflight MCP server:',
      '   copilot mcp add preflight \\',
      '     --env MCP_CLIENT=copilot-sdk \\',
      '     --env NEW_RELIC_LICENSE_KEY=<your-key> \\',
      '     --env NEW_RELIC_ACCOUNT_ID=<your-account-id> \\',
      '     -- npx preflight --stdio',
      '4. (Optional, for token-exact cost) Copy the bundled Copilot SDK extension',
      '   to pick up per-call token counts (the hooks above cover tool calls only):',
      '   mkdir -p ~/.copilot/extensions/preflight',
      '   cp <preflight-install-dir>/data/copilot-sdk-extension/extension.mjs \\',
      '     ~/.copilot/extensions/preflight/extension.mjs',
      '5. Restart the host (extensions load at startup) with --experimental',
      '   (or run /experimental on) — extensions require the experimental',
      '   feature flag. If already open, asking Copilot to reload extensions',
      '   or running /clear may also pick up a newly-copied extension.',
    ].join('\n');
  }

  isSupported(): boolean {
    return (
      process.env.MCP_CLIENT === 'copilot-sdk' ||
      process.env.NEW_RELIC_AI_PLATFORM === 'copilot-sdk'
    );
  }
}
