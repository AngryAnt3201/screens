/**
 * Theme: three-state cycle (light → dark → system).
 *
 * The actual theme that gets rendered (i.e. one of 'light' or 'dark') is
 * mirrored to `<html data-theme="...">` so CSS can do the rest. To avoid
 * a flash of the wrong theme on launch, an inline script in `index.html`
 * applies the attribute *before* React mounts.
 */
import { useEffect, useState } from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'screens:theme';
const PREFERS_DARK = '(prefers-color-scheme: dark)';

export function readStoredMode(): ThemeMode {
  if (typeof window === 'undefined') return 'system';
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch { /* ignore */ }
  return 'system';
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode !== 'system') return mode;
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia(PREFERS_DARK).matches ? 'dark' : 'light';
}

function applyTheme(theme: ResolvedTheme) {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', theme);
}

export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(() => readStoredMode());
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(readStoredMode()));

  // Persist + apply whenever mode changes.
  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, mode);
    } catch { /* ignore */ }
    const next = resolveTheme(mode);
    setResolved(next);
    applyTheme(next);
  }, [mode]);

  // When in 'system' mode, react to OS theme changes live.
  useEffect(() => {
    if (mode !== 'system' || typeof window === 'undefined') return;
    const mq = window.matchMedia(PREFERS_DARK);
    const onChange = () => {
      const next: ResolvedTheme = mq.matches ? 'dark' : 'light';
      setResolved(next);
      applyTheme(next);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [mode]);

  const cycle = () => {
    setMode((m) => (m === 'light' ? 'dark' : m === 'dark' ? 'system' : 'light'));
  };

  return { mode, resolved, setMode, cycle };
}
