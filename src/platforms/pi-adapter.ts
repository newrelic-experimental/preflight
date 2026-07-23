import type {
  NormalizedToolCall,
  PlatformAdapter,
  PlatformConfig,
  PlatformSessionMetadata,
} from './types.js';

/**
 * Maps Pi's built-in tool names (confirmed from the README's CLI Reference —
 * github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md —
 * "Available built-in tools: read, bash, edit, write, grep, find, ls") to the
 * normalized Claude Code tool vocabulary. `bash`/`read`/`write`/`edit`/`grep`
 * map directly. `find` maps to 'Glob' — same precedent as Gemini CLI's
 * `glob` -> 'Glob' (a file-finding tool, even though Pi's own docs don't
 * detail `find`'s exact argument shape). `ls` has no confirmed canonical
 * Preflight tool-name equivalent — listing a directory's contents isn't
 * reading a file's contents — and is deliberately left unmapped -> falls
 * through to 'Unknown', same "leave genuinely uncovered names unmapped"
 * precedent as ZedAdapter's `create_directory`/`move_path`. Only
 * `read`/`write`/`edit`/`bash` are enabled by default; `grep`/`find`/`ls`
 * are real Pi built-ins but require explicit `--tools` enabling to produce
 * any events at all.
 */
const PI_TOOL_MAP: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  grep: 'Grep',
  find: 'Glob',
};

interface PiToolCallEvent {
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

function isPiToolCallEvent(x: unknown): x is PiToolCallEvent {
  return typeof x === 'object' && x !== null;
}

export class PiAdapter implements PlatformAdapter {
  readonly platformName = 'pi';
  readonly visibilityLevel = 'full-hooks' as const;
  // Confirmed via the README's Context Files section: "Pi loads AGENTS.md
  // (or CLAUDE.md) at startup" from global, parent-directory-walk, and cwd
  // locations. Same convention opencode, Codex, Droid, Cursor, and Gemini
  // CLI already read.
  readonly capabilities = { instructionFilePaths: ['AGENTS.md'] as const };

  async initialize(_config: PlatformConfig): Promise<void> {
    // Pi's tool-call capture is delivered via a user-installed extension
    // file (see getHookInstallInstructions()), not configured by this
    // process — same no-op shape as every other full-hooks adapter.
  }

  normalizeToolCall(raw: unknown): NormalizedToolCall {
    const event = isPiToolCallEvent(raw) ? raw : {};
    const platformToolName = event.tool ?? event.toolName ?? 'unknown';
    const toolName = PI_TOOL_MAP[platformToolName] ?? 'Unknown';
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
    return PI_TOOL_MAP[platformToolName] ?? 'Unknown';
  }

  getSessionMetadata(): PlatformSessionMetadata {
    return {
      platform: this.platformName,
    };
  }

  getHookInstallInstructions(): string {
    return [
      'Pi Setup:',
      '',
      'Pi has no MCP client support by design — there is no MCP server',
      'registration step. Preflight instead runs in --local mode, which needs',
      'a persistently running process since nothing spawns one per Pi session.',
      '',
      '1. Run `preflight setup` once to configure NEW_RELIC_LICENSE_KEY and',
      '   NEW_RELIC_ACCOUNT_ID and (on macOS) install the background dashboard',
      '   daemon that keeps a --local process running persistently.',
      '2. On Linux/Windows (no daemon support yet): run `preflight --local &`',
      '   yourself in a persistent terminal/tmux session and keep it running.',
      '3. Ensure preflight-collector is on your PATH (npm link, or npm install -g @newrelic/preflight)',
      '4. Create ~/.pi/agent/extensions/preflight.ts (global) or',
      '   .pi/extensions/preflight.ts (project) with:',
      '',
      '   import { spawn } from "node:child_process"',
      '',
      '   const TOOL_MAP = {',
      '     bash: "Bash", read: "Read", write: "Write", edit: "Edit",',
      '     grep: "Grep", find: "Glob",',
      '   }',
      '',
      '   function report(payload) {',
      '     const child = spawn("preflight-collector", [], { stdio: ["pipe", "ignore", "ignore"] })',
      '     child.stdin.write(JSON.stringify(payload))',
      '     child.stdin.end()',
      '   }',
      '',
      '   export default function (pi) {',
      '     pi.on("tool_call", (event) => {',
      '       report({',
      '         hook_event_name: "PreToolUse",',
      '         tool_name: TOOL_MAP[event.toolName] ?? "Unknown",',
      '         tool_input: event.input,',
      '         tool_use_id: event.toolCallId,',
      '       })',
      '     })',
      '     pi.on("tool_result", (event) => {',
      '       report({',
      '         hook_event_name: "PostToolUse",',
      '         tool_name: TOOL_MAP[event.toolName] ?? "Unknown",',
      '         tool_use_id: event.toolCallId,',
      '         tool_response: { success: !event.isError },',
      '       })',
      '     })',
      '   }',
      '',
      '5. Restart Pi (or run /reload in an active session).',
      '',
      'Known gaps: ls has no confirmed canonical Preflight tool-name',
      'equivalent and reports as Unknown. grep/find/ls are Pi built-ins but',
      'disabled by default — they only produce events in sessions that',
      'explicitly enable them via --tools. event.input is forwarded as-is for',
      "every tool rather than remapped to Claude Code's own field names, so",
      "collector-script.ts's tool-specific input extractors (file_path, etc.)",
      'will not populate for Pi calls. See docs/ADAPTERS.md for details.',
    ].join('\n');
  }

  isSupported(): boolean {
    return process.env.PI_CODING_AGENT === 'true';
  }
}
