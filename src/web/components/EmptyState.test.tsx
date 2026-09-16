import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EmptyState } from './EmptyState';

describe('EmptyState', () => {
  it('renders the title and icon for the default variant', () => {
    const { container } = render(<EmptyState icon="radar" title="Nothing yet" />);
    expect(screen.getByText('Nothing yet')).toBeInTheDocument();
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('inline variant renders one muted line with no icon', () => {
    const { container } = render(<EmptyState variant="inline" title="Nothing needs attention." />);
    expect(screen.getByText('Nothing needs attention.')).toBeInTheDocument();
    expect(container.querySelector('svg')).not.toBeInTheDocument();
  });

  it('inline variant appends the subtitle after a middot when present', () => {
    render(<EmptyState variant="inline" title="No recommendations" subtitle="check back later" />);
    expect(screen.getByText('No recommendations · check back later')).toBeInTheDocument();
  });

  it('inline variant has no fixed min-height wrapper', () => {
    const { container } = render(<EmptyState variant="inline" title="Nothing yet" />);
    expect(container.querySelector('.py-8')).not.toBeInTheDocument();
  });
});
