import { localStartOfDay } from '../lib/date.js';
import { resolveScopeParam, resolveWindowParam } from './git-window-params.js';

// Fixed instant: 2026-03-15T15:30:00 local time (arbitrary but deterministic
// — every assertion below is relative to this `now`, never the real clock).
const NOW = new Date(2026, 2, 15, 15, 30, 0).getTime();
const DAY_MS = 86_400_000;

describe('resolveWindowParam', () => {
  it('defaults to today when raw is null/undefined', () => {
    const todayStart = localStartOfDay(NOW);
    expect(resolveWindowParam(null, NOW)).toEqual({ since: todayStart, until: NOW });
    expect(resolveWindowParam(undefined, NOW)).toEqual({ since: todayStart, until: NOW });
  });

  it("resolves 'today' explicitly", () => {
    const todayStart = localStartOfDay(NOW);
    expect(resolveWindowParam('today', NOW)).toEqual({ since: todayStart, until: NOW });
  });

  it("resolves 'yesterday' to [start of yesterday, start of today)", () => {
    const todayStart = localStartOfDay(NOW);
    expect(resolveWindowParam('yesterday', NOW)).toEqual({
      since: todayStart - DAY_MS,
      until: todayStart,
    });
  });

  it("resolves 'week' to 7 days inclusive of today, until now", () => {
    const todayStart = localStartOfDay(NOW);
    expect(resolveWindowParam('week', NOW)).toEqual({
      since: todayStart - 6 * DAY_MS,
      until: NOW,
    });
  });

  it("resolves 'previous_week' to the 7 days immediately before 'week', a fixed fully-past window", () => {
    const todayStart = localStartOfDay(NOW);
    const week = resolveWindowParam('week', NOW);
    const previousWeek = resolveWindowParam('previous_week', NOW);
    expect(previousWeek).toEqual({
      since: todayStart - 13 * DAY_MS,
      until: todayStart - 6 * DAY_MS,
    });
    // Back-to-back, no gap and no overlap with 'week'.
    expect(previousWeek.until).toBe(week.since);
    // Unlike 'week' (until: now), previous_week's boundary never moves
    // within the same calendar day — both ends are day-anchored.
    expect(previousWeek.until).toBe(todayStart - 6 * DAY_MS);
  });

  it('resolves a bare integer as N days back, until now', () => {
    const todayStart = localStartOfDay(NOW);
    expect(resolveWindowParam('14', NOW)).toEqual({
      since: todayStart - 13 * DAY_MS,
      until: NOW,
    });
  });

  it('clamps a bare integer above 365 down to 365', () => {
    const todayStart = localStartOfDay(NOW);
    expect(resolveWindowParam('9000', NOW)).toEqual({
      since: todayStart - 364 * DAY_MS,
      until: NOW,
    });
  });

  it('clamps a bare integer of 0 up to 1 (treated as today)', () => {
    const todayStart = localStartOfDay(NOW);
    expect(resolveWindowParam('0', NOW)).toEqual({ since: todayStart, until: NOW });
  });

  it('falls back to today for an invalid/unparseable string', () => {
    const todayStart = localStartOfDay(NOW);
    expect(resolveWindowParam('bogus', NOW)).toEqual({ since: todayStart, until: NOW });
    expect(resolveWindowParam('-5', NOW)).toEqual({ since: todayStart, until: NOW });
    expect(resolveWindowParam('', NOW)).toEqual({ since: todayStart, until: NOW });
  });
});

describe('resolveScopeParam', () => {
  it('defaults to all when raw is null/undefined', () => {
    expect(resolveScopeParam(null)).toEqual({ kind: 'all' });
    expect(resolveScopeParam(undefined)).toEqual({ kind: 'all' });
  });

  it("resolves 'all' explicitly", () => {
    expect(resolveScopeParam('all')).toEqual({ kind: 'all' });
  });

  it("resolves 'repo:<id>'", () => {
    expect(resolveScopeParam('repo:abc')).toEqual({ kind: 'repo', id: 'abc' });
  });

  it("resolves 'worktree:<id>' and URL-decodes the id", () => {
    expect(resolveScopeParam('worktree:xyz%2Fpath')).toEqual({
      kind: 'worktree',
      id: 'xyz/path',
    });
  });

  it('falls back to all for a malformed scope with no id', () => {
    expect(resolveScopeParam('worktree:')).toEqual({ kind: 'all' });
    expect(resolveScopeParam('repo:')).toEqual({ kind: 'all' });
  });

  it('falls back to all for an unrecognized scope string', () => {
    expect(resolveScopeParam('bogus')).toEqual({ kind: 'all' });
  });
});
