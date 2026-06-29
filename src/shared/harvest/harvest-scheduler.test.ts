import { HarvestScheduler } from './harvest-scheduler.js';
import type { HarvestSchedulerOptions } from './harvest-scheduler.js';
import type { TransportResult, NrMetric } from '../transport/types.js';
import type { NrEventData } from '../events/types.js';
import type { OtlpEventBridge } from '../transport/otlp-event-bridge.js';
import type { OtlpTransport } from '../transport/otlp-transport.js';
import { getLogOutput } from '../__test-utils__/log-output.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;

const successResult: TransportResult = { success: true, statusCode: 200, retryCount: 0 };
const failureResult: TransportResult = {
  success: false,
  statusCode: 500,
  retryCount: 3,
  error: 'server error',
};

function makeScheduler(overrides: Partial<HarvestSchedulerOptions> = {}): {
  scheduler: HarvestScheduler;
  sendEventsFn: jest.Mock;
  sendMetricsFn: jest.Mock;
} {
  const sendEventsFn = jest
    .fn<Promise<TransportResult>, unknown[]>()
    .mockResolvedValue(successResult);
  const sendMetricsFn = jest
    .fn<Promise<TransportResult>, unknown[]>()
    .mockResolvedValue(successResult);

  const scheduler = new HarvestScheduler({
    licenseKey: 'testkey123',
    transportOptions: { accountId: '12345' },
    eventHarvestIntervalMs: 5_000,
    metricHarvestIntervalMs: 60_000,
    sendEventsFn,
    sendMetricsFn,
    ...overrides,
  });

  return { scheduler, sendEventsFn, sendMetricsFn };
}

beforeEach(() => {
  jest.useFakeTimers();
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  jest.useRealTimers();
  stderrSpy.mockRestore();
});

describe('HarvestScheduler', () => {
  // ---------------------------------------------------------------------------
  // 0a. stop() flushes even when start() was never called
  // ---------------------------------------------------------------------------
  it('stop() flushes buffered events even when start() was never called', async () => {
    jest.useFakeTimers();
    const sendEventsFn = jest
      .fn<Promise<TransportResult>, unknown[]>()
      .mockResolvedValue(successResult);
    const { scheduler } = makeScheduler({ sendEventsFn });

    scheduler.addEvent({ eventType: 'Test', value: 1 });
    await scheduler.stop();

    expect(sendEventsFn).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  // 0b. Constructor warns when OTLP transport is configured but bridge absent
  // ---------------------------------------------------------------------------
  it('warns at construction when transport=otlp but otlpEventBridge is absent', () => {
    const stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    makeScheduler({ transport: 'otlp' });
    const output = stderrSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(output).toMatch(/otlpEventBridge is not configured/);
    stderrSpy.mockRestore();
  });

  it('does not warn at construction when transport=nr-events-api', () => {
    const stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    makeScheduler({ transport: 'nr-events-api' });
    const output = stderrSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(output).not.toMatch(/not configured/);
    stderrSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // 0. Interval validation
  // ---------------------------------------------------------------------------
  it('throws RangeError when eventHarvestIntervalMs < 100', () => {
    expect(() => makeScheduler({ eventHarvestIntervalMs: 0 }).scheduler).toThrow(RangeError);
    expect(() => makeScheduler({ eventHarvestIntervalMs: 50 }).scheduler).toThrow(RangeError);
    expect(() => makeScheduler({ eventHarvestIntervalMs: NaN }).scheduler).toThrow(RangeError);
  });

  it('throws RangeError when metricHarvestIntervalMs < 100', () => {
    expect(() => makeScheduler({ metricHarvestIntervalMs: 0 }).scheduler).toThrow(RangeError);
    expect(() => makeScheduler({ metricHarvestIntervalMs: 99 }).scheduler).toThrow(RangeError);
  });

  it('accepts eventHarvestIntervalMs and metricHarvestIntervalMs >= 100', () => {
    expect(
      () => makeScheduler({ eventHarvestIntervalMs: 100, metricHarvestIntervalMs: 100 }).scheduler,
    ).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // 1. Events harvest fires at 5s, metrics at 60s
  // ---------------------------------------------------------------------------
  it('fires events harvest at 5s intervals and metrics at 60s', async () => {
    const { scheduler, sendEventsFn, sendMetricsFn } = makeScheduler();

    scheduler.addEvent({ eventType: 'Test', value: 1 });
    scheduler.recordMetric('ai.duration', 100);
    scheduler.start();

    // Advance 5s — events should fire, metrics should not
    await jest.advanceTimersByTimeAsync(5_000);
    expect(sendEventsFn).toHaveBeenCalledTimes(1);
    expect(sendMetricsFn).toHaveBeenCalledTimes(0);

    // Advance to 55s — no new events, so sendEventsFn is not called again
    // but the timer is still firing (just skipping empty buffers)
    await jest.advanceTimersByTimeAsync(50_000);
    expect(sendEventsFn).toHaveBeenCalledTimes(1); // no new data

    // Add event and advance to 60s — both should fire
    scheduler.addEvent({ eventType: 'Test', value: 2 });
    await jest.advanceTimersByTimeAsync(5_000);
    expect(sendEventsFn).toHaveBeenCalledTimes(2);
    expect(sendMetricsFn).toHaveBeenCalledTimes(1);

    await scheduler.stop();
  });

  // ---------------------------------------------------------------------------
  // 2. stop() triggers final flush
  // ---------------------------------------------------------------------------
  it('stop triggers final flush of both buffers', async () => {
    const { scheduler, sendEventsFn, sendMetricsFn } = makeScheduler();

    scheduler.addEvent({ eventType: 'Test', value: 1 });
    scheduler.recordMetric('ai.tokens', 500);
    scheduler.start();

    // Stop immediately — no intervals should have fired yet
    await scheduler.stop();

    // Final flush should have sent both
    expect(sendEventsFn).toHaveBeenCalledTimes(1);
    expect(sendMetricsFn).toHaveBeenCalledTimes(1);

    // Verify the events were sent
    const sentEvents = sendEventsFn.mock.calls[0][0] as NrEventData[];
    expect(sentEvents).toHaveLength(1);
    expect(sentEvents[0].eventType).toBe('Test');

    // Verify metrics were sent (ONE summary metric per bucket)
    const sentMetrics = sendMetricsFn.mock.calls[0][0] as NrMetric[];
    expect(sentMetrics).toHaveLength(1);
    expect(sentMetrics[0].type).toBe('summary');
  });

  // ---------------------------------------------------------------------------
  // 3. Atomic snapshot — events added during send appear in next harvest
  // ---------------------------------------------------------------------------
  it('events added during send are captured in next harvest', async () => {
    let addDuringSend: (() => void) | null = null;

    const sendEventsFn = jest
      .fn<Promise<TransportResult>, unknown[]>()
      .mockImplementation(async () => {
        // Simulate adding an event while the send is in-flight
        if (addDuringSend) {
          addDuringSend();
          addDuringSend = null;
        }
        return successResult;
      });

    const { scheduler } = makeScheduler({ sendEventsFn });

    scheduler.addEvent({ eventType: 'Original', seq: 1 });
    scheduler.addEvent({ eventType: 'Original', seq: 2 });
    scheduler.addEvent({ eventType: 'Original', seq: 3 });

    // On first send, add 2 new events
    addDuringSend = () => {
      scheduler.addEvent({ eventType: 'DuringSend', seq: 10 });
      scheduler.addEvent({ eventType: 'DuringSend', seq: 11 });
    };

    scheduler.start();

    // First harvest at 5s
    await jest.advanceTimersByTimeAsync(5_000);
    expect(sendEventsFn).toHaveBeenCalledTimes(1);

    // First harvest should have received the 3 original events
    const firstBatch = sendEventsFn.mock.calls[0][0] as NrEventData[];
    expect(firstBatch).toHaveLength(3);

    // Second harvest at 10s should pick up the 2 events added during first send
    await jest.advanceTimersByTimeAsync(5_000);
    expect(sendEventsFn).toHaveBeenCalledTimes(2);

    const secondBatch = sendEventsFn.mock.calls[1][0] as NrEventData[];
    expect(secondBatch).toHaveLength(2);
    expect(secondBatch[0].eventType).toBe('DuringSend');

    await scheduler.stop();
  });

  // ---------------------------------------------------------------------------
  // 4. Send failure → re-queued and retried on next harvest
  // ---------------------------------------------------------------------------
  it('re-queues events on send failure and retries on next harvest', async () => {
    const sendEventsFn = jest
      .fn<Promise<TransportResult>, unknown[]>()
      .mockResolvedValueOnce(failureResult)
      .mockResolvedValue(successResult);

    const { scheduler } = makeScheduler({ sendEventsFn });

    scheduler.addEvent({ eventType: 'Test', value: 1 });
    scheduler.start();

    // First harvest — fails, events re-queued
    await jest.advanceTimersByTimeAsync(5_000);
    expect(sendEventsFn).toHaveBeenCalledTimes(1);

    const logOutput = getLogOutput(stderrSpy);
    expect(logOutput).toContain('re-queuing batch for retry');

    // Second harvest — retry succeeds, includes the re-queued event
    await jest.advanceTimersByTimeAsync(5_000);
    expect(sendEventsFn).toHaveBeenCalledTimes(2);
    const retryBatch = sendEventsFn.mock.calls[1][0] as NrEventData[];
    expect(retryBatch).toHaveLength(1);
    expect(retryBatch[0].value).toBe(1);

    await scheduler.stop();
  });

  // ---------------------------------------------------------------------------
  // 5. Re-queued events are combined with new events on retry
  // ---------------------------------------------------------------------------
  it('combines re-queued events with new events on next harvest', async () => {
    const sendEventsFn = jest
      .fn<Promise<TransportResult>, unknown[]>()
      .mockResolvedValueOnce(failureResult)
      .mockResolvedValue(successResult);

    const { scheduler } = makeScheduler({ sendEventsFn });

    scheduler.addEvent({ eventType: 'Original', seq: 1 });
    scheduler.start();

    // First harvest — fails
    await jest.advanceTimersByTimeAsync(5_000);
    expect(sendEventsFn).toHaveBeenCalledTimes(1);

    // Add new event before next harvest
    scheduler.addEvent({ eventType: 'New', seq: 2 });

    // Second harvest — should include both re-queued and new events
    await jest.advanceTimersByTimeAsync(5_000);
    expect(sendEventsFn).toHaveBeenCalledTimes(2);
    const retryBatch = sendEventsFn.mock.calls[1][0] as NrEventData[];
    expect(retryBatch).toHaveLength(2);
    expect(retryBatch[0].seq).toBe(1); // re-queued event first
    expect(retryBatch[1].seq).toBe(2); // new event second

    await scheduler.stop();
  });

  // ---------------------------------------------------------------------------
  // 6. Re-queued events are capped to prevent unbounded growth
  // ---------------------------------------------------------------------------
  it('caps re-queued events to maxEventBufferSize, keeping newest', async () => {
    const sendEventsFn = jest
      .fn<Promise<TransportResult>, unknown[]>()
      .mockResolvedValue(failureResult);

    const { scheduler } = makeScheduler({
      sendEventsFn,
      maxEventBufferSize: 5,
    });

    // Add 5 events (seq 0-4) and fail
    for (let i = 0; i < 5; i++) {
      scheduler.addEvent({ eventType: 'Test', seq: i });
    }
    scheduler.start();

    // First harvest — fails, 5 events re-queued (at capacity)
    await jest.advanceTimersByTimeAsync(5_000);

    // Add 3 newer events (seq 10-12)
    for (let i = 10; i < 13; i++) {
      scheduler.addEvent({ eventType: 'Test', seq: i });
    }

    // Second harvest — 5 retry + 3 new = 8, sent and fails again, capped to 5
    await jest.advanceTimersByTimeAsync(5_000);
    expect(sendEventsFn).toHaveBeenCalledTimes(2);
    const logOutput = getLogOutput(stderrSpy);
    expect(logOutput).toContain('overflow');

    // Third harvest — the retry buffer should contain the 5 newest events.
    // Newest are the 3 fresh (seq 10,11,12) plus the last 2 old retries (seq 3,4).
    // The oldest retries (seq 0,1,2) should have been dropped.
    // We can't swap the fn mid-test, but we can check the 3rd call's batch
    await jest.advanceTimersByTimeAsync(5_000);
    expect(sendEventsFn).toHaveBeenCalledTimes(3);
    const thirdBatch = sendEventsFn.mock.calls[2][0] as Array<NrEventData & { seq: number }>;
    expect(thirdBatch).toHaveLength(5);
    // Should contain seq 3,4,10,11,12 (newest 5) — not seq 0,1,2 (oldest 3)
    const seqs = thirdBatch.map((e) => e.seq);
    expect(seqs).not.toContain(0);
    expect(seqs).not.toContain(1);
    expect(seqs).not.toContain(2);
    expect(seqs).toContain(10);
    expect(seqs).toContain(11);
    expect(seqs).toContain(12);

    await scheduler.stop();
  });

  // ---------------------------------------------------------------------------
  // 7. Metrics are re-queued on send failure and retried
  // ---------------------------------------------------------------------------
  it('re-queues metrics on send failure and retries on next harvest', async () => {
    const sendMetricsFn = jest
      .fn<Promise<TransportResult>, unknown[]>()
      .mockResolvedValueOnce(failureResult)
      .mockResolvedValue(successResult);

    const { scheduler } = makeScheduler({ sendMetricsFn });

    scheduler.recordMetric('ai.duration', 100);
    scheduler.start();

    // First metric harvest at 60s — fails
    await jest.advanceTimersByTimeAsync(60_000);
    expect(sendMetricsFn).toHaveBeenCalledTimes(1);
    const firstBatch = sendMetricsFn.mock.calls[0][0] as NrMetric[];
    expect(firstBatch.length).toBeGreaterThan(0);

    // Second metric harvest at 120s — retry succeeds with re-queued metrics
    await jest.advanceTimersByTimeAsync(60_000);
    expect(sendMetricsFn).toHaveBeenCalledTimes(2);
    const retryBatch = sendMetricsFn.mock.calls[1][0] as NrMetric[];
    expect(retryBatch.length).toBeGreaterThanOrEqual(firstBatch.length);

    await scheduler.stop();
  });

  // ---------------------------------------------------------------------------
  // 8. Re-queued metric snapshots are capped to prevent unbounded growth (B-01)
  // ---------------------------------------------------------------------------
  it('caps re-queued metric snapshots to maxRetryMetricSnapshots (500), keeping newest', async () => {
    // The retry buffer holds pre-explosion bucket snapshots, not the
    // exploded NrMetric[] wire form. The cap is 500 *snapshots* (= 500 unique
    // name+attrs buckets), so to exceed it we record 600 unique metric names.
    // After failure, oldest 100 snapshots are dropped and the newest 500
    // survive into the next harvest.
    //
    // Each surviving snapshot now becomes ONE summary metric on the
    // wire instead of four, so the retry batch length is 500, not 2000.
    //
    // Order-independence: the assertions below use a Set so they
    // don't depend on the order metrics appear in the retry batch. The
    // "newest 500 retained, oldest 100 dropped" guarantee itself depends
    // on insertion order being preserved by `MetricAggregator.harvestSnapshots()`
    // (which iterates a Map — insertion-order in JS) and on the
    // `slice(-cap)` truncation in `requeueNrMetrics` keeping the trailing
    // entries. If a future optimization ever sorts metrics by name on the
    // way out of harvestSnapshots (a reasonable thing to do), this test
    // will still pass on order-independence but the underlying invariant
    // — "drops oldest" — will need to be re-evaluated against the new
    // ordering.
    const sendMetricsFn = jest
      .fn<Promise<TransportResult>, unknown[]>()
      .mockResolvedValue(failureResult);

    const { scheduler } = makeScheduler({ sendMetricsFn });
    scheduler.start();

    // Record 600 unique metric names → 600 snapshots (exceeds snapshot cap of 500)
    for (let i = 0; i < 600; i++) {
      scheduler.recordMetric(`metric.b01.${i}`, i);
    }

    // First harvest at 60s — sends 600 summary metrics, fails, retry buffer
    // is then capped to 500 snapshots.
    await jest.advanceTimersByTimeAsync(60_000);
    expect(sendMetricsFn).toHaveBeenCalledTimes(1);
    const logOutput = getLogOutput(stderrSpy);
    expect(logOutput).toContain('overflow');

    // Second harvest — retry batch is the 500 retained snapshots plus the
    // nr.ai.dropped_metrics self-monitoring metric recorded on overflow.
    await jest.advanceTimersByTimeAsync(60_000);
    expect(sendMetricsFn).toHaveBeenCalledTimes(2);
    const retryBatch = sendMetricsFn.mock.calls[1][0] as Array<{ name: string }>;
    const retryUserMetrics = retryBatch.filter((m) => m.name !== 'nr.ai.dropped_metrics');
    expect(retryUserMetrics).toHaveLength(500);

    // Oldest 100 snapshots (metric.b01.0 – metric.b01.99) should have been
    // dropped; the newest (metric.b01.100 – metric.b01.599) should survive.
    const retryNames = new Set(retryBatch.map((m) => m.name));
    expect(retryNames.has('metric.b01.0')).toBe(false);
    expect(retryNames.has('metric.b01.99')).toBe(false);
    expect(retryNames.has('metric.b01.100')).toBe(true);
    expect(retryNames.has('metric.b01.599')).toBe(true);

    await scheduler.stop();
  });

  // ---------------------------------------------------------------------------
  // 9. Concurrent stop() calls await the same flush (no short-circuit)
  // ---------------------------------------------------------------------------
  it('concurrent stop() calls share the same flush promise', async () => {
    const sendEventsFn = jest
      .fn<Promise<TransportResult>, unknown[]>()
      .mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(successResult), 100)),
      );
    const sendMetricsFn = jest
      .fn<Promise<TransportResult>, unknown[]>()
      .mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(successResult), 100)),
      );

    const { scheduler } = makeScheduler({ sendEventsFn, sendMetricsFn });

    scheduler.addEvent({ eventType: 'Test', value: 1 });
    scheduler.recordMetric('ai.duration', 42);
    scheduler.start();

    // Call stop() twice concurrently (simulates a consumer's signal handler
    // and main-shutdown path both racing to flush)
    const p1 = scheduler.stop();
    const p2 = scheduler.stop();

    // Advance timers to let the mocked send promises resolve
    await jest.advanceTimersByTimeAsync(200);
    await Promise.all([p1, p2]);

    // Final flush should have fired exactly once
    expect(sendEventsFn).toHaveBeenCalledTimes(1);
    expect(sendMetricsFn).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // 9b. stop() awaits in-flight interval harvest before its own final flush
  // ---------------------------------------------------------------------------
  it('stop() awaits in-flight interval harvest before its own final flush', async () => {
    // When an interval-driven harvest is already in flight and
    // stop() is called, stop() must (1) await the in-flight harvest before
    // initiating its own final flush, and (2) ensure events added between
    // the in-flight harvest's snapshot and stop()'s final flush are
    // captured. Without the await, stop()'s call to harvestEvents() would
    // hit the re-entrancy guard, return the existing in-flight promise, and
    // the newly-buffered events would be silently dropped.
    let resolveFirstSend!: () => void;
    const firstSendComplete = new Promise<void>((resolve) => {
      resolveFirstSend = resolve;
    });

    const sendEventsFn = jest
      .fn<Promise<TransportResult>, unknown[]>()
      .mockImplementation(async () => {
        if (sendEventsFn.mock.calls.length === 1) {
          // First call (interval-driven) — block until the test releases us
          await firstSendComplete;
        }
        return successResult;
      });

    const { scheduler } = makeScheduler({ sendEventsFn });

    scheduler.addEvent({ eventType: 'InFlight', seq: 1 });
    scheduler.start();

    // Fire the interval. harvestEvents() begins, sendEventsFn is invoked,
    // and is now parked on firstSendComplete.
    await jest.advanceTimersByTimeAsync(5_000);
    expect(sendEventsFn).toHaveBeenCalledTimes(1);

    // Add an event AFTER the in-flight harvest's buffer snapshot. stop()'s
    // final flush must capture it.
    scheduler.addEvent({ eventType: 'PostInFlight', seq: 2 });

    // Begin stop() without awaiting. It should be parked awaiting the
    // in-flight harvest, which is itself parked on firstSendComplete.
    const stopPromise = scheduler.stop();

    // Drain microtasks without releasing the in-flight send. stop() must
    // not have triggered a second send yet.
    await Promise.resolve();
    await Promise.resolve();
    expect(sendEventsFn).toHaveBeenCalledTimes(1);

    // Release the in-flight send. stop() can now proceed to its own final
    // flush, which should pick up the PostInFlight event.
    resolveFirstSend();
    await stopPromise;

    // Two distinct sends: the in-flight one + stop()'s final flush.
    expect(sendEventsFn).toHaveBeenCalledTimes(2);

    const inFlightBatch = sendEventsFn.mock.calls[0][0] as NrEventData[];
    expect(inFlightBatch).toHaveLength(1);
    expect(inFlightBatch[0].eventType).toBe('InFlight');

    const finalBatch = sendEventsFn.mock.calls[1][0] as NrEventData[];
    expect(finalBatch).toHaveLength(1);
    expect(finalBatch[0].eventType).toBe('PostInFlight');
  });

  // ---------------------------------------------------------------------------
  // 9. Restart+stop flushes data from second session (stopPromise cleared)
  // ---------------------------------------------------------------------------
  it('flushes data from second session after restart', async () => {
    const { scheduler, sendEventsFn, sendMetricsFn } = makeScheduler();

    // First session
    scheduler.addEvent({ eventType: 'Session1', seq: 1 });
    scheduler.recordMetric('ai.duration', 100);
    scheduler.start();
    await scheduler.stop();

    expect(sendEventsFn).toHaveBeenCalledTimes(1);
    expect((sendEventsFn.mock.calls[0][0] as NrEventData[])[0].eventType).toBe('Session1');
    expect(sendMetricsFn).toHaveBeenCalledTimes(1);

    // Second session — start again, add new data, stop
    scheduler.addEvent({ eventType: 'Session2', seq: 2 });
    scheduler.recordMetric('ai.duration', 200);
    scheduler.start();
    await scheduler.stop();

    // Second stop must trigger its own final flush
    expect(sendEventsFn).toHaveBeenCalledTimes(2);
    expect((sendEventsFn.mock.calls[1][0] as NrEventData[])[0].eventType).toBe('Session2');
    expect(sendMetricsFn).toHaveBeenCalledTimes(2);
  });

  // Every per-cycle log line carries a harvestId so
  // operators can pivot on it in stderr to trace one harvest cycle through
  // batch-send, retry, and overflow logs. A future regression that reverts
  // to the module-level `logger` in any of the eight threading points (the
  // four send* helpers + four requeue* helpers) would silently break this
  // contract; this test catches it.
  it('stamps harvestId on retry/requeue log lines', async () => {
    const sendEventsFn = jest
      .fn<Promise<TransportResult>, unknown[]>()
      .mockResolvedValue(failureResult);
    const { scheduler } = makeScheduler({ sendEventsFn });
    scheduler.start();

    scheduler.addEvent({ eventType: 'Test', seq: 1 });

    // Capture the warns from the harvest tick — both "Failed to send" and
    // (eventually) the retry buffer overflow log are scoped under the
    // harvestId.
    stderrSpy.mockClear();
    await jest.advanceTimersByTimeAsync(5_000);

    // Left inline rather than collapsed to
    // `getLogOutput(stderrSpy)` because this test needs the per-frame
    // `string[]` to `.find()` a specific line, then `JSON.parse()` it
    // standalone. The helper returns a joined string, which would
    // require splitting back apart here. Adding a `getLogLines()`
    // sibling helper for one site is more cost than benefit.
    const logLines = stderrSpy.mock.calls.map((c: unknown[]) => c[0] as string);
    const failedSendLog = logLines.find((line: string) =>
      line.includes('Failed to send events to NR'),
    );
    expect(failedSendLog).toBeDefined();

    const parsed = JSON.parse(failedSendLog!);
    expect(parsed.harvestId).toMatch(/^[0-9a-f]{8}$/);
    // Scope is set on the bound child logger, so it appears alongside.
    expect(parsed.scope).toBe('events');

    await scheduler.stop();
  });

  // Scheduler-level boolean return for backpressure.
  // The underlying buffer/aggregator return values are tested in their own
  // suites; these tests pin the contract at the public scheduler surface so
  // a future regression that drops the return-propagation through the
  // wrappers fails CI.
  describe('addEvent / recordMetric boolean return', () => {
    it('addEvent returns true while the buffer has room and false on overflow', () => {
      const { scheduler } = makeScheduler({ maxEventBufferSize: 2 });
      expect(scheduler.addEvent({ eventType: 'T', seq: 1 })).toBe(true);
      expect(scheduler.addEvent({ eventType: 'T', seq: 2 })).toBe(true);
      // Buffer at cap — next add evicts the oldest and returns false.
      expect(scheduler.addEvent({ eventType: 'T', seq: 3 })).toBe(false);
      expect(scheduler.addEvent({ eventType: 'T', seq: 4 })).toBe(false);
    });

    it('recordMetric returns true on accept and false on rejection', () => {
      const { scheduler } = makeScheduler();
      // Valid sample: returns true.
      expect(scheduler.recordMetric('ai.duration', 10, { model: 'claude' })).toBe(true);
      // Non-finite value: returns false (logged as warn by aggregator).
      expect(scheduler.recordMetric('ai.duration', NaN)).toBe(false);
      expect(scheduler.recordMetric('ai.duration', Infinity)).toBe(false);
      // Invalid attribute (non-primitive): returns false.
      expect(
        scheduler.recordMetric('ai.duration', 1, {
          bad: { nested: 'thing' } as unknown as string,
        }),
      ).toBe(false);
    });
  });

  // Self-monitoring: rejected metric samples
  // surface as an `nr.ai.dropped_metrics` summary metric on the next harvest.
  it('emits nr.ai.dropped_metrics when MetricAggregator rejects samples', async () => {
    const { scheduler, sendMetricsFn } = makeScheduler();
    scheduler.start();

    // Mix valid + invalid samples. The invalid ones increment dropCount on
    // the aggregator and should surface as a self-monitoring metric on the
    // next harvest — alongside the valid ai.duration bucket.
    scheduler.recordMetric('ai.duration', 100);
    scheduler.recordMetric('ai.duration', NaN);
    scheduler.recordMetric('ai.duration', Infinity);
    scheduler.recordMetric('ai.duration', 1, {
      bad: { nested: 'thing' } as unknown as string,
    });

    await jest.advanceTimersByTimeAsync(60_000);
    await scheduler.stop();

    // Find the nr.ai.dropped_metrics summary among the harvested metrics.
    const allMetrics = sendMetricsFn.mock.calls.flatMap((c) => c[0] as NrMetric[]);
    const dropped = allMetrics.find((m) => m.name === 'nr.ai.dropped_metrics');
    expect(dropped).toBeDefined();
    if (dropped && dropped.type === 'summary') {
      // 3 rejections (NaN, Infinity, invalid attr) → recorded as a single
      // summary sample of value=3 on the next harvest.
      expect(dropped.value.sum).toBe(3);
      expect(dropped.attributes?.source).toBe('metric_aggregator');
    } else {
      throw new Error('nr.ai.dropped_metrics not emitted as a summary');
    }
  });

  // Listener leak guard for repeated start/stop cycles
  // when `allowProcessExit: true` is in play (the only path that registers
  // a `beforeExit` listener at all). Without this guard, a
  // future regression that forgot to clean up the listener after each stop
  // would silently accumulate one listener per cycle.
  it('does not leak beforeExit listeners across repeated start/stop cycles', async () => {
    const baseline = process.listeners('beforeExit').length;
    const { scheduler } = makeScheduler({ allowProcessExit: true });

    for (let i = 0; i < 5; i++) {
      scheduler.start();
      await scheduler.stop();
    }

    // After 5 start/stop cycles the listener count must equal the baseline.
    expect(process.listeners('beforeExit').length).toBe(baseline);
  });

  // maxRetryEvents and maxRetryMetricSnapshots are
  // independent of maxEventBufferSize.
  describe('decoupled retry caps', () => {
    it('maxRetryEvents defaults to maxEventBufferSize when not set', async () => {
      const sendEventsFn = jest
        .fn<Promise<TransportResult>, unknown[]>()
        .mockResolvedValue(failureResult);
      const { scheduler } = makeScheduler({ sendEventsFn, maxEventBufferSize: 50 });
      scheduler.start();

      // Generate 60 events — first harvest sends 50 (buffer cap), retry
      // buffer caps to 50 (default = maxEventBufferSize), 0 dropped beyond.
      for (let i = 0; i < 60; i++) {
        scheduler.addEvent({ eventType: 'Test', seq: i });
      }
      await jest.advanceTimersByTimeAsync(5_000);
      // Drain remaining: retry buffer is full, second harvest should
      // re-attempt the same 50.
      await jest.advanceTimersByTimeAsync(5_000);
      const secondCall = sendEventsFn.mock.calls[1][0] as NrEventData[];
      expect(secondCall.length).toBeLessThanOrEqual(50);
      await scheduler.stop();
    });

    it('maxRetryEvents can be set independently of maxEventBufferSize', async () => {
      const sendEventsFn = jest
        .fn<Promise<TransportResult>, unknown[]>()
        .mockResolvedValue(failureResult);
      const { scheduler } = makeScheduler({
        sendEventsFn,
        maxEventBufferSize: 10,
        maxRetryEvents: 100, // Allow much deeper retry backlog
      });
      scheduler.start();

      // Push events through ten failing harvests; each harvest moves up to
      // 10 events into retry. Decoupled cap means retry can grow above 10.
      for (let cycle = 0; cycle < 5; cycle++) {
        for (let i = 0; i < 10; i++) {
          scheduler.addEvent({ eventType: 'T', seq: cycle * 10 + i });
        }
        await jest.advanceTimersByTimeAsync(5_000);
      }
      // Final retry batch should contain >10 events (proving retry grew
      // beyond the primary buffer cap).
      const lastCall = sendEventsFn.mock.calls[
        sendEventsFn.mock.calls.length - 1
      ][0] as NrEventData[];
      expect(lastCall.length).toBeGreaterThan(10);
      expect(lastCall.length).toBeLessThanOrEqual(100);
      await scheduler.stop();
    });

    it('maxRetryMetricSnapshots can be set independently of the 500 default', async () => {
      const sendMetricsFn = jest
        .fn<Promise<TransportResult>, unknown[]>()
        .mockResolvedValue(failureResult);
      const { scheduler } = makeScheduler({
        sendMetricsFn,
        maxRetryMetricSnapshots: 50, // tighter cap for the test
      });
      scheduler.start();

      // 100 unique metric names → 100 snapshots; cap of 50 means oldest 50
      // are dropped, newest 50 retained.
      for (let i = 0; i < 100; i++) {
        scheduler.recordMetric(`metric.r421.${i}`, i);
      }
      await jest.advanceTimersByTimeAsync(60_000);
      await jest.advanceTimersByTimeAsync(60_000);
      const retryBatch = sendMetricsFn.mock.calls[1][0] as Array<{ name: string }>;
      // Filter out nr.ai.dropped_metrics self-monitoring metric
      const userMetrics = retryBatch.filter((m) => m.name !== 'nr.ai.dropped_metrics');
      expect(userMetrics).toHaveLength(50);
      const names = new Set(retryBatch.map((m) => m.name));
      expect(names.has('metric.r421.0')).toBe(false);
      expect(names.has('metric.r421.99')).toBe(true);
      await scheduler.stop();
    });
  });

  // start() refuses while a previous stop() is in flight
  it('start() during in-flight stop() is refused with a warn', async () => {
    const sendEventsFn = jest
      .fn<Promise<TransportResult>, unknown[]>()
      .mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(successResult), 100)),
      );
    const sendMetricsFn = jest
      .fn<Promise<TransportResult>, unknown[]>()
      .mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(successResult), 100)),
      );

    const { scheduler } = makeScheduler({ sendEventsFn, sendMetricsFn });

    scheduler.addEvent({ eventType: 'Test', seq: 1 });
    scheduler.start();

    // Initiate stop but do NOT await yet — stopPromise is non-null, running is false.
    const stopP = scheduler.stop();

    // Try to start while stop is in flight — should be refused with a warn.
    scheduler.start();
    const logOutput = getLogOutput(stderrSpy);
    expect(logOutput).toContain('start() called while a previous stop() is in flight');

    // Allow the stop to finish.
    await jest.advanceTimersByTimeAsync(200);
    await stopP;

    // After stop has resolved, stopPromise was cleared via the .finally hook,
    // so a fresh start() now succeeds.
    scheduler.addEvent({ eventType: 'Test', seq: 2 });
    scheduler.start();
    const secondStop = scheduler.stop();
    await jest.advanceTimersByTimeAsync(200);
    await secondStop;
    // Two sends total: one from the original start/stop + one from the
    // post-resolution restart. (The refused start in between produced no send.)
    expect(sendEventsFn).toHaveBeenCalledTimes(2);
  });

  // ---------------------------------------------------------------------------
  // 10. Events re-queued on thrown exception
  // ---------------------------------------------------------------------------
  it('re-queues events when sendEventsFn throws', async () => {
    const sendEventsFn = jest
      .fn<Promise<TransportResult>, unknown[]>()
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockResolvedValue(successResult);

    const { scheduler } = makeScheduler({ sendEventsFn });

    scheduler.addEvent({ eventType: 'Test', value: 1 });
    scheduler.start();

    // First harvest — throws, events re-queued
    await jest.advanceTimersByTimeAsync(5_000);
    expect(sendEventsFn).toHaveBeenCalledTimes(1);

    // Second harvest — retry succeeds
    await jest.advanceTimersByTimeAsync(5_000);
    expect(sendEventsFn).toHaveBeenCalledTimes(2);
    const retryBatch = sendEventsFn.mock.calls[1][0] as NrEventData[];
    expect(retryBatch).toHaveLength(1);
    expect(retryBatch[0].value).toBe(1);

    await scheduler.stop();
  });

  // ---------------------------------------------------------------------------
  // 11. OTLP routing — 'otlp' mode calls otlpEventBridge.sendEvents, not NR API
  // ---------------------------------------------------------------------------
  it("transport: 'otlp' routes events to otlpEventBridge.sendEvents, not NR API", async () => {
    const sendEventsFn = jest
      .fn<Promise<TransportResult>, unknown[]>()
      .mockResolvedValue(successResult);
    const otlpEventBridgeSendFn = jest.fn<void, [NrEventData[]]>();
    const otlpEventBridge = {
      sendEvents: otlpEventBridgeSendFn,
      flush: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
    } as unknown as OtlpEventBridge;

    const { scheduler } = makeScheduler({
      sendEventsFn,
      otlpEventBridge,
      transport: 'otlp',
    });

    scheduler.addEvent({ eventType: 'Test', value: 1 });
    scheduler.start();

    // Advance to first harvest at 5s
    await jest.advanceTimersByTimeAsync(5_000);

    // NR sendEventsFn should NOT have been called
    expect(sendEventsFn).not.toHaveBeenCalled();

    // OTLP bridge's sendEvents should have been called once
    expect(otlpEventBridgeSendFn).toHaveBeenCalledTimes(1);
    const sentEvents = otlpEventBridgeSendFn.mock.calls[0][0] as NrEventData[];
    expect(sentEvents).toHaveLength(1);
    expect(sentEvents[0].eventType).toBe('Test');

    await scheduler.stop();
  });

  // ---------------------------------------------------------------------------
  // 12. OTLP routing — 'otlp' mode calls otlpTransport.exportMetrics, not NR API
  // ---------------------------------------------------------------------------
  it("transport: 'otlp' routes metrics to otlpTransport.exportMetrics, not NR API", async () => {
    const sendMetricsFn = jest
      .fn<Promise<TransportResult>, unknown[]>()
      .mockResolvedValue(successResult);
    const otlpTransportExportFn = jest.fn<Promise<void>, [NrMetric[]]>();
    const otlpTransport = {
      exportMetrics: otlpTransportExportFn,
      flush: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
      getTracer: jest.fn(),
      getMeter: jest.fn(),
    } as unknown as OtlpTransport;

    const { scheduler } = makeScheduler({
      sendMetricsFn,
      otlpTransport,
      transport: 'otlp',
    });

    scheduler.recordMetric('ai.duration', 100);
    scheduler.start();

    // Advance to first metric harvest at 60s
    await jest.advanceTimersByTimeAsync(60_000);

    // NR sendMetricsFn should NOT have been called
    expect(sendMetricsFn).not.toHaveBeenCalled();

    // OTLP transport's exportMetrics should have been called once
    expect(otlpTransportExportFn).toHaveBeenCalledTimes(1);
    const sentMetrics = otlpTransportExportFn.mock.calls[0][0] as NrMetric[];
    expect(sentMetrics.length).toBeGreaterThan(0);

    await scheduler.stop();
  });

  // ---------------------------------------------------------------------------
  // 13. OTLP routing — 'both' mode calls both NR API and OTLP concurrently
  // ---------------------------------------------------------------------------
  it("transport: 'both' calls both NR API and OTLP concurrently for events", async () => {
    const sendEventsFn = jest
      .fn<Promise<TransportResult>, unknown[]>()
      .mockResolvedValue(successResult);
    const otlpEventBridgeSendFn = jest.fn<void, [NrEventData[]]>();
    const otlpEventBridge = {
      sendEvents: otlpEventBridgeSendFn,
      flush: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
    } as unknown as OtlpEventBridge;

    const { scheduler } = makeScheduler({
      sendEventsFn,
      otlpEventBridge,
      transport: 'both',
    });

    scheduler.addEvent({ eventType: 'Test', value: 1 });
    scheduler.start();

    // Advance to first harvest at 5s
    await jest.advanceTimersByTimeAsync(5_000);

    // Both NR and OTLP should have been called
    expect(sendEventsFn).toHaveBeenCalledTimes(1);
    expect(otlpEventBridgeSendFn).toHaveBeenCalledTimes(1);

    // Both should receive the same events
    const nrEvents = sendEventsFn.mock.calls[0][0] as NrEventData[];
    const otlpEvents = otlpEventBridgeSendFn.mock.calls[0][0] as NrEventData[];
    expect(nrEvents).toHaveLength(1);
    expect(otlpEvents).toHaveLength(1);
    expect(nrEvents[0].eventType).toBe('Test');
    expect(otlpEvents[0].eventType).toBe('Test');

    await scheduler.stop();
  });

  // ---------------------------------------------------------------------------
  // 14. OTLP routing — 'both' mode calls both NR API and OTLP for metrics
  // ---------------------------------------------------------------------------
  it("transport: 'both' calls both NR API and OTLP concurrently for metrics", async () => {
    const sendMetricsFn = jest
      .fn<Promise<TransportResult>, unknown[]>()
      .mockResolvedValue(successResult);
    const otlpTransportExportFn = jest.fn<Promise<void>, [NrMetric[]]>();
    const otlpTransport = {
      exportMetrics: otlpTransportExportFn,
      flush: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
      getTracer: jest.fn(),
      getMeter: jest.fn(),
    } as unknown as OtlpTransport;

    const { scheduler } = makeScheduler({
      sendMetricsFn,
      otlpTransport,
      transport: 'both',
    });

    scheduler.recordMetric('ai.duration', 100);
    scheduler.start();

    // Advance to first metric harvest at 60s
    await jest.advanceTimersByTimeAsync(60_000);

    // Both NR and OTLP should have been called
    expect(sendMetricsFn).toHaveBeenCalledTimes(1);
    expect(otlpTransportExportFn).toHaveBeenCalledTimes(1);

    // Both should receive metrics
    const nrMetrics = sendMetricsFn.mock.calls[0][0] as NrMetric[];
    const otlpMetrics = otlpTransportExportFn.mock.calls[0][0] as NrMetric[];
    expect(nrMetrics.length).toBeGreaterThan(0);
    expect(otlpMetrics.length).toBeGreaterThan(0);

    await scheduler.stop();
  });

  // ---------------------------------------------------------------------------
  // 14b. 'both' mode must not duplicate to OTLP
  //      when only NR fails. Per-transport retry buffers ensure that the
  //      OTLP-bound batch isn't re-sent on the next harvest just because
  //      the NR-bound batch needs retry.
  // ---------------------------------------------------------------------------
  it("'both' mode does not duplicate to OTLP when only NR send fails", async () => {
    const sendEventsFn = jest
      .fn<Promise<TransportResult>, unknown[]>()
      .mockResolvedValueOnce(failureResult) // NR fails first attempt
      .mockResolvedValue(successResult); // NR succeeds on retry

    const otlpEventBridgeSendFn = jest.fn<void, [NrEventData[]]>();
    const otlpEventBridge = {
      sendEvents: otlpEventBridgeSendFn,
      flush: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
    } as unknown as OtlpEventBridge;

    const { scheduler } = makeScheduler({
      sendEventsFn,
      otlpEventBridge,
      transport: 'both',
    });

    scheduler.addEvent({ eventType: 'Test', value: 1 });
    scheduler.start();

    // First harvest: NR fails, OTLP succeeds. NR batch requeued; OTLP batch is not.
    await jest.advanceTimersByTimeAsync(5_000);
    expect(sendEventsFn).toHaveBeenCalledTimes(1);
    expect(otlpEventBridgeSendFn).toHaveBeenCalledTimes(1);

    // Second harvest: NR retries with the requeued batch; OTLP must NOT be
    // called again with the same data (which would duplicate it on OTLP).
    await jest.advanceTimersByTimeAsync(5_000);
    expect(sendEventsFn).toHaveBeenCalledTimes(2);
    expect(otlpEventBridgeSendFn).toHaveBeenCalledTimes(1); // <- still 1, not 2

    await scheduler.stop();
  });

  // ---------------------------------------------------------------------------
  // 14c. Symmetric of 14b: 'both' mode does not re-send to NR when only OTLP fails
  // ---------------------------------------------------------------------------
  it("'both' mode does not re-send to NR when only OTLP send fails", async () => {
    const sendEventsFn = jest
      .fn<Promise<TransportResult>, unknown[]>()
      .mockResolvedValue(successResult);

    const otlpEventBridgeSendFn = jest
      .fn<void, [NrEventData[]]>()
      .mockImplementationOnce(() => {
        throw new Error('OTLP bridge error');
      }) // OTLP fails first attempt
      .mockImplementation(() => {}); // OTLP succeeds on retry

    const otlpEventBridge = {
      sendEvents: otlpEventBridgeSendFn,
      flush: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
    } as unknown as OtlpEventBridge;

    const { scheduler } = makeScheduler({
      sendEventsFn,
      otlpEventBridge,
      transport: 'both',
    });

    scheduler.addEvent({ eventType: 'Test', value: 1 });
    scheduler.start();

    // First harvest: NR succeeds, OTLP fails. OTLP batch requeued; NR must NOT be called again.
    await jest.advanceTimersByTimeAsync(5_000);
    expect(sendEventsFn).toHaveBeenCalledTimes(1);
    expect(otlpEventBridgeSendFn).toHaveBeenCalledTimes(1);

    // Second harvest: OTLP retries with the requeued batch; NR must NOT be
    // called again with the same data (which would duplicate it on NR).
    await jest.advanceTimersByTimeAsync(5_000);
    expect(sendEventsFn).toHaveBeenCalledTimes(1); // <- still 1, not 2
    expect(otlpEventBridgeSendFn).toHaveBeenCalledTimes(2); // OTLP retried

    await scheduler.stop();
  });

  // ---------------------------------------------------------------------------
  // 15. Default transport mode is 'nr-events-api'
  // ---------------------------------------------------------------------------
  it("default transport mode is 'nr-events-api'", async () => {
    const sendEventsFn = jest
      .fn<Promise<TransportResult>, unknown[]>()
      .mockResolvedValue(successResult);
    const otlpEventBridgeSendFn = jest.fn<void, [NrEventData[]]>();
    const otlpEventBridge = {
      sendEvents: otlpEventBridgeSendFn,
      flush: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
    } as unknown as OtlpEventBridge;

    // Don't specify transport — should default to 'nr-events-api'
    const { scheduler } = makeScheduler({
      sendEventsFn,
      otlpEventBridge,
      // transport not specified
    });

    scheduler.addEvent({ eventType: 'Test', value: 1 });
    scheduler.start();

    // Advance to first harvest at 5s
    await jest.advanceTimersByTimeAsync(5_000);

    // NR API should be called (default behavior)
    expect(sendEventsFn).toHaveBeenCalledTimes(1);

    // OTLP bridge should NOT be called (default mode doesn't use it)
    expect(otlpEventBridgeSendFn).not.toHaveBeenCalled();

    await scheduler.stop();
  });

  // ---------------------------------------------------------------------------
  // Process-exit semantics
  // ---------------------------------------------------------------------------
  describe('process exit', () => {
    it('does NOT unref intervals by default (consumer must await stop())', async () => {
      const { scheduler } = makeScheduler();
      scheduler.start();

      const eventInterval = (
        scheduler as unknown as {
          eventIntervalId: NodeJS.Timeout;
        }
      ).eventIntervalId;
      const metricInterval = (
        scheduler as unknown as {
          metricIntervalId: NodeJS.Timeout;
        }
      ).metricIntervalId;

      // hasRef() returns true → interval keeps the event loop alive until
      // explicitly cleared. This is the safe default; if a consumer forgets
      // to await stop(), the process won't quit (which is correct — silently
      // dropping buffered events on exit is worse).
      expect(eventInterval.hasRef()).toBe(true);
      expect(metricInterval.hasRef()).toBe(true);

      await scheduler.stop();
    });

    it('does NOT register beforeExit listener by default', async () => {
      const onceSpy = jest.spyOn(process, 'once');
      const { scheduler } = makeScheduler();
      scheduler.start();

      const beforeExitCalls = onceSpy.mock.calls.filter(([event]) => event === 'beforeExit');
      expect(beforeExitCalls).toHaveLength(0);

      onceSpy.mockRestore();
      await scheduler.stop();
    });

    it('unrefs intervals when allowProcessExit: true', async () => {
      const { scheduler } = makeScheduler({ allowProcessExit: true });
      scheduler.start();

      const eventInterval = (
        scheduler as unknown as {
          eventIntervalId: NodeJS.Timeout;
        }
      ).eventIntervalId;
      const metricInterval = (
        scheduler as unknown as {
          metricIntervalId: NodeJS.Timeout;
        }
      ).metricIntervalId;

      expect(eventInterval.hasRef()).toBe(false);
      expect(metricInterval.hasRef()).toBe(false);

      await scheduler.stop();
    });

    it('registers and removes beforeExit listener when allowProcessExit: true', async () => {
      const onceSpy = jest.spyOn(process, 'once');
      const removeSpy = jest.spyOn(process, 'removeListener');

      const { scheduler } = makeScheduler({ allowProcessExit: true });
      scheduler.start();

      const beforeExitOnce = onceSpy.mock.calls.filter(([event]) => event === 'beforeExit');
      expect(beforeExitOnce).toHaveLength(1);

      await scheduler.stop();

      const beforeExitRemove = removeSpy.mock.calls.filter(([event]) => event === 'beforeExit');
      expect(beforeExitRemove).toHaveLength(1);

      onceSpy.mockRestore();
      removeSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------
  // OTLP_BAD_REQUEST is dropped, not requeued
  // ---------------------------------------------------------------------------
  describe('OTLP_BAD_REQUEST non-retryable handling', () => {
    it('drops OTLP metric batch on OTLP_BAD_REQUEST and does not requeue', async () => {
      const badRequestError = Object.assign(new Error('bad request'), {
        code: 'OTLP_BAD_REQUEST',
      });
      const otlpExportFn = jest
        .fn<Promise<void>, [NrMetric[]]>()
        .mockRejectedValue(badRequestError);
      const otlpTransport = {
        exportMetrics: otlpExportFn,
        flush: jest.fn().mockResolvedValue(undefined),
        shutdown: jest.fn().mockResolvedValue(undefined),
      } as unknown as OtlpTransport;

      const { scheduler } = makeScheduler({
        transport: 'otlp',
        otlpTransport,
        metricHarvestIntervalMs: 60_000,
      });

      scheduler.recordMetric('test.metric', 42);
      scheduler.start();

      // First metric harvest at 60s — exportMetrics throws OTLP_BAD_REQUEST
      await jest.advanceTimersByTimeAsync(60_000);
      expect(otlpExportFn).toHaveBeenCalledTimes(1);
      const logAfterFirst = getLogOutput(stderrSpy);
      expect(logAfterFirst).toContain('OTLP metric export rejected (bad request)');

      // Second metric harvest at 120s — no fresh data AND retry buffer should
      // be empty (batch was dropped, not requeued). exportMetrics must NOT be
      // called again.
      stderrSpy.mockClear();
      await jest.advanceTimersByTimeAsync(60_000);
      expect(otlpExportFn).toHaveBeenCalledTimes(1); // no second attempt

      await scheduler.stop();
    });

    it('requeues OTLP metric batch on generic errors (non-BAD_REQUEST)', async () => {
      const networkError = new Error('connection refused');
      const otlpExportFn = jest
        .fn<Promise<void>, [NrMetric[]]>()
        .mockRejectedValueOnce(networkError)
        .mockResolvedValue(undefined);
      const otlpTransport = {
        exportMetrics: otlpExportFn,
        flush: jest.fn().mockResolvedValue(undefined),
        shutdown: jest.fn().mockResolvedValue(undefined),
      } as unknown as OtlpTransport;

      const { scheduler } = makeScheduler({
        transport: 'otlp',
        otlpTransport,
        metricHarvestIntervalMs: 60_000,
      });

      scheduler.recordMetric('test.metric', 1);
      scheduler.start();

      // First harvest fails with a generic network error — should requeue
      await jest.advanceTimersByTimeAsync(60_000);
      expect(otlpExportFn).toHaveBeenCalledTimes(1);
      expect(getLogOutput(stderrSpy)).toContain('re-queuing batch for retry');

      // Second harvest should retry the requeued batch
      await jest.advanceTimersByTimeAsync(60_000);
      expect(otlpExportFn).toHaveBeenCalledTimes(2);

      await scheduler.stop();
    });
  });
});
