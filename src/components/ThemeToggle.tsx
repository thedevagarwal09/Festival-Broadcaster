'use client';

import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { THEME_STORAGE_KEY } from '@/lib/theme';

function applyTheme(dark: boolean): void {
  document.documentElement.classList.toggle('dark', dark);
}

function savedTheme(): 'light' | 'dark' | null {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

/** Sun/moon button that switches between light and dark mode and remembers the choice. */
export function ThemeToggle({ className = '' }: { className?: string }) {
  // null until mounted: the server can't know the theme, so render a neutral placeholder first.
  const [dark, setDark] = useState<boolean | null>(null);

  useEffect(() => {
    setDark(document.documentElement.classList.contains('dark'));
    // Follow the device setting live, until the person picks a theme themselves.
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => {
      if (savedTheme()) return;
      applyTheme(e.matches);
      setDark(e.matches);
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const toggle = () => {
    const next = !(dark ?? document.documentElement.classList.contains('dark'));
    applyTheme(next);
    setDark(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next ? 'dark' : 'light');
    } catch {
      // storage blocked: the choice lasts until the page is reloaded
    }
  };

  const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
  return (
    <button
      type="button"
      onClick={toggle}
      className={`btn-secondary px-2.5 ${className}`}
      aria-label={label}
      title={label}
    >
      {dark === null ? (
        <span className="h-4 w-4" aria-hidden="true" />
      ) : dark ? (
        <Sun className="h-4 w-4" />
      ) : (
        <Moon className="h-4 w-4" />
      )}
    </button>
  );
}
