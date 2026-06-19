import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'preflight-theme';

function getInitialTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // localStorage unavailable
  }
  try {
    if (window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
  } catch {
    // matchMedia unavailable (e.g. test environment)
  }
  return 'dark';
}

function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('light', theme === 'light');
}

export function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  // Track whether this is the initial mount. On first render the theme may
  // have been derived from matchMedia (not an explicit user choice), so we
  // must not write it back to localStorage — otherwise future OS-level theme
  // changes would be silently ignored on every subsequent load.
  const isMounted = useRef(false);

  // useLayoutEffect fires synchronously before paint, preventing a flash of
  // the wrong theme when the saved preference differs from the CSS default.
  useLayoutEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (!isMounted.current) {
      isMounted.current = true;
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // localStorage unavailable
    }
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  return { theme, toggleTheme };
}
