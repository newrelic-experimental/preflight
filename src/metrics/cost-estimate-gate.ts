export interface CostEstimateParams {
  readonly estimateBytes: number;
  readonly reportCount: number;
  readonly sessionId: string | null;
  /** Called only when the answer depends on it: unscoped, and after the cheap early-outs. */
  readonly liveOwnedSessionIds: () => ReadonlySet<string>;
}

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
 *
 * Scope is mutable because a provisional `--stdio` process becomes scoped
 * once its real session id resolves; `markScoped()` is called at the same
 * point the event processor is swapped to the scoped store.
 */
export class CostEstimateGate {
  private unscoped: boolean;

  constructor(unscoped: boolean) {
    this.unscoped = unscoped;
  }

  markScoped(): void {
    this.unscoped = false;
  }

  shouldApply(params: CostEstimateParams): boolean {
    if (params.estimateBytes <= 0) return false;
    if (params.reportCount !== 0) return false;
    if (this.unscoped && params.sessionId !== null) {
      return !params.liveOwnedSessionIds().has(params.sessionId);
    }
    return true;
  }
}
