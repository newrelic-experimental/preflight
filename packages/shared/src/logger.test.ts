import { createLogger } from './logger.js';

describe('createLogger', () => {
  let stderrSpy: jest.SpiedFunction<typeof process.stderr.write>;

  beforeEach(() => {
    stderrSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    delete process.env.NEW_RELIC_AI_LOG_LEVEL;
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

  it('does not throw and emits a fallback when data contains a circular reference', () => {
    const logger = createLogger('test');
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => logger.warn('circular', circular)).not.toThrow();

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const output = (stderrSpy.mock.calls[0][0] as string).trim();
    const parsed = JSON.parse(output);
    expect(parsed.data).toBe('[unserializable]');
    expect(parsed.message).toBe('circular');
  });

  it('writes to stderr, not stdout', () => {
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    const logger = createLogger('test');

    logger.info('hello');

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stdoutSpy).not.toHaveBeenCalled();
    stdoutSpy.mockRestore();
  });
});
