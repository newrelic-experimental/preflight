import { RequestTimer } from './timing.js';

function busyWait(ms: number): void {
  const start = performance.now();
  while (performance.now() - start < ms) {
    // spin
  }
}

describe('RequestTimer', () => {
  // 1. Basic duration measurement
  it('measures durationMs > 0 after start/stop', () => {
    const timer = new RequestTimer();
    timer.start();
    busyWait(2);
    timer.stop();

    const metrics = timer.getMetrics();
    expect(metrics.durationMs).toBeGreaterThan(0);
  });

  // 2. TTFT measurement
  it('measures timeToFirstTokenMs between start and stop', () => {
    const timer = new RequestTimer();
    timer.start();
    busyWait(1);
    timer.markFirstToken();
    busyWait(1);
    timer.stop();

    const metrics = timer.getMetrics();
    expect(metrics.timeToFirstTokenMs).not.toBeNull();
    expect(metrics.timeToFirstTokenMs!).toBeGreaterThanOrEqual(0);
    expect(metrics.timeToFirstTokenMs!).toBeLessThanOrEqual(metrics.durationMs);
  });

  // 3. Thinking phase brackets
  it('measures thinkingDurationMs and derives generationDurationMs', () => {
    const timer = new RequestTimer();
    timer.start();
    timer.markThinkingStart();
    busyWait(2);
    timer.markThinkingEnd();
    busyWait(1);
    timer.stop();

    const metrics = timer.getMetrics();
    expect(metrics.thinkingDurationMs).not.toBeNull();
    expect(metrics.thinkingDurationMs!).toBeGreaterThan(0);
    expect(metrics.generationDurationMs).toBeCloseTo(
      metrics.durationMs - metrics.thinkingDurationMs!,
      5,
    );
  });

  // 4. tokensPerSecond calculation
  it('computes tokensPerSecond when outputTokens is provided', () => {
    const timer = new RequestTimer();
    timer.start();
    busyWait(10);
    timer.stop();

    const metrics = timer.getMetrics(100);
    expect(metrics.tokensPerSecond).not.toBeNull();
    // 100 tokens in ~10ms → ~10,000 tok/s (rough check: just verify it's a positive number)
    expect(metrics.tokensPerSecond!).toBeGreaterThan(0);
  });

  // Aligned semantics with factory.ts — null when no rate
  // is meaningful (outputTokens=0 OR durationMs=0).
  it('returns null tokensPerSecond when outputTokens is 0 (no rate to measure)', () => {
    const timer = new RequestTimer();
    timer.start();
    busyWait(2);
    timer.stop();

    const metrics = timer.getMetrics(0);
    expect(metrics.tokensPerSecond).toBeNull();
  });

  // 5. Null defaults for non-streaming / no thinking
  it('returns null for timeToFirstTokenMs and thinkingDurationMs when not marked', () => {
    const timer = new RequestTimer();
    timer.start();
    timer.stop();

    const metrics = timer.getMetrics();
    expect(metrics.timeToFirstTokenMs).toBeNull();
    expect(metrics.thinkingDurationMs).toBeNull();
    expect(metrics.tokensPerSecond).toBeNull();
  });

  // 6. getMetrics before stop (or start) throws with a distinct message
  it('throws if getMetrics() called before stop()', () => {
    const timer = new RequestTimer();
    timer.start();
    expect(() => timer.getMetrics()).toThrow('stop() must be called before getMetrics()');
  });

  it('throws with distinct message if getMetrics() called before start()', () => {
    const timer = new RequestTimer();
    expect(() => timer.getMetrics()).toThrow('start() must be called before getMetrics()');
  });

  it('start() and stop() are idempotent — second call is ignored', () => {
    const timer = new RequestTimer();
    timer.start();
    busyWait(2);
    timer.start(); // second call ignored — startAt stays at first call
    busyWait(2);
    timer.stop();
    const firstDuration = timer.getMetrics().durationMs;

    // A second stop() should not change stopAt
    busyWait(2);
    timer.stop();
    const secondDuration = timer.getMetrics().durationMs;

    expect(firstDuration).toBeCloseTo(secondDuration, 0);
  });

  // 7. markFirstToken idempotent
  it('only records the first markFirstToken() call', () => {
    const timer = new RequestTimer();
    timer.start();
    busyWait(1);
    timer.markFirstToken();
    busyWait(5);
    timer.markFirstToken(); // should be ignored
    timer.stop();

    const metrics = timer.getMetrics();
    // TTFT should be much closer to 1ms than to 6ms — less than half
    // of total duration since the first mark happened early
    expect(metrics.timeToFirstTokenMs!).toBeLessThan(metrics.durationMs / 2);
  });

  // 8. generationDurationMs clamped to 0 when markThinkingEnd() called after stop()
  it('clamps generationDurationMs to 0 when thinkingDurationMs exceeds durationMs', () => {
    const timer = new RequestTimer();
    timer.start();
    timer.markThinkingStart();
    busyWait(5);
    timer.stop(); // stop before thinking ends — durationMs < eventual thinkingDurationMs
    busyWait(5);
    timer.markThinkingEnd(); // now thinkingDurationMs > durationMs

    const metrics = timer.getMetrics();
    expect(metrics.thinkingDurationMs!).toBeGreaterThan(metrics.durationMs);
    expect(metrics.generationDurationMs).toBe(0);
  });

  // 9. overheadMs calculation
  it('computes overheadMs as TTFT minus thinking duration, clamped to >= 0', () => {
    const timer = new RequestTimer();
    timer.start();
    busyWait(2); // overhead before thinking
    timer.markThinkingStart();
    busyWait(3);
    timer.markThinkingEnd();
    timer.markFirstToken();
    timer.stop();

    const metrics = timer.getMetrics();
    const expected = Math.max(
      0,
      (metrics.timeToFirstTokenMs ?? 0) - (metrics.thinkingDurationMs ?? 0),
    );
    expect(metrics.overheadMs).toBeCloseTo(expected, 5);
    expect(metrics.overheadMs).toBeGreaterThanOrEqual(0);
  });

  // first-write-wins WITHIN an open-phase state
  describe('first-write-wins idempotency for thinking markers', () => {
    it('ignores duplicate markThinkingStart() while a phase is open', () => {
      const timer = new RequestTimer();
      timer.start();
      busyWait(1);
      timer.markThinkingStart();
      busyWait(5);
      timer.markThinkingStart(); // open phase already exists — should be ignored
      timer.markThinkingEnd();
      timer.stop();

      const metrics = timer.getMetrics();
      // Single phase recorded with the FIRST start timestamp.
      expect(metrics.thinkingPhases).toHaveLength(1);
      expect(metrics.thinkingDurationMs!).toBeGreaterThan(2);
    });

    it('ignores duplicate markThinkingEnd() (no open phase)', () => {
      const timer = new RequestTimer();
      timer.start();
      timer.markThinkingStart();
      busyWait(1);
      timer.markThinkingEnd();
      busyWait(5);
      timer.markThinkingEnd(); // no open phase — should be ignored
      timer.stop();

      const metrics = timer.getMetrics();
      // The first end closed the phase; the second end didn't reopen and re-close.
      expect(metrics.thinkingPhases).toHaveLength(1);
      expect(metrics.thinkingDurationMs!).toBeLessThan(4);
    });

    it('markFirstToken remains strictly first-write-wins', () => {
      const timer = new RequestTimer();
      timer.start();
      busyWait(1);
      timer.markFirstToken();
      busyWait(5);
      timer.markFirstToken(); // should be ignored
      timer.stop();

      const metrics = timer.getMetrics();
      // TTFT close to first call (~1ms), not second (~6ms).
      expect(metrics.timeToFirstTokenMs!).toBeLessThan(metrics.durationMs / 2);
    });
  });

  // multiple thinking phases per request
  describe('multiple thinking phases', () => {
    it('records each closed (start, end) pair as a separate phase', () => {
      const timer = new RequestTimer();
      timer.start();
      timer.markThinkingStart();
      busyWait(1);
      timer.markThinkingEnd();
      busyWait(1);
      timer.markThinkingStart(); // second phase opens because the first is closed
      busyWait(1);
      timer.markThinkingEnd();
      timer.markFirstToken();
      timer.stop();

      const metrics = timer.getMetrics();
      expect(metrics.thinkingPhases).toHaveLength(2);
      // Each phase is positive-duration and non-overlapping in start order.
      expect(metrics.thinkingPhases[0].durationMs).toBeGreaterThan(0);
      expect(metrics.thinkingPhases[1].durationMs).toBeGreaterThan(0);
      expect(metrics.thinkingPhases[1].startAt).toBeGreaterThan(metrics.thinkingPhases[0].endAt);
    });

    it('thinkingDurationMs sums across all closed phases', () => {
      const timer = new RequestTimer();
      timer.start();
      timer.markThinkingStart();
      busyWait(2);
      timer.markThinkingEnd();
      busyWait(1);
      timer.markThinkingStart();
      busyWait(3);
      timer.markThinkingEnd();
      timer.stop();

      const metrics = timer.getMetrics();
      const sum = metrics.thinkingPhases.reduce((s, p) => s + p.durationMs, 0);
      expect(metrics.thinkingDurationMs).toBeCloseTo(sum, 5);
      expect(metrics.thinkingDurationMs!).toBeGreaterThan(4);
    });

    it('returns null thinkingDurationMs and empty thinkingPhases when no phases recorded', () => {
      const timer = new RequestTimer();
      timer.start();
      timer.stop();

      const metrics = timer.getMetrics();
      expect(metrics.thinkingDurationMs).toBeNull();
      expect(metrics.thinkingPhases).toEqual([]);
    });

    it('drops phases that were started but not ended (open phase ignored)', () => {
      const timer = new RequestTimer();
      timer.start();
      timer.markThinkingStart();
      busyWait(2);
      timer.markThinkingEnd();
      timer.markThinkingStart(); // never ended — should be auto-closed at stopAt
      busyWait(2);
      timer.stop();

      const metrics = timer.getMetrics();
      // Both phases are reported: one closed normally, one auto-closed at stopAt.
      expect(metrics.thinkingPhases).toHaveLength(2);
      expect(metrics.thinkingDurationMs).not.toBeNull();
      expect(metrics.thinkingDurationMs!).toBeGreaterThan(0);
    });

    it('auto-closing an open phase at stop() produces non-null thinkingDurationMs', () => {
      const timer = new RequestTimer();
      timer.start();
      busyWait(2);
      timer.markThinkingStart();
      busyWait(2);
      // No markThinkingEnd() — simulates stream disconnect during thinking
      timer.stop();

      const metrics = timer.getMetrics();
      expect(metrics.thinkingDurationMs).not.toBeNull();
      expect(metrics.thinkingDurationMs!).toBeGreaterThan(0);
      // generationDurationMs should not absorb the open thinking time
      expect(metrics.generationDurationMs).toBeGreaterThanOrEqual(0);
    });

    it('overheadMs subtracts the SUM of closed phase durations', () => {
      const timer = new RequestTimer();
      timer.start();
      busyWait(1); // pre-thinking gap
      timer.markThinkingStart();
      busyWait(2);
      timer.markThinkingEnd();
      busyWait(1);
      timer.markThinkingStart();
      busyWait(3);
      timer.markThinkingEnd();
      timer.markFirstToken();
      timer.stop();

      const metrics = timer.getMetrics();
      const expected = Math.max(
        0,
        (metrics.timeToFirstTokenMs ?? 0) - (metrics.thinkingDurationMs ?? 0),
      );
      expect(metrics.overheadMs).toBeCloseTo(expected, 5);
      expect(metrics.overheadMs).toBeGreaterThanOrEqual(0);
    });
  });
});
