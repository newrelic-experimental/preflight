import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { EstimateMarker } from './EstimateMarker';

describe('EstimateMarker', () => {
  it('shows an est. label beside a dollar figure', () => {
    render(<EstimateMarker />);
    expect(screen.getByText('est.')).toBeInTheDocument();
  });

  it('explains on hover why the number can differ from a bill', () => {
    render(<EstimateMarker />);
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'What is this?' }));

    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent(
      'list prices, not your negotiated rate or a flat subscription',
    );
    expect(tooltip).toHaveTextContent('this machine and the platforms Preflight hooks into');
    expect(tooltip).toHaveTextContent('Copilot in VS Code');
    expect(tooltip).toHaveTextContent('Invoices can post later');
    expect(tooltip).toHaveTextContent('local time zone');
  });
});
