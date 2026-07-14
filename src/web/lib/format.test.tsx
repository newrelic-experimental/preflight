import { describe, expect, it } from 'vitest';
import { formatDuration } from './format';

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
