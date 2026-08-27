/**
 * Single source of truth for New Relic region host mappings — events-ingest
 * host, NerdGraph URL, license-key auto-detect prefix, and deploy-CLI flag —
 * consumed by key-validator.ts, setup-wizard.ts, and the deploy CLI files.
 * Previously each of those maintained its own copy of this table; adding or
 * changing a region meant updating all of them in lockstep with no
 * compiler-enforced sync.
 */

import { stagingHost } from '../shared/transport/http-client.js';

export type RegionKey = 'us' | 'eu' | 'staging' | 'gov' | 'jp';

export interface RegionDefinition {
  readonly key: RegionKey;
  readonly menuLabel: string;
  readonly displayHost: string;
  readonly eventsApiHost: string;
  readonly nerdgraphUrl: string;
  readonly licenseKeyPrefix: string | null;
  readonly cliFlag: '--eu' | '--staging' | '--jp' | null;
}

// Order is load-bearing: setup-wizard's regenerated region menu numbers its
// options 1-4 by this array's index. Staging is deliberately NOT included
// here — see STAGING_REGION below.
export const REGIONS: readonly RegionDefinition[] = [
  {
    key: 'us',
    menuLabel: 'US',
    displayHost: 'api.newrelic.com',
    eventsApiHost: 'insights-collector.newrelic.com',
    nerdgraphUrl: 'https://api.newrelic.com/graphql',
    licenseKeyPrefix: 'us01',
    cliFlag: null,
  },
  {
    key: 'eu',
    menuLabel: 'EU',
    displayHost: 'api.eu.newrelic.com',
    eventsApiHost: 'insights-collector.eu01.nr-data.net',
    nerdgraphUrl: 'https://api.eu.newrelic.com/graphql',
    licenseKeyPrefix: 'eu01',
    cliFlag: '--eu',
  },
  {
    key: 'gov',
    menuLabel: 'FedRAMP',
    displayHost: 'api.newrelic.com (FedRAMP/GovCloud)',
    eventsApiHost: 'gov-insights-collector.newrelic.com',
    // FedRAMP/GovCloud uses the same NerdGraph API as US, only the
    // events-ingest host differs — there is no --gov deploy CLI flag
    // because deploy commands never need a different NerdGraph URL for it.
    nerdgraphUrl: 'https://api.newrelic.com/graphql',
    licenseKeyPrefix: 'gov01',
    cliFlag: null,
  },
  {
    key: 'jp',
    menuLabel: 'Japan',
    displayHost: 'api.jp.newrelic.com',
    eventsApiHost: 'insights-collector.jp.nr-data.net',
    nerdgraphUrl: 'https://api.jp.newrelic.com/graphql',
    licenseKeyPrefix: 'jp',
    cliFlag: '--jp',
  },
];

// Resolvable via the deploy-CLI --staging flag and the setup wizard's
// --staging flag, but deliberately excluded from REGIONS so it's never
// listed in the interactive environment menu or matched by the
// license-key auto-detect loop — reachable only by passing the flag
// explicitly.
const STAGING_REGION: RegionDefinition = {
  key: 'staging',
  menuLabel: 'Staging',
  displayHost: stagingHost('api'),
  eventsApiHost: stagingHost('insights-collector'),
  nerdgraphUrl: `https://${stagingHost('api')}/graphql`,
  licenseKeyPrefix: null,
  cliFlag: '--staging',
};

export function getRegion(key: string | null | undefined): RegionDefinition {
  return (
    REGIONS.find((r) => r.key === key) ??
    (key === STAGING_REGION.key ? STAGING_REGION : undefined) ??
    REGIONS[0]!
  );
}

export function getRegionByDeployFlags(opts: {
  staging?: boolean;
  eu?: boolean;
  jp?: boolean;
}): RegionDefinition {
  if (opts.staging) return getRegion('staging');
  if (opts.eu) return getRegion('eu');
  if (opts.jp) return getRegion('jp');
  return getRegion('us');
}

// Strict prefix match — returns null when the key has no recognized region
// prefix (e.g. a legacy key), so callers can distinguish "no opinion" from
// "detected us". Used for the setup wizard's key/environment-mismatch warning.
export function detectRegionFromLicenseKeyStrict(licenseKey: string): RegionKey | null {
  const keyLower = licenseKey.toLowerCase();
  for (const region of REGIONS) {
    if (region.licenseKeyPrefix && keyLower.startsWith(region.licenseKeyPrefix)) {
      return region.key;
    }
  }
  return null;
}

// Same prefix match as above, but defaults to 'us' instead of null — used to
// pre-select a default answer in the setup wizard's environment picker.
export function suggestRegionFromLicenseKey(licenseKey: string): RegionKey {
  return detectRegionFromLicenseKeyStrict(licenseKey) ?? 'us';
}
