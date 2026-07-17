import { describe, expect, it } from 'vitest';
import { formatDuration, rateColor, shortToolName, formatTokensCompact } from './format';

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
