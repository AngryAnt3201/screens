import { useEffect, useRef, useState } from 'react';

/**
 * `useState` that mirrors its value into `localStorage` under a stable key.
 * Mirrors writes synchronously, but only reads from storage on first mount.
 */
export function usePersistedState<T>(
  key: string,
  initial: T,
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [state, setState] = useState<T>(() => {
    if (typeof window === 'undefined') return initial;
    try {
      const raw = window.localStorage.getItem(key);
      if (raw == null) return initial;
      return JSON.parse(raw) as T;
    } catch {
      return initial;
    }
  });

  // Avoid writing on the very first render (no value change yet).
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    try {
      window.localStorage.setItem(key, JSON.stringify(state));
    } catch {
      // Quota or private-mode — silent.
    }
  }, [key, state]);

  return [state, setState];
}
