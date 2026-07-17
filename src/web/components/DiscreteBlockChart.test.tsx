import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { DiscreteBlockChart } from './DiscreteBlockChart';

describe('DiscreteBlockChart', () => {
  it('renders nothing when every item has a count of 0, even with a nonzero maxCount override', () => {
    const { container } = render(
      <DiscreteBlockChart
        data={[
          { count: 0, tooltip: 'a' },
          { count: 0, tooltip: 'b' },
        ]}
        maxCount={5}
        ariaLabel="empty chart"
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('colors the peak column with BLOCK_COLOR_PEAK and a shorter column with BLOCK_COLOR', () => {
    const { container } = render(
      <DiscreteBlockChart
        data={[
          { count: 1, tooltip: 'short' },
          { count: 3, tooltip: 'tall' },
        ]}
        ariaLabel="chart"
      />,
    );
    const rects = container.querySelectorAll('rect.heatmap-cell');
    expect(rects.length).toBe(4);
    // First column (count 1, not the peak) gets the base color.
    expect(rects[0]!.getAttribute('fill')).toBe('var(--color-chart-block)');
    // Second column (count 3 === effectiveMax) gets the peak color, including
    // its topmost block.
    expect(rects[1]!.getAttribute('fill')).toBe('var(--color-chart-block-peak)');
    expect(rects[3]!.getAttribute('fill')).toBe('var(--color-chart-block-peak)');
  });
});
