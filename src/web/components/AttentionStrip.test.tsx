import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AttentionStrip } from './AttentionStrip';

describe('AttentionStrip', () => {
  it('humanizes known anti-pattern types', () => {
    render(
      <AttentionStrip
        flags={[{ type: 'over_delegation', count: 4 }]}
        firingCount={0}
        alertsHref="/alerts"
      />,
    );
    expect(screen.getByText('Over-delegation ×4')).toBeInTheDocument();
  });

  it('humanizes every named type from the table', () => {
    render(
      <AttentionStrip
        flags={[
          { type: 're_reading', count: 1 },
          { type: 'stuck_loop', count: 1 },
          { type: 'blind_editing', count: 1 },
          { type: 'thrashing', count: 1 },
        ]}
        firingCount={0}
        alertsHref="/alerts"
      />,
    );
    expect(screen.getByText('Repeated reads ×1')).toBeInTheDocument();
    expect(screen.getByText('Stuck loop ×1')).toBeInTheDocument();
    expect(screen.getByText('Blind editing ×1')).toBeInTheDocument();
    expect(screen.getByText('Edit/test thrashing ×1')).toBeInTheDocument();
  });

  it('falls back to underscore-replaced, capitalized text for an unknown type', () => {
    render(
      <AttentionStrip
        flags={[{ type: 'some_new_flag', count: 2 }]}
        firingCount={0}
        alertsHref="/alerts"
      />,
    );
    expect(screen.getByText('Some new flag ×2')).toBeInTheDocument();
  });

  it('appends the target when present and not "unknown"', () => {
    render(
      <AttentionStrip
        flags={[{ type: 'over_delegation', count: 3, target: 'Bash' }]}
        firingCount={0}
        alertsHref="/alerts"
      />,
    );
    expect(screen.getByText('Over-delegation ×3 on Bash')).toBeInTheDocument();
  });

  it('suppresses the target when it is "unknown"', () => {
    render(
      <AttentionStrip
        flags={[{ type: 'over_delegation', count: 3, target: 'unknown' }]}
        firingCount={0}
        alertsHref="/alerts"
      />,
    );
    expect(screen.getByText('Over-delegation ×3')).toBeInTheDocument();
    expect(screen.queryByText(/on unknown/)).not.toBeInTheDocument();
  });

  it('renders the firing count as a link to alertsHref', () => {
    render(<AttentionStrip flags={[]} firingCount={3} alertsHref="/alerts" />);
    const link = screen.getByRole('link', { name: '3 firing' });
    expect(link).toHaveAttribute('href', '/alerts');
  });

  it('renders "Nothing needs attention." when there are no flags and nothing firing', () => {
    render(<AttentionStrip flags={[]} firingCount={0} alertsHref="/alerts" />);
    expect(screen.getByText('Nothing needs attention.')).toBeInTheDocument();
  });
});
