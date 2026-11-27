export interface CostEstimateParams {
  readonly estimateBytes: number;
  readonly reportCount: number;
  /** A real report replaced the session's byte estimates, in this process or another writer. */
  readonly estimatesRetracted: boolean;
  /** The session the record belongs to, or null when the hook did not carry one. */
  readonly recordSessionId: string | null;
  /** The session this process currently owns; synthetic (`local-`/`pending-`) until resolved. */
  readonly ownSessionId: string;
}

/**
 * Whether the byte-size cost fallback (`CostTracker.recordEstimatedTokens`)
 * should fire for a given tool call. The fallback covers the handful of calls
 * before a session's first exact token report, which this process drained or
 * another writer of the session saw. It only makes sense for the
 * session this process owns: `CostTracker` is process-wide and its total is
 * saved as that session's `estimatedCostUsd`, so an estimate for any other
 * session's call (drained by `--local`, or by a provisional `--stdio` engine
 * before its session id resolves) would be persisted under the wrong session.
 *
 * Ownership is decided by identity against the live session id.
 * See #877.
 */
export function shouldApplyCostEstimate(params: CostEstimateParams): boolean {
  if (params.estimateBytes <= 0) return false;
  if (params.reportCount !== 0 || params.estimatesRetracted) return false;
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

export function isForThisProcess(params: {
  readonly stdio: boolean;
  readonly sessionId: string | null;
  readonly ownSessionId: string;
}): boolean {
  return !params.stdio || isOwnSessionRecord(params.sessionId, params.ownSessionId);
}
