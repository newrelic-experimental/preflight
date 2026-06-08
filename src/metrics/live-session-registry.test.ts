import { LiveSessionRegistry } from './live-session-registry.js';

describe('LiveSessionRegistry', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns touched sessions as live', () => {
    const reg = new LiveSessionRegistry();
    reg.touch('sess-a');
    reg.touch('sess-b');
    expect(reg.getLiveSessions()).toEqual(expect.arrayContaining(['sess-a', 'sess-b']));
    expect(reg.getLiveSessions()).toHaveLength(2);
  });

  it('isLive returns true for recently touched sessions', () => {
    const reg = new LiveSessionRegistry();
    reg.touch('sess-a');
    expect(reg.isLive('sess-a')).toBe(true);
    expect(reg.isLive('unknown')).toBe(false);
  });

  it('prunes sessions older than threshold from getLiveSessions', () => {
    const reg = new LiveSessionRegistry(5000);
    reg.touch('sess-a');
    jest.advanceTimersByTime(6000);
    expect(reg.getLiveSessions()).toEqual([]);
  });

  it('isLive returns false after threshold and prunes entry', () => {
    const reg = new LiveSessionRegistry(5000);
    reg.touch('sess-a');
    jest.advanceTimersByTime(6000);
    expect(reg.isLive('sess-a')).toBe(false);
  });

  it('refreshes liveness on repeated touch', () => {
    const reg = new LiveSessionRegistry(5000);
    reg.touch('sess-a');
    jest.advanceTimersByTime(4000);
    reg.touch('sess-a');
    jest.advanceTimersByTime(4000);
    expect(reg.isLive('sess-a')).toBe(true);
  });

  it('handles mix of live and stale sessions', () => {
    const reg = new LiveSessionRegistry(5000);
    reg.touch('sess-old');
    jest.advanceTimersByTime(4000);
    reg.touch('sess-new');
    jest.advanceTimersByTime(2000);
    // sess-old: 6000ms ago (stale), sess-new: 2000ms ago (live)
    expect(reg.getLiveSessions()).toEqual(['sess-new']);
  });

  it('returns empty array when no sessions touched', () => {
    const reg = new LiveSessionRegistry();
    expect(reg.getLiveSessions()).toEqual([]);
  });

  it('reset() clears all tracked sessions', () => {
    const reg = new LiveSessionRegistry();
    reg.touch('sess-a');
    reg.touch('sess-b');
    reg.reset();
    expect(reg.getLiveSessions()).toEqual([]);
    expect(reg.isLive('sess-a')).toBe(false);
  });

  describe('concurrency tracking', () => {
    it('tracks peak concurrent sessions via touch()', () => {
      const reg = new LiveSessionRegistry(5000);
      reg.touch('a');
      reg.touch('b');
      reg.touch('c');
      expect(reg.getPeakConcurrent()).toBe(3);
    });

    it('getConcurrentCount() returns current live count', () => {
      const reg = new LiveSessionRegistry(5000);
      reg.touch('a');
      reg.touch('b');
      expect(reg.getConcurrentCount()).toBe(2);
      jest.advanceTimersByTime(6000);
      expect(reg.getConcurrentCount()).toBe(0);
    });

    it('peak persists even after sessions go stale', () => {
      const reg = new LiveSessionRegistry(5000);
      reg.touch('a');
      reg.touch('b');
      reg.touch('c');
      jest.advanceTimersByTime(6000);
      expect(reg.getConcurrentCount()).toBe(0);
      expect(reg.getPeakConcurrent()).toBe(3);
    });

    it('startSampling() records time series entries', () => {
      const reg = new LiveSessionRegistry(60_000);
      reg.touch('a');
      reg.startSampling();
      jest.advanceTimersByTime(30_000);
      const ts = reg.getConcurrencyTimeSeries();
      expect(ts.length).toBe(1);
      expect(ts[0]!.count).toBe(1);
      reg.stopSampling();
    });

    it('stopSampling() halts recording', () => {
      const reg = new LiveSessionRegistry(60_000);
      reg.startSampling();
      jest.advanceTimersByTime(30_000);
      reg.stopSampling();
      jest.advanceTimersByTime(60_000);
      expect(reg.getConcurrencyTimeSeries().length).toBe(1);
    });

    it('time series caps at max buffer size', () => {
      const reg = new LiveSessionRegistry();
      reg.touch('a');
      reg.startSampling();
      jest.advanceTimersByTime(30_000 * 2900);
      const ts = reg.getConcurrencyTimeSeries();
      expect(ts.length).toBeLessThanOrEqual(2880);
      reg.stopSampling();
    });
  });
});
