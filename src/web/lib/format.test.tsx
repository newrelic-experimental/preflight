import { describe, expect, it } from 'vitest';
import {
  rateColor,
  scoreColor,
  fmtDateTime,
  fmtTimeOfDay,
  fmtElapsed,
  formatDuration,
  formatNumber,
  formatUsd,
  formatUsdOrDash,
  formatTokensCompact,
  shortToolName,
} from './format';

describe('rateColor()', () => {
  it('returns the muted color for null (no data)', () => {
    expect(rateColor(null)).toBe('text-ink-muted');
  });

  it('returns green at/above the good threshold', () => {
    expect(rateColor(0.9)).toBe('text-accent-green');
  });

  it('returns amber between the warn and good thresholds', () => {
    expect(rateColor(0.6)).toBe('text-accent-amber');
  });

  it('returns red below the warn threshold', () => {
    expect(rateColor(0.3)).toBe('text-accent-red');
  });
});

describe('scoreColor()', () => {
  it('returns cyan at/above 0.8', () => {
    expect(scoreColor(0.8)).toBe('text-accent-cyan');
  });

  it('returns amber between 0.5 and 0.8', () => {
    expect(scoreColor(0.6)).toBe('text-accent-amber');
  });

  it('returns red below 0.5', () => {
    expect(scoreColor(0.3)).toBe('text-accent-red');
  });
});

describe('fmtDateTime()', () => {
  it('formats an epoch-ms timestamp as "Mon D, H:MM AM/PM" in local time', () => {
    const ms = new Date(2026, 0, 5, 14, 30).getTime();
    expect(fmtDateTime(ms)).toMatch(/^Jan 5, \d{1,2}:30\s?[AP]M$/);
  });

  it('accepts an ISO string input equivalently to epoch ms', () => {
    const date = new Date(2026, 0, 5, 14, 30);
    expect(fmtDateTime(date.toISOString())).toBe(fmtDateTime(date.getTime()));
  });
});

describe('fmtTimeOfDay()', () => {
  it('formats epoch ms as time only, no date', () => {
    const ms = new Date(2026, 0, 5, 14, 30).getTime();
    expect(fmtTimeOfDay(ms)).toMatch(/^\d{1,2}:30\s?[AP]M$/);
  });
});

describe('fmtElapsed()', () => {
  it('formats minutes and zero-padded seconds', () => {
    expect(fmtElapsed(65_000)).toBe('1:05');
  });

  it('formats sub-minute elapsed with zero minutes', () => {
    expect(fmtElapsed(9_000)).toBe('0:09');
  });

  it('floors partial seconds', () => {
    expect(fmtElapsed(1_999)).toBe('0:01');
  });
});

describe('formatDuration()', () => {
  it('formats seconds', () => {
    expect(formatDuration(45_000)).toBe('45s');
  });

  it('formats minutes and seconds', () => {
    expect(formatDuration(198_000)).toBe('3m 18s');
  });

  it('formats whole minutes with no trailing seconds', () => {
    expect(formatDuration(120_000)).toBe('2m');
  });

  it('formats hours and minutes', () => {
    expect(formatDuration(5_400_000)).toBe('1h 30m');
  });

  it('formats days and hours', () => {
    expect(formatDuration(187_200_000)).toBe('2d 4h');
  });

  it('returns the em-dash placeholder for NaN', () => {
    expect(formatDuration(NaN)).toBe('—');
  });

  it('returns the em-dash placeholder for negative input', () => {
    expect(formatDuration(-500)).toBe('—');
  });

  it('returns the em-dash placeholder for Infinity', () => {
    expect(formatDuration(Infinity)).toBe('—');
  });
});

describe('formatNumber()', () => {
  it('rounds magnitudes >= 100 to whole units', () => {
    expect(formatNumber(123.456)).toBe('123');
  });

  it('renders 10 <= magnitude < 100 with one decimal', () => {
    expect(formatNumber(45.678)).toBe('45.7');
  });

  it('renders integers below 10 bare', () => {
    expect(formatNumber(7)).toBe('7');
  });

  it('renders non-integers below 10 with two decimals', () => {
    expect(formatNumber(3.14159)).toBe('3.14');
  });

  it('returns the em-dash placeholder for non-finite input', () => {
    expect(formatNumber(NaN)).toBe('—');
    expect(formatNumber(Infinity)).toBe('—');
  });
});

describe('formatUsd', () => {
  it('renders >= $1 with 2 decimals', () => {
    expect(formatUsd(6.0473)).toBe('$6.05');
    expect(formatUsd(45.48)).toBe('$45.48');
    expect(formatUsd(1)).toBe('$1.00');
    expect(formatUsd(232.90783)).toBe('$232.91');
  });

  it('renders 0 < value < $1 with 4 decimals (preserves small-cost precision)', () => {
    expect(formatUsd(0.0125)).toBe('$0.0125');
    expect(formatUsd(0.42)).toBe('$0.4200');
  });

  it('renders an exact zero as $0.00 (a measured zero, not missing data)', () => {
    expect(formatUsd(0)).toBe('$0.00');
  });

  it('renders non-finite as $0.00 rather than leaking NaN', () => {
    expect(formatUsd(Number.NaN)).toBe('$0.00');
    expect(formatUsd(Number.POSITIVE_INFINITY)).toBe('$0.00');
  });

  it('is precision-stable: the same value formats identically every call', () => {
    // The bug this guards: a session showing $6.05 in the list but $6.0473 in
    // the detail panel. One value, one rendering, everywhere.
    const v = 6.0473;
    expect(formatUsd(v)).toBe(formatUsd(v));
    expect(formatUsd(v)).toBe('$6.05');
  });
});

describe('formatUsdOrDash', () => {
  it('renders null/undefined as the em-dash (no data), distinct from $0.00', () => {
    expect(formatUsdOrDash(null)).toBe('—');
    expect(formatUsdOrDash(undefined)).toBe('—');
    expect(formatUsdOrDash(Number.NaN)).toBe('—');
  });

  it('renders a present value via formatUsd (including a real $0.00)', () => {
    expect(formatUsdOrDash(0)).toBe('$0.00');
    expect(formatUsdOrDash(6.0473)).toBe('$6.05');
    expect(formatUsdOrDash(0.0125)).toBe('$0.0125');
  });
});

describe('shortToolName()', () => {
  it('strips the mcp__<server>__ prefix', () => {
    expect(shortToolName('mcp__nr-observe__nr_observe_health')).toBe('nr_observe_health');
  });

  it('passes non-MCP names through unchanged', () => {
    expect(shortToolName('Read')).toBe('Read');
  });
});

describe('formatTokensCompact()', () => {
  it('renders the k tier at the 1,000 boundary', () => {
    expect(formatTokensCompact(1_000)).toBe('1.0k');
  });

  it('renders the M tier at the 1,000,000 boundary', () => {
    expect(formatTokensCompact(1_000_000)).toBe('1.0M');
  });
});
