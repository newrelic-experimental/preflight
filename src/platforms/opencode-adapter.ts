import type {
  NormalizedToolCall,
  PlatformAdapter,
  PlatformConfig,
  PlatformSessionMetadata,
} from './types.js';

/**
 * Maps opencode's built-in tool names (opencode.ai/docs/tools/) to the
 * normalized Claude Code tool vocabulary. `bash`/`read`/`write`/`edit`/
 * `grep`/`glob`/`webfetch`/`websearch` map directly. `apply_patch` collapses
 * to 'Edit' — a single patch can touch multiple files with mixed
 * add/update/delete actions, so there's no clean 1:1 mapping, same
 * precedent as CodexAdapter's apply_patch -> 'Edit'. `skill` maps to 'Skill'
 * (same precedent as ContinueAdapter's read_skill -> 'Skill'). `todowrite`
 * maps to 'TaskCreate' (same precedent as AmazonQAdapter's todo_list ->
 * 'TaskCreate'). `question` maps to 'AskUserQuestion' — opencode's own docs
 * describe it as "Each question includes a header, the question text, and a
 * list of options," matching AskUserQuestion's shape. `lsp` is experimental
 * (gated behind OPENCODE_EXPERIMENTAL_LSP_TOOL) with no confirmed Preflight
 * canonical equivalent and is left unmapped -> falls through to 'Unknown',
 * same treatment as Codex's update_plan.
 */
const OPENCODE_TOOL_MAP: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  apply_patch: 'Edit',
  grep: 'Grep',
  glob: 'Glob',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  skill: 'Skill',
  todowrite: 'TaskCreate',
  question: 'AskUserQuestion',
};

interface OpencodeToolCallEvent {
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

function isOpencodeToolCallEvent(x: unknown): x is OpencodeToolCallEvent {
  return typeof x === 'object' && x !== null;
}

export class OpencodeAdapter implements PlatformAdapter {
  readonly platformName = 'opencode';
  readonly visibilityLevel = 'full-hooks' as const;
  // opencode.ai/docs/rules/: project-level AGENTS.md, with CLAUDE.md as a
  // documented fallback (opencode's own "Claude Code Compatibility" mode).
  readonly capabilities = { instructionFilePaths: ['AGENTS.md'] as const };

  async initialize(_config: PlatformConfig): Promise<void> {
    // opencode's tool-call capture is delivered via a user-installed plugin
    // file (see getHookInstallInstructions()), not configured by this
    // process — same no-op shape as every other full-hooks adapter.
  }

  normalizeToolCall(raw: unknown): NormalizedToolCall {
    const event = isOpencodeToolCallEvent(raw) ? raw : {};
    const platformToolName = event.tool ?? event.toolName ?? 'unknown';
    const toolName = OPENCODE_TOOL_MAP[platformToolName] ?? 'Unknown';
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
    return OPENCODE_TOOL_MAP[platformToolName] ?? 'Unknown';
  }

  getSessionMetadata(): PlatformSessionMetadata {
    return {
      platform: this.platformName,
    };
  }

  getHookInstallInstructions(): string {
    return [
      'opencode Setup:',
      '',
      '1. Register the Preflight MCP server in opencode.json:',
      '   {',
      '     "mcp": {',
      '       "preflight": {',
      '         "type": "local",',
      '         "command": ["npx", "preflight", "--stdio"],',
      '         "environment": {',
      '           "MCP_CLIENT": "opencode",',
      '           "NEW_RELIC_LICENSE_KEY": "<your-key>",',
      '           "NEW_RELIC_ACCOUNT_ID": "<your-account-id>"',
      '         }',
      '       }',
      '     }',
      '   }',
      '2. Ensure preflight-collector is on your PATH (npm link, or npm install -g @newrelic/preflight)',
      '3. Built-in tool calls (bash, read, write, edit, etc.) require a plugin file, since',
      '   opencode has no external hooks.json — it only supports in-process JS/TS plugins.',
      '   Create .opencode/plugins/preflight.js (project) or',
      '   ~/.config/opencode/plugins/preflight.js (global) with:',
      '',
      '   import { spawn } from "node:child_process"',
      '',
      '   const TOOL_MAP = {',
      '     bash: "Bash", read: "Read", write: "Write", edit: "Edit",',
      '     apply_patch: "Edit", grep: "Grep", glob: "Glob",',
      '     webfetch: "WebFetch", websearch: "WebSearch", skill: "Skill",',
      '     todowrite: "TaskCreate", question: "AskUserQuestion",',
      '   }',
      '',
      '   function report(payload) {',
      '     const child = spawn("preflight-collector", [], { stdio: ["pipe", "ignore", "ignore"] })',
      '     child.stdin.write(JSON.stringify(payload))',
      '     child.stdin.end()',
      '   }',
      '',
      '   function toClaudeShape(tool, args) {',
      '     if (tool === "bash") return { command: args.command }',
      '     if (tool === "read" || tool === "edit" || tool === "write") return { file_path: args.filePath }',
      '     return args',
      '   }',
      '',
      '   export const PreflightPlugin = async () => ({',
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
      '4. Restart opencode.',
      '',
      "Known gaps: opencode's hook payload has no success/error field, so every",
      'tool call reports success unconditionally. Only bash/read/edit/write',
      "get structured input metadata; other tools' arg shapes (including apply_patch)",
      'are undocumented and forwarded as-is. No output-side metadata (exit codes,',
      'match counts, etc.) is captured — see docs/ADAPTERS.md for details.',
    ].join('\n');
  }

  isSupported(): boolean {
    return (
      process.env.MCP_CLIENT === 'opencode' || process.env.NEW_RELIC_AI_PLATFORM === 'opencode'
    );
  }
}
