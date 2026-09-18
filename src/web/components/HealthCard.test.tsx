import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HealthCard } from './HealthCard';

describe('HealthCard', () => {
  it('renders the title and hero value', () => {
    render(<HealthCard title="Cache health" value="97%" />);
    expect(screen.getByText('Cache health')).toBeInTheDocument();
    expect(screen.getByText('97%')).toBeInTheDocument();
  });

  it('renders the status pill and tones the hero value', () => {
    render(<HealthCard title="Compute waste" value="12%" tone="warn" />);
    expect(screen.getByText('Watch')).toBeInTheDocument();
    expect(screen.getByText('12%').className).toMatch(/text-accent-amber/);
  });

  it('renders the detail line', () => {
    render(<HealthCard title="API failures" value="0" detail="Reflects the StopFailure hook" />);
    expect(screen.getByText('Reflects the StopFailure hook')).toBeInTheDocument();
  });

  it('renders up to four label/value rows', () => {
    render(
      <HealthCard
        title="Latency"
        value="1.4 s"
        rows={[
          { label: 'p50', value: '820 ms' },
          { label: 'p99', value: '3.1 s' },
        ]}
      />,
    );
    expect(screen.getByText('p50')).toBeInTheDocument();
    expect(screen.getByText('820 ms')).toBeInTheDocument();
    expect(screen.getByText('p99')).toBeInTheDocument();
    expect(screen.getByText('3.1 s')).toBeInTheDocument();
  });

  it('omits the status pill, detail, and rows when not provided', () => {
    const { container } = render(<HealthCard title="Quality" value="—" />);
    expect(container.querySelectorAll('.rounded-full').length).toBe(0);
  });
});
