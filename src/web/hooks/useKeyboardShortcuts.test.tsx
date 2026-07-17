import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';

function dispatchKeyDown(key: string, target: EventTarget = document): void {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
}

describe('useKeyboardShortcuts', () => {
  let navigate: (path: string) => void;
  let onToggleHelp: () => void;
  let onToggleTheme: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    navigate = vi.fn<(path: string) => void>();
    onToggleHelp = vi.fn<() => void>();
    onToggleTheme = vi.fn<() => void>();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('navigates to /sessions on g then s', () => {
    renderHook(() => useKeyboardShortcuts({ navigate, onToggleHelp, onToggleTheme }));
    dispatchKeyDown('g');
    dispatchKeyDown('s');
    expect(navigate).toHaveBeenCalledWith('/sessions');
  });

  it('expires the g-prefix window after 500ms, so a late second key does not navigate', () => {
    renderHook(() => useKeyboardShortcuts({ navigate, onToggleHelp, onToggleTheme }));
    dispatchKeyDown('g');
    vi.advanceTimersByTime(600);
    dispatchKeyDown('s');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('restarts the prefix window on g then g, staying in prefix mode', () => {
    renderHook(() => useKeyboardShortcuts({ navigate, onToggleHelp, onToggleTheme }));
    dispatchKeyDown('g');
    vi.advanceTimersByTime(400);
    dispatchKeyDown('g');
    // Window restarted at t=400; advancing another 400ms (t=800, only 400ms
    // since the restart) should still be within the window.
    vi.advanceTimersByTime(400);
    dispatchKeyDown('s');
    expect(navigate).toHaveBeenCalledWith('/sessions');
  });

  it('exits prefix mode on an unmatched second key without navigating', () => {
    renderHook(() => useKeyboardShortcuts({ navigate, onToggleHelp, onToggleTheme }));
    dispatchKeyDown('g');
    dispatchKeyDown('z');
    expect(navigate).not.toHaveBeenCalled();
    // Confirms prefix mode was exited (not left pending): a fresh g→s now works.
    dispatchKeyDown('g');
    dispatchKeyDown('s');
    expect(navigate).toHaveBeenCalledWith('/sessions');
  });

  it('skips handling when focus is on an INPUT element', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    renderHook(() => useKeyboardShortcuts({ navigate, onToggleHelp, onToggleTheme }));
    dispatchKeyDown('t', input);
    expect(onToggleTheme).not.toHaveBeenCalled();
    document.body.removeChild(input);
  });

  it('skips handling when focus is on a contentEditable element', () => {
    const div = document.createElement('div');
    Object.defineProperty(div, 'isContentEditable', { value: true });
    document.body.appendChild(div);
    renderHook(() => useKeyboardShortcuts({ navigate, onToggleHelp, onToggleTheme }));
    dispatchKeyDown('t', div);
    expect(onToggleTheme).not.toHaveBeenCalled();
    document.body.removeChild(div);
  });

  it('skips handling when a modifier key is held', () => {
    renderHook(() => useKeyboardShortcuts({ navigate, onToggleHelp, onToggleTheme }));
    const event = new KeyboardEvent('keydown', {
      key: 't',
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    });
    document.dispatchEvent(event);
    expect(onToggleTheme).not.toHaveBeenCalled();
  });

  it('calls onToggleHelp on ?', () => {
    renderHook(() => useKeyboardShortcuts({ navigate, onToggleHelp, onToggleTheme }));
    dispatchKeyDown('?');
    expect(onToggleHelp).toHaveBeenCalledTimes(1);
  });

  it('calls onToggleTheme on t when provided', () => {
    renderHook(() => useKeyboardShortcuts({ navigate, onToggleHelp, onToggleTheme }));
    dispatchKeyDown('t');
    expect(onToggleTheme).toHaveBeenCalledTimes(1);
  });

  it('does not throw on t when onToggleTheme is not provided', () => {
    renderHook(() => useKeyboardShortcuts({ navigate, onToggleHelp }));
    expect(() => dispatchKeyDown('t')).not.toThrow();
  });

  it('removes the listener and clears the pending timer on unmount', () => {
    const { unmount } = renderHook(() =>
      useKeyboardShortcuts({ navigate, onToggleHelp, onToggleTheme }),
    );
    dispatchKeyDown('g');
    unmount();
    // After unmount, a stray keydown must not be handled by the removed listener.
    dispatchKeyDown('s');
    expect(navigate).not.toHaveBeenCalled();
  });
});
