import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DiscreteBlockChart } from './DiscreteBlockChart';

// Each column renders as a <g>; its heatmap-cell rects are the drawn blocks.
function blocksPerColumn(container: HTMLElement): number[] {
  return Array.from(
    container.querySelectorAll('g'),
    (g) => g.querySelectorAll('rect.heatmap-cell').length,
  );
}

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

  it('lets an explicit isPeak override the quantized-count comparison', () => {
    // Two hours can round to the same block count while only one is
    // the true max-spend hour. The caller flags the real peak via isPeak;
    // the chart must defer to it instead of comparing quantized counts.
    const { container } = render(
      <DiscreteBlockChart
        data={[
          { count: 3, tooltip: 'false tie', isPeak: false },
          { count: 3, tooltip: 'true peak', isPeak: true },
        ]}
        ariaLabel="chart"
      />,
    );
    const rects = container.querySelectorAll('rect.heatmap-cell');
    expect(rects.length).toBe(6);
    // First column: count === effectiveMax, but isPeak: false wins.
    expect(rects[0]!.getAttribute('fill')).toBe('var(--color-chart-block)');
    // Second column: isPeak: true wins.
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

  it("caps the svg's auto height at the chart's own pixel height, for a low-column-count chart in a wide panel", () => {
    // Mirrors History's peak-concurrency chart: as few as a handful of
    // columns in a near-full-width panel. Without a max-height cap, `height:
    // auto` stretches to the viewBox aspect ratio at the container's full
    // width, blowing the chart up far past its natural size.
    const BLOCK_SIZE = 10;
    const BLOCK_GAP = 2;
    const data = [
      { count: 1, tooltip: 'a' },
      { count: 2, tooltip: 'b' },
      { count: 3, tooltip: 'c' },
      { count: 4, tooltip: 'd' },
    ];
    const effectiveMax = Math.max(...data.map((d) => d.count), 1);
    const expectedChartHeight = effectiveMax * (BLOCK_SIZE + BLOCK_GAP);

    const { container } = render(<DiscreteBlockChart data={data} ariaLabel="chart" />);
    const svg = container.querySelector('svg')!;
    expect(svg.style.maxHeight).toBe(`${expectedChartHeight}px`);
  });

  describe('levels', () => {
    it('quantizes the tallest column to exactly `levels` blocks and shorter columns proportionally', () => {
      const { container } = render(
        <DiscreteBlockChart
          data={[
            { count: 10, tooltip: 'a' },
            { count: 100, tooltip: 'b' },
          ]}
          levels={4}
          ariaLabel="chart"
        />,
      );
      const rects = container.querySelectorAll('rect.heatmap-cell');
      // count 10 -> Math.ceil(10/100*4) = 1; count 100 (effectiveMax) -> 4.
      expect(rects.length).toBe(5);
    });

    it('renders 0 blocks for a count of 0 even when levels is set', () => {
      const { container } = render(
        <DiscreteBlockChart
          data={[
            { count: 0, tooltip: 'a' },
            { count: 100, tooltip: 'b' },
          ]}
          levels={4}
          ariaLabel="chart"
        />,
      );
      const rects = container.querySelectorAll('rect.heatmap-cell');
      expect(rects.length).toBe(4);
    });

    it('shows the raw tooltip text on hover, unaffected by quantization', () => {
      const { container } = render(
        <DiscreteBlockChart
          data={[{ count: 10, tooltip: 'raw: 10 of 100' }]}
          levels={4}
          ariaLabel="chart"
        />,
      );
      fireEvent.mouseEnter(container.querySelector('g')!);
      expect(screen.getByText('raw: 10 of 100')).toBeInTheDocument();
    });

    it('renders one block per count when levels is omitted, preserving prior behavior', () => {
      const { container } = render(
        <DiscreteBlockChart data={[{ count: 3, tooltip: 'a' }]} ariaLabel="chart" />,
      );
      const rects = container.querySelectorAll('rect.heatmap-cell');
      expect(rects.length).toBe(3);
    });
  });

  describe('maxLevels', () => {
    it('draws one block per count when the tallest column is at or under maxLevels', () => {
      const { container } = render(
        <DiscreteBlockChart
          data={[
            { count: 2, tooltip: 'a' },
            { count: 8, tooltip: 'b' },
          ]}
          maxLevels={8}
          ariaLabel="chart"
        />,
      );
      expect(blocksPerColumn(container)).toEqual([2, 8]);
    });

    it('caps the tallest column at maxLevels and scales the rest, keeping nonzero columns above 0', () => {
      const { container } = render(
        <DiscreteBlockChart
          data={[
            { count: 0, tooltip: 'a' },
            { count: 1, tooltip: 'b' },
            { count: 50, tooltip: 'c' },
            { count: 100, tooltip: 'd' },
          ]}
          maxLevels={4}
          ariaLabel="chart"
        />,
      );
      // 1/100*4 rounds up to 1; 50/100*4 = 2; 100 is the peak and renders 4.
      expect(blocksPerColumn(container)).toEqual([0, 1, 2, 4]);
    });

    it('lets an explicit levels override maxLevels', () => {
      const { container } = render(
        <DiscreteBlockChart
          data={[
            { count: 1, tooltip: 'a' },
            { count: 100, tooltip: 'b' },
          ]}
          levels={4}
          maxLevels={8}
          ariaLabel="chart"
        />,
      );
      expect(blocksPerColumn(container)).toEqual([1, 4]);
    });

    it('shows the raw count on hover when the column is scaled down', () => {
      const { container } = render(
        <DiscreteBlockChart
          data={[
            { count: 3, tooltip: 'raw: 3' },
            { count: 100, tooltip: 'raw: 100' },
          ]}
          maxLevels={4}
          ariaLabel="chart"
        />,
      );
      fireEvent.mouseEnter(container.querySelectorAll('g')[0]!);
      expect(screen.getByText('raw: 3')).toBeInTheDocument();
    });
  });
});
