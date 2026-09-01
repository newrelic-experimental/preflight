import { LiveSessionRegistry, DEFAULT_STALE_THRESHOLD_MS } from './live-session-registry.js';

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

  it('getLiveSessions excludes synthetic session IDs by default', () => {
    const reg = new LiveSessionRegistry();
    reg.touch('real-session');
    reg.touch('local-1234567890');
    reg.touch('proxy-9876543210');
    reg.touch('pending-1111111111');
    expect(reg.getLiveSessions()).toEqual(['real-session']);
  });

  it('getLiveSessions({ includeSynthetic: true }) returns every live session', () => {
    const reg = new LiveSessionRegistry();
    reg.touch('real-session');
    reg.touch('local-1234567890');
    const all = reg.getLiveSessions({ includeSynthetic: true });
    expect(all).toEqual(expect.arrayContaining(['real-session', 'local-1234567890']));
    expect(all).toHaveLength(2);
  });

  it('getPeakConcurrent() still counts synthetic sessions (unfiltered internal tracking)', () => {
    const reg = new LiveSessionRegistry(5000);
    reg.touch('local-a');
    reg.touch('local-b');
    reg.touch('real-c');
    expect(reg.getPeakConcurrent()).toBe(3);
  });

  it('getConcurrentCount() still counts synthetic sessions (unfiltered internal tracking)', () => {
    const reg = new LiveSessionRegistry(5000);
    reg.touch('local-a');
    reg.touch('proxy-b');
    expect(reg.getConcurrentCount()).toBe(2);
  });

  it('reset() clears all tracked sessions', () => {
    const reg = new LiveSessionRegistry();
    reg.touch('sess-a');
    reg.touch('sess-b');
    reg.reset();
    expect(reg.getLiveSessions()).toEqual([]);
    expect(reg.isLive('sess-a')).toBe(false);
  });

  it('exports DEFAULT_STALE_THRESHOLD_MS matching the constructor default', () => {
    expect(DEFAULT_STALE_THRESHOLD_MS).toBe(180_000);
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

  describe('setAuthoritativeName', () => {
    it('sets the display name for a session', () => {
      const reg = new LiveSessionRegistry();
      reg.setAuthoritativeName('sess-a', 'refactor auth flow', 'ai-title');
      expect(reg.getSessionName('sess-a')).toBe('refactor auth flow');
    });

    it('overrides a cwd basename already stored by touch()', () => {
      const reg = new LiveSessionRegistry();
      reg.touch('sess-a', '/Users/dev/projects/preflight');
      expect(reg.getSessionName('sess-a')).toBe('preflight');
      reg.setAuthoritativeName('sess-a', 'session naming logic', 'ai-title');
      expect(reg.getSessionName('sess-a')).toBe('session naming logic');
    });

    it('is not overwritten by a later touch() with a cwd', () => {
      const reg = new LiveSessionRegistry();
      reg.setAuthoritativeName('sess-a', 'session naming logic', 'ai-title');
      reg.touch('sess-a', '/Users/dev/projects/preflight');
      expect(reg.getSessionName('sess-a')).toBe('session naming logic');
    });

    it('ignores an empty name', () => {
      const reg = new LiveSessionRegistry();
      reg.touch('sess-a', '/Users/dev/projects/preflight');
      reg.setAuthoritativeName('sess-a', '', 'ai-title');
      expect(reg.getSessionName('sess-a')).toBe('preflight');
    });

    it('is cleared on reset()', () => {
      const reg = new LiveSessionRegistry();
      reg.setAuthoritativeName('sess-a', 'session naming logic', 'ai-title');
      reg.reset();
      expect(reg.getSessionName('sess-a')).toBeNull();
    });

    // --- Phase 2 freshness: re-resolution may upgrade, never downgrade ---

    it('upgrades the name as a better source arrives (cwd -> auto -> ai-title -> user)', () => {
      const reg = new LiveSessionRegistry();
      // cwd basename first (from touch), then progressively better re-resolves.
      reg.touch('sess-a', '/Users/dev/projects/preflight');
      expect(reg.getSessionName('sess-a')).toBe('preflight');
      reg.setAuthoritativeName('sess-a', 'auto guess', 'auto');
      expect(reg.getSessionName('sess-a')).toBe('auto guess');
      reg.setAuthoritativeName('sess-a', 'refined title', 'ai-title');
      expect(reg.getSessionName('sess-a')).toBe('refined title');
      reg.setAuthoritativeName('sess-a', 'human named it', 'user');
      expect(reg.getSessionName('sess-a')).toBe('human named it');
    });

    it('refreshes text for the same source (ai-title -> refined ai-title)', () => {
      const reg = new LiveSessionRegistry();
      reg.setAuthoritativeName('sess-a', 'first guess', 'ai-title');
      reg.setAuthoritativeName('sess-a', 'refined title', 'ai-title');
      expect(reg.getSessionName('sess-a')).toBe('refined title');
    });

    it('never downgrades a user name to auto or cwd', () => {
      const reg = new LiveSessionRegistry();
      reg.setAuthoritativeName('sess-a', 'human named it', 'user');
      // A later re-resolve that fell back to auto/cwd (e.g. the job-state file
      // disappeared) must not demote the user name.
      reg.setAuthoritativeName('sess-a', 'auto guess', 'auto');
      expect(reg.getSessionName('sess-a')).toBe('human named it');
      reg.setAuthoritativeName('sess-a', 'cwd basename', 'cwd');
      expect(reg.getSessionName('sess-a')).toBe('human named it');
      // And a later touch() with a cwd still can't clobber it either.
      reg.touch('sess-a', '/Users/dev/projects/preflight');
      expect(reg.getSessionName('sess-a')).toBe('human named it');
    });

    it('does not downgrade an ai-title to auto', () => {
      const reg = new LiveSessionRegistry();
      reg.setAuthoritativeName('sess-a', 'refined title', 'ai-title');
      reg.setAuthoritativeName('sess-a', 'auto guess', 'auto');
      expect(reg.getSessionName('sess-a')).toBe('refined title');
    });
  });

  describe('getSessionNameSource', () => {
    it('returns null for an unknown/unnamed session', () => {
      const reg = new LiveSessionRegistry();
      expect(reg.getSessionNameSource('sess-a')).toBeNull();
    });

    it("reports 'cwd' for a name set by the touch() streaming fallback", () => {
      const reg = new LiveSessionRegistry();
      reg.touch('sess-a', '/Users/dev/projects/preflight');
      expect(reg.getSessionName('sess-a')).toBe('preflight');
      expect(reg.getSessionNameSource('sess-a')).toBe('cwd');
    });

    it('reports the authoritative source and tracks upgrades', () => {
      const reg = new LiveSessionRegistry();
      reg.touch('sess-a', '/Users/dev/projects/preflight');
      expect(reg.getSessionNameSource('sess-a')).toBe('cwd');
      reg.setAuthoritativeName('sess-a', 'refined title', 'ai-title');
      expect(reg.getSessionNameSource('sess-a')).toBe('ai-title');
      reg.setAuthoritativeName('sess-a', 'human named it', 'user');
      expect(reg.getSessionNameSource('sess-a')).toBe('user');
    });

    it('is cleared on reset()', () => {
      const reg = new LiveSessionRegistry();
      reg.setAuthoritativeName('sess-a', 'human named it', 'user');
      reg.reset();
      expect(reg.getSessionNameSource('sess-a')).toBeNull();
    });
  });
});
