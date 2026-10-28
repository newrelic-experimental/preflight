import { createLogger } from '../shared/index.js';
import type { McpServerConfig } from '../config.js';
import { SessionTracker } from '../metrics/session-tracker.js';
import type { AuditRecord } from '../security/audit-trail.js';
import { NrIngestManager, type NrIngestOptions } from './nr-ingest.js';

const logger = createLogger('audit-record-sender');

type NrIngestConfigOptions = Pick<
  NrIngestOptions,
  | 'licenseKey'
  | 'transportOptions'
  | 'developer'
  | 'appName'
  | 'teamId'
  | 'projectId'
  | 'orgId'
  | 'repoUrl'
  | 'companionMode'
  | 'tiers'
  | 'eventHarvestIntervalMs'
  | 'metricHarvestIntervalMs'
>;

/** The NrIngestManager options every server mode derives from config alone. */
export function nrIngestOptionsFromConfig(config: McpServerConfig): NrIngestConfigOptions {
  if (!config.licenseKey || !config.accountId) {
    throw new Error(
      'licenseKey and accountId must be defined. ' +
        'This should have been caught by config validation. ' +
        'Check that mode is not "local" or that cloud credentials are configured.',
    );
  }
  return {
    licenseKey: config.licenseKey,
    transportOptions: {
      accountId: config.accountId,
      collectorHost: config.collectorHost,
    },
    developer: config.developer,
    appName: config.appName,
    teamId: config.teamId,
    projectId: config.projectId,
    orgId: config.orgId,
    repoUrl: config.repoUrl,
    companionMode: config.companionMode,
    tiers: config.tiers,
    eventHarvestIntervalMs: config.harvestIntervalMs.events,
    metricHarvestIntervalMs: config.harvestIntervalMs.metrics,
  };
}

/**
 * Sends one audit record to New Relic now. Uses the live ingest manager when
 * it is running. Otherwise, outside local mode, a short-lived manager sends and
 * flushes it, because a pending stdio session may never resolve and build one.
 */
export async function sendAuditRecord(
  record: AuditRecord,
  options: {
    config: McpServerConfig;
    liveIngest: NrIngestManager | undefined;
    sessionTraceId: string;
    /** Test seam for the short-lived manager's transport. */
    overrides?: Partial<NrIngestOptions>;
  },
): Promise<void> {
  if (options.liveIngest?.isRunning) {
    options.liveIngest.ingestAuditRecord(record);
    return;
  }
  if (options.config.mode === 'local') return;

  const oneShot = new NrIngestManager({
    ...nrIngestOptionsFromConfig(options.config),
    sessionTracker: new SessionTracker(options.sessionTraceId),
    sessionTraceId: options.sessionTraceId,
    trackSessionGauges: false,
    ...options.overrides,
  });
  oneShot.start();
  oneShot.ingestAuditRecord(record);
  await oneShot.stop();
  logger.info('Sent audit record through a one-shot ingest manager', { action: record.action });
}
