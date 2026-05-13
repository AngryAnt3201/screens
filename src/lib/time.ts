/**
 * Relative-time formatter for `Screen.visitedAt`.
 *
 * Accepts either:
 *   - a number (epoch-ms timestamp, the canonical form going forward)
 *   - a pre-formatted string (the legacy CLI wrote `"just now"` etc.; the
 *     demo seed still does — we display those verbatim)
 *   - null / undefined → returns the placeholder
 */
export function formatRelative(
  value: number | string | null | undefined,
  placeholder = '—',
): string {
  if (value == null) return placeholder;
  if (typeof value === 'string') return value || placeholder;
  if (!Number.isFinite(value) || value <= 0) return placeholder;
  const deltaMs = Date.now() - value;
  // Allow a tiny bit of negative skew (clock drift) before treating it as
  // "just now" rather than printing nonsense like "in 200ms".
  if (deltaMs < 30_000) return 'just now';
  const deltaSec = Math.floor(deltaMs / 1000);
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const deltaMin = Math.floor(deltaSec / 60);
  if (deltaMin < 60) return `${deltaMin}m ago`;
  const deltaHr = Math.floor(deltaMin / 60);
  if (deltaHr < 24) return `${deltaHr}h ago`;
  const deltaDay = Math.floor(deltaHr / 24);
  if (deltaDay < 30) return `${deltaDay}d ago`;
  const deltaMonth = Math.floor(deltaDay / 30);
  if (deltaMonth < 12) return `${deltaMonth}mo ago`;
  return `${Math.floor(deltaMonth / 12)}y ago`;
}
