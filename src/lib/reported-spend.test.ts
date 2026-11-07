import { isReportedSpendStale, type ReportedSpend } from './reported-spend.js';

const entry = (periodKind: 'daily' | 'weekly', asOf: Date): ReportedSpend => ({
  periodKind,
  amountUsd: 5,
  asOf: asOf.toISOString(),
});

// Wednesday 2026-11-11 noon, local time.
const NOW = new Date(2026, 10, 11, 12, 0).getTime();

describe('isReportedSpendStale', () => {
  it('keeps a daily value from earlier today and stales one from yesterday evening', () => {
    expect(isReportedSpendStale(entry('daily', new Date(2026, 10, 11, 0, 5)), NOW)).toBe(false);
    expect(isReportedSpendStale(entry('daily', new Date(2026, 10, 10, 23, 55)), NOW)).toBe(true);
  });

  it('keeps a weekly value from Monday and stales one from the Sunday before', () => {
    expect(isReportedSpendStale(entry('weekly', new Date(2026, 10, 9, 8, 0)), NOW)).toBe(false);
    expect(isReportedSpendStale(entry('weekly', new Date(2026, 10, 8, 23, 0)), NOW)).toBe(true);
  });

  it('treats a Sunday as the last day of the week that began the Monday before', () => {
    const sunday = new Date(2026, 10, 15, 12, 0).getTime();
    expect(isReportedSpendStale(entry('weekly', new Date(2026, 10, 9, 8, 0)), sunday)).toBe(false);
    expect(isReportedSpendStale(entry('weekly', new Date(2026, 10, 8, 23, 0)), sunday)).toBe(true);
  });
});
