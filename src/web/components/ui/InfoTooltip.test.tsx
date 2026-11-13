import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { InfoTooltip } from './InfoTooltip';

type KeydownListener = EventListenerOrEventListenerObject;

function trackDocumentKeydownListeners(): Set<KeydownListener> {
  const attached = new Set<KeydownListener>();
  const realAdd = document.addEventListener.bind(document);
  const realRemove = document.removeEventListener.bind(document);
  vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => {
    if (type === 'keydown' && listener) attached.add(listener);
    realAdd(type, listener, options);
  });
  vi.spyOn(document, 'removeEventListener').mockImplementation((type, listener, options) => {
    if (type === 'keydown' && listener) attached.delete(listener);
    realRemove(type, listener, options);
  });
  return attached;
}

describe('InfoTooltip', () => {
  afterEach(() => vi.restoreAllMocks());

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

  it('closes an open tooltip on Escape and keeps focus on its trigger', () => {
    render(<InfoTooltip text="Explains the panel." />);
    const button = screen.getByRole('button', { name: 'What is this?' });

    button.focus();
    fireEvent.focus(button);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    fireEvent.keyDown(button, { key: 'Escape' });

    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('closes a hover-opened tooltip on Escape without the pointer leaving', () => {
    render(<InfoTooltip text="Explains the panel." />);
    const button = screen.getByRole('button', { name: 'What is this?' });

    fireEvent.mouseEnter(button);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('opening and closing repeatedly leaves no document keydown listener behind, including after unmount', () => {
    const attached = trackDocumentKeydownListeners();
    const { unmount } = render(<InfoTooltip text="Explains the panel." />);
    const button = screen.getByRole('button', { name: 'What is this?' });

    for (let i = 0; i < 20; i++) {
      fireEvent.mouseEnter(button);
      fireEvent.mouseLeave(button);
    }
    expect(attached.size).toBe(0);

    fireEvent.mouseEnter(button);
    unmount();
    expect(attached.size).toBe(0);
  });

  it('ignores keys other than Escape while the tooltip is open', () => {
    render(<InfoTooltip text="Explains the panel." />);
    const button = screen.getByRole('button', { name: 'What is this?' });

    fireEvent.focus(button);
    fireEvent.keyDown(button, { key: 'Enter' });

    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });
});
