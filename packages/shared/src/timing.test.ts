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

  // 6. getMetrics before stop throws
  it('throws if getMetrics() called before stop()', () => {
    const timer = new RequestTimer();
    timer.start();

    expect(() => timer.getMetrics()).toThrow('stop() must be called before getMetrics()');
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
});
