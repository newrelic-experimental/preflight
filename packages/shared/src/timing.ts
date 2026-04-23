// ---------------------------------------------------------------------------
// RequestTimer — high-precision latency measurement for AI SDK calls
// ---------------------------------------------------------------------------

export interface RequestTimerMetrics {
  /** Wall-clock total duration (ms). */
  durationMs: number;
  /** Time to first content token; null if non-streaming. */
  timeToFirstTokenMs: number | null;
  /** Time spent in thinking phase; null if no thinking detected. */
  thinkingDurationMs: number | null;
  /** Duration minus thinking time. */
  generationDurationMs: number;
  /** Output tokens / (durationMs / 1000); null if outputTokens not provided. */
  tokensPerSecond: number | null;
  /** Estimated SDK/network overhead before generation started. */
  overheadMs: number;
}

export class RequestTimer {
  private startAt: number | null = null;
  private stopAt: number | null = null;
  private firstTokenAt: number | null = null;
  private thinkingStartAt: number | null = null;
  private thinkingEndAt: number | null = null;

  /** Record the request start time. */
  start(): void {
    this.startAt = performance.now();
  }

  /** Record when the first content token arrives (idempotent — only first call takes effect). */
  markFirstToken(): void {
    if (this.firstTokenAt === null) {
      this.firstTokenAt = performance.now();
    }
  }

  /** Mark the beginning of a thinking phase. */
  markThinkingStart(): void {
    this.thinkingStartAt = performance.now();
  }

  /** Mark the end of a thinking phase. */
  markThinkingEnd(): void {
    this.thinkingEndAt = performance.now();
  }

  /** Record the request end time. */
  stop(): void {
    this.stopAt = performance.now();
  }

  /**
   * Compute derived timing metrics.
   *
   * @param outputTokens — If provided, `tokensPerSecond` is calculated.
   * @throws if `stop()` has not been called.
   */
  getMetrics(outputTokens?: number): RequestTimerMetrics {
    if (this.stopAt === null || this.startAt === null) {
      throw new Error('RequestTimer: stop() must be called before getMetrics()');
    }

    const durationMs = this.stopAt - this.startAt;

    const timeToFirstTokenMs =
      this.firstTokenAt !== null ? this.firstTokenAt - this.startAt : null;

    const thinkingDurationMs =
      this.thinkingStartAt !== null && this.thinkingEndAt !== null
        ? this.thinkingEndAt - this.thinkingStartAt
        : null;

    const generationDurationMs = Math.max(0, durationMs - (thinkingDurationMs ?? 0));

    const tokensPerSecond =
      outputTokens !== undefined && durationMs > 0
        ? outputTokens / (durationMs / 1000)
        : null;

    const overheadMs = Math.max(0, (timeToFirstTokenMs ?? 0) - (thinkingDurationMs ?? 0));

    return {
      durationMs,
      timeToFirstTokenMs,
      thinkingDurationMs,
      generationDurationMs,
      tokensPerSecond,
      overheadMs,
    };
  }
}
