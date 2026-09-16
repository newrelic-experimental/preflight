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
  formatRelativeTime,
  shortToolName,
  formatMs,
  formatPct,
  formatAxisDate,
  formatAxisWeek,
  formatAxisUsd,
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
  it('renders >= $1 with 2 decimals and thousands separators', () => {
    expect(formatUsd(6.0473)).toBe('$6.05');
    expect(formatUsd(45.48)).toBe('$45.48');
    expect(formatUsd(1)).toBe('$1.00');
    expect(formatUsd(232.90783)).toBe('$232.91');
    expect(formatUsd(1234.5)).toBe('$1,234.50');
  });

  it('renders $0.10 <= value < $1 with 2 decimals', () => {
    expect(formatUsd(0.42)).toBe('$0.42');
    expect(formatUsd(0.1)).toBe('$0.10');
  });

  it('renders $0.001 <= value < $0.10 with 3 decimals', () => {
    expect(formatUsd(0.0125)).toBe('$0.013');
    expect(formatUsd(0.088)).toBe('$0.088');
    expect(formatUsd(0.001)).toBe('$0.001');
  });

  it('renders 0 < value < $0.001 as <$0.001, never a fake $0.000', () => {
    expect(formatUsd(0.0005)).toBe('<$0.001');
    expect(formatUsd(0.0000001)).toBe('<$0.001');
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
    expect(formatUsdOrDash(0.0125)).toBe('$0.013');
  });
});

describe('formatMs()', () => {
  it('renders sub-second values in whole milliseconds', () => {
    expect(formatMs(16)).toBe('16 ms');
    expect(formatMs(844)).toBe('844 ms');
  });

  it('renders 1s <= value < 60s in seconds with one decimal', () => {
    expect(formatMs(1400)).toBe('1.4 s');
    expect(formatMs(12_800)).toBe('12.8 s');
  });

  it('delegates to formatDuration at the 60s boundary', () => {
    expect(formatMs(65_000)).toBe(formatDuration(65_000));
    expect(formatMs(65_000)).toBe('1m 5s');
  });

  it('returns the em-dash placeholder for non-finite or negative input', () => {
    expect(formatMs(Number.NaN)).toBe('—');
    expect(formatMs(-5)).toBe('—');
  });
});

describe('formatPct()', () => {
  it('renders a whole percent, rounded', () => {
    expect(formatPct(34)).toBe('34%');
    expect(formatPct(0.7)).toBe('1%');
  });

  it('renders <1% for a positive value that would round to 0', () => {
    expect(formatPct(0.1)).toBe('<1%');
    expect(formatPct(0.49)).toBe('<1%');
  });

  it('renders 0% for an exact zero (or non-positive) share', () => {
    expect(formatPct(0)).toBe('0%');
    expect(formatPct(-3)).toBe('0%');
  });
});

describe('formatAxisDate()', () => {
  it('renders a YYYY-MM-DD date', () => {
    expect(formatAxisDate('2026-08-13')).toBe('Aug 13');
  });

  it('renders an MM-DD date with no year', () => {
    expect(formatAxisDate('08-13')).toBe('Aug 13');
  });
});

describe('formatAxisWeek()', () => {
  it('renders the Monday of the given ISO week', () => {
    expect(formatAxisWeek('2026-W34')).toBe('Aug 17');
  });

  it('handles an ISO week that starts in the prior December', () => {
    expect(formatAxisWeek('2026-W01')).toBe('Dec 29');
  });
});

describe('formatAxisUsd()', () => {
  it('renders sub-$1,000 amounts as whole dollars', () => {
    expect(formatAxisUsd(85)).toBe('$85');
  });

  it('renders $1,000+ amounts in the k tier', () => {
    expect(formatAxisUsd(1200)).toBe('$1.2k');
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

describe('formatRelativeTime()', () => {
  it('returns "just now" for a timestamp within the last minute', () => {
    expect(formatRelativeTime(Date.now())).toBe('just now');
  });

  it('formats minutes ago', () => {
    expect(formatRelativeTime(Date.now() - 5 * 60_000)).toBe('5m ago');
  });

  it('formats hours ago', () => {
    expect(formatRelativeTime(Date.now() - 3 * 3_600_000)).toBe('3h ago');
  });

  it('formats days ago', () => {
    expect(formatRelativeTime(Date.now() - 2 * 86_400_000)).toBe('2d ago');
  });
});
