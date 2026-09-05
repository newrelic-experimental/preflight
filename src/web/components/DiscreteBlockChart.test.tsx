import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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

  it('portals the tooltip to document.body on hover, escaping an overflow-hidden ancestor', () => {
    const { container } = render(
      <div style={{ overflow: 'hidden' }}>
        <DiscreteBlockChart data={[{ count: 2, tooltip: 'peak: 5' }]} ariaLabel="chart" />
      </div>,
    );
    fireEvent.mouseEnter(container.querySelector('g')!);
    const tooltip = screen.getByText('peak: 5');
    expect(container.contains(tooltip)).toBe(false);
    expect(document.body.contains(tooltip)).toBe(true);
  });

  it('dismisses the tooltip on scroll instead of leaving it drifted from its anchor', () => {
    render(<DiscreteBlockChart data={[{ count: 2, tooltip: 'peak: 5' }]} ariaLabel="chart" />);
    fireEvent.mouseEnter(document.querySelector('g')!);
    expect(screen.getByText('peak: 5')).toBeInTheDocument();
    fireEvent.scroll(window);
    expect(screen.queryByText('peak: 5')).toBeNull();
  });

  it('dismisses the tooltip on window resize', () => {
    render(<DiscreteBlockChart data={[{ count: 2, tooltip: 'peak: 5' }]} ariaLabel="chart" />);
    fireEvent.mouseEnter(document.querySelector('g')!);
    expect(screen.getByText('peak: 5')).toBeInTheDocument();
    fireEvent.resize(window);
    expect(screen.queryByText('peak: 5')).toBeNull();
  });
});
