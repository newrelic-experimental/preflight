import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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

  it.each([92, 96, 100])('renders one column per bucket for a %i-bucket day', (count) => {
    const buckets = Array.from({ length: count }, (_, i) => ({
      timestamp: i * 900_000,
      count: i === count - 1 ? 2 : 1,
    }));
    const { container } = render(
      <ConcurrencyIndicator
        current={1}
        peak={2}
        bucketSizeMs={900_000}
        startTimestamp={0}
        buckets={buckets}
      />,
    );

    expect(container.querySelectorAll('svg > g')).toHaveLength(count);
  });

  it('labels each column from its own timestamp so a repeated fall-back hour is not index-derived', () => {
    const hour = 3_600_000;
    const timestamps = [0, 900_000, 5 * hour, 5 * hour + 900_000];
    const buckets = timestamps.map((timestamp) => ({ timestamp, count: 1 }));
    const { container } = render(
      <ConcurrencyIndicator
        current={1}
        peak={1}
        bucketSizeMs={900_000}
        startTimestamp={0}
        buckets={buckets}
      />,
    );

    const columns = container.querySelectorAll('svg > g');
    fireEvent.mouseEnter(columns[2]!);
    const expected = new Date(5 * hour).toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
    expect(screen.getByText(`${expected} — 1 concurrent`)).toBeInTheDocument();
  });
});
