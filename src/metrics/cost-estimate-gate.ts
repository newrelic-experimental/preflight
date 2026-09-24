/**
 * Whether the byte-size cost fallback (`CostTracker.recordEstimatedTokens`)
 * should fire for a given tool call. The fallback exists so a session with no
 * exact token report yet still has *some* cost signal — but an unscoped
 * process (`--local`, or a provisional `--stdio` window before session ID
 * resolution) drains hook activity for sessions it has no transcript
 * connection to. For those, `reportCount` never leaves 0 from this process's
 * point of view, so the fallback would otherwise fire for the session's
 * entire duration instead of just its first few calls — while the session's
 * real `--stdio` owner is independently reporting accurate cost the whole
 * time. See #723.
 */
export interface CostEstimateGateParams {
  readonly estimateBytes: number;
  readonly reportCount: number;
  readonly isUnscopedSession: boolean;
  readonly sessionId: string | null | undefined;
  readonly liveOwnedSessionIds: ReadonlySet<string>;
}

export function shouldApplyCostEstimate(params: CostEstimateGateParams): boolean {
  if (params.estimateBytes <= 0) return false;
  if (params.reportCount !== 0) return false;
  if (
    params.isUnscopedSession &&
    params.sessionId !== null &&
    params.sessionId !== undefined &&
    params.liveOwnedSessionIds.has(params.sessionId)
  ) {
    return false;
  }
  return true;
}
