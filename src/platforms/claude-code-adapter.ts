import type { ToolCallRecord } from '../storage/types.js';
import type {
  NormalizedToolCall,
  PlatformAdapter,
  PlatformConfig,
  PlatformSessionMetadata,
} from './types.js';

// `CLAUDECODE=1`, `CLAUDE_CODE_ENTRYPOINT`, and `CLAUDE_CODE_SESSION_ID` are
// what current Claude Code actually sets in every child process env (hooks,
// MCP servers) — verified empirically in a live session 2026-08-31;
// `CLAUDE_CODE`/`CLAUDE_CODE_VERSION` kept for older builds. Without these,
// detection falls through to generic-mcp on current versions.
export const CLAUDE_CODE_ENV_SIGNALS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE',
  'CLAUDE_CODE_VERSION',
] as const;

export class ClaudeCodeAdapter implements PlatformAdapter {
  readonly platformName = 'claude-code';
  readonly visibilityLevel = 'full-hooks' as const;
  readonly capabilities = { instructionFilePaths: ['CLAUDE.md', '.claude/'] as const };

  async initialize(_config: PlatformConfig): Promise<void> {
    // No-op — Claude Code hooks are configured externally
  }

  normalizeToolCall(record: ToolCallRecord): NormalizedToolCall {
    return {
      toolName: record.toolName,
      platformToolName: record.toolName,
      platform: this.platformName,
      timestamp: record.timestamp,
      durationMs: record.durationMs,
      success: record.success,
      ...(record.error !== undefined && { error: record.error }),
      ...(record.inputSizeBytes !== undefined && { inputSizeBytes: record.inputSizeBytes }),
      ...(record.outputSizeBytes !== undefined && { outputSizeBytes: record.outputSizeBytes }),
      ...(record.sessionId !== undefined &&
        record.sessionId !== null && { sessionId: record.sessionId }),
      ...(record.toolUseId !== undefined && { toolUseId: record.toolUseId }),
      ...(record.inputHash !== undefined && { inputHash: record.inputHash }),
      ...(typeof record.filePath === 'string' && { filePath: record.filePath }),
      ...(typeof record.command === 'string' && { command: record.command }),
    };
  }

  mapToolName(platformToolName: string): string {
    return platformToolName;
  }

  getSessionMetadata(): PlatformSessionMetadata {
    return {
      platform: this.platformName,
      ...(process.env.CLAUDE_MODEL && { model: process.env.CLAUDE_MODEL }),
      ...(process.env.CLAUDE_CODE_VERSION && { ideVersion: process.env.CLAUDE_CODE_VERSION }),
    };
  }

  getHookInstallInstructions(): string {
    return [
      'Claude Code Hook Setup:',
      '1. Run: npx preflight install',
      '2. This adds PreToolUse/PostToolUse/PermissionRequest/PermissionDenied hooks to ~/.claude/settings.json',
      '3. Restart Claude Code to activate the hooks',
      '4. Add the MCP server to your .mcp.json configuration',
    ].join('\n');
  }

  isSupported(): boolean {
    return (
      CLAUDE_CODE_ENV_SIGNALS.some((key) => process.env[key] !== undefined) ||
      process.env.MCP_CLIENT === 'claude-code'
    );
  }
}
