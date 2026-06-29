import { randomUUID } from 'node:crypto';
import type { NrEventData } from '../events/types.js';
import type {
  NrMetric,
  TransportMode,
  TransportOptions,
  TransportResult,
} from '../transport/types.js';
import type { OtlpEventBridge } from '../transport/otlp-event-bridge.js';
import type { OtlpTransport } from '../transport/otlp-transport.js';
import { createLogger, type Logger } from '../logger.js';
import { EventBuffer } from './event-buffer.js';
import { MetricAggregator, snapshotsToNrMetrics } from './metric-aggregator.js';
import type { MetricAttributeValue, MetricSnapshot } from './metric-aggregator.js';

const logger = createLogger('harvest');

/**
 * Generate an 8-hex-char correlation ID for one harvest cycle.
 * Stamped via `logger.child({ harvestId })` so every
 * log line emitted during the cycle — including from `sendEvents*` /
 * `sendMetrics*` helpers — carries the same ID. Operators can pivot on
 * `harvestId` in stderr to trace one cycle through batch send, retry,
 * and overflow logs.
 */
function newHarvestId(): string {
  return randomUUID().slice(0, 8);
}

type SendEventsFn = (
  events: NrEventData[],
  licenseKey: string,
  options: TransportOptions,
) => Promise<TransportResult>;

type SendMetricsFn = (
  metrics: NrMetric[],
  licenseKey: string,
  options: TransportOptions,
) => Promise<TransportResult>;

export interface HarvestSchedulerOptions {
  readonly licenseKey: string;
  readonly transportOptions: TransportOptions;
  readonly eventHarvestIntervalMs?: number;
  readonly metricHarvestIntervalMs?: number;
  readonly maxEventBufferSize?: number;
  /**
   * Maximum number of events kept in the per-transport retry buffer when a
   * harvest fails. Defaults to `maxEventBufferSize`,
   * but can be set independently — operators with bursty failure modes may
   * want a deeper retry cap than primary buffer cap. Note that peak
   * in-memory event count is roughly `maxEventBufferSize + maxRetryEvents`.
   */
  readonly maxRetryEvents?: number;
  /**
   * Maximum number of metric snapshots kept in the per-transport retry
   * buffer when a metric harvest fails. Defaults to 500.
   * Each snapshot represents one (name, attributes) bucket; with the
   * summary-metric wire format, the corresponding NrMetric count is also
   * one per snapshot.
   */
  readonly maxRetryMetricSnapshots?: number;
  readonly sendEventsFn: SendEventsFn;
  readonly sendMetricsFn: SendMetricsFn;
  readonly otlpEventBridge?: OtlpEventBridge;
  readonly otlpTransport?: OtlpTransport;
  readonly transport?: TransportMode;

  /**
   * If `true`, the harvest intervals are `unref()`'d so they do not keep the
   * Node event loop alive on their own, and a best-effort `beforeExit` handler
   * is registered to attempt a final flush.
   *
   * **Default: `false`.** With the default, the running scheduler keeps the
   * process alive — consumers MUST call `await scheduler.stop()` before
   * exiting. This is the safe default: silently dropping buffered events on
   * exit is worse than a process that won't quit.
   *
   * Set this to `true` only when:
   * 1. You are sure your shutdown path always calls `await scheduler.stop()`,
   *    AND
   * 2. You also want the scheduler not to delay process exit if your
   *    shutdown path is missed (CLI tools, short-lived scripts).
   *
   * The `beforeExit` fallback is best-effort: Node may exit before its
   * fire-and-forget `void this.stop()` finishes, so events may be lost.
   */
  readonly allowProcessExit?: boolean;
}

const DEFAULT_EVENT_HARVEST_MS = 5_000;
const DEFAULT_METRIC_HARVEST_MS = 60_000;

export class HarvestScheduler {
  private readonly eventBuffer: EventBuffer;
  private readonly metricAggregator: MetricAggregator;
  private readonly licenseKey: string;
  private readonly transportOptions: TransportOptions;
  private readonly sendEventsFn: SendEventsFn;
  private readonly sendMetricsFn: SendMetricsFn;
  private readonly eventHarvestIntervalMs: number;
  private readonly metricHarvestIntervalMs: number;
  private readonly otlpEventBridge?: OtlpEventBridge;
  private readonly otlpTransport?: OtlpTransport;
  private readonly transport: TransportMode;
  private readonly allowProcessExit: boolean;

  private eventIntervalId: ReturnType<typeof setInterval> | null = null;
  private metricIntervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private stopPromise: Promise<void> | null = null;

  // Track in-flight harvests so (a) overlapping
  // interval ticks don't double-fire harvests on the same buffers (a slow
  // network can otherwise produce N concurrent fetches if interval < latency),
  // and (b) stop() can await any harvest already in progress before kicking
  // off the final flush (avoids racing the in-flight one).
  private inFlightEventHarvest: Promise<void> | null = null;
  private inFlightMetricHarvest: Promise<void> | null = null;

  // Per-transport retry buffers. In 'both' mode, NR and OTLP failures must
  // be tracked independently — otherwise a NR-only failure causes the next
  // harvest to re-send the batch to *both* transports, duplicating on OTLP.
  private retryNrEventBatch: NrEventData[] = [];
  private retryOtlpEventBatch: NrEventData[] = [];
  // Retry buffers hold pre-explosion bucket snapshots, not
  // exploded NrMetric[] wire form. On the next harvest the failed snapshots
  // are merged back into the aggregator (via a temporary one, per transport)
  // so that overlapping (name, attributes) keys collapse into a single
  // rolled-up data point with one timestamp instead of two separately
  // exploded sets of count/sum/min/max.
  private retryNrMetricSnapshots: MetricSnapshot[] = [];
  private retryOtlpMetricSnapshots: MetricSnapshot[] = [];
  private readonly maxRetryEvents: number;
  private readonly maxRetryMetricSnapshotsCap: number;
  // Snapshot cap: 500 buckets ≈ 2000 wire metrics post-explosion. Larger
  // effective ceiling than the previous 500-NrMetric cap (~125 buckets) by
  // design — retry pressure is rare and the previous limit was tighter than
  // intended.

  private readonly boundBeforeExit: () => void;

  constructor(options: HarvestSchedulerOptions) {
    this.licenseKey = options.licenseKey;
    this.transportOptions = options.transportOptions;
    this.sendEventsFn = options.sendEventsFn;
    this.sendMetricsFn = options.sendMetricsFn;
    this.eventHarvestIntervalMs = this.validateInterval(
      'eventHarvestIntervalMs',
      options.eventHarvestIntervalMs ?? DEFAULT_EVENT_HARVEST_MS,
    );
    this.metricHarvestIntervalMs = this.validateInterval(
      'metricHarvestIntervalMs',
      options.metricHarvestIntervalMs ?? DEFAULT_METRIC_HARVEST_MS,
    );
    this.otlpEventBridge = options.otlpEventBridge;
    this.otlpTransport = options.otlpTransport;
    this.transport = options.transport ?? 'nr-events-api';
    this.allowProcessExit = options.allowProcessExit ?? false;

    // Warn when the transport configuration requires an OTLP component that
    // was not provided — events/metrics would be silently dropped.
    const wantOtlp = this.transport === 'otlp' || this.transport === 'both';
    if (wantOtlp && !this.otlpEventBridge) {
      logger.warn(
        'HarvestScheduler: transport includes otlp but otlpEventBridge is not configured — OTLP events will be silently dropped',
      );
    }
    if (wantOtlp && !this.otlpTransport) {
      logger.warn(
        'HarvestScheduler: transport includes otlp but otlpTransport is not configured — OTLP metrics will be silently dropped',
      );
    }

    this.eventBuffer = new EventBuffer({ maxSize: options.maxEventBufferSize });
    this.metricAggregator = new MetricAggregator();
    // maxRetryEvents defaults to maxEventBufferSize when
    // not specified, preserving prior behavior. Operators that need a
    // deeper retry cap (bursty failures, long downstream outages) can set
    // it independently — peak in-memory event count is then roughly
    // maxEventBufferSize + maxRetryEvents.
    this.maxRetryEvents = options.maxRetryEvents ?? options.maxEventBufferSize ?? 1_000;
    this.maxRetryMetricSnapshotsCap = options.maxRetryMetricSnapshots ?? 500;

    this.boundBeforeExit = () => {
      void this.stop();
    };
  }

  /**
   * Buffer an event for the next harvest tick.
   *
   * Returns `true` when the event was added without evicting another, and
   * `false` when the event buffer was already full and the oldest event
   * was head-dropped. Callers ignoring the return
   * value see the same behavior as before — the per-harvest
   * `nr.ai.dropped_events` self-monitoring metric still counts the drops
   * regardless. The boolean lets producers throttle or surface a custom
   * backpressure metric instead of polling.
   */
  addEvent(event: NrEventData): boolean {
    return this.eventBuffer.add(event);
  }

  /**
   * Record a metric sample.
   *
   * Returns `true` when the sample was accepted into a bucket, and `false`
   * when it was rejected (non-finite value or invalid attribute type) per
   * the strict validation contract. Existing
   * callers that ignore the return value see unchanged behavior.
   */
  recordMetric(
    name: string,
    value: number,
    attributes: Record<string, MetricAttributeValue> = {},
  ): boolean {
    return this.metricAggregator.record(name, value, attributes);
  }

  /**
   * Start periodic harvesting.
   *
   * **Signal handling is the consumer's responsibility.** This library does
   * NOT register `SIGTERM` or `SIGINT` handlers — auto-registering process-level
   * signal handlers from a library is an anti-pattern:
   *
   * 1. The consumer's main process likely has its own `SIGTERM`/`SIGINT`
   *    handler. If both fire and the consumer's `process.exit(0)` runs first,
   *    our in-flight `stop()` is killed mid-flush and events are lost on
   *    graceful K8s rollout.
   * 2. The consumer can't know that *we* attached a handler, so they can't
   *    coordinate ordering.
   *
   * To flush cleanly on shutdown, register your own signal handler and
   * `await scheduler.stop()` before exiting:
   *
   * ```ts
   * for (const sig of ['SIGTERM', 'SIGINT'] as const) {
   *   process.once(sig, async () => {
   *     await scheduler.stop();
   *     process.exit(0);
   *   });
   * }
   * ```
   *
   * **Process exit semantics.** By default
   * (`allowProcessExit: false`), the harvest intervals keep the Node event
   * loop alive — your process will NOT exit until you call
   * `await scheduler.stop()`. This is intentional: silently dropping
   * buffered events on exit is worse than a process that won't quit.
   * Pass `allowProcessExit: true` to opt into `unref()` + a best-effort
   * `beforeExit` fallback (suitable for short-lived CLI tools where
   * losing the last few buffered events is acceptable).
   */
  start(): void {
    if (this.running) {
      logger.warn('HarvestScheduler already running');
      return;
    }

    // Refuse start() while a previous stop() is still
    // resolving. `running` flips to false at the top of doStop(), so without
    // this guard a fast-cycling consumer could call start() before stop()
    // has finished tearing down intervals / removing the beforeExit
    // listener — the new start would then register a fresh beforeExit
    // listener while the old stop is mid-flight clearing it. Caller must
    // `await scheduler.stop()` before restarting. (`stopPromise` is cleared
    // via `.finally()` in `stop()` once doStop resolves, so a fully-awaited
    // stop unblocks the next start.)
    if (this.stopPromise !== null) {
      logger.warn(
        'HarvestScheduler.start() called while a previous stop() is in flight — refusing. Await stop() before restarting.',
      );
      return;
    }

    this.running = true;

    this.eventIntervalId = setInterval(() => {
      // Re-entrancy guard: if the previous harvest is still running (slow
      // network, big batch), skip this tick rather than fire concurrent
      // fetches. Data isn't lost — the buffer still accumulates and the
      // next clean tick picks it up.
      if (this.inFlightEventHarvest) return;
      // .catch prevents unhandled-rejection process crash if the promise
      // rejects unexpectedly before reaching its internal try/catch.
      this.harvestEvents().catch((err) => {
        logger.error('Unexpected error in event harvest interval', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.eventHarvestIntervalMs);

    this.metricIntervalId = setInterval(() => {
      if (this.inFlightMetricHarvest) return;
      this.harvestMetrics().catch((err) => {
        logger.error('Unexpected error in metric harvest interval', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.metricHarvestIntervalMs);

    if (this.allowProcessExit) {
      // Opt-in path for short-lived CLI tools. unref()'d
      // intervals don't hold the loop open, and beforeExit is registered as
      // a best-effort final-flush attempt. Both are best-effort: Node can
      // exit before the fire-and-forget stop() finishes, so events may be
      // lost. Consumers should still prefer awaiting stop() explicitly.
      this.eventIntervalId.unref();
      this.metricIntervalId.unref();
      process.once('beforeExit', this.boundBeforeExit);
    }

    logger.info('Harvest scheduler started', {
      eventIntervalMs: this.eventHarvestIntervalMs,
      metricIntervalMs: this.metricHarvestIntervalMs,
      allowProcessExit: this.allowProcessExit,
    });
  }

  /**
   * Stop the scheduler and run a final flush.
   *
   * Concurrent calls are coalesced — the first call drives the shutdown,
   * subsequent calls receive the same `Promise`.
   *
   * Order of operations:
   * 1. Clear the harvest intervals.
   * 2. Await any in-flight harvest started by an interval tick.
   * 3. Run a final `harvestEvents()` + `harvestMetrics()`.
   * 4. `flush()` the optional `otlpEventBridge` and `otlpTransport` so
   *    pending OTLP batches are drained.
   *
   * **OTel SDK teardown is the consumer's responsibility.**
   * `stop()` deliberately does not call `shutdown()` on `otlpTransport` /
   * `otlpEventBridge` — the scheduler does not own those objects'
   * lifecycles. If you do not call `shutdown()` yourself, you will leak
   * keep-alive HTTP/2 connections, may drop in-flight OTLP batches sitting
   * inside the SDK's batch processors, and SDK timer handles can keep the
   * Node event loop alive past `stop()`. After `await scheduler.stop()`,
   * call:
   *
   * ```ts
   * await otlpTransport.shutdown();   // tracer + meter providers
   * await otlpEventBridge.shutdown(); // logger provider
   * ```
   *
   * Order matters: shut down only *after* `stop()` has resolved, otherwise
   * the final flush above will fail mid-export.
   */
  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    // Do NOT short-circuit when !this.running — a caller who added events
    // without ever calling start() should still get a final flush.
    // The interval teardown steps in doStop() are all safe no-ops when the
    // intervals were never started.

    // Drive doStop to completion through stopPromise so
    // concurrent stop() callers coalesce, then clear stopPromise once it
    // resolves so a subsequent start() can pass the "no in-flight stop"
    // guard. Without the clear, a restart-after-stop sequence would be
    // refused (the guard sees a non-null stopPromise from the prior
    // session and treats the next start() as racing an in-flight stop).
    const promise = this.doStop().finally(() => {
      // Only clear if the promise we registered is still the current one —
      // a brand-new stop() may have already overwritten it (unlikely under
      // normal use, but defensive).
      if (this.stopPromise === promise) this.stopPromise = null;
    });
    this.stopPromise = promise;
    return promise;
  }

  private async doStop(): Promise<void> {
    this.running = false;

    if (this.eventIntervalId !== null) {
      clearInterval(this.eventIntervalId);
      this.eventIntervalId = null;
    }
    if (this.metricIntervalId !== null) {
      clearInterval(this.metricIntervalId);
      this.metricIntervalId = null;
    }

    if (this.allowProcessExit) {
      process.removeListener('beforeExit', this.boundBeforeExit);
    }

    // Wait for any harvest started by an interval tick
    // to complete before we initiate the final flush. Without this, stop()'s
    // own harvestEvents call could race the in-flight one (the re-entrancy
    // guard would make it a no-op, returning the existing promise — but if
    // we don't await first, we'd queue a second harvest immediately after
    // and lose the chance to flush newly-buffered events from after the
    // in-flight one started).
    if (this.inFlightEventHarvest) {
      await this.inFlightEventHarvest.catch((err) => {
        logger.warn('In-flight event harvest errored during stop()', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    if (this.inFlightMetricHarvest) {
      await this.inFlightMetricHarvest.catch((err) => {
        logger.warn('In-flight metric harvest errored during stop()', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    // Final flush of in-memory buffers
    await Promise.all([this.harvestEvents(), this.harvestMetrics()]);

    // Flush OTLP-managed buffers (they live inside the OTel SDK batch
    // processors; otherwise events/metrics already enqueued but not yet
    // exported are dropped on process exit).
    const flushes: Promise<void>[] = [];
    if (this.otlpEventBridge) {
      flushes.push(
        this.otlpEventBridge.flush().catch((err) => {
          logger.warn('Error flushing OTLP event bridge', {
            error: err instanceof Error ? err.message : String(err),
          });
        }),
      );
    }
    if (this.otlpTransport) {
      flushes.push(
        this.otlpTransport.flush().catch((err) => {
          logger.warn('Error flushing OTLP transport', {
            error: err instanceof Error ? err.message : String(err),
          });
        }),
      );
    }
    if (flushes.length > 0) await Promise.all(flushes);

    logger.info('Harvest scheduler stopped');
  }

  private async harvestEvents(): Promise<void> {
    // If already in flight, return the same promise — callers (interval
    // ticks, manual invocations, stop's final flush) all wait on the
    // same operation rather than racing.
    if (this.inFlightEventHarvest) return this.inFlightEventHarvest;
    this.inFlightEventHarvest = this.doHarvestEvents().finally(() => {
      this.inFlightEventHarvest = null;
    });
    return this.inFlightEventHarvest;
  }

  private validateInterval(name: string, ms: number): number {
    if (!Number.isFinite(ms) || ms < 100) {
      throw new RangeError(
        `HarvestScheduler: ${name} must be a finite number >= 100ms, got ${String(ms)}`,
      );
    }
    return ms;
  }

  private async doHarvestEvents(): Promise<void> {
    // Scoped child logger stamps `harvestId` on every
    // log line emitted during this cycle (overflow, retry, requeue,
    // OTLP-export failures). Operators searching stderr for one harvest's
    // story have a single pivot.
    const harvestLog = logger.child({ harvestId: newHarvestId(), scope: 'events' });

    const fresh = this.eventBuffer.flush();

    // Surface event-buffer head-drops as a self-monitoring metric so
    // overflow loss is visible in the consumer's own NR dashboards. Drained
    // once per harvest, paired with a single warn log.
    const dropped = this.eventBuffer.drainDropCount();
    if (dropped > 0) {
      harvestLog.warn('EventBuffer overflow — oldest entries dropped', { dropped });
      this.metricAggregator.record('nr.ai.dropped_events', dropped, {
        source: 'event_buffer',
      });
    }
    // Drain the add counter each cycle so totalAdded represents adds-since-
    // last-flush. Not emitted as a metric today; wired here so a
    // future nr.ai.added_events metric reads the correct per-interval value.
    this.eventBuffer.drainAddCount();

    const wantNr = this.transport === 'nr-events-api' || this.transport === 'both';
    const wantOtlp = this.transport === 'otlp' || this.transport === 'both';

    const sends: Promise<void>[] = [];

    if (wantNr) {
      const nrBatch =
        this.retryNrEventBatch.length > 0 ? [...this.retryNrEventBatch, ...fresh] : [...fresh];
      this.retryNrEventBatch = [];
      if (nrBatch.length > 0) {
        sends.push(this.sendEventsToNr(nrBatch, harvestLog));
      }
    }

    if (wantOtlp) {
      const otlpBatch =
        this.retryOtlpEventBatch.length > 0 ? [...this.retryOtlpEventBatch, ...fresh] : [...fresh];
      this.retryOtlpEventBatch = [];
      if (otlpBatch.length > 0) {
        sends.push(this.sendEventsToOtlp(otlpBatch, harvestLog));
      }
    }

    if (sends.length > 0) await Promise.all(sends);
  }

  private async sendEventsToNr(batch: NrEventData[], log: Logger = logger): Promise<void> {
    try {
      const result = await this.sendEventsFn(batch, this.licenseKey, this.transportOptions);
      if (!result.success) {
        log.warn('Failed to send events to NR — re-queuing batch for retry', {
          batchSize: batch.length,
          error: result.error,
        });
        this.requeueNrEvents(batch, log);
      } else {
        // Debug-level success log so operators tailing stderr can
        // distinguish "harvest completed cleanly with N events" from
        // "harvest never ran". Debug (not info) keeps the steady-state
        // happy-path output quiet at default log levels.
        log.debug('Sent events to NR', { batchSize: batch.length });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('Unexpected error sending events to NR — re-queuing batch for retry', {
        batchSize: batch.length,
        error: message,
      });
      this.requeueNrEvents(batch, log);
    }
  }

  private async sendEventsToOtlp(batch: NrEventData[], log: Logger = logger): Promise<void> {
    try {
      if (this.otlpEventBridge) {
        this.otlpEventBridge.sendEvents(batch);
        // Paired with the NR-side success log. Note: this only
        // confirms enqueue into the OTel BatchLogRecordProcessor, not
        // export — the SDK decides when the wire send actually fires.
        log.debug('Enqueued events to OTLP bridge', { batchSize: batch.length });
      } else {
        // Bridge absent: the constructor already warned once. Warn
        // at debug here so repeated harvests are traceable without flooding
        // stderr.
        log.debug('OTLP event bridge not configured — batch discarded', {
          batchSize: batch.length,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('Error sending events to OTLP — re-queuing batch for retry', {
        batchSize: batch.length,
        error: message,
      });
      this.requeueOtlpEvents(batch, log);
    }
  }

  private async harvestMetrics(): Promise<void> {
    if (this.inFlightMetricHarvest) return this.inFlightMetricHarvest;
    this.inFlightMetricHarvest = this.doHarvestMetrics().finally(() => {
      this.inFlightMetricHarvest = null;
    });
    return this.inFlightMetricHarvest;
  }

  private async doHarvestMetrics(): Promise<void> {
    // Scoped child logger stamps a `harvestId` on every
    // log line emitted during this metric harvest cycle.
    const harvestLog = logger.child({ harvestId: newHarvestId(), scope: 'metrics' });

    // Self-monitoring: drain MetricAggregator's
    // drop counter and emit it as a metric so non-finite-value rejections
    // and invalid-attribute rejections are visible in the consumer's own
    // NR dashboards. Mirrors the `nr.ai.dropped_events` pattern from
    // doHarvestEvents. Note this is recorded BEFORE harvestSnapshots() so
    // the dropped_metrics gauge itself flows through this same harvest tick
    // (one extra bucket, one extra summary on the wire).
    const droppedMetrics = this.metricAggregator.drainDropCount();
    if (droppedMetrics > 0) {
      harvestLog.warn('MetricAggregator overflow — non-finite or invalid samples dropped', {
        dropped: droppedMetrics,
      });
      this.metricAggregator.record('nr.ai.dropped_metrics', droppedMetrics, {
        source: 'metric_aggregator',
      });
    }

    // Drain the aggregator as snapshots, then per
    // transport: merge the previous failed-send snapshots with the fresh
    // ones (so duplicate name+attrs buckets accumulate), then explode to
    // wire form. Each transport gets its own merged set so a NR-only
    // failure doesn't double-send to OTLP.
    const fresh = this.metricAggregator.harvestSnapshots();
    const wantNr = this.transport === 'nr-events-api' || this.transport === 'both';
    const wantOtlp = this.transport === 'otlp' || this.transport === 'both';

    const sends: Promise<void>[] = [];

    if (wantNr) {
      const nrSnapshots = this.mergeSnapshots(this.retryNrMetricSnapshots, fresh);
      this.retryNrMetricSnapshots = [];
      if (nrSnapshots.length > 0) {
        sends.push(
          this.sendMetricsToNr(
            snapshotsToNrMetrics(nrSnapshots, this.metricHarvestIntervalMs),
            nrSnapshots,
            harvestLog,
          ),
        );
      }
    }

    if (wantOtlp) {
      const otlpSnapshots = this.mergeSnapshots(this.retryOtlpMetricSnapshots, fresh);
      this.retryOtlpMetricSnapshots = [];
      if (otlpSnapshots.length > 0) {
        sends.push(
          this.sendMetricsToOtlp(
            snapshotsToNrMetrics(otlpSnapshots, this.metricHarvestIntervalMs),
            otlpSnapshots,
            harvestLog,
          ),
        );
      }
    }

    if (sends.length > 0) await Promise.all(sends);
  }

  /**
   * Combine retry snapshots with a fresh harvest's snapshots, accumulating
   * any duplicate (name, attributes) buckets. Returns a new snapshot list
   * with one entry per unique key. Uses a throwaway {@link MetricAggregator}
   * as the merge engine so the bucket-key logic is not duplicated here.
   *
   * Without this re-merge, a failed-send retry plus a
   * fresh harvest hitting the same metric+attrs would produce two wire
   * data points with different timestamps, breaking downstream NRQL
   * aggregation that expects one bucket per harvest interval.
   */
  private mergeSnapshots(
    retry: readonly MetricSnapshot[],
    fresh: readonly MetricSnapshot[],
  ): MetricSnapshot[] {
    if (retry.length === 0) return [...fresh];
    if (fresh.length === 0) return [...retry];
    const merger = new MetricAggregator();
    merger.merge(retry);
    merger.merge(fresh);
    return merger.harvestSnapshots();
  }

  private async sendMetricsToNr(
    batch: NrMetric[],
    snapshots: MetricSnapshot[],
    log: Logger = logger,
  ): Promise<void> {
    try {
      const result = await this.sendMetricsFn(batch, this.licenseKey, this.transportOptions);
      if (!result.success) {
        log.warn('Failed to send metrics to NR — re-queuing batch for retry', {
          batchSize: batch.length,
          error: result.error,
        });
        this.requeueNrMetrics(snapshots, log);
      } else {
        // Debug-level success log so operators tailing stderr can
        // distinguish "harvest completed cleanly with N metrics" from
        // "harvest never ran". Includes both the wire batch count and
        // the underlying snapshot count so a future cardinality-explosion
        // signal is visible at debug.
        log.debug('Sent metrics to NR', {
          batchSize: batch.length,
          snapshotCount: snapshots.length,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('Unexpected error sending metrics to NR — re-queuing batch for retry', {
        batchSize: batch.length,
        error: message,
      });
      this.requeueNrMetrics(snapshots, log);
    }
  }

  private async sendMetricsToOtlp(
    batch: NrMetric[],
    snapshots: MetricSnapshot[],
    log: Logger = logger,
  ): Promise<void> {
    try {
      if (this.otlpTransport) {
        await this.otlpTransport.exportMetrics(batch);
        // Paired with the NR-side success log.
        log.debug('Sent metrics to OTLP', {
          batchSize: batch.length,
          snapshotCount: snapshots.length,
        });
      } else {
        // Transport absent: the constructor already warned once.
        log.debug('OTLP transport not configured — metric batch discarded', {
          batchSize: batch.length,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // OtlpTransport.exportMetrics throws { code: 'OTLP_BAD_REQUEST' } for
      // HTTP 400 to signal that the payload is permanently malformed and will always
      // fail. Drop the batch instead of requeuing so it does not occupy the retry
      // buffer indefinitely. All other errors are retried normally.
      const isNonRetryable =
        err instanceof Error && (err as Error & { code?: string }).code === 'OTLP_BAD_REQUEST';
      if (isNonRetryable) {
        log.error('OTLP metric export rejected (bad request) — dropping batch, will not retry', {
          batchSize: batch.length,
          snapshotCount: snapshots.length,
          error: message,
        });
      } else {
        log.warn('Error sending metrics to OTLP — re-queuing batch for retry', {
          batchSize: batch.length,
          error: message,
        });
        this.requeueOtlpMetrics(snapshots, log);
      }
    }
  }

  // NOTE: the self-monitoring metrics recorded below (nr.ai.dropped_events,
  // nr.ai.dropped_metrics) are written to metricAggregator AFTER the current
  // harvest cycle has already drained it via harvestSnapshots(). They will not
  // be sent until the NEXT harvest cycle — operators see overflow counts one
  // cycle late. This is an accepted trade-off; documenting so the lag is not
  // mistaken for a bug.
  private requeueNrEvents(batch: NrEventData[], log: Logger = logger): void {
    // for-of push avoids two hazards: (a) the O(n+m) intermediate array from
    // [...old, ...new], and (b) push(...batch) throwing RangeError when
    // batch.length exceeds the engine's argument-count limit (~65k).
    for (const e of batch) this.retryNrEventBatch.push(e);
    if (this.retryNrEventBatch.length > this.maxRetryEvents) {
      const dropped = this.retryNrEventBatch.length - this.maxRetryEvents;
      this.retryNrEventBatch.splice(0, dropped);
      log.warn('NR event retry buffer overflow — oldest entries dropped', { dropped });
      // Surface as self-monitoring metric so NR dashboards show retry-buffer drops.
      this.metricAggregator.record('nr.ai.dropped_events', dropped, {
        source: 'retry_buffer',
        transport: 'nr-events-api',
      });
    }
  }

  private requeueOtlpEvents(batch: NrEventData[], log: Logger = logger): void {
    for (const e of batch) this.retryOtlpEventBatch.push(e);
    if (this.retryOtlpEventBatch.length > this.maxRetryEvents) {
      const dropped = this.retryOtlpEventBatch.length - this.maxRetryEvents;
      this.retryOtlpEventBatch.splice(0, dropped);
      log.warn('OTLP event retry buffer overflow — oldest entries dropped', { dropped });
      this.metricAggregator.record('nr.ai.dropped_events', dropped, {
        source: 'retry_buffer',
        transport: 'otlp',
      });
    }
  }

  private requeueNrMetrics(snapshots: MetricSnapshot[], log: Logger = logger): void {
    for (const s of snapshots) this.retryNrMetricSnapshots.push(s);
    if (this.retryNrMetricSnapshots.length > this.maxRetryMetricSnapshotsCap) {
      const dropped = this.retryNrMetricSnapshots.length - this.maxRetryMetricSnapshotsCap;
      this.retryNrMetricSnapshots.splice(0, dropped);
      log.warn('NR metric retry buffer overflow — oldest entries dropped', { dropped });
      this.metricAggregator.record('nr.ai.dropped_metrics', dropped, {
        source: 'retry_buffer',
        transport: 'nr-metrics-api',
      });
    }
  }

  private requeueOtlpMetrics(snapshots: MetricSnapshot[], log: Logger = logger): void {
    for (const s of snapshots) this.retryOtlpMetricSnapshots.push(s);
    if (this.retryOtlpMetricSnapshots.length > this.maxRetryMetricSnapshotsCap) {
      const dropped = this.retryOtlpMetricSnapshots.length - this.maxRetryMetricSnapshotsCap;
      this.retryOtlpMetricSnapshots.splice(0, dropped);
      log.warn('OTLP metric retry buffer overflow — oldest entries dropped', { dropped });
      this.metricAggregator.record('nr.ai.dropped_metrics', dropped, {
        source: 'retry_buffer',
        transport: 'otlp',
      });
    }
  }
}
