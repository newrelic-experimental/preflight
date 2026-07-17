import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConcurrencyIndicator } from './ConcurrencyIndicator';

const STORAGE_KEY = 'nr-observe-peak-concurrent';

describe('ConcurrencyIndicator', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('shows "NEW RECORD!" and persists the new peak when allTimePeak exceeds the stored value', () => {
    localStorage.setItem(STORAGE_KEY, '5');
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');

    render(
      <ConcurrencyIndicator
        current={3}
        peak={8}
        allTimePeak={10}
        bucketSizeMs={60_000}
        startTimestamp={0}
        buckets={[]}
      />,
    );

    expect(screen.getByText('NEW RECORD!')).toBeInTheDocument();
    expect(setItemSpy).toHaveBeenCalledWith(STORAGE_KEY, '10');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('10');
  });

  it('does not celebrate when the peak does not exceed the stored value', () => {
    localStorage.setItem(STORAGE_KEY, '10');

    render(
      <ConcurrencyIndicator
        current={3}
        peak={8}
        allTimePeak={10}
        bucketSizeMs={60_000}
        startTimestamp={0}
        buckets={[]}
      />,
    );

    expect(screen.queryByText('NEW RECORD!')).not.toBeInTheDocument();
  });
});
