import type { HookEvent, PreHookEvent, ToolCallRecord } from '../../storage/types.js';
import { parseToolSpecificFields } from '../../hooks/tool-parsers.js';

function pairKey(sessionId: string, toolUseId: string): string {
  return `${sessionId}:${toolUseId}`;
}

// Reconstructs full-fidelity ToolCallRecord[] from raw buffer-file events —
// the ONLY source that still carries outputSizeBytes for not-yet-persisted
// activity (see the ToolSelectionSummary doc comment in
// src/metrics/tool-selection-scorer.ts for why persisted sessions can't).
// filePath/command aren't on the wire directly (see PreHookEvent/PostHookEvent
// in src/storage/types.ts) — HookEventProcessor derives them in-memory via
// parseToolSpecificFields from the pre event's raw toolInput, which this
// function replicates for pre/post pairs read from ANY process's buffer file
// via LocalStore.peekAllBuffers().
//
// Two passes (collect all `pre` events first, then match `post` events)
// rather than a single left-to-right scan — peekAllBuffers() concatenates
// multiple processes' buffer files in directory-listing order, not
// chronological order, so a post event can appear before its matching pre.
//
// Pairs missing a toolUseId, or with no matching partner, are silently
// skipped — modern collector versions always set toolUseId; this only
// affects very old buffer data from other concurrent processes, a narrow
// and self-correcting gap (it heals itself the moment that process upgrades).
export function pairToolCallsFromBufferEvents(events: readonly HookEvent[]): ToolCallRecord[] {
  const pending = new Map<string, PreHookEvent>();
  for (const event of events) {
    if (event.mode !== 'pre') continue;
    if (!event.sessionId || !event.toolUseId) continue;
    pending.set(pairKey(event.sessionId, event.toolUseId), event);
  }

  const records: ToolCallRecord[] = [];
  for (const event of events) {
    if (event.mode !== 'post') continue;
    if (!event.sessionId || !event.toolUseId) continue;
    const matchedPre = pending.get(pairKey(event.sessionId, event.toolUseId));
    if (!matchedPre) continue;

    const fields = parseToolSpecificFields(event.tool, matchedPre.toolInput, event.toolOutput);

    // PostHookEvent doesn't declare durationMs (see src/storage/types.ts) even
    // though real buffer-file JSON lines carry one at runtime — same duck-typed
    // access api-handler.ts already uses for this exact field.
    const raw = event as unknown as Record<string, unknown>;
    const durationMs = typeof raw.durationMs === 'number' ? raw.durationMs : null;

    records.push({
      id: pairKey(event.sessionId, event.toolUseId),
      sessionId: event.sessionId,
      toolName: event.tool,
      toolUseId: event.toolUseId,
      timestamp: event.timestamp,
      durationMs,
      success: event.success ?? true,
      outputSizeBytes: typeof event.outputSize === 'number' ? event.outputSize : undefined,
      ...fields,
    });
  }
  return records;
}
