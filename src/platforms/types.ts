export interface NormalizedToolCall {
  readonly toolName: string;
  readonly platformToolName: string;
  readonly platform: string;
  readonly timestamp: number;
  readonly durationMs: number | null;
  readonly success: boolean;
  readonly error?: string;
  readonly inputSizeBytes?: number;
  readonly outputSizeBytes?: number;
  readonly filePath?: string;
  readonly command?: string;
  readonly sessionId?: string;
  readonly toolUseId?: string;
  readonly inputHash?: string;
}

export interface PlatformConfig {
  readonly platform?: string;
  readonly [key: string]: unknown;
}

export interface PlatformSessionMetadata {
  readonly platform: string;
  readonly model?: string;
  readonly ideVersion?: string;
  readonly extensionVersion?: string;
  readonly [key: string]: unknown;
}

/**
 * How much of a platform's built-in tool activity Preflight can actually see,
 * independent of whether the platform is otherwise "supported":
 * - `full-hooks` — a real hook/callback mechanism fires automatically on every
 *   built-in tool call (Claude Code, Kiro, Amazon Q, Cursor, Windsurf).
 * - `self-reported` — built-in-tool-shaped events are observable in principle,
 *   but only when an external party (a third-party extension, or the calling
 *   MCP client itself) actually reports them; there is no automatic capture
 *   (Copilot, generic-mcp fallback).
 * - `mcp-tools-only` — no hook/callback mechanism exists at all; Preflight can
 *   only see calls made to its own MCP tools, never the platform's built-in
 *   tools (Zed, Continue.dev).
 * See docs/ADAPTERS.md's "Integration mechanisms" table for the per-platform
 * sourcing.
 */
export type PlatformVisibilityLevel = 'full-hooks' | 'self-reported' | 'mcp-tools-only';

/**
 * Per-platform feature capabilities that go beyond the coarse
 * `visibilityLevel` — features that assume a specific platform construct
 * (rather than "hooks vs. no hooks") check these instead of hardcoding
 * Claude Code's own vocabulary.
 */
export interface PlatformCapabilities {
  /**
   * File path(s) or path-fragments this platform's own tooling treats as
   * persistent agent instructions (Preflight calls this "the instruction
   * file" regardless of platform) — e.g. Cursor's `.cursorrules`. Every
   * entry must trace to that platform's own documentation, cited in a
   * comment on the adapter. Leave empty (`[]`) when unconfirmed — do not
   * guess. `ClaudeMdTracker`/`InstructionDriftTracker` always additionally
   * watch `CLAUDE.md`/`.claude/` regardless of this list, so an empty
   * array here does not lose any detection Preflight already has today.
   */
  readonly instructionFilePaths: readonly string[];
}

export interface PlatformAdapter {
  readonly platformName: string;
  readonly visibilityLevel: PlatformVisibilityLevel;
  readonly capabilities: PlatformCapabilities;
  initialize(config: PlatformConfig): Promise<void>;
  normalizeToolCall(raw: unknown): NormalizedToolCall;
  /**
   * Maps a platform's raw tool name (e.g. Kiro's `fs_read`) to Preflight's
   * canonical vocabulary (`Read`). Returns `'Unknown'` for names the adapter
   * doesn't recognize, preserving the platform's original name in telemetry
   * via the caller (never throws).
   */
  mapToolName(platformToolName: string): string;
  getSessionMetadata(): PlatformSessionMetadata;
  getHookInstallInstructions(): string;
  isSupported(): boolean;
}
