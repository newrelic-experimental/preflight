import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HourlyCostBlocks } from './HourlyCostBlocks';

describe('HourlyCostBlocks', () => {
  it('renders nothing when every hour has zero cost', () => {
    const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, cost: 0 }));
    const { container } = render(<HourlyCostBlocks hours={hours} />);
    expect(container.firstChild).toBeNull();
  });

  it('describes total and peak hour in the default aria-label', () => {
    const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, cost: 0 }));
    hours[9] = { hour: 9, cost: 1.5 };
    hours[14] = { hour: 14, cost: 0.5 };
    render(<HourlyCostBlocks hours={hours} />);
    expect(
      screen.getByRole('img', { name: 'Hourly spend today: $2.00 total, peak $1.50 at 9am' }),
    ).toBeInTheDocument();
  });

  it('uses a custom ariaLabel when provided instead of the computed description', () => {
    const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, cost: hour === 5 ? 1 : 0 }));
    render(<HourlyCostBlocks hours={hours} ariaLabel="Custom label" />);
    expect(screen.getByRole('img', { name: 'Custom label' })).toBeInTheDocument();
  });
});
