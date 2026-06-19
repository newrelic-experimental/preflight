import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useTheme } from './useTheme';

const STORAGE_KEY = 'preflight-theme';

function mockMatchMedia(prefersLight: boolean): void {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: prefersLight } as MediaQueryList));
}

describe('useTheme', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('light');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    document.documentElement.classList.remove('light');
  });

  it('defaults to dark when no preference is stored and matchMedia unavailable', () => {
    mockMatchMedia(false);
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('dark');
  });

  it('falls back to OS light preference when nothing is stored', () => {
    mockMatchMedia(true);
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('light');
  });

  it('reads a stored preference and ignores matchMedia', () => {
    localStorage.setItem(STORAGE_KEY, 'light');
    mockMatchMedia(false);
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('light');
  });

  it('applies the light class to <html> when theme is light', () => {
    localStorage.setItem(STORAGE_KEY, 'light');
    renderHook(() => useTheme());
    expect(document.documentElement.classList.contains('light')).toBe(true);
  });

  it('does not apply the light class when theme is dark', () => {
    mockMatchMedia(false);
    renderHook(() => useTheme());
    expect(document.documentElement.classList.contains('light')).toBe(false);
  });

  it('toggles from dark to light', () => {
    mockMatchMedia(false);
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('dark');
    act(() => result.current.toggleTheme());
    expect(result.current.theme).toBe('light');
  });

  it('toggles from light to dark', () => {
    localStorage.setItem(STORAGE_KEY, 'light');
    const { result } = renderHook(() => useTheme());
    act(() => result.current.toggleTheme());
    expect(result.current.theme).toBe('dark');
  });

  it('persists explicit toggle to localStorage', () => {
    mockMatchMedia(false);
    const { result } = renderHook(() => useTheme());
    act(() => result.current.toggleTheme());
    expect(localStorage.getItem(STORAGE_KEY)).toBe('light');
  });

  it('does not lock OS preference into localStorage on initial mount', () => {
    mockMatchMedia(true);
    renderHook(() => useTheme());
    // OS preference must not be written back — otherwise future OS changes
    // would be ignored because getInitialTheme always finds a stored value.
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('does not write back an already-stored preference on mount', () => {
    localStorage.setItem(STORAGE_KEY, 'light');
    const setSpy = vi.spyOn(Storage.prototype, 'setItem');
    renderHook(() => useTheme());
    expect(setSpy).not.toHaveBeenCalled();
  });
});
