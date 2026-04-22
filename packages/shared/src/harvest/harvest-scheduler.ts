import type { NrEventData } from '../events/types.js';
import type { NrMetric, TransportOptions, TransportResult } from '../transport/types.js';
import { createLogger } from '../logger.js';
import { EventBuffer } from './event-buffer.js';
import { MetricAggregator } from './metric-aggregator.js';

const logger = createLogger('harvest');

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
  licenseKey: string;
  transportOptions: TransportOptions;
  eventHarvestIntervalMs?: number;
  metricHarvestIntervalMs?: number;
  maxEventBufferSize?: number;
  sendEventsFn: SendEventsFn;
  sendMetricsFn: SendMetricsFn;
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

  private eventIntervalId: ReturnType<typeof setInterval> | null = null;
  private metricIntervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private stopPromise: Promise<void> | null = null;

  private retryEventBatch: NrEventData[] = [];
  private retryMetricBatch: NrMetric[] = [];
  private readonly maxRetryEvents: number;
  private readonly maxRetryMetrics = 500;

  private readonly boundBeforeExit: () => void;
  private readonly boundSigterm: () => void;

  constructor(options: HarvestSchedulerOptions) {
    this.licenseKey = options.licenseKey;
    this.transportOptions = options.transportOptions;
    this.sendEventsFn = options.sendEventsFn;
    this.sendMetricsFn = options.sendMetricsFn;
    this.eventHarvestIntervalMs = options.eventHarvestIntervalMs ?? DEFAULT_EVENT_HARVEST_MS;
    this.metricHarvestIntervalMs = options.metricHarvestIntervalMs ?? DEFAULT_METRIC_HARVEST_MS;

    this.eventBuffer = new EventBuffer({ maxSize: options.maxEventBufferSize });
    this.metricAggregator = new MetricAggregator();
    this.maxRetryEvents = options.maxEventBufferSize ?? 1_000;

    this.boundBeforeExit = () => {
      void this.stop();
    };
    this.boundSigterm = () => {
      void this.stop();
    };
  }

  addEvent(event: NrEventData): void {
    this.eventBuffer.add(event);
  }

  recordMetric(name: string, value: number, attributes: Record<string, string | number> = {}): void {
    this.metricAggregator.record(name, value, attributes);
  }

  start(): void {
    if (this.running) {
      logger.warn('HarvestScheduler already running');
      return;
    }

    this.running = true;
    this.stopPromise = null;

    this.eventIntervalId = setInterval(() => {
      void this.harvestEvents();
    }, this.eventHarvestIntervalMs);
    this.eventIntervalId.unref();

    this.metricIntervalId = setInterval(() => {
      void this.harvestMetrics();
    }, this.metricHarvestIntervalMs);
    this.metricIntervalId.unref();

    process.once('beforeExit', this.boundBeforeExit);
    process.once('SIGTERM', this.boundSigterm);

    logger.info('Harvest scheduler started', {
      eventIntervalMs: this.eventHarvestIntervalMs,
      metricIntervalMs: this.metricHarvestIntervalMs,
    });
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (!this.running) return;

    this.stopPromise = this.doStop();
    return this.stopPromise;
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

    process.removeListener('beforeExit', this.boundBeforeExit);
    process.removeListener('SIGTERM', this.boundSigterm);

    // Final flush
    await Promise.all([this.harvestEvents(), this.harvestMetrics()]);

    logger.info('Harvest scheduler stopped');
  }

  async harvestEvents(): Promise<void> {
    const fresh = this.eventBuffer.flush();
    const batch = this.retryEventBatch.length > 0
      ? [...this.retryEventBatch, ...fresh]
      : fresh;
    this.retryEventBatch = [];
    if (batch.length === 0) return;

    try {
      const result = await this.sendEventsFn(batch, this.licenseKey, this.transportOptions);
      if (!result.success) {
        logger.warn('Failed to send events — re-queuing batch for retry', {
          batchSize: batch.length,
          error: result.error,
        });
        this.requeueEvents(batch);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('Unexpected error sending events — re-queuing batch for retry', {
        batchSize: batch.length,
        error: message,
      });
      this.requeueEvents(batch);
    }
  }

  async harvestMetrics(): Promise<void> {
    const fresh = this.metricAggregator.harvest();
    const batch = this.retryMetricBatch.length > 0
      ? [...this.retryMetricBatch, ...fresh]
      : fresh;
    this.retryMetricBatch = [];
    if (batch.length === 0) return;

    try {
      const result = await this.sendMetricsFn(batch, this.licenseKey, this.transportOptions);
      if (!result.success) {
        logger.warn('Failed to send metrics — re-queuing batch for retry', {
          batchSize: batch.length,
          error: result.error,
        });
        this.requeueMetrics(batch);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('Unexpected error sending metrics — re-queuing batch for retry', {
        batchSize: batch.length,
        error: message,
      });
      this.requeueMetrics(batch);
    }
  }

  private requeueEvents(batch: NrEventData[]): void {
    this.retryEventBatch = [...batch, ...this.retryEventBatch];
    if (this.retryEventBatch.length > this.maxRetryEvents) {
      const dropped = this.retryEventBatch.length - this.maxRetryEvents;
      this.retryEventBatch = this.retryEventBatch.slice(-this.maxRetryEvents);
      logger.warn('Event retry buffer overflow — oldest entries dropped', { dropped });
    }
  }

  private requeueMetrics(batch: NrMetric[]): void {
    this.retryMetricBatch = [...batch, ...this.retryMetricBatch];
    if (this.retryMetricBatch.length > this.maxRetryMetrics) {
      const dropped = this.retryMetricBatch.length - this.maxRetryMetrics;
      this.retryMetricBatch = this.retryMetricBatch.slice(-this.maxRetryMetrics);
      logger.warn('Metric retry buffer overflow — oldest entries dropped', { dropped });
    }
  }
}
