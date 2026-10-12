import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { estimateFromFamily } from './model-pricing.js';

let consoleError: jest.SpiedFunction<typeof console.error>;

function loggedText(): string {
  return consoleError.mock.calls.map((c) => String(c[0])).join('\n');
}

beforeEach(() => {
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  consoleError.mockRestore();
});

describe('estimateFromFamily', () => {
  const same = () => ({ inputPerMTok: 1 });

  it('collapses equally priced dated and undated twins to the undated id', () => {
    expect(
      estimateFromFamily('claude-x-1-9', ['claude-x-1-1-20250101', 'claude-x-1-1'], same),
    ).toBe('claude-x-1-1');
    expect(
      estimateFromFamily('claude-x-1-9', ['claude-x-1-1', 'claude-x-1-1-20250101'], same),
    ).toBe('claude-x-1-1');
  });

  it('returns null and warns when the chosen release holds differently priced ids', () => {
    const priceOf = (id: string) => ({ inputPerMTok: id.endsWith('20250101') ? 2 : 1 });
    expect(
      estimateFromFamily('claude-x-1-9', ['claude-x-1-1', 'claude-x-1-1-20250101'], priceOf),
    ).toBeNull();
    expect(loggedText()).toContain('Ambiguous family pricing fallback; returning null');
  });

  it('picks the highest minor of the same major', () => {
    expect(
      estimateFromFamily('claude-x-5-9', ['claude-x-4-9', 'claude-x-5', 'claude-x-5-1'], same),
    ).toBe('claude-x-5-1');
  });

  it('falls back to the newest release when no sibling shares the major', () => {
    expect(estimateFromFamily('claude-x-6-9', ['claude-x-4-5', 'claude-x-5-1'], same)).toBe(
      'claude-x-5-1',
    );
  });

  it('never crosses families or vendors', () => {
    expect(estimateFromFamily('claude-y-1-9', ['claude-x-1-1'], same)).toBeNull();
    expect(estimateFromFamily('gpt-5', ['claude-x-1-1'], same)).toBeNull();
  });
});
