import type {
  NormalizedToolCall,
  PlatformAdapter,
  PlatformConfig,
  PlatformSessionMetadata,
} from './types.js';

/**
 * Maps Kilo Code's built-in tool names (kilocode.ai/docs/automate/tools,
 * /docs/automate/how-tools-work) to the normalized Claude Code tool
 * vocabulary. Kilo CLI is a confirmed literal fork of opencode ("The Kilo
 * CLI is a fork of OpenCode" — kilocode.ai/docs/code-with-ai/platforms/cli),
 * so its base tool set and mapping precedents mirror OpencodeAdapter's:
 * `read`/`glob`/`grep`/`edit`/`write`/`bash`/`webfetch`/`websearch` map
 * directly. `apply_patch` collapses to 'Edit' (same precedent as
 * CodexAdapter and OpencodeAdapter — a single patch can touch multiple
 * files with mixed add/update/delete actions, no clean 1:1 mapping).
 * `skill` maps to 'Skill' (same precedent as OpencodeAdapter/
 * ContinueAdapter). `question` maps to 'AskUserQuestion' (same precedent as
 * OpencodeAdapter). `todowrite` maps to 'TaskCreate' (same precedent as
 * AmazonQAdapter/OpencodeAdapter). `task` (spawns a sub-agent/child session)
 * maps to 'Agent' — same precedent as Zed/Codex's spawn_agent and
 * Cursor/Droid's Task. `todoread` maps to 'TaskList' and `plan` maps to
 * 'EnterPlanMode' — both are real, pre-existing entries in Preflight's
 * canonical tool vocabulary (see TERMINAL_OUTPUT_TOOLS in
 * src/metrics/tool-selection-scorer.ts) with no adapter-map precedent
 * before this one; chosen by user decision during brainstorming, not
 * invented. `agent_manager` (starts VS-Code-specific Agent Manager
 * local/worktree sessions) has no clean canonical equivalent and is left
 * unmapped -> falls through to 'Unknown', same treatment as opencode's
 * `lsp` and Codex's `update_plan`. Kilo's built-in Playwright MCP server
 * tools (namespaced `kilo-playwright_*`) are not fixed map keys and are not
 * special-cased -> they also fall through to 'Unknown' with the original
 * name preserved, same as any other platform's MCP-server tool calls.
 */
const KILO_CODE_TOOL_MAP: Record<string, string> = {
  read: 'Read',
  glob: 'Glob',
  grep: 'Grep',
  edit: 'Edit',
  write: 'Write',
  apply_patch: 'Edit',
  bash: 'Bash',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  question: 'AskUserQuestion',
  todowrite: 'TaskCreate',
  todoread: 'TaskList',
  plan: 'EnterPlanMode',
  task: 'Agent',
  skill: 'Skill',
};

interface KiloCodeToolCallEvent {
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

function isKiloCodeToolCallEvent(x: unknown): x is KiloCodeToolCallEvent {
  return typeof x === 'object' && x !== null;
}

export class KiloCodeAdapter implements PlatformAdapter {
  readonly platformName = 'kilocode';
  readonly visibilityLevel = 'full-hooks' as const;
  // kilocode.ai/docs/code-with-ai/platforms/cli's Built-in Commands table:
  // `/init` — "Create/update AGENTS.md file for the project." Same
  // convention opencode, Codex, Droid, Cursor, and Gemini CLI already read.
  readonly capabilities = { instructionFilePaths: ['AGENTS.md'] as const };

  async initialize(_config: PlatformConfig): Promise<void> {
    // Kilo Code's tool-call capture is delivered via a user-installed
    // plugin file (see getHookInstallInstructions()), not configured by
    // this process — same no-op shape as every other full-hooks adapter.
  }

  normalizeToolCall(raw: unknown): NormalizedToolCall {
    const event = isKiloCodeToolCallEvent(raw) ? raw : {};
    const platformToolName = event.tool ?? event.toolName ?? 'unknown';
    const toolName = KILO_CODE_TOOL_MAP[platformToolName] ?? 'Unknown';
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
    return KILO_CODE_TOOL_MAP[platformToolName] ?? 'Unknown';
  }

  getSessionMetadata(): PlatformSessionMetadata {
    return {
      platform: this.platformName,
    };
  }

  getHookInstallInstructions(): string {
    return [
      'Kilo Code Setup:',
      '',
      '1. Register the Preflight MCP server in kilo.json:',
      '   {',
      '     "mcp": {',
      '       "preflight": {',
      '         "type": "local",',
      '         "command": ["npx", "preflight", "--stdio"],',
      '         "environment": {',
      '           "MCP_CLIENT": "kilocode",',
      '           "NEW_RELIC_LICENSE_KEY": "<your-key>",',
      '           "NEW_RELIC_ACCOUNT_ID": "<your-account-id>"',
      '         }',
      '       }',
      '     }',
      '   }',
      '2. Ensure preflight-collector is on your PATH (npm link, or npm install -g @newrelic/preflight)',
      '3. Built-in tool calls (read, edit, write, bash, etc.) require a plugin file, since',
      '   Kilo Code has no external hooks.json — it only supports in-process JS/TS plugins',
      '   (Kilo CLI is a fork of opencode and shares this mechanism exactly). Create',
      '   .kilo/plugin/preflight.ts (project) or ~/.config/kilo/plugin/preflight.ts (global) with:',
      '',
      '   import { spawn } from "node:child_process"',
      '   import type { Plugin } from "@kilocode/plugin"',
      '',
      '   const TOOL_MAP: Record<string, string> = {',
      '     read: "Read", glob: "Glob", grep: "Grep", edit: "Edit", write: "Write",',
      '     apply_patch: "Edit", bash: "Bash", webfetch: "WebFetch", websearch: "WebSearch",',
      '     question: "AskUserQuestion", todowrite: "TaskCreate", todoread: "TaskList",',
      '     plan: "EnterPlanMode", task: "Agent", skill: "Skill",',
      '   }',
      '',
      '   function report(payload: unknown) {',
      '     const child = spawn("preflight-collector", [], { stdio: ["pipe", "ignore", "ignore"] })',
      '     child.stdin.write(JSON.stringify(payload))',
      '     child.stdin.end()',
      '   }',
      '',
      '   function toClaudeShape(tool: string, args: any) {',
      '     if (tool === "bash") return { command: args.command }',
      '     if (tool === "read" || tool === "edit" || tool === "write") return { file_path: args.filePath }',
      '     return args',
      '   }',
      '',
      '   const PreflightPlugin: Plugin = async () => ({',
      '     "tool.execute.before": async (input, output) => {',
      '       report({',
      '         hook_event_name: "PreToolUse",',
      '         tool_name: TOOL_MAP[input.tool] ?? "Unknown",',
      '         tool_input: toClaudeShape(input.tool, output.args),',
      '         tool_use_id: input.callID,',
      '         session_id: input.sessionID,',
      '       })',
      '     },',
      '     "tool.execute.after": async (input, output) => {',
      '       report({',
      '         hook_event_name: "PostToolUse",',
      '         tool_name: TOOL_MAP[input.tool] ?? "Unknown",',
      '         tool_use_id: input.callID,',
      '         session_id: input.sessionID,',
      '       })',
      '     },',
      '   })',
      '',
      '   export default { id: "preflight", server: PreflightPlugin }',
      '',
      '4. Restart Kilo Code.',
      '',
      "Known gaps: Kilo's hook payload has no success/error field, so every",
      'tool call reports success unconditionally. Only bash/read/edit/write',
      "get structured input metadata; other tools' arg shapes (including",
      'apply_patch) are undocumented and forwarded as-is. No output-side',
      'metadata (exit codes, match counts, etc.) is captured. kilo-playwright_*',
      "(Kilo's built-in Playwright MCP) tool calls are observable through this",
      'same plugin mechanism but report as Unknown, same as any unrecognized',
      'MCP tool call — see docs/ADAPTERS.md for details.',
    ].join('\n');
  }

  isSupported(): boolean {
    return (
      process.env.MCP_CLIENT === 'kilocode' || process.env.NEW_RELIC_AI_PLATFORM === 'kilocode'
    );
  }
}
