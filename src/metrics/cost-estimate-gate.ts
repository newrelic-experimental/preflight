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
  return isOwnSessionRecord(params.recordSessionId, params.ownSessionId);
}

/**
 * Whether a record belongs to the session this process owns, so its cost may
 * enter the process-wide `CostTracker`. A record with no session id is treated
 * as ours. Applies to exact token events as well as byte estimates: a
 * provisional `--stdio` engine drains every session's buffer before its own id
 * resolves, and would otherwise persist a crashed session's cost as its own.
 */
export function isOwnSessionRecord(recordSessionId: string | null, ownSessionId: string): boolean {
  return recordSessionId === null || recordSessionId === ownSessionId;
}

/**
 * Whether a token event's cost belongs to this process's session rather than
 * only to that session's rollup. A `--stdio` engine persists its process-wide
 * `CostTracker` total as its own session's cost, and stamps its own session id
 * on every `AiTurnCost` it emits, so another session's token event must feed
 * neither. `--local` owns no single session and keeps everything.
 */
export function isTokenEventForThisProcess(params: {
  readonly stdio: boolean;
  readonly eventSessionId: string | null;
  readonly ownSessionId: string;
}): boolean {
  return !params.stdio || isOwnSessionRecord(params.eventSessionId, params.ownSessionId);
}
