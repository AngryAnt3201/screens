import { useEffect } from 'react';
import { useTheme, type ThemeMode } from '../lib/theme';
import { Monitor, Moon, Sun } from './icons';

/**
 * Tri-state theme cycle: light → dark → system → light.
 *
 * The icon mirrors the *mode* (user intent), not the resolved theme — so
 * "system" gets a monitor glyph even when the OS is on dark. Tooltip shows
 * the resolved value for clarity.
 */
export function ThemeToggle() {
  const { mode, resolved, cycle } = useTheme();

  // ⌘⇧L cycles theme.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        cycle();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cycle]);

  return (
    <button
      type="button"
      className="icon-btn"
      onClick={cycle}
      title={titleFor(mode, resolved)}
      aria-label={titleFor(mode, resolved)}
    >
      {mode === 'system' ? <Monitor /> : mode === 'dark' ? <Moon /> : <Sun />}
    </button>
  );
}

function titleFor(mode: ThemeMode, resolved: 'light' | 'dark') {
  const next: Record<ThemeMode, ThemeMode> = {
    light: 'dark',
    dark: 'system',
    system: 'light',
  };
  return `Theme: ${mode}${mode === 'system' ? ` (${resolved})` : ''} · ⌘⇧L → ${next[mode]}`;
}
