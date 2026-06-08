import { bucketTimeline, autoBucketSize, buildDailyGrid } from './bucket.js';

describe('bucketTimeline', () => {
  it('distributes entries into correct buckets', () => {
    const entries = [
      { timestamp: 1000 },
      { timestamp: 1500 },
      { timestamp: 2000 },
      { timestamp: 3500 },
    ];
    const result = bucketTimeline(entries, { startMs: 1000, endMs: 4000, bucketSizeMs: 1000 });
    expect(result).toEqual([2, 1, 1]);
  });

  it('ignores entries outside range', () => {
    const entries = [{ timestamp: 500 }, { timestamp: 1500 }, { timestamp: 5000 }];
    const result = bucketTimeline(entries, { startMs: 1000, endMs: 3000, bucketSizeMs: 1000 });
    expect(result).toEqual([1, 0]);
  });

  it('handles empty entries', () => {
    const result = bucketTimeline([], { startMs: 0, endMs: 3000, bucketSizeMs: 1000 });
    expect(result).toEqual([0, 0, 0]);
  });

  it('handles single bucket', () => {
    const entries = [{ timestamp: 100 }, { timestamp: 200 }];
    const result = bucketTimeline(entries, { startMs: 0, endMs: 500, bucketSizeMs: 1000 });
    expect(result).toEqual([2]);
  });
});

describe('autoBucketSize', () => {
  it('returns 30s for short sessions (<10 min)', () => {
    expect(autoBucketSize(300_000)).toBe(30_000);
  });

  it('returns 1min for medium sessions (<1h)', () => {
    expect(autoBucketSize(1_800_000)).toBe(60_000);
  });

  it('returns 5min for longer sessions (<4h)', () => {
    expect(autoBucketSize(7_200_000)).toBe(300_000);
  });

  it('returns 15min for very long sessions (>=4h)', () => {
    expect(autoBucketSize(14_400_000)).toBe(900_000);
  });
});

describe('buildDailyGrid', () => {
  it('returns days with correct counts', () => {
    const today = new Date();
    const sessions = [
      { startTime: today.getTime(), toolCallCount: 10 },
      { startTime: today.getTime(), toolCallCount: 5 },
    ];
    const result = buildDailyGrid(sessions, 1);
    const todayKey = today.toISOString().slice(0, 10);
    const todayEntry = result.days.find((d) => d.date === todayKey);
    expect(todayEntry?.count).toBe(15);
  });

  it('returns maxCount of at least 1', () => {
    const result = buildDailyGrid([], 1);
    expect(result.maxCount).toBe(1);
  });

  it('ignores sessions without startTime', () => {
    const result = buildDailyGrid([{ toolCallCount: 10 }], 1);
    const allCounts = result.days.map((d) => d.count);
    expect(allCounts.every((c) => c === 0)).toBe(true);
  });

  it('covers the expected number of days', () => {
    const result = buildDailyGrid([], 2);
    // 2 weeks = 14 days, plus today = 15 days (depending on time of day)
    expect(result.days.length).toBeGreaterThanOrEqual(14);
    expect(result.days.length).toBeLessThanOrEqual(15);
  });
});
