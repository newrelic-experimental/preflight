export interface CostEstimateParams {
  readonly estimateBytes: number;
  readonly reportCount: number;
  /** The session the record belongs to, or null when the hook did not carry one. */
  readonly recordSessionId: string | null;
  /** The session this process currently owns; synthetic (`local-`/`pending-`) until resolved. */
  readonly ownSessionId: string;
}

/**
 * Whether the byte-size cost fallback (`CostTracker.recordEstimatedTokens`)
 * should fire for a given tool call. The fallback covers the handful of calls
 * before a session's first exact token report, so it only makes sense for the
 * session this process owns: `CostTracker` is process-wide and its total is
 * saved as that session's `estimatedCostUsd`, so an estimate for any other
 * session's call (drained by `--local`, or by a provisional `--stdio` engine
 * before its session id resolves) would be persisted under the wrong session.
 *
 * Ownership is decided by identity against the live session id. A provisional
 * engine's own calls drained before adopt carry the real id while the process
 * id is still `pending-`, so they get no estimate and are never replayed; the
 * undercount is bounded to calls before the first token report.
 * See #877.
 */
export function shouldApplyCostEstimate(params: CostEstimateParams): boolean {
  if (params.estimateBytes <= 0) return false;
  if (params.reportCount !== 0) return false;
  return params.recordSessionId === null || params.recordSessionId === params.ownSessionId;
}
