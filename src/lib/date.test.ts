import { isSameLocalDay, localStartOfDay } from './date.js';

describe('localStartOfDay', () => {
  it('returns the start of the local day for a given timestamp', () => {
    const noon = new Date(2026, 5, 10, 12, 30, 45, 678).getTime();
    const start = localStartOfDay(noon);
    expect(new Date(start).getHours()).toBe(0);
    expect(new Date(start).getMinutes()).toBe(0);
    expect(new Date(start).getSeconds()).toBe(0);
    expect(new Date(start).getMilliseconds()).toBe(0);
    expect(new Date(start).getDate()).toBe(10);
  });

  it('uses now when no argument is passed', () => {
    const before = Date.now();
    const start = localStartOfDay();
    const after = Date.now();
    expect(start).toBeLessThanOrEqual(before);
    expect(start).toBeLessThanOrEqual(after);
    expect(new Date(start).getHours()).toBe(0);
  });
});

describe('isSameLocalDay', () => {
  it('returns true for two timestamps on the same local day', () => {
    const morning = new Date(2026, 5, 10, 8, 15).getTime();
    const evening = new Date(2026, 5, 10, 22, 45).getTime();
    expect(isSameLocalDay(morning, evening)).toBe(true);
  });

  it('returns false for two timestamps on different local days', () => {
    const yesterday = new Date(2026, 5, 9, 23, 50).getTime();
    const today = new Date(2026, 5, 10, 0, 5).getTime();
    expect(isSameLocalDay(yesterday, today)).toBe(false);
  });

  it('compares against now when refTs is omitted', () => {
    const now = Date.now();
    expect(isSameLocalDay(now)).toBe(true);
    const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
    expect(isSameLocalDay(oneWeekAgo)).toBe(false);
  });
});
