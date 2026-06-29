import { redact, safeForLog } from './redact.js';
import { loadConfig } from './config.js';

describe('redact', () => {
  it('returns primitives unchanged', () => {
    expect(redact('hello')).toBe('hello');
    expect(redact(42)).toBe(42);
    expect(redact(true)).toBe(true);
    expect(redact(null)).toBe(null);
    expect(redact(undefined)).toBe(undefined);
  });

  it('replaces values under secret-shaped keys with ***', () => {
    const input = {
      licenseKey: 'us01xxSECRET123',
      apiToken: 'tk_abc',
      password: 'p@ssw0rd',
      Authorization: 'Bearer xyz',
      bearer: 'tok',
      credentials: { user: 'a', pass: 'b' },
      normalField: 'visible',
    };
    const out = redact(input) as typeof input;
    expect(out.licenseKey).toBe('***');
    expect(out.apiToken).toBe('***');
    expect(out.password).toBe('***');
    expect(out.Authorization).toBe('***');
    expect(out.bearer).toBe('***');
    expect(out.credentials).toBe('***'); // entire object replaced when key matches
    expect(out.normalField).toBe('visible');
  });

  it('matches secret keys case-insensitively', () => {
    const out = redact({ API_KEY: 'x', PassWord: 'y', AccessToken: 'z' }) as Record<string, string>;
    expect(out.API_KEY).toBe('***');
    expect(out.PassWord).toBe('***');
    expect(out.AccessToken).toBe('***');
  });

  it('preserves null/undefined under secret keys (does not stringify)', () => {
    const out = redact({ apiKey: null, token: undefined }) as Record<string, unknown>;
    expect(out.apiKey).toBeNull();
    expect(out.token).toBeUndefined();
  });

  it('walks nested objects', () => {
    const input = {
      config: {
        host: 'example.com',
        nested: { secret: 'hidden' },
      },
    };
    const out = redact(input) as typeof input;
    expect(out.config.host).toBe('example.com');
    expect((out.config.nested as { secret: string }).secret).toBe('***');
  });

  it('walks arrays', () => {
    const input = [
      { name: 'a', token: 't1' },
      { name: 'b', token: 't2' },
    ];
    const out = redact(input);
    expect(out[0].name).toBe('a');
    expect(out[0].token).toBe('***');
    expect(out[1].token).toBe('***');
  });

  it('returns a copy, not the original', () => {
    const input = { apiKey: 'x', other: 'y' };
    const out = redact(input);
    expect(out).not.toBe(input);
    expect(input.apiKey).toBe('x'); // original unchanged
  });

  it('handles circular references safely', () => {
    const input: Record<string, unknown> = { a: 1 };
    input.self = input;
    expect(() => redact(input)).not.toThrow();
    const out = redact(input) as Record<string, unknown>;
    expect(out.a).toBe(1);
    expect(out.self).toBe('[circular]');
  });

  it('walks DAG-shaped objects (shared reference at sibling positions) without false [circular]', () => {
    const shared = { value: 42 };
    const input = { x: shared, y: shared };
    const out = redact(input) as typeof input;
    expect(out.x).toEqual({ value: 42 });
    expect(out.y).toEqual({ value: 42 });
    expect(out.x).not.toBe('[circular]');
    expect(out.y).not.toBe('[circular]');
  });

  it('truncates very deep nesting (20 levels exceeds MAX_DEPTH=8)', () => {
    // INVARIANT: 20 > MAX_DEPTH (currently 8). If MAX_DEPTH is raised above 20,
    // this test will fail because '[max-depth]' is never reached, making the
    // regression visible. Keep 20 comfortably above MAX_DEPTH to ensure truncation.
    let deep: Record<string, unknown> = { leaf: 'bottom' };
    for (let i = 0; i < 20; i++) deep = { nested: deep };
    const out = redact(deep) as Record<string, unknown>;
    let cursor: unknown = out;
    let depth = 0;
    while (
      cursor &&
      typeof cursor === 'object' &&
      'nested' in (cursor as Record<string, unknown>)
    ) {
      cursor = (cursor as Record<string, unknown>).nested;
      depth++;
      if (depth > 30) break;
    }
    // Eventually we hit '[max-depth]' rather than infinite recursion
    expect(typeof cursor === 'string' && cursor === '[max-depth]').toBe(true);
  });

  it('does not mistake non-secret keys for secrets', () => {
    const input = { model: 'claude-opus-4-7', name: 'foo', bucket: 'b' };
    const out = redact(input) as typeof input;
    expect(out.model).toBe('claude-opus-4-7');
    expect(out.name).toBe('foo');
    expect(out.bucket).toBe('b');
  });

  it('preserves keys (plural) — does not redact it as a secret key', () => {
    const out = redact({ keys: ['feature-a', 'feature-b'] }) as Record<string, unknown>;
    expect(out.keys).toEqual(['feature-a', 'feature-b']);
  });

  it('preserves apiKey (singular) — still redacted since it IS a secret', () => {
    const out = redact({ apiKey: 'sk-abc' }) as Record<string, string>;
    expect(out.apiKey).toBe('***');
  });

  it('preserves tokenCount, tokenize, tokenAmount — compound token fields must not be redacted', () => {
    const out = redact({ tokenCount: 128, tokenize: true, tokenAmount: 50 }) as Record<
      string,
      unknown
    >;
    expect(out.tokenCount).toBe(128);
    expect(out.tokenize).toBe(true);
    expect(out.tokenAmount).toBe(50);
  });

  it('preserves credentialType, credentialProvider, credentialId — compound credential fields', () => {
    const out = redact({
      credentialType: 'api-key',
      credentialProvider: 'aws',
      credentialId: 'my-cred',
    }) as Record<string, unknown>;
    expect(out.credentialType).toBe('api-key');
    expect(out.credentialProvider).toBe('aws');
    expect(out.credentialId).toBe('my-cred');
  });

  it('still redacts credential and credentials', () => {
    const out = redact({ credential: 'secret', credentials: { user: 'a', pass: 'b' } }) as Record<
      string,
      unknown
    >;
    expect(out.credential).toBe('***');
    expect(out.credentials).toBe('***');
  });

  it('preserves passwordPolicy, passwordStrength — compound password fields', () => {
    const out = redact({ passwordPolicy: 'strong', passwordStrength: 3 }) as Record<
      string,
      unknown
    >;
    expect(out.passwordPolicy).toBe('strong');
    expect(out.passwordStrength).toBe(3);
  });

  it('preserves token-count fields (input_tokens / output_tokens must not be redacted)', () => {
    const input = {
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        prompt_tokens: 80,
        completion_tokens: 20,
        cached_tokens: 30,
        cacheReadTokens: 30,
        cacheCreationTokens: 10,
        thinkingTokens: 5,
      },
    };
    const out = redact(input) as typeof input;
    expect(out.usage.input_tokens).toBe(100);
    expect(out.usage.output_tokens).toBe(50);
    expect(out.usage.total_tokens).toBe(150);
    expect(out.usage.prompt_tokens).toBe(80);
    expect(out.usage.completion_tokens).toBe(20);
    expect(out.usage.cached_tokens).toBe(30);
    expect(out.usage.cacheReadTokens).toBe(30);
    expect(out.usage.cacheCreationTokens).toBe(10);
    expect(out.usage.thinkingTokens).toBe(5);
  });

  it('preserves Date, RegExp, URL, Buffer, Uint8Array values intact', () => {
    const date = new Date('2026-01-01T00:00:00Z');
    const re = /foo/i;
    const url = new URL('https://example.com/path');
    const buf = Buffer.from('hello');
    const u8 = new Uint8Array([1, 2, 3]);
    const out = redact({ date, re, url, buf, u8 }) as Record<string, unknown>;
    expect(out.date).toBe(date);
    expect(out.re).toBe(re);
    expect(out.url).toBe(url);
    expect(out.buf).toBe(buf);
    expect(out.u8).toBe(u8);
  });

  it('summarises Map and Set as [Map(N)] / [Set(N)] instead of {}', () => {
    const m = new Map([['k', 'v']]);
    const s = new Set([1, 2, 3]);
    const out = redact({ m, s }) as Record<string, unknown>;
    expect(out.m).toBe('[Map(1)]');
    expect(out.s).toBe('[Set(3)]');
  });

  it('still redacts singular token fields (apiToken, AccessToken, bare token)', () => {
    const out = redact({
      apiToken: 'secret-1',
      AccessToken: 'secret-2',
      token: 'secret-3',
    }) as Record<string, string>;
    expect(out.apiToken).toBe('***');
    expect(out.AccessToken).toBe('***');
    expect(out.token).toBe('***');
  });
});

// ---------------------------------------------------------------------------
// safeForLog — typed wrapper around redact() for AgentConfig diagnostic dumps
// ---------------------------------------------------------------------------
describe('safeForLog', () => {
  it('redacts licenseKey while preserving non-secret fields', () => {
    const cfg = loadConfig({
      licenseKey: 'us01xx0000000000000000000000000000000NRAL',
      appName: 'my-app',
      accountId: '12345',
      collectorHost: 'collector.newrelic.com',
      transport: 'nr-events-api',
    });
    const safe = safeForLog(cfg);
    expect(safe.licenseKey).toBe('***');
    expect(safe.appName).toBe('my-app');
    expect(safe.accountId).toBe('12345');
    expect(safe.collectorHost).toBe('collector.newrelic.com');
    expect(safe.transport).toBe('nr-events-api');
    expect(safe.recordContent).toBe(false);
    expect(safe.highSecurity).toBe(false);
  });

  it('redacts secret-shaped keys inside otlpHeaders', () => {
    const cfg = loadConfig({
      licenseKey: 'us01xx0000000000000000000000000000000NRAL',
      appName: 'my-app',
      // null accountId requires the otlp transport explicitly.
      accountId: '12345',
      otlpHeaders: {
        Authorization: 'Bearer sk_live_abc',
        'api-key': 'tk_xyz',
        'X-Service-Name': 'visible-name',
      },
    });
    const safe = safeForLog(cfg);
    expect(safe.otlpHeaders.Authorization).toBe('***');
    expect(safe.otlpHeaders['api-key']).toBe('***');
    expect(safe.otlpHeaders['X-Service-Name']).toBe('visible-name');
  });

  it('does not mutate the input config', () => {
    const cfg = loadConfig({
      licenseKey: 'us01xx0000000000000000000000000000000NRAL',
      appName: 'my-app',
      // accountId required for the default nr-events-api transport.
      accountId: '12345',
    });
    const before = cfg.licenseKey;
    safeForLog(cfg);
    expect(cfg.licenseKey).toBe(before);
  });
});
