import {
  REGIONS,
  getRegion,
  getRegionByDeployFlags,
  detectRegionFromLicenseKeyStrict,
  suggestRegionFromLicenseKey,
} from './regions.js';
import { stagingHost } from '../shared/transport/http-client.js';

describe('REGIONS', () => {
  it('is ordered us, eu, gov, jp — staging deliberately excluded', () => {
    expect(REGIONS.map((r) => r.key)).toEqual(['us', 'eu', 'gov', 'jp']);
  });
});

describe('getRegion', () => {
  it('returns the us region for null', () => {
    expect(getRegion(null).key).toBe('us');
  });

  it('returns the us region for undefined', () => {
    expect(getRegion(undefined).key).toBe('us');
  });

  it('returns the us region for an unrecognized key', () => {
    expect(getRegion('not-a-real-region').key).toBe('us');
  });

  it('returns the matching region for a known key', () => {
    expect(getRegion('eu').eventsApiHost).toBe('insights-collector.eu01.nr-data.net');
    expect(getRegion('jp').nerdgraphUrl).toBe('https://api.jp.newrelic.com/graphql');
    expect(getRegion('gov').eventsApiHost).toBe('gov-insights-collector.newrelic.com');
    expect(getRegion('gov').nerdgraphUrl).toBe('https://api.newrelic.com/graphql');
  });

  it('resolves staging fully despite it being excluded from REGIONS', () => {
    const staging = getRegion('staging');
    expect(staging.key).toBe('staging');
    expect(staging.eventsApiHost).toBe(stagingHost('insights-collector'));
    expect(staging.nerdgraphUrl).toBe(`https://${stagingHost('api')}/graphql`);
    expect(staging.cliFlag).toBe('--staging');
  });
});

describe('getRegionByDeployFlags', () => {
  it('returns us when no flag is set', () => {
    expect(getRegionByDeployFlags({}).key).toBe('us');
  });

  it('returns eu when eu is set', () => {
    expect(getRegionByDeployFlags({ eu: true }).nerdgraphUrl).toBe(
      'https://api.eu.newrelic.com/graphql',
    );
  });

  it('returns staging when staging is set', () => {
    expect(getRegionByDeployFlags({ staging: true }).nerdgraphUrl).toBe(
      `https://${stagingHost('api')}/graphql`,
    );
  });

  it('returns jp when jp is set', () => {
    expect(getRegionByDeployFlags({ jp: true }).nerdgraphUrl).toBe(
      'https://api.jp.newrelic.com/graphql',
    );
  });
});

describe('detectRegionFromLicenseKeyStrict', () => {
  it('detects eu01 prefix', () => {
    expect(detectRegionFromLicenseKeyStrict('eu01xx-license')).toBe('eu');
  });

  it('detects gov01 prefix', () => {
    expect(detectRegionFromLicenseKeyStrict('gov01xx-license')).toBe('gov');
  });

  it('detects us01 prefix', () => {
    expect(detectRegionFromLicenseKeyStrict('us01xx-license')).toBe('us');
  });

  it('detects jp prefix', () => {
    expect(detectRegionFromLicenseKeyStrict('jpxx-license')).toBe('jp');
  });

  it('returns null for a legacy key with no recognized prefix', () => {
    expect(detectRegionFromLicenseKeyStrict('NRLIC-legacykey')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(detectRegionFromLicenseKeyStrict('EU01XX-LICENSE')).toBe('eu');
  });
});

describe('suggestRegionFromLicenseKey', () => {
  it('suggests eu for an eu01-prefixed key', () => {
    expect(suggestRegionFromLicenseKey('eu01xx-license')).toBe('eu');
  });

  it('defaults to us for a key with no recognized prefix', () => {
    expect(suggestRegionFromLicenseKey('NRLIC-legacykey')).toBe('us');
  });

  it('defaults to us for a nonsense key', () => {
    expect(suggestRegionFromLicenseKey('nope')).toBe('us');
  });
});
