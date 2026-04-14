import { HarvestScheduler } from './harvest-scheduler.js';
import type { HarvestSchedulerOptions } from './harvest-scheduler.js';
import type { TransportResult } from '../transport/types.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;

const successResult: TransportResult = { success: true, statusCode: 200, retryCount: 0 };
const failureResult: TransportResult = {
  success: false,
  statusCode: 500,
  retryCount: 3,
  error: 'server error',
};

function makeScheduler(
  overrides: Partial<HarvestSchedulerOptions> = {},
): {
  scheduler: HarvestScheduler;
  sendEventsFn: jest.Mock;
  sendMetricsFn: jest.Mock;
} {
  const sendEventsFn = jest.fn<Promise<TransportResult>, any>().mockResolvedValue(successResult);
  const sendMetricsFn = jest.fn<Promise<TransportResult>, any>().mockResolvedValue(successResult);

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
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  jest.useRealTimers();
  stderrSpy.mockRestore();
});

describe('HarvestScheduler', () => {
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
    const sentEvents = sendEventsFn.mock.calls[0][0];
    expect(sentEvents).toHaveLength(1);
    expect(sentEvents[0].eventType).toBe('Test');

    // Verify metrics were sent (4 gauges: count, sum, min, max)
    const sentMetrics = sendMetricsFn.mock.calls[0][0];
    expect(sentMetrics).toHaveLength(4);
  });

  // ---------------------------------------------------------------------------
  // 3. Atomic snapshot — events added during send appear in next harvest
  // ---------------------------------------------------------------------------
  it('events added during send are captured in next harvest', async () => {
    let addDuringSend: (() => void) | null = null;

    const sendEventsFn = jest.fn<Promise<TransportResult>, any>().mockImplementation(async () => {
      // Simulate adding an event while the send is in-flight
      if (addDuringSend) {
        addDuringSend();
        addDuringSend = null;
      }
      return successResult;
    });

    const { scheduler, sendMetricsFn } = makeScheduler({ sendEventsFn });

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
    const firstBatch = sendEventsFn.mock.calls[0][0];
    expect(firstBatch).toHaveLength(3);

    // Second harvest at 10s should pick up the 2 events added during first send
    await jest.advanceTimersByTimeAsync(5_000);
    expect(sendEventsFn).toHaveBeenCalledTimes(2);

    const secondBatch = sendEventsFn.mock.calls[1][0];
    expect(secondBatch).toHaveLength(2);
    expect(secondBatch[0].eventType).toBe('DuringSend');

    await scheduler.stop();
  });

  // ---------------------------------------------------------------------------
  // 4. Send failure → warning logged, scheduler continues
  // ---------------------------------------------------------------------------
  it('logs warning on send failure and continues operating', async () => {
    const sendEventsFn = jest
      .fn<Promise<TransportResult>, any>()
      .mockResolvedValue(failureResult);

    const { scheduler } = makeScheduler({ sendEventsFn });

    scheduler.addEvent({ eventType: 'Test', value: 1 });
    scheduler.start();

    // First harvest — fails
    await jest.advanceTimersByTimeAsync(5_000);
    expect(sendEventsFn).toHaveBeenCalledTimes(1);

    // Verify warning was logged
    const logOutput = stderrSpy.mock.calls.map((c) => c[0] as string).join('');
    expect(logOutput).toContain('Failed to send events');
    expect(logOutput).toContain('droppedCount');

    // Add more events — scheduler should still be running
    scheduler.addEvent({ eventType: 'Test', value: 2 });
    await jest.advanceTimersByTimeAsync(5_000);
    expect(sendEventsFn).toHaveBeenCalledTimes(2);

    await scheduler.stop();
  });
});
