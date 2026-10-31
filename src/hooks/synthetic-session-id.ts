/**
 * Returns true for session IDs that are MCP-internal synthetic identifiers
 * (not real Claude Code session IDs). These should be hidden from user-facing
 * surfaces such as the dashboard session list and audit trail.
 */
export function isSyntheticSessionId(id: string | null | undefined): boolean {
  if (!id) return false;
  return id.startsWith('local-') || id.startsWith('proxy-') || id.startsWith('pending-');
}
