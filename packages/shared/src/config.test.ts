import { loadConfig } from './config.js';

describe('loadConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.NEW_RELIC_LICENSE_KEY;
    delete process.env.NEW_RELIC_APP_NAME;
    delete process.env.NEW_RELIC_AI_ENABLED;
    delete process.env.NEW_RELIC_AI_RECORD_CONTENT;
    delete process.env.NEW_RELIC_AI_COST_TRACKING;
    delete process.env.NEW_RELIC_AI_QUALITY_TRACKING;
    delete process.env.NEW_RELIC_AI_CONVERSATION_TRACKING;
    delete process.env.NEW_RELIC_AI_THINKING_TRACKING;
    delete process.env.NEW_RELIC_AI_CUSTOM_PRICING_FILE;
    delete process.env.NEW_RELIC_AI_CONTENT_MAX_LENGTH;
    delete process.env.NEW_RELIC_AI_HIGH_SECURITY;
    delete process.env.NEW_RELIC_AI_LOG_LEVEL;
    delete process.env.NEW_RELIC_HOST;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('throws when NEW_RELIC_LICENSE_KEY is missing', () => {
    expect(() => loadConfig({ appName: 'test-app' })).toThrow('NEW_RELIC_LICENSE_KEY');
  });

  it('throws when NEW_RELIC_APP_NAME is missing', () => {
    expect(() => loadConfig({ licenseKey: 'abc123' })).toThrow('NEW_RELIC_APP_NAME');
  });

  it('loads required fields from env vars', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'my-key';
    process.env.NEW_RELIC_APP_NAME = 'my-app';

    const config = loadConfig();

    expect(config.licenseKey).toBe('my-key');
    expect(config.appName).toBe('my-app');
  });

  it('overrides take precedence over env vars', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'env-key';
    process.env.NEW_RELIC_APP_NAME = 'env-app';

    const config = loadConfig({ licenseKey: 'override-key', appName: 'override-app' });

    expect(config.licenseKey).toBe('override-key');
    expect(config.appName).toBe('override-app');
  });

  it('has correct default values', () => {
    const config = loadConfig({ licenseKey: 'key', appName: 'app' });

    expect(config.enabled).toBe(true);
    expect(config.recordContent).toBe(false);
    expect(config.costTrackingEnabled).toBe(true);
    expect(config.qualityTrackingEnabled).toBe(true);
    expect(config.conversationTrackingEnabled).toBe(true);
    expect(config.thinkingTrackingEnabled).toBe(true);
    expect(config.customPricingFile).toBeNull();
    expect(config.contentMaxLength).toBe(4096);
    expect(config.highSecurity).toBe(false);
    expect(config.logLevel).toBe('info');
    expect(config.collectorHost).toBeNull();
  });

  it('maps all env vars to config fields', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'key';
    process.env.NEW_RELIC_APP_NAME = 'app';
    process.env.NEW_RELIC_AI_ENABLED = 'false';
    process.env.NEW_RELIC_AI_RECORD_CONTENT = 'true';
    process.env.NEW_RELIC_AI_COST_TRACKING = 'false';
    process.env.NEW_RELIC_AI_QUALITY_TRACKING = 'false';
    process.env.NEW_RELIC_AI_CONVERSATION_TRACKING = 'false';
    process.env.NEW_RELIC_AI_THINKING_TRACKING = 'false';
    process.env.NEW_RELIC_AI_CUSTOM_PRICING_FILE = '/path/to/pricing.json';
    process.env.NEW_RELIC_AI_CONTENT_MAX_LENGTH = '8192';
    process.env.NEW_RELIC_AI_LOG_LEVEL = 'debug';
    process.env.NEW_RELIC_HOST = 'collector.eu.newrelic.com';

    const config = loadConfig();

    expect(config.enabled).toBe(false);
    expect(config.recordContent).toBe(true);
    expect(config.costTrackingEnabled).toBe(false);
    expect(config.qualityTrackingEnabled).toBe(false);
    expect(config.conversationTrackingEnabled).toBe(false);
    expect(config.thinkingTrackingEnabled).toBe(false);
    expect(config.customPricingFile).toBe('/path/to/pricing.json');
    expect(config.contentMaxLength).toBe(8192);
    expect(config.logLevel).toBe('debug');
    expect(config.collectorHost).toBe('collector.eu.newrelic.com');
  });

  it('highSecurity=true forces recordContent=false even if explicitly set', () => {
    const config = loadConfig({
      licenseKey: 'key',
      appName: 'app',
      highSecurity: true,
      recordContent: true,
    });

    expect(config.highSecurity).toBe(true);
    expect(config.recordContent).toBe(false);
  });

  it('highSecurity via env var forces recordContent=false', () => {
    process.env.NEW_RELIC_AI_HIGH_SECURITY = 'true';
    process.env.NEW_RELIC_AI_RECORD_CONTENT = 'true';

    const config = loadConfig({ licenseKey: 'key', appName: 'app' });

    expect(config.highSecurity).toBe(true);
    expect(config.recordContent).toBe(false);
  });

  it('returns a frozen config object', () => {
    const config = loadConfig({ licenseKey: 'key', appName: 'app' });

    expect(Object.isFrozen(config)).toBe(true);
  });

  it('handles invalid env var values gracefully', () => {
    process.env.NEW_RELIC_AI_CONTENT_MAX_LENGTH = 'not-a-number';
    process.env.NEW_RELIC_AI_LOG_LEVEL = 'garbage';

    const config = loadConfig({ licenseKey: 'key', appName: 'app' });

    expect(config.contentMaxLength).toBe(4096);
    expect(config.logLevel).toBe('info');
  });

  // S-03: accountId format validation
  it('throws when accountId contains path-traversal characters', () => {
    expect(() =>
      loadConfig({ licenseKey: 'key', appName: 'app', accountId: '123/../other' }),
    ).toThrow('NEW_RELIC_ACCOUNT_ID must be 1–12 decimal digits');
  });

  it('throws when accountId is non-numeric', () => {
    expect(() =>
      loadConfig({ licenseKey: 'key', appName: 'app', accountId: 'abc' }),
    ).toThrow('NEW_RELIC_ACCOUNT_ID must be 1–12 decimal digits');
  });

  it('throws when accountId exceeds 12 digits', () => {
    expect(() =>
      loadConfig({ licenseKey: 'key', appName: 'app', accountId: '1234567890123' }),
    ).toThrow('NEW_RELIC_ACCOUNT_ID must be 1–12 decimal digits');
  });

  it('throws when accountId from env var is invalid', () => {
    process.env.NEW_RELIC_ACCOUNT_ID = '123/evil';
    expect(() => loadConfig({ licenseKey: 'key', appName: 'app' })).toThrow(
      'NEW_RELIC_ACCOUNT_ID must be 1–12 decimal digits',
    );
  });

  it('accepts a valid numeric accountId', () => {
    const config = loadConfig({ licenseKey: 'key', appName: 'app', accountId: '12345' });
    expect(config.accountId).toBe('12345');
  });

  it('accepts null accountId without validation', () => {
    const config = loadConfig({ licenseKey: 'key', appName: 'app', accountId: null });
    expect(config.accountId).toBeNull();
  });

  // S-06: envInt bounds clamping
  it('clamps contentMaxLength to minimum 1 when env var is 0 or negative', () => {
    process.env.NEW_RELIC_AI_CONTENT_MAX_LENGTH = '0';
    const config = loadConfig({ licenseKey: 'key', appName: 'app' });
    expect(config.contentMaxLength).toBe(1);
  });

  it('clamps contentMaxLength to minimum 1 when env var is negative', () => {
    process.env.NEW_RELIC_AI_CONTENT_MAX_LENGTH = '-500';
    const config = loadConfig({ licenseKey: 'key', appName: 'app' });
    expect(config.contentMaxLength).toBe(1);
  });

  it('clamps contentMaxLength to maximum 1_048_576 when env var exceeds it', () => {
    process.env.NEW_RELIC_AI_CONTENT_MAX_LENGTH = '9999999';
    const config = loadConfig({ licenseKey: 'key', appName: 'app' });
    expect(config.contentMaxLength).toBe(1_048_576);
  });

  it('accepts valid contentMaxLength within bounds', () => {
    process.env.NEW_RELIC_AI_CONTENT_MAX_LENGTH = '8192';
    const config = loadConfig({ licenseKey: 'key', appName: 'app' });
    expect(config.contentMaxLength).toBe(8192);
  });

  it('accepts 1/0 as boolean env var values', () => {
    process.env.NEW_RELIC_AI_ENABLED = '0';
    process.env.NEW_RELIC_AI_HIGH_SECURITY = '1';

    const config = loadConfig({ licenseKey: 'key', appName: 'app' });

    expect(config.enabled).toBe(false);
    expect(config.highSecurity).toBe(true);
  });
});
