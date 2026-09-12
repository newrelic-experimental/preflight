import { describe, expect, it } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { SpendBars, type SpendBarsDatum } from './SpendBars';

describe('SpendBars', () => {
  it('renders one bar for every datum passed in data', async () => {
    const data: ReadonlyArray<SpendBarsDatum> = [
      {
        key: 'day1',
        label: 'Day 1',
        spendUsd: 10,
        cumulativeUsd: null,
        projectedUsd: null,
      },
      {
        key: 'day2',
        label: 'Day 2',
        spendUsd: 20,
        cumulativeUsd: null,
        projectedUsd: null,
      },
      {
        key: 'day3',
        label: 'Day 3',
        spendUsd: 30,
        cumulativeUsd: null,
        projectedUsd: null,
      },
    ];
    const { container } = render(
      <div style={{ width: 400, height: 200 }}>
        <SpendBars data={data} />
      </div>,
    );
    await waitFor(() => {
      const barRects = container.querySelectorAll('.recharts-bar-rectangle');
      expect(barRects.length).toBe(3);
    });
  });

  it('does not render a dashed projected line when every datum has projectedUsd null', async () => {
    const data: ReadonlyArray<SpendBarsDatum> = [
      {
        key: 'day1',
        label: 'Day 1',
        spendUsd: 10,
        cumulativeUsd: null,
        projectedUsd: null,
      },
      {
        key: 'day2',
        label: 'Day 2',
        spendUsd: 20,
        cumulativeUsd: null,
        projectedUsd: null,
      },
    ];
    const { container } = render(
      <div style={{ width: 400, height: 200 }}>
        <SpendBars data={data} />
      </div>,
    );
    await waitFor(() => {
      const lines = container.querySelectorAll('[stroke-dasharray="4 3"]');
      expect(lines.length).toBe(0);
    });
  });

  it('renders a dashed projected line when at least one datum has non-null projectedUsd', async () => {
    const data: ReadonlyArray<SpendBarsDatum> = [
      {
        key: 'day1',
        label: 'Day 1',
        spendUsd: 10,
        cumulativeUsd: null,
        projectedUsd: 12,
      },
      {
        key: 'day2',
        label: 'Day 2',
        spendUsd: 20,
        cumulativeUsd: null,
        projectedUsd: 25,
      },
    ];
    const { container } = render(
      <div style={{ width: 400, height: 200 }}>
        <SpendBars data={data} />
      </div>,
    );
    await waitFor(() => {
      const allElements = Array.from(container.querySelectorAll('*'));
      const hasProjectedLine = allElements.some(
        (el) =>
          (el.getAttribute('stroke-dasharray') === '4 3' &&
            el.getAttribute('stroke') === 'var(--color-accent-green)') ||
          el.getAttribute('stroke') === 'var(--color-accent-green)',
      );
      expect(hasProjectedLine).toBe(true);
    });
  });
});
