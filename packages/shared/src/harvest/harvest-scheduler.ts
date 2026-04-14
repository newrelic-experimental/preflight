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

    this.eventIntervalId = setInterval(() => {
      void this.harvestEvents();
    }, this.eventHarvestIntervalMs);
    this.eventIntervalId.unref();

    this.metricIntervalId = setInterval(() => {
      void this.harvestMetrics();
    }, this.metricHarvestIntervalMs);
    this.metricIntervalId.unref();

    process.once('beforeExit', this.boundBeforeExit);
    process.on('SIGTERM', this.boundSigterm);

    logger.info('Harvest scheduler started', {
      eventIntervalMs: this.eventHarvestIntervalMs,
      metricIntervalMs: this.metricHarvestIntervalMs,
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
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
    const batch = this.eventBuffer.flush();
    if (batch.length === 0) return;

    try {
      const result = await this.sendEventsFn(batch, this.licenseKey, this.transportOptions);
      if (!result.success) {
        logger.warn('Failed to send events — batch dropped', {
          droppedCount: batch.length,
          error: result.error,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('Unexpected error sending events — batch dropped', {
        droppedCount: batch.length,
        error: message,
      });
    }
  }

  async harvestMetrics(): Promise<void> {
    const metrics = this.metricAggregator.harvest();
    if (metrics.length === 0) return;

    try {
      const result = await this.sendMetricsFn(metrics, this.licenseKey, this.transportOptions);
      if (!result.success) {
        logger.warn('Failed to send metrics — batch dropped', {
          droppedCount: metrics.length,
          error: result.error,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('Unexpected error sending metrics — batch dropped', {
        droppedCount: metrics.length,
        error: message,
      });
    }
  }
}
