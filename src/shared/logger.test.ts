import { createLogger, __resetLogLevelCache } from './logger.js';

describe('createLogger', () => {
  let stderrSpy: jest.SpiedFunction<typeof console.error>;

  beforeEach(() => {
    stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    // Env-resolved log level is cached on first use; tests
    // that flip NEW_RELIC_AI_LOG_LEVEL must clear the cache first so the
    // next createLogger call re-reads the new value.
    __resetLogLevelCache();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    delete process.env.NEW_RELIC_AI_LOG_LEVEL;
    __resetLogLevelCache();
  });

  it('produces a logger with all 4 level methods', () => {
    const logger = createLogger('test');
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
  });

  it('outputs valid JSON with expected fields', () => {
    const logger = createLogger('myComponent');
    logger.info('hello world');

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const output = (stderrSpy.mock.calls[0][0] as string).trim();
    const parsed = JSON.parse(output);

    expect(parsed.level).toBe('info');
    expect(parsed.component).toBe('myComponent');
    expect(parsed.message).toBe('hello world');
    expect(typeof parsed.timestamp).toBe('string');
    expect(() => new Date(parsed.timestamp)).not.toThrow();
  });

  it('includes extra data fields in the log entry', () => {
    const logger = createLogger('test');
    logger.warn('something happened', { requestId: 'abc-123', count: 5 });

    const output = (stderrSpy.mock.calls[0][0] as string).trim();
    const parsed = JSON.parse(output);

    expect(parsed.requestId).toBe('abc-123');
    expect(parsed.count).toBe(5);
  });

  it('canonical fields (level, message) cannot be overwritten by caller data', () => {
    const logger = createLogger('test');
    logger.error('real-message', { level: 'debug', message: 'injected', component: 'fake' });

    const output = (stderrSpy.mock.calls[0][0] as string).trim();
    const parsed = JSON.parse(output);
    expect(parsed.level).toBe('error');
    expect(parsed.message).toBe('real-message');
    expect(parsed.component).toBe('test');
  });

  it('filters log levels — setting level to warn suppresses debug and info', () => {
    const logger = createLogger('test', 'warn');

    logger.debug('should not appear');
    logger.info('should not appear');
    logger.warn('should appear');
    logger.error('should appear');

    expect(stderrSpy).toHaveBeenCalledTimes(2);
  });

  it('respects NEW_RELIC_AI_LOG_LEVEL env var', () => {
    process.env.NEW_RELIC_AI_LOG_LEVEL = 'error';
    const logger = createLogger('test');

    logger.debug('no');
    logger.info('no');
    logger.warn('no');
    logger.error('yes');

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse((stderrSpy.mock.calls[0][0] as string).trim());
    expect(parsed.level).toBe('error');
  });

  it('defaults to info level when env var is not set', () => {
    const logger = createLogger('test');

    logger.debug('should not appear');
    logger.info('should appear');

    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  it('defaults to info level when env var is invalid', () => {
    process.env.NEW_RELIC_AI_LOG_LEVEL = 'garbage';
    const logger = createLogger('test');

    logger.debug('should not appear');
    logger.info('should appear');

    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  it('does not throw and preserves non-circular fields when data contains a circular reference', () => {
    // redact() detects cycles and replaces the back-edge with
    // '[circular]', so JSON.stringify no longer throws and the rest of the
    // structure survives. (Previously the whole `data` field collapsed to
    // '[unserializable]'; that fallback still exists for genuinely
    // unserializable values — see the BigInt test below.)
    const logger = createLogger('test');
    const circular: Record<string, unknown> = { keep: 'me' };
    circular.self = circular;

    expect(() => logger.warn('circular', circular)).not.toThrow();

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const output = (stderrSpy.mock.calls[0][0] as string).trim();
    const parsed = JSON.parse(output);
    expect(parsed.message).toBe('circular');
    expect(parsed.keep).toBe('me');
    expect(parsed.self).toBe('[circular]');
  });

  it('replaces only the offending field with "[unserializable]" when a value cannot be JSON-serialized', () => {
    // Per-field fallback. The redact walker handles circulars but
    // passes BigInt through; BigInt then trips JSON.stringify on the whole
    // entry. The catch-block walks top-level keys and replaces only the
    // offending key with '[unserializable]' instead of collapsing the
    // entire data payload. `data` is spread into the entry via
    // `...safeData`, so individual data keys are top-level — the offender
    // here is `v`, not `data`.
    const logger = createLogger('test');
    expect(() => logger.warn('bigint', { v: 1n })).not.toThrow();

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const output = (stderrSpy.mock.calls[0][0] as string).trim();
    const parsed = JSON.parse(output);
    expect(parsed.v).toBe('[unserializable]');
    expect(parsed.message).toBe('bigint');
    expect(parsed.level).toBe('warn');
    expect(parsed.component).toBe('test');
    // The legacy collapsed `data: '[unserializable]'` field must NOT appear —
    // the per-field walker only replaces the bad key, not all data.
    expect(parsed.data).toBeUndefined();
  });

  it('preserves well-formed siblings when one data field is unserializable', () => {
    // A single bad field shouldn't poison the whole log entry.
    // Operators rely on these surrounding fields (request IDs, counts,
    // model names) to triage the failure — they must survive even when a
    // sibling value is unserializable.
    const logger = createLogger('test');
    expect(() =>
      logger.info('mixed payload', {
        good: 'kept',
        count: 7,
        bad: 1n,
      }),
    ).not.toThrow();

    const output = (stderrSpy.mock.calls[0][0] as string).trim();
    const parsed = JSON.parse(output);
    expect(parsed.good).toBe('kept');
    expect(parsed.count).toBe(7);
    expect(parsed.bad).toBe('[unserializable]');
    expect(parsed.message).toBe('mixed payload');
  });

  it('redacts secret-shaped keys from data', () => {
    const logger = createLogger('test');
    logger.info('config dump', {
      licenseKey: 'us01xxFAKEKEYFORTESTSONLY1234',
      appName: 'my-app',
      authorization: 'Bearer abc123',
      nested: {
        apiToken: 'sekrit',
        publicField: 'visible',
      },
      headers: {
        'X-Api-Key': 'leaked',
        'Content-Type': 'application/json',
      },
    });

    const output = (stderrSpy.mock.calls[0][0] as string).trim();
    const parsed = JSON.parse(output);

    expect(parsed.licenseKey).toBe('***');
    expect(parsed.authorization).toBe('***');
    expect(parsed.appName).toBe('my-app');
    expect(parsed.nested.apiToken).toBe('***');
    expect(parsed.nested.publicField).toBe('visible');
    expect(parsed.headers['X-Api-Key']).toBe('***');
    expect(parsed.headers['Content-Type']).toBe('application/json');
  });

  it('writes to stderr, not stdout', () => {
    // Logger uses console.error which routes to stderr; verify nothing
    // ever leaks to stdout via console.log.
    const stdoutSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const logger = createLogger('test');

    logger.info('hello');

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stdoutSpy).not.toHaveBeenCalled();
    stdoutSpy.mockRestore();
  });

  // child logger pre-binds context onto every entry
  describe('child logger', () => {
    it('child(boundContext) prepends context onto every emitted entry', () => {
      const root = createLogger('root');
      const child = root.child({ requestId: 'abc-12345' });

      child.warn('something happened', { statusCode: 502 });

      const parsed = JSON.parse(stderrSpy.mock.calls[0][0] as string);
      expect(parsed.requestId).toBe('abc-12345');
      expect(parsed.statusCode).toBe(502);
    });

    it('per-call data wins over bound context on key collision', () => {
      const child = createLogger('root').child({ requestId: 'bound', shared: 'from-bound' });
      child.info('msg', { shared: 'from-call' });

      const parsed = JSON.parse(stderrSpy.mock.calls[0][0] as string);
      expect(parsed.requestId).toBe('bound');
      expect(parsed.shared).toBe('from-call');
    });

    it('child of a child re-merges context (later wins)', () => {
      const root = createLogger('root');
      const a = root.child({ traceId: 't-1', layer: 'a' });
      const b = a.child({ layer: 'b', span: 's-1' });

      b.warn('msg');

      const parsed = JSON.parse(stderrSpy.mock.calls[0][0] as string);
      expect(parsed.traceId).toBe('t-1');
      expect(parsed.layer).toBe('b');
      expect(parsed.span).toBe('s-1');
    });

    it('child does not mutate the parent logger', () => {
      const root = createLogger('root');
      const child = root.child({ requestId: 'abc' });

      // Parent should NOT carry the child's bound context.
      root.info('parent log');
      child.info('child log');

      const parentParsed = JSON.parse(stderrSpy.mock.calls[0][0] as string);
      const childParsed = JSON.parse(stderrSpy.mock.calls[1][0] as string);
      expect(parentParsed.requestId).toBeUndefined();
      expect(childParsed.requestId).toBe('abc');
    });

    it('secret-shaped keys in child() bound context are redacted', () => {
      const child = createLogger('root').child({
        authorization: 'Bearer secret-token',
        requestId: 'safe-id',
      });
      child.info('msg');

      const parsed = JSON.parse(stderrSpy.mock.calls[0][0] as string);
      expect(parsed.authorization).toBe('***');
      expect(parsed.requestId).toBe('safe-id');
    });
  });

  // logger emits epoch_ms alongside ISO timestamp
  describe('epoch_ms timestamp', () => {
    it('emits epoch_ms (number) alongside ISO timestamp on every entry', () => {
      const logger = createLogger('test');
      logger.info('hello');

      const parsed = JSON.parse(stderrSpy.mock.calls[0][0] as string);
      expect(typeof parsed.timestamp).toBe('string');
      expect(typeof parsed.epoch_ms).toBe('number');
      // Both fields should refer to the same instant (within tolerance).
      expect(Math.abs(new Date(parsed.timestamp).getTime() - parsed.epoch_ms)).toBeLessThan(2);
    });
  });
});
