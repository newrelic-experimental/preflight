/**
 * Every registered platform's `platformName`. Import-free so the bundled hook
 * collector can match the engine a hook names without loading any adapter.
 */
export const PLATFORM_NAMES = [
  'claude-code',
  'cursor',
  'windsurf',
  'copilot',
  'copilot-app',
  'copilot-sdk',
  'zed',
  'continue',
  'amazon-q',
  'kiro',
  'droid',
  'gemini-cli',
  'cline',
  'codex',
  'opencode',
  'kilocode',
  'pi',
  'antigravity',
  'generic-mcp',
] as const;
