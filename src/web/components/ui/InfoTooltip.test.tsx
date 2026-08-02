import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { InfoTooltip } from './InfoTooltip';

describe('InfoTooltip', () => {
  it('renders an info button wired to the tooltip text via aria-describedby once hovered', () => {
    render(<InfoTooltip text="Explains the panel." />);
    const button = screen.getByRole('button', { name: 'What is this?' });
    expect(screen.queryByRole('tooltip')).toBeNull();

    fireEvent.mouseEnter(button);

    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent('Explains the panel.');
    expect(button.getAttribute('aria-describedby')).toBe(tooltip.getAttribute('id'));
  });

  it('hides the tooltip again after the mouse leaves the button', () => {
    render(<InfoTooltip text="Explains the panel." />);
    const button = screen.getByRole('button', { name: 'What is this?' });

    fireEvent.mouseEnter(button);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    fireEvent.mouseLeave(button);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('portals the tooltip outside the rendered container instead of nesting it inline', () => {
    const { container } = render(<InfoTooltip text="Explains the panel." />);
    const button = screen.getByRole('button', { name: 'What is this?' });

    fireEvent.mouseEnter(button);

    const tooltip = screen.getByRole('tooltip');
    expect(container).not.toContainElement(tooltip);
    expect(document.body).toContainElement(tooltip);
  });

  it('shows the tooltip on focus and hides it again on blur', () => {
    render(<InfoTooltip text="Explains the panel." />);
    const button = screen.getByRole('button', { name: 'What is this?' });
    expect(screen.queryByRole('tooltip')).toBeNull();

    fireEvent.focus(button);

    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent('Explains the panel.');
    expect(button.getAttribute('aria-describedby')).toBe(tooltip.getAttribute('id'));

    fireEvent.blur(button);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
