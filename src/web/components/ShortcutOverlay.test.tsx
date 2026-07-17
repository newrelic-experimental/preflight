import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ShortcutOverlay } from './ShortcutOverlay';

describe('ShortcutOverlay', () => {
  it('renders nothing when open is false', () => {
    const { container } = render(<ShortcutOverlay open={false} onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the shortcut list when open is true', () => {
    render(<ShortcutOverlay open={true} onClose={() => {}} />);
    expect(screen.getByText('Keyboard Shortcuts')).toBeInTheDocument();
  });

  it('calls onClose when Escape is pressed while open', () => {
    const onClose = vi.fn();
    render(<ShortcutOverlay open={true} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose when the backdrop is clicked', () => {
    const onClose = vi.fn();
    const { container } = render(<ShortcutOverlay open={true} onClose={onClose} />);
    fireEvent.click(container.firstElementChild!);
    expect(onClose).toHaveBeenCalled();
  });

  it('does not call onClose when clicking inside the shortcut card (stopPropagation)', () => {
    const onClose = vi.fn();
    render(<ShortcutOverlay open={true} onClose={onClose} />);
    fireEvent.click(screen.getByText('Keyboard Shortcuts'));
    expect(onClose).not.toHaveBeenCalled();
  });
});
