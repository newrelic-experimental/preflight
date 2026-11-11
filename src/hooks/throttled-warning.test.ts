import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Logger } from '../shared/index.js';
import { ThrottledWarning } from './throttled-warning.js';

describe('ThrottledWarning', () => {
  const warn = jest.fn();
  let throttle: ThrottledWarning;

  beforeEach(() => {
    jest.useFakeTimers();
    warn.mockClear();
    throttle = new ThrottledWarning({ warn } as unknown as Logger, 'read deferred');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('logs the first failure, then suppresses repeats within a minute and reports the count', () => {
    throttle.warn(new Error('disk full'));
    throttle.warn(new Error('disk full'));
    throttle.warn(new Error('disk full'));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenLastCalledWith('read deferred', { error: 'disk full', suppressed: 0 });

    jest.advanceTimersByTime(60_000);
    throttle.warn(new Error('disk full'));
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith('read deferred', { error: 'disk full', suppressed: 2 });
  });

  it('logs again at once after a success', () => {
    throttle.warn(new Error('x'));
    throttle.succeeded();
    throttle.warn(new Error('x'));
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("keeps a key's throttle when a different key succeeds", () => {
    throttle.warn(new Error('x'), '/a.jsonl');
    throttle.succeeded('/b.jsonl');
    throttle.warn(new Error('x'), '/a.jsonl');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('throttles each key independently', () => {
    throttle.warn(new Error('x'), '/a.jsonl');
    throttle.warn(new Error('x'), '/b.jsonl');
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
