import { render, screen } from '@testing-library/react';
import { Kpi } from './Kpi';

describe('Kpi', () => {
  it('renders label and value', () => {
    render(<Kpi label="spend" value="$3.42" />);
    expect(screen.getByText('spend')).toBeInTheDocument();
    expect(screen.getByText('$3.42')).toBeInTheDocument();
  });

  it('applies tone color when tone="good"', () => {
    render(<Kpi label="eff." value="94%" tone="good" />);
    const v = screen.getByText('94%');
    expect(v.className).toMatch(/text-accent-green/);
  });

  it('applies tone color when tone="warn"', () => {
    render(<Kpi label="flags" value="2" tone="warn" />);
    const v = screen.getByText('2');
    expect(v.className).toMatch(/text-accent-amber/);
  });

  it('renders subtext when provided', () => {
    render(<Kpi label="spend" value="$3.42" sub="+34% vs avg" />);
    expect(screen.getByText('+34% vs avg')).toBeInTheDocument();
  });

  it('does not accept tone="accent" (removed — use "good")', () => {
    render(<Kpi label="spend" value="$3.42" tone="good" />);
    const v = screen.getByText('$3.42');
    expect(v.className).toMatch(/text-accent-green/);
  });
});
