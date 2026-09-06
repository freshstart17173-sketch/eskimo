// Light/dark theme preference. 'system' (default) follows the OS via
// prefers-color-scheme and stays live if the OS theme changes mid-session;
// 'light'/'dark' pin an explicit choice via a data-theme attribute on the
// root element, which the CSS in styles.css checks ahead of the media
// query. Device-level preference, not synced through the app's own JSON
// blob — like the OS's own dark-mode switch, it isn't part of the library.
import { useState, useEffect, useCallback } from 'react';

const STORAGE_KEY = 'eskimo:theme';
const VALID = ['system', 'light', 'dark'];

function readStored() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return VALID.includes(v) ? v : 'system';
  } catch (e) { return 'system'; }
}

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
}

// Runs once at module load (before React even renders) so the very first
// paint already has the right theme — no light-mode flash before a saved
// dark preference kicks in.
applyTheme(readStored());

export function useTheme() {
  const [theme, setThemeState] = useState(readStored);
  const [systemIsDark, setSystemIsDark] = useState(
    () => window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
  );

  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e) => setSystemIsDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const setTheme = useCallback((next) => {
    if (!VALID.includes(next)) return;
    try { localStorage.setItem(STORAGE_KEY, next); } catch (e) { /* ignore */ }
    applyTheme(next);
    setThemeState(next);
  }, []);

  const isDark = theme === 'dark' || (theme === 'system' && systemIsDark);
  return { theme, setTheme, isDark };
}
