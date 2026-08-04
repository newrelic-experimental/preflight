import {
  sendEvents,
  sendMetrics,
  sendLogs,
  createLogger,
} from '../shared/index.js';
import type {
  NrEventData,
  NrLogEntry,
  NrMetric,
  TransportOptions,
  TransportResult,
} from '../shared/index.js';

const logger = createLogger('jp-region');

/**
 * New Relic Japan (JP) data center support.
 *
 * WHY THIS LIVES HERE (and not in `src/shared/transport/http-client.ts`):
 * `src/shared/` is a vendored snapshot that must never be edited in this repo
 * (see CLAUDE.md). The canonical region table there (`Region = 'us' | 'eu' |
 * 'gov'` + `NR_INGEST_HOSTS`) therefore cannot be widened to add a `'jp'` row.
 *
 * The JP region also can't be expressed through the shared `collectorHost`
 * FQDN-passthrough directly, because that passthrough uses a SINGLE host for
 * all three ingest APIs (events, metric, logs) — whereas JP, like every real
 * NR region, uses three distinct subdomains. The shared URL builders, however,
 * are per-API functions that each read `collectorHost` independently, so we can
 * reuse them unchanged by handing EACH shared sender the correct per-API JP
 * FQDN as its `collectorHost`. This keeps all payload-shaping and retry logic
 * in the shared layer (zero duplication) and, because a literal FQDN makes the
 * shared `resolveRegion()` short-circuit, it also avoids the spurious
 * "unrecognized license-key region prefix" warning.
 *
 * Endpoint source: New Relic network docs,
 * https://docs.newrelic.com/docs/new-relic-solutions/get-started/networks/
 * License-key region prefix: `jp`.
 */
export const JP_REGION = 'jp';

/** Per-API New Relic JP ingest hostnames. */
export const JP_INGEST_HOSTS = {
  events: 'insights-collector.jp.nr-data.net',
  metric: 'metric-api.jp.nr-data.net',
  log: 'log-api.jp.nr-data.net',
} as const;

/** NerdGraph (GraphQL) endpoint for the JP data center. */
export const JP_NERDGRAPH_URL = 'https://api.jp.newrelic.com/graphql';

/** OTLP/HTTP ingest endpoint for the JP data center. */
export const JP_OTLP_ENDPOINT = 'https://otlp.jp.nr-data.net';

/**
 * True when the resolved collector host is the JP region keyword. Case- and
 * whitespace-insensitive. Returns false for `null`/`undefined` and for literal
 * hostnames (which route through the shared FQDN passthrough unchanged).
 */
export function isJapanRegion(collectorHost: string | null | undefined): boolean {
  return typeof collectorHost === 'string' && collectorHost.trim().toLowerCase() === JP_REGION;
}

/**
 * Detect the JP region from a license key. NR JP keys carry the `jp` region
 * prefix (e.g. `jp01xxxx...`), mirroring the `eu01`/`gov01` scheme the shared
 * layer recognizes for the other regions.
 */
export function isJapanLicenseKey(licenseKey: string | undefined): boolean {
  return typeof licenseKey === 'string' && licenseKey.trim().toLowerCase().startsWith(JP_REGION);
}

// Force `collectorHost` to a specific JP FQDN so the shared URL builder emits
// the correct per-API host. Any inbound `collectorHost` (e.g. the `'jp'`
// keyword) is intentionally overridden.
function withJpHost(options: TransportOptions, host: string): TransportOptions {
  return { ...options, collectorHost: host };
}

/** JP-region wrapper around the shared events sender. */
export function sendEventsJp(
  events: NrEventData[],
  licenseKey: string,
  options: TransportOptions,
): Promise<TransportResult> {
  return sendEvents(events, licenseKey, withJpHost(options, JP_INGEST_HOSTS.events));
}

/** JP-region wrapper around the shared metrics sender. */
export function sendMetricsJp(
  metrics: NrMetric[],
  licenseKey: string,
  options: TransportOptions,
): Promise<TransportResult> {
  return sendMetrics(metrics, licenseKey, withJpHost(options, JP_INGEST_HOSTS.metric));
}

/** JP-region wrapper around the shared logs sender. */
export function sendLogsJp(
  logs: NrLogEntry[],
  licenseKey: string,
  options: TransportOptions,
): Promise<TransportResult> {
  return sendLogs(logs, licenseKey, withJpHost(options, JP_INGEST_HOSTS.log));
}

/**
 * Transport-function overrides for `NrIngestManager`. When the region is JP,
 * returns the three JP-aware senders so events/metrics/logs each route to their
 * correct JP subdomain; otherwise returns an empty object so the caller falls
 * back to the shared defaults. Spread the result into `NrIngestManager` options.
 */
export function jpSenderOverrides(collectorHost: string | null | undefined): {
  sendEventsFn?: typeof sendEventsJp;
  sendMetricsFn?: typeof sendMetricsJp;
  sendLogsFn?: typeof sendLogsJp;
} {
  if (!isJapanRegion(collectorHost)) return {};
  logger.debug('Routing telemetry to New Relic Japan (JP) data center', {
    events: JP_INGEST_HOSTS.events,
    metric: JP_INGEST_HOSTS.metric,
    log: JP_INGEST_HOSTS.log,
  });
  return {
    sendEventsFn: sendEventsJp,
    sendMetricsFn: sendMetricsJp,
    sendLogsFn: sendLogsJp,
  };
}
