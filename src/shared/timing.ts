// ---------------------------------------------------------------------------
// RequestTimer — high-precision latency measurement for AI SDK calls
//
// Lifecycle invariant:
//   start()
//     → [optional] markThinkingStart() → markThinkingEnd() (one or more pairs)
//     → markFirstToken()              ← first NON-thinking content token
//     → stop()
//
// The timer assumes thinking phases do NOT overlap with content generation.
// All providers we currently wrap (Anthropic extended thinking, Gemini thought
// summaries) emit thinking as one or more discrete blocks before any content
// tokens. Multiple thinking phases are supported via
// repeated markThinkingStart/markThinkingEnd pairs; thinkingDurationMs is the
// sum of the closed phase durations.
//
// Idempotency policy: all event-marking methods are
// first-write-wins. For markThinkingStart/markThinkingEnd "first-write-wins"
// applies WITHIN an open-phase state — once a phase is closed (markThinkingEnd
// has been called), a subsequent markThinkingStart opens a NEW phase rather
// than being treated as a duplicate.
// ---------------------------------------------------------------------------

import { createLogger } from './logger.js';

const timerLogger = createLogger('timing');

export interface ThinkingPhase {
  /** Wall-clock millisecond timestamp the phase began (from `performance.now()`). */
  readonly startAt: number;
  /** Wall-clock millisecond timestamp the phase ended (from `performance.now()`). */
  readonly endAt: number;
  /** `endAt - startAt`. */
  readonly durationMs: number;
}

export interface RequestTimerMetrics {
  /** Wall-clock total duration (ms). */
  readonly durationMs: number;
  /** Time to first NON-thinking content token; null if non-streaming. */
  readonly timeToFirstTokenMs: number | null;
  /**
   * Sum of all closed thinking phase durations (ms); null if no phases were
   * recorded. With a single phase this matches the legacy semantics.
   */
  readonly thinkingDurationMs: number | null;
  /**
   * Closed thinking phases as recorded, in start-order. Empty when no phases
   * were marked. Useful for OTel span emission where each phase becomes its
   * own child span.
   */
  readonly thinkingPhases: readonly ThinkingPhase[];
  /**
   * Duration spent generating output (i.e. wall-clock minus thinking time).
   * Assumes thinking does not overlap with content generation; see file header.
   */
  readonly generationDurationMs: number;
  /** Output tokens / (durationMs / 1000); null if outputTokens not provided. */
  readonly tokensPerSecond: number | null;
  /**
   * Estimated SDK/network overhead — the wall-clock time the request spent
   * outside both thinking and content generation. Algebraically:
   *
   *   overheadMs = TTFT − thinkingDuration
   *              = (firstTokenAt − startAt) − Σ(phase.endAt − phase.startAt)
   *
   * Clamped to ≥ 0. Relies on the non-overlap invariant documented in the
   * file header.
   */
  readonly overheadMs: number;
}

interface OpenPhase {
  startAt: number;
}

interface ClosedPhase {
  startAt: number;
  endAt: number;
}

export class RequestTimer {
  private startAt: number | null = null;
  private stopAt: number | null = null;
  private firstTokenAt: number | null = null;
  /** Phase that has been started but not yet ended. */
  private openPhase: OpenPhase | null = null;
  /** Closed phases in start-order. */
  private closedPhases: ClosedPhase[] = [];

  /** Record the request start time. Idempotent — only the first call takes effect. */
  start(): void {
    if (this.startAt !== null) {
      timerLogger.debug('start() called more than once — ignoring duplicate');
      return;
    }
    this.startAt = performance.now();
  }

  /**
   * Record when the first NON-thinking content token arrives. Idempotent —
   * only the first call takes effect. Must be called after `markThinkingEnd()`
   * if a thinking phase is being tracked; see the file header for the full
   * lifecycle invariant.
   */
  markFirstToken(): void {
    if (this.firstTokenAt === null) {
      this.firstTokenAt = performance.now();
    } else {
      timerLogger.debug('markFirstToken called more than once — ignoring duplicate');
    }
  }

  /**
   * Mark the beginning of a thinking phase.
   *
   * - First call (or first call after `markThinkingEnd`): opens a new phase.
   * - Subsequent call WITHOUT a matching `markThinkingEnd` first: debug log
   *   and ignored — first-write-wins within the open phase.
   *
   * Multiple phases per request are supported; each
   * (start, end) pair appears in `metrics.thinkingPhases`.
   */
  markThinkingStart(): void {
    if (this.openPhase !== null) {
      timerLogger.debug('markThinkingStart called while a phase is open — ignoring duplicate');
      return;
    }
    this.openPhase = { startAt: performance.now() };
  }

  /**
   * Mark the end of the currently open thinking phase.
   *
   * - With an open phase: closes it and appends to the closed-phase list.
   * - With no open phase: debug log and ignored.
   */
  markThinkingEnd(): void {
    if (this.openPhase === null) {
      timerLogger.debug('markThinkingEnd called with no open phase — ignoring');
      return;
    }
    this.closedPhases.push({ startAt: this.openPhase.startAt, endAt: performance.now() });
    this.openPhase = null;
  }

  /** Record the request end time. Idempotent — only the first call takes effect. */
  stop(): void {
    if (this.stopAt !== null) {
      timerLogger.debug('stop() called more than once — ignoring duplicate');
      return;
    }
    this.stopAt = performance.now();
  }

  /**
   * Compute derived timing metrics.
   *
   * **Side effects:** if a thinking phase was started but never ended (e.g. the
   * stream disconnected before `markThinkingEnd()` was called), this method
   * auto-closes the open phase at `stopAt` and writes back `this.closedPhases`
   * and `this.openPhase = null` so subsequent calls see a consistent state.
   * This mutation is intentional — it means `getMetrics()` is safe to
   * call multiple times and will return consistent results after the first call.
   *
   * @param outputTokens — If provided, `tokensPerSecond` is calculated.
   * @throws if `start()` or `stop()` has not been called.
   */
  getMetrics(outputTokens?: number): RequestTimerMetrics {
    if (this.startAt === null) {
      throw new Error('RequestTimer: start() must be called before getMetrics()');
    }
    if (this.stopAt === null) {
      throw new Error('RequestTimer: stop() must be called before getMetrics()');
    }

    const durationMs = this.stopAt - this.startAt;

    // Clamp to 0 so a markFirstToken() call that happens before start() (out of
    // order usage) produces 0 rather than a negative latency.
    const timeToFirstTokenMs =
      this.firstTokenAt !== null ? Math.max(0, this.firstTokenAt - this.startAt) : null;

    // Auto-close any phase that was started but never ended (e.g. stream
    // disconnected during thinking, so markThinkingEnd was never called).
    // Without this, the open phase's wall-clock time is counted inside
    // generationDurationMs instead of thinkingDurationMs.
    let effectiveClosedPhases = this.closedPhases;
    if (this.openPhase !== null) {
      timerLogger.debug('thinking phase still open at getMetrics() — auto-closed at stopAt', {
        openStart: this.openPhase.startAt,
        stopAt: this.stopAt,
      });
      effectiveClosedPhases = [
        ...this.closedPhases,
        { startAt: this.openPhase.startAt, endAt: this.stopAt },
      ];
      // Move the auto-closed phase into closedPhases so subsequent
      // markThinkingEnd() or getMetrics() calls see a consistent state.
      this.closedPhases = effectiveClosedPhases;
      this.openPhase = null;
    }

    const thinkingPhases: readonly ThinkingPhase[] = effectiveClosedPhases.map((p) => ({
      startAt: p.startAt,
      endAt: p.endAt,
      durationMs: p.endAt - p.startAt,
    }));

    const thinkingDurationMs =
      thinkingPhases.length > 0 ? thinkingPhases.reduce((sum, p) => sum + p.durationMs, 0) : null;

    const generationDurationMs = Math.max(0, durationMs - (thinkingDurationMs ?? 0));

    // Align tokensPerSecond semantics with `factory.ts` —
    // return `null` when either the duration is zero or no output tokens were
    // produced, treating both as "no meaningful rate to report". The previous
    // path returned 0 when `outputTokens === 0`, which read downstream as a
    // measured-zero rate rather than a missing measurement.
    //
    // Compute as `(outputTokens / durationMs) * 1000`
    // rather than `outputTokens / (durationMs / 1000)`. The two are
    // mathematically equivalent for non-degenerate inputs but the multiply
    // form preserves precision better when `durationMs` is small (e.g.
    // sub-millisecond synthetic test inputs) — `durationMs / 1000` rounds to
    // a tiny float before the division. Aligns with the formula in
    // `events/factory.ts:tokensPerSecond` so the two paths agree bit-for-bit
    // on identical inputs.
    const tokensPerSecond =
      outputTokens !== undefined && outputTokens > 0 && durationMs > 0
        ? (outputTokens / durationMs) * 1000
        : null;

    const overheadMs = Math.max(0, (timeToFirstTokenMs ?? 0) - (thinkingDurationMs ?? 0));

    return {
      durationMs,
      timeToFirstTokenMs,
      thinkingDurationMs,
      thinkingPhases,
      generationDurationMs,
      tokensPerSecond,
      overheadMs,
    };
  }
}
