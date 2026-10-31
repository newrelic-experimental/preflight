/**
 * Returns true for session IDs that are MCP-internal synthetic identifiers
 * (not real Claude Code session IDs). These should be hidden from user-facing
 * surfaces such as the dashboard session list and audit trail.
 *
 * Single source of truth, in a module with no imports so the hook collector
 * can use it without loading the session resolver.
 */
export function isSyntheticSessionId(id: string | null | undefined): boolean {
  if (!id) return false;
  return id.startsWith('local-') || id.startsWith('proxy-') || id.startsWith('pending-');
}
