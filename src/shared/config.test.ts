import { loadConfig } from './config.js';
import { __resetLogLevelCache } from './logger.js';
import { getLogOutput } from './__test-utils__/log-output.js';

describe('loadConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    // Env-resolved log level is cached on first use; clear
    // it so per-test NEW_RELIC_AI_LOG_LEVEL changes are observable.
    __resetLogLevelCache();
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
    delete process.env.NEW_RELIC_ACCOUNT_ID;
    delete process.env.NEW_RELIC_AI_ATTRIBUTION_FEATURE;
    delete process.env.NEW_RELIC_AI_ATTRIBUTION_TEAM;
    delete process.env.NEW_RELIC_AI_ATTRIBUTION_USER;
    delete process.env.NEW_RELIC_AI_ATTRIBUTION_ENVIRONMENT;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    delete process.env.NEW_RELIC_AI_TRANSPORT;

    // `loadConfig` now requires accountId when transport is
    // 'nr-events-api' or 'both' (the default is 'nr-events-api'). Most tests
    // here exercise non-accountId, non-transport behavior, so set a default
    // accountId in env to keep them focused. Tests that need accountId=null
    // explicitly opt into 'transport: otlp', and the F3-specific tests below
    // delete this env var inline before asserting the throw.
    process.env.NEW_RELIC_ACCOUNT_ID = '999999';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('throws when NEW_RELIC_LICENSE_KEY is missing', () => {
    expect(() => loadConfig({ appName: 'test-app' })).toThrow('NEW_RELIC_LICENSE_KEY');
  });

  // license key format validation
  it('throws when license key is too short', () => {
    expect(() => loadConfig({ licenseKey: 'short', appName: 'app' })).toThrow('printable ASCII');
  });

  it('throws when license key contains whitespace', () => {
    expect(() => loadConfig({ licenseKey: 'us01xxKEY WITH SPACE INSIDE', appName: 'app' })).toThrow(
      'printable ASCII',
    );
  });

  it('throws when license key contains a CR/LF (header injection guard)', () => {
    expect(() =>
      loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234\r\nX-Evil: y', appName: 'app' }),
    ).toThrow('printable ASCII');
  });

  it('strips leading/trailing whitespace from license key (cat-pipe newlines)', () => {
    const config = loadConfig({
      licenseKey: '  us01xxFAKEKEYFORTESTSONLY1234\n',
      appName: 'app',
    });
    expect(config.licenseKey).toBe('us01xxFAKEKEYFORTESTSONLY1234');
  });

  it('throws when NEW_RELIC_APP_NAME is missing', () => {
    expect(() => loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234' })).toThrow(
      'NEW_RELIC_APP_NAME',
    );
  });

  it('throws when appName contains a newline (header injection guard)', () => {
    expect(() =>
      loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'my-app\nX-Evil: y' }),
    ).toThrow('control characters');
  });

  it('throws when appName contains a null byte', () => {
    expect(() =>
      loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'my-app\x00' }),
    ).toThrow('control characters');
  });

  it('throws when appName exceeds 255 characters', () => {
    expect(() =>
      loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'a'.repeat(256) }),
    ).toThrow('control characters');
  });

  it('accepts appName exactly 255 characters', () => {
    const longName = 'a'.repeat(255);
    const config = loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: longName });
    expect(config.appName).toBe(longName);
  });

  it('loads required fields from env vars', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'us01xxFAKEKEYFORTESTSONLY1234';
    process.env.NEW_RELIC_APP_NAME = 'my-app';

    const config = loadConfig();

    expect(config.licenseKey).toBe('us01xxFAKEKEYFORTESTSONLY1234');
    expect(config.appName).toBe('my-app');
  });

  it('overrides take precedence over env vars', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'us01xxFAKEENVKEYFORTESTSONLY';
    process.env.NEW_RELIC_APP_NAME = 'env-app';

    const config = loadConfig({
      licenseKey: 'us01xxFAKEOVRKEYFORTESTSONLY',
      appName: 'override-app',
    });

    expect(config.licenseKey).toBe('us01xxFAKEOVRKEYFORTESTSONLY');
    expect(config.appName).toBe('override-app');
  });

  it('has correct default values', () => {
    const config = loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' });

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
    expect(config.clientName).toBe('ai-telemetry');
    expect(config.clientVersion).toBe('');
  });

  it('maps all env vars to config fields', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'us01xxFAKEKEYFORTESTSONLY1234';
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

  it('reads clientName and clientVersion from env vars', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'us01xxFAKEKEYFORTESTSONLY1234';
    process.env.NEW_RELIC_APP_NAME = 'app';
    process.env.NEW_RELIC_AI_CLIENT_NAME = 'preflight';
    process.env.NEW_RELIC_AI_CLIENT_VERSION = '1.2.3';

    const config = loadConfig();

    expect(config.clientName).toBe('preflight');
    expect(config.clientVersion).toBe('1.2.3');
  });

  it('strips control characters from clientVersion', () => {
    const config = loadConfig({
      licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234',
      appName: 'app',
      clientVersion: '1.2.3\n',
    });

    expect(config.clientVersion).toBe('1.2.3');
  });

  it('strips control characters from clientName', () => {
    const config = loadConfig({
      licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234',
      appName: 'app',
      clientName: 'preflight\r\n',
    });

    expect(config.clientName).toBe('preflight');
  });

  it('trims whitespace-only clientVersion to empty string', () => {
    const config = loadConfig({
      licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234',
      appName: 'app',
      clientVersion: '   ',
    });

    expect(config.clientVersion).toBe('');
  });

  it('trims leading/trailing spaces from clientVersion', () => {
    const config = loadConfig({
      licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234',
      appName: 'app',
      clientVersion: ' 1.2.3 ',
    });

    expect(config.clientVersion).toBe('1.2.3');
  });

  it('empty-string clientVersion override suppresses env var', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'us01xxFAKEKEYFORTESTSONLY1234';
    process.env.NEW_RELIC_APP_NAME = 'app';
    process.env.NEW_RELIC_AI_CLIENT_VERSION = '9.9.9';

    const config = loadConfig({ clientVersion: '' });

    expect(config.clientVersion).toBe('');
  });

  it('empty-string clientName override suppresses env var and falls back to default name', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'us01xxFAKEKEYFORTESTSONLY1234';
    process.env.NEW_RELIC_APP_NAME = 'app';
    process.env.NEW_RELIC_AI_CLIENT_NAME = 'preflight';

    const config = loadConfig({ clientName: '' });

    // '' suppresses the env var (env value 'preflight' is not used), but after
    // sanitization the empty result falls back to DEFAULT_CLIENT_NAME so
    // config.clientName is always a non-empty string.
    expect(config.clientName).toBe('ai-telemetry');
  });

  it('override wins over env var for clientName and clientVersion', () => {
    process.env.NEW_RELIC_LICENSE_KEY = 'us01xxFAKEKEYFORTESTSONLY1234';
    process.env.NEW_RELIC_APP_NAME = 'app';
    process.env.NEW_RELIC_AI_CLIENT_NAME = 'from-env';
    process.env.NEW_RELIC_AI_CLIENT_VERSION = '9.9.9';

    const config = loadConfig({ clientName: 'from-override', clientVersion: '1.0.0' });

    expect(config.clientName).toBe('from-override');
    expect(config.clientVersion).toBe('1.0.0');
  });

  it('highSecurity=true forces recordContent=false even if explicitly set', () => {
    const config = loadConfig({
      licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234',
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

    const config = loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' });

    expect(config.highSecurity).toBe(true);
    expect(config.recordContent).toBe(false);
  });

  it('returns a frozen config object', () => {
    const config = loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' });

    expect(Object.isFrozen(config)).toBe(true);
  });

  // nested objects must also be frozen
  it('deep-freezes attributionDefaults and otlpHeaders', () => {
    const config = loadConfig({
      licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234',
      appName: 'app',
      attributionDefaults: { team: 'backend' },
      otlpHeaders: { 'api-key': 'secret' },
    });

    expect(Object.isFrozen(config.attributionDefaults)).toBe(true);
    expect(Object.isFrozen(config.otlpHeaders)).toBe(true);
  });

  it('handles invalid env var values gracefully', () => {
    process.env.NEW_RELIC_AI_CONTENT_MAX_LENGTH = 'not-a-number';
    process.env.NEW_RELIC_AI_LOG_LEVEL = 'garbage';

    const config = loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' });

    expect(config.contentMaxLength).toBe(4096);
    expect(config.logLevel).toBe('info');
  });

  it('emits a warn log when NEW_RELIC_AI_LOG_LEVEL is unrecognized', () => {
    process.env.NEW_RELIC_AI_LOG_LEVEL = 'verbose';
    const stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' });
    const output = stderrSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(output).toMatch(/unrecognized log level/);
    stderrSpy.mockRestore();
  });

  it('trims whitespace from NEW_RELIC_AI_LOG_LEVEL', () => {
    process.env.NEW_RELIC_AI_LOG_LEVEL = ' debug ';
    const config = loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' });
    expect(config.logLevel).toBe('debug');
  });

  it('empty-string collectorHost override normalizes to null', () => {
    process.env.NEW_RELIC_HOST = 'collector.newrelic.com';
    const config = loadConfig({
      licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234',
      appName: 'app',
      collectorHost: '',
    });
    // Empty string override → normalized to null (not ''), which is different
    // from undefined which would fall through to the env var
    expect(config.collectorHost).toBeNull();
  });

  it('null collectorHost override wins over env var', () => {
    process.env.NEW_RELIC_HOST = 'collector.newrelic.com';
    const config = loadConfig({
      licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234',
      appName: 'app',
      collectorHost: null,
    });
    expect(config.collectorHost).toBeNull(); // explicit null wins over env var
  });

  // S-03: accountId format validation (relaxed to
  // positive integer with no leading zeros; upper bound enforced server-side)
  it('throws when accountId contains path-traversal characters', () => {
    expect(() =>
      loadConfig({
        licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234',
        appName: 'app',
        accountId: '123/../other',
      }),
    ).toThrow('NEW_RELIC_ACCOUNT_ID must be a positive decimal integer');
  });

  it('throws when accountId is non-numeric', () => {
    expect(() =>
      loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app', accountId: 'abc' }),
    ).toThrow('NEW_RELIC_ACCOUNT_ID must be a positive decimal integer');
  });

  it('accepts accountIds longer than 12 digits (NR may issue 13+ in the future)', () => {
    // The prior /^\d{1,12}$/ cap forced a library bump
    // every time NR widened the account-ID space. Validation now accepts
    // any positive decimal integer length; server-side enforces the real bound.
    const config = loadConfig({
      licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234',
      appName: 'app',
      accountId: '1234567890123',
    });
    expect(config.accountId).toBe('1234567890123');
  });

  it('throws when accountId is "0"', () => {
    // "0" passed the old regex but is not a real NR
    // account ID. New positive-integer validation rejects it.
    expect(() =>
      loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app', accountId: '0' }),
    ).toThrow('NEW_RELIC_ACCOUNT_ID must be a positive decimal integer');
  });

  it('throws when accountId has leading zeros (e.g. "07", "00123")', () => {
    // Leading-zero strings passed the old regex but no
    // NR account uses leading zeros; they almost always indicate config drift.
    expect(() =>
      loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app', accountId: '07' }),
    ).toThrow('NEW_RELIC_ACCOUNT_ID must be a positive decimal integer');
    expect(() =>
      loadConfig({
        licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234',
        appName: 'app',
        accountId: '00123',
      }),
    ).toThrow('NEW_RELIC_ACCOUNT_ID must be a positive decimal integer');
  });

  it('throws when accountId from env var is invalid', () => {
    process.env.NEW_RELIC_ACCOUNT_ID = '123/evil';
    expect(() =>
      loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' }),
    ).toThrow('NEW_RELIC_ACCOUNT_ID must be a positive decimal integer');
  });

  it('accepts a valid numeric accountId', () => {
    const config = loadConfig({
      licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234',
      appName: 'app',
      accountId: '12345',
    });
    expect(config.accountId).toBe('12345');
  });

  // null accountId is acceptable ONLY for the OTLP transport.
  // For 'nr-events-api' or 'both', loadConfig fails fast (the URL would
  // otherwise become .../accounts/null/events and silently 404 every batch).
  it('accepts null accountId in OTLP-only transport mode', () => {
    delete process.env.NEW_RELIC_ACCOUNT_ID;
    const config = loadConfig({
      licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234',
      appName: 'app',
      accountId: null,
      transport: 'otlp',
    });
    expect(config.accountId).toBeNull();
  });

  it('accountId: null override wins over env var — explicit null is honored', () => {
    // Pre-fix: null fell through `??` to the env var and was silently ignored.
    process.env.NEW_RELIC_ACCOUNT_ID = '99999';
    const config = loadConfig({
      licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234',
      appName: 'app',
      accountId: null,
      transport: 'otlp',
    });
    expect(config.accountId).toBeNull(); // override wins, not '99999'
  });

  // null accountId is valid for OTLP-only; for nr-events-api
  // or both it must throw (the URL would become .../accounts/null/... and 404).
  it('throws when accountId is null and transport defaults to nr-events-api', () => {
    delete process.env.NEW_RELIC_ACCOUNT_ID;
    expect(() =>
      loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app', accountId: null }),
    ).toThrow('NEW_RELIC_ACCOUNT_ID');
  });

  it('throws when accountId is null and transport is "both"', () => {
    delete process.env.NEW_RELIC_ACCOUNT_ID;
    expect(() =>
      loadConfig({
        licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234',
        appName: 'app',
        accountId: null,
        transport: 'both',
      }),
    ).toThrow('NEW_RELIC_ACCOUNT_ID');
  });

  it('throws when accountId is missing entirely (no env, no override) and transport defaults to nr-events-api', () => {
    delete process.env.NEW_RELIC_ACCOUNT_ID;
    expect(() =>
      loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' }),
    ).toThrow('NEW_RELIC_ACCOUNT_ID');
  });

  // S-06: envInt bounds clamping
  it('clamps contentMaxLength to minimum 1 when env var is 0 or negative', () => {
    process.env.NEW_RELIC_AI_CONTENT_MAX_LENGTH = '0';
    const config = loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' });
    expect(config.contentMaxLength).toBe(1);
  });

  it('clamps contentMaxLength to minimum 1 when env var is negative', () => {
    process.env.NEW_RELIC_AI_CONTENT_MAX_LENGTH = '-500';
    const config = loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' });
    expect(config.contentMaxLength).toBe(1);
  });

  it('clamps contentMaxLength to maximum 1_048_576 when env var exceeds it', () => {
    process.env.NEW_RELIC_AI_CONTENT_MAX_LENGTH = '9999999';
    const config = loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' });
    expect(config.contentMaxLength).toBe(1_048_576);
  });

  it('accepts valid contentMaxLength within bounds', () => {
    process.env.NEW_RELIC_AI_CONTENT_MAX_LENGTH = '8192';
    const config = loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' });
    expect(config.contentMaxLength).toBe(8192);
  });

  it('rejects trailing garbage in envInt values and falls back to default', () => {
    // '4kb' should NOT silently become 4 via parseInt
    process.env.NEW_RELIC_AI_CONTENT_MAX_LENGTH = '4kb';
    const config = loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' });
    expect(config.contentMaxLength).toBe(4096); // default, not 4

    // '1e3' should NOT silently become 1
    process.env.NEW_RELIC_AI_CONTENT_MAX_LENGTH = '1e3';
    const config2 = loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' });
    expect(config2.contentMaxLength).toBe(4096); // default, not 1
  });

  // envInt clamps emit a debug log
  describe('envInt clamp logging', () => {
    let stderrSpy: jest.SpyInstance;
    let originalLogLevel: string | undefined;

    beforeEach(() => {
      originalLogLevel = process.env.NEW_RELIC_AI_LOG_LEVEL;
      process.env.NEW_RELIC_AI_LOG_LEVEL = 'debug';
      // Log level is cached; reset so the new env value applies.
      __resetLogLevelCache();
      stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      stderrSpy.mockRestore();
      if (originalLogLevel === undefined) delete process.env.NEW_RELIC_AI_LOG_LEVEL;
      else process.env.NEW_RELIC_AI_LOG_LEVEL = originalLogLevel;
      __resetLogLevelCache();
    });

    it('logs at debug when an env value is clamped to the upper bound', () => {
      process.env.NEW_RELIC_AI_CONTENT_MAX_LENGTH = '9999999';
      loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' });
      const output = getLogOutput(stderrSpy, '\n');
      expect(output).toContain('NEW_RELIC_AI_CONTENT_MAX_LENGTH');
      expect(output).toContain('clamped to max');
    });

    it('logs at debug when an env value is clamped to the lower bound', () => {
      process.env.NEW_RELIC_AI_CONTENT_MAX_LENGTH = '-500';
      loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' });
      const output = getLogOutput(stderrSpy, '\n');
      expect(output).toContain('NEW_RELIC_AI_CONTENT_MAX_LENGTH');
      expect(output).toContain('clamped to min');
    });

    it('does not log when env value is within bounds', () => {
      process.env.NEW_RELIC_AI_CONTENT_MAX_LENGTH = '4096';
      loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' });
      const output = getLogOutput(stderrSpy, '\n');
      expect(output).not.toContain('clamped to');
    });
  });

  // envBool accepts yes/no/on/off
  describe('envBool extended truthy/falsy values', () => {
    it.each([
      ['true', true],
      ['TRUE', true],
      ['1', true],
      ['yes', true],
      ['YES', true],
      ['on', true],
      ['On', true],
    ])('accepts %s as true', (envValue, expected) => {
      process.env.NEW_RELIC_AI_HIGH_SECURITY = envValue;
      const config = loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' });
      expect(config.highSecurity).toBe(expected);
    });

    it.each([
      ['false', false],
      ['FALSE', false],
      ['0', false],
      ['no', false],
      ['NO', false],
      ['off', false],
      ['Off', false],
    ])('accepts %s as false', (envValue, expected) => {
      process.env.NEW_RELIC_AI_HIGH_SECURITY = 'true'; // start true
      const config1 = loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' });
      expect(config1.highSecurity).toBe(true);

      process.env.NEW_RELIC_AI_HIGH_SECURITY = envValue;
      const config2 = loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' });
      expect(config2.highSecurity).toBe(expected);
    });

    it('falls back to default for unrecognized values', () => {
      process.env.NEW_RELIC_AI_HIGH_SECURITY = 'maybe';
      // Default for highSecurity is false.
      const config = loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' });
      expect(config.highSecurity).toBe(false);
    });

    it('logs at debug when an unrecognized boolean is encountered', () => {
      const originalLogLevel = process.env.NEW_RELIC_AI_LOG_LEVEL;
      process.env.NEW_RELIC_AI_LOG_LEVEL = 'debug';
      __resetLogLevelCache();
      const stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      process.env.NEW_RELIC_AI_HIGH_SECURITY = 'definitely-not-a-bool';
      loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' });

      const output = getLogOutput(stderrSpy, '\n');
      expect(output).toContain('NEW_RELIC_AI_HIGH_SECURITY');
      expect(output).toContain('unrecognized boolean value');

      stderrSpy.mockRestore();
      if (originalLogLevel === undefined) delete process.env.NEW_RELIC_AI_LOG_LEVEL;
      else process.env.NEW_RELIC_AI_LOG_LEVEL = originalLogLevel;
      __resetLogLevelCache();
    });

    it('trims whitespace around the value', () => {
      process.env.NEW_RELIC_AI_HIGH_SECURITY = '  yes  ';
      const config = loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' });
      expect(config.highSecurity).toBe(true);
    });
  });

  // parseOtlpHeaders should follow OTel spec
  describe('OTLP headers parsing', () => {
    it('parses simple key=value pairs', () => {
      process.env.OTEL_EXPORTER_OTLP_HEADERS = 'api-key=abc123,x-trace=on';
      const config = loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' });
      expect(config.otlpHeaders).toEqual({ 'api-key': 'abc123', 'x-trace': 'on' });
    });

    it('preserves "=" inside values (e.g. base64 padding) via percent-encoding', () => {
      process.env.OTEL_EXPORTER_OTLP_HEADERS = 'auth=Bearer%20abc%3Dxyz';
      const config = loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' });
      expect(config.otlpHeaders).toEqual({ auth: 'Bearer abc=xyz' });
    });

    it('preserves "," inside values via %2C encoding', () => {
      process.env.OTEL_EXPORTER_OTLP_HEADERS = 'x-list=a%2Cb%2Cc';
      const config = loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' });
      expect(config.otlpHeaders).toEqual({ 'x-list': 'a,b,c' });
    });

    it('strips whitespace from keys but NOT from values (OTel spec)', () => {
      // OTel spec: trim key whitespace; do NOT trim value whitespace.
      process.env.OTEL_EXPORTER_OTLP_HEADERS = ' key1 = val1 ,key2= val2';
      const config = loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' });
      // Keys are trimmed (' key1 ' → 'key1', 'key2' stays).
      // Values are NOT trimmed (' val1 ' stays, ' val2' stays).
      expect(config.otlpHeaders).toEqual({ key1: ' val1 ', key2: ' val2' });
    });

    it('skips entries with empty key or missing "="', () => {
      process.env.OTEL_EXPORTER_OTLP_HEADERS = 'noequals,=onlyvalue,key=val';
      const config = loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' });
      expect(config.otlpHeaders).toEqual({ key: 'val' });
    });

    it('falls back to raw value on malformed percent-encoding', () => {
      process.env.OTEL_EXPORTER_OTLP_HEADERS = 'key=abc%';
      const config = loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' });
      expect(config.otlpHeaders).toEqual({ key: 'abc%' });
    });

    it('warns when percent-encoding in value is malformed', () => {
      const warnSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      process.env.OTEL_EXPORTER_OTLP_HEADERS = 'Authorization=Bearer%ZZtoken';
      loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' });
      const logs = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(logs.some((l) => l.includes('malformed percent-encoding in value'))).toBe(true);
      warnSpy.mockRestore();
    });

    // Keys must be percent-decoded too. Headers names
    // rarely need encoding in practice (they're usually plain ASCII tokens),
    // but the OTel spec applies the same encoding rules to both sides of
    // the `=` and the parser must honor that for spec compliance.
    it('percent-decodes the key as well as the value', () => {
      process.env.OTEL_EXPORTER_OTLP_HEADERS = 'x-tag%2Dname=val';
      const config = loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' });
      expect(config.otlpHeaders).toEqual({ 'x-tag-name': 'val' });
    });

    it('falls back to raw key on malformed percent-encoding in key', () => {
      process.env.OTEL_EXPORTER_OTLP_HEADERS = 'bad%key=val';
      const config = loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' });
      expect(config.otlpHeaders).toEqual({ 'bad%key': 'val' });
    });

    it('warns when percent-encoding in key is malformed', () => {
      const warnSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      process.env.OTEL_EXPORTER_OTLP_HEADERS = 'bad%key=val';
      loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' });
      const logs = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(logs.some((l) => l.includes('malformed percent-encoding in key'))).toBe(true);
      warnSpy.mockRestore();
    });
  });

  // buildAttributionDefaults coverage
  describe('attributionDefaults', () => {
    it('returns null when no env vars or overrides are set', () => {
      const config = loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' });
      expect(config.attributionDefaults).toBeNull();
    });

    it('builds attributionDefaults from env vars', () => {
      process.env.NEW_RELIC_AI_ATTRIBUTION_FEATURE = 'checkout';
      process.env.NEW_RELIC_AI_ATTRIBUTION_TEAM = 'payments';
      process.env.NEW_RELIC_AI_ATTRIBUTION_USER = 'svc-account';
      process.env.NEW_RELIC_AI_ATTRIBUTION_ENVIRONMENT = 'prod';

      const config = loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' });

      expect(config.attributionDefaults).toEqual({
        feature: 'checkout',
        team: 'payments',
        user: 'svc-account',
        environment: 'prod',
      });
    });

    it('passing undefined for a key in attributionDefaults clears an env-set default', () => {
      process.env.NEW_RELIC_AI_ATTRIBUTION_FEATURE = 'env-feature';
      process.env.NEW_RELIC_AI_ATTRIBUTION_TEAM = 'env-team';

      const config = loadConfig({
        licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234',
        appName: 'app',
        attributionDefaults: { feature: undefined },
      });

      // feature was set by env but cleared by the override; team survives
      expect(config.attributionDefaults).toEqual({ team: 'env-team' });
      expect(Object.keys(config.attributionDefaults ?? {})).not.toContain('feature');
    });

    it('override attributionDefaults win over env vars on overlapping keys', () => {
      process.env.NEW_RELIC_AI_ATTRIBUTION_FEATURE = 'env-feature';
      process.env.NEW_RELIC_AI_ATTRIBUTION_TEAM = 'env-team';

      const config = loadConfig({
        licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234',
        appName: 'app',
        attributionDefaults: { feature: 'override-feature', extra: 'custom' },
      });

      expect(config.attributionDefaults).toEqual({
        feature: 'override-feature', // override wins
        team: 'env-team', // env-only key preserved
        extra: 'custom', // override-only key added
      });
    });
  });

  // transport field default + override
  describe('transport', () => {
    it("defaults to 'nr-events-api'", () => {
      const config = loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' });
      expect(config.transport).toBe('nr-events-api');
    });

    it("accepts 'otlp' override", () => {
      const config = loadConfig({
        licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234',
        appName: 'app',
        transport: 'otlp',
      });
      expect(config.transport).toBe('otlp');
    });

    it("accepts 'both' override", () => {
      const config = loadConfig({
        licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234',
        appName: 'app',
        transport: 'both',
      });
      expect(config.transport).toBe('both');
    });

    // env-var support for transport
    it("reads NEW_RELIC_AI_TRANSPORT='otlp' from env", () => {
      process.env.NEW_RELIC_AI_TRANSPORT = 'otlp';
      const config = loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' });
      expect(config.transport).toBe('otlp');
      delete process.env.NEW_RELIC_AI_TRANSPORT;
    });

    it("reads NEW_RELIC_AI_TRANSPORT='both' from env", () => {
      process.env.NEW_RELIC_AI_TRANSPORT = 'both';
      const config = loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' });
      expect(config.transport).toBe('both');
      delete process.env.NEW_RELIC_AI_TRANSPORT;
    });

    it("reads NEW_RELIC_AI_TRANSPORT='nr-events-api' from env", () => {
      process.env.NEW_RELIC_AI_TRANSPORT = 'nr-events-api';
      const config = loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' });
      expect(config.transport).toBe('nr-events-api');
      delete process.env.NEW_RELIC_AI_TRANSPORT;
    });

    it('overrides override the env var', () => {
      process.env.NEW_RELIC_AI_TRANSPORT = 'otlp';
      const config = loadConfig({
        licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234',
        appName: 'app',
        transport: 'nr-events-api',
      });
      expect(config.transport).toBe('nr-events-api');
      delete process.env.NEW_RELIC_AI_TRANSPORT;
    });

    it('falls back to default when env var is unrecognized', () => {
      process.env.NEW_RELIC_AI_TRANSPORT = 'something-else';
      const config = loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' });
      expect(config.transport).toBe('nr-events-api');
      delete process.env.NEW_RELIC_AI_TRANSPORT;
    });

    it('logs at debug when env var is unrecognized', () => {
      const originalLogLevel = process.env.NEW_RELIC_AI_LOG_LEVEL;
      process.env.NEW_RELIC_AI_LOG_LEVEL = 'debug';
      __resetLogLevelCache();
      const stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      process.env.NEW_RELIC_AI_TRANSPORT = 'invalid-transport';
      loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' });

      const output = getLogOutput(stderrSpy, '\n');
      expect(output).toContain('NEW_RELIC_AI_TRANSPORT');
      expect(output).toContain('unrecognized transport');

      stderrSpy.mockRestore();
      delete process.env.NEW_RELIC_AI_TRANSPORT;
      if (originalLogLevel === undefined) delete process.env.NEW_RELIC_AI_LOG_LEVEL;
      else process.env.NEW_RELIC_AI_LOG_LEVEL = originalLogLevel;
      __resetLogLevelCache();
    });

    it('trims whitespace and is case-insensitive', () => {
      process.env.NEW_RELIC_AI_TRANSPORT = '  OTLP  ';
      const config = loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' });
      expect(config.transport).toBe('otlp');
      delete process.env.NEW_RELIC_AI_TRANSPORT;
    });
  });

  // otlpEndpoint env var + override
  describe('otlpEndpoint', () => {
    it('defaults to null when no env var or override is set', () => {
      const config = loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' });
      expect(config.otlpEndpoint).toBeNull();
    });

    it('reads OTEL_EXPORTER_OTLP_ENDPOINT env var', () => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://otlp.example.com:4318';
      const config = loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' });
      expect(config.otlpEndpoint).toBe('https://otlp.example.com:4318');
    });

    it('override takes precedence over env var', () => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://env.example.com:4318';
      const config = loadConfig({
        licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234',
        appName: 'app',
        otlpEndpoint: 'https://override.example.com:4318',
      });
      expect(config.otlpEndpoint).toBe('https://override.example.com:4318');
    });

    it('empty-string env var is treated as null for string-or-null fields', () => {
      // `export OTEL_EXPORTER_OTLP_ENDPOINT=` in a shell produces ''
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = '';
      process.env.NEW_RELIC_HOST = '';
      process.env.NEW_RELIC_AI_CUSTOM_PRICING_FILE = '';
      const config = loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' });
      expect(config.otlpEndpoint).toBeNull();
      expect(config.collectorHost).toBeNull();
      expect(config.customPricingFile).toBeNull();
    });
  });

  it('accepts 1/0 as boolean env var values', () => {
    process.env.NEW_RELIC_AI_ENABLED = '0';
    process.env.NEW_RELIC_AI_HIGH_SECURITY = '1';

    const config = loadConfig({ licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234', appName: 'app' });

    expect(config.enabled).toBe(false);
    expect(config.highSecurity).toBe(true);
  });
});
