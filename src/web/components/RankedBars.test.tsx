import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RankedBars } from './RankedBars';

const ROW = (key: string, share: number) => ({
  key,
  label: key,
  value: `${share}`,
  share,
});

describe('RankedBars', () => {
  it('renders the empty text when there are no rows', () => {
    render(<RankedBars rows={[]} emptyText="No spend yet" />);
    expect(screen.getByText('No spend yet')).toBeInTheDocument();
  });

  it('renders a default empty text when none is given', () => {
    render(<RankedBars rows={[]} />);
    expect(screen.getByText('No data yet')).toBeInTheDocument();
  });

  it('caps rows at max and shows a "+N more" footnote', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ROW(`row-${i}`, 10 - i));
    render(<RankedBars rows={rows} max={8} />);
    expect(screen.getAllByText(/^row-/).length).toBe(16); // 8 rows x 2 (sr-only table + visible list)
    expect(screen.getByText('+2 more not shown')).toBeInTheDocument();
  });

  it('does not render a footnote when rows fit within max', () => {
    render(<RankedBars rows={[ROW('bash', 40), ROW('read', 30)]} max={8} />);
    expect(screen.queryByText(/more not shown/)).not.toBeInTheDocument();
  });

  it('renders the share as a formatted percent', () => {
    render(<RankedBars rows={[ROW('bash', 34)]} />);
    expect(screen.getAllByText('34%').length).toBeGreaterThan(0);
  });

  it('renders a <1% share for a small nonzero value', () => {
    render(<RankedBars rows={[ROW('bash', 0.2)]} />);
    expect(screen.getAllByText('<1%').length).toBeGreaterThan(0);
  });
});
