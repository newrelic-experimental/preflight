import { formatUsd, formatUsdOrDash } from './format.js';

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
