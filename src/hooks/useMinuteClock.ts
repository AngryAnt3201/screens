import { useEffect, useState } from 'react';

/**
 * Forces a re-render of the calling component once a minute. Used by
 * components that display relative timestamps (`5m ago` → `6m ago`) so
 * they don't go stale until some unrelated state change happens.
 *
 * A single shared interval drives every subscriber so 100 nodes on the
 * canvas don't create 100 timers.
 */
const listeners = new Set<() => void>();
let intervalHandle: number | null = null;

function ensureInterval() {
  if (intervalHandle !== null) return;
  intervalHandle = window.setInterval(() => {
    for (const l of listeners) l();
  }, 60_000);
}

export function useMinuteClock() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const l = () => setTick((t) => t + 1);
    listeners.add(l);
    ensureInterval();
    return () => {
      listeners.delete(l);
      if (listeners.size === 0 && intervalHandle !== null) {
        window.clearInterval(intervalHandle);
        intervalHandle = null;
      }
    };
  }, []);
}
