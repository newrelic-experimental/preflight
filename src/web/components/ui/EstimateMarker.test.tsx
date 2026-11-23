import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { EstimateMarker, EstimateNote } from './EstimateMarker';

describe('EstimateMarker', () => {
  it('shows an est. label beside a dollar figure', () => {
    render(<EstimateMarker />);
    expect(screen.getByText('est.')).toBeInTheDocument();
  });

  it('explains on hover why the number can differ from a bill', () => {
    render(<EstimateMarker />);
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Why this is an estimate' }));

    const reasons = Array.from(screen.getByRole('tooltip').children, (el) => el.textContent);
    expect(reasons).toEqual([
      'Priced from list prices unless a rate multiplier, data residency premium, or custom pricing file is configured. A model missing from the price table can be priced from a sibling model in its family. Flat subscriptions are not reflected.',
      'Counts this machine and the platforms Preflight hooks into, not your whole org.',
      'Copilot in VS Code and the Copilot app do not report cache writes separately, so they are priced as ordinary input.',
      "Before a session's first token report, cost is estimated from the size of tool inputs and outputs.",
      "Invoices can post later and use their own day and time zone. Preflight days use this machine's local time zone.",
    ]);
  });

  it('renders without an info button when withoutInfoButton', () => {
    render(<EstimateMarker withoutInfoButton />);
    expect(screen.getByText('est.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('EstimateNote states costs are estimates and explains why on hover', () => {
    render(<EstimateNote />);
    expect(screen.getByText('Costs are estimates.')).toBeInTheDocument();
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Why this is an estimate' }));
    expect(screen.getByRole('tooltip')).toHaveTextContent('unless a rate multiplier');
  });
});
