import { useEffect, useState } from 'react';

export const THEME_STORAGE_KEY = 'movie-recommender-theme';

export type Theme = 'light' | 'dark';

const THEME_COLORS: Record<Theme, string> = {
  dark: '#0d0f0c',
  light: '#f2f2ed',
};

function isTheme(value: string | undefined): value is Theme {
  return value === 'light' || value === 'dark';
}

function readStoredTheme(): Theme | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);

    return stored === 'light' || stored === 'dark' ? stored : null;
  } catch {
    // Storage can be unavailable in private mode or when the user blocks it.
    return null;
  }
}

function readSystemTheme(): Theme | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return null;
  }

  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return null;
  }
}

function resolveInitialTheme(): Theme {
  if (typeof document !== 'undefined') {
    const fromDocument = document.documentElement.dataset.theme;

    if (isTheme(fromDocument)) {
      return fromDocument;
    }
  }

  return readStoredTheme() ?? readSystemTheme() ?? 'light';
}

function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') {
    return;
  }

  document.documentElement.dataset.theme = theme;

  const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');

  if (themeColor !== null) {
    themeColor.content = THEME_COLORS[theme];
  }
}

export interface UseThemeResult {
  theme: Theme;
  toggle: () => void;
}

export function useTheme(): UseThemeResult {
  const [theme, setTheme] = useState<Theme>(resolveInitialTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  function toggle(): void {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';

    // Apply synchronously so the switch never lags behind the click; the
    // effect repeats this on the next render.
    applyTheme(next);

    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(THEME_STORAGE_KEY, next);
      }
    } catch {
      // Persisting is best effort; the active theme still changes.
    }

    setTheme(next);
  }

  return { theme, toggle };
}
